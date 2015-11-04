/*jslint node: true, vars: true, nomen: true */
'use strict';

var async = require('async');
var Events = require('events');
var util = require('util');
var debug = require('debug')('xpl-scripts:script');

var scriptId = 0;

var Script = function(host, name) {
  this.id = scriptId++;
  this._scriptHost = host;
  this.name = name;

  this.cpums = 0;

  this._setState(Script.INITIALIZED | Script.PROCESSING);
};

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
  debug("Initializing script=", this);
  this.emit("initializing");

  this._setState(Script.INITIALIZED);

  this.emit("initialized");

  debug("Initialized script=", this);

  callback();
};

Script.prototype._run = function(callback) {
  debug("Starting script=", this);

  this._setState(Script.RUNNING | Script.PROCESSING);

  this.emit("starting");

  this._setState(Script.RUNNING);

  this.emit("running");

  debug("Running script=", this);

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

Script.prototype.onXplTrig = function(unit, func) {
  debug("onXplTrig unit=", unit, " script=", this);

  if (this.state & Script.DESTROYED) {
    throw new Error("Script has been destroyed");
  }

  return this._scriptHost.onXplTrig(this, unit, func);
};

Script.prototype.onXplStat = function(unit, func) {
  debug("onXplStat unit=", unit, " script=", this);

  if (this.state & Script.DESTROYED) {
    throw new Error("Script has been destroyed");
  }

  return this._scriptHost.onXplStat(this, unit, func);
};

Script.prototype.sendXplCmnd = function(body, bodyName, target, callback) {
  return this._scriptHost.sendXplCmnd(this, body, bodyName, target, callback);
};

Script.prototype.sendXplStat = function(body, bodyName, target, callback) {
  return this._scriptHost.sendXplStat(this, body, bodyName, target, callback);
};

Script.prototype.sendXplTrig = function(body, bodyName, target, callback) {
  return this._scriptHost.sendXplTrig(this, body, bodyName, target, callback);
};

Script.prototype.newCronJob = function(time, func) {
  return this._scriptHost.newCronJob(this, time, func);
};

function pad2(n) {
  if (n > 9) {
    return n;
  }
  return "0" + n;
}

function pad3(n) {
  if (n > 99) {
    return n;
  }
  if (n > 9) {
    return "0" + n;
  }
  return "00" + n;
}

function formatLog(name, args) {
  var s = Array.prototype.slice.call(args);

  var date = new Date();

  s.unshift("[" + pad2(date.getDate()) + "/" + pad2(date.getMonth() + 1) + "/" +
      date.getFullYear() + " " + pad2(date.getHours()) + ":" +
      pad2(date.getMinutes()) + ":" + pad2(date.getSeconds()) + "." +
      pad3(date.getMilliseconds()) + "]", "[" + name + "]");

  return s;
}

Script.prototype.log = function(message) {
  console.log.apply(console, formatLog(this.name, arguments));
};

Script.prototype.error = function(message) {
  console.error.apply(console, formatLog(this.name, arguments));
};

Script.prototype.setTimeout = function(func, delay) {
  return this._scriptHost.setTimeout(this, func, delay);
};

Script.prototype.setInterval = function(func, interval) {
  return this._scriptHost.setInterval(this, func, interval);
};

Script.prototype.setImmediate = function(func) {
  return this._scriptHost.setImmediate(this, func);
};

Script.prototype.callInContext = function(script, func) {
  var f = this._scriptHost._callScriptFunc({
    script : script,
    type : "callScript from #" + this.id,
    func : func
  }, true);

  var args = Array.prototype.slice.call(arguments, 2);

  return f.apply(this, args);
};
