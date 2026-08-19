// @ts-nocheck
const http = require('http');
const https = require('https');

function normalizeOptionalString(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function chooseTransport(url) {
  return url.protocol === 'https:' ? https : http;
}

function requestJson(method, inputUrl, body = null, options = {}) {
  const target = typeof inputUrl === 'string' ? new URL(inputUrl) : inputUrl;
  const transport = chooseTransport(target);
  const payload = body == null ? null : JSON.stringify(body);
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 15000);
  const headers = {
    Accept: 'application/json',
    ...(payload ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
    ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
    ...(options.headers || {})
  };

  return new Promise((resolve, reject) => {
    const req = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch (_error) {
          parsed = null;
        }
        if (res.statusCode >= 400) {
          const message = parsed?.error || parsed?.message || `Request failed with status ${res.statusCode}`;
          const error = new Error(message);
          error.statusCode = res.statusCode;
          error.payload = parsed;
          reject(error);
          return;
        }
        resolve(parsed);
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function buildControlHeaders(authToken, extraHeaders = {}) {
  const token = normalizeOptionalString(authToken);
  return {
    ...(token ? { 'x-localagent-control-token': token } : {}),
    ...extraHeaders
  };
}

async function invokeControl(baseUrl, authToken, channel, args = [], options = {}) {
  const url = new URL('/invoke', String(baseUrl));
  const result = await requestJson('POST', url, {
    channel,
    args,
    requestContext: options.requestContext || null,
    requestId: options.requestId || null
  }, {
    headers: buildControlHeaders(authToken, options.headers),
    timeoutMs: options.timeoutMs
  });
  if (result?.success === false) {
    throw new Error(result.error || `Control invocation failed: ${channel}`);
  }
  return result?.result;
}

async function getHealth(baseUrl, authToken, options = {}) {
  const url = new URL('/health', String(baseUrl));
  return requestJson('GET', url, null, {
    headers: buildControlHeaders(authToken, options.headers),
    timeoutMs: options.timeoutMs
  });
}

async function shutdown(baseUrl, authToken, options = {}) {
  const url = new URL('/shutdown', String(baseUrl));
  return requestJson('POST', url, {
    requestContext: options.requestContext || null
  }, {
    headers: buildControlHeaders(authToken, options.headers),
    timeoutMs: options.timeoutMs
  });
}

module.exports = {
  getHealth,
  invokeControl,
  shutdown
};

export {};

