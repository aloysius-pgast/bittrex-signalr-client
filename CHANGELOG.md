# Change Log

## [v1.1.2]
* Ensures connection to exchange is always closed when we don't have any subscription remaining
* New constructor option _watchdog.orders_ to automatically force re-subscriptions for orders periodically

## [v1.1.1]
* Allows to force re-subscription to orders (Bittrex Beta API)
* New method to enable logging keepalive messages (node _DEBUG_ must be enabled)
* Bittrex Beta is over, removed _legacy_ methods

## [v1.1.0]
* Support for Bittrex Beta API (tickers, order books, trades & user orders)
* Possibility to disable Cloud Scraper

## [v1.0.9]
* Change default User-Agent & add extra headers to bypass CloudFare protection

## [v1.0.8]
* Watchdog was added to reconnect upon detecting timeout (ie: when _Bittrex_ stopped sending data)

## [v1.0.7]
* Method _subscribeToAllTickers_ was added to subscribe to all tickers at once

## [v1.0.6]
* Take UTC offset into account when parsing DateTime strings returned by Bittrex

## [v1.0.5]
* Use _Big.js_ for floating point arithmetic

## [v1.0.4]
* Change _transport_ from _serverSentEvents_ to _webSockets_ for _abort_ step

## [v1.0.3]
* Change _transport_ from _serverSentEvents_ to _webSockets_ for _start_ step
* Implement call to _SignalR_ method _SubscribeToSummaryDeltas_ for tickers subscription (update are not sent automatically anymore by Bittrex)

## [v1.0.2]
* Ensure _disconnected_ and _connected_ events are properly emitted
* New method to retrieve SignalR connectionId
* Changes to logged messages
