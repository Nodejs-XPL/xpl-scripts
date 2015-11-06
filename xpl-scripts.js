/*jslint node: true, vars: true, nomen: true */
'use strict';

var Xpl = require("xpl-api");
var commander = require('commander');
var os = require('os');
var debug = require('debug')('xpl-scripts');

var ScriptsEngine = require("./lib/scriptsEngine");

commander.version(require("./package.json").version);
commander.option("--deviceAliases <path>", "Device aliases (path or string)");
commander.option("--scriptsLogPath <path>", "Logs directory");
commander.option("--logRotate", "Enable scripts logs rotate");
commander.option("--logRotateSize <size>", "Max log size");
commander.option("--logRotateKeep <keep>", "Logs count", parseInt);
commander.option("--logRotateCompress", "Compress logs rotate");

Xpl.fillCommander(commander);

commander.command('start').action(function(params) {
  console.log("Start", params);

  var deviceAliases = commander.deviceAliases;
  if (deviceAliases) {
    if (deviceAliases.indexOf('=') >= 0) {
      var ds = {};
      commander.deviceAliases = ds;

      var js = deviceAliases.split(',');
      for (var i = 0; i < js.length; i++) {
        var j = js[i].split('=');
        if (j.length === 2) {
          ds[j[0].trim()] = j[1].trim();
        }
      }

    } else {
      commander.deviceAliases = {};
      deviceAliases.split(",").forEach(function(path) {
        var r = require(path);
        for ( var n in r) {
          if (!r.hasOwnProperty(n)) {
            continue;
          }
          commander.deviceAliases[n] = r[n];
        }
      });
    }

    debug("DeviceAliases=", commander.deviceAliases);
  }

  if (!commander.xplSource) {
    var hostName = os.hostname();
    if (hostName.indexOf('.') > 0) {
      hostName = hostName.substring(0, hostName.indexOf('.'));
    }

    commander.xplSource = "tsx-script." + hostName;
  }

  var xpl = new Xpl(commander);

  xpl.on("error", function(error) {
    console.log("XPL error", error);
  });

  xpl.bind(function(error) {
    if (error) {
      console.error("Can not open xpl bridge ", error);
      process.exit(2);
      return;
    }

    console.log("Xpl bind succeed ");

    var scriptsEngine = new ScriptsEngine(xpl, commander);

    scriptsEngine.scan(params, function(error) {
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
