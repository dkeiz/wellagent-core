// @ts-nocheck
const crypto = require('crypto');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { URL } = require('url');
const { wsDecodeFrame, wsFrameText } = require('./companion-server-core');

function normalizeGatewayUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) throw new Error('Gateway URL is required');
  const parsed = new URL(value);
  if (!['ws:', 'wss:'].includes(parsed.protocol)) {
    throw new Error('Gateway URL must start with ws:// or wss://');
  }
  if (parsed.pathname === '/' || !parsed.pathname) parsed.pathname = '/gateway/host';
  return parsed;
}

function buildHandshake(url, secret) {
  const key = crypto.randomBytes(16).toString('base64');
  const path = `${url.pathname || '/gateway/host'}${url.search || ''}`;
  const port = url.port || (url.protocol === 'wss:' ? '443' : '80');
  const host = url.port ? `${url.hostname}:${port}` : url.hostname;
  return {
    key,
    request: [
      `GET ${path} HTTP/1.1`,
      `Host: ${host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      `Authorization: Bearer ${secret}`,
      '\r\n'
    ].join('\r\n')
  };
}

function parseHttpResponseHeaders(headerText) {
  const lines = String(headerText || '').split('\r\n');
  const statusLine = lines.shift() || '';
  const headers = {};
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return { statusLine, headers };
}

function expectedWebSocketAccept(key) {
  return crypto.createHash('sha1')
    .update(String(key || '') + '258EAFA5-E914-47DA-95CA-5AB5DC11E548')
    .digest('base64');
}

function assertValidHandshakeResponse(headerText, key) {
  const { statusLine, headers } = parseHttpResponseHeaders(headerText);
  if (!/^HTTP\/1\.1 101\b/.test(statusLine)) {
    throw new Error(`Gateway rejected host tunnel: ${statusLine || 'invalid response'}`);
  }
  const accept = headers['sec-websocket-accept'];
  if (accept !== expectedWebSocketAccept(key)) {
    throw new Error('Gateway returned an invalid WebSocket accept key');
  }
}

function shellQuote(value) {
  return `'${String(value || '').replace(/'/g, "'\"'\"'")}'`;
}

function readGatewayFile(fileName) {
  return fs.readFileSync(path.join(__dirname, 'remote-gateway', fileName), 'utf8');
}

function heredoc(filePath, content) {
  const marker = `LOCALAGENT_${crypto.randomBytes(6).toString('hex')}`;
  return [
    `cat > "${filePath}" <<'${marker}'`,
    content.replace(/\r\n/g, '\n'),
    marker
  ].join('\n');
}

function runSshInstall({ target, sshPort, script, timeoutMs = 120000 }) {
  return new Promise((resolve, reject) => {
    const args = ['-p', String(sshPort || 22), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', target, 'sh -s'];
    const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      reject(new Error('Remote Gateway setup timed out'));
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', code => {
      clearTimeout(timer);
      const output = `${stdout}${stderr ? `\n${stderr}` : ''}`.trim();
      if (code === 0) {
        resolve({ output });
        return;
      }
      reject(new Error(output || `ssh exited with code ${code}`));
    });
    child.stdin.end(script);
  });
}

function buildGatewayUrl({ host, gatewayPort, domain, useTls }) {
  const publicHost = String(domain || '').trim();
  if (publicHost) {
    return `${useTls === false ? 'ws' : 'wss'}://${publicHost.replace(/^wss?:\/\//, '').replace(/\/.*$/, '')}/gateway/host`;
  }
  return `ws://${host}:${gatewayPort}/gateway/host`;
}

