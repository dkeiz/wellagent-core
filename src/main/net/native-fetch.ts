// @ts-nocheck
const { nativeHttpRequest } = require('./native-http-client');

function createNativeResponse(response) {
  const buffer = Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data || '');
  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    url: response.requestUrl,
    async text() { return buffer.toString('utf8'); },
    async json() { return JSON.parse(buffer.toString('utf8')); },
    async arrayBuffer() { return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength); },
    async buffer() { return Buffer.from(buffer); }
  };
}

async function nativeFetch(url, options = {}) {
  const response = await nativeHttpRequest({
    url,
    method: options.method || 'GET',
    headers: options.headers || {},
    body: options.body,
    signal: options.signal,
    timeout: options.timeout,
    maxBytes: options.size,
    redirect: options.redirect,
    maxRedirects: options.follow,
    responseType: 'buffer',
    validateStatus: () => true
  });
  return createNativeResponse(response);
}

module.exports = { createNativeResponse, nativeFetch };
