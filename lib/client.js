"use strict";
const WebSocket = require('ws');
const _ = require('lodash');
const util = require('util');
const debug = require('debug')('BittrexSignalRClient:Client');
const EventEmitter = require('events');
const SignalRConnection = require('./connection');

class SignalRClient extends EventEmitter
{

constructor(options)
{
    super();
    this._orderBooksAndTrades = {
        timestamp:null,
        pairs:{}
    };
    this._tickers = {};
    this._connectionOptions = {};
    if (undefined !== options)
    {
        // retry count
        if (undefined !== options.retryCount)
        {
            this._connectionOptions.retryCount = options.retryCount;
        }
        if (undefined !== options.retryDelay)
        {
            this._connectionOptions.retryDelay = options.retryDelay;
        }
        if (undefined !== options.ignoreStartStep)
        {
            this._connectionOptions.ignoreStartStep = options.ignoreStartStep;
        }
        if (undefined != options.userAgent && '' != options.userAgent)
        {
            this._connectionOptions.userAgent = options.userAgent;
        }
        if (undefined !== options.pingTimeout)
        {
            this._connectionOptions.pingTimeout = options.pingTimeout;
        }
    }
    // keep track of how many connections we started
    this._counter = 0;
    this._connection = null;
    this._connectionTimestamp = null;
}

/**
 * Pairs to subscribe to
 *
 * @param {array} pairs array of pairs
 * @param {boolean} opt.reset if true, previous subscriptions will be ignored (default = false)
 * @param {boolean} opt.initial if true, full order book will be retrieved before sending update (default = false)
 */
subscribeOrderBooksAndTrades(pairs, opt)
{
    let options = {reset:false, initial:false};
    if (undefined !== opt)
    {
        if (undefined !== opt.reset && true === opt.reset)
        {
            options.reset = true;
        }
        if (undefined !== opt.initial && true === opt.initial)
        {
            options.initial = true;
        }
    }
    let timestamp = new Date().getTime();
    this._orderBooksAndTrades.timestamp = timestamp;
    // update the list of pairs
    if (!options.reset)
    {
        let cseq = parseInt(timestamp);
        _.forEach(pairs, (p) => {
            if (undefined === this._orderBooksAndTrades.pairs[p])
            {
                this._orderBooksAndTrades.pairs[p] = this._inititializeOrderBooksAndTradesPair(timestamp, p, cseq);
            }
        });
    }
    else
    {
        let newPairs = {};
        _.forEach(pairs, (p) => {
            let cseq = parseInt(timestamp);
            if (undefined !== this._orderBooksAndTrades.pairs[p])
            {
                cseq = this._orderBooksAndTrades.pairs[p].cseq;
            }
            newPairs[p] = this._inititializeOrderBooksAndTradesPair(timestamp, p, cseq);
        });
        this._orderBooksAndTrades.pairs = newPairs;
    }
    if (options.reset)
    {
        // disconnect any existing connection
        this._disconnect();
    }
    // connect if necessary
    this._connect(options.initial);
}

/*
* @param {array} pairs array of pairs
* @param {boolean} opt.reset if true, previous subscriptions will be ignored (default = false)
*/
subscribeTickers(pairs, opt)
{
    let options = {reset:false};
    if (undefined !== opt)
    {
        if (undefined !== opt.reset && true === opt.reset)
        {
            options.reset = true;
        }
    }
    let timestamp = new Date().getTime();
    // update the list of pairs
    if (!options.reset)
    {
        _.forEach(pairs, (p) => {
            if (undefined === this._tickers[p])
            {
                this._tickers[p] = timestamp;
            }
        });
    }
    else
    {
        let newPairs = {};
        _.forEach(pairs, (p) => {
            newPairs[p] = timestamp;
        });
        this._tickers = newPairs;
    }
    // connect if necessary
    this._connect(false);
}

_inititializeOrderBooksAndTradesPair(timestamp, p, cseq)
{
    return {
        // subscription timestamp
        timestamp:timestamp,
        // value of last nounce
        nounce:0,
        cseq:cseq
    }
}

_connect(initial)
{
    if (null !== this._connection)
    {
        this._processSubscriptions(this._connection, initial, false);
        return;
    }
    this._createConnection(this);
}

_createConnection(self)
{
    self._counter += 1;
    let connection = new SignalRConnection(self._connectionOptions);
    connection.on('terminated', function(data){
        if (debug.enabled)
        {
            debug("Connection #%d terminated, will try to reconnect", self._counter);
        }
        self._createConnection(self);
    });
    connection.on('connectionFailed', function(err){
        if (debug.enabled)
        {
            debug("Connection #%d failed, will try to reconnect", self._counter);
        }
        self._createConnection(self);
    });
    connection.on('ready', function(){
        if (debug.enabled)
        {
            debug("Connection #%d ready", self._counter);
        }
        self._processSubscriptions.call(self, connection, true, true);
    });
    connection.on('data', function(data){
        self._processData.call(self, data);
    });
    self._connection = connection;
    self._connectionTimestamp = new Date().getTime();
    connection.connect();
}

/**
 * @param {object} connection SignalRConnection object
 * @param {boolean} initial, if true full order book will be retrieved before sending updates
 * @param {boolean} forceSubscription if true subscription will be sent to exchange (will be true for new connections)
 */
_processSubscriptions(connection, initial, forceSubscription)
{
    this._processOrderBooksAndTradesSubscriptions(connection, initial, forceSubscription);
}

/**
 * @param {object} connection SignalRConnection object
 * @param {boolean} initial, if true full order book will be retrieved before sending updates
 * @param {boolean} forceSubscription if true subscription will be sent to exchange (will be true for new connections)
 */
_processOrderBooksAndTradesSubscriptions(connection, initial, forceSubscription)
{
    _.forEach(this._orderBooksAndTrades.pairs, (obj, p) => {
        let sendSubscription = forceSubscription || obj.timestamp >= this._orderBooksAndTrades.timestamp;
        // we didn't subscribe to this exchange yet
        if (initial || sendSubscription)
        {
            this._subscribeToExchangeDeltas(connection, p, sendSubscription, initial);
        }
    });
}

/**
 * @param {object} connection SignalRConnection object
 * @param {string} pair pair to subscribe for (ex: USDT-BTC)
 * @param {boolean} sendSubscription if true subscription will be sent to exchange (will be true for new connections)
 * @param {boolean} retrieveFullData, if true full order book will be retrieved before sending updates
 */
_subscribeToExchangeDeltas(connection, pair, sendSubscription, retrieveFullData)
{
    if (sendSubscription)
    {
        connection.callMethod('SubscribeToExchangeDeltas', [pair]);
    }
    if (sendSubscription || retrieveFullData)
    {
        this._queryExchangeState(connection, pair);
    }
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
_queryExchangeState(connection, pair)
{
    // reset nounce
    this._orderBooksAndTrades.pairs[pair].nounce = 0;
    let self = this;
    connection.callMethod('QueryExchangeState', [pair], function(data, err){
        // we got an error
        if (null !== err)
        {
            if (debug.enabled)
            {
                debug("Could not query exchange for pair '%s' (might be an invalid pair) : err = '%s'", pair, err);
            }
            delete self._orderBooksAndTrades.pairs[pair];
            return;
        }
        // ignore if we're not subscribed to this pair
        if (undefined === self._orderBooksAndTrades.pairs[pair])
        {
            return;
        }
        let obj = {
            pair:pair,
            cseq:self._orderBooksAndTrades.pairs[pair].cseq++,
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
            }),
            trades:_.map(data.Fills, entry => {
                let price = undefined !== entry.Total ? entry.Total : entry.Quantity * entry.Price;
                return {
                    id:entry.Id,
                    quantity:entry.Quantity,
                    rate:entry.Price,
                    price:price,
                    timestamp:parseFloat(new Date(entry.TimeStamp).getTime() / 1000.0)
                }
            })
        }
        self._orderBooksAndTrades.pairs[pair].nounce = data.Nounce;
        // emit event
        self.emit('orderBookAndTrades', obj);
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
    if (undefined === this._orderBooksAndTrades.pairs[data.MarketName])
    {
        return;
    }
    let lastNounce = this._orderBooksAndTrades.pairs[data.MarketName].nounce;
    // ignore, we didn't receive full order book yet
    if (0 == lastNounce)
    {
        return;
    }
    // did we miss some nounce ?
    let missedCount = data.Nounce - lastNounce;
    if (missedCount > 1 || missedCount < 0)
    {
        if (debug.enabled)
        {
            debug("We missed %d update for market '%s', full data will be retrieved", missedCount, data.MarketName);
        }
        this._queryExchangeState(this._connection, data.MarketName);
        return;
    }
    let obj = {
        pair:data.MarketName,
        cseq:this._orderBooksAndTrades.pairs[data.MarketName].cseq++,
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
            if (0 == entry.Type)
            {
                action = 'insert';
            }
            else if (1 == entry.Type)
            {
                action = 'remove';
            }
            return {
                action:action,
                rate:parseFloat(entry.Rate),
                quantity:parseFloat(entry.Quantity)
            }
        }),
        trades:_.map(data.Fills, entry => {
            let price = undefined !== entry.Price ? entry.Price : entry.Quantity * entry.Rate;
            return {
                quantity:entry.Quantity,
                rate:entry.Rate,
                price:price,
                timestamp:parseFloat(new Date(entry.TimeStamp).getTime() / 1000.0)
            }
        })
    }
    this._orderBooksAndTrades.pairs[data.MarketName].nounce = data.Nounce;
    this.emit('orderBookAndTradesUpdate', obj);
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
        if (undefined === this._tickers[entry.MarketName])
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
        let ticker = {
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
        this.emit('tickers', ticker);
    });
}

_disconnect(finalDisconnect)
{
    if (null === this._connection)
    {
        return;
    }
    if (finalDisconnect)
    {
        if (debug.enabled)
        {
            debug("Client will be disconnected : %d connections have been made", this._counter);
        }
    }
    this._connection.disconnect();
    this._connection = null;
}

disconnect()
{
    this._disconnect(true);
}

}

module.exports = SignalRClient;
