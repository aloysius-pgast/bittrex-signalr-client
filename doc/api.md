# Constructor

Constructor takes an object as argument with following available properties (all optional)

* _useCloudScraper_ : _boolean_, if _false_ Cloud Scraper will not be used (default = _true_)

* _auth.key_ : _string_, Bittrex API key (only needed to subscribe to user orders)

* _auth.secret_ : _string_, Bittrex API secret (only needed to subscribe to user orders)

* _retryDelay_ : _integer_, delay in milliseconds before reconnecting upon disconnection or connection failure (default = _10000_)

* _retryCount.negotiate_ : _integer_, number of retries in case _negotiate_ step fails (default = _11_) (can be set to string _always_ to retry indefinitely)

* _retryCount.connect_ : _integer_, number of retries in case _connect_ step fails (default = _1_) (can be set to string _always_ to retry indefinitely)

* _retryCount.start_ : _integer_, number of retries in case _start_ step fails (default = _1_) (can be set to string _always_ to retry indefinitely)

* _reconnectAfterUnsubscribingFromMarkets.reconnect_ : _boolean_. If _true_, current _SignalR_ connection will be reconnected when unsubscribing from markets (since _Bittrex_ does not allow any other way to unsubscribe). If _false_ library will keep receiving data for unsubscribed markets (which could consume unnecessary bandwidth in the long run) (default = _true_)

* _reconnectAfterUnsubscribingFromMarkets.after_ : integer, indicates after how many un-subscriptions _SignalR_ connection should be reconnected (default = _1_)

* _watchdog.tickers.timeout_ : _integer_, delay in milliseconds after which we should consider timeout if no _tickers_ data was received. (default = _1800000_, 30min) (set to _0_ to disable)

* _watchdog.tickers.reconnect_ : _boolean_, if true a reconnection will occur upon detecting timeout (default = _true_)

* _watchdog.markets.timeout_ : _integer_, delay in milliseconds after which we should consider timeout if no _markets_ data was received. (default = _1800000_, 30min) (set to _0_ to disable)

* _watchdog.markets.reconnect_ : _boolean_, if true a reconnection will occur upon detecting timeout (default = _true_)

* _watchdog.orders.enabled_ : _boolean_, if true library will re-subscribe for orders periodically (default = _true_)

* _watchdog.orders.period_ : _integer_, delay (in _seconds_) after which re-subscription should be performed (default = _1800_, 30min)

# Watchdog

## Tickers & Markets

When watchdog is enabled, it will only be activated if subscriptions exist. If client unsubscribe from all _markets_ or all _tickers_, it will be automatically disabled and re-enabled once new subscriptions exist

If a watchdog is enabled and _timeout_ is detected, _timeout_ event will be triggered. If _reconnect_ is _false_ for this watchdog, client will need to reconnect manually

Watchdog will check for timeout every _timeout / 10_. This means that will be detected between _timeout_ ms and _timeout ms + 10%_.

Do not set timeout value *too low* : setting value to _5 min_ will ensure timeout will be detected between _5 min_ and _5 min 30 sec_, while checking for timeout _every 30 seconds_

## Orders

When _watchdog.orders.enabled_ is _true_, a new subscription for orders will be sent to Bittrex, N seconds (_watchdog.orders.period_) after the last subscription

NB: re-subscription only be triggered if a subscription for orders exist (ie: if _subscribeToOrders_ was called by client)

# Reconnection

Method _reconnect(immediate)_ should be called upon receiving _terminated_ event

* _immediate_ : boolean, if _true_ connection will be reconnected immediately, otherwise delay will be as specified in constructor (_retryDelay_) (default = _false_)

# Subscriptions methods

## Subscribe to all tickers

Used to subscribe to all existing tickers at once

Method _subscribeToAllTickers()_

## Subscribe to tickers

Used to subscribe to tickers for a list of pairs (will be ignored if a subscription to _all_ tickers exists)

Method _subscribeToTickers(pairs, reset)_

* _pairs_ : array of pairs to subscribed to (ex: _['USDT-BTC']_)

* _reset_ : if _true_, previous subscriptions will be discarded (optional, default = _false_)

## Unsubscribe from tickers

Used to unsubscribe from tickers for a list of pairs (will be ignored if a subscription to _all_ tickers exists)

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

## Subscribe to orders

Used to subscribe to orders data (ie: receive events when your orders are being opened, filled, cancelled)

Method _subscribeToOrders(resubscribe)_

* _resubscribe_ : if _true_ client will re-subscribe to exchange, even if a subscription already exists (default = _false_)

## Unsubscribe from orders

Used to unsubscribe from orders feed

Method _unsubscribeFromOrders()_

# Emitted events

## Connection related events

### connected

When _SignalR_ connection connection is connected/reconnected. No action should be taken by client.

```
{
    "connectionId":string
}
```

* _connectionId_ : id of _SignalR_ connection

### disconnected

When _SignalR_ connection has been closed by exchange. Reconnection will be automatic, no action should be taken by client.

```
{
    "connectionId":string,
    "code":integer,
    "reason":string
}
```

* _connectionId_ : id of _SignalR_ connection

* _code_ : disconnection code

* _reason_ : disconnection reason

### connectionError

When a connection/reconnection error has occurred. Library will automatically retry to connect. No action should be taken by client.

