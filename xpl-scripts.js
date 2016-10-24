/*jslint node: true, vars: true, nomen: true, esversion:6 */
'use strict';

const Xpl = require("xpl-api");
const commander = require('commander');
const os = require('os');
const debug = require('debug')('xpl-scripts');
const XplDBClient = require('xpl-dbclient');
const Memcache = XplDBClient.Memcache;
const Query = XplDBClient.Query;

var ScriptsEngine = require("./lib/scriptsEngine");

commander.version(require("./package.json").version);
commander.option("--deviceAliases <path>", "Device aliases (path or string)");
commander.option("--scriptsLogPath <path>", "Logs directory");
commander.option("--logRotate", "Enable scripts logs rotate");
commander.option("--logRotateSize <size>", "Max log size");
commander.option("--logRotateKeep <keep>", "Logs count", parseInt);
commander.option("--logRotateCompress", "Compress logs rotate");

Xpl.fillCommander(commander);
Memcache.fillCommander(commander);
Query.fillCommander(commander);

commander.command('start').action((params) => {
	console.log("Start", params);

	commander.deviceAliases = Xpl.loadDeviceAliases(commander.deviceAliases);

	if (!commander.xplSource) {
		var hostName = os.hostname();
		if (hostName.indexOf('.') > 0) {
			hostName = hostName.substring(0, hostName.indexOf('.'));
		}

		commander.xplSource = "xpl-scripts." + hostName;
	}

	var xpl = new Xpl(commander);

	xpl.on("error", (error) => {
		console.log("XPL error", error);
	});

	xpl.bind((error) => {
		if (error) {
			console.error("Can not open xpl bridge ", error);
			process.exit(2);
			return;
		}

		console.log("Xpl bind succeed ");

		var query = new Query(commander);

		var scriptsEngine = new ScriptsEngine(xpl, commander, query);

		scriptsEngine.scan(params, (error) => {
			if (error) {
				console.error("Can not open xpl bridge ", error);
				process.exit(3);
				return;
			}

			console.log("Scripts engine launched");
		});
	});
});

commander.parse(process.argv);

if (commander.headDump) {
	var heapdump = require("heapdump");
	console.log("***** HEAPDUMP enabled **************");
}
