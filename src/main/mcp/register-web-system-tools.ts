// @ts-nocheck
const { nativeFetch } = require('../net/native-fetch');
const FETCH_TIMEOUT_MS = 15000;
const MAX_FETCH_BYTES = 2 * 1024 * 1024;
const FETCH_PREVIEW_CHARS = 5000;
const MAX_FETCH_REDIRECTS = 3;
const INNER_BROWSER_DEFAULT_TIMEOUT_MS = 15000;
const INNER_BROWSER_DEFAULT_WAIT_UNTIL = 'networkidle';
const INNER_BROWSER_NETWORK_IDLE_MS = 700;
const INNER_BROWSER_IDLE_TTL_MS = 10 * 60 * 1000;
const INNER_BROWSER_MAX_SESSIONS = 4;
const INNER_BROWSER_DEFAULT_MAX_CHARS = 30000;
const INNER_BROWSER_MAX_HTML_CHARS = 250000;
const INNER_BROWSER_QUERY_HTML_CHARS = 4000;
const INNER_BROWSER_LINK_LIMIT = 100;
const INNER_BROWSER_MATCH_LIMIT = 50;
const TEXT_LIKE_CONTENT_TYPES = new Set([
  'application/atom+xml',
  'application/javascript',
  'application/json',
  'application/ld+json',
  'application/problem+json',
  'application/rss+xml',
  'application/x-javascript',
  'application/x-ndjson',
  'application/xhtml+xml',
  'application/xml',
  'application/yaml',
  'application/yml'
]);
const INNER_BROWSER_INLINE_PROTOCOLS = new Set(['about:', 'blob:', 'chrome-error:', 'data:']);
function parseIpv4(ip) {
  const parts = String(ip || '').split('.').map(part => Number(part));
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return parts;
}
function isPrivateIpv4(ip) {
  const parts = parseIpv4(ip);
  if (!parts) return false;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && (b === 0 || b === 168)) return true;
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return true;
  if (a === 203 && b === 0) return true;
  if (a >= 224) return true;
  return false;
}
function isPrivateIpv6(ip) {
  const normalized = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!normalized) return false;
  const mappedIpv4 = /(?:^|:)ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mappedIpv4) return isPrivateIpv4(mappedIpv4[1]);
  if (normalized === '::' || normalized === '::1') return true;
  const first = parseInt(normalized.split(':')[0] || '0', 16);
  if (!Number.isFinite(first)) return false;
  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xffc0) === 0xfe80) return true;
  if ((first & 0xff00) === 0xff00) return true;
  return false;
}
function isPrivateIpAddress(ip) {
  const net = require('net');
  const normalized = String(ip || '').replace(/^\[|\]$/g, '');
  const family = net.isIP(normalized);
  if (family === 4) return isPrivateIpv4(normalized);
  if (family === 6) return isPrivateIpv6(normalized);
  return false;
}
async function assertFetchableUrl(input) {
  const dns = require('dns').promises;
  const parsed = new URL(String(input || ''));
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('fetch_url only supports http and https URLs');
  }
  const hostname = String(parsed.hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname) {
    throw new Error('fetch_url requires a hostname');
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('fetch_url cannot target localhost addresses');
  }
  const net = require('net');
  const literalFamily = net.isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(entry => isPrivateIpAddress(entry.address))) {
    throw new Error('fetch_url cannot target private, local, or reserved network addresses');
  }
  return parsed.toString();
}
function isFetchContentTypeAllowed(contentType = '') {
  const type = String(contentType || '').split(';', 1)[0].trim().toLowerCase();
  if (!type) return true;
  return type.startsWith('text/')
    || TEXT_LIKE_CONTENT_TYPES.has(type)
    || type.endsWith('+json')
    || type.endsWith('+xml');
}
function assertFetchContentTypeAllowed(response) {
  const contentType = response?.headers?.get?.('content-type') || '';
  if (!isFetchContentTypeAllowed(contentType)) {
    throw new Error(`fetch_url refused non-text content type: ${contentType}`);
  }
}
async function fetchWithPolicy(fetch, inputUrl, options = {}) {
  let currentUrl = await assertFetchableUrl(inputUrl);
  let method = String(options.method || 'GET').toUpperCase();
  for (let redirectCount = 0; redirectCount <= MAX_FETCH_REDIRECTS; redirectCount++) {
    const response = await fetch(currentUrl, {
      ...options,
      method,
      redirect: 'manual'
    });
    const location = response?.headers?.get?.('location') || '';
    if (response.status >= 300 && response.status < 400 && location) {
      if (redirectCount >= MAX_FETCH_REDIRECTS) {
        throw new Error(`fetch_url exceeded ${MAX_FETCH_REDIRECTS} redirects`);
      }
      const nextUrl = new URL(location, currentUrl).toString();
      currentUrl = await assertFetchableUrl(nextUrl);
      if ([301, 302, 303].includes(response.status)) {
        method = 'GET';
      }
      continue;
    }
    assertFetchContentTypeAllowed(response);
    return { response, url: currentUrl, redirectCount };
  }
  throw new Error(`fetch_url exceeded ${MAX_FETCH_REDIRECTS} redirects`);
}
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
function clampNumber(value, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback = min } = {}) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.round(numeric)));
}
function trimText(value, maxChars = INNER_BROWSER_DEFAULT_MAX_CHARS) {
  const text = String(value ?? '');
  if (text.length <= maxChars) return { value: text, truncated: false };
  return { value: text.slice(0, maxChars), truncated: true };
}
function normalizeWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}
function normalizeSessionId(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}
function normalizeWaitUntil(value, selector = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return selector ? 'selector' : INNER_BROWSER_DEFAULT_WAIT_UNTIL;
  if (['none', 'domcontentloaded', 'load', 'networkidle', 'selector'].includes(normalized)) {
    return normalized;
  }
  return selector ? 'selector' : INNER_BROWSER_DEFAULT_WAIT_UNTIL;
}

