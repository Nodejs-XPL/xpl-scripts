/*jslint node: true, vars: true, nomen: true */
'use strict';

var async = require('async');
var Events = require('events');
var util = require('util');
var debug = require('debug')('xpl-scripts:script');

var dateFormat = require('dateformat');
dateFormat.i18n = {
  dayNames : [ 'Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dimanche',
      'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi' ],
  monthNames : [ 'Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Aoû',
      'Sep', 'Oct', 'Nov', 'Déc', 'Janvier', 'Février', 'Mars', 'Avril', 'Mai',
      'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre' ]
};

var DEFAULT_SCRIPT_DATE_FORMAT = 'dd/mm/yyyy HH:MM:ss';

var Script = function(host, name) {
  Events.EventEmitter.call(this);

  this.id = Script.id++;
  this._scriptHost = host;
  this.name = name;

  this.cpums = 0;

  this._setState(Script.INITIALIZED | Script.PROCESSING);
};

Script.id = 0;

Script.INITIALIZED = 0x00;
Script.RUNNING = 0x10;
Script.STOPPED = 0x20;
Script.DESTROYED = 0x40;

Script.PROCESSING = 0x01;

util.inherits(Script, Events.EventEmitter);

module.exports = Script;

Script.prototype.toString = function() {
  return "[Script #" + this.id + " name='" + this.name + "' state=" +
      this.state + "]";
};

Script.prototype._setState = function(state) {
  this.state = state;

  debug("Change state of script #", this.id, " state=", state);
};

Script.prototype._initialize = function(callback) {
  debug("Initializing script #", this.id);
  this.emit("initializing");

  this._setState(Script.INITIALIZED);

  this.emit("initialized");

  debug("Initialized script #", this.id);

  callback();
};

Script.prototype._run = function(callback) {
  debug("Starting script #", this.id);

  this._setState(Script.RUNNING | Script.PROCESSING);

  this.emit("starting");

  this._setState(Script.RUNNING);

  this.emit("running");

  debug("Running script #", this.id);

  callback();
};

Script.prototype.shutdown = function(reason, callback) {
  if (this.state & Script.DESTROYED) {
    return callback();
  }

  this._setState(Script.DESTROYED | Script.PROCESSING);

  this.emit("destroying");

  this._setState(Script.DESTROYED);

  this.emit("destroyed");

  delete this._scriptHost;

  callback();
};

Script.prototype.onXplCmnd = function(unit, func) {
  if (arguments.length === 1) {
    func = unit;
    unit = "*";
  }

  debug("onXplCmnd unit=", unit, " script#", this.id);

  if (this.state & Script.DESTROYED) {
    throw new Error("Script has been destroyed");
  }

  return this._scriptHost.onXplCmnd(this, unit, func);
};

Script.prototype.onXplTrig = function(unit, func) {
  if (arguments.length === 1) {
    func = unit;
    unit = "*";
  }

  debug("onXplTrig unit=", unit, " script#", this.id);

  if (this.state & Script.DESTROYED) {
    throw new Error("Script has been destroyed");
  }

  return this._scriptHost.onXplTrig(this, unit, func);
};

Script.prototype.onXplStat = function(unit, func) {
  if (arguments.length === 1) {
    func = unit;
    unit = "*";
  }

  debug("onXplStat unit=", unit, " script#", this.id);

  if (this.state & Script.DESTROYED) {
    throw new Error("Script has been destroyed");
  }

  return this._scriptHost.onXplStat(this, unit, func);
};

Script.prototype.sendXplMessage = function(command, body, bodyName, target,
    callback) {
  return this._scriptHost.sendXplCommand(this, command, body, bodyName, target,
      callback);
};
Script.prototype.sendXplCmnd = function(body, bodyName, target, callback) {
  return this._scriptHost.sendXplCommand(this, "xpl-cmnd", body, bodyName,
      target, callback);
};

Script.prototype.sendXplStat = function(body, bodyName, target, callback) {
  return this._scriptHost.sendXplCommand(this, "xpl-stat", body, bodyName,
      target, callback);
};

Script.prototype.sendXplTrig = function(body, bodyName, target, callback) {
  return this._scriptHost.sendXplCommand(this, "xpl-trig", body, bodyName,
      target, callback);
};

Script.prototype.newCronJob = function(time, func) {
  return this._scriptHost.newCronJob(this, time, func);
};

Script.prototype.log = function(message) {
  return this._scriptHost.log(this, arguments);
};

Script.prototype.error = function(message) {
  return this._scriptHost.error(this, arguments);
};

Script.prototype.setTimeout = function(func, delay) {
  return this._scriptHost.setTimeout(this, func, delay);
};

Script.prototype.clearTimeout = function(timeoutId) {
  if (typeof (timeoutId) === "function") {
    timeoutId();
  }
};

Script.prototype.setInterval = function(func, interval) {
  return this._scriptHost.setInterval(this, func, interval);
};

Script.prototype.clearInterval = function(intervalId) {
  if (typeof (intervalId) === "function") {
    intervalId();
  }
};

Script.prototype.setImmediate = function(func) {
  return this._scriptHost.setImmediate(this, func);
};

Script.prototype.clearImmediate = function(immediateId) {
  if (typeof (immediateId) === "function") {
    immediateId();
  }
};

Script.prototype.callInContext = function(script, func) {
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
};

Script.prototype.dateFormat = function(date, format) {
  return dateFormat(date, format || DEFAULT_SCRIPT_DATE_FORMAT);
};