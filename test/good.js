// Load modules

var Lab = require('lab');
var Hapi = require('hapi');
var Hoek = require('hoek');
var Path = require('path');
var Fs = require('fs');
var Monitor = require('../lib/monitor');
var Async = require('async');
var GoodReporter = require('good-reporter');
var Http = require('http');


// Declare internals

var internals = {};

internals.makeBroadcaster = function (options, report) {

    options = options || {};
    options.events = options.events || {
        request: [],
        ops: [],
        log: [],
        error: []
    };
    var broadcaster = new GoodReporter(options);
    broadcaster.report = report;

    return broadcaster;
}

// Test shortcuts

var lab = exports.lab = Lab.script();
var expect = Lab.expect;
var before = lab.before;
var after = lab.after;
var describe = lab.describe;
var it = lab.it;


describe('Monitor', function () {

    var makePack = function (callback) {

        var holder = null;

        var plugin = {
            name: '--test',
            version: '0.0.0',
            register: function (pack, options, next) {

                holder = pack;
                next();
            }
        };

        var server = new Hapi.Server();
        server.pack.register(plugin, function (err) {

            expect(err).to.not.exist;
            expect(holder).to.exist;
            callback(holder, server);
        });
    };

    describe('#constructor', function () {

        it('throws an error constructed without new', function (done) {

            var fn = function () {

                var monitor = Monitor();
            };

            expect(fn).throws(Error, 'Monitor must be instantiated using new');
            done();
        });

        it('has no options', function (done) {

            makePack(function (pack, server) {

                var fn = function () {

                    var monitor = new Monitor(pack);
                };
                expect(fn).to.not.throw();
                done();
            });
        });

        it('throws an error if opsInterval is too small', function (done) {

            var options = {
                opsInterval: 50
            };

            makePack(function (pack, server) {

                var fn = function () {

                    var monitor = new Monitor(pack, options);
                };

                expect(fn).to.throw(Error, /opsInterval must be larger than or equal to 100/gi);
                done();
            });
        });

        it('does not throw an error when opsInterval is more than 100', function (done) {

            var options = {
                opsInterval: 100
            };

            makePack(function (pack, server) {

                var fn = function () {

                    var monitor = new Monitor(pack, options);
                };

                expect(fn).not.to.throw(Error);
                done();
            });
        });

        it('throws an error if requestsEvent is not response or tail', function (done) {

            var options = {
                requestsEvent: 'test'
            };

            makePack(function (pack, server) {

                var fn = function () {
                    var monitor = new Monitor(pack, options);
                };

                expect(fn).to.throw(Error, /requestsEvent must be one of response, tail/gi);
                done();
            });
        });

        it('requestsEvent is a response', function (done) {

            var options = {
                requestsEvent: 'response'
            };

            makePack(function (pack, server) {

                var fn = function () {

                    var monitor = new Monitor(pack, options);
                };

                expect(fn).not.to.throw(Error);
                done();
            });
        });
    });

    describe('broadcasting', function () {

        it('sends events to the immediate list when they occur', function (done) {

            var hitCount = 0;

            var server = new Hapi.Server('127.0.0.1', 0);
            server.route({
                method: 'GET',
                path: '/',
                handler: function (request, reply) {

                    server.log(['test'], 'test data');
                    server.emit('internalError', request, new Error('mock error'));
                    reply('done');
                }
            });

            var Reporter = function () {

                var settings = {
                    events: {
                        request: [],
                        ops: [],
                        log: [],
                        error: []
                    }
                };

                GoodReporter.call(this, settings);
                return this;
            };

            Hoek.inherits(Reporter, GoodReporter);

            Reporter.prototype.report = function (callback) {

                expect(this._eventQueue.length).to.equal(++hitCount);
                return callback(null);
            };

            var broadcaster = new Reporter();

            var plugin = {
                register: require('../lib/index').register,
                options: {
                    subscribers: [broadcaster]
                }
            };

            server.pack.register(plugin, function () {

                server.start(function () {

                    Http.get('http://127.0.0.1:' + server.info.port + '/?q=test', function (res) {

                        expect(res.statusCode).to.equal(200);
                        expect(hitCount).to.equal(3);
                        setTimeout(function () {

                            expect(broadcaster._eventQueue.length).to.equal(hitCount);
                        }, 200);

                        done();
                    });
                });
            });
        });
    });

});
