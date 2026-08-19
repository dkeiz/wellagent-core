// @ts-nocheck
const http = require('http');
const https = require('https');
const zlib = require('zlib');

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_REDIRECTS = 5;

class NativeHeaders {
  constructor(headers = {}) {
    this.values = new Map();
    for (const [name, value] of Object.entries(headers || {})) {
      if (value === undefined) continue;
      this.values.set(String(name).toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value));
    }
  }

  get(name) {
    return this.values.get(String(name || '').toLowerCase()) || null;
  }

  has(name) {
    return this.values.has(String(name || '').toLowerCase());
  }

  entries() {
    return this.values.entries();
  }

  toJSON() {
    return Object.fromEntries(this.values.entries());
  }
}

class NativeHttpError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = options.name || 'NativeHttpError';
    this.code = options.code || 'NATIVE_HTTP_ERROR';
    this.status = options.status || null;
    this.response = options.response || null;
    this.cause = options.cause;
  }
}

function normalizeBody(data, headers) {
  if (data === undefined || data === null) return null;
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === 'string' || data instanceof Uint8Array) return Buffer.from(data);
  if (data instanceof URLSearchParams) {
    if (!headers['content-type']) headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
    return Buffer.from(data.toString());
  }
  if (!headers['content-type']) headers['content-type'] = 'application/json';
  return Buffer.from(JSON.stringify(data));
}

function decodedStream(response) {
  const encoding = String(response.headers['content-encoding'] || '').toLowerCase();
  if (encoding === 'gzip') return response.pipe(zlib.createGunzip());
  if (encoding === 'deflate') return response.pipe(zlib.createInflate());
  if (encoding === 'br') return response.pipe(zlib.createBrotliDecompress());
  return response;
}

function collectStream(stream, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on('data', chunk => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) {
        stream.destroy(new NativeHttpError(`Response exceeded ${maxBytes} bytes`, { code: 'RESPONSE_TOO_LARGE' }));
        return;
      }
      chunks.push(buffer);
    });
    stream.once('end', () => resolve(Buffer.concat(chunks)));
    stream.once('error', reject);
  });
}

function parseResponseData(buffer, responseType, contentType) {
  if (responseType === 'arraybuffer' || responseType === 'buffer') return buffer;
  const text = buffer.toString('utf8');
  if (responseType === 'text') return text;
  if (responseType === 'json' || /(^|\b|\+)json\b/i.test(contentType || '')) {
    if (!text.trim()) return null;
    try { return JSON.parse(text); } catch (_) { return text; }
  }
  if (!text.trim()) return '';
  try { return JSON.parse(text); } catch (_) { return text; }
}

function abortError(message = 'Request canceled') {
  return new NativeHttpError(message, { name: 'AbortError', code: 'ERR_CANCELED' });
}

