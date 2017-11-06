"use strict";
const WebSocket = require('ws');
const _ = require('lodash');
const util = require('util');
const debug = require('debug')('BittrexSignalRClient:Client');
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

    this._retryDelay = RETRY_DELAY;
    this._connectionOptions = {};
    if (undefined !== options)
    {
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
        if (undefined !== options.reconnectAfterUnsubscribingFromMarket)
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

    // keep track of how many connections we started
    this._connectionCounter = 0;
    this._connection = null;
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
 */
subscribeToMarkets(pairs, reset)
{
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
        this._processChanges(changes);
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
        this._processChanges(changes);
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
    this._processChanges(changes);
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
        this._processChanges(changes);
    }
}

/**
 * Subscribe to tickers for a list of pairs
 *
 * @param {array} pairs array of pairs
 * @param {boolean} reset, previous subscriptions will be ignored (default = false)
 */
subscribeToTickers(pairs, reset)
{
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
        this._processChanges(changes);
    }
}

/**
 * Unsubscribe from tickers for a list of pairs
 *
 * @param {array} pairs array of pairs
 */
unsubscribeFromTickers(pairs)
{
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
        this._processChanges(changes);
    }
}

/**
 * Unsubscribe from all tickers
 */
unsubscribeFromAllTickers()
{
    // we don't have any subscribed tickers
    if (_.isEmpty(this._subscriptions.tickers.pairs))
    {
        return;
    }
    let timestamp = (new Date().getTime()) / 1000.0;
    let changes = {
        unsubscribe:[]
    };
    _.forEach(this._subscriptions.tickers.pairs, (p) => {
        changes.unsubscribe.push({entity:'ticker',pair:p})
    });
    this._subscriptions.tickers.timestamp = timestamp;
    this._subscriptions.tickers.pairs = {};
    if (debug.enabled)
    {
        this._debugChanges(changes);
    }
    this._processChanges(changes);
}

/**
 * Process subscription changes
 *
 * @param {object} changes list of changes to process
 *
 *  Each property (subscribe,unsubscribe,resync) is optional
 *  Entity can be (ticker,market) for subscribe/ubsubscribe or (orderBook) for resync
 *
 * {
 *    "subscribe":[{"entity":"","pair":""},...],
 *    "unsubscribe":[{"entity":"","pair":""},...],
 *    "resync":[{"entity":"","pair":""},...]
 * }
 */
_processChanges(changes)
{
    if (null === this._connection)
    {
        this._createConnection();
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
    // check if we need to subscribe to markets
    if (undefined !== changes.subscribe)
    {
        _.forEach(changes.subscribe, (entry) => {
            // ignore if entity != market since subscription to tickers is automatic
            if ('market' !== entry.entity)
            {
                return;
            }
            this._connection.callMethod('SubscribeToExchangeDeltas', [entry.pair]);
        });
    }
}

/**
 * Creates a new connection
 *
 * @param {integer} delay delay in ms before creating the connection (optional, default = no delay)
 */
_createConnection(delay)
{
    this._connectionCounter += 1;
    let connection = new SignalRConnection(this._connectionOptions);
    let self = this;

    connection.on('disconnected', function(data){
        if (debug.enabled)
        {
            debug("Connection #%d (%s) disconnected, will try to reconnect in %dms", self._connectionCounter, data.connectionId, self._retryDelay);
        }
        if (null !== self._logger)
        {
            self._logger.warn("Connection #%d (%s) disconnected, will try to reconnect in %dms", self._connectionCounter, data.connectionId, self._retryDelay);
        }
        self._createConnection.call(self);
    });

    connection.on('connectionError', function(err){
        // retry is possible
        if (err.retry)
        {
            if (debug.enabled)
            {
                debug("Connection #%d (%s) failed (will try to reconnect in %dms) : attempts = %d, error = '%s'", self._connectionCounter, err.step, self._retryDelay, err.attempts, JSON.stringify(err.error));
            }
            if (null !== self._logger)
            {
                self._logger.warn("Connection #%d (%s) failed (will try to reconnect in %dms) : attempts = %d, error = '%s'", self._connectionCounter, err.step, self._retryDelay, err.attempts, JSON.stringify(err.error));
            }
            self.emit('connectionError', {step:err.step,attempts:err.attempts,error:err.error});
            return;
        }
        // no more retry
        if (debug.enabled)
        {
            debug("Connection #%d (%s) failed (no more retry left) : attempts = %d, error = '%s'", self._connectionCounter, err.step, err.attempts, JSON.stringify(err.error));
        }
        if (null !== self._logger)
        {
            self._logger.warn("Connection #%d (%s) failed (no more retry left) : attempts = %d, error = '%s'", self._connectionCounter, err.step, err.attempts, JSON.stringify(err.error));
        }
        self.emit('terminated', {step:err.step,attempts:err.attempts,error:err.error});
    });

    connection.on('connected', function(data){
        if (debug.enabled)
        {
            debug("Connection #%d (%s) ready", self._connectionCounter, data.connectionId);
        }
        if (null !== self._logger)
        {
            self._logger.info("Connection #%d (%s) ready", self._connectionCounter, data.connectionId);
        }
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
    _.forEach(Object.keys(this._subscriptions.tickers.pairs), (p) => {
        changes.subscribe.push({entity:'ticker',pair:p});
    });
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
                let price = undefined !== entry.Total ? entry.Total : entry.Quantity * entry.Price;
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
                    timestamp:parseFloat(new Date(entry.TimeStamp).getTime() / 1000.0)
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
            let price = entry.Quantity * entry.Rate;
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
                timestamp:parseFloat(new Date(entry.TimeStamp).getTime() / 1000.0)
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
    _.forEach(data.Deltas, (entry) => {
        // we're not subscribed to this pair => ignore
        if (undefined === this._subscriptions.tickers.pairs[entry.MarketName])
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
                timestamp: parseFloat(new Date(entry.TimeStamp).getTime() / 1000.0)
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
    if (debug.enabled)
    {
        debug("Client will be disconnected : %d connections have been made", this._connectionCounter);
    }
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
            debug("Client will reconnect in %dms", this._retryDelay);
        }
        if (null !== this._logger)
        {
            this._logger.info("Client will reconnect in %dms", this._retryDelay);
        }
        this._createConnection(this._retryDelay);
    }
}

}

module.exports = SignalRClient;
