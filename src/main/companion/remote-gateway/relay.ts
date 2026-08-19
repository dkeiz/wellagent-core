// @ts-nocheck
const crypto = require('crypto');

function acceptWebSocket(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return null;
  }
  const accept = crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-5AB5DC11E548')
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  return socket;
}

function wsFrameText(text) {
  const data = Buffer.from(text, 'utf-8');
  const len = data.length;
  let header = null;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

function wsDecodeFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0F;
  const masked = (buffer[1] & 0x80) !== 0;
  let payloadLen = buffer[1] & 0x7F;
  let offset = 2;
  if (payloadLen === 126) {
    if (buffer.length < 4) return null;
    payloadLen = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buffer.length < 10) return null;
    payloadLen = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  let mask = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.slice(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + payloadLen) return null;
  const payload = buffer.slice(offset, offset + payloadLen);
  if (mask) {
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
  }
  return { opcode, payload, totalLength: offset + payloadLen };
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body || {});
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text)
  });
  res.end(text);
}

class RelayHub {
  constructor(options = {}) {
    this.maxBodyBytes = options.maxBodyBytes || 10 * 1024 * 1024;
    this.hostSocket = null;
    this.hostBuffer = Buffer.alloc(0);
    this.pending = new Map();
    this.clients = new Map();
    this.clientBuffers = new Map();
  }

  getStatus() {
    return {
      ok: true,
      hostConnected: Boolean(this.hostSocket),
      pendingRequests: this.pending.size,
      connectedClients: this.clients.size
    };
  }

  attachHost(req, socket) {
    const ws = acceptWebSocket(req, socket);
    if (!ws) return;
    const previousHost = this.hostSocket;
    if (previousHost) {
      this._failPending(503, 'Desktop host reconnected');
      this._closeAllClients();
      try { this.hostSocket.destroy(); } catch (_) {}
    }
    this.hostSocket = ws;
    this.hostBuffer = Buffer.alloc(0);
    ws.on('data', chunk => this._onHostData(ws, chunk));
    ws.on('close', () => this._dropHost(ws));
    ws.on('error', () => this._dropHost(ws));
  }

  attachClient(req, socket) {
    if (!this.hostSocket) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }
    const ws = acceptWebSocket(req, socket);
    if (!ws) return;
    const connectionId = crypto.randomUUID();
    this.clients.set(connectionId, ws);
    this.clientBuffers.set(connectionId, Buffer.alloc(0));
    this._sendHost({
      type: 'ws-open',
      connectionId,
      path: req.url,
      headers: req.headers
    });
    ws.on('data', chunk => this._onClientData(connectionId, chunk));
    ws.on('close', () => this._closeClient(connectionId));
    ws.on('error', () => this._closeClient(connectionId));
  }

  async forwardHttp(req, res, body) {
    if (!this.hostSocket) {
      sendJson(res, 503, { success: false, error: 'Desktop host is not connected to this gateway' });
      return;
    }
    const requestId = crypto.randomUUID();
    const timeout = setTimeout(() => {
      this.pending.delete(requestId);
      sendJson(res, 504, { success: false, error: 'Gateway request timed out' });
    }, 120000);
    this.pending.set(requestId, { res, timeout });
    this._sendHost({
      type: 'http-request',
      requestId,
      method: req.method,
      path: req.url,
      headers: req.headers,
      bodyBase64: body?.length ? body.toString('base64') : ''
    });
  }

  _onHostData(ws, chunk) {
    if (this.hostSocket !== ws) return;
    this.hostBuffer = Buffer.concat([this.hostBuffer, chunk]);
    while (this.hostBuffer.length > 0) {
      const frame = wsDecodeFrame(this.hostBuffer);
      if (!frame) break;
      this.hostBuffer = this.hostBuffer.slice(frame.totalLength);
      if (frame.opcode === 0x08) {
        this._dropHost(ws);
        return;
      }
      if (frame.opcode !== 0x01) continue;
      try { this._handleHostFrame(JSON.parse(frame.payload.toString('utf-8'))); }
      catch (_) {}
    }
  }

  _onClientData(connectionId, chunk) {
    const client = this.clients.get(connectionId);
    if (!client) return;
    const existing = this.clientBuffers.get(connectionId) || Buffer.alloc(0);
    let buffer = Buffer.concat([existing, chunk]);
    while (buffer.length > 0) {
      const frame = wsDecodeFrame(buffer);
      if (!frame) break;
      buffer = buffer.slice(frame.totalLength);
      if (frame.opcode === 0x08) {
        this._closeClient(connectionId);
        this.clientBuffers.delete(connectionId);
        return;
      }
      if (frame.opcode === 0x09) {
        try { client.write(Buffer.from([0x8A, 0])); } catch (_) {}
        continue;
      }
      if (frame.opcode !== 0x01) continue;
      const text = frame.payload.toString('utf-8');
      let payload = text;
      try { payload = JSON.parse(text); } catch (_) {}
      this._sendHost({ type: 'ws-message', connectionId, payload });
    }
    this.clientBuffers.set(connectionId, buffer);
  }

  _handleHostFrame(frame) {
    if (frame.type === 'ping') {
      this._sendHost({ type: 'pong', connectedClients: this.clients.size });
      return;
    }
    if (frame.type === 'http-response') {
      const pending = this.pending.get(frame.requestId);
      if (!pending) return;
      this.pending.delete(frame.requestId);
      clearTimeout(pending.timeout);
      const payload = frame.bodyBase64
        ? Buffer.from(String(frame.bodyBase64), 'base64')
        : Buffer.from(JSON.stringify(frame.body || {}));
      pending.res.writeHead(Number(frame.status) || 200, {
        'content-type': frame.bodyBase64 ? 'application/octet-stream' : 'application/json; charset=utf-8',
        ...(frame.headers || {}),
        'content-length': payload.length
      });
      pending.res.end(payload);
      return;
    }
    if (frame.type === 'ws-message') {
      const client = this.clients.get(frame.connectionId);
      if (client) client.write(wsFrameText(JSON.stringify(frame.payload || {})));
      return;
    }
    if (frame.type === 'ws-accepted') return;
    if (frame.type === 'ws-close') {
      this._closeClient(frame.connectionId, { notifyHost: false });
      return;
    }
    if (frame.type === 'ws-rejected') this._closeClient(frame.connectionId);
  }

  _sendHost(payload) {
    try { this.hostSocket?.write(wsFrameText(JSON.stringify(payload))); }
    catch (_) { this._dropHost(); }
  }

  _dropHost(ws = null) {
    if (ws && this.hostSocket !== ws) return;
    this.hostSocket = null;
    this._failPending(503, 'Desktop host disconnected');
    this._closeAllClients();
  }

  _failPending(status, message) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      sendJson(pending.res, status, { success: false, error: message });
    }
    this.pending.clear();
  }

  _closeAllClients() {
    for (const id of Array.from(this.clients.keys())) {
      this._closeClient(id, { notifyHost: false });
    }
  }

  _closeClient(connectionId, options = {}) {
    const client = this.clients.get(connectionId);
    if (client) {
      try { client.destroy(); } catch (_) {}
    }
    this.clients.delete(connectionId);
    this.clientBuffers.delete(connectionId);
    if (options.notifyHost !== false) {
      this._sendHost({ type: 'ws-close', connectionId });
    }
  }
}

module.exports = { RelayHub, sendJson };
