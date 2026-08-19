// @ts-nocheck
const crypto = require('crypto');

const MAX_BODY_BYTES = 10 * 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 30_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 120;

function readBody(req, maxBytes = MAX_BODY_BYTES) {
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

async function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  const raw = (await readBody(req, maxBytes)).toString('utf-8');
  try {
    return raw ? JSON.parse(raw) : {};
  } catch (error) {
    throw new Error(`Invalid JSON: ${error.message}`);
  }
}

function getSourceHeaders(source) {
  return source?.headers || source?._companionRequest?.headers || {};
}

function splitHostPort(value) {
  const raw = String(value || '').trim();
  if (!raw) return { hostname: '', port: '' };
  try {
    const parsed = new URL(`http://${raw}`);
    return { hostname: parsed.hostname.toLowerCase(), port: parsed.port || '' };
  } catch (_) {
    const bracketMatch = /^\[([^\]]+)\](?::(\d+))?$/.exec(raw);
    if (bracketMatch) {
      return { hostname: bracketMatch[1].toLowerCase(), port: bracketMatch[2] || '' };
    }
    const parts = raw.split(':');
    return {
      hostname: String(parts[0] || '').toLowerCase(),
      port: parts.length > 1 ? String(parts[parts.length - 1] || '') : ''
    };
  }
}

function getAllowedCorsOrigin(source = null) {
  const headers = getSourceHeaders(source);
  const origin = String(headers.origin || '').trim();
  if (!origin || origin === 'null') return null;

  const configuredOrigins = String(process.env.LOCALAGENT_COMPANION_ALLOWED_ORIGINS || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
  if (configuredOrigins.includes(origin)) return origin;

  try {
    const parsedOrigin = new URL(origin);
    const requestHost = splitHostPort(headers.host);
    const originPort = parsedOrigin.port || (parsedOrigin.protocol === 'https:' ? '443' : '80');
    const requestDefaultPort = source?.socket?.encrypted ? '443' : '80';
    const hostPort = requestHost.port || requestDefaultPort;
    if (
      requestHost.hostname
      && parsedOrigin.hostname.toLowerCase() === requestHost.hostname
      && originPort === hostPort
    ) {
      return origin;
    }
  } catch (_) {
    return null;
  }
  return null;
}

function withCorsHeaders(source = null, headers = {}) {
  const next = { ...headers };
  delete next['Access-Control-Allow-Origin'];
  delete next['access-control-allow-origin'];
  const origin = getAllowedCorsOrigin(source);
  if (origin) {
    next['Access-Control-Allow-Origin'] = origin;
    next.Vary = next.Vary ? `${next.Vary}, Origin` : 'Origin';
  }
  return next;
}

function sendJson(res, status, payload, source = null) {
  const body = JSON.stringify(payload);
  res.writeHead(status, withCorsHeaders(source || res, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  }));
  res.end(body);
}

function sendCors(res, source = null) {
  res.writeHead(204, withCorsHeaders(source || res, {
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400'
  }));
  res.end();
}

function parseBooleanParam(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

class RateLimiter {
  constructor(windowMs = RATE_LIMIT_WINDOW_MS, max = RATE_LIMIT_MAX) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map();
  }

  check(key) {
    const now = Date.now();
    const window = this.hits.get(key) || [];
    const valid = window.filter(time => now - time < this.windowMs);
    if (valid.length >= this.max) return false;
    valid.push(now);
    this.hits.set(key, valid);
    return true;
  }
}

function acceptWebSocket(req, socket) {
  const key = String(req.headers['sec-websocket-key'] || '').trim();
  if (!key) {
    socket.destroy();
    return null;
  }

  const accept = crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-5AB5DC11E548')
    .digest('base64');

  socket.setNoDelay(true);
  if (typeof socket.setKeepAlive === 'function') socket.setKeepAlive(true, 30_000);
  socket.write(Buffer.from(
    'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n`
      + 'Sec-WebSocket-Version: 13\r\n'
      + '\r\n',
    'utf-8'
  ));
  return socket;
}

function wsFrameText(text) {
  const data = Buffer.from(text, 'utf-8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = len;
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
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }
  }
  return { opcode, payload, totalLength: offset + payloadLen };
}

module.exports = {
  HEARTBEAT_INTERVAL_MS,
  MAX_BODY_BYTES,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
  RateLimiter,
  acceptWebSocket,
  parseBooleanParam,
  readBody,
  readJsonBody,
  getAllowedCorsOrigin,
  sendCors,
  sendJson,
  withCorsHeaders,
  wsDecodeFrame,
  wsFrameText
};
