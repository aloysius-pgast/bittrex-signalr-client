"use strict";
const util = require('util');
const SignalRClient = require('../lib/client.js');
let client = new SignalRClient({
    // websocket will be automatically reconnected if server does not respond to ping after 10s
    pingTimeout:10000
});

//-- event handlers
client.on('tickers', function(data){
    console.log(util.format("Got ticker update for pair '%s'", data.pair));
});

//-- start subscription
console.log("Subscribing to 'USDT-BTC' pair");
client.subscribeTickers(['USDT-BTC']);

// add subscription for 'USDT-ETH' & 'BTC-USDT' after 10s
setTimeout(function(){
    console.log("Adding subscription for USDT-ETH & BTC-ETH pairs");
    client.subscribeTickers(['USDT-ETH','BTC-ETH']);
}, 15000);

// add subscription for 'BTC-NEO', unsubscribe from previous pairs after 20s
setTimeout(function(){
    console.log("Setting BTC-NEO as the only pair we want to subscribe to");
    client.subscribeTickers(['BTC-NEO'], {reset:true});
}, 30000);

// disconnect client after 45s
setTimeout(function(){
    console.log('Disconnecting...');
    client.disconnect();
    process.exit(0);
}, 45000);
