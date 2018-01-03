# Change Log

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
