var fs = require("fs");
var os = require("os");
var stackTrace = require("stack-trace");
var sha1 = require("sha1");
var queue = require("./queue");

function Errplane() {
  this.apiKey = null;
  this.applicationId = null;
  this.environment = process.env.NODE_ENV || 'development';
}

Errplane.PACKAGE = (function() {
  var json = fs.readFileSync(__dirname + '/../package.json', 'utf8');
  return JSON.parse(json);
})();

Errplane.configure = function(options) {
  var instance = new this();

  instance.apiKey         = options["apiKey"];
  instance.applicationId  = options["applicationId"];
  instance.environment    = options["environment"] || instance.environment;

  return instance;
};

Errplane.prototype.handleUncaughtExceptions = function(die) {
  var self = this;

  process.on('uncaughtException', function(exception) {
    self._enqueueException(exception);

    if (die) {
      process.exit(1);
    }
  });

};

Errplane.prototype.expressExceptionHandler = function() {
  var self = this;

  return function exceptionHandler(exception, request, response, next) {
    if (response.statusCode < 400) response.statusCode = 500;
    exception.request_url = request.url;
    exception.action = request.method;
    exception.params = request.params;
    exception.session_data = request.session;
    exception.user_agent = request.headers["user-agent"];

    self._enqueueException(exception);
    next(exception);
  }
}

Errplane.prototype.reportException = function(exception) {
  this._enqueueException(exception);
}

Errplane.prototype.expressResponseTimeReporter = function() {
  self = this;

  return function(request, response, next){
    var start = Date.now();

    if (response._responseTime) return next();
    response._responseTime = true;

    self.report("controllers", {
      value: Date.now() - start
    })

    next();
  };
};

Errplane.prototype.report = function(name, options) {
  options = options || {}

  queue.push({
    name: name,
    value: options["value"],
    timestamp: options["timestamp"],
    context: options["context"]
  })
}

Errplane.prototype.heartbeat = function(name, interval, options) {
  self = this;
  setInterval(function() {
    self.report(name, options);
  }, interval);
}

Errplane.prototype.timeSync = function(name, f, context) {
  self = this;
  var timedFunction = function() {
    var start, end, result;

    context = context || this;
    start = Date.now();
    result = f.apply(context, arguments);
    var elapsed = Date.now() - start;
    self.report(name, {
      value: elapsed
    })
    return result;
  };
  return timedFunction;
};

Errplane.prototype.timeAsync = function(name, f, context) {
  self = this;
  var slice = Array.prototype.slice,

  timedFunction = function() {
    var args = slice.call(arguments), start, end, callback, timedCallback;
    context = context || this;
    callback = args.pop();
    timedCallback = function() {
      var elapsed = Date.now() - start;
      self.report(name, {
        value: elapsed
      })
    }

    args.push(timedCallback);
    start = Date.now();
    result = f.apply(context, args);
  };

  return timedFunction;
};

Errplane.prototype._enqueueException = function(exception) {
  payload = this._formatException(exception)

  point = {
    name: "exceptions/" + payload["hash"],
    context: payload
  }

  queue.push(point);
}

Errplane.prototype._formatException = function(exception) {
  var payload = {}

  backtrace = stackTrace.parse(exception).map(function(line) {
    return line.getFunctionName() + " " + line.getFileName() + ":" + line.getLineNumber();
  });

  request_data = {
    params: (exception.params instanceof Object) ? exception.params : {},
    session_data: (exception.session instanceof Object) ? exception.session : {},
    request_url: exception.request_url || null,
    user_agent: exception.user_agent || null
  }

  hash = sha1(exception.name + backtrace[0])

  payload["hash"] = hash;
  payload["backtrace"] = backtrace;
  payload["hostname"] = os.hostname();
  payload["message"] = exception.message;
  payload["exception_class"] = exception.name;
  payload["request_data"] = request_data;

  return payload;
}

module.exports = Errplane;
