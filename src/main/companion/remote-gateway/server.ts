// @ts-nocheck
const http = require('http');
const { URL } = require('url');
const { isAuthorized } = require('./auth');
const { loadConfig } = require('./config');
const { RelayHub, sendJson } = require('./relay');
const { RateLimiter } = require('../companion-server-core');

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function createServer(config = loadConfig()) {
  const hub = new RelayHub({ maxBodyBytes: config.maxBodyBytes });
  const pairLimiter = new RateLimiter(15 * 60 * 1000, 20);
  const authLimiter = new RateLimiter(15 * 60 * 1000, 40);
  const hostAuthLimiter = new RateLimiter(15 * 60 * 1000, 20);

  function clientIp(req) {
    return String(req.socket?.remoteAddress || 'anonymous');
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/gateway/health') {
      sendJson(res, 200, hub.getStatus());
      return;
    }
    const isCompanionRoute = url.pathname === '/'
      || url.pathname === '/companion'
      || url.pathname.startsWith('/companion/');
    if (!isCompanionRoute) {
      sendJson(res, 404, { success: false, error: 'Not found' });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/companion/pair' && !pairLimiter.check(clientIp(req))) {
      sendJson(res, 429, { success: false, error: 'Too many pairing attempts' });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/companion/auth' && !authLimiter.check(clientIp(req))) {
      sendJson(res, 429, { success: false, error: 'Too many authentication attempts' });
      return;
    }
    try {
      const body = ['POST', 'PUT', 'PATCH'].includes(String(req.method || '').toUpperCase())
        ? await readBody(req, config.maxBodyBytes)
        : Buffer.alloc(0);
      await hub.forwardHttp(req, res, body);
    } catch (error) {
      sendJson(res, 400, { success: false, error: error.message });
    }
  });

  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/gateway/host') {
      if (!hostAuthLimiter.check(clientIp(req))) {
        socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
        socket.destroy();
        return;
      }
      if (!isAuthorized(req, url, config.secret)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      hub.attachHost(req, socket);
      return;
    }
    if (url.pathname === '/companion/ws') {
      hub.attachClient(req, socket);
      return;
    }
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  });

  server.relayHub = hub;
  return server;
}

if (require.main === module) {
  const config = loadConfig();
  if (!config.secret) {
    console.error('REMOTE_GATEWAY_SECRET is required');
    process.exit(1);
  }
  createServer(config).listen(config.port, config.host, () => {
    console.log(`[RemoteGateway] listening on ${config.host}:${config.port}`);
  });
}

module.exports = { createServer };