function requestOnce(config, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(String(config.url || ''));
    } catch (error) {
      reject(new NativeHttpError('Invalid request URL', { code: 'INVALID_URL', cause: error }));
      return;
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      reject(new NativeHttpError(`Unsupported protocol: ${url.protocol}`, { code: 'UNSUPPORTED_PROTOCOL' }));
      return;
    }

    const headers = {};
    for (const [name, value] of Object.entries(config.headers || {})) {
      if (value !== undefined && value !== null) headers[String(name).toLowerCase()] = String(value);
    }
    if (!headers.accept) headers.accept = 'application/json, text/plain, */*';
    if (!headers['accept-encoding']) headers['accept-encoding'] = 'gzip, deflate, br';
    const body = normalizeBody(config.data ?? config.body, headers);
    if (body && !headers['content-length']) headers['content-length'] = String(body.length);
    const requestedTimeout = config.timeout === undefined || config.timeout === null
      ? DEFAULT_TIMEOUT_MS
      : Number(config.timeout);
    const timeoutMs = Number.isFinite(requestedTimeout) ? Math.max(0, requestedTimeout) : DEFAULT_TIMEOUT_MS;
    const transport = url.protocol === 'https:' ? https : http;
    let settled = false;
    let timer = null;

    const finishReject = error => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    };
    const finishResolve = value => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };

    const request = transport.request(url, {
      method: String(config.method || 'GET').toUpperCase(),
      headers,
      agent: config.agent,
      rejectUnauthorized: config.rejectUnauthorized !== false
    }, async response => {
      const status = Number(response.statusCode || 0);
      const responseHeaders = new NativeHeaders(response.headers);
      const location = responseHeaders.get('location');
      const maxRedirects = Number.isFinite(Number(config.maxRedirects)) ? Number(config.maxRedirects) : DEFAULT_REDIRECTS;
      if (status >= 300 && status < 400 && location && config.redirect !== 'manual') {
        response.resume();
        if (redirectCount >= maxRedirects) {
          finishReject(new NativeHttpError(`Too many redirects (${maxRedirects})`, { code: 'TOO_MANY_REDIRECTS', status }));
          return;
        }
        const nextUrl = new URL(location, url).toString();
        const nextConfig = { ...config, url: nextUrl, headers: { ...(config.headers || {}) } };
        if (new URL(nextUrl).origin !== url.origin) {
          delete nextConfig.headers.Authorization;
          delete nextConfig.headers.authorization;
        }
        if ([301, 302, 303].includes(status) && String(config.method || 'GET').toUpperCase() !== 'GET') {
          nextConfig.method = 'GET';
          delete nextConfig.data;
          delete nextConfig.body;
        }
        try {
          finishResolve(await requestOnce(nextConfig, redirectCount + 1));
        } catch (error) {
          finishReject(error);
        }
        return;
      }

      const stream = decodedStream(response);
      const base = {
        status,
        statusText: response.statusMessage || '',
        headers: responseHeaders,
        requestUrl: url.toString(),
        data: null
      };
      if (config.responseType === 'stream') {
        const validateStatus = typeof config.validateStatus === 'function'
          ? config.validateStatus
          : value => value >= 200 && value < 300;
        if (!validateStatus(status)) {
          try {
            const buffer = await collectStream(stream, Math.max(1, Number(config.maxBytes || DEFAULT_MAX_BYTES)));
            base.data = parseResponseData(buffer, 'json', responseHeaders.get('content-type'));
          } catch (error) {
            finishReject(error);
            return;
          }
          finishReject(new NativeHttpError(
            base.data?.error?.message || base.data?.message || ('HTTP ' + status),
            { code: 'HTTP_ERROR', status, response: base }
          ));
          return;
        }
        base.data = stream;
        finishResolve(base);
        return;
      }
      try {
        const buffer = await collectStream(stream, Math.max(1, Number(config.maxBytes || DEFAULT_MAX_BYTES)));
        base.data = parseResponseData(buffer, config.responseType, responseHeaders.get('content-type'));
        const validateStatus = typeof config.validateStatus === 'function'
          ? config.validateStatus
          : value => value >= 200 && value < 300;
        if (!validateStatus(status)) {
          finishReject(new NativeHttpError(`HTTP ${status}`, {
            code: 'HTTP_ERROR', status, response: base
          }));
          return;
        }
        finishResolve(base);
      } catch (error) {
        finishReject(error);
      }
    });

    request.once('error', error => {
      if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
        finishReject(abortError());
      } else {
        finishReject(new NativeHttpError(error.message || 'Network request failed', {
          code: error.code || 'NETWORK_ERROR', cause: error
        }));
      }
    });
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        const error = new NativeHttpError(`Request timed out after ${timeoutMs}ms`, { code: 'ETIMEDOUT' });
        request.destroy(error);
        finishReject(error);
      }, timeoutMs);
    }

    const signal = config.signal;
    const onAbort = () => {
      const error = abortError();
      request.destroy(error);
      finishReject(error);
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      request.once('close', () => signal.removeEventListener('abort', onAbort));
    }
    if (body) request.write(body);
    request.end();
  });
}

async function nativeHttpRequest(config = {}) {
  return requestOnce(config, 0);
}

module.exports = {
  NativeHeaders,
  NativeHttpError,
  nativeHttpRequest
};
