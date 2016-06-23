/*jslint node: true, vars: true, nomen: true, esversion: 6 */
'use strict';

const async = require('async');
const util = require('util');
const EventEmitter = require('events');
const debug = require('debug')('xpl-scripts:scriptsHost');
const debugEvent = require('debug')('xpl-scripts:scriptsHost:event');
const Path = require('path');
const LogRotateStream = require('logrotate-stream');
const fs = require('fs');
const DateFormat = require('dateformat');

const Script = require('./script');
const Cron = require('cron');

const LOG_DATE_FORMAT = 'dd/mm/yyyy HH:MM:ss.l';

const DEFAULT_LOGROTATE_SIZE = '128k';
const DEFAULT_LOGROTATE_KEEP = 4;
const DEFAULT_LOGROTATE_COMPRESS = true;

class ScriptsHost extends EventEmitter {
  constructor(path, mtime, configuration, query) {
    super();

    this.setMaxListeners(64);

    this.id = Script.id++;
    this.path = path;
    this._mtime = mtime;
    this._configuration = configuration;
    this._query = query;

    this._scriptsByName = {};

    this._resources = []; 

    this._installLogs();

    this.on("message", (...args) => this._processMessage(...args));
  }

  _installLogs() {
    var configuration = this._configuration;

    var logPath = Path.join(configuration.scriptsLogPath, Path.basename(
        this.path, ".js") + ".log");

    if (configuration.logRotate) {
      this._logStream = new LogRotateStream(
          {
            file : logPath,
            size : (configuration.logRotateSize || DEFAULT_LOGROTATE_SIZE),
            keep : (configuration.logRotateKeep || DEFAULT_LOGROTATE_KEEP),
            compress : (configuration.logRotateCompress || DEFAULT_LOGROTATE_COMPRESS)
          });

    } else {
      this._logStream = fs.createWriteStream(logPath, {
        flags : 'a',
        defaultEncoding : 'utf8'
      });
    }

    this.log(null, [ "Begin log" ]);

    this.on("destroyed", () => {
      if (!this._logStream) {
        return;
      }
      this.log(null, [ "Close log" ]);
      this._logStream.end();
      this._logStream = null;
    });
  }

  toString() {
    return "[ScriptsHost id=" + this.id + " path='" + this.path + "' mtime=" +
    this._mtime + " resources=" + this._resources.length + "]";
  }

  newScript(name) {
    if (!name) {
      name = Path.basename(this.path, ".js") + " #" + this.id;
    }
    if (this._scriptsByName[name]) {
      throw new Error("Script '" + name + "' already exists");
    }

    var script = new Script(this, name);

    this._scriptsByName[name] = script;

    script.on("destroying", () => {
      var resources = this._resources;
      for (var i = 0; i < resources.length; i++) {
        var resource = resources[i];
        if (resource.script !== script) {
          continue;
        }

        resources.splice(i, 1);
        i--;

        if (resource.unlink) {
          resource.unlink.call(resource);
        }
      }
    });

    script.on("destroyed", () => {
      this._destroyScript(script);
    });

    return script;
  }

  _initializeScripts(callback) {
    this._eachScript((script, callback) => {
      script._initialize(callback);
    }, callback);
  }

  _run(callback) {

    debug("Running Host #" + this.id + " (" + this.path + ")");

    this._eachScript((script, callback) => {
      script._run(callback);
    }, callback);
  }

  shutdown(reason, callback) {

    debug("Shutdown Host #" + this.id);

    this.emit("destroying", reason);

    this._eachScript((script, callback) => {
      script.shutdown(reason, callback);

    }, (error) => {
      if (error) {
        console.error(error);
      }

      debug("Destroyed Host #" + this.id);

      this.emit("destroyed", reason);

      callback(error);
    });
  }

  _eachScript(func, callback) {
    var scriptsByName = this._scriptsByName;

    var list = [];

    for ( var name in scriptsByName) {
      if (!scriptsByName.hasOwnProperty(name)) {
        continue;
      }

      list.push(scriptsByName[name]);
    }

    if (!list.length) {
      return callback();
    }

    async.eachSeries(list, func, callback);
  }

