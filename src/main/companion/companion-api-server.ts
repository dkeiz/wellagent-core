// @ts-nocheck
/**
 * Companion HTTP transport.
 * This class owns sockets, static files, WebSocket framing, and body parsing.
 * Backend decisions are delegated through setDispatch().
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const {
  HEARTBEAT_INTERVAL_MS,
  MAX_BODY_BYTES,
  acceptWebSocket,
  parseBooleanParam,
  readBody,
  readJsonBody,
  sendCors,
  sendJson,
  withCorsHeaders,
  wsDecodeFrame,
  wsFrameText
} = require('./companion-server-core');
const { getArtifactContentType, getClientFacingBaseUrl } = require('./companion-http-utils');
const { readAndCastCompanionSkin } = require('./companion-skin-caster');
const { buildNativeCompanionUrl } = require('../companion-network-utils');
const { resolveProjectRoot } = require('../runtime-root');
const {
  resolveCompanionBootstrapFile,
  resolveCompanionSkinFile,
  resolveCompanionWebFile
} = require('./companion-web-static');
const { getCompanionUiState } = require('./companion-ui-state');
const { COMPANION_RELAY_CHANNELS } = require('./companion-relay-channels');

const REPO_ROOT = resolveProjectRoot(__dirname);

function readJsonFile(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function readAndroidBuildMetadata(apkPath) {
  const candidates = [
    `${apkPath}.metadata.json`,
    path.join(path.dirname(apkPath), 'android-app-metadata.json'),
    path.join(path.dirname(apkPath), 'output-metadata.json'),
    path.join(REPO_ROOT, 'mobile', 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'output-metadata.json')
  ];
  for (const candidate of candidates) {
    const parsed = readJsonFile(candidate);
    const first = Array.isArray(parsed?.elements) ? parsed.elements[0] : parsed;
    if (first && (first.versionCode || first.versionName)) {
      return {
        versionCode: Number(first.versionCode || 0) || 0,
        versionName: String(first.versionName || '').trim(),
        sha256: String(first.sha256 || '').trim().toLowerCase()
      };
    }
  }
  return { versionCode: 0, versionName: '', sha256: '' };
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function findAndroidApk() {
  const dirs = [
    path.join(REPO_ROOT, 'releases', 'android'),
    path.join(REPO_ROOT, 'mobile', 'dist'),
    path.join(REPO_ROOT, 'dist', 'android'),
    path.join(REPO_ROOT, 'dist')
  ];
  const files = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.toLowerCase().endsWith('.apk')) continue;
      const absolutePath = path.join(dir, entry);
      const stat = fs.statSync(absolutePath);
      if (stat.isFile()) {
        const metadata = readAndroidBuildMetadata(absolutePath);
        files.push({
          absolutePath,
          fileName: entry,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          versionCode: metadata.versionCode,
          versionName: metadata.versionName,
          sha256: metadata.sha256
        });
      }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files[0] || null;
}

class CompanionApiServer {
  constructor(options = {}) {
    this.host = options.host || '0.0.0.0';
    this.port = Number(options.port) || 8790;
    this.tlsManager = options.tlsManager || null;
    this.server = null;
    this._httpServer = null;
    this.secureServer = null;
    this.tlsState = null;
    this.lastTlsError = '';
    this._startedAt = null;
    this._uiStateDb = options.uiStateDb || null;

    /** @type {Map<string, import('net').Socket>} */
    this._wsClients = new Map();
    this._remoteWsClients = new Map();
    this._remoteGatewayManager = null;
    this._heartbeatTimer = null;

    /** @type {function} — single backend entrypoint */
    this._dispatch = null;
  }

  /**
   * Set the backend dispatch function.
   * Called by bootstrap: (method, path, body, headers, token, socketInfo) => Promise<result>
   */
  setDispatch(fn) {
    this._dispatch = fn;
  }

  setUiStateDb(db) {
    this._uiStateDb = db || null;
  }

  setRemoteGatewayManager(manager) {
    this._remoteGatewayManager = manager || null;
  }

  getBaseUrl(useTls = false) {
    return `${useTls ? 'https' : 'http'}://${this.host}:${this.port}`;
  }

  async refreshTlsState() {
    if (!this.tlsManager?.getStatus) {
      this.tlsState = { enabled: false, supported: false, ready: false, securePort: 0, setupRequired: false, warning: '', error: '' };
      return this.tlsState;
    }
    this.tlsState = await this.tlsManager.getStatus({ bindHost: this.host, httpPort: this.port });
    return this.tlsState;
  }

  _extractAuthToken(req) {
    const header = req.headers?.authorization || '';
    if (header.startsWith('Bearer ')) return header.slice(7).trim();
    return null;
  }

  _isTlsConnection(req) { return Boolean(req.socket?.encrypted); }

  _getRequestHostname(req) {
    const hostHeader = String(req?.headers?.host || '').trim();
    if (!hostHeader) return this.host;
    try { return new URL(`http://${hostHeader}`).hostname || this.host; }
    catch (_) {
      const bracketMatch = /^\[([^\]]+)\]/.exec(hostHeader);
      if (bracketMatch?.[1]) return bracketMatch[1];
      return hostHeader.split(':')[0].trim() || this.host;
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start() {
    if (this.server) return { success: true, host: this.host, port: this.port };
    const tlsState = await this.refreshTlsState();
    const httpsOptions = tlsState.enabled && tlsState.ready ? (this.tlsManager?.getHttpsOptions?.() || null) : null;
    const requestHandler = this._createRequestHandler();
    const httpServer = http.createServer(requestHandler);
    httpServer.on('upgrade', (req, socket, head) => this._handleWsUpgrade(req, socket, head));
    try {
      await this._listenServer(httpServer, this.port, this.host);
      this.server = httpServer;
      this._httpServer = httpServer;

      if (httpsOptions) {
        const secureServer = https.createServer(httpsOptions, requestHandler);
        secureServer.on('upgrade', (req, socket, head) => this._handleWsUpgrade(req, socket, head));
        await this._listenServer(secureServer, tlsState.securePort, this.host);
        this.secureServer = secureServer;
      }
    } catch (error) {
      try { httpServer.close(); } catch (_) {}
      if (this.secureServer) {
        try { this.secureServer.close(); } catch (_) {}
      }
      this.server = null;
      this._httpServer = null;
      this.secureServer = null;
      throw error;
    }

    this.server.tlsEnabled = Boolean(this.secureServer);
    this.lastTlsError = '';
    this._startedAt = Date.now();
    this._startHeartbeat();
    console.log(`[Companion] Server on ${this.host}:${this.port}${this.secureServer ? ` (HTTPS :${tlsState.securePort})` : ' (HTTP)'}`);
    return { success: true, host: this.host, port: this.port, tlsEnabled: Boolean(this.secureServer), tlsReady: Boolean(this.secureServer), securePort: tlsState.securePort };
  }

  async stop() {
    if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
    for (const [, socket] of this._wsClients) { try { socket.destroy(); } catch (_) {} }
    this._wsClients.clear();
    this._remoteWsClients.clear();
    const active = this.server;
    const httpSrv = this._httpServer;
    const secureSrv = this.secureServer;
    this.server = null;
    this._httpServer = null;
    this.secureServer = null;
    if (!active) return { success: true, stopped: false };
    await Promise.all([
      new Promise(resolve => { try { active.close(() => resolve()); } catch (_) { resolve(); } }),
      new Promise(resolve => { if (httpSrv && httpSrv !== active) try { httpSrv.close(() => resolve()); } catch (_) { resolve(); } else resolve(); }),
      new Promise(resolve => { if (secureSrv) try { secureSrv.close(() => resolve()); } catch (_) { resolve(); } else resolve(); })
    ]);
    console.log('[Companion] Server stopped');
    return { success: true, stopped: true };
  }

  async _listenServer(server, port, host) {
    await new Promise((resolve, reject) => {
      const handleError = (error) => { server.off('listening', handleListening); reject(error); };
      const handleListening = () => { server.off('error', handleError); resolve(); };
      server.once('error', handleError);
      server.once('listening', handleListening);
      server.listen(port, host);
    });
  }

  // ── Request Routing ───────────────────────────────────────────────────────

  _createRequestHandler() {
    return async (req, res) => {
      res._companionRequest = req;
      try { await this._route(req, res); }
      catch (error) { if (!res.headersSent) sendJson(res, 500, { success: false, error: error.message || 'Internal error' }); }
    };
  }

  async _route(req, res) {
    const method = String(req.method || 'GET').toUpperCase();
    if (method === 'OPTIONS') return sendCors(res);
    const isTls = this._isTlsConnection(req);
    const url = new URL(req.url || '/', this.getBaseUrl(isTls));
    const urlPath = url.pathname;

    // Public — no auth
    if (method === 'GET' && urlPath === '/companion/health') return this._handleHealth(res, isTls);
    if (method === 'GET' && (urlPath === '/' || urlPath === '/companion/web' || urlPath.startsWith('/companion/web/'))) return this._serveWebAsset(urlPath, res);
    if (method === 'GET' && (urlPath === '/companion/bootstrap' || urlPath === '/companion/bootstrap/')) return this._serveBootstrapAsset(urlPath, res);
    if (method === 'GET' && urlPath === '/companion/bootstrap/status') return this._handleBootstrapStatus(req, res, url);
    if (method === 'GET' && (urlPath === '/companion/bootstrap/ca.cer' || urlPath === '/companion/bootstrap/ca.crt')) return this._handleBootstrapCertificateDownload(res, urlPath);
    if (method === 'GET' && urlPath === '/companion/app/android/status') return this._handleAndroidAppStatus(req, res, url);
    if (method === 'GET' && urlPath === '/companion/app/android/download') return this._handleAndroidAppDownload(res);
    if (method === 'GET' && urlPath.startsWith('/companion/skin-cast/')) return this._serveCastSkinAsset(urlPath, res);
    if (method === 'GET' && urlPath === '/companion/ui-state') return this._handleUiState(res);

    // Forward everything else to backend dispatch
    return this._dispatchRequest(req, res, method, url, urlPath);
  }

  async _dispatchRequest(req, res, method, url, urlPath) {
    if (!this._dispatch) return sendJson(res, 503, { success: false, error: 'Backend not available' });

    const token = this._extractAuthToken(req);
    let body = null;
    if (method === 'POST') {
      const contentType = String(req.headers?.['content-type'] || '').toLowerCase();
      const isJsonBody = !contentType || contentType.includes('application/json');
      if (isJsonBody) {
        try { body = await readJsonBody(req); } catch (_) { return sendJson(res, 400, { success: false, error: 'Invalid JSON body' }); }
      } else {
        // Binary upload (audio, file, etc.) — read raw and wrap as base64
        try {
          const rawBuffer = await readBody(req);
          body = { _binaryBase64: rawBuffer.toString('base64'), _binaryContentType: contentType, _binarySize: rawBuffer.length };
        } catch (_) { return sendJson(res, 400, { success: false, error: 'Failed to read request body' }); }
      }
    }

    const socketInfo = {
      encrypted: this._isTlsConnection(req),
      remoteAddress: req.socket?.remoteAddress || '',
      host: this._getRequestHostname(req)
    };

    try {
      const result = await this._dispatch(method, urlPath, body, req.headers, token, socketInfo, url);
      if (!result || result.status === undefined) {
        return sendJson(res, result?.success === false ? 400 : 200, result || {});
      }
      if (result._closeConnection) {
        const payload = result.body || { success: false, error: 'Companion protocol violation' };
        const responseBody = JSON.stringify(payload);
        res.writeHead(result.status || 403, withCorsHeaders(req, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Connection': 'close',
          'Content-Length': Buffer.byteLength(responseBody)
        }));
        res.end(responseBody, () => {
          try { req.socket?.destroy(); } catch (_) {}
        });
        return;
      }
      if (result._rawFile) {
        res.writeHead(result.status, withCorsHeaders(req, result.headers || {}));
        res.end(result._rawFile);
        return;
      }
      sendJson(res, result.status, result.body || {});
    } catch (e) {
      sendJson(res, 500, { success: false, error: e.message });
    }
  }

  // ── Health ────────────────────────────────────────────────────────────────

  async _handleHealth(res, isTls = false) {
    await this.refreshTlsState();
    const uptimeMs = this._startedAt ? Date.now() - this._startedAt : 0;
    const tlsReady = Boolean(this.server?.tlsEnabled);
    sendJson(res, 200, {
      ok: true, kind: 'companion', version: '0.2.0',
      host: this.host, port: this.port, tlsEnabled: tlsReady, tlsReady,
      connectionSecure: isTls, uptime: Math.floor(uptimeMs / 1000),
      pairedDevices: 0, connectedDevices: this._wsClients.size + this._remoteWsClients.size
    });
  }

  // ── Static Files ──────────────────────────────────────────────────────────

  _serveWebAsset(requestPath, res) {
    try {
      const file = resolveCompanionWebFile(requestPath);
      if (!file?.absolutePath) return sendJson(res, 404, { error: 'Not found' });
      const body = fs.readFileSync(file.absolutePath);
      const cacheControl = /\.(?:html|js|css)$/i.test(file.absolutePath) ? 'no-cache' : 'public, max-age=300';
      res.writeHead(200, withCorsHeaders(res, { 'Content-Type': file.contentType, 'Cache-Control': cacheControl }));
      res.end(body);
    } catch (e) { sendJson(res, 500, { error: e.message }); }
  }

  _serveBootstrapAsset(requestPath, res) {
    try {
      const file = resolveCompanionBootstrapFile(requestPath);
      if (!file?.absolutePath) return sendJson(res, 404, { error: 'Not found' });
      const body = fs.readFileSync(file.absolutePath);
      res.writeHead(200, withCorsHeaders(res, { 'Content-Type': file.contentType, 'Cache-Control': 'no-cache' }));
      res.end(body);
    } catch (e) { sendJson(res, 500, { error: e.message }); }
  }

  async _handleBootstrapStatus(req, res, url) {
    await this.refreshTlsState();
    const requestHost = this._getRequestHostname(req);
    const pairingCode = url.searchParams.get('code') || url.searchParams.get('pairingCode') || '';
    const tlsReady = Boolean(this.secureServer);
    const securePort = Number(this.tlsState?.securePort) || this.port;
    const secureUrl = tlsReady ? `https://${requestHost}:${securePort}/companion/web${pairingCode ? `?code=${encodeURIComponent(pairingCode)}` : ''}` : '';
    const clientBaseUrl = getClientFacingBaseUrl(req, this.getBaseUrl());
    const caUrl = clientBaseUrl ? `${clientBaseUrl}/companion/bootstrap/ca.crt` : '';
    const androidApp = this._buildAndroidAppPayload(req, url);
    sendJson(res, 200, { success: true, enabled: this.tlsState?.enabled === true, supported: this.tlsState?.supported === true, ready: tlsReady, pairingCode, secureUrl, caUrl, androidApp, warning: this.tlsState?.warning || this.lastTlsError || '' });
  }

  _buildAndroidAppPayload(req, url) {
    const isTls = this._isTlsConnection(req);
    const requestHost = this._getRequestHostname(req);
    const pairingCode = url.searchParams.get('code') || url.searchParams.get('pairingCode') || '';
    const port = isTls ? (Number(this.tlsState?.securePort) || this.port) : this.port;
    const apk = findAndroidApk();
    const sha256 = apk ? (apk.sha256 || sha256File(apk.absolutePath)) : '';
    return {
      available: Boolean(apk),
      fileName: apk?.fileName || '',
      size: apk?.size || 0,
      versionCode: apk?.versionCode || 0,
      versionName: apk?.versionName || '',
      sha256,
      openUrl: buildNativeCompanionUrl(requestHost, port, {
        useTls: isTls,
        pairingCode
      }) || 'localagent-companion://companion',
      downloadUrl: apk ? '/companion/app/android/download' : ''
    };
  }

  async _handleAndroidAppStatus(req, res, url) {
    await this.refreshTlsState();
    sendJson(res, 200, { success: true, androidApp: this._buildAndroidAppPayload(req, url) });
  }

  _handleAndroidAppDownload(res) {
    const apk = findAndroidApk();
    if (!apk) return sendJson(res, 404, { success: false, error: 'Android APK is not available on this desktop yet.' });
    const body = fs.readFileSync(apk.absolutePath);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="${apk.fileName}"`
    });
    res.end(body);
  }

  async _handleBootstrapCertificateDownload(res, urlPath = '') {
    await this.refreshTlsState();
    if (!this.tlsState?.ready || !this.tlsManager?.caCertPath || !fs.existsSync(this.tlsManager.caCertPath)) return sendJson(res, 404, { error: 'CA cert not ready' });
    const buffer = fs.readFileSync(this.tlsManager.caCertPath);
    const ext = String(urlPath || '').toLowerCase().endsWith('.crt') ? 'crt' : 'cer';
    res.writeHead(200, withCorsHeaders(res, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Length': buffer.length, 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="LocalAgent-Companion-CA.${ext}"` }));
    res.end(buffer);
  }

  _serveCastSkinAsset(requestPath, res) {
    try {
      const skinPath = requestPath.replace('/companion/skin-cast/', '/companion/skins/');
      const file = resolveCompanionSkinFile(skinPath);
      if (!file?.absolutePath || !file.contentType.includes('text/css')) return sendJson(res, 404, { error: 'Not found' });
      res.writeHead(200, withCorsHeaders(res, { 'Content-Type': file.contentType, 'Cache-Control': 'no-cache' }));
      res.end(readAndCastCompanionSkin(file.absolutePath));
    } catch (e) { sendJson(res, 500, { error: e.message }); }
  }

  async _handleUiState(res) {
    try { sendJson(res, 200, { success: true, ui: await getCompanionUiState(this._uiStateDb).catch(() => ({})) }); }
    catch (_) { sendJson(res, 200, { success: true, ui: {} }); }
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────

  _handleWsUpgrade(req, socket, head) {
    const isTls = this._isTlsConnection(req);
    const url = new URL(req.url || '/', this.getBaseUrl(isTls));
    if (url.pathname !== '/companion/ws') { socket.destroy(); return; }

    const ticket = url.searchParams.get('ticket');
    if (!ticket) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }

    if (!this._dispatch) { socket.write('HTTP/1.1 503 Unavailable\r\n\r\n'); socket.destroy(); return; }

    this._dispatch('GET', '/companion/ws', null, req.headers, null, {}, url).then(dResult => {
      if (!dResult?._wsAccepted || !dResult._deviceId) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return;
      }
      const ws = acceptWebSocket(req, socket);
      if (!ws) return;
      const deviceId = dResult._deviceId;
      const oldWs = this._wsClients.get(deviceId);
      if (oldWs) { try { oldWs.destroy(); } catch (_) {} }
      this._wsClients.set(deviceId, ws);
      console.log(`[Companion] WS connected: ${deviceId} (${this._wsClients.size})`);
      const initialHeartbeat = setTimeout(() => {
        if (this._wsClients.get(deviceId) !== ws) return;
        this._wsSend(ws, {
          type: 'heartbeat',
          payload: {
            uptime: this._uptimeSeconds(),
            connectedDevices: this._wsClients.size + this._remoteWsClients.size
          }
        });
      }, 0);
      if (typeof initialHeartbeat.unref === 'function') initialHeartbeat.unref();

      let buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
      const flushFrames = () => {
        while (buffer.length > 0) {
          const frame = wsDecodeFrame(buffer);
          if (!frame) break;
          buffer = buffer.slice(frame.totalLength);
          if (frame.opcode === 0x08) { ws.destroy(); return; }
          if (frame.opcode === 0x09) { try { ws.write(Buffer.from([0x8A, 0])); } catch (_) {} }
        }
      };
      ws.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        flushFrames();
      });
      ws.on('close', () => {
        if (this._wsClients.get(deviceId) === ws) this._wsClients.delete(deviceId);
        console.log(`[Companion] WS closed: ${deviceId} (${this._wsClients.size})`);
      });
      ws.on('error', (error) => {
        if (this._wsClients.get(deviceId) === ws) this._wsClients.delete(deviceId);
        console.warn(`[Companion] WS socket error for ${deviceId}: ${error?.message || 'socket error'}`);
      });
      if (buffer.length) flushFrames();
    }).catch((error) => {
      console.warn(`[Companion] WS upgrade failed: ${error?.message || 'internal error'}`);
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      socket.destroy();
    });
  }

  _wsSend(socket, message) {
    try { socket.write(wsFrameText(JSON.stringify({ ...message, timestamp: new Date().toISOString() }))); } catch (_) {}
  }

  async dispatchRemoteGatewayRequest(frame = {}) {
    if (!this._dispatch) {
      return { status: 503, body: { success: false, error: 'Backend not available' } };
    }
    const method = String(frame.method || 'GET').toUpperCase();
    const requestPath = String(frame.path || '/');
    const url = new URL(requestPath, this.getBaseUrl(false));
    if (this._isGatewayPublicRoute(method, url.pathname)) {
      return this._captureGatewayRoute(method, requestPath, frame.headers || {});
    }
    const headers = frame.headers || {};
    const token = this._extractAuthToken({ headers });
    let body = frame.body || null;
    if (frame.bodyBase64) {
      const raw = Buffer.from(String(frame.bodyBase64), 'base64');
      const contentType = String(headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
      if (!contentType || contentType.includes('application/json')) {
        try { body = JSON.parse(raw.toString('utf-8') || '{}'); }
        catch (_) { return { status: 400, body: { success: false, error: 'Invalid JSON body' } }; }
      } else {
        body = { _binaryBase64: raw.toString('base64'), _binaryContentType: contentType, _binarySize: raw.length };
      }
    }
    const socketInfo = {
      encrypted: true,
      remoteAddress: 'remote-gateway',
      host: url.hostname
    };
    const result = await this._dispatch(method, url.pathname, body, headers, token, socketInfo, url);
    if (!result || result.status === undefined) {
      return { status: result?.success === false ? 400 : 200, body: result || {} };
    }
    if (result._rawFile) {
      return {
        status: result.status,
        headers: result.headers || {},
        bodyBase64: Buffer.from(result._rawFile).toString('base64')
      };
    }
    return { status: result.status, headers: result.headers || {}, body: result.body || {} };
  }

  _isGatewayPublicRoute(method, urlPath) {
    if (method === 'OPTIONS') return true;
    if (method !== 'GET') return false;
    return urlPath === '/companion/health'
      || urlPath === '/'
      || urlPath === '/companion/web'
      || urlPath.startsWith('/companion/web/')
      || urlPath === '/companion/bootstrap'
      || urlPath === '/companion/bootstrap/'
      || urlPath === '/companion/bootstrap/status'
      || urlPath === '/companion/bootstrap/ca.cer'
      || urlPath === '/companion/bootstrap/ca.crt'
      || urlPath === '/companion/app/android/status'
      || urlPath === '/companion/app/android/download'
      || urlPath.startsWith('/companion/skin-cast/')
      || urlPath === '/companion/ui-state';
  }

  async _captureGatewayRoute(method, requestPath, headers = {}) {
    const req = {
      method,
      url: requestPath,
      headers,
      socket: { encrypted: true, remoteAddress: 'remote-gateway' }
    };
    const chunks = [];
    const res = {
      _companionRequest: req,
      headersSent: false,
      statusCode: 200,
      headers: {},
      writeHead(status, responseHeaders = {}) {
        this.statusCode = status;
        this.headers = responseHeaders || {};
        this.headersSent = true;
      },
      end(chunk) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
    };
    await this._route(req, res);
    const body = Buffer.concat(chunks);
    const contentType = String(res.headers['Content-Type'] || res.headers['content-type'] || '');
    if (contentType.includes('application/json')) {
      try {
        return { status: res.statusCode, headers: res.headers, body: JSON.parse(body.toString('utf-8') || '{}') };
      } catch (_) {}
    }
    return { status: res.statusCode, headers: res.headers, bodyBase64: body.toString('base64') };
  }

  async acceptRemoteGatewayWebSocket(frame = {}) {
    if (!this._dispatch) return { accepted: false, error: 'Backend not available' };
    const connectionId = String(frame.connectionId || '').trim();
    if (!connectionId) return { accepted: false, error: 'connectionId is required' };
    const url = new URL(String(frame.path || '/companion/ws'), this.getBaseUrl(false));
    const result = await this._dispatch('GET', '/companion/ws', null, frame.headers || {}, null, {}, url);
    if (!result?._wsAccepted || !result._deviceId) {
      return { accepted: false, error: 'WebSocket ticket rejected' };
    }
    this._remoteWsClients.set(connectionId, { deviceId: result._deviceId, connectedAt: new Date().toISOString() });
    return { accepted: true, deviceId: result._deviceId };
  }

  closeRemoteGatewayWebSocket(connectionId) {
    return this._remoteWsClients.delete(String(connectionId || ''));
  }

  handleRemoteGatewayWebSocketMessage(connectionId, message) {
    const id = String(connectionId || '');
    if (!this._remoteWsClients.has(id)) return false;
    if (message?.type === 'ping') {
      this._remoteGatewayManager?.sendRemoteWsMessage?.(id, {
        type: 'heartbeat',
        payload: { uptime: this._uptimeSeconds(), connectedDevices: this._wsClients.size + this._remoteWsClients.size }
      });
    }
    return true;
  }

  _wsBroadcast(message) {
    for (const [, s] of this._wsClients) this._wsSend(s, message);
    for (const [connectionId] of this._remoteWsClients) {
      this._remoteGatewayManager?.sendRemoteWsMessage?.(connectionId, message);
    }
  }

  disconnectDevice(deviceId, reason = 'device-removed') {
    let disconnected = false;
    const ws = this._wsClients.get(deviceId);
    if (ws) {
      this._wsSend(ws, { type: 'device-kicked', payload: { reason } });
      try { ws.destroy(); } catch (_) {}
      this._wsClients.delete(deviceId);
      disconnected = true;
    }
    for (const [connectionId, remoteClient] of Array.from(this._remoteWsClients.entries())) {
      if (remoteClient?.deviceId !== deviceId) continue;
      this._remoteGatewayManager?.sendRemoteWsMessage?.(connectionId, {
        type: 'device-kicked',
        payload: { reason }
      });
      this._remoteGatewayManager?.closeRemoteWsConnection?.(connectionId, reason);
      this._remoteWsClients.delete(connectionId);
      disconnected = true;
    }
    return disconnected;
  }

  _startHeartbeat() {
    this._heartbeatTimer = setInterval(() => this._wsBroadcast({ type: 'heartbeat', payload: { uptime: this._uptimeSeconds(), connectedDevices: this._wsClients.size + this._remoteWsClients.size } }), HEARTBEAT_INTERVAL_MS);
    if (typeof this._heartbeatTimer.unref === 'function') this._heartbeatTimer.unref();
  }

  _uptimeSeconds() { return this._startedAt ? Math.floor((Date.now() - this._startedAt) / 1000) : 0; }
}

module.exports = CompanionApiServer;