```
{
    "step":string,
    "attempts":integer,
    "error":object
}
```

* _step_ : connection step (negotiate|start|connect)

* _attempts_ : number of attempts to connect

* _error_ : the connection error which occurred

### terminated

When connection failed after last connection retry. This is a final event, library will not try to reconnect automatically anymore. This event will never be emitted if library was setup with infinite retry (see _constructor_). Client should call method _reconnect()_ upon receiving this event.

```
{
    "step":string,
    "attempts":integer,
    "error":object
}
```

### timeout

When watchdog detected that Bittrex stopped sending data. If _watchdog_ was configured to reconnect automatically upon detecting timeout, no action is required on client side

```
{
    "connectionId":string,
    "dataType":string,
    "lastTimestamp":integer
}
```

* _connectionId_ : id of _SignalR_ connection

* _dataType_ : one of (_tickers_,_markets_)

* _lastTimestamp_ : unix timestamp (in ms) of last received data

NB: will only be sent for _tickers_ & _markets_

### watchdog

### Tickers & markets

For _tickers_ and _markets_ watchdogs, event will be emitted everytime watchdog checks if a timeout occurred.

```
{
    "connectionId":string,
    "dataType":string,
    "lastTimestamp":integer
}
```

* _connectionId_ : id of _SignalR_ connection

* _dataType_ : one of (_tickers_,_markets_)

* _lastTimestamp_ : unix timestamp (in ms) of last received data

#### Orders

For _orders_ watchdog, event will be emitted everytime, an _automatic_ re-subscription was successful

```
{
    "connectionId":string,
    "dataType":string,
    "lastTimestamp":integer
}
```

* _connectionId_ : id of _SignalR_ connection

* _dataType_ : _orders_

* _lastTimestamp_ : unix timestamp (in ms) of last automatic re-subscription

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
    ]
}
```

### order

_orderState_ can be one of the following :

* _OPEN_ : order has been created
* _PARTIAL_ : order has been partially filled and is still open
* _CANCEL_ : order has been cancelled before being filled (ie: _quantity_ = _remainingQuantity_)
* _FILL_ : order is closed (it can be filled partially or completely)

#### event when an order has been created

```
{
    "pair":"BTC-PTC",
    "orderNumber":"77c8f585-6d0c-4d5f-a5b0-a3c5abee504e",
    "data":{
        "pair":"BTC-PTC",
        "orderNumber":"77c8f585-6d0c-4d5f-a5b0-a3c5abee504e",
        "orderState":"OPEN",
        "orderType":"LIMIT_SELL",
        "quantity":1000,
        "remainingQuantity":1000,
        "openTimestamp":1522765015.517,
        "targetRate":0.00000406,
        "targetPrice":0.00406
    }
}
```

#### event when an order has been partially filled

An order will be in state _PARTIAL_ until it is closed in following cases :

* order is completely filled
* order is cancelled

```
{
    "pair":"BTC-PTC",
    "orderNumber":"77c8f585-6d0c-4d5f-a5b0-a3c5abee504e",
    "data":{
        "pair":"BTC-PTC",
        "orderNumber":"77c8f585-6d0c-4d5f-a5b0-a3c5abee504e",
        "orderState":"PARTIAL",
        "orderType":"LIMIT_SELL",
        "quantity":1000,
        "remainingQuantity":29.71930944,
        "openTimestamp":1522765015.517,
        "targetRate":0.00000406,
        "targetPrice":0.00406
    }
}
```

#### event when an order has been cancelled

An order will only be in _CANCEL_ state if it was *not filled at all*. In such case :

* _quantity_ = _remainingQuantity_
* _actualPrice_ = 0
* _fees_ = 0
* _actualRate_ = _null_

```
{
    "pair":"BTC-PTC",
    "orderNumber":"0c047f50-de8d-4c9d-841e-88c67bfbc28d",
    "data":{
        "pair":"BTC-PTC",
        "orderNumber":"0c047f50-de8d-4c9d-841e-88c67bfbc28d",
        "orderState":"CANCEL",
        "orderType":"LIMIT_SELL",
        "quantity":1000,
        "remainingQuantity":1000,
        "openTimestamp":1522762678.567,
        "targetRate":0.000008,
        "targetPrice":0.008,
        "closedTimestamp":1522762698.473,
        "actualPrice":0,
        "fees":0,
        "actualRate":null
    }
}
```

#### event when an order has been closed after being filled

If an order has been filled (partially or completely), it will be in _FILL_ state. If order has been cancelled while being partially completed _remainingQuantity_ will be _!= 0_

```
{
    "pair":"BTC-PTC",
    "orderNumber":"77c8f585-6d0c-4d5f-a5b0-a3c5abee504e",
    "data":{
        "pair":"BTC-PTC",
        "orderNumber":"77c8f585-6d0c-4d5f-a5b0-a3c5abee504e",
        "orderState":"FILL",
        "orderType":"LIMIT_SELL",
        "quantity":1000,
        "remainingQuantity":29.71930944,
        "openTimestamp":1522765015.517,
        "targetRate":0.00000406,
        "targetPrice":0.00406,
        "closedTimestamp":1522765092.253,
        "actualPrice":0.00393933,
        "fees":0.00000984,
        "actualRate":0.00000405
    }
}```
