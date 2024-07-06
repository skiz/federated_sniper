const { promisify } = require("util");
const WebSocket = require('ws');
var http = require('http');
const url = require('url');
var targets = require('./targets.json');
let redis = require('redis');
const { createVerify } = require('crypto');
const { resourceUsage } = require("process");
var port = 4200;
const DUPE_IGNORE_SECONDS = 60;

var rc = redis.createClient({
    port: 6379,
    host: '127.0.0.1',
});
rc.on('error', err => {
    console.log(`Redis Error: ${err}`);
})

function makeKey(length) {
    var result = '';
    var characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    var charactersLength = characters.length;
    for (var i = 0; i < length; i++) {
        result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return result;
}

function revokeKey(key, cb) {
    rc.ltrim(`key:${key}:pools`, 0, -1, function (err, obj) {
        cb(err, obj);
    });
}

function getKeyPoolIds(key, cb) {
    rc.smembers(`key:${key}:pools`, function (err, obj) {
        cb(err, obj);
    });
}

function addKeyPools(key, pools, cb) {
    rc.sadd([`key:${key}:pools`, ...pools], function (err, obj) {
        cb(err, obj);
    });
}

function getPoolMeta(poolIds, cb) {
    let multi = rc.multi();
    for (i in poolIds) {
        multi.hgetall(`pools:${poolIds[i]}:meta`);
    }
    multi.exec(function (err, replies) {
        cb(err, replies);
    });
}

function getTempIgnore(poolId, identifier, cb) {
    rc.hget(`pools:${poolId}:${identifier}`, 'ignore', function (err, obj) {
        if (err) {
            cb(err, null);
        } else {
            cb(null, obj);
        }
    });
}

function setTempIgnore(poolId, identifier, seconds, cb) {
    let k = `pools:${poolId}:${identifier}`;
    rc.hset(k, "ignore", true, function (err, obj) {
        if (err) {
            cb(err, null)
        } else {
            rc.expire(k, seconds, function (err, obj) {
                cb(err, obj);
            });
        }
    });
}

function getPoolTargets(poolId, cb) {
    rc.smembers(`pools:${poolId}:targets`, function (err, target_ids) {
        if (err) {
            return cb(err, null);
        } else {
            let multi = rc.multi();
            for (i in target_ids) {
                multi.hgetall(`targets:${target_ids[i]}`);
            }
            multi.exec(function (err, replies) {
                cb(err, replies);
            });
        }
    });
}

function getPoolTarget(poolId, identifier, cb) {
    rc.smembers(`pools:${poolId}:targets`, function (err, target_ids) {
        if (err) {
            return cb(err, null);
        } else {
            for (i in target_ids) {
                if (target_ids[i] == identifier) {
                    // TODO: check ignore
                    rc.hgetall(`targets:${target_ids[i]}`, function (err, target) {
                        return cb(err, target);
                    });
                }
            }
        }
    });
}

function notAuthorized(res) {
    res.writeHead(401);
    res.end("Not authorized");
}

function authHeaderKey(req) {
    if (!req.headers.authorization) {
        return;
    }
    let check = (req.headers.authorization).match(/Bearer ([a-zA-z0-9]+)/);
    if (check.length != 2) {
        return;
    }
    return check[1];
}

function handleRequest(context, req, res) {
    if (req.url == '/api/pools.json') {
        getPoolMeta(context.poolIds, function (err, data) {
            if (err) {
                res.writeHead(500, "PEBKAC");
                res.end();
                return;
            }
            res.writeHead(200, { 'Content-type': 'application/json' });
            res.write(JSON.stringify(data));
            res.end();
        })
    }
    else if (req.url.startsWith('/api/targets.json')) {
        const q = url.parse(req.url, true).query;
        if (!q.pool_id || context.poolIds.indexOf(q.pool_id) == -1) {
            notAuthorized(res);
            return;
        }
        getPoolTargets(q.pool_id, function (err, targets) {
            if (err) {
                res.writeHead(500, "PEBKAC");
                res.end();
                return;
            }
            res.writeHead(200, { 'Content-type': 'application/json' });
            res.write(JSON.stringify(targets));
            res.end();
        });
    } else {
        res.writeHead(404);
        res.end('Invalid Request!');
    }
}

var server = http.createServer(function (req, res) {
    let key = authHeaderKey(req);
    if (!key) {
        notAuthorized(res);
        return;
    }

    getKeyPoolIds(key, function (err, obj) {
        if (err || obj.length == 0) {
            notAuthorized(res);
            return;
        }
        handleRequest({
            key: key,
            poolIds: obj
        }, req, res);
    });
});

server.listen(port, function () {
    console.log("webserver running...");
});

wss = new WebSocket.Server({
    server: server,
    autoAcceptConnections: true
});

var connections = new Map();
var idCounter = 0;

wss.on('connection', function (ws) {
    let connId = idCounter++;
    connections.set(connId, { session: ws, pool: null });
    let session = connections.get(connId);

    ws.on('message', function (message) {
        try {
            msg = JSON.parse(message);
        } catch (err) {
            ws.send('{"error":"PEKAC"}');
            return;
        }

        if (!session.pool) {
            if (msg.key && msg.pool) {
                getKeyPoolIds(msg.key, function (err, obj) {
                    if (err || obj.length == 0 || obj.indexOf(msg.pool) == -1) {
                        ws.send('{"error":"pool not authorized"}');
                    } else {
                        session.pool = msg.pool;
                        let pool_size = connections.keys.length + 1;
                        ws.send(`{"pool":"joined","size":${pool_size}}`);
                    }
                });
            } else {
                ws.send('{"error":"not authorized"}');
            }
            return;
        }

        if (msg.ping != undefined) {
            ws.send(`{"pong":"${msg.ping}"}`);
            return;
        }

        if (typeof msg.price === "number" && msg.identifier && msg.pool) {
            getPoolTarget(msg.pool, msg.identifier, function (err, target) {
                if (err) {
                    console.log("bad target");
                    return;
                }
                if (msg.price > 0 && msg.price <= target.max_price) {
                    getTempIgnore(msg.pool, msg.identifier, function (err, ignored) {
                        if (!ignored) {
                            setTempIgnore(msg.pool, msg.identifier, DUPE_IGNORE_SECONDS, function (err, obj) {
                                if (err) {
                                    console.log("unable to set ignore", err);
                                } else {
                                    connections.forEach(function (conn, k) {
                                        if (k != connId && conn.pool == msg.pool) {
                                            console.log("sending to ", k);
                                            conn.session.send(JSON.stringify(msg));
                                        } else {
                                            console.log("not sending to ", k);
                                        }
                                    });
                                }
                            });
                        } else {
                            console.log("ignoring ", msg);
                        }
                    });
                } else {
                    console.log("bad price");
                    return;
                }
            });
            return;
        }

        console.log("unhandled message: ", msg);
    });

    ws.on('close', function (reasonCode, description) {
        connections.delete(connId);
    })
});