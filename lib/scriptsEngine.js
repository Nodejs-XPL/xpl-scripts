/*jslint node: true, vars: true, nomen: true */
'use strict';

var async = require('async');
var fs = require('fs');
var Path = require('path');
var util = require('util');
var Events = require('events');
var debug = require('debug')('xpl-scripts:scriptsEngine');
var debugSync = require('debug')('xpl-scripts:scriptsEngine:sync');
var os = require('os');
var fs = require('fs');

var semaphore = require('semaphore')(1);

var ScriptsHost = require('./scriptsHost');
var Script = require('./script');

var ScriptEngine = function(xpl, configuration) {
  Events.EventEmitter.call(this);

  this.id = Script.id++;
  this.xpl = xpl;

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
};

util.inherits(ScriptEngine, Events.EventEmitter);

module.exports = ScriptEngine;

ScriptEngine.prototype._messageReceived = function(packet, address, buffer) {
  var scriptsHosts = this._scriptsHosts.slice(0);

  // TODO copy packet

  var deviceAliases = this._deviceAliases;

//  console.log("DeviceAliases=",deviceAliases);
  
  if (deviceAliases) {
    var runit = packet.body.device || packet.body.address;
    var alias = deviceAliases[runit];
    debug("Alias",runit,"=>",alias);
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
      console.log("Alias",runit,"=>",alias);
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

  scriptsHosts.forEach(function(scriptsHost) {

    debug("scriptEngine: fire message to ", scriptsHost);

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

  scriptsHosts.forEach(function(scriptsHost) {

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
};

ScriptEngine.prototype.scan = function(directory, callback) {

  debug("Directory=", directory);

  var self = this;
  fs.watch(directory, function(event, filename) {
    debug("Start watch scan ");

    semaphore.take(function() {
      self._scanDirectory(directory, function(error) {
        semaphore.leave();
        if (error) {
          console.error("Scan directory error", error);
          return;
        }

        debug("Watch scan done");
      });
    });
  });

  this._scanDirectory(directory, callback);
};

ScriptEngine.prototype._scanDirectory = function(directory, callback) {
  var self = this;

  var scriptsHosts = this._scriptsHosts.slice(0);

  var removed = 0;
  var added = 0;
  var updated = 0;
  var scanned = 0;

  fs.readdir(directory, function(error, list) {
    if (error) {
      return callback(error);
    }

    async.eachSeries(list, function(path, callback) {

      if (!/\.js$/.exec(path)) {
        return callback();
      }

      scanned++;

      var scriptPath = Path.join(directory, path);

      debugSync("Script path=" + scriptPath);

      fs.stat(scriptPath, function(error, stats) {
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
          self._newScriptsHost(scriptPath, stats.mtime.getTime(), callback);
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
        knownScriptsHost.shutdown("modified", function(error) {
          if (error) {
            console.error("Shudown error", error);
          }

          self._newScriptsHost(scriptPath, stats.mtime.getTime(), callback);
        });
      });

    }, function(error) {
      if (error) {
        console.error("Directory scan error", error);
      }

      async.eachSeries(function(deletedScript, callback) {
        debugSync("Host#", deletedScript.id, " Script has been deleted: ",
            deletedScript);

        removed++;
        deletedScript.shutdown("deleted", function(error) {
          if (error) {
            console.error(error);
          }

          callback();
        });
      }, function(error) {
        if (error) {
          console.error(error);
        }

        debugSync("SYNC: Scanned=", scanned, " Added=", added, " Updated=",
            updated, " Removed=", removed);

        callback(error);
      });
    });

  });
};

ScriptEngine.prototype.newScript = function(name) {
  var scriptHost = this._currentScriptsHost;

  debug("Allocate new script '" + name + "' for scriptHost=" + scriptHost);

  if (!scriptHost) {
    throw new Error("No script host");
  }

  var script = scriptHost.newScript(name);

  return script;
};

ScriptEngine.prototype._newScriptsHost = function(scriptPath, mtime, callback) {
  var scriptsHost = new ScriptsHost(scriptPath, mtime, this._configuration);

  debug("New ScriptsHost path='" + scriptPath + " mtime=" + mtime);

  this._scriptsHosts.push(scriptsHost);

  var sendXpl = this._sendXpl.bind(this);

  // Can send event even in init phase !
  scriptsHost.on("sendXpl", sendXpl);

  try {
    this._currentScriptsHost = scriptsHost;

    var result = require(scriptPath);

    debug("Require's return=", result);

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

  var self = this;

  scriptsHost.on("destroyed", function destroyed(reason) {
    console.log("ScriptHost #" + scriptsHost.id + " destroyed");

    scriptsHost.removeListener("destroyed", destroyed);
    scriptsHost.removeListener("sendXpl", sendXpl);

    var idx = self._scriptsHosts.indexOf(scriptsHost);
    if (idx < 0) {
      console.error("Can not find scriptsHost in list ??? #" + scriptsHost.id);
    } else {
      self._scriptsHosts.splice(idx, 1);
    }
  });

  setImmediate(function() {
    scriptsHost._initializeScripts(function(error) {
      if (error) {
        console.error("Initializing error", error);
        return;
      }

      scriptsHost._run(function(error) {
        if (error) {
          console.error("Starting error", error);
          return;
        }

        debug("Scripts started !");
      });
    });
  });

  callback(null, scriptsHost);
};

ScriptEngine.prototype._sendXpl = function(event) {
  switch (event.command) {
  case "xpl-cmnd":
    return this.sendXplCmnd(event.body, event.bodyName, event.target,
        event.callback);

  case "xpl-stat":
    return this.sendXplStat(event.body, event.bodyName, event.target,
        event.callback);

  case "xpl-trig":
    return this.sendXplTrig(event.body, event.bodyName, event.target,
        event.callback);

  default:
    return this.sendXplCommand(event.command, event.body, event.bodyName,
        event.target, event.callback);

  }
};

ScriptEngine.prototype.sendXplCmnd = function(body, bodyName, target, callback) {
  this.xpl.sendXplCmnd(body, bodyName, target, callback);
};

ScriptEngine.prototype.sendXplStat = function(body, bodyName, target, callback) {
  this.xpl.sendXplStat(body, bodyName, target, callback);
};

ScriptEngine.prototype.sendXplTrig = function(body, bodyName, target, callback) {
  this.xpl.sendXplTrig(body, bodyName, target, callback);
};

module.exports = ScriptEngine;