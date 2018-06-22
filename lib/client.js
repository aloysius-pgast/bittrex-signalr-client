"use strict";
const WebSocket = require('ws');
const _ = require('lodash');
const util = require('util');
const debug = require('debug')('BittrexSignalRClient:Client');
const Big = require('big.js');
const EventEmitter = require('events');
const zlib = require('zlib');
const crypto = require('crypto');
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

    6) watchdog, will be emitted everytime watchdog checks for timeout

    Data will be an object {connectionId:string,dataType:string,lastTimestamp:integer}

    - connectionId : id of SignalRConnection
    - dataType: tickers|markets
    - lastTimestamp: unix timestamp (in ms) when last data was received

    Following exchange events can be emitted

    1) ticker

    2) orderBook

    3) orderBookUpdate

    4) trades
*/

constructor(options)
{
    super();

    this._auth = {
        key:null,
        secret:null
    }
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
        },
        orders:{
            timestamp:null,
            subscribed:false
        }
    };

    this._unsubscribedMarkets = {
        pairs:{},
        count:0
    };

    // use to keep track of last trades id
    this._lastTrades = {};

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
        },
        // used to re-subscribe periodically
        orders:{
            // defaults to 30 min
            period:1800000,
            // whether or not we should re-subscribe automatically
            enabled:true,
            lastTimestamp:0,
            timer:null
        }
    };

    this._retryDelay = RETRY_DELAY;
    this._connectionOptions = {useCloudScraper:true};
    if (undefined !== options)
    {
        // auth
        if (undefined !== options.auth)
        {
            if (undefined !== options.auth.key && '' != options.auth.key &&
                undefined !== options.auth.secret && '' !== options.auth.secret)
            {
                this._auth.key = options.auth.key;
                this._auth.secret = options.auth.secret;
            }
        }
        if (false === options.useCloudScraper)
        {
            this._connectionOptions.useCloudScraper = false;
        }
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
            if (undefined !== options.watchdog.orders)
            {
                if (undefined !== options.watchdog.orders.period)
                {
                    this._watchdog.orders.period = options.watchdog.orders.period * 1000;
                }
                if (undefined !== options.watchdog.orders.enabled && false === options.watchdog.orders.enabled)
                {
                    this._watchdog.orders.enabled = false;
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
    this._utcOffset = 0;

    // keep track of how many connections we started
    this._connectionCounter = 0;
    this._connection = null;
    // SignalR connection id
    this._connectionId = null;
    // timestamp of last connected event
    this._connectedTimestamp = null;

    // for debugging purpose
    this._logAllWsMessages = false;
    this._logKeepaliveMessages = false;
}

/**
 * Enable / disable logging of all received WS messages
 *
 * @param {boolean} true to enable, false to disable
 */
logAllWsMessages(flag)
{
    this._logAllWsMessages = flag;
    if (null !== this._connection)
    {
        this._connection.logAllWsMessages(flag);
    }
}

/**
 * Enable / disable logging of keepalive messages (received 'ping' & received 'pong')
 *
 * @param {boolean} true to enable, false to disable
 */
logKeepaliveMessages(flag)
{
    this._logKeepaliveMessages = flag;
    if (null !== this._connection)
    {
        this._connection.logKeepaliveMessages(flag);
    }
}

// used to compute utc offset in seconds (negative offset means we're ahead of utc time)
_computeUtcOffset()
{
    this._utcOffset = new Date().getTimezoneOffset() * 60;
}

/**
 * Parses a datetime in UTC format (YYYY-mm-dd HH:MM:SS)
 * @param {date}
 * @return {integer} unix timestamp based on local timezone
 */
_parseUtcDateTime(dateTime)
{
    return parseInt(Date.parse(dateTime) / 1000.0) - this._utcOffset;
}

_initializeLastTrade(pair)
{
    if (undefined === this._lastTrades[pair])
    {
        this._lastTrades[pair] = {id:0};
    }
}

_resetLastTrade(pair)
{
    delete this._lastTrades[pair];
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
    let timestamp = Date.now() / 1000.0;
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
                this._initializeLastTrade(p);
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
            this._initializeLastTrade(p);
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
                this._resetLastTrade(p);
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
    let timestamp = Date.now() / 1000.0;
    let changes = {
        unsubscribe:[]
    };
    let updated = false;
    _.forEach(pairs, (p) => {
        if (undefined !== this._subscriptions.markets.pairs[p])
        {
            this._resetLastTrade(p);
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
    let timestamp = Date.now() / 1000.0;
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
    let timestamp = Date.now() / 1000.0;
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
    let timestamp = Date.now() / 1000.0;
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
    let timestamp = Date.now() / 1000.0;
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
    let timestamp = Date.now() / 1000.0;
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
 * Subscribe to orders (requires valid api key & api secret)
 *
 * @param {boolean} resubscribe if true, will resubscribe even if a subscription already exists (default = false)
 * @param {boolean} connect whether or not connection with exchange should be established if necessary (optional, default = true)
 */
subscribeToOrders(resubscribe, connect)
{
    // no support
    if (null === this._auth.key)
    {
        return false;
    }
    if (undefined === resubscribe)
    {
        resubscribe = false;
    }
    if (undefined === connect)
    {
        connect = true;
    }
    // already subscribed, do nothing
    if (this._subscriptions.orders.subscribed && !resubscribe)
    {
        return;
    }
    // cancel watchdog since a new one will be automatically started
    if (resubscribe)
    {
        this._clearWatchdogTimer('orders');
    }
    let timestamp = Date.now() / 1000.0;
    let changes = {
        subscribe:[{entity:'orders'}]
    };
    if (debug.enabled)
    {
        this._debugChanges(changes);
    }
    this._subscriptions.orders.timestamp = timestamp;
    this._subscriptions.orders.subscribed = true;
    this._processChanges(changes, connect);
}

/**
 * Unsubscribe from orders to orders (requires valid api key & api secret)
 */
unsubscribeFromOrders()
{
    // no support
    if (null === this._auth.key)
    {
        return false;
    }
    // ignore if we didn't subscribe previously
    if (!this._subscriptions.orders.subscribed)
    {
        return;
    }
    let timestamp = Date.now() / 1000.0;
    let changes = {
        unsubscribe:[{entity:'orders'}]
    };
    if (debug.enabled)
    {
        this._debugChanges(changes);
    }
    this._subscriptions.orders.timestamp = timestamp;
    this._subscriptions.orders.subscribed = false;
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
                case 'orders':
                    this._subscribeToOrders();
                    break;
            }
        });
    }
    this._initializeWatchdog();
}

/**
 * Performs SignalR request
 *
 * @param {function} cb callback to call upon completion (optional)
 */
_subscribeToOrders(cb)
{
    let self = this;
    this._connection.callMethod('GetAuthContext', [this._auth.key], function(challenge, err){
        // we got an error
        if (null !== err)
        {
            if (debug.enabled)
            {
                debug("Could not call 'GetAuthContext' : err = '%s'", err);
            }
            if (null !== self._logger)
            {
                self._logger.warn("Could not call 'GetAuthContext' : err = '%s'", err);
            }
            // unsubscribe from orders
            let timestamp = Date.now() / 1000.0;
            self._subscriptions.orders.timestamp = timestamp;
            self._subscriptions.orders.subscribed = false;
            self._initializeWatchdog.call(self);

            if (undefined !== cb)
            {
                try
                {
                    cb(false, err);
                }
                catch (e)
                {
                    // just ignore
                }
            }
            return;
        }
        if (null === self._connection || !self._connection.isConnected())
        {
            if (undefined !== cb)
            {
                try
                {
                    cb(false);
                }
                catch (e)
                {
                    // just ignore
                }
            }
            return;
        }

        // create response
        const hmac = crypto.createHmac('sha512', self._auth.secret);
        hmac.update(challenge);
        const response = hmac.digest('hex');

        // call Authenticate
        self._connection.callMethod('Authenticate', [self._auth.key, response], function(success, err){
            // we got an error
            if (null !== err)
            {
                if (debug.enabled)
                {
                    debug("Could not call 'Authenticate' : err = '%s'", err);
                }
                if (null !== self._logger)
                {
                    self._logger.warn("Could not call 'Authenticate' : err = '%s'", err);
                }
                // unsubscribe from orders
                let timestamp = Date.now() / 1000.0;
                self._subscriptions.orders.timestamp = timestamp;
                self._subscriptions.orders.subscribed = false;
                self._initializeWatchdog.call(self);
                if (undefined !== cb)
                {
                    try
                    {
                        cb(false, err);
                    }
                    catch (e)
                    {
                        // just ignore
                    }
                }
                return;
            }
            if (undefined !== cb)
            {
                try
                {
                    cb(true);
                }
                catch (e)
                {
                    // just ignore
                }
            }
        });
    });
}

/**
 * Clears all watchdog timers
 */
_clearWatchdogTimers()
{
    this._clearWatchdogTimer('tickers');
    this._clearWatchdogTimer('markets');
    this._clearWatchdogTimer('orders');
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
    // orders watchdog is enabled
    if (this._watchdog.orders.enabled)
    {
        // no subscriptions => disable watchdog
        if (!this._subscriptions.orders.subscribed)
        {
            if (debug.enabled)
            {
                debug("Watchdog for 'orders' will be disabled since we don't have a subscription");
            }
            this._clearWatchdogTimer('orders');
        }
        else
        {
            this._startWatchdogTimerForOrders();
        }
    }
}

/**
 * Starts a timer for orders subscription
 *
 */
_startWatchdogTimerForOrders()
{
    // timer already exists
    if (null !== this._watchdog.orders.timer)
    {
        return;
    }
    let self = this;
    if (debug.enabled)
    {
        debug("Watchdog for 'orders' will be started since we have a subscription");
    }
    this._watchdog.orders.timer = setInterval(function(){
        // if socket is not connected, do nothing
        if (!self.isConnected.call(self))
        {
            return;
        }
        self._watchdog.orders.lastTimestamp = new Date().getTime();
        if (debug.enabled)
        {
            debug("About to re-subscribe for 'orders'...");
        }
        // resubscribe & emit event
        self._subscribeToOrders.call(self, function(subscribed, err){
            // only emit event if re-subscribe was successful
            if (subscribed)
            {
                let evt = {connectionId:self._connectionId,dataType:'orders',lastTimestamp:self._watchdog.orders.lastTimestamp}
                self.emit('watchdog', evt);
            }
        });
    }, this._watchdog.orders.period);
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
    // use timeout / 10 to ensure we properly detect timeout soon enough (this means timeout will be detected at most in ${timeout * 1.10} ms)
    let interval = parseInt(this._watchdog[type].timeout / 10.0);
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
        let evt = {connectionId:self._connectionId,dataType:type,lastTimestamp:self._watchdog[type].lastTimestamp}
        self.emit('watchdog', evt);
        if (delta > self._watchdog[type].timeout)
        {
            if (debug.enabled)
            {
                debug("Data timeout occured for '%s' : last data received at = %d", type, self._watchdog[type].lastTimestamp);
            }
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
    }, interval);
}

/**
 * Creates a new connection
 *
 * @param {integer} delay delay in ms before connecting (optional, default = no delay)
 */
_createConnection(delay)
{
    this._connectionCounter += 1;
    this._connectionId = null;
    let connection = new SignalRConnection(this._connectionOptions);

    connection.logAllWsMessages(this._logAllWsMessages);
    connection.logKeepaliveMessages(this._logKeepaliveMessages);

    // recompute utc offset on each reconnect
    this._computeUtcOffset();

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
        self._connectedTimestamp = Date.now() / 1000.0;
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
    if (this._subscriptions.orders.subscribed)
    {
        changes.subscribe.push({entity:'orders'});
    }
    this._processChanges(changes);
}

/*
 Example data
 {
     "M":null,
     "N":1870,
     "Z":[
         {
             "Q":0.64276295,
             "R":7375.00000000
         },
         {
             "Q":0.00134273,
             "R":7373.02479393
         },
         {
             "Q":0.02982468,
             "R":7358.00000000
         }
     ],
     "S":[
         {
             "Q":0.23198481,
             "R":7389.89999990
         },
         {
             "Q":6.78724854,
             "R":7390.00000000
         },
         {
             "Q":0.01109804,
             "R":7396.44820350
         }
     ],
     "f":[
         {
             "I":46589978,
             "T":1522748465633,
             "Q":0.16349764,
             "P":7376.00000000,
             "t":1205.95859264,
             "F":"FILL",
             "OT":"SELL"
         },
         {
             "I":46589971,
             "T":1522748446290,
             "Q":0.00696611,
             "P":7375.00000000,
             "t":51.37506125,
             "F":"PARTIAL_FILL",
             "OT":"SELL"
         }
     ]
 }
 */
_queryExchangeState(pair)
{
    // reset nounce
    this._subscriptions.markets.pairs[pair].cseq = 0;
    let self = this;
    this._connection.callMethod('QueryExchangeState', [pair], function(d, err){
        // we got an error
        if (null !== err)
        {
            if (debug.enabled)
            {
                debug("Could not query exchange for pair '%s' (might be an invalid pair) : err = '%s'", pair, err);
            }
            if (null !== self._logger)
            {
                self._logger.warn("Could not query exchange for pair '%s' (might be an invalid pair) : err = '%s'", pair, err);
            }
            delete self._subscriptions.markets.pairs[pair];
            return;
        }
        self._decodeData.call(self, d, function(data){
            // ignore if we're not subscribed to this pair anymore
            if (undefined === self._subscriptions.markets.pairs[pair])
            {
                return;
            }
            self._subscriptions.markets.pairs[pair].lastCseq = data.N;

            // build events
            let orderBookEvt = {
                pair:pair,
                cseq:data.N,
                data:{
                    buy:_.map(data.Z, entry => {
                        return {
                            rate:parseFloat(entry.R),
                            quantity:parseFloat(entry.Q)
                        }
                    }),
                    sell:_.map(data.S, entry => {
                        return {
                            rate:parseFloat(entry.R),
                            quantity:parseFloat(entry.Q)
                        }
                    })
                }
            }
            let tradesEvt = {
                pair:pair,
                data:_.map(data.f, entry => {
                    let price = undefined !== entry.t ? entry.t : parseFloat(new Big(entry.Q).times(entry.P));
                    let orderType = 'sell';
                    if ('BUY' == entry.OT)
                    {
                        orderType = 'buy';
                    }
                    return {
                        id:entry.I,
                        quantity:entry.Q,
                        rate:entry.P,
                        price:price,
                        orderType:orderType,
                        timestamp:parseFloat(entry.T / 1000.0)
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
                if (self._subscriptions.markets.pairs[pair].lastUpdateCseq != data.N)
                {
                    // only emit trades which were executed after last(trade.id) or subscription
                    let minTimestamp = 0;
                    let minTradeId = self._lastTrades[pair].id;
                    // if we don't have previous trade id, use subscription timestamp
                    if (0 == minTradeId)
                    {
                        minTimestamp = self._subscriptions.markets.pairs[pair].timestamp;
                    }
                    // if oldest entry is <= last(trade).id or is < timestamp(subscription), we need to do some filtering
                    if (tradesEvt.data[tradesEvt.data.length - 1].id <= minTradeId || tradesEvt.data[tradesEvt.data.length - 1].timestamp < minTimestamp)
                    {
                        let data = [];
                        _.forEach(tradesEvt.data, (e) => {
                            if (e.id <= minTradeId || e.timestamp < minTimestamp)
                            {
                                return false;
                            }
                            data.push(e);
                        });
                        tradesEvt.data = data;
                    }
                    if (0 != tradesEvt.data.length)
                    {
                        // update last trade id
                        self._lastTrades[pair].id = tradesEvt.data[0].id;
                        self.emit('trades', tradesEvt);
                    }
                }
            }
        });
    });
}

/*
Example output
{"C":"d-D0576E0C-B,0|v0,0|v1,3|g,467C|v2,0","M":[{"H":"C2","M":"uE","A":["ddA9DsIwDAXgu3gO0XNi528EVpCgZQDUlUug3p1ShYq2qsfo07Pz3nSiQrfm2O727YEMnalwEmRDDyrPN7V3KjB0pZJShMUwCrChywBtFP2+oDdbEqOEZZ8zUvAbchipmepYWaP+JK+kr5nYJrwkrpLAc8KWRQRe00pOYdMf1MFFF5dSvQ3pT7J1Ps96qQcKJ4sUlXnKRN8ZaqaqK8wiVtxs+aLjHENY3gfPDhFj5GuI7PoP"]}]}
*/
_processData(data)
{
    try
    {
        let methodName = data.M.toLowerCase();
        switch (methodName)
        {
            case 'ue':
                _.forEach(data.A, (entry) => {
                    this._processUpdateExchangeState(entry);
                })
                break;
            case 'us':
                _.forEach(data.A, (entry) => {
                    this._processUpdateSummaryState(entry);
                })
                break;
            case 'uo':
                _.forEach(data.A, (entry) => {
                    this._processOrdersDelta(entry);
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

/**
 * Process Market Delta
 */

/*
Example data :

{
    "M":"USDT-BTC",
    "N":3188,
    "Z":[
        {
            "TY":1,
            "R":6992.378,
            "Q":0
        },
        {
            "TY":0,
            "R":6687,
            "Q":0.1
        }
    ],
    "S":[
        {
            "TY":2,
            "R":7374.38554949,
            "Q":0.10561806
        },
        {
            "TY":1,
            "R":7449.51146141,
            "Q":0
        },
        {
            "TY":0,
            "R":7960.22045353,
            "Q":0.09085729
        }
    ],
    "f":[
        {
            "OT":"BUY",
            "R":7374.38554949,
            "Q":0.00105,
            "T":1522750645830
        }
    ]
}
 */
_processUpdateExchangeState(d)
{
    this._decodeData(d, function(data){
        // an error occurred
        if (undefined === data)
        {
            return;
        }
        // keep track of last timestamp when data was received
        this._watchdog.markets.lastTimestamp = new Date().getTime();
        // we're not subscribed to this pair => ignore
        if (undefined === this._subscriptions.markets.pairs[data.M])
        {
            return;
        }
        let lastCseq = this._subscriptions.markets.pairs[data.M].lastCseq;
        // ignore, we didn't receive full order book yet
        if (0 == lastCseq)
        {
            return;
        }
        // did we miss some nounce ?
        let missedCount = data.N - lastCseq;
        if (missedCount > 1 || missedCount < 0)
        {
            if (debug.enabled)
            {
                debug("We missed %d update for market '%s' (full data will be retrieved) : last cseq = %d, current cseq", missedCount, data.M, lastCseq, data.N);
            }
            this._queryExchangeState(data.M);
            return;
        }
        // ignore update since it's the same nounce as it's the same one as the full order book we last received
        else if (0 == missedCount)
        {
            return;
        }
        this._subscriptions.markets.pairs[data.M].lastCseq = data.N;
        this._subscriptions.markets.pairs[data.M].lastUpdateCseq = data.N;

        // build events
        /*
        entry.Type :
        - Type 0 – you need to add this entry into your orderbook. There were no orders at matching price before.
        - Type 1 – you need to delete this entry from your orderbook. This entry no longer exists (no orders at matching price)
        - Type 2 – you need to edit this entry. There are different number of orders at this price.
        */
        let orderBookUpdateEvt = {
            pair:data.M,
            cseq:data.N,
            data:{
                buy:_.map(data.Z, entry => {
                    let action = 'update';
                    if (1 == entry.TY)
                    {
                        action = 'remove';
                    }
                    return {
                        action:action,
                        rate:parseFloat(entry.R),
                        quantity:parseFloat(entry.Q)
                    }
                }),
                sell:_.map(data.S, entry => {
                    let action = 'update';
                    if (1 == entry.TY)
                    {
                        action = 'remove';
                    }
                    return {
                        action:action,
                        rate:parseFloat(entry.R),
                        quantity:parseFloat(entry.Q)
                    }
                })
            }
        }
        let tradesEvt = {
            pair:data.M,
            data:_.map(data.f, entry => {
                let price = parseFloat(new Big(entry.Q).times(entry.R));
                let orderType = 'sell';
                if ('BUY' == entry.OT)
                {
                    orderType = 'buy';
                }
                let obj = {
                    // 2018-05-07 : seems that trade id is now available
                    id:entry.FI,
                    quantity:entry.Q,
                    rate:entry.R,
                    price:price,
                    orderType:orderType,
                    timestamp:parseFloat(entry.T / 1000.0)
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
            // only emit trades which were executed after last(trade.id) or subscription
            let minTimestamp = 0;
            let minTradeId = this._lastTrades[tradesEvt.pair].id;
            // if we don't have previous trade id, use subscription timestamp
            if (0 == minTradeId)
            {
                minTimestamp = this._subscriptions.markets.pairs[tradesEvt.pair].timestamp;
            }
            // if oldest entry is <= last(trade).id or is < timestamp(subscription), we need to do some filtering
            if (tradesEvt.data[tradesEvt.data.length - 1].id <= minTradeId || tradesEvt.data[tradesEvt.data.length - 1].timestamp < minTimestamp)
            {
                let data = [];
                _.forEach(tradesEvt.data, (e) => {
                    if (e.id <= minTradeId || e.timestamp < minTimestamp)
                    {
                        return false;
                    }
                    data.push(e);
                });
                tradesEvt.data = data;
            }
            if (0 != tradesEvt.data.length)
            {
                // update last trade id
                this._lastTrades[tradesEvt.pair].id = tradesEvt.data[0].id;
                this.emit('trades', tradesEvt);
            }
        }
    });
}

/**
 * Process Summary Delta
 */

/*
Example data :

{
    "N":208,
    "D":[
        {
            "M":"BTC-AMP",
            "H":0.000033,
            "L":0.00002861,
            "V":5045735.76501928,
            "l":0.00002889,
            "m":152.43805072,
            "T":1522746674360,
            "B":0.00002888,
            "A":0.00002889,
            "G":296,
            "g":3807,
            "PD":0.00003045,
            "x":1446578035180
        },
        {
            "M":"BTC-ARDR",
            "H":0.00004035,
            "L":0.00003099,
            "V":7108198.19040366,
            "l":0.00003532,
            "m":251.78803265,
            "T":1522746673860,
            "B":0.00003514,
            "A":0.00003556,
            "G":911,
            "g":2462,
            "PD":0.00003116,
            "x":1476385177407
        }
    ]
}

 */
_processUpdateSummaryState(d)
{
    this._decodeData(d, function(data){
        // an error occurred
        if (undefined === data)
        {
            return;
        }
        // no entry
        if (undefined === data.D)
        {
            return;
        }
        // keep track of last timestamp when data was received
        this._watchdog.tickers.lastTimestamp = new Date().getTime();
        _.forEach(data.D, (entry) => {
            // we're not subscribed to this pair => ignore
            if (!this._subscriptions.tickers.global && undefined === this._subscriptions.tickers.pairs[entry.M])
            {
                return;
            }
            let last = parseFloat(entry.l);
            let previousDay = parseFloat(entry.PD);
            let percentChange = 0;
            if (previousDay > 0)
            {
                percentChange = ((last/previousDay) - 1) * 100;
            }
            let evt = {
                pair:entry.M,
                data:{
                    pair:entry.M,
                    last: last,
                    priceChangePercent:percentChange,
                    sell: parseFloat(entry.A),
                    buy: parseFloat(entry.B),
                    high: parseFloat(entry.H),
                    low: parseFloat(entry.L),
                    volume: parseFloat(entry.V),
                    timestamp: entry.T / 1000.0
                }
            }
            this.emit('ticker', evt);
        });
    });
}

/**
 * Process Orders Delta
 */

/*
Example data :

1) TY = 0 (OPEN)

{
    "w":"45a0efa4-02c7-4f39-81dd-ecb6125671da",
    "N":1,
    "TY":0,
    "o":{
        "U":"45a0efa4-02c7-4f39-81dd-ecb6125671da",
        "I":6459944809,
        "OU":"88d2a22e-be40-4a48-a857-fd6ad4293438",
        "E":"BTC-PTC",
        "OT":"LIMIT_SELL",
        "Q":1000.00000000,
        "q":1000.00000000,
        "X":0.00000800,
        "n":0.00000000,
        "P":0.00000000,
        "PU":null,
        "Y":1522759978173,
        "C":null,
        "i":null,
        "CI":false,
        "K":false,
        "k":false,
        "J":"NONE",
        "j":null,
        "u":null
    }
}

2) TY = 3 (PARTIAL)

{
    "w":"42a0efa3-02c7-4f39-81dd-ecb6125671db",
    "N":17,
    "TY":1,
    "o":{
        "U":"42a0efa3-02c7-4f39-81dd-ecb6125671db",
        "I":6460428042,
        "OU":"76664025-ee77-4d16-976a-a408d033dc61",
        "E":"BTC-PTC",
        "OT":"LIMIT_SELL",
        "Q":1000,
        "q":359.21926724,
        "X":0.00000406,
        "n":0.0000065,
        "P":0.00260156,
        "PU":0.00000405,
        "Y":1522762803353,
        "C":null,
        "i":null,
        "CI":false,
        "K":false,
        "k":false,
        "J":"NONE",
        "j":null,
        "u":null
    }
}

3) TY = 2 (FILL)

Example where order was filled 100%

{
    "w":"45a0efa4-02c7-4f39-81dd-ecb6125671da",
    "N":8,
    "TY":2,
    "o":{
        "U":"45a0efa4-02c7-4f39-81dd-ecb6125671da",
        "I":6460531390,
        "OU":"a333660a-1919-434b-9863-bdef13a849e6",
        "E":"BTC-PTC",
        "OT":"LIMIT_SELL",
        "Q":123.7654321,
        "q":0,
        "X":0.00000405,
        "n":0.00000125,
        "P":0.00050125,
        "PU":0.00000404,
        "Y":1522763432983,
        "C":1522763433140,
        "i":null,
        "CI":false,
        "K":false,
        "k":false,
        "J":"NONE",
        "j":null,
        "u":null
    }
}

Example where order was cancelled after being partially filled

{
    "w":"42a0efa3-02c7-4f39-81dd-ecb6125671db",
    "N":24,
    "TY":2,
    "o":{
        "U":"42a0efa3-02c7-4f39-81dd-ecb6125671db",
        "I":6460803705,
        "OU":"77c8f585-6d0c-4d2f-a5b0-a3c5abee504e",
        "E":"BTC-PTC",
        "OT":"LIMIT_SELL",
        "Q":1000,
        "q":29.71930944,
        "X":0.00000406,
        "n":0.00000984,
        "P":0.00393933,
        "PU":0.00000405,
        "Y":1522765015517,
        "C":1522765092253,
        "i":null,
        "CI":true,
        "K":false,
        "k":false,
        "J":"NONE",
        "j":null,
        "u":null
    }
}

4) TY = 3 (CANCEL)

This state will be only set for an order which was cancelled before being filled (partially or completely)

{
    "w":"45a0efa4-02c7-4f39-81dd-ecb6125671da",
    "N":2,
    "TY":3,
    "o":{
        "U":"45a0efa4-02c7-4f39-81dd-ecb6125671da",
        "I":6459944809,
        "OU":"88d2a22e-be40-4a48-a857-fd6ad4293438",
        "E":"BTC-PTC",
        "OT":"LIMIT_SELL",
        "Q":1000.00000000,
        "q":1000.00000000,
        "X":0.00000800,
        "n":0.00000000,
        "P":0.00000000,
        "PU":null,
        "Y":1522759978173,
        "C":1522761657550,
        "i":null,
        "CI":true,
        "K":false,
        "k":false,
        "J":"NONE",
        "j":null,
        "u":null
    }
}

*/
_processOrdersDelta(d)
{
    this._decodeData(d, function(data){
        // an error occurred
        if (undefined === data)
        {
            return;
        }
        // no entry
        if (undefined === data.o)
        {
            return;
        }
        let orderState = 'OPEN';
        switch (data.TY)
        {
            case 1:
                orderState = 'PARTIAL';
                break;
            case 2:
                orderState = 'FILL';
                break;
            case 3:
                orderState = 'CANCEL';
                break;
        }
        let evt = {
            pair:data.o.E,
            orderNumber:data.o.OU,
            data:{
                pair:data.o.E,
                orderNumber:data.o.OU,
                orderState:orderState,
                orderType:data.o.OT,
                quantity:parseFloat(data.o.Q),
                remainingQuantity:parseFloat(data.o.q),
                openTimestamp:parseFloat(data.o.Y / 1000.0),
                targetRate:parseFloat(data.o.X)
            }
        }
        evt.data.targetPrice = parseFloat(new Big(evt.data.targetRate).times(evt.data.quantity));

        // order is closed
        if (null !== data.o.C)
        {
            evt.data.closedTimestamp = parseFloat(data.o.C / 1000.0);
            evt.data.actualPrice = parseFloat(data.o.P);
            evt.data.fees = parseFloat(data.o.n);
            evt.data.actualRate = null;
            if (null !== data.o.PU)
            {
                evt.data.actualRate = parseFloat(data.o.PU);
            }
        }

        this.emit('order', evt);
    });
}

/**
 * Decode data received from endpoint :
 * 1) base64 decode
 * 2) gzip inflate
 */
_decodeData(d, cb)
{
    let self = this;
    let gzipData = Buffer.from(d, 'base64');
    // we need to use inflateRaw to avoid zlib error 'incorrect header check' (Z_DATA_ERROR)
    zlib.inflateRaw(gzipData, function(err, str){
        if (null !== err)
        {
            self._logger.warn("Could not decompress Bittrex gzip data : %s", err);
            cb.call(self, undefined);
            return;
        }
        let data;
        try
        {
            data = JSON.parse(str);
        }
        catch (e)
        {
            self._logger.warn("Decompressed Bittrex data does not contain valid JSON", err);
            cb.call(self, undefined);
            return;
        }
        cb.call(self, data);
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

isConnecting()
{
    if (null === this._connection)
    {
        return false;
    }
    return this._connection.isConnecting()
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
