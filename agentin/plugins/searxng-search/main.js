'use strict';
// scaffold-managed:searxng-search

const http = require('http');
const { spawn } = require('child_process');

const DEFAULT_DISCOVERY_URLS = [
  'https://searx.be',
  'https://search.sapti.me'
];

const RUNTIME = {
  server: null,
  host: '127.0.0.1',
  port: null,
  startedAt: null,
  preferredInstance: null,
  lastDiscovery: null,
  context: null,
  backend: {
    process: null,
    pid: null,
    unregister: null,
    startedAt: null,
    command: '',
    args: [],
    ready: false,
    lastError: null
  }
};

function normalizeBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function parseBool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') return false;
  return fallback;
}

function parseNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function parseDiscoveryUrls(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  return text
    .split(/[,\n]/g)
    .map((entry) => normalizeBaseUrl(entry))
    .filter(Boolean);
}

function splitArgs(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  const parts = [];
  const regex = /[^\s"]+|"([^"]*)"/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    parts.push(match[1] != null ? match[1] : match[0]);
  }
  return parts;
}

function getBackendConfig(context) {
  return {
    mode: String(context.getConfig('backendMode') || 'embedded').trim().toLowerCase(),
    autoStart: parseBool(context.getConfig('backendAutoStart'), true),
    command: String(context.getConfig('backendCommand') || '').trim(),
    args: splitArgs(context.getConfig('backendArgs')),
    cwd: String(context.getConfig('backendWorkingDir') || '').trim(),
    baseUrl: normalizeBaseUrl(context.getConfig('backendBaseUrl') || 'http://127.0.0.1:8080'),
    healthPath: String(context.getConfig('backendHealthPath') || '/search?q=healthcheck&format=json').trim(),
    startupTimeoutMs: parseNumber(context.getConfig('backendStartupTimeoutMs'), 25000)
  };
}

async function isBackendHealthy(baseUrl, healthPath, timeoutMs) {
  const url = new URL(healthPath || '/search?q=healthcheck&format=json', baseUrl).toString();
  try {
    await fetchWithTimeout(url, Math.max(1000, timeoutMs), 'json', 0);
    return true;
  } catch (_) {
    return false;
  }
}

function getDiscoveryCandidates(context) {
  const configuredBase = normalizeBaseUrl(context.getConfig('baseUrl'));
  const configuredList = parseDiscoveryUrls(context.getConfig('discoveryUrls'));
  const merged = [];

  if (configuredBase) merged.push(configuredBase);
  configuredList.forEach((url) => {
    if (!merged.includes(url)) merged.push(url);
  });
  DEFAULT_DISCOVERY_URLS.forEach((url) => {
    if (!merged.includes(url)) merged.push(url);
  });

  return merged;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanText(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseRequestQuery(reqUrl) {
  const requestUrl = new URL(reqUrl, 'http://127.0.0.1');
  return {
    query: requestUrl.searchParams.get('q') || requestUrl.searchParams.get('query') || '',
    language: requestUrl.searchParams.get('language') || '',
    safe_search: requestUrl.searchParams.get('safe_search') || requestUrl.searchParams.get('safesearch') || '',
    max_results: requestUrl.searchParams.get('max_results') || '',
    pageno: requestUrl.searchParams.get('pageno') || ''
  };
}

function writeJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function fetchWithTimeout(url, timeoutMs, expectedType, retryCount) {
  const retries = Math.max(0, parseNumber(retryCount, 0));
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept': expectedType === 'json'
            ? 'application/json,text/javascript,*/*;q=0.8'
            : 'text/html,application/xhtml+xml,*/*;q=0.8'
        }
      });

      if (!response.ok) {
        throw new Error('HTTP ' + response.status);
      }

      if (expectedType === 'json') {
        return await response.json();
      }
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await sleep(250 * (attempt + 1));
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error('Request failed');
}

function parseHtmlResults(html, limit) {
  const results = [];
  const seen = new Set();
  const linkRegex = /<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = linkRegex.exec(html)) !== null && results.length < limit) {
    const url = String(match[1] || '').trim();
    const title = cleanText(match[2] || '');
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    results.push({
      title,
      url,
      snippet: '',
      engines: ['searxng-html']
    });
  }

  return results;
}

