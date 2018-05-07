"use strict";
const WebSocket = require('ws');
const request = require('request');
const util = require('util');
const retry = require('retry');
const querystring = require('querystring');
const debug = require('debug')('BittrexSignalRClient:Connection');
const cloudScraper = require('cloudscraper');
const _ = require('lodash');
const EventEmitter = require('events');

//-- Bittrex endpoints
// base url
const BASE_PATH = 'bittrex.com/signalr';
const CLOUD_SCRAPER_URL = 'https://bittrex.com/';

// connection configuration
const DEFAULT_SOCKETTIMEOUT = 60 * 1000;
// in case connection fails, how long should we wait before retrying ?
const RETRY_DELAY = 10 * 1000;
const RETRY_COUNT = {
    // retry 11 times (this means that WS will try to connect for a maximum of 120s)
    negotiate:11,
    // only retry once for connect
    connect:1,
    // only retry once for start
    start:1
}

// SignalR connection states
const STATE_NEW = 0;
const STATE_CONNECTING = 1;
const STATE_CONNECTED = 2;
const STATE_DISCONNECTING = 3;
const STATE_DISCONNECTED = 4;

// whether or not we want to perform 'start' step (does not seem to be mandatory with Bittrex)
const IGNORE_START_STEP = false;

//-- SignalR config
// hub
const HUB = 'c2';
const CLIENT_PROTOCOL_VERSION = '1.5';

// Extra headers used to bypass CloudFare
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 11_0 like Mac OS X) AppleWebKit/604.1.38 (KHTML, like Gecko) Version/11.0 Mobile/15A372 Safari/604.1';
const CLOUD_SCRAPER_HTTP_HEADERS = {
    'Referer': 'https://google.com',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Upgrade-Insecure-Requests': '1'
}

