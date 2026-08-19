// @ts-nocheck
const http = require('http');

const MAX_JSON_BODY_BYTES = 10 * 1024 * 1024;

function readBody(req, maxBytes = MAX_JSON_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
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

async function readJsonBody(req, maxBytes = MAX_JSON_BODY_BYTES) {
  const raw = (await readBody(req, maxBytes)).toString('utf-8');
  try {
    return raw ? JSON.parse(raw) : {};
  } catch (error) {
    throw new Error(`Invalid JSON body: ${error.message}`);
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function sendRpcError(res, status, id, message, code = -32001) {
  sendJson(res, status, {
    jsonrpc: '2.0',
    id: id == null ? null : id,
    error: {
      code,
      message
    }
  });
}

class A2AHttpServer {
  constructor(manager, options = {}) {
    this.manager = manager;
    this.host = options.host || '127.0.0.1';
    this.port = Number(options.port) || 8789;
    this.server = null;
  }

  getBaseUrl() {
    return `http://${this.host}:${this.port}`;
  }

  async start() {
    if (this.server) {
      return { success: true, host: this.host, port: this.port };
    }

    this.server = http.createServer(async (req, res) => {
      try {
        await this._handleRequest(req, res);
      } catch (error) {
        if (!res.headersSent) {
          sendJson(res, 500, {
            error: {
              code: -32000,
              message: error.message || String(error)
            }
          });
        } else {
          try {
            res.end();
          } catch (_) {}
        }
      }
    });

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => resolve());
    });

    return { success: true, host: this.host, port: this.port };
  }

  async stop() {
    if (!this.server) {
      return { success: true, stopped: false };
    }

    const active = this.server;
    this.server = null;
    await new Promise((resolve) => {
      try {
        active.close(() => resolve());
      } catch (_) {
        resolve();
      }
    });
    return { success: true, stopped: true };
  }

  async _handleRequest(req, res) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url || '/', this.getBaseUrl());

    if (method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, {
        ok: true,
        kind: 'a2a',
        host: this.host,
        port: this.port
      });
      return;
    }

    if (method === 'GET' && url.pathname === '/.well-known/agent-card.json') {
      sendJson(res, 200, this.manager.getAgentCard(this.getBaseUrl()));
      return;
    }

    if (method === 'POST' && url.pathname === '/rpc') {
      const payload = await readJsonBody(req);
      const id = Object.prototype.hasOwnProperty.call(payload || {}, 'id') ? payload.id : null;
      const rpcMethod = String(payload?.method || '').trim();
      if (payload?.jsonrpc !== '2.0' || !rpcMethod) {
        sendRpcError(res, 400, id, 'Invalid JSON-RPC request', -32600);
        return;
      }

      const resolved = typeof this.manager.resolveRpcRequestContext === 'function'
        ? await this.manager.resolveRpcRequestContext({ headers: req.headers || {}, payload })
        : { ok: false, status: 401, error: 'A2A user identity required' };
      if (!resolved?.ok) {
        sendRpcError(res, Number(resolved?.status) || 401, id, resolved?.error || 'Unauthorized');
        return;
      }

      if (rpcMethod === 'message/stream' || rpcMethod === 'tasks/resubscribe') {
        await this.manager.handleRpcStream(payload, req, res, {
          requestContext: resolved.requestContext || null
        });
        return;
      }

      const response = await this.manager.handleRpc(payload, {
        requestContext: resolved.requestContext || null
      });
      sendJson(res, 200, response);
      return;
    }

    sendJson(res, 404, {
      error: {
        code: -32601,
        message: 'Not found'
      }
    });
  }
}

module.exports = A2AHttpServer;
