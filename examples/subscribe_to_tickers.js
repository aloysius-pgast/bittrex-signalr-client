"use strict";
const util = require('util');
const SignalRClient = require('../lib/client.js');
let client = new SignalRClient({
    // websocket will be automatically reconnected if server does not respond to ping after 10s
    pingTimeout:10000,
    // use cloud scraper to bypass Cloud Fare (default)
    useCloudScraper:true
});

//-- event handlers
client.on('ticker', function(data){
    console.log(util.format("Got ticker update for pair '%s'", data.pair));
});

//-- start subscription
console.log("=== Subscribing to 'USDT-BTC' pair");
client.subscribeToTickers(['USDT-BTC']);

// add subscription for 'USDT-ETH' & 'BTC-USDT' after 15s
setTimeout(function(){
    console.log("=== Adding subscription for USDT-ETH & BTC-ETH pairs");
    client.subscribeToTickers(['USDT-ETH','BTC-ETH']);
}, 30000);

// add subscription for 'BTC-NEO', unsubscribe from previous pairs after 30s
setTimeout(function(){
    console.log("=== Setting BTC-NEO as the only pair we want to subscribe to");
    client.subscribeToTickers(['BTC-NEO'], true);
}, 60000);

// disconnect client after 60s
setTimeout(function(){
    console.log('=== Disconnecting...');
    client.disconnect();
    process.exit(0);
}, 120000);