function buildInstallScript({ targetDir, gatewayPort, secret }) {
  const appDir = String(targetDir || '~/localagent-remote-gateway').trim();
  const port = Number(gatewayPort) || 8791;
  const files = ['server.js', 'relay.js', 'auth.js', 'config.js', 'package.json', 'Dockerfile', 'README.md'];
  const script = [
    'set -eu',
    `APP_DIR_INPUT=${shellQuote(appDir)}`,
    'case "$APP_DIR_INPUT" in',
    '  "~") APP_DIR="$HOME" ;;',
    '  "~/"*) APP_DIR="$HOME/${APP_DIR_INPUT#~/}" ;;',
    '  *) APP_DIR="$APP_DIR_INPUT" ;;',
    'esac',
    `PORT=${shellQuote(port)}`,
    `SECRET=${shellQuote(secret)}`,
    'mkdir -p "$APP_DIR"',
    ...files.map(fileName => heredoc(`$APP_DIR/${fileName}`, readGatewayFile(fileName))),
    'cat > "$APP_DIR/localagent-remote-gateway.env" <<ENV',
    'REMOTE_GATEWAY_HOST=0.0.0.0',
    'REMOTE_GATEWAY_PORT=$PORT',
    'REMOTE_GATEWAY_SECRET=$SECRET',
    'ENV',
    "cat > \"$APP_DIR/start.sh\" <<'SH'",
    '#!/usr/bin/env sh',
    'set -eu',
    '. "$(dirname "$0")/localagent-remote-gateway.env"',
    'exec node "$(dirname "$0")/server.js"',
    'SH',
    'chmod +x "$APP_DIR/start.sh"',
    'if ! command -v node >/dev/null 2>&1; then echo "Node.js is required on the VPS"; exit 12; fi',
    'if [ -f "$APP_DIR/gateway.pid" ] && kill -0 "$(cat "$APP_DIR/gateway.pid")" 2>/dev/null; then kill "$(cat "$APP_DIR/gateway.pid")" || true; fi',
    'nohup "$APP_DIR/start.sh" > "$APP_DIR/gateway.log" 2>&1 &',
    'echo $! > "$APP_DIR/gateway.pid"',
    'sleep 1',
    'if ! kill -0 "$(cat "$APP_DIR/gateway.pid")" 2>/dev/null; then tail -40 "$APP_DIR/gateway.log" || true; exit 13; fi',
    'node -e "const http=require(\'http\');const port=process.env.REMOTE_GATEWAY_PORT||process.argv[1];http.get({host:\'127.0.0.1\',port,path:\'/gateway/health\',timeout:3000},r=>{process.exit(r.statusCode===200?0:14)}).on(\'error\',()=>process.exit(15))" "$PORT"',
    'echo "Remote Gateway installed and running in $APP_DIR on port $PORT"'
  ];
  return script.join('\n');
}

class RemoteGatewayManager {
  constructor(options = {}) {
    this.db = options.db || null;
    this.getCompanionServer = options.getCompanionServer || (() => null);
    this.socket = null;
    this.url = '';
    this.secret = '';
    this.state = 'disconnected';
    this.lastError = '';
    this.connectedAt = null;
    this.latencyMs = 0;
    this.connectedClients = 0;
    this._buffer = Buffer.alloc(0);
    this._handshakeBuffer = Buffer.alloc(0);
    this._heartbeatTimer = null;
    this._lastPingAt = 0;
    this._autoReconnect = false;
    this._reconnectTimer = null;
    this._reconnectDelayMs = 1000;
    this.scopeOptions = {};
  }

  setCompanionServer(server) {
    if (server?.setRemoteGatewayManager) server.setRemoteGatewayManager(this);
  }

  async connect(url, secret, options = {}) {
    const parsedUrl = normalizeGatewayUrl(url);
    const authSecret = String(secret || '').trim();
    if (!authSecret) throw new Error('Gateway auth secret is required');
    this.disconnect({ disableReconnect: false });
    this._clearReconnect();
    const scopeOptions = options?.scopeOptions && typeof options.scopeOptions === 'object' ? options.scopeOptions : options;
    if (scopeOptions?.requestContext || scopeOptions?.userId) this.scopeOptions = scopeOptions;
    this._autoReconnect = options.autoReconnect !== false;
    if (!options.isReconnect) this._reconnectDelayMs = 1000;
    this.url = parsedUrl.toString();
    this.secret = authSecret;
    this.state = 'connecting';
    this.lastError = '';

    await new Promise((resolve, reject) => {
      const port = Number(parsedUrl.port || (parsedUrl.protocol === 'wss:' ? 443 : 80));
      const connectOptions = { host: parsedUrl.hostname, port, servername: parsedUrl.hostname };
      const socket = parsedUrl.protocol === 'wss:' ? tls.connect(connectOptions) : net.connect(connectOptions);
      const { request, key } = buildHandshake(parsedUrl, authSecret);
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        try { socket.destroy(); } catch (_) {}
        this.state = 'error';
        this.lastError = error.message;
        if (this._autoReconnect) this._scheduleReconnect();
        reject(error);
      };

      socket.setTimeout(15000, () => fail(new Error('Gateway connection timed out')));
      socket.once('error', fail);
      socket.once(parsedUrl.protocol === 'wss:' ? 'secureConnect' : 'connect', () => socket.write(request));
      socket.on('data', (chunk) => {
        if (settled) {
          this._onData(chunk);
          return;
        }
        this._handshakeBuffer = Buffer.concat([this._handshakeBuffer, chunk]);
        const marker = this._handshakeBuffer.indexOf('\r\n\r\n');
        if (marker < 0) return;
        const header = this._handshakeBuffer.slice(0, marker).toString('utf-8');
        const rest = this._handshakeBuffer.slice(marker + 4);
        try {
          assertValidHandshakeResponse(header, key);
        } catch (error) {
          fail(error);
          return;
        }
        settled = true;
        socket.setTimeout(0);
        this.socket = socket;
        this.state = 'connected';
        this.connectedAt = new Date().toISOString();
        this._reconnectDelayMs = 1000;
        if (rest.length) this._onData(rest);
        this._startHeartbeat();
        resolve();
      });
      socket.once('close', () => {
        if (!settled) fail(new Error('Gateway connection closed during handshake'));
        else this._markDisconnected('Gateway connection closed');
      });
    });

