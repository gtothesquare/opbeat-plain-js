var logger = require('../lib/logger')
var Trace = require('./trace')

var TraceBuffer = function (name) {
  this.traces = []
  this.activetraces = []
  this.traceTransactionReference = this
  this._isLocked = false
}

TraceBuffer.prototype.startTrace = function (signature, type) {
  logger.log('opbeat.instrumentation.TraceBuffer.startTrace', signature)

  var trace = new Trace(this.traceTransactionReference, signature, type)

  if (this._isLocked) {
    trace.setParent(this.traceTransactionReference._rootTrace)
  }

  this.activetraces.push(trace)

  return trace
}

TraceBuffer.prototype._onTraceEnd = function (trace) {
  logger.log('opbeat.instrumentation.TraceBuffer._endTrace', this.name, trace.signature)
  this.traces.push(trace)

  var index = this.activetraces.indexOf(trace)
  if (index > -1) {
    this.activetraces.splice(index, 1)
  }
  // TODO: Buffer should probably be flushed at somepoint to save memory
}

TraceBuffer.prototype.setTransactionReference = function (transaction) {

  logger.log('opbeat.instrumentation.TraceBuffer.setTransactionReference', transaction)

  if (this._isLocked) {
    return
  }

  this.traceTransactionReference = transaction

  this.activetraces.forEach(function (trace) {
    trace.transaction = this.traceTransactionReference
  }.bind(this))

  this.traces.forEach(function (trace) {
    trace.transaction = this.traceTransactionReference
    trace.setParent(this.traceTransactionReference._rootTrace)
  }.bind(this))

  this.traces = []
}

TraceBuffer.prototype.lock = function () {
  this._isLocked = true
}

module.exports = TraceBuffer