function parseDuckDuckGoHtmlResults(html, limit) {
  const results = [];
  const seen = new Set();
  const itemRegex = /<a[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = itemRegex.exec(html)) !== null && results.length < limit) {
    const rawUrl = String(match[1] || '').trim();
    const title = cleanText(match[2] || '');
    if (!rawUrl || !title) continue;

    let url = rawUrl;
    try {
      if (url.startsWith('//')) url = 'https:' + url;
      const decoded = decodeURIComponent(url);
      if (decoded.includes('uddg=')) {
        const u = new URL(decoded, 'https://duckduckgo.com');
        const target = u.searchParams.get('uddg');
        if (target) url = target;
      }
    } catch (_) {}

    if (!/^https?:\/\//i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    results.push({
      title,
      url,
      snippet: '',
      engines: ['duckduckgo-html']
    });
  }

  return results;
}

async function fetchDuckDuckGoSearch(params, timeoutMs, retryCount) {
  const url = new URL('https://duckduckgo.com/html/');
  url.searchParams.set('q', params.query);
  if (params.language) {
    const lang = String(params.language).toLowerCase().startsWith('en') ? 'us-en' : 'wt-wt';
    url.searchParams.set('kl', lang);
  }

  const html = await fetchWithTimeout(url.toString(), timeoutMs, 'html', retryCount);
  const parsed = parseDuckDuckGoHtmlResults(html, params.maxResults);
  return {
    mode: 'duckduckgo-html',
    data: {
      results: parsed,
      suggestions: []
    }
  };
}

async function fetchSearch(baseUrl, params, timeoutMs, retryCount) {
  const searchUrl = new URL(baseUrl + '/search');
  searchUrl.searchParams.set('format', 'json');
  searchUrl.searchParams.set('q', params.query);
  searchUrl.searchParams.set('language', String(params.language));
  searchUrl.searchParams.set('safesearch', String(params.safeSearch));
  searchUrl.searchParams.set('pageno', String(params.pageno));

  try {
    const data = await fetchWithTimeout(searchUrl.toString(), timeoutMs, 'json', retryCount);
    return { mode: 'json', data };
  } catch (jsonError) {
    const htmlUrl = new URL(baseUrl + '/search');
    htmlUrl.searchParams.set('q', params.query);
    const html = await fetchWithTimeout(htmlUrl.toString(), timeoutMs, 'html', retryCount);
    const parsed = parseHtmlResults(html, params.maxResults);
    return {
      mode: 'html',
      data: {
        results: parsed,
        suggestions: [],
        fallback_reason: jsonError.message
      }
    };
  }
}

function normalizeResults(results, limit) {
  if (!Array.isArray(results)) return [];
  return results.slice(0, limit).map((item) => ({
    title: item.title || '',
    url: item.url || item.link || '',
    snippet: item.content || item.snippet || '',
    engines: Array.isArray(item.engines) ? item.engines : []
  }));
}

function getSearchDefaults(context) {
  return {
    timeoutMs: parseNumber(context.getConfig('timeoutMs'), 8000),
    retryCount: parseNumber(context.getConfig('retryCount'), 1),
    language: String(context.getConfig('defaultLanguage') || 'en-US'),
    safeSearch: parseNumber(context.getConfig('defaultSafeSearch'), 1),
    maxResults: parseNumber(context.getConfig('defaultMaxResults'), 8)
  };
}

async function stopBackendProcess() {
  const proc = RUNTIME.backend.process;
  const unregister = RUNTIME.backend.unregister;
  RUNTIME.backend.unregister = null;
  if (typeof unregister === 'function') {
    try {
      unregister();
    } catch (_) {}
  }
  if (!proc) return;

  RUNTIME.backend.process = null;
  RUNTIME.backend.ready = false;

  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };

    const hardTimeout = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch (_) {}
      finish();
    }, 1200);

    proc.once('exit', () => {
      clearTimeout(hardTimeout);
      finish();
    });

    try {
      proc.kill('SIGTERM');
    } catch (_) {
      clearTimeout(hardTimeout);
      finish();
    }
  });

  RUNTIME.backend.pid = null;
}