  _destroyScript(script) {
    var scriptsByName = this._scriptsByName;
    var scriptName = script.name;

    if (!(scriptName in scriptsByName)) {
      var error = new Error("Unknown script !");
      error.script = script;
      console.error(error);

      throw error;
    }

    delete scriptsByName[scriptName];
  }

  onXplTrig(script, unit, func) {
    return this._onXplMessage("xpl-trig", script, unit, func);
  }

  onXplStat(script, unit, func) {
    return this._onXplMessage("xpl-stat", script, unit, func);
  }

  onXplCmnd(script, unit, func) {
    return this._onXplMessage("xpl-cmnd", script, unit, func);
  }

  sendXplCommand(script, command, body,
      bodyName, target, callback) {
    var res = {
        script : script,
        command : command,
        body : body,
        bodyName : bodyName,
        target : target
    };

    if (callback) {
      res.func = callback;

      res.callback = this._callScriptFunc(res);
    }

    this.emit("sendXpl", res);
  }

  _onXplMessage(cmd, script, unit, func) {
    return this._addResource({
      id : Script.id++,
      type : "onXplMessage",
      script : script,
      unit : unit,
      func : func,
      command : cmd,
    });
  }

  _addResource(resource) {
    var resources = this._resources;
    resources.push(resource);

    return this._addResourceRef(resource.id);
  }

  _addResourceRef(resourceId) {
    var resources = this._resources;

    return () => {
      for (var i = 0; i < resources.length; i++) {
        var resource = resources[i];

        if (resource.id !== resourceId) {
          continue;
        }

        resources.splice(i, 1);

        if (resource.unlink) {
          resource.unlink.call(resource);
        }

        break;
      }
    };
  }

  _processMessage(packet, address, buffer) {
    var runit = packet.body.device || packet.body.address;
    var type = packet.body.type || packet.body.unit;
    if (type) {
      runit += "/" + type;
    }

    var unit = "";
    if (packet.header.source) {
      unit += packet.header.source;
    }
    unit += "/" + runit;

    debug("processMessage", "ScriptId=",this.id, "packet=", packet, " unit='", unit, "' runit='", runit, "'");

    var resources = this._resources.slice(0);
    resources.forEach((ref) => {
      if (ref.type !== "onXplMessage") {
        return;
      }

      if (!(ref.script.state & Script.RUNNING)) {
        debug("Trigs #", ref.id, "Not running ", ref.script.state);
        return;
      }

      if (ref.command && ref.command !== packet.headerName) {
        debug("Trigs #", ref.id, "Not right command", ref.command);
        return;
      }

      if (ref.unit) {
        if (util.isRegExp(ref.unit)) {
          if (!ref.unit.exec(unit)) {
            debug("Trigs #", ref.id, "Regexp refused", ref.unit, unit);
            return;
          }

        } else if (ref.unit !== "*") {
          if (/^\*\//.exec(ref.unit)) {
            if (ref.unit.slice(2) !== runit) {
              debug("Trigs #", ref.id, " bad unit (wilcard)", runit, ref.unit
                  .slice(2));
              return;
            }

          } else {
            if (ref.unit !== unit) {
              debug("Trigs #", ref.id, " bad unit", unit, ref.unit);
              return;
            }
          }
        }
      }

      debug("Trigs #", ref.id, " hit: call func for script #", ref.script.id);

      var f = this._callScriptFunc(ref);

      f(packet, address, buffer);
    });
  }

  _callScriptFunc(resource, throwException,
      context) {
    
    return function() { // pas de () => !!!! (on utilise arguments)
      var script = resource.script;

      if (!(script.state & Script.RUNNING)) {
        debug("CallScriptFunc #", script.id, " Not running ", script.state);
        return;
      }

      debugEvent("Enter script sandbox  script #", script.id, " type=",
          resource.type);

      var t0 = process.hrtime();
      var t1;
      var ret;
      try {
        ret = resource.func.apply(script, arguments);

        t1 = process.hrtime();

        return ret;

      } catch (x) {
        t1 = process.hrtime();

        script.lastErrorDate = new Date();
        script.lastError = x;

        console.error(x);

        if (x.stack) {
          console.error('Stacktrace:');
          console.error('====================');
          console.error(x.stack);
        }

        if (throwException) {
          throw x;
        }

      } finally {
        var diff = ((t1[0] - t0[0]) * 1e9 + (t1[1] - t0[1])) / 1e6;

        script.cpums += diff;

        if (context) {
          context.cpums = diff;
        }

        debugEvent("Exit script sandbox #", script.id, " in ", diff, "ms");
      }
    };
  }

