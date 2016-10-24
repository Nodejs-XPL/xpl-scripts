/*jslint node: true, vars: true, nomen: true, esversion: 6 */
'use strict';

const async = require('async');
const Path = require('path');
const util = require('util');
const EventEmitter = require('events');
const debug = require('debug')('xpl-scripts:scriptsEngine');
const debugSync = require('debug')('xpl-scripts:scriptsEngine:sync');
const os = require('os');
const fs = require('fs');

const semaphore = require('semaphore')(1);

const ScriptsHost = require('./scriptsHost');
const Script = require('./script');

class ScriptEngine extends EventEmitter {
	constructor(xpl, configuration, query) {
		super();

		this.setMaxListeners(64);

		this.id = Script.id++;
		this.xpl = xpl;
		this._query = query;

		configuration = configuration || {};
		this._configuration = configuration;

		if (!configuration.scriptsLogPath) {
			var logPath = Path.join(os.tmpdir(), "xpl-script-logs");
			try {
				fs.statSync(logPath);

			} catch (x) {
				console.error(x);
				fs.mkdirSync(logPath);
			}

			configuration.scriptsLogPath = logPath;
		}

		this._deviceAliases = configuration.deviceAliases;

		this._scriptsHosts = [];

		this._currentScriptsHost = null;

		xpl.on("message", this._messageReceived.bind(this));
	}

	_messageReceived(packet, address, buffer) {
		var scriptsHosts = this._scriptsHosts.slice(0);

		// TODO copy packet

		var deviceAliases = this._deviceAliases;

		// console.log("DeviceAliases=",deviceAliases);

		if (deviceAliases) {
			var runit = packet.body.device || packet.body.address;
			var alias = deviceAliases[runit];
			debug("messageReceived", "Alias", runit, "=>", alias);
			if (alias) {
				if (packet.body.device) {
					packet.body.device = alias;
				} else {
					packet.body.address = alias;
				}
				runit = alias;
			}

			var type = packet.body.type || packet.body.unit;
			if (type) {
				runit += "/" + type;
				alias = deviceAliases[runit];
				debug("messageReceived", "Alias", runit, "=>", alias);
				if (alias) {
					if (packet.body.device) {
						packet.body.device = alias;
					} else {
						packet.body.address = alias;
					}
					if (packet.body.type) {
						packet.body.type = "";
					} else {
						packet.body.unit = "";
					}
				}
			}
		}

		scriptsHosts.forEach((scriptsHost) => {

			debug("messageReceived", "scriptEngine: fire message to #", scriptsHost.id);

			try {
				scriptsHost.emit("message", packet, address, buffer);

			} catch (x) {
				console.error("ScriptHosts #" + scriptsHost.id + " throws an exception ",
					x);

				if (x.stack) {
					console.error('\nStacktrace:\n');
					console.error('====================\n');
					console.error(x.stack);
				}
			}
		});

		scriptsHosts.forEach((scriptsHost) => {

			debug("scriptEngine: fire POST message to ", scriptsHost.id);

			try {
				scriptsHost.emit("message:post", packet, address, buffer);

			} catch (x) {
				console.error("ScriptHosts #" + scriptsHost.id + " throws an exception ",
					x);

				if (x.stack) {
					console.error('\nStacktrace:\n');
					console.error('====================\n');
					console.error(x.stack);
				}
			}
		});
	}

	scan(directory, callback) {

		debug("scan", "Directory=", directory);

		fs.watch(directory, (event, filename) => {
			debug("scan", "Start watch scan ");

			semaphore.take(() => {
				this._scanDirectory(directory, (error) => {
					semaphore.leave();
					if (error) {
						console.error("Scan directory error", error);
						return;
					}

					debug("scan", "Watch scan done");
				});
			});
		});

		this._scanDirectory(directory, callback);
	}