async function startBackendProcess(context) {
  const cfg = getBackendConfig(context);
  if (cfg.mode !== 'embedded') return { started: false, reason: 'mode-not-embedded' };
  if (!cfg.autoStart) return { started: false, reason: 'autostart-disabled' };

  const alreadyHealthy = await isBackendHealthy(cfg.baseUrl, cfg.healthPath, 1200);
  if (alreadyHealthy) {
    RUNTIME.backend.ready = true;
    RUNTIME.backend.lastError = null;
    await context.setConfig('baseUrl', cfg.baseUrl);
    return { started: false, attached: true, baseUrl: cfg.baseUrl };
  }

  if (RUNTIME.backend.process) {
    return { started: false, busy: true, baseUrl: cfg.baseUrl };
  }

  if (!cfg.command) {
    RUNTIME.backend.lastError = 'backendCommand is empty';
    return { started: false, error: RUNTIME.backend.lastError, baseUrl: cfg.baseUrl };
  }

  const child = spawn(cfg.command, cfg.args, {
    cwd: cfg.cwd || undefined,
    env: process.env,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  RUNTIME.backend.process = child;
  RUNTIME.backend.pid = child.pid;
  if (typeof context.registerManagedProcess === 'function') {
    RUNTIME.backend.unregister = context.registerManagedProcess(child, {
      name: 'searxng-embedded-backend'
    });
  }
  RUNTIME.backend.startedAt = new Date().toISOString();
  RUNTIME.backend.command = cfg.command;
  RUNTIME.backend.args = cfg.args;
  RUNTIME.backend.ready = false;
  RUNTIME.backend.lastError = null;

  child.on('exit', (code, signal) => {
    RUNTIME.backend.process = null;
    const unregisterOnExit = RUNTIME.backend.unregister;
    RUNTIME.backend.unregister = null;
    if (typeof unregisterOnExit === 'function') {
      try {
        unregisterOnExit();
      } catch (_) {}
    }
    RUNTIME.backend.ready = false;
    if (code !== 0) {
      RUNTIME.backend.lastError = `backend exited code=${code} signal=${signal || ''}`.trim();
    }
  });

  child.on('error', (error) => {
    RUNTIME.backend.lastError = error.message;
  });

  const startedAt = Date.now();
  const timeoutMs = Math.max(1000, cfg.startupTimeoutMs);
  while (Date.now() - startedAt < timeoutMs) {
    const healthy = await isBackendHealthy(cfg.baseUrl, cfg.healthPath, 1500);
    if (healthy) {
      RUNTIME.backend.ready = true;
      RUNTIME.backend.lastError = null;
      await context.setConfig('baseUrl', cfg.baseUrl);
      await context.setConfig('backendLastStartedAt', RUNTIME.backend.startedAt);
      return { started: true, ready: true, baseUrl: cfg.baseUrl, pid: child.pid };
    }
    await sleep(300);
  }

  RUNTIME.backend.lastError = `backend health timeout after ${timeoutMs}ms`;
  return { started: true, ready: false, baseUrl: cfg.baseUrl, pid: child.pid, error: RUNTIME.backend.lastError };
}

function backendStatus(context) {
  const cfg = getBackendConfig(context);
  return {
    mode: cfg.mode,
    autoStart: cfg.autoStart,
    baseUrl: cfg.baseUrl,
    command: cfg.command,
    args: cfg.args,
    running: Boolean(RUNTIME.backend.process),
    ready: Boolean(RUNTIME.backend.ready),
    pid: RUNTIME.backend.pid,
    startedAt: RUNTIME.backend.startedAt,
    lastError: RUNTIME.backend.lastError
  };
}

async function discover(context) {
  const defaults = getSearchDefaults(context);
  const candidates = getDiscoveryCandidates(context);
  const checks = [];

  for (const baseUrl of candidates) {
    const startedAt = Date.now();
    try {
      const data = await fetchSearch(baseUrl, {
        query: 'healthcheck',
        language: 'en-US',
        safeSearch: 1,
        pageno: 1,
        maxResults: 3
      }, defaults.timeoutMs, defaults.retryCount);

      const latencyMs = Date.now() - startedAt;
      const resultCount = Array.isArray(data.data?.results) ? data.data.results.length : 0;
      const check = {
        baseUrl,
        ok: true,
        mode: data.mode,
        latencyMs,
        resultCount
      };
      checks.push(check);

      RUNTIME.preferredInstance = baseUrl;
      RUNTIME.lastDiscovery = {
        selected: baseUrl,
        mode: data.mode,
        latencyMs,
        at: new Date().toISOString()
      };

      await context.setConfig('baseUrl', baseUrl);
      await context.setConfig('discoveredSearchPath', '/search');
      await context.setConfig('discoveredResponseMode', data.mode);
      await context.setConfig('lastDiscoveryAt', RUNTIME.lastDiscovery.at);
      await context.setConfig('lastDiscoveryLatencyMs', latencyMs);

      return { ok: true, selected: baseUrl, checks };
    } catch (error) {
      checks.push({ baseUrl, ok: false, error: error.message });
    }
  }

  return { ok: false, selected: null, checks };
}

async function searchUpstream(context, params) {
  const defaults = getSearchDefaults(context);
  const backendCfg = getBackendConfig(context);
  const language = params.language || defaults.language;
  const safeSearch = params.safe_search === '' || params.safe_search == null
    ? defaults.safeSearch
    : parseNumber(params.safe_search, defaults.safeSearch);
  const maxResults = params.max_results === '' || params.max_results == null
    ? defaults.maxResults
    : parseNumber(params.max_results, defaults.maxResults);
  const pageno = params.pageno === '' || params.pageno == null
    ? 1
    : parseNumber(params.pageno, 1);

  const configuredBase = normalizeBaseUrl(context.getConfig('baseUrl'));
  const candidates = [];
  if (backendCfg.mode === 'embedded' && backendCfg.baseUrl) {
    candidates.push(backendCfg.baseUrl);
  }
  if (RUNTIME.preferredInstance) candidates.push(RUNTIME.preferredInstance);
  if (configuredBase && !candidates.includes(configuredBase)) candidates.push(configuredBase);

  if (!candidates.length) {
    const discovery = await discover(context);
    if (discovery.ok && discovery.selected) {
      candidates.push(discovery.selected);
    }
  }

  if (!candidates.length) {
    return { error: 'SearXNG baseUrl is not configured and discovery failed. Run discover first.' };
  }

  let lastError = null;
  for (const baseUrl of candidates) {
    try {
      const response = await fetchSearch(baseUrl, {
        query: params.query,
        language,
        safeSearch,
        maxResults,
        pageno
      }, defaults.timeoutMs, defaults.retryCount);

      const data = response.data || {};
      const results = normalizeResults(data.results, maxResults);
      RUNTIME.preferredInstance = baseUrl;

      return {
        query: params.query,
        source: 'searxng',
        instance: baseUrl,
        mode: response.mode,
        total: results.length,
        results,
        suggestions: Array.isArray(data.suggestions) ? data.suggestions : [],
        fallback_reason: data.fallback_reason || null,
        via_local_proxy: false
      };
    } catch (error) {
      lastError = error;
    }
  }
  try {
    const response = await fetchDuckDuckGoSearch({
      query: params.query,
      language,
      maxResults
    }, defaults.timeoutMs, defaults.retryCount);
    const data = response.data || {};
    const results = normalizeResults(data.results, maxResults);
    return {
      query: params.query,
      source: 'duckduckgo-fallback',
      instance: 'https://duckduckgo.com/html/',
      mode: response.mode,
      total: results.length,
      results,
      suggestions: [],
      fallback_reason: lastError ? lastError.message : null,
      via_local_proxy: false
    };
  } catch (fallbackError) {
    return {
      error: 'SearXNG search failed: ' + (lastError ? lastError.message : 'unknown error'),
      fallback_error: fallbackError.message || 'duckduckgo fallback failed'
    };
  }
}

function getLocalServerConfig(context) {
  const enabled = parseBool(context.getConfig('enableLocalServer'), true);
  const host = String(context.getConfig('localServerHost') || '127.0.0.1').trim() || '127.0.0.1';
  const port = Math.max(0, parseNumber(context.getConfig('localServerPort'), 0));
  return { enabled, host, port };
}

function getLocalServerUrl() {
  if (!RUNTIME.server || !RUNTIME.port) return null;
  return `http://${RUNTIME.host}:${RUNTIME.port}`;
}

async function ensureLocalServer(context) {
  const cfg = getLocalServerConfig(context);
  if (!cfg.enabled) return null;

  if (RUNTIME.server && RUNTIME.port && RUNTIME.host === cfg.host) {
    return getLocalServerUrl();
  }

  if (RUNTIME.server) {
    await stopLocalServer();
  }

  RUNTIME.context = context;
  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url, 'http://127.0.0.1');

      if (requestUrl.pathname === '/health') {
        writeJson(res, 200, {
          ok: true,
          server: 'searxng-plugin-proxy',
          startedAt: RUNTIME.startedAt,
          preferredInstance: RUNTIME.preferredInstance,
          lastDiscovery: RUNTIME.lastDiscovery
        });
        return;
      }

      if (requestUrl.pathname === '/discover') {
        const result = await discover(RUNTIME.context);
        writeJson(res, result.ok ? 200 : 502, result);
        return;
      }

      if (requestUrl.pathname === '/search') {
        const query = parseRequestQuery(req.url);
        if (!query.query) {
          writeJson(res, 400, { error: 'Missing query parameter q' });
          return;
        }

        const result = await searchUpstream(RUNTIME.context, query);
        if (result.error) {
          writeJson(res, 502, result);
          return;
        }

        result.via_local_proxy = true;
        writeJson(res, 200, result);
        return;
      }

      writeJson(res, 404, { error: 'Not found' });
    } catch (error) {
      writeJson(res, 500, { error: error.message || 'Internal error' });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, () => resolve());
  });

  const addr = server.address();
  RUNTIME.server = server;
  RUNTIME.host = cfg.host;
  RUNTIME.port = addr && typeof addr === 'object' ? addr.port : cfg.port;
  RUNTIME.startedAt = new Date().toISOString();

  const localUrl = getLocalServerUrl();
  await context.setConfig('localServerHost', RUNTIME.host);
  await context.setConfig('localServerPort', RUNTIME.port);
  await context.setConfig('localServerUrl', localUrl);
  await context.setConfig('localServerStartedAt', RUNTIME.startedAt);

  return localUrl;
}