/*

ConnectionTimeout : this setting represents the amount of time to leave a transport connection open and waiting for a response before closing it and
opening a new connection. The default value is 110 seconds. This setting applies only when keepalive functionality is disabled, which normally applies
only to the long polling transport

DisconnectTimeout : the amount of time in seconds within which the client should try to reconnect if the connection goes away.

KeepAliveTimeout : the amount of time in seconds the client should wait before attempting to reconnect if it has not received a keep alive message.
If the server is configured to not send keep alive messages this value is null.

TransportConnectTimeout : the maximum amount of time the client should try to connect to the server using a given transport

 */

 /*
  Following events are emitted :

  1) message, when a message is received

  Data will contain the message received

  2) connectionError, when a connection error occurs

  Data will be an object {step:string,attempts:integer,retry:boolean,error:err}

  - step : connection step (negotiate|start|connect)
  - attempts : number of attempts to connect
  - retry : whether or not there are retry left
  - error : the connection error which occurred

  3) disconnected, when websocket connection has been disconnected

  This is a final event. Websocket won't be reconnected. A new SignalRConnection object should be used
  Event will not be emitted in case connection is disconnected by client or on connection failure
  Event will not be emitted for connection/reconnection error (event connectionError will be emitted instead)

  Data will be an object {connectionId:string, code:integer,reason:string}

  4) connected, when connection is ready to receive message

  Event will only be emitted once in the lifetime of the object

  Data will be an object {connectionId:string}

*/
class SignalRConnection extends EventEmitter
{

constructor(options)
{
    super();
    // by default use Cloud Scraper
    this._useCloudScraper = true;
    this._retryCount = {
        negotiate:RETRY_COUNT.negotiate,
        connect:RETRY_COUNT.connect,
        start:RETRY_COUNT.start
    }
    this._retryDelay = RETRY_DELAY;
    this._ignoreStartStep = IGNORE_START_STEP;
    // how long should we wait for a ping response ? (set to 0 to disable)
    this._pingTimeout = 30000;
    this._userAgent = DEFAULT_USER_AGENT;
    if (undefined !== options)
    {
        // Cloud Scraper
        if (false === options.useCloudScraper)
        {
            this._useCloudScraper = false;
        }
        // retry count
        if (undefined !== options.retryCount)
        {
            if (undefined !== options.retryCount.negotiate)
            {
                this._retryCount.negotiate = options.retryCount.negotiate;
            }
            if (undefined !== options.retryCount.connect)
            {
                this._retryCount.connect = options.retryCount.connect;
            }
            if (undefined !== options.retryCount.start)
            {
                this._retryCount.start = options.retryCount.start;
            }
        }
        if (undefined !== options.retryDelay)
        {
            this._retryDelay = options.retryDelay;
        }
        if (undefined !== options.ignoreStartStep)
        {
            this._ignoreStartStep = options.ignoreStartStep;
        }
        if (undefined != options.userAgent && '' != options.userAgent)
        {
            this._userAgent = options.userAgent;
        }
        if (undefined !== options.pingTimeout)
        {
            this._pingTimeout = options.pingTimeout;
        }
    }

    // cloud scraper parameters
    this._cloudScraper = {
        cookie:'',
    }

    this._timestamps = {
        negotiate:null,
        connect:null,
        start:null
    }
    this._ignoreCloseEvent = true;
    this._connectionState = STATE_NEW;
    this._connection = null,
    this._ws = null;
    this._lastMessageId = 1;
    this._callbacks = {};

    // for debugging purpose
    this._logAllWsMessages = false;
    this._logKeepaliveMessages = false;
}

/**
 * Enable / disable logging of all received WS messages
 *
 * @param {boolean} true to enable, false to disable
 */
logAllWsMessages(flag)
{
    this._logAllWsMessages = flag;
}

/**
 * Enable / disable logging of keepalive messages (received 'ping' & received 'pong')
 *
 * @param {boolean} true to enable, false to disable
 */
logKeepaliveMessages(flag)
{
    this._logKeepaliveMessages = flag;
}

/**
 * Indicates whether or not we're ready to process messages from server
 */
isConnected()
{
    return STATE_CONNECTED == this._connectionState;
}

/**
 * Indicates whether or not we're waiting for connection to be established
 */
isConnecting()
{
    return STATE_CONNECTING == this._connectionState;
}

/**
 * Indicates whether or not connection is new (ie: can be connected)
 */
isNew()
{
    return STATE_NEW == this._connectionState;
}

/**
 * Indicates whether or no connection is disconnected (ie: cannot be used anymore)
 */
isDisconnected()
{
    return STATE_DISCONNECTED == this._connectionState;
}

/**
 * Returns an https url
 *
 * @param {path} url path
 * @return {string}
 */
_getHttpsUrl(path)
{
    return `https://${BASE_PATH}/${path}`;
}

/**
 * Returns a wss url
 *
 * @param {path} url path
 * @return {string}
 */
_getWssUrl(path)
{
    return `wss://${BASE_PATH}/${path}`;
}

/**
 * Returns SignalR hubs
 *
 * @return {array}
 */
_getHubs()
{
    return [{name:HUB}];
}

/**
 * Return hub name
 *
 * @return {string}
 */
_getHubName()
{
    return HUB;
}

/**
 * SignalR 'negotiate' step
 */
_negotiate(retryCount)
{
    let attempt = 1;
    try
    {
        let retryOptions = {
            minTimeout:this._retryDelay,
            factor:1,
            randomize:false
         };
         if (-1 === retryCount)
         {
             retryOptions.forever = true;
         }
         else
         {
             retryOptions.retries = retryCount;
         }
         let operation = retry.operation(retryOptions);
         let headers = {
             'User-Agent': this._userAgent
         }
         // use data retrieved by cloud scraper if available
         if ('' != this._cloudScraper.cookie)
         {
             headers['cookie'] = this._cloudScraper.cookie;
         }
         let requestOptions = {
             timeout:DEFAULT_SOCKETTIMEOUT,
             method:'GET',
             headers: headers,
             json:true,
             url:this._getHttpsUrl('negotiate'),
             qs:{
                 clientProtocol:CLIENT_PROTOCOL_VERSION,
                 transport:'serverSentEvents',
                 connectionData:JSON.stringify(this._getHubs())
             }
         }
         let self = this;
         return new Promise((resolve, reject) => {
             operation.attempt(function(currentAttempt){
                 if (STATE_CONNECTING != self._connectionState)
                 {
                     resolve({ignore:true});
                     return;
                 }
                 attempt = currentAttempt;
                 request(requestOptions, function(error, response, body){
                     if (STATE_CONNECTING != self._connectionState)
                     {
                         resolve({ignore:true});
                         return;
                     }
                     let err = null;
                     let doRetry = true;
                     if (null !== error)
                     {
                         err = {origin:'client', error:error.message};
                     }
                     else if (200 != response.statusCode)
                     {
                         err = {origin:'remote', error:{code:response.statusCode,message:response.statusMessage}}
                     }
                     if (null !== err)
                     {
                         if (debug.enabled)
                         {
                             debug("'negotiate' step error (%d/%s) : %s", attempt, -1 === retryCount ? 'unlimited' : (1 + retryCount), JSON.stringify(err));
                         }
                         if (doRetry && operation.retry(err))
                         {
                             self.emit('connectionError', {step:'negotiate',attempts:attempt,retry:true,error:err});
                             return;
                         }
                         reject({attempts:attempt, error:err});
                         return;
                     }
                     self._connection = body;
                     self._timestamps.negotiate = new Date().getTime();
                     resolve({connectionId:body.ConnectionId,attempts:currentAttempt});
                 });
             });
        });
    }
    catch (e)
    {
        if (debug.enabled)
        {
            debug("'negotiate' step exception : %s", e.stack);
        }
        return new Promise((resolve, reject) => {
            let err = {origin:'client', error:e.message, stack:e.stack};
            reject({attempts:attempt, error:err});
        });
    }
}

_getConnectQueryString(connection)
{
    let qs = {
        clientProtocol: connection.ProtocolVersion,
        transport: "webSockets",
        connectionToken: connection.ConnectionToken,
        connectionData: JSON.stringify(this._getHubs()),
        tid: parseInt(new Date().getTime())
    };
    return `${this._getWssUrl('connect')}?${querystring.stringify(qs)}`;
}

/**
 * SignalR 'connect' step
 */
_connect(connection, retryCount)
{
    let attempt = 1;
    try
    {
        let self = this;
        let retryOptions = {
            minTimeout:this._retryDelay,
            factor:1,
            randomize:false
         };
         if (-1 === retryCount)
         {
             retryOptions.forever = true;
         }
         else
         {
             retryOptions.retries = retryCount;
         }
         let headers = {
             'User-Agent': this._userAgent
         }
         // use data retrieved by cloud scraper if available
         if ('' != this._cloudScraper.cookie)
         {
             headers['cookie'] = this._cloudScraper.cookie;
         }
         let wsOptions = {
             perMessageDeflate: false,
             handshakeTimeout:connection.TransportConnectTimeout * 2000,
             headers: headers
         }
         let operation = retry.operation(retryOptions);
         let queryString = this._getConnectQueryString(connection);
         return new Promise((resolve, reject) => {
             operation.attempt(function(currentAttempt){
                 if (STATE_CONNECTING != self._connectionState)
                 {
                     resolve({ignore:true});
                     return;
                 }
                 attempt = currentAttempt;
                 let doRetry = true;
                 let ws = new WebSocket(queryString, wsOptions);
                 let ignoreErrorEvent = false;
                 let skipCloseEvent = false;
                 ws.on('open', function open() {
                     // connection has already been disconnected
                     if (STATE_CONNECTING != self._connectionState)
                     {
                         resolve({ignore:true});
                         return;
                     }
                     if (debug.enabled)
                     {
                         debug("WS connected for connection '%s'", connection.ConnectionId);
                     }
                     self._timestamps.connect = new Date().getTime();
                     self._ignoreCloseEvent = false;
                     skipCloseEvent = false;
                     self._ws = this;
                     // start ping/pong
                     if (0 != self._pingTimeout)
                     {
                         let _ws = this;
                         _ws.isAlive = false;
                         // initial ping
                         _ws.ping('', true, true);
                         let interval = setInterval(function() {
                             if (WebSocket.OPEN != _ws.readyState)
                             {
                                 clearTimeout(interval);
                                 return;
                             }
                             if (!_ws.isAlive)
                             {
                                 if (debug.enabled)
                                 {
                                     debug("WS timeout for connection '%s' : timeout = '%d'", connection.ConnectionId, self._pingTimeout);
                                 }
                                 _ws.terminate();
                                 clearTimeout(interval);
                                 return;
                             }
                             _ws.isAlive = false;
                             _ws.ping('', true, true);
                         }, self._pingTimeout);
                     }
                     resolve({attempts:attempt});
                 });
                 ws.on('message', function (message) {
                     // this is for debugging purpose
                     if (self._logAllWsMessages && debug.enabled)
                     {
                         debug(message);
                     }
                     // discard messages if we're not in ready state
                     if (STATE_CONNECTED != self._connectionState)
                     {
                         return;
                     }
                     // ignore empty data
                     if ('{}' === message)
                     {
                         return;
                     }
                     let data;
                     try
                     {
                         data = JSON.parse(message);
                     }
                     catch (e)
                     {
                        if (debug.enabled)
                        {
                            debug("Received invalid JSON message : %s", message);
                        }
                        return;
                     }
                     // process responses
                     if (undefined !== data.I)
                     {
                         let messageId = parseInt(data.I);
                         // ignore progress
                         if (undefined !== data.D)
                         {
                             return;
                         }
                         // process result
                         if (undefined !== data.R)
                         {
                             // do we have a callback for this messageId
                             if (undefined !== self._callbacks[messageId])
                             {
                                 self._callbacks[messageId](data.R, null);
                                 delete self._callbacks[messageId];
                             }
                         }
                         // probably an error
                         else
                         {
                             let err = '';
                             // process error
                             if (undefined !== data.E)
                             {
                                 err = data.E;
                             }
                             if (debug.enabled)
                             {
                                 debug("Got an error for message %d : err = '%s'", messageId, err);
                             }
                             // do we have a callback for this messageId
                             if (undefined !== self._callbacks[messageId])
                             {
                                 self._callbacks[messageId](null, err);
                                 delete self._callbacks[messageId];
                             }
                         }
                         return;
                     }
                     if (undefined !== data.M)
                     {
                         _.forEach(data.M, (entry) => {
                             self.emit('data', entry);
                         });
                     }
                 });
                 ws.on('error', function(e) {
                     if (ignoreErrorEvent)
                     {
                         return;
                     }
                     // connection has already been disconnected
                     if (STATE_CONNECTING != self._connectionState)
                     {
                         resolve({ignore:true});
                         return;
                     }
                     let err = {origin:'client', error:{code:e.code,message:e.message}}
                     if (debug.enabled)
                     {
                         debug("'connect' step error for connection '%s' (%d/%s) : %s", connection.ConnectionId, attempt, -1 === retryCount ? 'unlimited' : (1 + retryCount), JSON.stringify(err));
                     }
                     skipCloseEvent = true;
                     self._ws = null;
                     this.terminate();
                     // ws is not open yet, likely to be a connection error
                     if (null === self._timestamps.connect)
                     {
                         if (doRetry && operation.retry(err))
                         {
                             self.emit('connectionError', {step:'connect',attempts:attempt,retry:true,error:err});
                             return;
                         }
                     }
                     reject({attempts:attempt, error:err});
                 });
                 // likely to be an auth error
                 ws.on('unexpected-response', function(request, response){
                     // connection has already been disconnected
                     if (STATE_CONNECTING != self._connectionState)
                     {
                         resolve({ignore:true});
                         return;
                     }
                     let err = {origin:'remote', error:{code:response.statusCode,message:response.statusMessage}}
                     if (debug.enabled)
                     {
                         debug("'connect' step unexpected-response for connection '%s' (%d/%s) : %s", connection.ConnectionId, attempt, -1 === retryCount ? 'unlimited' : (1 + retryCount), JSON.stringify(err));
                     }
                     ignoreErrorEvent = true;
                     skipCloseEvent = true;
                     self._ws = null;
                     if (doRetry && operation.retry(err))
                     {
                         self.emit('connectionError', {step:'connect',attempts:attempt,retry:true,error:err});
                         return;
                     }
                     reject({attempts:attempt, error:err});
                 });
                 ws.on('close', function(code, reason){
                     if (self._ignoreCloseEvent)
                     {
                         return;
                     }
                     // connection has already been disconnected
                     if (STATE_CONNECTING != self._connectionState && STATE_CONNECTED != self._connectionState)
                     {
                         return;
                     }
                     if (debug.enabled)
                     {
                         debug("WS closed for connection '%s' : code = '%d', reason = '%s'", connection.ConnectionId, code, reason);
                     }
                     self._ws = null;
                     self._finalize(true, STATE_DISCONNECTED);
                     if (!skipCloseEvent)
                     {
                         self.emit('disconnected', {connectionId:connection.ConnectionId, code:code, reason:reason});
                     }
                 });
                 // reply to ping
                 ws.on('ping', function(data){
                     // this is for debugging purpose
                     if (self._logKeepaliveMessages && debug.enabled)
                     {
                         debug(`Got 'ping' message from Bittrex at ${parseInt(Date.now() / 1000.0)}`);
                     }
                     this.pong('', true, true);
                 });
                 ws.on('pong', function(data){
                     // this is for debugging purpose
                     if (self._logKeepaliveMessages && debug.enabled)
                     {
                         debug(`Got 'pong' message from Bittrex at ${parseInt(Date.now() / 1000.0)}`);
                     }
                     this.isAlive = true;
                 });
            });
        });
    }
    catch (e)
    {
        if (debug.enabled)
        {
            debug("'connect' step exception : %s", e.stack);
        }
        return new Promise((resolve, reject) => {
            let err = {origin:'client', error:e.message, stack:e.stack};
            reject({attempts:attempt, error:err});
        });
    }
}

/**
 * SignalR 'start' step
 */
_start(connection, retryCount)
{
    let attempt = 1;
    try
    {
        // connection has already been disconnected
        if (STATE_CONNECTING != this._connectionState)
        {
            return new Promise((resolve, reject) => {
                resolve({ignore:true});
            });
        }
        // don't perform start step
        if (this._ignoreStartStep)
        {
            return new Promise((resolve, reject) => {
                resolve({});
            });
        }
        let retryOptions = {
            minTimeout:this._retryDelay,
            factor:1,
            randomize:false
         };
         if (-1 === retryCount)
         {
             retryOptions.forever = true;
         }
         else
         {
             retryOptions.retries = retryCount;
         }
         let operation = retry.operation(retryOptions);
         let headers = {
             'User-Agent': this._userAgent
         }
         // use data retrieved by cloud scraper if available
         if ('' != this._cloudScraper.cookie)
         {
             headers['cookie'] = this._cloudScraper.cookie;
         }
         let requestOptions = {
             timeout:DEFAULT_SOCKETTIMEOUT,
             method:'GET',
             headers: headers,
             json:true,
             url:this._getHttpsUrl('start'),
             qs:{
                 clientProtocol:CLIENT_PROTOCOL_VERSION,
                 //transport:'serverSentEvents',
                 // On 19/11/2017 Bittrex did some changes to transport
                 transport:'webSockets',
                 connectionToken:connection.ConnectionToken,
                 connectionData:JSON.stringify(this._getHubs())
             }
        }
        let self = this;
        return new Promise((resolve, reject) => {
            operation.attempt(function(currentAttempt){
                // connection has already been disconnected
                if (STATE_CONNECTING != self._connectionState)
                {
                    resolve({ignore:true});
                    return;
                }
                attempt = currentAttempt;
                request(requestOptions, function(error, response, body){
                    // connection has already been disconnected
                    if (STATE_CONNECTING != self._connectionState)
                    {
                        resolve({ignore:true});
                        return;
                    }
                    let err = null;
                    let doRetry = true;
                    if (null !== error)
                    {
                        err = {origin:'client', error:error.message};
                    }
                    else if (200 != response.statusCode)
                    {
                        err = {origin:'remote', error:{code:response.statusCode,message:response.statusMessage}}
                    }
                    if (null !== err)
                    {
                        if (debug.enabled)
                        {
                            debug("'start' step error for connection '%s' (%d/%s) : %s", connection.ConnectionId, attempt, -1 === retryCount ? 'unlimited' : (1 + retryCount), JSON.stringify(err));
                        }
                        if (doRetry && operation.retry(err))
                        {
                            self.emit('connectionError', {step:'start',attempts:attempt,retry:true,error:err});
                            return;
                        }
                        reject({attempts:attempt, error:err});
                        return;
                    }
                    self._timestamps.start = new Date().getTime();
                    resolve({attempts:attempt});
                });
            });
        });
    }
    catch (e)
    {
        if (debug.enabled)
        {
            debug("'start' step exception : %s", e.stack);
        }
        return new Promise((resolve, reject) => {
            let err = {origin:'client', error:e.message, stack:e.stack};
            reject({attempts:attempt, error:err});
        });
    }
 }

/**
 * SignalR 'abort' step
 */
_abort(connection)
{
    try
    {
        // do nothing if start was not sent
        if (null === this._timestamps.start)
        {
            return;
        }
        let headers = {
            'User-Agent': this._userAgent
        }
        // use data retrieved by cloud scraper if available
        if ('' != this._cloudScraper.cookie)
        {
            headers['cookie'] = this._cloudScraper.cookie;
        }
        let requestOptions = {
            timeout:DEFAULT_SOCKETTIMEOUT,
            method:'GET',
            headers: headers,
            json:true,
            url:this._getHttpsUrl('abort'),
            qs:{
                clientProtocol:CLIENT_PROTOCOL_VERSION,
                transport:'webSockets',
                connectionToken:connection.ConnectionToken,
                connectionData:JSON.stringify(this._getHubs())
            }
        }
        request(requestOptions, function(error, response, body){
            let err = null;
            if (null !== error)
            {
                err = {origin:'client', error:error.message};
            }
            else if (200 != response.statusCode)
            {
                err = {origin:'remote', error:{code:response.statusCode,message:response.statusMessage}}
            }
            if (null !== err)
            {
                if (debug.enabled)
                {
                    debug("'abort' step error : %s", JSON.stringify(err));
                }
            }
            else
            {
                if (debug.enabled)
                {
                    debug("'abort' step successfully performed for connection '%s' : %s", connection.ConnectionId);
                }
            }
        });
    }
    catch (e)
    {
        if (debug.enabled)
        {
            debug("'abort' step exception : %s", e.stack);
        }
    }
}

/**
 * Used to do a bit of cleaning (close ws, abort ...)
 *
 * @param {boolean} indicates whether or not WS should be terminated vs closed (default = false)
 */
_finalize(terminate, newState)
{
    // abort connection
    if (null !== this._connection)
    {
        let connection = this._connection;
        this._connection = null;
        this._abort(connection);
    }
    // close ws
    if (null !== this._ws)
    {
        let ws = this._ws;
        this._ws = null;
        this._ignoreCloseEvent = true;
        try
        {
            if (terminate)
            {
                ws.terminate();
            }
            else
            {
                ws.close();
            }
        }
        catch (e)
        {
            // do nothing
        }
    }
    this._connectionState = newState;
}

disconnect()
{
    if (STATE_DISCONNECTED == this._connectionState || STATE_DISCONNECTING == this._connectionState)
    {
        return;
    }
    this._connectionState = STATE_DISCONNECTING;
    this._finalize(false, STATE_DISCONNECTED);
    return;
}

callMethod(method, args, cb)
{
    if (STATE_CONNECTED != this._connectionState || WebSocket.OPEN != this._ws.readyState)
    {
        return false;
    }
    if (undefined !== cb)
    {
        this._callbacks[this._lastMessageId] = cb;
    }
    try
    {
        let methodName = method.toLowerCase();
        let data = {
            H:this._getHubName(),
            M:methodName,
            A:undefined === args ? [] : args,
            I:this._lastMessageId++
        }
        let payload = JSON.stringify(data);
        this._ws.send(payload);
    }
    catch (e)
    {
        if (debug.enabled)
        {
            debug("Exception when trying to call method %s : %s", method, e.stack);
        }
        return false;
    }
    return true;
}

connect()
{
    if (STATE_NEW != this._connectionState)
    {
        return false;
    }
    this._connectionState = STATE_CONNECTING;
    let self = this;
    this._cloudScraperRequest(function(err){
        if (null !== err)
        {
            // emit connectionError
            self.emit('connectionError', {step:'negotiate',attempts:0,retry:false,error:err});
            return;
        }
        // 'negotiate' step
        self._negotiate(self._retryCount.negotiate).then((result) => {
            if (result.ignore)
            {
                return;
            }
            if (debug.enabled)
            {
                debug("'negotiate' step successful after %d attempts : %s", result.attempts, JSON.stringify(self._connection));
            }
            // 'connect' step
            self._connect(self._connection, self._retryCount.connect).then((result) => {
                if (result.ignore)
                {
                    return;
                }
                if (debug.enabled)
                {
                    debug("'connect' step successful after %d attempts", result.attempts);
                }
                // 'start' step
                self._start(self._connection, self._retryCount.start).then((result) => {
                    if (result.ignore)
                    {
                        return;
                    }
                    self._connectionState = STATE_CONNECTED;
                    if (self._ignoreStartStep)
                    {
                        self.emit('connected', {connectionId:self._connection.ConnectionId});
                        return;
                    }
                    // now we're ready to have fun
                    if (debug.enabled)
                    {
                        debug("'start' step successful after %d attempts", result.attempts);
                    }
                    self.emit('connected', {connectionId:self._connection.ConnectionId});
                }).catch ((e) => {
                    if (debug.enabled)
                    {
                        debug("'start' step stopped after %d attempts : %s", e.attempts, JSON.stringify(e.error));
                    }
                    self.emit('connectionError', {step:'start',attempts:e.attempts,retry:false,error:e.error});
                });
            }).catch ((e) => {
                if (debug.enabled)
                {
                    debug("'connect' step stopped after %d attempts : %s", e.attempts, JSON.stringify(e.error));
                }
                self.emit('connectionError', {step:'connect',attempts:e.attempts,retry:false,error:e.error});
            });
        }).catch ((e) => {
            if (debug.enabled)
            {
                debug("'negotiate' step stopped after %d attempts : %s", e.attempts, JSON.stringify(e.error));
            }
            self.emit('connectionError', {step:'negotiate',attempts:e.attempts,retry:false,error:e.error});
        });
    });
    return true;
}

/**
 * Cloud Scraper request
 *
 * @param {callback} cb callback to call after cloud scraper request (cb parameter will be null if cloudscraper request was successful)
 */
_cloudScraperRequest(cb)
{
    // we're not supposed to use Cloud Scraper
    if (!this._useCloudScraper)
    {
        cb(null);
        return;
    }
    let self = this;
    // cloud scraper magic
    let headers = _.clone(CLOUD_SCRAPER_HTTP_HEADERS);
    headers['User-Agent'] = this._userAgent;
    cloudScraper.get(CLOUD_SCRAPER_URL, function(error, response, body) {
        // we're fucked
        if (error)
        {
            if (debug.enabled)
            {
                debug("'Cloud Scraper' error : %s", JSON.stringify(error));
            }
            let err;
            if (0 === error.errorType)
            {
                err = {origin:'client', error:error.error.message}
            }
            else
            {
                err = {origin:'remote', error:error}
            }
            cb(err);
            return;
        }
        // save cloud scraper data
        self._cloudScraper = {
            cookie:response.request.headers['cookie'] || '',
        }
        cb(null);
    }, headers);
}

}

module.exports = SignalRConnection;
