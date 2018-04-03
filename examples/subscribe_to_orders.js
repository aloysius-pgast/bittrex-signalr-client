"use strict";
const util = require('util');
const SignalRClient = require('../lib/client.js');

let client = new SignalRClient({
    // websocket will be automatically reconnected if server does not respond to ping after 10s
    pingTimeout:10000,
    // subscribing to orders is not supported by legacy endpoint (we need to use the beta API)
    legacy:false,
    auth:{
        key:"abcdef",
        secret: "123456"
    }
});

// NB: you need to provide correct API key & secret above to be able to subscribe to orders

//-- event handlers
client.on('order', function(data){
    console.log(util.format("Got 'order' event for order '%s' (%s)", data.orderNumber, data.pair));
    console.log(JSON.stringify(data));
});

//-- start subscription
console.log("=== Subscribing to orders");
client.subscribeToOrders();

// disconnect client after 10min
setTimeout(function(){
    console.log('=== Disconnecting...');
    client.disconnect();
    process.exit(0);
}, 600000);
