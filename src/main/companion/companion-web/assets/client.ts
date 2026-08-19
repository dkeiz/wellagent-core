// @ts-nocheck
(function bootstrapCompanionClient(global) {
  const STORAGE_KEYS = {
    sessionToken: 'companion_session_token',
    legacySessionToken: 'companion_token',
    deviceId: 'companion_device',
    deviceName: 'companion_device_name'
  };

  function randomIdChunk() {
    if (global.crypto && global.crypto.getRandomValues) {
      const bytes = new Uint8Array(6);
      global.crypto.getRandomValues(bytes);
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    }
    return Math.random().toString(16).slice(2, 14);
  }

  function detectPlatformName() {
    const rawPlatform = String(
      (global.navigator && global.navigator.userAgentData && global.navigator.userAgentData.platform)
      || (global.navigator && global.navigator.platform)
      || ''
    ).trim().toLowerCase();
    const userAgent = String((global.navigator && global.navigator.userAgent) || '').trim().toLowerCase();
    if (rawPlatform.includes('win')) return 'Windows';
    if (rawPlatform.includes('mac')) return 'macOS';
    if (rawPlatform.includes('linux')) return 'Linux';
    if (rawPlatform.includes('android')) return 'Android';
    if (rawPlatform.includes('iphone') || rawPlatform.includes('ipad') || rawPlatform.includes('ios')) return 'iOS';
    if (userAgent.includes('android')) return 'Android';
    if (/(iphone|ipad|ipod|ios)/.test(userAgent)) return 'iOS';
    return '';
  }

  function detectBrowserName() {
    const brands = Array.isArray(global.navigator && global.navigator.userAgentData && global.navigator.userAgentData.brands)
      ? global.navigator.userAgentData.brands
      : [];
    const preferredBrand = brands.find((entry) => entry && entry.brand && entry.brand !== 'Not=A?Brand');
    if (preferredBrand && preferredBrand.brand) {
      return preferredBrand.brand;
    }

    const userAgent = String((global.navigator && global.navigator.userAgent) || '');
    if (/Edg\//.test(userAgent)) return 'Edge';
    if (/OPR\//.test(userAgent)) return 'Opera';
    if (/Chrome\//.test(userAgent)) return 'Chrome';
    if (/Firefox\//.test(userAgent)) return 'Firefox';
    if (/Safari\//.test(userAgent) && !/Chrome\//.test(userAgent)) return 'Safari';
    return 'Browser';
  }

  function buildDefaultDeviceName() {
    const browser = detectBrowserName();
    const platform = detectPlatformName();
    if (!platform) {
      return browser === 'Browser' ? 'Browser Companion' : `${browser} Companion`;
    }
    if (browser === 'Browser') {
      return `Browser on ${platform}`;
    }
    return `${browser} on ${platform}`;
  }

  function isLegacyAutoDeviceName(value) {
    const trimmed = String(value || '').trim();
    if (!trimmed) return false;
    const legacyPlatform = String((global.navigator && global.navigator.platform) || 'Browser').trim();
    return trimmed === `Web ${legacyPlatform}` || trimmed === 'Web Browser';
  }

  function buildPlatformToken() {
    const platform = detectPlatformName();
    if (platform === 'Android') return 'android-web';
    if (platform === 'iOS') return 'ios-web';
    if (platform) return 'desktop-web';
    return 'web';
  }

  class CompanionBrowserClient {
    constructor(baseUrl) {
      this.baseUrl = String(baseUrl || global.location.origin).replace(/\/$/, '');
      this.sessionToken = '';
      this.accessToken = '';
      this.wsTicket = '';
      this.deviceId = '';
      this.ws = null;
      this.wsConnected = false;
      this.shouldReconnect = false;
      this.reconnectTimer = null;
      this.artifactTickets = new Map();
      this.onMessage = null;
      this.onConnection = null;
      this.onOpen = null;
      this.lastTransportMode = 'offline';
      this.lastTransportDetail = '';
    }

    notifyConnection(update = {}) {
      const next = {
        connected: update.connected === true,
        mode: update.mode || 'offline',
        detail: String(update.detail || '').trim()
      };
      this.wsConnected = next.connected;
      this.lastTransportMode = next.mode;
      this.lastTransportDetail = next.detail;
      if (this.onConnection) this.onConnection(next);
    }

    savedSessionToken() {
      return localStorage.getItem(STORAGE_KEYS.sessionToken) || localStorage.getItem(STORAGE_KEYS.legacySessionToken) || '';
    }

    saveSessionToken(value) {
      if (value) {
        localStorage.setItem(STORAGE_KEYS.sessionToken, value);
        localStorage.removeItem(STORAGE_KEYS.legacySessionToken);
      } else {
        localStorage.removeItem(STORAGE_KEYS.sessionToken);
        localStorage.removeItem(STORAGE_KEYS.legacySessionToken);
      }
    }

    getOrCreateDeviceId() {
      const saved = localStorage.getItem(STORAGE_KEYS.deviceId);
      if (saved) return saved;
      const created = `web-${randomIdChunk()}-${Date.now().toString(36)}`;
      localStorage.setItem(STORAGE_KEYS.deviceId, created);
      return created;
    }

    getDefaultDeviceName() {
      const saved = String(localStorage.getItem(STORAGE_KEYS.deviceName) || '').trim();
      if (saved && !isLegacyAutoDeviceName(saved)) {
        return saved;
      }
      const generated = buildDefaultDeviceName();
      this.setDeviceName(generated);
      return generated;
    }

    setDeviceName(name) {
      localStorage.setItem(STORAGE_KEYS.deviceName, String(name || '').trim());
    }

    async request(method, path, body, extra = {}) {
      const options = {
        method,
        headers: {
          ...(body == null || extra.binary ? {} : { 'Content-Type': 'application/json' }),
          ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
          ...(extra.headers || {})
        }
      };
      if (body != null) {
        options.body = extra.binary ? body : JSON.stringify(body);
      }
      const response = await fetch(`${this.baseUrl}${path}`, options);
      if (extra.expectRaw) {
        return response;
      }
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || (payload && payload.success === false)) {
        throw new Error((payload && payload.error) || `HTTP ${response.status}`);
      }
      return payload;
    }

    async pair(pairingCode, deviceName) {
      const nextDeviceId = this.getOrCreateDeviceId();
      const payload = await this.request('POST', '/companion/pair', {
        pairingCode,
        deviceName,
        deviceId: nextDeviceId,
        platform: buildPlatformToken(),
        appVersion: '0.2.0'
      });
      if (!payload.success || !payload.sessionToken) {
        throw new Error(payload.error || 'Pairing failed');
      }
      this.setDeviceName(deviceName);
      await this.authenticate(payload.sessionToken, nextDeviceId);
      return payload;
    }

    async authenticate(sessionToken, deviceId) {
      const payload = await this.request('POST', '/companion/auth', {
        sessionToken,
        deviceId
      });
      if (!payload.success || !payload.accessToken) {
        throw new Error(payload.error || 'Authentication failed');
      }
      this.sessionToken = sessionToken;
      this.accessToken = payload.accessToken;
      this.wsTicket = payload.wsTicket || '';
      this.deviceId = deviceId;
      this.saveSessionToken(sessionToken);
      localStorage.setItem(STORAGE_KEYS.deviceId, deviceId);
      return payload;
    }

    async autoLogin() {
      const savedToken = this.savedSessionToken();
      const savedDeviceId = this.getOrCreateDeviceId();
      if (!savedToken) return false;
      try {
        await this.authenticate(savedToken, savedDeviceId);
        return true;
      } catch (_) {
        this.logout({ preserveSocket: true });
        return false;
      }
    }

    logout({ preserveSocket = false } = {}) {
      this.sessionToken = '';
      this.accessToken = '';
      this.wsTicket = '';
      this.saveSessionToken('');
      if (!preserveSocket) {
        this.disconnectWebSocket();
      }
      this.notifyConnection({ connected: false, mode: 'offline', detail: '' });
    }

    async getSettingsSnapshot() {
      return this.request('GET', '/companion/settings/full');
    }

    async getUiState() {
      return this.request('GET', '/companion/ui-state');
    }

    async getWsTicket() {
      return this.request('GET', '/companion/ws-ticket');
    }

    async listChatSessions(limit = 20) {
      return this.request('GET', `/companion/chat/sessions?limit=${encodeURIComponent(String(limit))}`);
    }

    async createChatSession() {
      return this.request('POST', '/companion/chat/session', {});
    }

    async switchChatSession(sessionId) {
      return this.request('POST', '/companion/chat/switch', { sessionId });
    }

    async getMessages(sessionId, limit = 80) {
      const params = new URLSearchParams({ sessionId: String(sessionId || ''), limit: String(limit) });
      return this.request('GET', `/companion/chat/messages?${params.toString()}`);
    }

    async sendMessage(text, sessionId) {
      return this.request('POST', '/companion/chat/send', { text, sessionId });
    }

    async stopGeneration() {
      return this.request('POST', '/companion/chat/stop', {});
    }

    async clearChatSession(sessionId) {
      return this.request('POST', '/companion/chat/clear', { sessionId });
    }

    async setThinkingMode(mode) {
      return this.request('POST', '/companion/llm/thinking', { mode });
    }

    async listAgents() {
      return this.request('GET', '/companion/agents');
    }

    async setAgentActive(agentId, active) {
      return this.request('POST', '/companion/agents/active', { agentId, active });
    }

    async getSessionArtifacts(sessionId) {
      const params = new URLSearchParams({ sessionId: String(sessionId || '') });
      return this.request('GET', `/companion/artifacts?${params.toString()}`);
    }

    async readSessionArtifact(sessionId, fileName) {
      const params = new URLSearchParams({ sessionId: String(sessionId || ''), fileName: String(fileName || '') });
      return this.request('GET', `/companion/artifact/read?${params.toString()}`);
    }

    artifactTicketKey(sessionId, fileName) {
      return `${String(sessionId || '')}\n${String(fileName || '')}`;
    }

    extractArtifactNames(messages = []) {
      const names = new Set();
      for (const message of messages || []) {
        const content = String((message && message.content) || '');
        const pattern = /^\[(?:Image attached|Voice message|File attached):\s*([^\]]+)\]/gim;
        let match = pattern.exec(content);
        while (match) {
          const name = String(match[1] || '').trim();
          if (name) names.add(name);
          match = pattern.exec(content);
        }
      }
      return Array.from(names);
    }

    async getArtifactTicket(sessionId, fileName) {
      const key = this.artifactTicketKey(sessionId, fileName);
      const existing = this.artifactTickets.get(key);
      if (existing && Number(existing.expiresAt || 0) > Date.now() + 5000) {
        return existing.ticket;
      }
      const params = new URLSearchParams({ sessionId: String(sessionId || ''), fileName: String(fileName || '') });
      const payload = await this.request('GET', `/companion/artifact/ticket?${params.toString()}`);
      const ticket = String(payload.ticket || '').trim();
      if (!ticket) throw new Error('Artifact ticket was not returned');
      this.artifactTickets.set(key, {
        ticket,
        expiresAt: Number(payload.expiresAt || 0) || Date.now() + (Number(payload.expiresIn || 60) * 1000)
      });
      return ticket;
    }

    async prepareArtifactTickets(sessionId, messages = []) {
      if (!sessionId) return;
      const names = this.extractArtifactNames(messages);
      await Promise.all(names.map((fileName) => this.getArtifactTicket(sessionId, fileName).catch(() => null)));
    }

    async setCapabilityMain(enabled) {
      return this.request('POST', '/companion/capabilities/main', { enabled });
    }

    async setCapabilityGroup(groupId, enabled) {
      return this.request('POST', '/companion/capabilities/group', { groupId, enabled });
    }

    async setDaemonRunning(kind, running) {
      return this.request('POST', '/companion/daemon', { kind, running });
    }

    async listTaskQueue() {
      return this.request('GET', '/companion/task-queue?actionable=true');
    }

    async updateTask(action, taskId) {
      return this.request('POST', '/companion/task-queue/action', { action, taskId });
    }

    async transcribeBlob(blob, options = {}) {
      const params = new URLSearchParams();
      if (options.sessionId) params.set('sessionId', options.sessionId);
      if (options.sendAsMessage) params.set('sendAsMessage', 'true');
      if (options.language) params.set('language', options.language);
      if (options.prompt) params.set('prompt', options.prompt);
      return this.request(
        'POST',
        `/companion/stt/transcribe${params.toString() ? `?${params.toString()}` : ''}`,
        await blob.arrayBuffer(),
        {
          binary: true,
          headers: { 'Content-Type': blob.type || 'audio/webm' }
        }
      );
    }

    async uploadFile(file, options = {}) {
      const params = new URLSearchParams();
      if (options.sessionId) params.set('sessionId', options.sessionId);
      if (options.caption) params.set('caption', options.caption);
      if (options.sendAsMessage === false) params.set('sendAsMessage', 'false');
      return this.request(
        'POST',
        `/companion/media/upload${params.toString() ? `?${params.toString()}` : ''}`,
        await file.arrayBuffer(),
        {
          binary: true,
          headers: { 'Content-Type': file.type || 'application/octet-stream' }
        }
      );
    }

    async speakText(text) {
      return this.request('POST', '/backend/voice/generate', { text });
    }

    getArtifactUrl(sessionId, fileName) {
      const entry = this.artifactTickets.get(this.artifactTicketKey(sessionId, fileName));
      const ticket = entry && Number(entry.expiresAt || 0) > Date.now()
        ? `?ticket=${encodeURIComponent(entry.ticket)}`
        : '';
      return ticket
        ? `${this.baseUrl}/companion/artifact/${encodeURIComponent(sessionId)}/${encodeURIComponent(fileName)}${ticket}`
        : '';
    }

    async getArtifactUrlWithTicket(sessionId, fileName) {
      const ticket = await this.getArtifactTicket(sessionId, fileName);
      return `${this.baseUrl}/companion/artifact/${encodeURIComponent(sessionId)}/${encodeURIComponent(fileName)}?ticket=${encodeURIComponent(ticket)}`;
    }

    connectWebSocket(onMessage, onConnection, onOpen) {
      this.onMessage = onMessage || null;
      this.onConnection = onConnection || null;
      this.onOpen = onOpen || null;
      this.shouldReconnect = true;
      this.notifyConnection({ connected: false, mode: 'connecting', detail: 'Opening live connection...' });
      this.openWebSocket();
    }

    disconnectWebSocket() {
      this.shouldReconnect = false;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      if (this.ws) {
        this.ws.close();
        this.ws = null;
      }
      this.notifyConnection({ connected: false, mode: 'offline', detail: '' });
    }

    openWebSocket() {
      if (!this.wsTicket) {
        this.notifyConnection({ connected: false, mode: 'polling', detail: 'Live updates unavailable. Using refresh polling.' });
        return;
      }
      const proto = global.location.protocol === 'https:' ? 'wss:' : 'ws:';
      this.ws = new WebSocket(`${proto}//${global.location.host}/companion/ws?ticket=${this.wsTicket}`);
      this.ws.onopen = () => {
        this.notifyConnection({ connected: true, mode: 'live', detail: 'Live updates connected.' });
        if (this.onOpen) this.onOpen();
      };
      this.ws.onmessage = (event) => {
        try {
          if (this.onMessage) this.onMessage(JSON.parse(String(event.data)));
        } catch (_) {}
      };
      this.ws.onclose = () => {
        this.wsConnected = false;
        this.ws = null;
        this.notifyConnection({
          connected: false,
          mode: this.shouldReconnect ? 'polling' : 'offline',
          detail: this.shouldReconnect
            ? 'Live updates unavailable. Using refresh polling.'
            : ''
        });
        if (this.shouldReconnect) this.scheduleReconnect();
      };
      this.ws.onerror = () => {
        this.notifyConnection({
          connected: false,
          mode: 'polling',
          detail: 'Live updates unavailable. Using refresh polling.'
        });
      };
    }

    scheduleReconnect() {
      if (this.reconnectTimer) return;
      this.reconnectTimer = global.setTimeout(async () => {
        this.reconnectTimer = null;
        if (!this.shouldReconnect || !this.accessToken) return;
        try {
          const result = await this.getWsTicket();
          if (!result.success || !result.wsTicket) return;
          this.wsTicket = result.wsTicket;
          this.openWebSocket();
        } catch (_) {
          if (this.shouldReconnect) this.scheduleReconnect();
        }
      }, 4000);
    }
  }

  global.LocalAgentCompanionClient = CompanionBrowserClient;
})(window);

