/*jslint node: true, vars: true, nomen: true, esversion: 6 */
'use strict';

const async = require('async');
const EventEmitter = require('events');
const util = require('util');
const debug = require('debug')('xpl-scripts:script');
const XplDBClient = require('xpl-dbclient');
const Query = XplDBClient.Query;

const dateFormat = require('dateformat');
dateFormat.i18n = {
    dayNames : [ 'Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dimanche',
                 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi' ],
                 monthNames : [ 'Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Aoû',
                                'Sep', 'Oct', 'Nov', 'Déc', 'Janvier', 'Février', 'Mars', 'Avril', 'Mai',
                                'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre' ]
};

const DEFAULT_SCRIPT_DATE_FORMAT = 'dd/mm/yyyy HH:MM:ss';

class Script extends EventEmitter {
  constructor(host, name) {
    super();

    this.id = Script.id++;
    this._scriptHost = host;
    this.name = name;

    this.cpums = 0;
    
    this.setMaxListeners(64);

    this._setState(Script.INITIALIZED | Script.PROCESSING);
  }

  toString() {
    return "[Script #" + this.id + " name='" + this.name + "' state=" +
    this.state + "]";
  }

  _setState(state) {
    this.state = state;

    debug("Change state of script #", this.id, " state=", state);
  }

  _initialize(callback) {
    debug("Initializing script #", this.id);
    this.emit("initializing");

    this._setState(Script.INITIALIZED);

    this.emit("initialized");

    debug("Initialized script #", this.id);

    callback();
  }

  _run (callback) {
    debug("Starting script #", this.id);

    this._setState(Script.RUNNING | Script.PROCESSING);

    this.emit("starting");

    this._setState(Script.RUNNING);

    this.emit("running");

    debug("Running script #", this.id);

    callback();
  }

  shutdown(reason, callback) {
    if (this.state & Script.DESTROYED) {
      return callback();
    }

    this._setState(Script.DESTROYED | Script.PROCESSING);

    this.emit("destroying");

    this._setState(Script.DESTROYED);

    this.emit("destroyed");

    delete this._scriptHost;

    callback();
  }

  onXplCmnd(unit, func) {
    if (arguments.length === 1) {
      func = unit;
      unit = "*";
    }

    debug("onXplCmnd unit=", unit, " script#", this.id);

    if (this.state & Script.DESTROYED) {
      throw new Error("Script has been destroyed");
    }

    return this._scriptHost.onXplCmnd(this, unit, func);
  }

  onXplTrig(unit, func) {
    if (arguments.length === 1) {
      func = unit;
      unit = "*";
    }

    debug("onXplTrig unit=", unit, " script#", this.id);

    if (this.state & Script.DESTROYED) {
      throw new Error("Script has been destroyed");
    }

    return this._scriptHost.onXplTrig(this, unit, func);
  }

  onXplStat(unit, func) {
    if (arguments.length === 1) {
      func = unit;
      unit = "*";
    }

    debug("onXplStat unit=", unit, " script#", this.id);

    if (this.state & Script.DESTROYED) {
      throw new Error("Script has been destroyed");
    }

    return this._scriptHost.onXplStat(this, unit, func);
  }

  sendXplMessage(command, body, bodyName, target,
      callback) {
    return this._scriptHost.sendXplCommand(this, command, body, bodyName, target,
        callback);
  }

  sendXplCmnd(body, bodyName, target, callback) {
    return this._scriptHost.sendXplCommand(this, "xpl-cmnd", body, bodyName,
        target, callback);
  }

  sendXplStat(body, bodyName, target, callback) {
    return this._scriptHost.sendXplCommand(this, "xpl-stat", body, bodyName,
        target, callback);
  }

  sendXplTrig(body, bodyName, target, callback) {
    return this._scriptHost.sendXplCommand(this, "xpl-trig", body, bodyName,
        target, callback);
  }

  newCronJob(time, func) {
    return this._scriptHost.newCronJob(this, time, func);
  }

  clearCronJob(jobId) {
    if (typeof (jobId) === "function") {
      jobId();
    }
  }

  log(message) {
    return this._scriptHost.log(this, arguments);
  }

  error(message) {
    return this._scriptHost.error(this, arguments);
  }

  setTimeout(func, delay) {
    return this._scriptHost.setTimeout(this, func, delay);
  }

  clearTimeout(timeoutId) {
    if (typeof (timeoutId) === "function") {
      timeoutId();
    }
  }

  setInterval(func, interval) {
    return this._scriptHost.setInterval(this, func, interval);
  }

  clearInterval(intervalId) {
    if (typeof (intervalId) === "function") {
      intervalId();
    }
  }

  setImmediate(func) {
    return this._scriptHost.setImmediate(this, func);
  }

  clearImmediate(immediateId) {
    if (typeof (immediateId) === "function") {
      immediateId();
    }
  }

  callInContext(script, func) {
    var context = {};
    var f = this._scriptHost._callScriptFunc({
      script : script,
      type : "callScript from #" + this.id,
      func : func
    }, true, context);

    var args = Array.prototype.slice.call(arguments, 2);

    try {
      return f.apply(this, args);

    } finally {
      if (context.cpums) {
        // Remove child script cpu cost !
        this.cpums -= context.cpums;
      }
    }
  }

  dateFormat(date, format) {
    return dateFormat(date, format || DEFAULT_SCRIPT_DATE_FORMAT);
  }
  
  queryLastValue(path, callback) {
    this._scriptHost._query.getLast(path, (error, value, response) => {
      if (error) {
        this.error("QueryLastValue error for path=",path,"error=",error);
      }
      
      callback(error, value, response);
    });
  }
  
  queryCumulated(path, options, callback) {
    this._scriptHost._query.getCumulated(path, options, (error, value, response) => {
      if (error) {
        this.error("QueryCumulated error for path=",path,"error=",error);
      }
      
      callback(error, value, response);
    });
  }
}

Script.id = 0;

Script.INITIALIZED = 0x00;
Script.RUNNING = 0x10;
Script.STOPPED = 0x20;
Script.DESTROYED = 0x40;

Script.PROCESSING = 0x01;

module.exports = Script;
