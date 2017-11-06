# Constructor

Constructor takes an object as argument with following available properties (all optional)

* _retryDelay_ : _integer_, delay in milliseconds before reconnecting upon disconnection or connection failure (default = _10000_)

* _retryCount.negotiate_ : _integer_, number of retries in case _negotiate_ step fails (default = _11_) (can be set to string _always_ to retry indefinitely) * _retryCount.connect : _integer_, number of retries in case _connect_ step fails (default = _1_) (can be set to string _always_ to retry indefinitely)

* _retryCount.start_ : _integer_, number of retries in case _start_ step fails (default = _1_) (can be set to string _always_ to retry indefinitely)

* _reconnectAfterUnsubscribingFromMarkets.reconnect_ : _boolean_. If _true_, currenct SignalR connection will be reconnected when unsubscribing from markets (since Bittrex does not allow any other way to unsubscribe). If _false_ library will keep receiving data for unsubscribed markets (which can consume unecessary bandwidth) (default = _true_)

* _reconnectAfterUnsubscribingFromMarkets.after_ : integer, indicates after how many unsubscriptions SignalR connection should be reconnected (default = _1_)

# Reconnection

Method _reconnect()_ should be called upon receiving _terminated_ event

# Subscriptions methods

## Subscribe to tickers

Used to subscribe to tickers for a list of pairs

Method _subscribeToTickers(pairs, reset)_

* _pairs_ : array of pairs to subscribed to (ex: _['USDT-BTC']_)

* _reset_ : if _true_, previous subscriptions will be discarded (optional, default = _false_)

## Unsubscribe from tickers

Used to unsubscribe from tickers for a list of pairs

Method _unsubscribeFromTickers(pairs)_

* _pairs_ : array of pairs to unsubscribe from (ex: _['USDT-BTC']_)

## Unsubscribe from all tickers

Used to unsubscribe from tickers for all currently subscribed pairs

Method _unsubscribeFromAllTickers()_

## Subscribe to markets

Used to subscribe to markets data (order books & trades) for a list of pairs

Method _subscribeToMarkets(pairs, reset)_

* _pairs_ : array of pairs to subscribed to (ex: _['USDT-BTC']_)

* _reset_ : if _true_, previous subscriptions will be discarded (optional, default = _false_)

## Unsubscribe from markets

Used to unsubscribe from markets (order books & trades) for a list of pairs

Method _unsubscribeFromMarkets(pairs)_

* _pairs_ : array of pairs to unsubscribe from (ex: _['USDT-BTC']_)

## Unsubscribe from all markets

Used to unsubscribe from markets for all currently subscribed pairs

Method _unsubscribeFromAllMarkets()_

## Resync order book

Used to request full order book for a list of pairs. This shouldn't be necessary as this is automatically done by library upon subscribing to a market or when library detect that order book updates were missed (based on cseq)

Method _resyncOrderBooks(pairs)_

* _pairs_ : array of pairs to ask full order books for (ex: _['USDT-BTC']_)

# Emitted events

## Connection related events

### connected

When SignalRConnection connection is connected/reconnected. No action should be taken by client.

```
{
    "connectionId":string
}
```

* connectionId : id of SignalR connection

### disconnected

When SignalRConnection has been closed by exchange. Reconnection will be automatic, no action should be taken by client.

```
{
    "connectionId":string,
    "code":integer,
    "reason":string
}
```

* connectionId : id of SignalR connection
* code: disconnection code
* reason : disconnection reason

### connectionError

When a connection/reconnection error has occurred. Library will automatically retry to connect. No action should be taken by client.

```
{
    "step":string,
    "attempts":integer,
    "error":object
}
```

* step : connection step (negotiate|start|connect)

* attempts : number of attempts to connect

* error : the connection error which occurred

### terminated

When connection failed after last connection retry. This is a final event, library will not try to reconnect automatically anymore. This event will never be emitted if library was setup with infinite retry (see _constructor_). Client should call method _reconnect()_ upon receiving this event.

```
{
    "step":string,
    "attempts":integer,
    "error":object
}
```

## Tickers & markets events

### ticker

_Example_

```
{
    "pair":"USDT-BTC",
    "data":{
        "pair":"USDT-BTC",
        "last":7155,
        "priceChangePercent":-5.206677139913463,
        "sell":7155,
        "buy":7150,
        "high":7576,
        "low":7100.01,
        "volume":5357.92210528,
        "timestamp":1509986841.91
    }
}
```

### orderBook

```
{
    "pair":"USDT-BTC",
    "cseq":54694,
    "data":{
        "buy":[
            {
                "rate":7158,
                "quantity":0.18125832
            },
            {
                "rate":7147.84000102,
                "quantity":0.33576833
            },
            {
                "rate":7147.84000003,
                "quantity":0.00037697
            }
        ],
        "sell":[
            {
                "rate":7159.61768333,
                "quantity":0.75758168
            },
            {
                "rate":7159.62768333,
                "quantity":0.00350054
            },
            {
                "rate":7162.99999999,
                "quantity":0.1648124
            },
            {
                "rate":7167.99999999,
                "quantity":0.59600039
            },
            {
                "rate":7169.99999999,
                "quantity":0.5333059
            }
        ]
    }
}
```

### orderBookUpdate

```
{
    "pair":"USDT-BTC",
    "cseq":85719,
    "data":{
        "buy":[
            {
                "action":"update",
                "rate":7131,
                "quantity":0.72188827
            }
        ],
        "sell":[
            {
                "action":"remove",
                "rate":7221.71517258,
                "quantity":0
            },
            {
                "action":"update",
                "rate":7226.99999999,
                "quantity":0.61909178
            },
            {
                "action":"update",
                "rate":7265.72525,
                "quantity":0.00709438
            }
        ]
    }
}
```

### trades

```
{
    "pair":"USDT-BTC",
    "data":[
        {
            "id":23090089,
            "quantity":0.0288771,
            "rate":7149.99999999,
            "price":206.47126499,
            "orderType":"buy",
            "timestamp":1509986924.897
        },
        {
            "id":23090087,
            "quantity":0.00460101,
            "rate":7149.99999999,
            "price":32.89722149,
            "orderType":"buy",
            "timestamp":1509986924.553
        }
}
```

_NB_ : Bittrex does not always provide _id_ property for trades so you should consider it as being optional (ie: don't rely on it)
