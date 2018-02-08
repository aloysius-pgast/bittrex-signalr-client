"use strict";
const WebSocket = require('ws');
const _ = require('lodash');
const util = require('util');
const debug = require('debug')('BittrexSignalRClient:Client');
const Big = require('big.js');
const EventEmitter = require('events');
const SignalRConnection = require('./connection');

// how long should we wait before trying to reconnect upon disconnection
const RETRY_DELAY = 10 * 1000;

class SignalRClient extends EventEmitter
{

/*
    Following events related to connection can be emitted

    1) connectionError, when a connection/reconnection error occurs

    Data will be an object {step:string,attempts:integer,error:err}

    - step : connection step (negotiate|start|connect)
    - attempts : number of attempts to connect
    - error : the connection error which occurred

    Reconnection will be automatic

    2) disconnected, when WS has been disconnected by exchange

    Data will be an object {connectionId:string,code:integer,reason:string}

    - connectionId : id of SignelR connection
    - code: disconnection code
    - reason : disconnection reason

    Reconnection will be automatic

    3) terminated, when connection failed after last connection retry

    This is a final event

    Data will be an object {step:string,attempts:integer,error:err}

    - step : connection step (negotiate|start|connect)
    - attempts : number of attempts to connect
    - error : the connection error which occurred

    4) connected, when SignalRConnection connection is connected/reconnected

    Data will be an object {connectionId:string}

    - connectionId : id of SignalRConnection

    5) timeout, when watchdog detected that Bittrex stopped sending data

    Data will be an object {connectionId:string,dataType:string,lastTimestamp:integer}

    - connectionId : id of SignalRConnection
    - dataType: tickers|markets
    - lastTimestamp: unix timestamp (in ms) when last data was received

    If watchdog was configured to reconnect automatically, no action should be taken by client

    Following exchange events can be emitted

    1) ticker

    2) orderBook

    3) orderBookUpdate

    4) trades
*/

constructor(options)
{
    super();

    // subscriptions
    this._subscriptions = {
        tickers:{
            // wether or not we subscribed to tickers globally
            global:false,
            timestamp:null,
            pairs:{}
        },
        markets:{
            timestamp:null,
            pairs:{}
        }
    };

    this._unsubscribedMarkets = {
        pairs:{},
        count:0
    };

    this._reconnectAfterUnsubscribingFromMarkets = {
        // if true, SignalR connection will be reconnected upon unsubscribing from markets (to ensure we don't receive unwanted data)
        reconnect:true,
        // after how many unsubscriptions we want to reconnect
        after:1
    };

    this._logger = null;

    // used to detect and Bittrex stops sending data over websocket
    this._watchdog = {
        // used to detect timeout on markets data
        markets:{
            // defaults to 30 min
            timeout:1800000,
            // whether or not we should reconnect if data timeout occurs
            reconnect:true,
            lastTimestamp:0,
            timer:null
        },
        // used to detect timeout on tickers data
        tickers:{
            // defaults to 30 min
            timeout:1800000,
            // whether or not we should reconnect if data timeout occurs
            reconnect:true,
            lastTimestamp:0,
            timer:null
        }
    };

    this._retryDelay = RETRY_DELAY;
    this._connectionOptions = {};
    if (undefined !== options)
    {
        // data timeout
        if (undefined !== options.watchdog)
        {
            if (undefined !== options.watchdog.tickers)
            {
                if (undefined !== options.watchdog.tickers.timeout)
                {
                    this._watchdog.tickers.timeout = options.watchdog.tickers.timeout;
                }
                if (undefined !== options.watchdog.tickers.reconnect && false === options.watchdog.tickers.reconnect)
                {
                    this._watchdog.tickers.reconnect = false;
                }
            }
            if (undefined !== options.watchdog.markets)
            {
                if (undefined !== options.watchdog.markets.timeout)
                {
                    this._watchdog.markets.timeout = options.watchdog.markets.timeout;
                }
                if (undefined !== options.watchdog.markets.reconnect && false === options.watchdog.markets.reconnect)
                {
                    this._watchdog.markets.reconnect = false;
                }
            }
        }
        // retry count
        if (undefined !== options.retryCount)
        {
            let retryCount = {};
            _.forEach(['negotiate','connect','start'], (step) => {
                if (undefined !== options.retryCount[step])
                {
                    if ('always' == options.retryCount[step])
                    {
                        retryCount[step] = -1;
                    }
                    else
                    {
                        let value = parseInt(options.retryCount[step]);
                        if (isNaN(value) || value < 0)
                        {
                            throw new Error(`Argument 'options.retryCount.${step}' should be 'always' or an integer >= 0`);
                        }
                        else
                        {
                            retryCount[step] = value;
                        }
                    }
                }
            });
            this._connectionOptions.retryCount = retryCount;
        }
        if (undefined !== options.retryDelay)
        {
            let value = parseInt(options.retryDelay);
            if (isNaN(value) || value <= 0)
            {
                throw new Error("Argument 'options.retryDelay' should be an integer > 0");
            }
            this._retryDelay = value;
            this._connectionOptions.retryDelay = value;
        }
        if (undefined !== options.ignoreStartStep)
        {
            if (false !== options.ignoreStartStep && true !== options.ignoreStartStep)
            {
                throw new Error("Argument 'options.ignoreStartStep' should be a boolean");
            }
            this._connectionOptions.ignoreStartStep = true === options.ignoreStartStep;
        }
        if (undefined != options.userAgent && '' != options.userAgent)
        {
            this._connectionOptions.userAgent = options.userAgent;
        }
        if (undefined !== options.pingTimeout)
        {
            let value = parseInt(options.pingTimeout);
            if (isNaN(value) || value < 0)
            {
                throw new Error("Argument 'options.pingTimeout' should be an integer >= 0");
            }
            this._connectionOptions.pingTimeout = value;
        }
        if (undefined !== options.reconnectAfterUnsubscribingFromMarkets)
        {
            if (undefined !== options.reconnectAfterUnsubscribingFromMarkets)
            {
                if (false !== options.reconnectAfterUnsubscribingFromMarkets.reconnect && true !== options.reconnectAfterUnsubscribingFromMarkets.reconnect)
                {
                    throw new Error("Argument 'options.reconnectAfterUnsubscribingFromMarkets.reconnect' should be a boolean");
                }
                this._reconnectAfterUnsubscribingFromMarkets.reconnect = true === options.reconnectAfterUnsubscribingFromMarkets.reconnect;
            }
            if (this._reconnectAfterUnsubscribingFromMarkets.reconnect)
            {
                if (undefined !== options.reconnectAfterUnsubscribingFromMarkets.after)
                {
                    let value = parseInt(options.reconnectAfterUnsubscribingFromMarkets.after);
                    if (isNaN(value) || value < 1)
                    {
                        throw new Error("Argument 'options.reconnectAfterUnsubscribingFromMarkets.after' should be an integer >= 1");
                    }
                    this._reconnectAfterUnsubscribingFromMarkets.after = value;
                }
            }
        }
        if (undefined !== options.logger)
        {
            this._logger = options.logger;
        }
    }

    // ensure we correctly parse datetime string
    this._timeOffset = new Date().getTimezoneOffset() * -60;

    // keep track of how many connections we started
    this._connectionCounter = 0;
    this._connection = null;
    // SignalR connection id
    this._connectionId = null;
    // timestamp of last connected event
    this._connectedTimestamp = null;
}

/*
 * The result of being lazy
 */
_debugChanges(changes)
{
    try
    {
        let stack = new Error().stack;
        let line = stack.split('\n')[2];
        let method = line.replace(/^.* at [a-zA-Z0-9_.][a-zA-Z0-9_]*\.([a-zA-Z0-9_]+).*$/, '$1');
        debug(`Method '${method}' will trigger following changes : ${JSON.stringify(changes)}`);
    }
    catch (e)
    {
        return;
    }
}

/**
 * Initialize markets subscriptions for a given pair
 *
 * @param {float} timestamp timestamp of the first subscription
 */
_initializeMarketsPair(timestamp)
{
    let obj = {
        // last time subscription for current pair has changed
        timestamp:timestamp,
        lastCseq:0,
        lastUpdateCseq:0
    }
    return obj;
}

/**
 * Subscribe to order books & trades for a list of pairs
 *
 * @param {array} pairs array of pairs
 * @param {boolean} reset if true, previous subscriptions will be ignored (default = false)
 * @param {boolean} connect whether or not connection with exchange should be established if necessary (optional, default = true)
 */
subscribeToMarkets(pairs, reset, connect)
{
    if (undefined === connect)
    {
        connect = true;
    }
    let timestamp = (new Date().getTime()) / 1000.0;
    let changes = {
        subscribe:[],
        unsubscribe:[],
        resync:[]
    };
    let updated = false;

    // just add new subscriptions
    if (undefined === reset || false === reset)
    {
        // process subscribe
        _.forEach(pairs, (p) => {
            // no subscriptions for this pair yet
            if (undefined === this._subscriptions.markets.pairs[p])
            {
                this._subscriptions.markets.pairs[p] = this._initializeMarketsPair(timestamp);
                changes.subscribe.push({entity:'market',pair:p});
                // request full order book for new pair
                changes.resync.push({entity:'orderBook',pair:p})
                updated = true;
            }
        });
    }
    // add new subscriptions & discard previous
    else
    {
        let newPairs = {};
        // check new subscriptions
        _.forEach(pairs, (p) => {
            if (undefined !== newPairs[p])
            {
                return;
            }
            // pair has been added
            if (undefined === this._subscriptions.markets.pairs[p])
            {
                newPairs[p] = this._initializeMarketsPair(timestamp);
                changes.subscribe.push({entity:'market',pair:p});
                // request full order book for new pair
                changes.resync.push({entity:'orderBook',pair:p})
                updated = true;
            }
            else
            {
                newPairs[p] = this._subscriptions.markets.pairs[p];
            }
        });
        // check if we need to unsubscribe
        _.forEach(this._subscriptions.markets.pairs, (obj, p) => {
            // pair has been removed
            if (undefined === newPairs[p])
            {
                changes.unsubscribe.push({entity:'market',pair:p});
                if (this._reconnectAfterUnsubscribingFromMarkets.reconnect)
                {
                    if (undefined === this._unsubscribedMarkets.pairs[p])
                    {
                        this._unsubscribedMarkets.pairs[p] = timestamp;
                        ++this._unsubscribedMarkets.count;
                    }
                }
                updated = true;
            }
        });
        this._subscriptions.markets.pairs = newPairs;
    }
    if (updated)
    {
        if (debug.enabled)
        {
            this._debugChanges(changes);
        }
        this._subscriptions.markets.timestamp = timestamp;
        this._processChanges(changes, connect);
    }
}

/**
 * Unsubscribe from order books & trades for a list of pairs
 *
 * @param {array} pairs array of pairs
 */
unsubscribeFromMarkets(pairs)
{
    let timestamp = (new Date().getTime()) / 1000.0;
    let changes = {
        unsubscribe:[]
    };
    let updated = false;
    _.forEach(pairs, (p) => {
        if (undefined !== this._subscriptions.markets.pairs[p])
        {
            changes.unsubscribe.push({entity:'market',pair:p})
            if (this._reconnectAfterUnsubscribingFromMarkets.reconnect)
            {
                if (undefined === this._unsubscribedMarkets.pairs[p])
                {
                    this._unsubscribedMarkets.pairs[p] = timestamp;
                    ++this._unsubscribedMarkets.count;
                }
            }
            delete this._subscriptions.markets.pairs[p];
            updated = true;
        }
    });
    if (updated)
    {
        if (debug.enabled)
        {
            this._debugChanges(changes);
        }
        this._subscriptions.markets.timestamp = timestamp;
        this._processChanges(changes, false);
    }
}

/**
 * Unsubscribe from order books & trades for all currently subscribed pairs
 *
 * @param {array} pairs array of pairs
 */
unsubscribeFromAllMarkets()
{
    // we don't have any subscribed markets
    if (_.isEmpty(this._subscriptions.markets.pairs))
    {
        return;
    }
    let timestamp = (new Date().getTime()) / 1000.0;
    let changes = {
        unsubscribe:[]
    };
    _.forEach(this._subscriptions.markets.pairs, (obj, p) => {
        changes.unsubscribe.push({entity:'market',pair:p});
        if (this._reconnectAfterUnsubscribingFromMarkets.reconnect)
        {
            if (undefined === this._unsubscribedMarkets.pairs[p])
            {
                this._unsubscribedMarkets.pairs[p] = timestamp;
                ++this._unsubscribedMarkets.count;
            }
        }
    });
    this._subscriptions.markets.timestamp = timestamp;
    this._subscriptions.markets.pairs = {};
    if (debug.enabled)
    {
        this._debugChanges(changes);
    }
    this._processChanges(changes, false);
}

/**
 * Resync order books (ie: ask for full order book) for a list of pairs
 *
 * @param {array} pairs array of pairs
 */
resyncOrderBooks(pairs)
{
    let changes = {
        resync:[]
    };
    let updated = false;
    _.forEach(pairs, (p) => {
        // no subscription for this pair
        if (undefined === this._subscriptions.markets.pairs[p])
        {
            return;
        }
        changes.resync.push({entity:'orderBook', pair:p});
        updated = true;
    });
    if (updated)
    {
        if (debug.enabled)
        {
            this._debugChanges(changes);
        }
        this._processChanges(changes, true);
    }
}

/**
 * Subscribe to all tickers
 *
 * @param {boolean} connect whether or not connection with exchange should be established if necessary (optional, default = true)
 */
subscribeToAllTickers(connect)
{
    // we already subscribed to all tickers
    if (this._subscriptions.tickers.global)
    {
        return;
    }
    if (undefined === connect)
    {
        connect = true;
    }
    let timestamp = (new Date().getTime()) / 1000.0;
    let changes = {
        subscribe:[{entity:'ticker',global:true}],
        unsubscribe:[]
    };
    this._subscriptions.tickers.pairs = {};
    if (debug.enabled)
    {
        this._debugChanges(changes);
    }
    this._subscriptions.tickers.global = true;
    this._subscriptions.tickers.timestamp = timestamp;
    this._processChanges(changes, connect);
}

/**
 * Subscribe to tickers for a list of pairs
 *
 * @param {array} pairs array of pairs
 * @param {boolean} reset, previous subscriptions will be ignored (default = false)
 * @param {boolean} connect whether or not connection with exchange should be established if necessary (optional, default = true)
 */
subscribeToTickers(pairs, reset, connect)
{
    // ignore if we subscribed to tickers globally
    if (this._subscriptions.tickers.global)
    {
        return;
    }
    if (undefined === connect)
    {
        connect = true;
    }
    let timestamp = (new Date().getTime()) / 1000.0;
    let changes = {
        subscribe:[],
        unsubscribe:[]
    };
    let updated = false;

    // just add new subscriptions
    if (undefined === reset || false === reset)
    {
        // process subscribe
        _.forEach(pairs, (p) => {
            // no subscriptions for this pair yet
            if (undefined === this._subscriptions.tickers.pairs[p])
            {
                this._subscriptions.tickers.pairs[p] = timestamp;
                changes.subscribe.push({entity:'ticker',pair:p});
                updated = true;
            }
        });
    }
    // add new subscriptions & discard previous
    else
    {
        let newPairs = {};
        // check new subscriptions
        _.forEach(pairs, (p) => {
            if (undefined !== newPairs[p])
            {
                return;
            }
            // pair has been added
            if (undefined === this._subscriptions.tickers.pairs[p])
            {
                newPairs[p] = timestamp;
                changes.subscribe.push({entity:'ticker',pair:p});
                updated = true;
            }
            else
            {
                newPairs[p] = this._subscriptions.tickers.pairs[p];
            }
        });
        // check if we need to unsubscribe
        _.forEach(this._subscriptions.tickers.pairs, (ts, p) => {
            // pair has been removed
            if (undefined === newPairs[p])
            {
                changes.unsubscribe.push({entity:'ticker',pair:p});
                updated = true;
            }
        });
        this._subscriptions.tickers.pairs = newPairs;
    }
    if (updated)
    {
        if (debug.enabled)
        {
            this._debugChanges(changes);
        }
        this._subscriptions.tickers.timestamp = timestamp;
        this._processChanges(changes, connect);
    }
}

/**
 * Unsubscribe from tickers for a list of pairs
 *
 * @param {array} pairs array of pairs
 */
unsubscribeFromTickers(pairs)
{
    // ignore if we subscribed to tickers globally
    if (this._subscriptions.tickers.global)
    {
        return;
    }
    let timestamp = (new Date().getTime()) / 1000.0;
    let changes = {
        unsubscribe:[]
    };
    let updated = false;
    _.forEach(pairs, (p) => {
        if (undefined !== this._subscriptions.tickers.pairs[p])
        {
            changes.unsubscribe.push({entity:'ticker',pair:p})
            delete this._subscriptions.tickers.pairs[p];
            updated = true;
        }
    });
    if (updated)
    {
        if (debug.enabled)
        {
            this._debugChanges(changes);
        }
        this._subscriptions.tickers.timestamp = timestamp;
        this._processChanges(changes, false);
    }
}

/**
 * Unsubscribe from all tickers
 */
unsubscribeFromAllTickers()
{
    // we don't have any subscribed tickers
    if (!this._subscriptions.tickers.global && _.isEmpty(this._subscriptions.tickers.pairs))
    {
        return;
    }
    let timestamp = (new Date().getTime()) / 1000.0;
    let changes = {
        unsubscribe:[]
    };
    this._subscriptions.tickers.timestamp = timestamp;
    if (this._subscriptions.tickers.global)
    {
        changes.unsubscribe.push({entity:'ticker',global:true})
    }
    else
    {
        _.forEach(this._subscriptions.tickers.pairs, (p) => {
            changes.unsubscribe.push({entity:'ticker',pair:p})
        });
        this._subscriptions.tickers.pairs = {};
    }
    if (debug.enabled)
    {
        this._debugChanges(changes);
    }
    this._subscriptions.tickers.global = false;
    this._processChanges(changes, false);
}

/**
 * Process subscription changes
 *
 * @param {object} changes list of changes to process
 * @param {boolean} connect whether or not connection with exchange should be established if necessary
 *
 *  Each property (subscribe,unsubscribe,resync) is optional
 *  Entity can be (ticker,market) for subscribe/unsubscribe or (orderBook) for resync
 *
 * {
 *    "subscribe":[{"entity":"","pair":""},...],
 *    "unsubscribe":[{"entity":"","pair":""},...],
 *    "resync":[{"entity":"","pair":""},...]
 * }
 */
_processChanges(changes, connect)
{
    if (null === this._connection)
    {
        if (connect)
        {
            this._createConnection();
        }
        return;
    }
    if (!this._connection.isConnected())
    {
        return;
    }
    // check if we need to reconnect
    if (this._reconnectAfterUnsubscribingFromMarkets.reconnect && this._unsubscribedMarkets.count >= this._reconnectAfterUnsubscribingFromMarkets.after)
    {
        this.reconnect(true);
        return;
    }
    // check if we need to resync order books
    if (undefined !== changes.resync)
    {
        _.forEach(changes.resync, (entry) => {
            this._queryExchangeState(entry.pair);
        });
    }
    // check if we need to subscribe to markets/tickers
    if (undefined !== changes.subscribe)
    {
        _.forEach(changes.subscribe, (entry) => {
            switch (entry.entity)
            {
                case 'market':
                    this._connection.callMethod('SubscribeToExchangeDeltas', [entry.pair]);
                    break;
                // Since 20/11/2017 tickers update are not sent automatically and require method SubscribeToSummaryDeltas
                case 'ticker':
                    this._connection.callMethod('SubscribeToSummaryDeltas');
                    break;
            }
        });
    }
    this._initializeWatchdog();
}

/**
 * Clears all watchdog timers
 */
_clearWatchdogTimers()
{
    this._clearWatchdogTimer('tickers');
    this._clearWatchdogTimer('markets');
}

/**
 * Clears a specific timer
 *
 * @param {string} type tickers|markets
 */
_clearWatchdogTimer(type)
{
    if (undefined === this._watchdog[type])
    {
        return;
    }
    if (null !== this._watchdog[type].timer)
    {
        clearTimeout(this._watchdog[type].timer);
        this._watchdog[type].timer = null;
    }
}

/**
 * Checks if watchdog timers should be started / stopped
 */
_initializeWatchdog()
{
    // tickers watchdog is enabled
    if (0 != this._watchdog.tickers.timeout)
    {
        // no subscriptions => disable watchdog
        if (!this._subscriptions.tickers.global && _.isEmpty(this._subscriptions.tickers.pairs))
        {
            if (debug.enabled)
            {
                debug("Watchdog for 'tickers' will be disabled since we don't have any remaining subscription");
            }
            this._clearWatchdogTimer('tickers');
        }
        else
        {
            this._startWatchdogTimer('tickers');
        }
    }
    // markets watchdog is enabled
    if (0 != this._watchdog.markets.timeout)
    {
        // no subscriptions => disable watchdog
        if (_.isEmpty(this._subscriptions.markets.pairs))
        {
            if (debug.enabled)
            {
                debug("Watchdog for 'markets' will be disabled since we don't have any remaining subscription");
            }
            this._clearWatchdogTimer('markets');
        }
        else
        {
            this._startWatchdogTimer('markets');
        }
    }
}

/**
 * Starts a specific timer
 *
 * @param {string} type tickers|markets
 */
_startWatchdogTimer(type)
{
    if (undefined === this._watchdog[type])
    {
        return;
    }
    // timer already exists
    if (null !== this._watchdog[type].timer)
    {
        return;
    }
    let self = this;
    if (debug.enabled)
    {
        debug("Watchdog for '%s' will be started since we have at least one subscription", type);
    }
    this._watchdog[type].timer = setInterval(function(){
        // if socket is not connected, do nothing
        if (!self.isConnected.call(self))
        {
            return;
        }
        let timestamp = new Date().getTime();
        // timeout triggered
        let delta = timestamp - self._watchdog[type].lastTimestamp;
        if (debug.enabled)
        {
            debug("Last '%s' data was received %dms ago", type, delta);
        }
        if (delta > self._watchdog[type].timeout)
        {
            if (debug.enabled)
            {
                debug("Data timeout occured for '%s' : last data received at = %d", type, self._watchdog[type].lastTimestamp);
            }
            let evt = {connectionId:self._connectionId,type:type,lastTimestamp:self._watchdog[type].lastTimestamp}
            self.emit('timeout', evt);
            // reconnect if necessary
            if (self._watchdog[type].reconnect)
            {
                if (null !== self._logger)
                {
                    self._logger.warn("Data timeout occured (bittrex|%d|%s), will try to reconnect immediately", self._connectionCounter, self._connectionId);
                }
                self.reconnect.call(self, true);
            }
        }
    }, this._watchdog[type].timeout);
}

/**
 * Creates a new connection
 *
 * @param {integer} delay delay in ms before creating the connection (optional, default = no delay)
 */
_createConnection(delay)
{
    this._connectionCounter += 1;
    this._connectionId = null;
    let connection = new SignalRConnection(this._connectionOptions);
    let self = this;

    connection.on('disconnected', function(data){
        // clear timers for data timeout
        self._clearWatchdogTimers.call(self);
        if (debug.enabled)
        {
            debug("Connection (bittrex|%d|%s) disconnected, will try to reconnect in %dms", self._connectionCounter, data.connectionId, self._retryDelay);
        }
        if (null !== self._logger)
        {
            self._logger.warn("Connection (bittrex|%d|%s) disconnected, will try to reconnect in %dms", self._connectionCounter, data.connectionId, self._retryDelay);
        }
        self.emit('disconnected', {connectionId:data.connectionId, code:data.code, reason:data.reason});
        self._createConnection.call(self, self._retryDelay);
    });

    connection.on('connectionError', function(err){
        // retry is possible
        if (err.retry)
        {
            if (debug.enabled)
            {
                debug("Connection (bittrex|%d|%s) failed (will try to reconnect in %dms) : attempts = %d, error = '%s'", self._connectionCounter, err.step, self._retryDelay, err.attempts, JSON.stringify(err.error));
            }
            if (null !== self._logger)
            {
                self._logger.warn("Connection (bittrex|%d|%s) failed (will try to reconnect in %dms) : attempts = %d, error = '%s'", self._connectionCounter, err.step, self._retryDelay, err.attempts, JSON.stringify(err.error));
            }
            self.emit('connectionError', {step:err.step,attempts:err.attempts,error:err.error});
            return;
        }
        // no more retry
        if (debug.enabled)
        {
            debug("Connection (bittrex|%s|%s) failed (no more retry left) : attempts = %d, error = '%s'", self._connectionCounter, err.step, err.attempts, JSON.stringify(err.error));
        }
        if (null !== self._logger)
        {
            self._logger.warn("Connection (bittrex|%d|%s) failed (no more retry left) : attempts = %d, error = '%s'", self._connectionCounter, err.step, err.attempts, JSON.stringify(err.error));
        }
        self.emit('terminated', {step:err.step,attempts:err.attempts,error:err.error});
    });

    connection.on('connected', function(data){
        // clear timers for data timeout
        self._clearWatchdogTimers.call(self);
        self._connectionId = data.connectionId;
        if (debug.enabled)
        {
            debug("Connection (bittrex|%d|%s) connected", self._connectionCounter, data.connectionId);
        }
        if (null !== self._logger)
        {
            self._logger.info("Connection (bittrex|%d|%s) connected", self._connectionCounter, data.connectionId);
        }
        self.emit('connected', {connectionId:data.connectionId});
        self._connectedTimestamp = (new Date().getTime()) / 1000.0;
        self._processSubscriptions.call(self);
    });

    connection.on('data', function(data){
        self._processData.call(self, data);
    });

    this._connection = connection;

    try
    {
        // connect immediately
        if (undefined === delay)
        {
            connection.connect();
        }
        else
        {
            setTimeout(function(){
                // disconnection probably requested by client
                if (null === self._connection)
                {
                    return;
                }
                connection.connect();
            }, delay);
        }
    }
    catch (e)
    {
        throw e;
    }
}

/**
 * This method will be called upon reconnection and will call _processChanges
 */
_processSubscriptions()
{
    let changes = {
        subscribe:[],
        resync:[]
    };
    // we just reconnected, reset unsubscribed markets
    this._unsubscribedMarkets = {
        pairs:{},
        count:0
    };
    if (this._subscriptions.tickers.global)
    {
        changes.subscribe.push({entity:'ticker',global:true});
    }
    else
    {
        _.forEach(Object.keys(this._subscriptions.tickers.pairs), (p) => {
            changes.subscribe.push({entity:'ticker',pair:p});
        });
    }
    _.forEach(Object.keys(this._subscriptions.markets.pairs), (p) => {
        changes.subscribe.push({entity:'market',pair:p});
        // request full order book upon reconnection
        changes.resync.push({entity:'orderBook',pair:p});
    });
    this._processChanges(changes);
}

/*
 Example data
 {
    "MarketName":null,
    "Nounce":159676,
    "Buys":[
        {
            "Quantity":0.29819029,
            "Rate":4816
        },
        {
            "Quantity":0.07981391,
            "Rate":4815.03
        },...
    ],
    "Sells":[
        {
            "Quantity":0.45209953,
            "Rate":4829.99998998
        },
        {
            "Quantity":0.03123587,
            "Rate":4829.99999
        },...
    ],
    "Fills":[
        {
            "Id":19214614,
            "TimeStamp":"2017-10-11T11:40:00.43",
            "Quantity":0.10501188,
            "Price":4816,
            "Total":505.73721408,
            "FillType":"PARTIAL_FILL",
            "OrderType":"SELL"
        },
        {
            "Id":19214613,
            "TimeStamp":"2017-10-11T11:40:00.43",
            "Quantity":0.00683507,
            "Price":4816,
            "Total":32.91769712,
            "FillType":"FILL",
            "OrderType":"SELL"
        },...
    ]
}
 */
_queryExchangeState(pair)
{
    // reset nounce
    this._subscriptions.markets.pairs[pair].cseq = 0;
    let self = this;
    this._connection.callMethod('QueryExchangeState', [pair], function(data, err){
        // we got an error
        if (null !== err)
        {
            if (debug.enabled)
            {
                debug("Could not query exchange for pair '%s' (might be an invalid pair) : err = '%s'", pair, err);
            }
            delete self._subscriptions.markets.pairs[pair];
            return;
        }
        // ignore if we're not subscribed to this pair anymore
        if (undefined === self._subscriptions.markets.pairs[pair])
        {
            return;
        }
        self._subscriptions.markets.pairs[pair].lastCseq = data.Nounce;

        // build events
        let orderBookEvt = {
            pair:pair,
            cseq:data.Nounce,
            data:{
                buy:_.map(data.Buys, entry => {
                    return {
                        rate:parseFloat(entry.Rate),
                        quantity:parseFloat(entry.Quantity)
                    }
                }),
                sell:_.map(data.Sells, entry => {
                    return {
                        rate:parseFloat(entry.Rate),
                        quantity:parseFloat(entry.Quantity)
                    }
                })
            }
        }
        let tradesEvt = {
            pair:pair,
            data:_.map(data.Fills, entry => {
                let price = undefined !== entry.Total ? entry.Total : parseFloat(new Big(entry.Quantity).times(entry.Price));
                let orderType = 'sell';
                if ('BUY' == entry.OrderType)
                {
                    orderType = 'buy';
                }
                return {
                    id:entry.Id,
                    quantity:entry.Quantity,
                    rate:entry.Price,
                    price:price,
                    orderType:orderType,
                    timestamp:parseFloat(new Date(entry.TimeStamp).getTime() / 1000.0) + self._timeOffset
                }
            })
        }

        // emit events
        if (0 != orderBookEvt.data.buy.length || 0 != orderBookEvt.data.sell.length)
        {
            self.emit('orderBook', orderBookEvt);
        }
        if (0 != tradesEvt.data.length)
        {
            // only if we didn't already emitted a 'trades' event for same cseq
            if (self._subscriptions.markets.pairs[pair].lastUpdateCseq != data.Nounce)
            {
                self.emit('trades', tradesEvt);
            }
        }
    });
}

/*
  {"H":"CoreHub","M":"updateExchangeState","A":[]}
 */
_processData(data)
{
    try
    {
        let methodName = data.M.toLowerCase();
        switch (methodName)
        {
            case 'updateexchangestate':
                _.forEach(data.A, (entry) => {
                    this._processUpdateExchangeState(entry);
                })
                break;
            case 'updatesummarystate':
                _.forEach(data.A, (entry) => {
                    this._processUpdateSummaryState(entry);
                })
                break;
        };
    }
    catch (e)
    {
        if (debug.enabled)
        {
            debug("Exception when trying to process data : %s", e.stack);
        }
    }
}

/*
Example data :

{
    "MarketName":"USDT-BTC",
    "Nounce":159275,
    "Buys":[
        {
            "Type":1,
            "Rate":4786.00000001,
            "Quantity":0
        },
        {
            "Type":0,
            "Rate":4531,
            "Quantity":0.04347826
        },...
    ],
    "Sells":[

    ],
    "Fills":[
        {
           OrderType: 'SELL',
           Rate: 4765,
           Quantity: 0.00016597,
           TimeStamp: '2017-10-11T13:15:11.21'
       },...
   ]
}
 */
_processUpdateExchangeState(data)
{
    // keep track of last timestamp when data was received
    this._watchdog.markets.lastTimestamp = new Date().getTime();
    // we're not subscribed to this pair => ignore
    if (undefined === this._subscriptions.markets.pairs[data.MarketName])
    {
        return;
    }
    let lastCseq = this._subscriptions.markets.pairs[data.MarketName].lastCseq;
    // ignore, we didn't receive full order book yet
    if (0 == lastCseq)
    {
        return;
    }
    // did we miss some nounce ?
    let missedCount = data.Nounce - lastCseq;
    if (missedCount > 1 || missedCount < 0)
    {
        if (debug.enabled)
        {
            debug("We missed %d update for market '%s' (full data will be retrieved) : last cseq = %d, current cseq", missedCount, data.MarketName, lastCseq, data.Nounce);
        }
        this._queryExchangeState(data.MarketName);
        return;
    }
    // ignore update since it's the same nounce as it's the same one as the full order book we last received
    else if (0 == missedCount)
    {
        return;
    }
    this._subscriptions.markets.pairs[data.MarketName].lastCseq = data.Nounce;
    this._subscriptions.markets.pairs[data.MarketName].lastUpdateCseq = data.Nounce;

    // build events
    /*
    entry.Type :
    - Type 0 – you need to add this entry into your orderbook. There were no orders at matching price before.
    - Type 1 – you need to delete this entry from your orderbook. This entry no longer exists (no orders at matching price)
    - Type 2 – you need to edit this entry. There are different number of orders at this price.
    */
    let orderBookUpdateEvt = {
        pair:data.MarketName,
        cseq:data.Nounce,
        data:{
            buy:_.map(data.Buys, entry => {
                let action = 'update';
                if (1 == entry.Type)
                {
                    action = 'remove';
                }
                return {
                    action:action,
                    rate:parseFloat(entry.Rate),
                    quantity:parseFloat(entry.Quantity)
                }
            }),
            sell:_.map(data.Sells, entry => {
                let action = 'update';
                if (1 == entry.Type)
                {
                    action = 'remove';
                }
                return {
                    action:action,
                    rate:parseFloat(entry.Rate),
                    quantity:parseFloat(entry.Quantity)
                }
            })
        }
    }
    let tradesEvt = {
        pair:data.MarketName,
        data:_.map(data.Fills, entry => {
            let price = parseFloat(new Big(entry.Quantity).times(entry.Rate));
            let orderType = 'sell';
            if ('BUY' == entry.OrderType)
            {
                orderType = 'buy';
            }
            let obj = {
                quantity:entry.Quantity,
                rate:entry.Rate,
                price:price,
                orderType:orderType,
                timestamp:parseFloat(new Date(entry.TimeStamp).getTime() / 1000.0) + this._timeOffset
            }
            if (undefined !== entry.Id)
            {
                obj.id = entry.Id;
            }
            return obj;
        })
    }

    // emit events
    if (0 != orderBookUpdateEvt.data.buy.length || 0 != orderBookUpdateEvt.data.sell.length)
    {
        this.emit('orderBookUpdate', orderBookUpdateEvt);
    }
    if (0 != tradesEvt.data.length)
    {
        this.emit('trades', tradesEvt);
    }
}

/*
Example data :

{
    "Nounce":84649,
    "Deltas":[
        {
            "MarketName":"BTC-AGRS",
            "High":0.00005351,
            "Low":0.000049,
            "Volume":45772.51642732,
            "Last":0.00005154,
            "BaseVolume":2.39469125,
            "TimeStamp":"2017-10-11T11:16:05.27",
            "Bid":0.00005052,
            "Ask":0.00005152,
            "OpenBuyOrders":91,
            "OpenSellOrders":2367,
            "PrevDay":0.00005299,
            "Created":"2015-11-10T00:53:59.643"
        },...
    ]
}
 */
_processUpdateSummaryState(data)
{
    if (undefined === data.Deltas)
    {
        return;
    }
    // keep track of last timestamp when data was received
    this._watchdog.tickers.lastTimestamp = new Date().getTime();
    _.forEach(data.Deltas, (entry) => {
        // we're not subscribed to this pair => ignore
        if (!this._subscriptions.tickers.global && undefined === this._subscriptions.tickers.pairs[entry.MarketName])
        {
            return;
        }
        let last = parseFloat(entry.Last);
        let previousDay = parseFloat(entry.PrevDay);
        let percentChange = 0;
        if (previousDay > 0)
        {
            percentChange = ((last/previousDay) - 1) * 100;
        }
        let evt = {
            pair:entry.MarketName,
            data:{
                pair:entry.MarketName,
                last: last,
                priceChangePercent:percentChange,
                sell: parseFloat(entry.Ask),
                buy: parseFloat(entry.Bid),
                high: parseFloat(entry.High),
                low: parseFloat(entry.Low),
                volume: parseFloat(entry.Volume),
                timestamp: parseFloat(new Date(entry.TimeStamp).getTime() / 1000.0) + this._timeOffset
            }
        }
        this.emit('ticker', evt);
    });
}

/*
 * Connect SignalR connection
 *
 * Should not be necessary since connection will happen automatically
 */
connect()
{
    // create if needed
    if (null !== this._connection)
    {
        return;
    }
    this._createConnection();
}

getConnectionId()
{
    return this._connectionId;
}

isConnected()
{
    if (null === this._connection)
    {
        return false;
    }
    return this._connection.isConnected()
}

disconnect()
{
    if (null === this._connection)
    {
        return;
    }
    // clear timers for data timeout
    this._clearWatchdogTimers();
    if (debug.enabled)
    {
        debug("Connection (bittrex|%d) will be disconnected", this._connectionCounter);
    }
    if (null !== this._logger)
    {
        this._logger.info("Connection (bittrex|%d) will be disconnected", this._connectionCounter);
    }
    this._connectionId = null;
    this._connection.disconnect();
    this._connection = null;
}

/**
 * Reconnect
 *
 * @param {boolean} immediate whether or not we want to reconnect immediately (otherwise, we will wait for options.retryDelay as provided in constructor) (optional, default = false)
 */
reconnect(immediate)
{
    if (null === this._connection)
    {
        return;
    }
    // clear timers for data timeout
    this._clearWatchdogTimers();
    let connection = this._connection;
    connection.disconnect();
    // reconnect immediately
    if (true === immediate)
    {
        this._createConnection();
    }
    else
    {
        if (debug.enabled)
        {
            debug("Client (bittrex) will reconnect in %dms", this._retryDelay);
        }
        if (null !== this._logger)
        {
            this._logger.info("Client (bittrex) will reconnect in %dms", this._retryDelay);
        }
        this._createConnection(this._retryDelay);
    }
}

}

module.exports = SignalRClient;
