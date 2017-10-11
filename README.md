# bittrex-signalr-client

Node.js implementation of SignalR protocol tailored for Bittrex exchange

## What it does

* Implement methods for subscribing to tickers & order books
* Handle automatic reconnection if (I think !) every possible scenario

## How to use it

See [examples in _examples_ directory](examples/) for an overview of what this library can do

## Other similar projects

* [signalr-client](https://www.npmjs.com/package/signalr-client)

My work is inspired by _signalr-client_. Unfortunately, developer of _signalr-client_ is not working actively on it anymore.
Also, the way disconnection was managed in _signalr-client_ didn't suit my needs

## Faq

### What about cloudscraper ?

I know that project [node.bittrex.api](https://github.com/dparlevliet/node.bittrex.api) uses _cloudscraper_ internally. But I'm still not sure whether or not I need it :)