	_scanDirectory(directory, callback) {

		var scriptsHosts = this._scriptsHosts.slice(0);

		var removed = 0;
		var added = 0;
		var updated = 0;
		var scanned = 0;

		fs.readdir(directory, (error, list) => {
			if (error) {
				return callback(error);
			}

			async.eachSeries(list, (path, callback) => {

				if (!/\.js$/.exec(path)) {
					return callback();
				}

				scanned++;

				var scriptPath = Path.join(directory, path);

				debugSync("Script path=" + scriptPath);

				fs.stat(scriptPath, (error, stats) => {
					if (error) {
						return callback(error);
					}

					var knownScriptsHost = null;

					for (var i = 0; i < scriptsHosts.length; i++) {
						var scriptsHost = scriptsHosts[i];

						debugSync("Compare ", scriptsHost.path, "<>", scriptPath);

						if (scriptsHost.path !== scriptPath) {
							continue;
						}
						debugSync("Found same path #", scriptsHost.id);

						knownScriptsHost = scriptsHost;
						break;
					}

					if (!knownScriptsHost) {
						debugSync("New script ", scriptPath);

						added++;
						this._newScriptsHost(scriptPath, stats.mtime.getTime(), callback);
						return;
					}

					var idx = scriptsHosts.indexOf(knownScriptsHost);
					scriptsHosts.splice(idx, 1);

					if (knownScriptsHost._mtime === stats.mtime.getTime()) {
						debugSync("Host#", knownScriptsHost.id, " Same date");

						return callback();
					}

					delete require.cache[scriptPath];

					debugSync("Host#", knownScriptsHost.id,
						" Not the same script ! shutdown old (known=",
						knownScriptsHost._mtime, "/", stats.mtime.getTime(), ")");

					updated++;
					knownScriptsHost.shutdown("modified", (error) => {
						if (error) {
							console.error("Shudown error", error);
						}

						this._newScriptsHost(scriptPath, stats.mtime.getTime(), callback);
					});
				});

			}, (error) => {
				if (error) {
					console.error("Directory scan error", error);
				}

				async.eachSeries((deletedScript, callback) => {
					debugSync("Host#", deletedScript.id, " Script has been deleted: ", deletedScript);

					removed++;
					deletedScript.shutdown("deleted", function (error) {
						if (error) {
							console.error(error);
						}

						callback();
					});
				}, (error) => {
					if (error) {
						console.error(error);
					}

					debugSync("SYNC: Scanned=", scanned, " Added=", added, " Updated=",
						updated, " Removed=", removed);

					callback(error);
				});
			});
		});
	}

	newScript(name) {
		var scriptHost = this._currentScriptsHost;

		debug("newScript", "Allocate new script '" + name + "' for scriptHost=" + scriptHost);

		if (!scriptHost) {
			throw new Error("No script host");
		}

		var script = scriptHost.newScript(name);

		return script;
	}

	_newScriptsHost(scriptPath, mtime, callback) {
		var scriptsHost = new ScriptsHost(scriptPath, mtime, this._configuration, this._query);

		debug("_newScriptsHost", "New ScriptsHost path='" + scriptPath + " mtime=" + mtime);

		this._scriptsHosts.push(scriptsHost);

		var sendXpl = this._sendXpl.bind(this);

		// Can send event even in init phase !
		scriptsHost.on("sendXpl", sendXpl);

		try {
			this._currentScriptsHost = scriptsHost;

			var result = require(scriptPath);

			debug("_newScriptsHost", "Require's return=", result);

			if (typeof (result) === "function") {
				scriptsHost.result = result(this);

			} else if (typeof (result) === "object") {
				scriptsHost.result = new result(this);

			} else {
				var error = new Error("Invalid result for script '" + scriptPath + "'");
				error.scriptEngine = this;

				throw error;
			}

		} catch (x) {
			console.error("New script error", x);

			if (x.stack) {
				console.error('\nStacktrace:');
				console.error('====================');
				console.error(x.stack);
			}

			return callback(x);

		} finally {
			this._currentScriptsHost = null;
		}

		scriptsHost.once("destroyed", (reason) => {
			console.log("ScriptHost #" + scriptsHost.id + " destroyed");

			scriptsHost.removeListener("sendXpl", sendXpl);

			var idx = this._scriptsHosts.indexOf(scriptsHost);
			if (idx < 0) {
				console.error("Can not find scriptsHost in list ??? #" + scriptsHost.id);
			} else {
				this._scriptsHosts.splice(idx, 1);
			}
		});

		setImmediate(() => {
			scriptsHost._initializeScripts((error) => {
				if (error) {
					console.error("Initializing error", error);
					return;
				}

				scriptsHost._run((error) => {
					if (error) {
						console.error("Starting error", error);
						return;
					}

					debug("Scripts started !");
				});
			});
		});

		callback(null, scriptsHost);
	}

	_sendXpl(event) {
		switch (event.command) {
			case "xpl-cmnd":
				return this.sendXplCmnd(event.body, event.bodyName, event.target, event.callback);

			case "xpl-stat":
				return this.sendXplStat(event.body, event.bodyName, event.target, event.callback);

			case "xpl-trig":
				return this.sendXplTrig(event.body, event.bodyName, event.target, event.callback);

			default:
				return this.sendXplCommand(event.command, event.body, event.bodyName, event.target, event.callback);

		}
	}

	sendXplCmnd(body, bodyName, target, callback) {
		this.xpl.sendXplCmnd(body, bodyName, target, callback);
	}

	sendXplStat(body, bodyName, target, callback) {
		this.xpl.sendXplStat(body, bodyName, target, callback);
	}

	sendXplTrigfunction(body, bodyName, target, callback) {
		this.xpl.sendXplTrig(body, bodyName, target, callback);
	}
}

module.exports = ScriptEngine;
