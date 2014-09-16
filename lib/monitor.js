// Load modules

var Os = require('os');
var Events = require('events');
var Path = require('path');
var Fs = require('fs');
var Dgram = require('dgram');
var Url = require('url');
var Async = require('async');
var Hoek = require('hoek');
var Wreck = require('wreck');
var SafeStringify = require('json-stringify-safe');
var System = require('./system');
var Package = require('../package.json');
var Process = require('./process');
var Network = require('./network');
var Redis = null;                           // Loaded on demand
var Schema = require('./schema');
var Utils = require('./utils');
var GoodConsole = require('./reporter');

// Declare internals

var internals = {
    host: Os.hostname(),
    appVer: Package.version
};


internals.defaults = {
    schemaName: 'good.v1',                          // String to include using 'schema' key in update envelope
    broadcastInterval: 0,                           // MSec, 0 for immediately
    opsInterval: 15000,                             // MSec, equal to or greater than 100
    extendedRequests: false,
    requestsEvent: 'tail',                          // Sets the event used by the monitor to listen to finished requests. Other options: 'response'.
    subscribers: null,
    requestTimeout: 60000,                          // Number of ms to set timeout for http request to
    extraFields: {},                                // extra fields to include in the envelope
    logRequestHeaders: false,                       // log all headers on request
    logRequestPayload: false,                       // log payload of request
    logResponsePayload: false,                      // log payload of response
    logPid: false                                   // log pid
};


module.exports = internals.Monitor = function (plugin, options) {

    var self = this;

    var queMessage = function (eventType, data) {

        for (var i = 0, il = self.reporters.length; i < il; ++i) {
            var broadcaster = self.reporters[i];
            broadcaster.queue(eventType, data);
        }
    };

    var sendMessages = function (reporters) {

        Async.each(self.reporters, function (item, callback) {

            item.report(callback);
        }, function (error) {

            if (error) {
                console.error(error);
            }
        });
    };

    var setUpOpsMonitoring = function () {
        var pmonitor = new Process.Monitor();
        var os = new System.Monitor();
        var network = new Network.Monitor(plugin.events);

        var asyncOps = {
            osload: os.loadavg,
            osmem: os.mem,
            osup: os.uptime,
            psup: pmonitor.uptime,
            psmem: pmonitor.memory,
            psdelay: pmonitor.delay,
            requests: network.requests.bind(network),
            concurrents: network.concurrents.bind(network),
            responseTimes: network.responseTimes.bind(network)
        };

        // Set ops interval timer

        return function() {

            // Gather operational statistics in parallel

            Async.parallel(asyncOps, function (err, results) {

                if (!err) {
                    self.emit('ops', results);
                }
                network.reset();
            });
        };
    };

    var logHandler = function (event) {

        event = {
            event: 'log',
            timestamp: event.timestamp,
            tags: event.tags,
            data: event.data
        };

        if (self.settings.logPid) {
            event.pid = process.pid;
        }

        queMessage('log', event);
        sendMessages(self.instantReporters);
    };

    var errorHandler = function (request, error) {

        error = {
            event: 'error',
            url: request.url,
            method: request.method,
            timestamp: request.info.received,
            message: error.message,
            stack: error.stack
        };

        if (self.settings.logPid) {

            error.pid = process.pid;
        }

        queMessage('error', error);
        sendMessages(self.instantReporters);
    };

    var requestHandler = function (request) {

        var req = request.raw.req;
        var res = request.raw.res;

        var event = {
            event: 'request',
            timestamp: request.info.received,
            id: request.id,
            instance: request.server.info.uri,
            labels: request.server.settings.labels,
            method: request.method,
            path: request.path,
            query: request.query,
            source: {
                remoteAddress: request.info.remoteAddress,
                userAgent: req.headers['user-agent'],
                referer: req.headers.referer
            },
            responseTime: Date.now() - request.info.received,
            statusCode: res.statusCode
        };

        if (self.settings.extendedRequests) {
            event.log = request.getLog();
        }

        if (self.settings.logRequestHeaders) {
            event.headers = req.headers;
        }

        if (self.settings.logRequestPayload) {
            event.requestPayload = request.payload;
        }

        if (self.settings.logResponsePayload) {
            event.responsePayload = request.response.source;
        }

        if (self.settings.logPid) {
            event.pid = process.pid;
        }

        queMessage('request', event);
        sendMessages(self.instantReporters);
    };

    var opsHandler = function (results) {

        var event = {
            event: 'ops',
            timestamp: Date.now(),
            os: {
                load: results.osload,
                mem: results.osmem,
                uptime: results.osup
            },
            proc: {
                uptime: results.psup,
                mem: results.psmem,
                delay: results.psdelay
            },
            load: {
                requests: results.requests,
                concurrents: results.concurrents,
                responseTimes: results.responseTimes
            }
        };

        if (self.settings.logPid) {
            event.pid = process.pid;
        }

        queMessage('ops', event);
        sendMessages(self.instantReporters);
    };

    Hoek.assert(this.constructor === internals.Monitor, 'Monitor must be instantiated using new');

    this.settings = Hoek.applyToDefaults(internals.defaults, options || {});

    // If they didn't provide any subscribers, attach the default console one
    if (!this.settings.subscribers) {
        this.settings.subscribers = [{
            broadcaster: GoodConsole
        }];
    }

    this.reporters = [];
    this.delayedReporters = [];
    this.instantReporters = [];
    var state = {};

    // Validate settings
    Schema.assert('monitorOptions', this.settings);

    for (var i = 0, il = this.settings.subscribers.length; i < il; i++) {

        var item = this.settings.subscribers[i];
        // If it has a broadcaster constructor, then create a new one, otherwise, assume it is
        // a valid pre-constructured broadcaster
        var broadcaster = item.broadcaster ? new item.broadcaster(item.options) : item;

        //if (item.remote) {
        //    this.delayedReporters.push(broadcaster);
        //}
        //else {
        //    this.instantReporters.push(broadcaster);
        //}
        this.reporters.push(broadcaster);
    }

    Async.each(this.reporters, function (item, callback) {

       item.start(callback);
    }, function (error) {

        if (error) {
            throw new Error('Error starting reporters' + error.toString());
        }

        // Register as event emitter
        Events.EventEmitter.call(self);

        // Setup broadcast interval
        if (self.settings.broadcastInterval) {
            state.broadcastInterval = setInterval(function () {
                sendMessages(self.delayedReporters);
            }, self.settings.broadcastInterval);
        }

        // Initialize Events
        plugin.events.on('log', logHandler);
        plugin.events.on('internalError', errorHandler);
        plugin.events.on(self.settings.requestsEvent, requestHandler);
        state.opsInterval = setInterval(setUpOpsMonitoring(), self.settings.opsInterval);
        self.on('ops', opsHandler);

    });

    this.stop = function () {

        if (state.opsInterval) {
            clearInterval(state.opsInterval);
        }

        if (state.broadcastInterval) {
            clearInterval(state.broadcastInterval);
        }

        this.plugin.events.removeListener('log', logHandler);
        this.plugin.events.removeListener(this.settings.requestsEvent, requestHandler);
        this.removeListener('ops', opsHandler);
        this.plugin.events.removeListener('internalError', errorHandler);
    };

    return this;
};