function canDeliverViewerContent(server) {
  return server?._uiMode?.noWindow !== true && server?._windowManager?.hasMainWindow?.() !== false;
}
function getInnerBrowserElectronApi() {
  try {
    const electron = require('electron');
    return electron && typeof electron === 'object' ? electron : null;
  } catch (_) {
    return null;
  }
}
function createInnerBrowserUnavailableError() {
  return new Error('inner_browser requires an Electron main-process runtime with BrowserWindow support');
}
class InnerBrowserService {
  constructor(server) {
    this.server = server;
    this.sessions = new Map();
    this.innerWindowIds = new Set();
    this.hostWindows = new Map();
    this.requestPolicyCache = new Map();
    this._electron = null;
    this._boundBeforeQuit = false;
  }
  async run(params = {}, toolRuntime = {}) {
    await this._cleanupExpiredSessions();
    this._syncHostWindowWatchers();
    const action = String(params.action || '').trim().toLowerCase();
    if (!action) {
      throw new Error('inner_browser requires an action');
    }
    if (action === 'session') {
      return this._handleSessionAction(params, toolRuntime);
    }
    if (action === 'extract') {
      return this._withActionSession(params, toolRuntime, async (entry) => this._extract(entry, params));
    }
    if (action === 'query') {
      return this._withActionSession(params, toolRuntime, async (entry) => this._query(entry, params));
    }
    if (action === 'dom') {
      return this._withActionSession(params, toolRuntime, async (entry) => this._dom(entry, params));
    }
    if (action === 'render') {
      return this._withActionSession(params, toolRuntime, async (entry) => this._render(entry, params, toolRuntime));
    }
    throw new Error(`Unsupported inner_browser action: ${params.action}`);
  }
  _getTimeoutMs(params = {}, toolRuntime = {}) {
    const toolTimeout = Number(toolRuntime?.timeoutMs) || INNER_BROWSER_DEFAULT_TIMEOUT_MS;
    return clampNumber(params.timeout_ms, {
      min: 1000,
      max: 120000,
      fallback: Math.max(toolTimeout, INNER_BROWSER_DEFAULT_TIMEOUT_MS)
    });
  }
  _generateSessionId(prefix = 'browser') {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
  _ensureElectron() {
    if (!this._electron) {
      this._electron = getInnerBrowserElectronApi();
    }
    const BrowserWindow = this._electron?.BrowserWindow;
    if (!BrowserWindow || typeof BrowserWindow !== 'function') {
      throw createInnerBrowserUnavailableError();
    }
    if (this._electron?.app?.on && !this._boundBeforeQuit) {
      this._electron.app.on('before-quit', () => {
        void this.destroyAllSessions();
      });
      this._boundBeforeQuit = true;
    }
    return this._electron;
  }  _syncHostWindowWatchers() {
    const BrowserWindow = this._ensureElectron().BrowserWindow;
    const windows = typeof BrowserWindow.getAllWindows === 'function'
      ? BrowserWindow.getAllWindows()
      : [];
    for (const win of windows) {
      if (!win || this.innerWindowIds.has(win.id) || this.hostWindows.has(win.id)) continue;
      this.hostWindows.set(win.id, win);
      if (typeof win.on === 'function') {
        win.on('closed', () => {
          this.hostWindows.delete(win.id);
          if (this.hostWindows.size === 0) {
            void this.destroyAllSessions();
          }
        });
      }
    }
  }
  async _cleanupExpiredSessions() {
    const now = Date.now();
    const expiredIds = [];
    for (const [sessionId, entry] of this.sessions) {
      if (!entry.persistent) continue;
      if (now - entry.touchedAt > INNER_BROWSER_IDLE_TTL_MS) {
        expiredIds.push(sessionId);
      }
    }
    for (const sessionId of expiredIds) {
      await this._destroySession(sessionId);
    }
  }
  _touch(entry) {
    if (!entry) return;
    entry.touchedAt = Date.now();
  }
  async _createSession({ sessionId, sessionName = '', persistent = true } = {}) {
    const normalizedSessionId = normalizeSessionId(sessionId) || this._generateSessionId();
    const existing = this.sessions.get(normalizedSessionId);
    if (existing) return existing;
    if (persistent && this.sessions.size >= INNER_BROWSER_MAX_SESSIONS) {
      throw new Error(`inner_browser reached the session limit (${INNER_BROWSER_MAX_SESSIONS})`);
    }
    const { BrowserWindow } = this._ensureElectron();
    const win = new BrowserWindow({
      show: false,
      width: 1365,
      height: 900,
      paintWhenInitiallyHidden: false,
      skipTaskbar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
        partition: `inner-browser-${normalizedSessionId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      }
    });
    if (typeof win.setMenuBarVisibility === 'function') {
      win.setMenuBarVisibility(false);
    }
    if (typeof win.webContents?.setWindowOpenHandler === 'function') {
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    }
    const entry = { id: normalizedSessionId, name: String(sessionName || normalizedSessionId), persistent, createdAt: Date.now(), touchedAt: Date.now(), window: win, lastUrl: 'about:blank', lastTitle: '' };
    this.sessions.set(normalizedSessionId, entry);
    if (win.id !== undefined && win.id !== null) {
      this.innerWindowIds.add(win.id);
    }
    if (typeof win.on === 'function') {
      win.on('closed', () => {
        this.innerWindowIds.delete(win.id);
        const current = this.sessions.get(normalizedSessionId);
        if (current === entry) {
          this.sessions.delete(normalizedSessionId);
        }
      });
    }
    if (typeof win.webContents?.on === 'function') {
      win.webContents.on('page-title-updated', (_event, title) => {
        entry.lastTitle = String(title || '');
      });
      win.webContents.on('did-navigate', (_event, url) => {
        entry.lastUrl = String(url || entry.lastUrl || 'about:blank');
      });
      win.webContents.on('did-navigate-in-page', (_event, url) => {
        entry.lastUrl = String(url || entry.lastUrl || 'about:blank');
      });
    }
    this._installRequestPolicy(entry);
    this._syncHostWindowWatchers();
    return entry;
  }
  _installRequestPolicy(entry) {
    const ses = entry?.window?.webContents?.session;
    if (!ses || entry.requestPolicyInstalled) return;
    entry.requestPolicyInstalled = true;
    if (typeof ses.setPermissionRequestHandler === 'function') {
      ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    }
    if (typeof ses.setPermissionCheckHandler === 'function') {
      ses.setPermissionCheckHandler(() => false);
    }
    if (ses.webRequest?.onBeforeRequest) {
      ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
        this._isRequestAllowed(details.url)
          .then(allowed => callback({ cancel: !allowed }))
          .catch(() => callback({ cancel: true }));
      });
    }
  }
  async _isRequestAllowed(rawUrl) {
    let parsed;
    try {
      parsed = new URL(String(rawUrl || ''));
    } catch (_) {
      return false;
    }
    if (INNER_BROWSER_INLINE_PROTOCOLS.has(parsed.protocol)) {
      return true;
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return false;
    }
    const originKey = `${parsed.protocol}//${parsed.host}`.toLowerCase();
    if (!this.requestPolicyCache.has(originKey)) {
      this.requestPolicyCache.set(originKey, assertFetchableUrl(originKey)
        .then(() => true)
        .catch(() => false));
    }
    return this.requestPolicyCache.get(originKey);
  }
  async _withActionSession(params, toolRuntime, action) {
    const requestedSessionId = normalizeSessionId(params.sessionId);
    const timeoutMs = this._getTimeoutMs(params, toolRuntime);
    let entry = null;
    let ephemeral = false;
    try {
      if (requestedSessionId) {
        entry = this.sessions.get(requestedSessionId) || null;
        if (!entry) {
          if (!params.url) {
            throw new Error(`inner_browser session not found: ${requestedSessionId}`);
          }
          entry = await this._createSession({
            sessionId: requestedSessionId,
            sessionName: params.session_name || requestedSessionId,
            persistent: true
          });
        }
      } else {
        const url = String(params.url || '').trim();
        if (!url) {
          throw new Error(`inner_browser ${params.action} requires either sessionId or url`);
        }
        entry = await this._createSession({
          sessionId: this._generateSessionId('temp-browser'),
          sessionName: params.session_name || 'Ephemeral browser session',
          persistent: false
        });
        ephemeral = true;
      }
      if (params.url) {
        await this._goto(entry, params.url, {
          waitUntil: normalizeWaitUntil(params.wait_until, params.selector),
          selector: params.selector,
          timeoutMs
        });
      } else if (params.wait_until && String(params.wait_until).trim().toLowerCase() !== 'none') {
        await this._wait(entry, {
          waitUntil: normalizeWaitUntil(params.wait_until, params.selector),
          selector: params.selector,
          timeoutMs
        });
      }
      return action(entry, timeoutMs);
    } finally {
      if (ephemeral && entry) {
        await this._destroySession(entry.id);
      }
    }
  }
  async _handleSessionAction(params, toolRuntime) {
    const sessionAction = String(params.session_action || 'status').trim().toLowerCase();
    const requestedSessionId = normalizeSessionId(params.sessionId);
    const timeoutMs = this._getTimeoutMs(params, toolRuntime);
    if (sessionAction === 'list' || (sessionAction === 'status' && !requestedSessionId)) {
      const sessions = [];
      for (const entry of this.sessions.values()) {
        sessions.push(await this._sessionSnapshot(entry));
      }
      return { action: 'session', sessionAction: 'list', sessionCount: sessions.length, sessions };
    }
    if (sessionAction === 'open') {
      const sessionId = requestedSessionId || this._generateSessionId();
      const entry = await this._createSession({
        sessionId,
        sessionName: params.session_name || sessionId,
        persistent: true
      });
      if (params.url) {
        await this._goto(entry, params.url, {
          waitUntil: normalizeWaitUntil(params.wait_until, params.selector),
          selector: params.selector,
          timeoutMs
        });
      }
      return { action: 'session', sessionAction: 'open', opened: true, ...(await this._sessionSnapshot(entry)) };
    }
    const entry = this.sessions.get(requestedSessionId || '');
    if (!entry) {
      throw new Error(`inner_browser session not found: ${requestedSessionId || '(missing sessionId)'}`);
    }    if (sessionAction === 'status') {
      return { action: 'session', sessionAction: 'status', ...(await this._sessionSnapshot(entry)) };
    }
    if (sessionAction === 'close') {
      await this._destroySession(entry.id);
      return { action: 'session', sessionAction: 'close', sessionId: entry.id, closed: true };
    }
    if (sessionAction === 'goto') {
      if (!params.url) {
        throw new Error('inner_browser session goto requires url');
      }
      const page = await this._goto(entry, params.url, {
        waitUntil: normalizeWaitUntil(params.wait_until, params.selector),
        selector: params.selector,
        timeoutMs
      });
      return { action: 'session', sessionAction: 'goto', sessionId: entry.id, page };
    }
    if (sessionAction === 'wait') {
      const page = await this._wait(entry, {
        waitUntil: normalizeWaitUntil(params.wait_until, params.selector),
        selector: params.selector,
        timeoutMs
      });
      return { action: 'session', sessionAction: 'wait', sessionId: entry.id, page };
    }
    if (sessionAction === 'click') {
      const clickResult = await this._click(entry, params.selector, timeoutMs);
      if (params.wait_until && String(params.wait_until).trim().toLowerCase() !== 'none') {
        await this._wait(entry, {
          waitUntil: normalizeWaitUntil(params.wait_until, params.selector),
          selector: params.selector,
          timeoutMs
        });
      }
      return { action: 'session', sessionAction: 'click', sessionId: entry.id, result: clickResult, page: await this._getPageInfo(entry) };
    }
    if (sessionAction === 'type') {
      const typeResult = await this._type(entry, params.selector, params.text);
      return { action: 'session', sessionAction: 'type', sessionId: entry.id, result: typeResult, page: await this._getPageInfo(entry) };
    }
    if (sessionAction === 'press') {
      const pressResult = await this._press(entry, params.key);
      if (params.wait_until && String(params.wait_until).trim().toLowerCase() !== 'none') {
        await this._wait(entry, {
          waitUntil: normalizeWaitUntil(params.wait_until, params.selector),
          selector: params.selector,
          timeoutMs
        });
      }
      return { action: 'session', sessionAction: 'press', sessionId: entry.id, result: pressResult, page: await this._getPageInfo(entry) };
    }
    throw new Error(`Unsupported inner_browser session action: ${params.session_action}`);
  }
  async _goto(entry, url, { waitUntil = INNER_BROWSER_DEFAULT_WAIT_UNTIL, selector = '', timeoutMs = INNER_BROWSER_DEFAULT_TIMEOUT_MS } = {}) {
    const safeUrl = await assertFetchableUrl(url);
    this._touch(entry);
    await this._withTimeout(
      Promise.resolve(entry.window.loadURL(safeUrl, { userAgent: 'LocalAgent/1.0 inner_browser' })),
      timeoutMs,
      `inner_browser navigation to ${safeUrl}`
    );
    entry.lastUrl = safeUrl;
    return this._wait(entry, { waitUntil, selector, timeoutMs });
  }
  async _wait(entry, { waitUntil = INNER_BROWSER_DEFAULT_WAIT_UNTIL, selector = '', timeoutMs = INNER_BROWSER_DEFAULT_TIMEOUT_MS } = {}) {
    const normalizedWait = normalizeWaitUntil(waitUntil, selector);
    if (normalizedWait === 'none') {
      return this._getPageInfo(entry);
    }
    if (normalizedWait === 'selector') {
      if (!selector) {
        throw new Error('inner_browser selector wait requires selector');
      }
      await this._waitForSelector(entry, selector, timeoutMs);
      return this._getPageInfo(entry);
    }
    if (normalizedWait === 'domcontentloaded') {
      await this._waitForReadyState(entry, 'interactive', timeoutMs);
      return this._getPageInfo(entry);
    }
    if (normalizedWait === 'load') {
      await this._waitForReadyState(entry, 'complete', timeoutMs);
      return this._getPageInfo(entry);
    }
    await this._waitForReadyState(entry, 'interactive', timeoutMs);
    await this._waitForNetworkIdle(entry, timeoutMs);
    return this._getPageInfo(entry);
  }
  async _waitForReadyState(entry, targetState, timeoutMs) {
    const targetOrder = { loading: 0, interactive: 1, complete: 2 };
    const deadline = Date.now() + timeoutMs;
    let lastState = 'loading';
    while (Date.now() <= deadline) {
      try {
        const state = await this._runScript(entry, 'document.readyState');
        lastState = String(state || 'loading').toLowerCase();
        if ((targetOrder[lastState] ?? -1) >= (targetOrder[targetState] ?? 1)) {
          return lastState;
        }
      } catch (_) {}
      await sleep(100);
    }
    throw new Error(`inner_browser wait timed out before readyState=${targetState} (last=${lastState})`);
  }
  async _waitForSelector(entry, selector, timeoutMs) {
    const serializedSelector = JSON.stringify(String(selector || ''));
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      try {
        const found = await this._runScript(entry, `Boolean(document.querySelector(${serializedSelector}))`);
        if (found) return true;
      } catch (_) {}
      await sleep(100);
    }
    throw new Error(`inner_browser selector wait timed out: ${selector}`);
  }
  async _waitForNetworkIdle(entry, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let quietSince = 0;
    while (Date.now() <= deadline) {
      let isLoading = false;
      try {
        isLoading = entry.window?.webContents?.isLoading?.() === true;
      } catch (_) {
        isLoading = false;
      }
      let readyState = 'loading';
      try {
        readyState = String(await this._runScript(entry, 'document.readyState') || 'loading').toLowerCase();
      } catch (_) {}
      if (!isLoading && readyState !== 'loading') {
        if (!quietSince) {
          quietSince = Date.now();
        }
        if (Date.now() - quietSince >= INNER_BROWSER_NETWORK_IDLE_MS) {
          return true;
        }
      } else {
        quietSince = 0;
      }
      await sleep(120);
    }
    throw new Error('inner_browser network idle wait timed out');
  }
  async _runScript(entry, script) {
    if (!entry?.window || (typeof entry.window.isDestroyed === 'function' && entry.window.isDestroyed())) {
      throw new Error(`inner_browser session is no longer available: ${entry?.id || 'unknown'}`);
    }
    this._touch(entry);
    return entry.window.webContents.executeJavaScript(String(script), true);
  }
  async _getPageInfo(entry) {
    try {
      const data = await this._runScript(entry, `(() => ({
        url: location.href,
        title: document.title || '',
        readyState: document.readyState || 'loading'
      }))()`);
      const page = { url: String(data?.url || entry.lastUrl || 'about:blank'), title: String(data?.title || entry.lastTitle || ''), readyState: String(data?.readyState || 'loading') };
      entry.lastUrl = page.url;
      entry.lastTitle = page.title;
      return page;
    } catch (_) {
      return { url: entry.lastUrl || 'about:blank', title: entry.lastTitle || '', readyState: 'unknown' };
    }
  }
  async _sessionSnapshot(entry) {
    return { sessionId: entry.id, sessionName: entry.name, persistent: entry.persistent, createdAt: new Date(entry.createdAt).toISOString(), lastTouchedAt: new Date(entry.touchedAt).toISOString(), page: await this._getPageInfo(entry) };
  }  async _click(entry, selector, timeoutMs) {
    const normalizedSelector = String(selector || '').trim();
    if (!normalizedSelector) {
      throw new Error('inner_browser session click requires selector');
    }
    await this._waitForSelector(entry, normalizedSelector, timeoutMs);
    const result = await this._runScript(entry, `(() => {
      const selector = ${JSON.stringify(normalizedSelector)};
      const el = document.querySelector(selector);
      if (!el) return { clicked: false, reason: 'selector not found' };
      if (typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'center', inline: 'center' });
      }
      const eventOptions = { bubbles: true, cancelable: true, view: window };
      for (const type of ['mouseover', 'mousedown', 'mouseup', 'click']) {
        el.dispatchEvent(new MouseEvent(type, eventOptions));
      }
      if (typeof el.click === 'function') {
        el.click();
      }
      return { clicked: true, tag: String(el.tagName || '').toLowerCase(), text: String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200) };
    })()`);
    if (!result?.clicked) {
      throw new Error(result?.reason || `inner_browser failed to click selector: ${normalizedSelector}`);
    }
    return result;
  }
  async _type(entry, selector, text) {
    const normalizedSelector = String(selector || '').trim();
    if (!normalizedSelector) {
      throw new Error('inner_browser session type requires selector');
    }
    const value = String(text ?? '');
    const result = await this._runScript(entry, `(() => {
      const selector = ${JSON.stringify(normalizedSelector)};
      const value = ${JSON.stringify(value)};
      const el = document.querySelector(selector);
      if (!el) return { typed: false, reason: 'selector not found' };
      if (typeof el.focus === 'function') {
        el.focus();
      }
      if (el.isContentEditable) {
        el.textContent = value;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
        return { typed: true, tag: String(el.tagName || '').toLowerCase(), length: value.length };
      }
      if (!('value' in el)) {
        return { typed: false, reason: 'element is not editable', tag: String(el.tagName || '').toLowerCase() };
      }
      el.value = value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { typed: true, tag: String(el.tagName || '').toLowerCase(), length: value.length };
    })()`);
    if (!result?.typed) {
      throw new Error(result?.reason || `inner_browser failed to type into selector: ${normalizedSelector}`);
    }
    return result;
  }
  async _press(entry, key) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) {
      throw new Error('inner_browser session press requires key');
    }
    return this._runScript(entry, `(() => {
      const key = ${JSON.stringify(normalizedKey)};
      const target = document.activeElement || document.body || document.documentElement;
      for (const type of ['keydown', 'keypress', 'keyup']) {
        target.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true }));
      }
      if (key === 'Enter' && target?.form && typeof target.form.requestSubmit === 'function') {
        target.form.requestSubmit();
      }
      return { pressed: true, key, target: String(target?.tagName || 'document').toLowerCase() };
    })()`);
  }
  async _extract(entry, params) {
    const format = String(params.format || 'text').trim().toLowerCase();
    const maxChars = clampNumber(params.max_chars, {
      min: 250,
      max: INNER_BROWSER_MAX_HTML_CHARS,
      fallback: INNER_BROWSER_DEFAULT_MAX_CHARS
    });
    if (format === 'html') {
      const html = await this._runScript(entry, `document.documentElement ? String(document.documentElement.outerHTML || '').slice(0, ${maxChars}) : ''`);
      return { action: 'extract', format: 'html', sessionId: entry.id, page: await this._getPageInfo(entry), truncated: String(html || '').length >= maxChars, content: String(html || '') };
    }
    if (format === 'links') {
      const limit = clampNumber(params.limit, {
        min: 1,
        max: INNER_BROWSER_LINK_LIMIT,
        fallback: 25
      });
      const links = await this._runScript(entry, `(() => {
        const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        return Array.from(document.querySelectorAll('a[href]'))
          .map((node) => ({
            text: normalize(node.innerText || node.textContent || ''),
            href: String(node.href || ''),
            title: normalize(node.getAttribute('title') || '')
          }))
          .filter((item) => item.href)
          .slice(0, ${limit});
      })()`);
      return { action: 'extract', format: 'links', sessionId: entry.id, page: await this._getPageInfo(entry), count: Array.isArray(links) ? links.length : 0, content: Array.isArray(links) ? links : [] };
    }
    if (format === 'json') {
      const payload = await this._runScript(entry, `(() => {
        const raw = document.body ? String(document.body.innerText || document.body.textContent || '') : '';
        try {
          return { ok: true, value: JSON.parse(raw) };
        } catch (error) {
          return { ok: false, error: String(error?.message || error || 'Failed to parse JSON'), raw: raw.slice(0, ${maxChars}) };
        }
      })()`);
      return { action: 'extract', format: 'json', sessionId: entry.id, page: await this._getPageInfo(entry), content: payload?.ok ? payload.value : null, raw: payload?.ok ? '' : String(payload?.raw || ''), error: payload?.ok ? '' : String(payload?.error || '') };
    }
    if (format === 'metadata') {
      const content = await this._runScript(entry, `(() => ({
        title: document.title || '',
        description: document.querySelector('meta[name="description"]')?.content || '',
        canonicalUrl: document.querySelector('link[rel="canonical"]')?.href || location.href,
        headings: Array.from(document.querySelectorAll('h1, h2')).slice(0, 10).map((node) => String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim())
      }))()`);
      return { action: 'extract', format: 'metadata', sessionId: entry.id, page: await this._getPageInfo(entry), content };
    }
    const text = await this._runScript(entry, `(() => {
      const raw = document.body ? (document.body.innerText || document.body.textContent || '') : '';
      return String(raw || '').slice(0, ${maxChars});
    })()`);
    const normalizedText = trimText(normalizeWhitespace(text), maxChars);
    return { action: 'extract', format: 'text', sessionId: entry.id, page: await this._getPageInfo(entry), truncated: normalizedText.truncated, content: normalizedText.value };
  }
  async _query(entry, params) {
    const selector = String(params.selector || '').trim();
    if (!selector) {
      throw new Error('inner_browser query requires selector');
    }
    const limit = clampNumber(params.limit, {
      min: 1,
      max: INNER_BROWSER_MATCH_LIMIT,
      fallback: 10
    });
    const includeText = params.include_text !== false;
    const includeHtml = params.include_html === true;
    const attribute = String(params.attribute || '').trim();
    const matches = await this._runScript(entry, `(() => {
      const selector = ${JSON.stringify(selector)};
      const attribute = ${JSON.stringify(attribute)};
      const includeText = ${includeText ? 'true' : 'false'};
      const includeHtml = ${includeHtml ? 'true' : 'false'};
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      return Array.from(document.querySelectorAll(selector)).slice(0, ${limit}).map((node, index) => ({
        index,
        tag: String(node.tagName || '').toLowerCase(),
        text: includeText ? normalize(node.innerText || node.textContent || '') : '',
        html: includeHtml ? String(node.outerHTML || '').slice(0, ${INNER_BROWSER_QUERY_HTML_CHARS}) : '',
        value: attribute ? String(node.getAttribute(attribute) || '') : '',
        href: typeof node.href === 'string' ? node.href : '',
        src: typeof node.src === 'string' ? node.src : ''
      }));
    })()`);
    return { action: 'query', sessionId: entry.id, selector, count: Array.isArray(matches) ? matches.length : 0, matches: Array.isArray(matches) ? matches : [], page: await this._getPageInfo(entry) };
  }  async _dom(entry, params) {
    const selector = String(params.selector || '').trim();
    const format = String(params.format || 'outer_html').trim().toLowerCase();
    const maxChars = clampNumber(params.max_chars, {
      min: 250,
      max: INNER_BROWSER_MAX_HTML_CHARS,
      fallback: INNER_BROWSER_DEFAULT_MAX_CHARS
    });
    const result = await this._runScript(entry, `(() => {
      const selector = ${JSON.stringify(selector)};
      const mode = ${JSON.stringify(format)};
      const node = selector ? document.querySelector(selector) : document.documentElement;
      if (!node) return { found: false };
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      if (mode === 'text') {
        return { found: true, value: normalize(node.innerText || node.textContent || '') };
      }
      if (mode === 'inner_html') {
        return { found: true, value: String(node.innerHTML || '').slice(0, ${maxChars}) };
      }
      return { found: true, value: String(node.outerHTML || '').slice(0, ${maxChars}) };
    })()`);
    if (!result?.found) {
      throw new Error(selector ? `inner_browser selector not found: ${selector}` : 'inner_browser DOM target not found');
    }
    const normalized = format === 'text'
      ? trimText(String(result.value || ''), maxChars)
      : { value: String(result.value || ''), truncated: String(result.value || '').length >= maxChars };
    return { action: 'dom', sessionId: entry.id, selector: selector || 'document.documentElement', format, truncated: normalized.truncated, content: normalized.value, page: await this._getPageInfo(entry) };
  }
  async _render(entry, params, toolRuntime) {
    const renderMode = String(params.format || 'snapshot').trim().toLowerCase();
    const maxChars = clampNumber(params.max_chars, {
      min: 500,
      max: INNER_BROWSER_MAX_HTML_CHARS,
      fallback: 60000
    });
    const page = await this._getPageInfo(entry);
    const title = String(params.title || page.title || page.url || entry.id || 'Browser Page');
    const sourceSessionId = toolRuntime?.context?.sessionId !== undefined && toolRuntime?.context?.sessionId !== null
      ? toolRuntime.context.sessionId
      : (this.server.getCurrentSessionId?.() || 'default');
    const sourceAgentId = toolRuntime?.context?.agentId ?? 'agent';
    const previewText = await this._runScript(entry, `(() => {
      const raw = document.body ? (document.body.innerText || document.body.textContent || '') : '';
      return String(raw || '').slice(0, ${Math.min(maxChars, 4000)});
    })()`);
    const uiRendered = canDeliverViewerContent(this.server);
    let content;
    if (renderMode === 'url' && /^https?:/i.test(page.url || '')) {
      content = { type: 'url', title, url: page.url, sourceAgentId, sourceSessionId };
    } else if (renderMode === 'text') {
      const textContent = trimText(previewText, maxChars).value;
      content = { type: 'text', title, content: textContent, text: textContent, sourceAgentId, sourceSessionId };
    } else {
      const html = await this._runScript(entry, `document.documentElement ? String(document.documentElement.outerHTML || '').slice(0, ${maxChars}) : ''`);
      content = { type: 'html', title, html: String(html || ''), content: String(html || ''), sourceAgentId, sourceSessionId };
    }
    const viewerContent = uiRendered ? content : null;
    if (this.server._artifactRegistry) {
      this.server._artifactRegistry.registerVirtual(String(sourceSessionId || 'default'), {
        name: title,
        kind: 'browser',
        source: 'inner_browser',
        data: {
          sessionId: entry.id,
          url: page.url,
          title
        }
      });
    }
    return { action: 'render', format: renderMode, sessionId: entry.id, page, preview: trimText(normalizeWhitespace(previewText), 2000).value, content, viewerContent, uiRendered };
  }
  async _destroySession(sessionId) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return false;
    this.sessions.delete(sessionId);
    const win = entry.window;
    if (win?.id !== undefined && win?.id !== null) {
      this.innerWindowIds.delete(win.id);
    }
    try {
      if (win && typeof win.isDestroyed === 'function' && !win.isDestroyed()) {
        win.destroy();
      }
    } catch (_) {}
    return true;
  }
  async destroyAllSessions() {
    const sessionIds = [...this.sessions.keys()];
    for (const sessionId of sessionIds) {
      await this._destroySession(sessionId);
    }
  }
  async _withTimeout(promise, timeoutMs, label) {
    let timeoutId = null;
    try {
      return await Promise.race([
        Promise.resolve(promise),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
        })
      ]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }
}
function getInnerBrowserService(server) {
  if (!server._innerBrowserService) {
    server._innerBrowserService = new InnerBrowserService(server);
  }
  return server._innerBrowserService;
}
function registerWebSystemTools(server) {
  server.registerTool('fetch_url', {
    name: 'fetch_url',
    description: 'Fetch raw content from a URL with bounded time and response size. Returns truncated response text and stores the bounded response in a temp file.',
    userDescription: 'Retrieves raw content from a web page or API endpoint',
    example: 'TOOL:fetch_url{"url":"https://example.com"}',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch' },
        method: { type: 'string', description: 'HTTP method (GET, POST, etc.)', default: 'GET' }
      },
      required: ['url']
    }
  }, async (params) => {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const method = String(params.method || 'GET').toUpperCase();
    const { response, url, redirectCount } = await fetchWithPolicy(nativeFetch, params.url, {
      method,
      timeout: FETCH_TIMEOUT_MS,
      size: MAX_FETCH_BYTES,
      headers: { 'User-Agent': 'LocalAgent/1.0' }
    });
    const text = await response.text();
    try {
      const sessionId = server.getCurrentSessionId?.() || 'default';
      const workDir = server._sessionWorkspace?.getWorkspacePath?.(sessionId) || os.tmpdir();
      const lastFetchedPath = path.join(workDir, 'last_fetched.txt');
      fs.writeFileSync(lastFetchedPath, text, 'utf-8');
      server._lastFetchedPath = lastFetchedPath;
      server._lastFetchedUrl = params.url;
      if (server._artifactRegistry) {
        server._artifactRegistry.registerFile(sessionId, {
          name: 'last_fetched.txt',
          path: lastFetchedPath,
          source: 'fetch_url',
          category: 'data'
        });
      }
    } catch (error) {
      console.error('[fetch_url] Failed to persist fetched content:', error.message);
    }
    return { url, status: response.status, redirects: redirectCount, content: text.substring(0, FETCH_PREVIEW_CHARS) };
  });  server.registerTool('inner_browser', {
    name: 'inner_browser',
    description: 'Hidden stateful browser for JS-heavy web pages. Runs headless by default and only sends content to the visible Content Viewer when render is requested. Actions: session, extract, query, dom, render.',
    userDescription: 'Uses a hidden browser session for dynamic web pages and optional viewer rendering',
    example: 'TOOL:inner_browser{"action":"extract","url":"https://example.com","format":"text"}',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Action: session | extract | query | dom | render' },
        session_action: { type: 'string', description: 'For action=session: open | status | list | goto | wait | click | type | press | close', default: 'status' },
        sessionId: { type: 'string', description: 'Optional persistent hidden browser session id' },
        session_name: { type: 'string', description: 'Optional label for the browser session' },
        url: { type: 'string', description: 'HTTP(S) URL to open or navigate to' },
        selector: { type: 'string', description: 'CSS selector used by query, dom, click, type, or selector waits' },
        attribute: { type: 'string', description: 'Attribute name to include in query results, such as href or data-id' },
        text: { type: 'string', description: 'Text to type for session_action=type' },
        key: { type: 'string', description: 'Keyboard key for session_action=press, such as Enter or Escape' },
        title: { type: 'string', description: 'Optional title override for render output' },
        format: { type: 'string', description: 'Output mode. extract: text | html | links | json | metadata. dom: outer_html | inner_html | text. render: snapshot | url | text.', default: 'text' },
        wait_until: { type: 'string', description: 'Wait mode: none | domcontentloaded | load | networkidle | selector', default: 'networkidle' },
        limit: { type: 'number', description: 'Maximum result count for query or link extraction', default: 10 },
        timeout_ms: { type: 'number', description: 'Requested timeout for this browser action in milliseconds', default: INNER_BROWSER_DEFAULT_TIMEOUT_MS },
        max_chars: { type: 'number', description: 'Maximum returned character count for text/html payloads', default: INNER_BROWSER_DEFAULT_MAX_CHARS },
        include_text: { type: 'boolean', description: 'Include normalized text in query results', default: true },
        include_html: { type: 'boolean', description: 'Include HTML snippets in query results', default: false }
      },
      required: ['action']
    }
  }, async (params, toolRuntime = {}) => {
    const browser = getInnerBrowserService(server);
    return browser.run(params, toolRuntime);
  });
}
module.exports = { InnerBrowserService, assertFetchableUrl, createInnerBrowserUnavailableError, fetchWithPolicy, getInnerBrowserService, isFetchContentTypeAllowed, isPrivateIpAddress, registerWebSystemTools };
