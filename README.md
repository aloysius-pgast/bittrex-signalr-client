# bittrex-signalr-client

Node.js implementation of SignalR protocol tailored for Bittrex exchange

## What it does

* Implement methods for subscribing to tickers & markets (order books & trades)
* Handle automatic reconnection in (I think !) every possible scenario
* Handle CloudFare's anti-ddos page using [cloudscaper](https://www.npmjs.com/package/cloudscraper/)

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