Hoek.inherits(internals.Monitor, Events.EventEmitter);


internals.Monitor.prototype._makeEnvelope = function (subscriberQueue, uri) {

    var self = this;

    var envelope = {
        schema: self.settings.schemaName,
        host: internals.host,
        appVer: internals.appVer,
        timestamp: Date.now(),
        events: self._eventsFilter(self._subscriberTags[uri], subscriberQueue)
    };

    envelope = Hoek.applyToDefaults(self.settings.extraFields, envelope);

    return envelope;
};

internals.Monitor.prototype._broadcastHttp = function () {

    var self = this;

    Object.keys(self._subscriberQueues.http).forEach(function (uri) {

        var subscriberQueue = self._subscriberQueues.http[uri];
        if (!subscriberQueue.length) {
            return;
        }

        var envelope = self._makeEnvelope(subscriberQueue, uri);

        subscriberQueue.length = 0;                                     // Empty queue (must not set to [] or queue reference will change)

        Wreck.request('post', uri, { headers: { 'content-type': 'application/json' }, payload: JSON.stringify(envelope), timeout: self.settings.requestTimeout });
    });
};


internals.Monitor.prototype._broadcastUdp = function () {

    var self = this;
    var request = function (uri, payload) {
        var message = new Buffer(payload);

        var client = Dgram.createSocket('udp4');
        client.on('error', function (err) { });
        client.send(message, 0, message.length, uri.port, uri.hostname, function () {

            client.close();
        });
    };

    Object.keys(self._subscriberQueues.udp).forEach(function (uri) {

        var subscriberQueue = self._subscriberQueues.udp[uri];
        if (!subscriberQueue.length) {
            return;
        }

        var envelope = self._makeEnvelope(subscriberQueue, uri);

        subscriberQueue.length = 0;                                     // Empty queue (must not set to [] or queue reference will change)

        request(Url.parse(uri), JSON.stringify(envelope));
    });
};


internals.Monitor.prototype._broadcastRedis = function () {

    var self = this;
    var request = function (uri, payload) {

        Redis = Redis || require('redis');          // Loaded on demand to avoid forcing a redis dependency

        var message = new Buffer(payload);
        var client = Redis.createClient(uri.port, uri.hostname);

        client.on('error', function (err) { });

        client.on('connect', function () {

            client.rpush(uri.path.substring(1), message, function () {

                client.quit();
            });
        });
    };

    Object.keys(self._subscriberQueues.redis).forEach(function (uri) {

        var subscriberQueue = self._subscriberQueues.redis[uri];
        if (!subscriberQueue.length) {
            return;
        }

        var envelope = self._makeEnvelope(subscriberQueue, uri);

        subscriberQueue.length = 0;                                     // Empty queue (must not set to [] or queue reference will change)

        request(Url.parse(uri), JSON.stringify(envelope));
    });
};