async function stopLocalServer() {
  if (!RUNTIME.server) return;
  const server = RUNTIME.server;
  RUNTIME.server = null;
  RUNTIME.port = null;
  RUNTIME.startedAt = null;

  await new Promise((resolve) => {
    const hardTimeout = setTimeout(() => {
      try {
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
      } catch (_) {}
      resolve();
    }, 1000);

    try {
      server.close(() => {
        clearTimeout(hardTimeout);
        resolve();
      });
    } catch (_) {
      clearTimeout(hardTimeout);
      resolve();
    }
  });
}

async function searchViaLocalServer(context, params) {
  const localUrl = await ensureLocalServer(context);
  if (!localUrl) {
    return searchUpstream(context, params);
  }

  const defaults = getSearchDefaults(context);
  const maxResults = params.max_results == null || params.max_results === ''
    ? defaults.maxResults
    : parseNumber(params.max_results, defaults.maxResults);

  const url = new URL(localUrl + '/search');
  url.searchParams.set('q', params.query);
  if (params.language) url.searchParams.set('language', String(params.language));
  if (params.safe_search != null && params.safe_search !== '') url.searchParams.set('safe_search', String(params.safe_search));
  if (params.pageno != null && params.pageno !== '') url.searchParams.set('pageno', String(params.pageno));
  url.searchParams.set('max_results', String(maxResults));

  try {
    const payload = await fetchWithTimeout(url.toString(), defaults.timeoutMs, 'json', defaults.retryCount);
    return payload;
  } catch (error) {
    return { error: 'Local search proxy failed: ' + error.message };
  }
}