  _cronTick(ref, onComplete) {
    // console.log("Cron tick ", ref);

    var f = this._callScriptFunc(ref);

    // console.log("Call f", f);
    f(onComplete);

    if (onComplete) {
      // console.log("Oncomplete, remove resource !");
      // Clean if user doesn't call stop()
      var idx = this._resources.indexOf(ref);
      if (idx >= 0) {
        this._resources.splice(idx, 1);
      }
    }
  }

  newCronJob(script, time, func) {

    var ref = {
        id : Script.id++,
        type : "cronJob",
        script : script,
        func : func,

        unlink : () => {
          // console.log("Unlink job ", this.job);
          if (!this.job) {
            return;
          }
          this.job.stop();
          this.job = null;
        }
    };

    var job = new Cron.CronJob({
      cronTime : time,
      onTick : this._cronTick.bind(this, ref),
      start : false
    });
    ref.job = job;

    var ret = this._addResource(ref);

    job.start();

    return ret;
  }

  setTimeout(script, func, delay) {
    var res = {
        id : Script.id++,
        type : "timeout",
        script : script,
        func : func,
        delay : delay,
        timeoutId : -1,

        unlink : () => {
          if (this.timeoutId < 0) {
            return;
          }

          clearTimeout(this.timeoutId);
          this.timeoutId = -1;
        }
    };

    var ret = this._addResource(res);

    res.timeoutId = setTimeout(this._callScriptFunc(res), delay);

    return ret;
  }

  setInterval(script, func, interval) {
    var res = {
        id : Script.id++,
        type : "interval",
        script : script,
        func : func,
        interval : interval,
        intervalId : -1,

        unlink : () => {
          if (this.intervalId < 0) {
            return;
          }

          clearInterval(this.intervalId);
          this.intervalId = -1;
        }
    };

    var ret = this._addResource(res);

    res.intervalId = setInterval(this._callScriptFunc(res), interval);

    return ret;
  }

  setImmediate(script, func) {
    var res = {
        id : Script.id++,
        type : "immediate",
        script : script,
        func : func,

        unlink : () => {
          var idx = this._resources.indexOf(res);
          if (idx >= 0) {
            this._resources.splice(idx, 1);
          }
        }
    };

    var ret = this._addResource(res);

    setImmediate(this._callScriptFunc(res));

    return ret;
  }

  _formatLog(script, args) {
    var s = Array.prototype.slice.call(args);

    var date = new Date();

    var dateFormat = this._configuration.logDateFormat || LOG_DATE_FORMAT;
    var name = (script && script.name);
    if (!name) {
      name = "*Host #" + this.id + "*";
    }
    s.unshift("[" + DateFormat(date, dateFormat) + "]", "[" + name + "]");

    return s;
  }

  log(script, args) {
    var message = this._formatLog(script, args);

    if (this._logStream) {
      var ms=["[LOG  ]"];
      message.forEach((o) => ms.push(util.inspect(o)));
      ms.push('\n');
      this._logStream.write(ms.join(' '));
      return;
    }

    console.log.apply(console, message);
  }

  error(script, args) {
    var message = this._formatLog(script.name, args);

    if (this._logStream) {
      var logStream = this._logStream;

      message.unshift("[ERROR]");
      message.push('\n');
      logStream.write(message.join(' '));

      message.forEach((msg) => {
        if (msg.stack) {
          logStream.write('\nStacktrace:\n');
          logStream.write('====================\n');
          logStream.write(msg.stack);
        }
      });
      return;
    }

    console.error.apply(console, message);

    message.forEach((msg) => {
      if (msg.stack) {
        console.error('\nStacktrace:');
        console.error('====================');
        console.error(msg.stack);
      }
    });
  }
}

module.exports = ScriptsHost;
