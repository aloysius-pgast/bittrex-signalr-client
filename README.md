# bittrex-signalr-client

Node.js implementation of SignalR protocol tailored for Bittrex exchange

## Disclaimer

This is a work in progress mostly meant to be integrated in [Crypto Exchanges Gateway](https://github.com/aloysius-pgast/crypto-exchanges-gateway). But it can also be used as a standalone module to connect to Bittrex WS

NB : doing REST API calls is outside of the scope of the module. If you need support for Bittrex REST API, use [node.bittrex.api](https://github.com/dparlevliet/node.bittrex.api) instead

## What it does

* Implement methods for subscribing to tickers & markets (order books & trades)

* Handle automatic reconnection in (I think !) every possible scenario

* Implements a watchdog to detect when _Bittrex_ stops sending data (default to 30min, automatic reconnection)

* Handle CloudFare's anti-ddos page using [cloudscaper](https://www.npmjs.com/package/cloudscraper/)

* Support for new Bittrex API (tickers, order books, trades & user orders)

## Installation

```
npm install bittrex-signalr-client
```

## How to use it

See [documentation in _doc_ directory](https://github.com/aloysius-pgast/bittrex-signalr-client/tree/master/doc/) for a description of supported API

See [examples in _examples_ directory](https://github.com/aloysius-pgast/bittrex-signalr-client/tree/master/examples/) for an overview of what this library can do

## Other similar projects

* [signalr-client](https://www.npmjs.com/package/signalr-client)

My work is inspired by _signalr-client_. Unfortunately, developer of _signalr-client_ is not working actively on it anymore.
Also, the way disconnection was managed in _signalr-client_ didn't suit my needs

* [node.bittrex.api](https://github.com/dparlevliet/node.bittrex.api)

_node.bittrex.api_ is a really nice wrapper around Bittrex API. Unfortunately it uses _signalr-client_ internally.

I need to add that without the work of [dparlevliet](https://github.com/dparlevliet) who did some reverse engineering on Bittrex usage of SignalR, this library would not exist