async function ensureDefaults(context) {
  if (context.getConfig('timeoutMs') == null) await context.setConfig('timeoutMs', 8000);
  if (context.getConfig('retryCount') == null) await context.setConfig('retryCount', 1);
  if (context.getConfig('defaultLanguage') == null) await context.setConfig('defaultLanguage', 'en-US');
  if (context.getConfig('defaultSafeSearch') == null) await context.setConfig('defaultSafeSearch', 1);
  if (context.getConfig('defaultMaxResults') == null) await context.setConfig('defaultMaxResults', 8);
  if (context.getConfig('enableLocalServer') == null) await context.setConfig('enableLocalServer', true);
  if (!context.getConfig('localServerHost')) await context.setConfig('localServerHost', '127.0.0.1');
  if (context.getConfig('localServerPort') == null) await context.setConfig('localServerPort', 0);
  if (!context.getConfig('discoveryUrls')) await context.setConfig('discoveryUrls', DEFAULT_DISCOVERY_URLS.join(','));
  if (!context.getConfig('backendMode')) await context.setConfig('backendMode', 'embedded');
  if (context.getConfig('backendAutoStart') == null) await context.setConfig('backendAutoStart', true);
  if (!context.getConfig('backendBaseUrl')) await context.setConfig('backendBaseUrl', 'http://127.0.0.1:8080');
  if (!context.getConfig('backendHealthPath')) await context.setConfig('backendHealthPath', '/search?q=healthcheck&format=json');
  if (context.getConfig('backendStartupTimeoutMs') == null) await context.setConfig('backendStartupTimeoutMs', 25000);
  if (context.getConfig('backendArgs') == null) await context.setConfig('backendArgs', '');
  if (context.getConfig('backendWorkingDir') == null) await context.setConfig('backendWorkingDir', '');
  if (context.getConfig('backendCommand') == null) await context.setConfig('backendCommand', '');
}

