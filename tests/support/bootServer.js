'use strict';
// ---------------------------------------------------------------------------
// Boots the REAL, unmodified server.js against the in-memory Mongo stub
// (tests/support/fakeMongo.js), by intercepting require('mongodb') at the
// Node module-loader level — server.js itself is never edited or forked for
// testing purposes. Exports a `start()` you can await in a test file.
// ---------------------------------------------------------------------------
const path = require('path');
const Module = require('module');
const http = require('http');

function start({ port }) {
  delete process.env.SUPABASE_DB_URL;
  process.env.PORT = String(port);
  process.env.NODE_ENV = process.env.NODE_ENV || 'test';
  process.env.SUPER_ADMIN_USERNAME = process.env.SUPER_ADMIN_USERNAME || 'testowner';
  process.env.SUPER_ADMIN_PASSWORD = process.env.SUPER_ADMIN_PASSWORD || 'TestOwnerPassword123!';
  process.env.MONGODB_URI = 'mongodb://fake-for-tests';
  process.env.VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
  process.env.VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';

  const fakeMongo = require('./fakeMongo');
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'mongodb') return fakeMongo;
    return originalLoad.apply(this, arguments);
  };

  const serverPath = path.join(__dirname, '..', '..', 'server.js');
  delete require.cache[require.resolve(serverPath)];
  require(serverPath); // side-effecting: this runs main() and starts listening

  Module._load = originalLoad; // only needed during server.js's own require chain

  // server.js has no exported "ready" signal, so poll the port until the
  // HTTP server actually accepts connections instead of guessing a fixed delay.
  return waitForPort(port, 15000);
}

function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function attempt() {
      const req = http.get({ host: 'localhost', port, path: '/api/public/stats', timeout: 1000 }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) return reject(new Error(`Server did not start listening on port ${port} within ${timeoutMs}ms`));
        setTimeout(attempt, 150);
      });
      req.on('timeout', () => req.destroy());
    })();
  });
}

module.exports = { start };