    await this._persistSettings({ enabled: true, url: this.url, secret: this.secret }, scopeOptions);
    return this.getStatus();
  }

  disconnect(options = {}) {
    if (options.disableReconnect !== false) {
      this._autoReconnect = false;
      this._clearReconnect();
    }
    this._stopHeartbeat();
    if (this.socket) {
      try { this.socket.destroy(); } catch (_) {}
    }
    this.socket = null;
    this.state = 'disconnected';
    this.connectedAt = null;
    this.connectedClients = 0;
    this._buffer = Buffer.alloc(0);
    this._handshakeBuffer = Buffer.alloc(0);
  }

  async disconnectAndPersist(options = {}) {
    this.disconnect();
    await this._persistSettings({ enabled: false }, options);
    return this.getStatus();
  }

  getStatus() {
    return {
      success: true,
      state: this.state,
      connected: this.state === 'connected',
      url: this.url,
      connectedAt: this.connectedAt,
      latencyMs: this.latencyMs,
      connectedClients: this.connectedClients,
      lastError: this.lastError
    };
  }

  generateSecret() {
    return crypto.randomBytes(32).toString('base64url');
  }

  async uploadGateway(sshConfig = {}) {
    const host = String(sshConfig.host || '').trim();
    const user = String(sshConfig.user || '').trim();
    const targetDir = String(sshConfig.targetDir || '~/localagent-remote-gateway').trim();
    return {
      success: true,
      mode: 'manual-package',
      packagePath: require('path').join(__dirname, 'remote-gateway'),
      target: host && user ? `${user}@${host}:${targetDir}` : targetDir,
      message: 'Automatic SSH deployment is not bundled. Upload the remote-gateway folder and run setup.sh on the VPS.'
    };
  }

  async setupGateway(options = {}) {
    const host = String(options.host || '').trim();
    const user = String(options.user || 'root').trim();
    if (!host) throw new Error('VPS host is required');
    if (!user) throw new Error('SSH user is required');
    const sshPort = Number(options.sshPort) || 22;
    const gatewayPort = Number(options.gatewayPort) || 8791;
    const targetDir = String(options.targetDir || '~/localagent-remote-gateway').trim();
    const secret = String(options.secret || this.secret || this.generateSecret()).trim();
    const url = buildGatewayUrl({
      host,
      gatewayPort,
      domain: options.domain,
      useTls: options.useTls !== false
    });
    const target = `${user}@${host}`;
    const script = buildInstallScript({ targetDir, gatewayPort, secret });
    const steps = [
      `Generated gateway config for ${target}`,
      `Installing to ${targetDir}`,
      `Gateway URL: ${url}`
    ];
    const result = await runSshInstall({ target, sshPort, script });
    const scopeOptions = options?.scopeOptions && typeof options.scopeOptions === 'object' ? options.scopeOptions : options;
    if (scopeOptions?.requestContext || scopeOptions?.userId) this.scopeOptions = scopeOptions;
    await this._persistSettings({ url, secret }, scopeOptions);
    const response = {
      success: true,
      mode: 'ssh',
      url,
      secret,
      target,
      targetDir,
      output: result.output,
      steps
    };
    if (options.connectAfter !== false) {
      try {
        response.connection = await this.connect(url, secret);
      } catch (error) {
        response.connection = { success: false, error: error.message };
      }
    }
    return response;
  }

  sendRemoteWsMessage(connectionId, message) {
    this._send({
      type: 'ws-message',
      connectionId,
      payload: message
    });
  }

  closeRemoteWsConnection(connectionId, reason = 'closed-by-host') {
    this._send({
      type: 'ws-close',
      connectionId,
      reason
    });
  }

  _onData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    while (this._buffer.length > 0) {
      const frame = wsDecodeFrame(this._buffer);
      if (!frame) break;
      this._buffer = this._buffer.slice(frame.totalLength);
      if (frame.opcode === 0x08) {
        this.disconnect();
        return;
      }
      if (frame.opcode !== 0x01) continue;
      try {
        this._handleFrame(JSON.parse(frame.payload.toString('utf-8')));
      } catch (error) {
        this.lastError = error.message;
      }
    }
  }

  async _handleFrame(frame) {
    if (frame.type === 'pong') {
      this.latencyMs = this._lastPingAt ? Date.now() - this._lastPingAt : 0;
      this.connectedClients = Number(frame.connectedClients || this.connectedClients || 0);
      return;
    }
    const server = this.getCompanionServer();
    if (frame.type === 'http-request') {
      const response = await server?.dispatchRemoteGatewayRequest?.(frame).catch(error => ({
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: { success: false, error: error.message }
      })) || { status: 503, body: { success: false, error: 'Companion server is not running' } };
      this._send({ type: 'http-response', requestId: frame.requestId, ...response });
      return;
    }
    if (frame.type === 'ws-open') {
      const accepted = await server?.acceptRemoteGatewayWebSocket?.(frame).catch(error => ({
        accepted: false,
        error: error.message
      })) || { accepted: false, error: 'Companion server is not running' };
      this._send({ type: accepted.accepted ? 'ws-accepted' : 'ws-rejected', connectionId: frame.connectionId, ...accepted });
      return;
    }
    if (frame.type === 'ws-close') {
      server?.closeRemoteGatewayWebSocket?.(frame.connectionId);
      return;
    }
    if (frame.type === 'ws-message') {
      server?.handleRemoteGatewayWebSocketMessage?.(frame.connectionId, frame.payload);
    }
  }

  _send(payload) {
    if (!this.socket || this.state !== 'connected') return false;
    try {
      this.socket.write(wsFrameText(JSON.stringify({ ...payload, at: new Date().toISOString() })));
      return true;
    } catch (error) {
      this._markDisconnected(error.message);
      return false;
    }
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      this._lastPingAt = Date.now();
      this._send({ type: 'ping' });
    }, 30000);
    if (typeof this._heartbeatTimer.unref === 'function') this._heartbeatTimer.unref();
    this._lastPingAt = Date.now();
    this._send({ type: 'ping' });
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = null;
  }

  _markDisconnected(reason) {
    this._stopHeartbeat();
    this.socket = null;
    if (this.state !== 'disconnected') {
      this.state = 'disconnected';
      this.lastError = reason || '';
      this.connectedAt = null;
    }
    if (this._autoReconnect) this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._reconnectTimer || !this.url || !this.secret) return;
    const delayMs = this._reconnectDelayMs;
    this._reconnectDelayMs = Math.min(this._reconnectDelayMs * 2, 30000);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect(this.url, this.secret, { autoReconnect: true, isReconnect: true }).catch(error => {
        this.lastError = error.message;
      });
    }, delayMs);
    if (typeof this._reconnectTimer.unref === 'function') this._reconnectTimer.unref();
  }

  _clearReconnect() {
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
  }

  async _persistSettings(update, options = {}) {
    if (!this.db?.saveScopedSetting && !this.db?.setCredential) return;
    const scopeOptions = options?.scopeOptions && typeof options.scopeOptions === 'object'
      ? options.scopeOptions
      : ((options?.requestContext || options?.userId) ? options : (this.scopeOptions || {}));
    if (Object.prototype.hasOwnProperty.call(update, 'enabled')) {
      if (this.db.saveScopedSetting) {
        await this.db.saveScopedSetting('remoteGateway.enabled', update.enabled ? 'true' : 'false', scopeOptions);
      } else {
        await this.db.saveSetting('remoteGateway.enabled', update.enabled ? 'true' : 'false');
      }
    }
    if (update.url) {
      if (this.db.saveScopedSetting) {
        await this.db.saveScopedSetting('remoteGateway.url', update.url, scopeOptions);
      } else {
        await this.db.saveSetting('remoteGateway.url', update.url);
      }
    }
    if (update.secret && this.db.setCredential) {
      await this.db.setCredential('remoteGateway.secret', update.secret, scopeOptions);
      await this.db.deleteSetting?.('remoteGateway.secret').catch(() => {});
      await this.db.deleteCredential?.('setting.remoteGateway.secret', scopeOptions).catch(() => {});
    }
  }
}

module.exports = {
  RemoteGatewayManager,
  _test: {
    buildHandshake,
    parseHttpResponseHeaders,
    expectedWebSocketAccept,
    assertValidHandshakeResponse,
    buildGatewayUrl,
    buildInstallScript
  }
};