module.exports = {
  async onEnable(context) {
    await ensureDefaults(context);
    const backendStart = await startBackendProcess(context);
    if (backendStart?.error) {
      context.log('Embedded backend start warning: ' + backendStart.error);
    } else if (backendStart?.ready) {
      context.log('Embedded backend ready at ' + backendStart.baseUrl);
    }

    if (parseBool(context.getConfig('enableLocalServer'), true)) {
      try {
        const localUrl = await ensureLocalServer(context);
        context.log('Local search server started at ' + localUrl);
      } catch (error) {
        context.log('Local search server failed to start: ' + error.message);
      }
    }

    const discovery = await discover(context);
    context.log('Discovery status: ' + (discovery.ok ? 'ok' : 'failed'));

    context.registerHandler('discover', {
      description: 'Discover reachable SearXNG endpoint and save config for this plugin',
      inputSchema: { type: 'object', properties: {} }
    }, async () => {
      const result = await discover(context);
      result.local_server_url = getLocalServerUrl();
      return result;
    });

    context.registerHandler('search', {
      description: 'Search the web via SearXNG. Optionally routes through local personal proxy when enabled.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          language: { type: 'string', description: 'Language code (optional)' },
          safe_search: { type: 'number', description: 'Safe search level 0/1/2 (optional)' },
          max_results: { type: 'number', description: 'Maximum results', default: 8 },
          pageno: { type: 'number', description: 'Page number', default: 1 }
        },
        required: ['query']
      }
    }, async (params) => {
      if (!params || !String(params.query || '').trim()) {
        return { error: 'query is required' };
      }

      const useLocal = parseBool(context.getConfig('enableLocalServer'), true);
      const result = useLocal
        ? await searchViaLocalServer(context, params)
        : await searchUpstream(context, params);

      if (result && !result.error) {
        result.local_server_url = getLocalServerUrl();
        result.used_local_server = useLocal;
      }
      return result;
    });

    context.registerHandler('server_status', {
      description: 'Return local SearXNG personal proxy and backend status',
      inputSchema: { type: 'object', properties: {} }
    }, async () => ({
      enabled: parseBool(context.getConfig('enableLocalServer'), true),
      running: Boolean(RUNTIME.server),
      local_server_url: getLocalServerUrl(),
      preferred_instance: RUNTIME.preferredInstance,
      last_discovery: RUNTIME.lastDiscovery,
      backend: backendStatus(context)
    }));
  },

  async runAction(action, params, context) {
    if (action === 'discover') {
      const result = await discover(context);
      result.local_server_url = getLocalServerUrl();
      return result;
    }

    if (action === 'start_server') {
      const localUrl = await ensureLocalServer(context);
      return { ok: true, local_server_url: localUrl };
    }

    if (action === 'stop_server') {
      await stopLocalServer();
      await context.setConfig('localServerUrl', '');
      return { ok: true, stopped: true };
    }

    if (action === 'server_status') {
      return {
        enabled: parseBool(context.getConfig('enableLocalServer'), true),
        running: Boolean(RUNTIME.server),
        local_server_url: getLocalServerUrl(),
        preferred_instance: RUNTIME.preferredInstance,
        last_discovery: RUNTIME.lastDiscovery,
        backend: backendStatus(context)
      };
    }

    if (action === 'start_backend') {
      const result = await startBackendProcess(context);
      return { ok: !result.error, ...result, backend: backendStatus(context) };
    }

    if (action === 'stop_backend') {
      await stopBackendProcess();
      return { ok: true, stopped: true, backend: backendStatus(context) };
    }

    throw new Error('Unknown plugin action: ' + action);
  },

  async onDisable() {
    await stopLocalServer();
    await stopBackendProcess();
  }
};
