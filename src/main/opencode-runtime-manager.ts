// @ts-nocheck
const { nativeHttpRequest } = require('./net/native-http-client');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const DEFAULT_PROVIDER_ID = 'opencode';
const DEFAULT_HOSTNAME = '127.0.0.1';
const DEFAULT_USERNAME = 'opencode';
// Proxy-backed reasoning/tool turns can legitimately take several minutes.
// Keep this above the executor timeout so LocalAgent receives the complete
// textual tool call instead of aborting the proxy midway through generation.
const REQUEST_TIMEOUT_MS = 600000;
const STATUS_TIMEOUT_MS = 60000;
const DISABLED_NATIVE_TOOLS = Object.freeze(Object.fromEntries([
  'apply_patch', 'bash', 'edit', 'glob', 'grep', 'list', 'multiedit', 'patch',
  'plan_enter', 'plan_exit', 'question', 'read', 'skill', 'task', 'todoread', 'todowrite',
  'webfetch', 'websearch', 'write'
].map(name => [name, false])));
const LOCALAGENT_TOOL_BRIDGE_INSTRUCTIONS = `
OpenCode proxy tool bridge:
- LocalAgent tools are invoked through the textual TOOL: name {json} protocol described below.
- They intentionally do not appear in OpenCode's native function-tool inventory. Do not claim a LocalAgent tool is unavailable because it is absent from that native inventory.
- Never invoke OpenCode-native tools for this conversation. When a LocalAgent tool is needed, emit the documented textual TOOL call and stop so LocalAgent can execute it.`;

function normalizeString(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function fileExists(targetPath = '') {
  const normalized = normalizeString(targetPath, '');
  if (!normalized) return false;
  try {
    return fs.existsSync(normalized);
  } catch (_error) {
    return false;
  }
}

function resolveOpenCodeShimExecutable(commandPath = '') {
  const normalized = normalizeString(commandPath, '');
  if (!normalized) return '';
  const baseName = path.basename(normalized).toLowerCase();
  if (!/^opencode(?:\.(cmd|ps1))?$/.test(baseName)) return '';
  const candidate = path.join(path.dirname(normalized), 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
  return fileExists(candidate) ? candidate : '';
}

function listWhereMatches(binaryName = '') {
  const normalized = normalizeString(binaryName, '');
  if (!normalized || process.platform !== 'win32') return [];
  try {
    const result = spawnSync('where.exe', [normalized], {
      encoding: 'utf8',
      windowsHide: true
    });
    if (result.error || result.status !== 0) return [];
    return String(result.stdout || '')
      .split(/\r?\n/g)
      .map(entry => normalizeString(entry, ''))
      .filter(Boolean);
  } catch (_error) {
    return [];
  }
}

function resolveWindowsOpenCodeCommand(configuredPath = '') {
  const candidates = [];
  const seen = new Set();
  const pushCandidate = (value) => {
    const normalized = normalizeString(value, '');
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(normalized);
  };

  pushCandidate(configuredPath);

  const appData = normalizeString(process.env.APPDATA || '', '');
  if (appData) {
    pushCandidate(path.join(appData, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'));
    pushCandidate(path.join(appData, 'npm', 'opencode.cmd'));
    pushCandidate(path.join(appData, 'npm', 'opencode.ps1'));
    pushCandidate(path.join(appData, 'npm', 'opencode'));
  }

  for (const name of ['opencode.exe', 'opencode.cmd', 'opencode.ps1', 'opencode']) {
    for (const match of listWhereMatches(name)) {
      pushCandidate(match);
    }
  }

  pushCandidate('opencode');

  for (const candidate of candidates) {
    const shimExecutable = resolveOpenCodeShimExecutable(candidate);
    if (shimExecutable) return shimExecutable;
    if (fileExists(candidate)) return candidate;
  }

  return normalizeString(configuredPath, '') || 'opencode';
}

function normalizeScopeOptions(options = {}) {
  const requestContext = options?.requestContext || null;
  const userId = normalizeString(options?.userId || requestContext?.userId || '', '');
  return {
    requestContext,
    userId: userId || 'localuser'
  };
}

function normalizeSessionKey(input = {}) {
  const raw = normalizeString(
    input?.sessionId
      || input?.requestContext?.sessionId
      || (input?.agentId ? `agent-${input.agentId}` : ''),
    ''
  );
  if (!raw) return null;
  return raw.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 160);
}

function splitOpenCodeModelRef(value) {
  const normalized = normalizeString(value, '');
  const slashIndex = normalized.indexOf('/');
  if (slashIndex <= 0 || slashIndex >= normalized.length - 1) {
    return {
      providerID: 'opencode',
      modelID: normalized,
      value: normalized
    };
  }
  return {
    providerID: normalized.slice(0, slashIndex),
    modelID: normalized.slice(slashIndex + 1),
    value: normalized
  };
}

function buildOpenCodeModelRef(providerID, modelID) {
  const provider = normalizeString(providerID, '');
  const model = normalizeString(modelID, '');
  if (!provider) return model;
  if (!model) return provider;
  return `${provider}/${model}`;
}

function isZeroCost(cost = null) {
  if (!cost || typeof cost !== 'object') return false;
  const values = [];
  if (Number.isFinite(Number(cost.input))) values.push(Number(cost.input));
  if (Number.isFinite(Number(cost.output))) values.push(Number(cost.output));
  if (cost.cache && typeof cost.cache === 'object') {
    if (Number.isFinite(Number(cost.cache.read))) values.push(Number(cost.cache.read));
    if (Number.isFinite(Number(cost.cache.write))) values.push(Number(cost.cache.write));
  }
  return values.length > 0 && values.every(value => value === 0);
}

function formatCostValue(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '';
  if (numeric === 0) return '0';
  if (numeric >= 1) return String(numeric);
  if (numeric >= 0.01) return numeric.toFixed(2).replace(/0+$/g, '').replace(/\.$/g, '');
  return numeric.toFixed(4).replace(/0+$/g, '').replace(/\.$/g, '');
}

function formatOpenCodeCostText(meta = {}) {
  const input = formatCostValue(meta?.cost?.input);
  const output = formatCostValue(meta?.cost?.output);
  if (!input && !output) return '';
  if (input === '0' && output === '0') {
    return meta?.providerID === 'opencode' ? 'included with OpenCode' : 'free';
  }
  return `in ${input || '?'} / out ${output || '?'}`;
}

function deriveOpenCodeModelFlags(meta = {}) {
  const included = meta?.providerID === 'opencode' && isZeroCost(meta?.cost);
  const free = !included && isZeroCost(meta?.cost);
  return { included, free };
}

function deriveOpenCodeModelBadge(meta = {}) {
  const { included, free } = deriveOpenCodeModelFlags(meta);
  if (included) return 'included';
  if (free) return 'free';
  return '';
}

function formatOpenCodeModelLabel(value, meta = {}) {
  const badge = deriveOpenCodeModelBadge(meta);
  return badge ? `${value} [${badge}]` : value;
}

function parseOpenCodeModelsVerboseOutput(rawOutput = '') {
  const lines = String(rawOutput || '').split(/\r?\n/);
  const models = [];
  let index = 0;

  while (index < lines.length) {
    const line = String(lines[index] || '').trim();
    if (!line) {
      index += 1;
      continue;
    }

    const next = String(lines[index + 1] || '').trim();
    if (!line.includes('/') || next !== '{') {
      index += 1;
      continue;
    }

    const jsonLines = [];
    let depth = 0;
    let cursor = index + 1;
    while (cursor < lines.length) {
      const current = lines[cursor];
      jsonLines.push(current);
      const opens = (current.match(/\{/g) || []).length;
      const closes = (current.match(/\}/g) || []).length;
      depth += opens - closes;
      cursor += 1;
      if (depth === 0 && jsonLines.length > 0) {
        break;
      }
    }

    try {
      const parsed = JSON.parse(jsonLines.join('\n'));
      const providerID = normalizeString(parsed?.providerID || splitOpenCodeModelRef(line).providerID, '');
      const modelID = normalizeString(parsed?.id || splitOpenCodeModelRef(line).modelID, '');
      const value = buildOpenCodeModelRef(providerID, modelID) || line;
      models.push({
        value,
        providerID,
        modelID,
        name: normalizeString(parsed?.name || modelID, modelID),
        family: normalizeString(parsed?.family || '', ''),
        status: normalizeString(parsed?.status || '', ''),
        limit: parsed?.limit || {},
        capabilities: parsed?.capabilities || {},
        cost: parsed?.cost || {},
        releaseDate: normalizeString(parsed?.release_date || '', ''),
        variants: parsed?.variants || {},
        raw: parsed
      });
    } catch (_error) {
      // Ignore malformed chunks and continue scanning.
    }

    index = cursor;
  }

  return models;
}

function extractTextFromPart(part) {
  if (!part) return [];
  if (typeof part === 'string') return [part];
  if (Array.isArray(part)) {
    return part.flatMap(entry => extractTextFromPart(entry));
  }
  if (typeof part !== 'object') return [];

  const output = [];
  if (typeof part.text === 'string') output.push(part.text);
  if (typeof part.content === 'string') output.push(part.content);
  if (typeof part.reasoning === 'string') output.push(part.reasoning);
  if (typeof part.summary === 'string') output.push(part.summary);
  if (typeof part.message === 'string') output.push(part.message);
  if (part.content && typeof part.content === 'object') {
    output.push(...extractTextFromPart(part.content));
  }
  if (Array.isArray(part.parts)) {
    output.push(...part.parts.flatMap(entry => extractTextFromPart(entry)));
  }
  if (Array.isArray(part.messages)) {
    output.push(...part.messages.flatMap(entry => extractTextFromPart(entry)));
  }
  return output;
}

function collectAssistantText(payload) {
  const candidates = [
    payload,
    payload?.data,
    payload?.result,
    payload?.message,
    payload?.assistant
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (typeof candidate === 'string') {
      const normalized = candidate.trim();
      if (normalized) return normalized;
    }
    const parts = Array.isArray(candidate?.parts)
      ? candidate.parts
      : (Array.isArray(candidate?.data?.parts) ? candidate.data.parts : []);
    const text = parts
      .filter(part => !isReasoningPart(part))
      .flatMap(entry => extractTextFromPart(entry))
      .join('\n')
      .trim();
    if (text) return text;
  }

  return '';
}

function isReasoningPart(part) {
  if (!part || typeof part !== 'object') return false;
  const type = String(part.type || '').toLowerCase();
  return type.includes('reason') || type.includes('think');
}

function collectAssistantReasoning(payload) {
  const candidates = [
    payload,
    payload?.data,
    payload?.result,
    payload?.message,
    payload?.assistant
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const parts = Array.isArray(candidate?.parts)
      ? candidate.parts
      : (Array.isArray(candidate?.data?.parts) ? candidate.data.parts : []);
    const reasoning = parts
      .filter(isReasoningPart)
      .flatMap(entry => extractTextFromPart(entry))
      .join('\n')
      .trim();
    if (reasoning) return reasoning;
  }

  return '';
}

function toPositiveInteger(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.round(numeric);
}

// OpenCode response/output metadata is authoritative session context. Prefer info.tokens;
// never accumulate turns or replace real values with estimates. Step tokens are fallback shapes.
function normalizeOpenCodeUsageCandidate(candidate = null, path = '') {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;

  const explicitKeys = [];
  const read = (keys = []) => {
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(candidate, key)) continue;
      explicitKeys.push(key);
      return toPositiveInteger(candidate[key]);
    }
    return 0;
  };

  const promptTokens = read(['prompt_tokens', 'promptTokens', 'inputTokens', 'input_tokens', 'promptTokenCount', 'input']);
  const completionTokens = read(['completion_tokens', 'completionTokens', 'outputTokens', 'output_tokens', 'completionTokenCount', 'output']);
  const totalTokens = read(['total_tokens', 'totalTokens', 'tokenCount', 'tokens', 'total']);
  const cacheObject = candidate.cache && typeof candidate.cache === 'object' ? candidate.cache : null;
  const cachedTokens = read(['cached_tokens', 'cachedTokens', 'cachedInputTokens', 'cacheReadInputTokens']) || toPositiveInteger(cacheObject?.read || 0);
  const cacheWriteTokens = read(['cache_write_tokens', 'cacheWriteTokens', 'cacheCreationInputTokens']) || toPositiveInteger(cacheObject?.write || 0);
  const contextTokens = cacheObject ? promptTokens + cachedTokens + cacheWriteTokens : promptTokens;
  const reasoningOutputTokens = read(['reasoning_output_tokens', 'reasoningOutputTokens', 'reasoning']);
  const contextLength = read(['context_length', 'contextLength', 'modelContextWindow']);
  const pathLower = normalizeString(path, '').toLowerCase();
  const pathLooksRelevant = /(usage|token|stats|metrics)/.test(pathLower);
  const hasExplicitTokenFields = explicitKeys.some(key => /(token|context)/i.test(key));

  if (!pathLooksRelevant && !hasExplicitTokenFields) return null;
  if (![contextTokens, completionTokens, totalTokens, cachedTokens, cacheWriteTokens, reasoningOutputTokens, contextLength].some(value => value > 0)) {
    return null;
  }

  return {
    prompt_tokens: contextTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens || (contextTokens + completionTokens + reasoningOutputTokens),
    cached_tokens: cachedTokens,
    cache_write_tokens: cacheWriteTokens,
    reasoning_output_tokens: reasoningOutputTokens,
    contextLength,
    _score: explicitKeys.length + (pathLooksRelevant ? 2 : 0) + (totalTokens > 0 ? 1 : 0) + (/\.info\.tokens$/.test(pathLower) ? 100 : 0)
  };
}

function collectOpenCodeUsageCandidates(value, path = 'root', depth = 0, seen = new Set()) {
  if (!value || typeof value !== 'object') return [];
  if (seen.has(value) || depth > 6) return [];
  seen.add(value);

  const candidates = [];
  const normalized = normalizeOpenCodeUsageCandidate(value, path);
  if (normalized) candidates.push(normalized);

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      candidates.push(...collectOpenCodeUsageCandidates(value[index], `${path}[${index}]`, depth + 1, seen));
    }
    return candidates;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== 'object') continue;
    candidates.push(...collectOpenCodeUsageCandidates(entry, `${path}.${key}`, depth + 1, seen));
  }

  return candidates;
}

function extractOpenCodeUsage(payload) {
  const candidates = collectOpenCodeUsageCandidates(payload);
  if (candidates.length === 0) return null;
  candidates.sort((left, right) => {
    if (right._score !== left._score) return right._score - left._score;
    if (right.total_tokens !== left.total_tokens) return right.total_tokens - left.total_tokens;
    if (right.prompt_tokens !== left.prompt_tokens) return right.prompt_tokens - left.prompt_tokens;
    return right.contextLength - left.contextLength;
  });
  const best = candidates[0];
  return {
    input_tokens: best.prompt_tokens,
    prompt_tokens: best.prompt_tokens,
    context_tokens: best.prompt_tokens,
    output_tokens: best.completion_tokens,
    completion_tokens: best.completion_tokens,
    total_tokens: best.total_tokens,
    cached_tokens: best.cached_tokens,
    cache_write_tokens: best.cache_write_tokens,
    reasoning_output_tokens: best.reasoning_output_tokens,
    contextLength: best.contextLength
  };
}

function buildHistoryPrompt(history = [], prompt = '') {
  const trimmedPrompt = normalizeString(prompt, '');
  if (!Array.isArray(history) || history.length === 0) {
    return trimmedPrompt || 'Continue.';
  }

  const historyLines = history
    .map(message => {
      const role = normalizeString(message?.role || 'user', 'user').toUpperCase();
      const content = normalizeString(message?.content || '', '');
      return content ? `${role}:\n${content}` : '';
    })
    .filter(Boolean);

  if (historyLines.length === 0) {
    return trimmedPrompt || 'Continue.';
  }

  return [
    'Conversation so far:',
    historyLines.join('\n\n'),
    '',
    'Current user message:',
    trimmedPrompt || 'Continue.'
  ].join('\n');
}

function isRecoverableRuntimeError(error = null) {
  const code = normalizeString(error?.code || error?.cause?.code || '', '').toUpperCase();
  if (['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNABORTED'].includes(code)) {
    return true;
  }
  const message = normalizeString(error?.message || '', '').toLowerCase();
  return message.includes('econnrefused')
    || message.includes('econnreset')
    || message.includes('socket hang up')
    || message.includes('timed out')
    || message.includes('timeout');
}

function isRecoverableSessionError(error = null) {
  const status = Number(error?.response?.status || error?.status || 0) || 0;
  if ([400, 404, 409, 410, 422].includes(status)) {
    return true;
  }
  const message = normalizeString(error?.message || '', '').toLowerCase();
  return (message.includes('session') && message.includes('not found'))
    || message.includes('unknown session')
    || message.includes('invalid session');
}

async function allocatePort(hostname = DEFAULT_HOSTNAME) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, hostname, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? Number(address.port) : 0;
      server.close((error) => {
        if (error) return reject(error);
        resolve(port);
      });
    });
  });
}

class OpenCodeRuntimeManager {
  constructor(options = {}) {
    this.db = options.db;
    this.windowManager = options.windowManager || null;
    this.executionDirectory = options.executionDirectory || null;
    this.runtimePaths = options.runtimePaths || {};
    this.activeProfile = options.activeProfile || null;
    this.dispatcher = options.dispatcher || null;
    this.runtimeMap = new Map();
    this.modelContextWindowCache = new Map();
    this.lastModelDiscovery = {
      ok: null,
      source: 'unknown',
      authoritative: false,
      error: null,
      count: 0,
      at: null
    };
  }

  isRuntimeProvider(providerId) {
    return normalizeString(providerId || '', '').toLowerCase() === DEFAULT_PROVIDER_ID;
  }

  getLastModelDiscovery() {
    return { ...this.lastModelDiscovery };
  }

  _recordModelDiscovery(meta = {}) {
    const models = Array.isArray(meta.models) ? meta.models : [];
    this.lastModelDiscovery = {
      ok: meta.ok === undefined ? true : Boolean(meta.ok),
      source: normalizeString(meta.source || 'unknown', 'unknown'),
      authoritative: Boolean(meta.authoritative),
      error: meta.error ? String(meta.error) : null,
      count: models.length,
      at: new Date().toISOString()
    };
    return models;
  }

  async getModels(forceRefreshOrOptions = false, maybeOptions = {}) {
    const { forceRefresh, options } = this._normalizeGetModelsArgs(forceRefreshOrOptions, maybeOptions);
    const modelOptions = await this.getModelOptions('', forceRefresh, options);
    return modelOptions.map(entry => entry.value);
  }

  async getModelContextWindow(model, options = {}) {
    return this._resolveContextLengthForTurn({ value: model }, {}, options);
  }

  async getModelOptions(providerFilter = '', forceRefresh = false, options = {}) {
    const normalizedFilter = normalizeString(providerFilter || '', '').toLowerCase();
    try {
      const providerMeta = await this._getProviderMeta(options);
      const models = await this._listModelsFromCli(normalizedFilter, forceRefresh, options);
      const connectedProviders = new Set(
        Array.isArray(providerMeta?.connected)
          ? providerMeta.connected.map(value => normalizeString(value, '').toLowerCase()).filter(Boolean)
          : []
      );
      const defaults = providerMeta?.defaults && typeof providerMeta.defaults === 'object'
        ? providerMeta.defaults
        : {};

      const normalized = models.map(entry => {
        const { included, free } = deriveOpenCodeModelFlags(entry);
        const costText = formatOpenCodeCostText(entry);
        const contextWindow = Number(entry?.limit?.context || 0) || null;
        const value = entry.value;
        if (value) {
          this.modelContextWindowCache.set(String(value).trim().toLowerCase(), contextWindow);
        }
        return {
          value,
          label: formatOpenCodeModelLabel(value, entry),
          sourceProviderId: entry.providerID,
          name: entry.name,
          free,
          included,
          connected: connectedProviders.has(normalizeString(entry.providerID, '').toLowerCase()),
          defaultModel: normalizeString(defaults[entry.providerID], '') === normalizeString(entry.modelID, ''),
          costText,
          contextWindow,
          raw: entry.raw
        };
      });

      this._recordModelDiscovery({
        ok: true,
        source: 'cli',
        authoritative: true,
        models: normalized.map(entry => entry.value)
      });
      return normalized;
    } catch (error) {
      this._recordModelDiscovery({
        ok: false,
        source: 'cli',
        authoritative: true,
        error: error.message,
        models: []
      });
      throw error;
    }
  }

  async getStatus(options = {}) {
    const scope = normalizeScopeOptions(options);
    const command = await this._resolveOpenCodeCommand(scope);
    const version = spawnSync(command, ['--version'], {
      encoding: 'utf8',
      windowsHide: true
    });
    if (version.error || version.status !== 0) {
      return {
        installed: false,
        path: '',
        version: '',
        serverRunning: false,
        connectedProviders: [],
        defaultModels: {},
        error: version.error?.message || `${version.stderr || version.stdout || ''}`.trim() || 'OpenCode not found'
      };
    }

    try {
      const existing = this.runtimeMap.get(this._scopeKey(scope)) || null;
      if (!existing && !(await this._shouldAutoStart(scope))) {
        return {
          installed: true,
          path: command,
          version: `${version.stdout || version.stderr || ''}`.trim(),
          serverRunning: false,
          connectedProviders: [],
          defaultModels: {},
          providers: [],
          notes: process.platform === 'win32'
            ? ['OpenCode recommends WSL on Windows, but native installs are still supported when available.']
            : []
        };
      }
      const cwd = await this._resolveWorkspaceRoot(scope);
      const runtime = await this._ensureRuntime(scope, cwd);
      const providerMeta = await this._getProviderMeta(options, runtime);
      return {
        installed: true,
        path: command,
        version: `${version.stdout || version.stderr || ''}`.trim(),
        serverRunning: runtime.connected === true,
        serverUrl: runtime.url,
        cwd: runtime.cwd,
        connectedProviders: Array.isArray(providerMeta?.connected) ? providerMeta.connected : [],
        defaultModels: providerMeta?.defaults || {},
        providers: Array.isArray(providerMeta?.all) ? providerMeta.all : [],
        notes: process.platform === 'win32'
          ? ['OpenCode recommends WSL on Windows, but native installs are still supported when available.']
          : []
      };
    } catch (error) {
      return {
        installed: true,
        path: command,
        version: `${version.stdout || version.stderr || ''}`.trim(),
        serverRunning: false,
        connectedProviders: [],
        defaultModels: {},
        error: error.message
      };
    }
  }

  stop() {
    let stopped = false;
    for (const runtime of this.runtimeMap.values()) {
      for (const controller of runtime.requestControllers || []) {
        controller.abort();
      }
      runtime.requestControllers?.clear?.();
      runtime.activeSessionIds?.forEach(sessionId => {
        this._abortRemoteSession(runtime, sessionId).catch(() => {});
      });
      if (runtime.child && !runtime.child.killed) {
        runtime.child.kill();
        stopped = true;
      }
    }
    return stopped;
  }

  get isGenerating() {
    for (const runtime of this.runtimeMap.values()) {
      if ((runtime.requestControllers?.size || 0) > 0) {
        return true;
      }
    }
    return false;
  }

  getActiveRequestCount() {
    let count = 0;
    for (const runtime of this.runtimeMap.values()) {
      count += runtime.requestControllers?.size || 0;
    }
    return count;
  }

  getConversationCapabilities() {
    return {
      continuity: 'stateful',
      manualCompaction: 'native',
      usageReporting: 'provider'
    };
  }

  async resetSession(sessionId, options = {}) {
    const sessionKey = normalizeSessionKey({ sessionId });
    if (!sessionKey) return { success: false, error: 'sessionId is required' };
    if (this.db?.deleteScopedSetting) {
      await this.db.deleteScopedSetting(this._sessionStateKey(sessionKey), options);
    } else if (this.db?.saveScopedSetting) {
      await this.db.saveScopedSetting(this._sessionStateKey(sessionKey), '', options);
    }
    return { success: true, sessionId: sessionKey };
  }

  async compactConversation(sessionId, options = {}) {
    const sessionKey = normalizeSessionKey({ sessionId });
    if (!sessionKey) throw new Error('sessionId is required');
    const scope = normalizeScopeOptions(options);
    const state = await this._readSessionState(sessionKey, scope);
    const externalSessionId = normalizeString(state?.externalSessionId || '', '');
    const expectedRuntimeUrl = normalizeString(state?.externalRuntimeUrl || '', '');
    if (!externalSessionId) throw new Error('No active OpenCode session exists for this LocalAgent session');
    const cwd = await this._resolveWorkspaceRoot(scope);
    const runtime = await this._ensureRuntime(scope, cwd);
    if (expectedRuntimeUrl && normalizeString(runtime?.url || '', '') !== expectedRuntimeUrl) {
      throw new Error('The saved OpenCode session belongs to a different runtime');
    }
    const modelRef = await this._resolveModel({ model: options?.model || state?.lastModel }, scope);
    const compacted = await this._request(runtime, {
      method: 'post',
      url: `/session/${encodeURIComponent(externalSessionId)}/summarize`,
      data: {
        providerID: modelRef.providerID,
        modelID: modelRef.modelID
      }
    });
    if (compacted === false || compacted?.data === false) {
      throw new Error('OpenCode declined session compaction');
    }
    const messages = await this._request(runtime, {
      method: 'get',
      url: `/session/${encodeURIComponent(externalSessionId)}/message`,
      timeoutMs: STATUS_TIMEOUT_MS
    }).catch(() => null);
    const usage = Array.isArray(messages)
      ? messages.slice().reverse().map(message => extractOpenCodeUsage(message)).find(Boolean) || null
      : extractOpenCodeUsage(messages);
    const checkpointSummary = Array.isArray(messages) && messages.length > 0
      ? collectAssistantText(messages[messages.length - 1])
      : '';
    return {
      success: true,
      mode: 'native',
      externalSessionId,
      // Message usage describes the summarization request, not the size of the
      // compacted context. Keep it diagnostic and let LocalAgent show an
      // estimate until the next normal turn reports authoritative input usage.
      compactionUsage: usage ? {
        input_tokens: Number(usage.prompt_tokens || 0),
        output_tokens: Number(usage.completion_tokens || 0),
        total_tokens: Number(usage.total_tokens || 0),
        cached_tokens: Number(usage.cached_tokens || 0)
      } : null,
      checkpointSummary: checkpointSummary || null,
      contextLength: Number(usage?.contextLength || 0) || null
    };
  }

  async testModel(model, options = {}) {
    const scope = normalizeScopeOptions(options);
    const cwd = await this._resolveWorkspaceRoot(scope);
    const runtime = await this._ensureRuntime(scope, cwd);
    const created = await this._request(runtime, {
      method: 'post',
      url: '/session',
      data: {
        title: `LocalAgent test ${new Date().toISOString()}`
      },
      timeoutMs: STATUS_TIMEOUT_MS
    });
    const sessionId = normalizeString(created?.id || created?.data?.id || '', '');
    if (!sessionId) {
      throw new Error('OpenCode did not return a session id');
    }

    const parsedModel = splitOpenCodeModelRef(model);
    const response = await this._request(runtime, {
      method: 'post',
      url: `/session/${encodeURIComponent(sessionId)}/message`,
      data: {
        model: {
          providerID: parsedModel.providerID,
          modelID: parsedModel.modelID
        },
        parts: [{ type: 'text', text: 'Reply with a very short hello.' }]
      }
    });
    await this._request(runtime, {
      method: 'delete',
      url: `/session/${encodeURIComponent(sessionId)}`
    }).catch(() => {});

    return {
      model: buildOpenCodeModelRef(parsedModel.providerID, parsedModel.modelID),
      content: collectAssistantText(response) || ''
    };
  }

  async runTurn(input = {}, options = {}) {
    const scope = normalizeScopeOptions(options);
    const sessionKey = normalizeSessionKey(input);
    const priorState = sessionKey ? await this._readSessionState(sessionKey, scope) : null;
    const cwd = await this._resolveWorkspaceRoot({
      ...scope,
      requestContext: input.requestContext || scope.requestContext || null
    });
    let runtime = await this._ensureRuntime(scope, cwd);
    const modelRef = await this._resolveModel(input, scope);
    const rawPrompt = normalizeString(input.message || input.prompt || '', '');
    const latestHistoryContent = Array.isArray(input.history)
      ? input.history.slice().reverse().map(entry => normalizeString(entry?.content || '', '')).find(Boolean)
      : '';
    const currentPrompt = rawPrompt || latestHistoryContent || 'Continue.';
    const historyPrompt = buildHistoryPrompt(input.history || [], rawPrompt);
    const systemPrompt = await this._buildSystemPrompt(input);
    const canReuseRemoteSession = normalizeString(priorState?.externalSessionId || '', '')
      && normalizeString(priorState?.externalRuntimeUrl || '', '')
      && normalizeString(priorState?.externalRuntimeUrl || '', '') === normalizeString(runtime.url || '', '');
    let continuity = canReuseRemoteSession
      ? this._buildContinuityState('remote-reused', 'remote-session-reused', runtime, priorState)
      : this._buildContinuityState(
        normalizeString(priorState?.externalSessionId || '', '') ? 'history-replayed' : 'fresh-session',
        normalizeString(priorState?.externalSessionId || '', '') ? 'runtime-changed' : 'fresh-session-created',
        runtime,
        priorState
      );
    let sessionId = await this._ensureSession(runtime, sessionKey, priorState, input, {
      allowReuseExistingSession: Boolean(canReuseRemoteSession)
    });
    continuity = {
      ...continuity,
      externalSessionId: normalizeString(sessionId || continuity.externalSessionId || '', ''),
      externalRuntimeUrl: normalizeString(runtime?.url || continuity.externalRuntimeUrl || '', ''),
      updatedAt: new Date().toISOString()
    };
    let prompt = canReuseRemoteSession ? currentPrompt : historyPrompt;
    const activeRuntimes = new Set();
    let eventSubscription = null;
    runtime.activeSessionIds.add(sessionId);
    activeRuntimes.add(runtime);

    try {
      input.turnEvents?.emit?.({ type: 'status', phase: 'connecting', message: 'Connecting to OpenCode' });
      let response = null;
      try {
        input.turnEvents?.emit?.({ type: 'status', phase: 'thinking', message: 'OpenCode is working' });
        eventSubscription = await this._subscribeTurnEvents(runtime, sessionId, input.turnEvents).catch(() => null);
        response = await this._sendSessionMessage(runtime, sessionId, modelRef, prompt, systemPrompt);
        if (eventSubscription?.state?.error) throw eventSubscription.state.error;
      } catch (error) {
        const shouldRecoverRuntime = isRecoverableRuntimeError(error);
        const shouldRecoverSession = canReuseRemoteSession && isRecoverableSessionError(error);
        if (!shouldRecoverRuntime && !shouldRecoverSession) {
          throw error;
        }

        runtime.activeSessionIds.delete(sessionId);
        eventSubscription?.close?.();
        eventSubscription = null;
        if (shouldRecoverRuntime) {
          await this._disposeRuntime(this._scopeKey(scope), runtime);
          runtime = await this._ensureRuntime(scope, cwd);
          activeRuntimes.add(runtime);
        }

        sessionId = await this._ensureSession(runtime, sessionKey, null, input, {
          allowReuseExistingSession: false
        });
        prompt = historyPrompt;
        runtime.activeSessionIds.add(sessionId);
        continuity = this._buildContinuityState(
          'history-replayed',
          shouldRecoverSession ? 'stale-remote-session' : 'runtime-restarted',
          runtime,
          priorState
        );
        continuity = {
          ...continuity,
          externalSessionId: normalizeString(sessionId || continuity.externalSessionId || '', ''),
          externalRuntimeUrl: normalizeString(runtime?.url || continuity.externalRuntimeUrl || '', ''),
          updatedAt: new Date().toISOString()
        };
        eventSubscription = await this._subscribeTurnEvents(runtime, sessionId, input.turnEvents).catch(() => null);
        response = await this._sendSessionMessage(runtime, sessionId, modelRef, prompt, systemPrompt);
        if (eventSubscription?.state?.error) throw eventSubscription.state.error;
      }

      const content = collectAssistantText(response) || '';
      const reasoning = collectAssistantReasoning(response) || '';
      if (content) input.turnEvents?.emit?.({ type: 'content.snapshot', text: content });
      const extractedUsage = extractOpenCodeUsage(response);
      if (extractedUsage) input.turnEvents?.emit?.({ type: 'usage.updated', usage: extractedUsage });
      const resolvedContextLength = (
        Number(extractedUsage?.contextLength || 0) > 0
          ? Number(extractedUsage.contextLength)
          : await this._resolveContextLengthForTurn(modelRef, input, scope)
      ) || null;
      const hasRealInput = Number(extractedUsage?.prompt_tokens || 0) > 0;
      if (sessionKey) {
        await this._writeSessionState(sessionKey, scope, {
          providerId: DEFAULT_PROVIDER_ID,
          externalSessionId: sessionId,
          externalRuntimeKind: 'opencode-serve',
          externalRuntimeUrl: runtime.url,
          workspaceRoot: cwd,
          lastUsedAt: new Date().toISOString(),
          lastModel: modelRef.value,
          continuity
        });
      }
      return {
        content,
        reasoning,
        model: modelRef.value,
        usage: extractedUsage
          ? {
            input_tokens: Number(extractedUsage.prompt_tokens || 0),
            prompt_tokens: Number(extractedUsage.prompt_tokens || 0),
            output_tokens: Number(extractedUsage.completion_tokens || 0),
            completion_tokens: Number(extractedUsage.completion_tokens || 0),
            total_tokens: Number(extractedUsage.total_tokens || 0),
            cached_tokens: Number(extractedUsage.cached_tokens || 0),
            cache_write_tokens: Number(extractedUsage.cache_write_tokens || 0),
            reasoning_output_tokens: Number(extractedUsage.reasoning_output_tokens || 0),
            ...(resolvedContextLength ? { contextLength: resolvedContextLength } : {}),
            estimated: !hasRealInput
          }
          : {
            ...(resolvedContextLength ? { contextLength: resolvedContextLength } : {}),
            estimated: true
          },
        ...(hasRealInput ? { context_tokens: Number(extractedUsage.prompt_tokens), source: 'provider' } : {}),
        ...(resolvedContextLength ? { context_length: resolvedContextLength } : {}),
        renderContext: {
          provider: DEFAULT_PROVIDER_ID,
          model: modelRef.value,
          continuity,
          requestContext: scope.requestContext || null,
          runtimeConfig: input.runtimeConfig || null
        }
      };
    } finally {
      eventSubscription?.close?.();
      for (const activeRuntime of activeRuntimes) {
        activeRuntime?.activeSessionIds?.delete?.(sessionId);
      }
    }
  }

  _normalizeGetModelsArgs(forceRefreshOrOptions = false, maybeOptions = {}) {
    if (typeof forceRefreshOrOptions === 'object' && forceRefreshOrOptions && !Array.isArray(forceRefreshOrOptions)) {
      return {
        forceRefresh: false,
        options: forceRefreshOrOptions
      };
    }
    return {
      forceRefresh: forceRefreshOrOptions === true,
      options: maybeOptions || {}
    };
  }

  async _resolveModel(input = {}, scope = {}) {
    const rawModel = normalizeString(
      input.model
      || await this.db.getScopedSetting?.('llm.model', scope)
      || '',
      ''
    );
    const parsed = splitOpenCodeModelRef(rawModel);
    if (parsed.providerID && parsed.modelID) {
      return {
        ...parsed,
        value: buildOpenCodeModelRef(parsed.providerID, parsed.modelID)
      };
    }

    const defaults = await this._getDefaultModels(scope);
    const firstDefaultProvider = Object.keys(defaults)[0] || 'opencode';
    const firstDefaultModel = normalizeString(defaults[firstDefaultProvider], '') || rawModel;
    const value = buildOpenCodeModelRef(firstDefaultProvider, firstDefaultModel);
    const fallback = splitOpenCodeModelRef(value);
    return {
      ...fallback,
      value
    };
  }

  async _resolveContextLengthForTurn(modelRef = {}, input = {}, scope = {}) {
    const caps = input?.modelSpec?.capabilities?.contextWindow || {};
    const runtimeContext = Number(input?.runtimeConfig?.contextWindow?.value || 0);
    if (caps.configurable && runtimeContext > 0) return runtimeContext;

    const cacheKey = normalizeString(modelRef?.value || '', '').toLowerCase();
    const cached = Number(this.modelContextWindowCache.get(cacheKey) || 0);
    if (cached > 0) return cached;

    try {
      const modelOptions = await this.getModelOptions('', false, scope);
      const matched = modelOptions.find(entry => normalizeString(entry?.value || '', '').toLowerCase() === cacheKey);
      const discovered = Number(matched?.contextWindow || 0);
      if (discovered > 0) {
        this.modelContextWindowCache.set(cacheKey, discovered);
        return discovered;
      }
    } catch (_error) {
      // Context remains unknown when OpenCode discovery is unavailable.
    }

    if (!caps.supported) return null;
    const modelSpecContext = Number(input?.modelSpec?.runtime?.contextWindow?.value || 0);
    return modelSpecContext > 0 ? modelSpecContext : (runtimeContext > 0 ? runtimeContext : null);
  }

  async _buildSystemPrompt(input = {}) {
    if (input.systemPrompt !== undefined) {
      return `${String(input.systemPrompt || '')}${LOCALAGENT_TOOL_BRIDGE_INSTRUCTIONS}`;
    }
    if (!this.dispatcher?._buildSystemPrompt) return LOCALAGENT_TOOL_BRIDGE_INSTRUCTIONS.trim();
    const basePrompt = await this.dispatcher._buildSystemPrompt({
      includeTools: input.includeTools === undefined ? true : input.includeTools === true,
      includeRules: input.includeRules === undefined ? true : input.includeRules === true,
      includeEnv: input.includeEnv === undefined ? true : input.includeEnv === true,
      skipMemoryOnStart: input.skipMemoryOnStart === true,
      sessionId: input.sessionId || null,
      agentId: input.agentId || null,
      requestContext: input.requestContext || null,
      completionTools: Array.isArray(input.completionTools) ? input.completionTools : []
    });
    return `${String(basePrompt || '')}${LOCALAGENT_TOOL_BRIDGE_INSTRUCTIONS}`;
  }

  async _resolveWorkspaceRoot(options = {}) {
    const requestContextRoot = normalizeString(
      options?.requestContext?.executionRoot
      || options?.requestContext?.rootPath
      || '',
      ''
    );
    if (requestContextRoot) return requestContextRoot;

    if (this.executionDirectory?.getRoot) {
      return this.executionDirectory.getRoot();
    }

    const configured = normalizeString(
      await this.db.getScopedSetting?.('execution.rootPath', options)
      || await this.db.getSetting?.('execution.rootPath')
      || '',
      ''
    );
    return configured || process.cwd();
  }

  async _getDefaultModels(options = {}) {
    try {
      const providerMeta = await this._getProviderMeta(options);
      return providerMeta?.defaults || {};
    } catch (_error) {
      return {};
    }
  }

  async _ensureSession(runtime, sessionKey, priorState = null, input = {}, options = {}) {
    const existingId = normalizeString(priorState?.externalSessionId || '', '');
    if (existingId && options?.allowReuseExistingSession === true) {
      return existingId;
    }
    const created = await this._request(runtime, {
      method: 'post',
      url: '/session',
      data: {
        title: normalizeString(input.title || sessionKey || 'LocalAgent Chat', 'LocalAgent Chat')
      },
      timeoutMs: STATUS_TIMEOUT_MS
    });
    const sessionId = normalizeString(created?.id || created?.data?.id || '', '');
    if (!sessionId) {
      throw new Error('OpenCode did not return a session id');
    }
    return sessionId;
  }

  async _sendSessionMessage(runtime, sessionId, modelRef, prompt, systemPrompt = '') {
    const providerID = normalizeString(modelRef?.providerID || '', '').toLowerCase();
    const isOpenCodeNative = providerID === 'opencode';
    return this._request(runtime, {
      method: 'post',
      url: `/session/${encodeURIComponent(sessionId)}/message`,
      data: {
        model: {
          providerID: modelRef.providerID,
          modelID: modelRef.modelID
        },
        ...(systemPrompt ? { system: systemPrompt } : {}),
        // opencode 1.18+ stops honoring the per-message tools-disable map for
        // opencode-native models: sending the full DISABLED_NATIVE_TOOLS map
        // (which includes legacy tool ids) makes the turn stall against the
        // provider. For opencode-native models rely on the system bridge
        // instructions instead. Other providers keep the legacy disable map.
        ...(isOpenCodeNative ? {} : { tools: { ...DISABLED_NATIVE_TOOLS } }),
        parts: [{ type: 'text', text: prompt }]
      }
    });
  }

  async _subscribeTurnEvents(runtime, sessionId, turnEvents = null) {
    if (!turnEvents?.emit) return null;
    const controller = new AbortController();
    runtime.requestControllers.add(controller);
    const response = await nativeHttpRequest({
      url: new URL('/event', runtime.url).toString(),
      method: 'get',
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Basic ${Buffer.from(`${runtime.username}:${runtime.password}`).toString('base64')}`
      },
      responseType: 'stream',
      timeout: 0,
      signal: controller.signal,
      validateStatus: status => status >= 200 && status < 300
    });
    let buffer = '';
    const state = { assistantMessageIds: new Set(), error: null };
    response.data.setEncoding?.('utf8');
    response.data.on('data', chunk => {
      buffer += String(chunk || '');
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '').trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line.startsWith('data:')) continue;
        try {
          const envelope = JSON.parse(line.slice(5).trim());
          this._emitOpenCodeEvent(envelope?.payload || envelope, sessionId, turnEvents, state);
        } catch (_error) {
          // Ignore keepalives and forward-compatible event payloads.
        }
      }
    });
    const close = () => {
      controller.abort();
      runtime.requestControllers.delete(controller);
      response.data.destroy?.();
    };
    response.data.on('close', () => runtime.requestControllers.delete(controller));
    response.data.on('error', () => runtime.requestControllers.delete(controller));
    return { close, state };
  }

  _emitOpenCodeEvent(event = {}, sessionId, turnEvents, state = { assistantMessageIds: new Set(), error: null }) {
    const type = normalizeString(event.type || '', '').toLowerCase();
    const properties = event.properties || event.data || {};
    const part = properties.part || {};
    const eventSessionId = normalizeString(
      properties.sessionID || properties.sessionId || part.sessionID || part.sessionId || '',
      ''
    );
    if (eventSessionId && eventSessionId !== String(sessionId)) return;
    if (type === 'message.updated') {
      const info = properties.info || {};
      if (info.role === 'assistant' && info.id) state.assistantMessageIds.add(info.id);
      return;
    }
    if (type === 'message.part.updated') {
      const partType = normalizeString(part.type || '', '').toLowerCase();
      if (part.messageID && !state.assistantMessageIds.has(part.messageID)) return;
      const delta = typeof properties.delta === 'string' ? properties.delta : '';
      if (partType === 'text') {
        turnEvents.emit(delta
          ? { type: 'content.delta', text: delta }
          : { type: 'content.snapshot', text: String(part.text || '') });
        return;
      }
      if (partType.includes('reason')) {
        turnEvents.emit(delta
          ? { type: 'reasoning.delta', text: delta }
          : { type: 'reasoning.snapshot', text: String(part.text || part.reasoning || '') });
        return;
      }
      if (partType === 'tool') {
        const state = part.state || {};
        const status = normalizeString(state.status || 'running', 'running').toLowerCase();
        const completed = ['completed', 'success', 'error', 'failed'].includes(status);
        turnEvents.emit({
          type: completed ? 'action.completed' : (status === 'running' ? 'action.started' : 'action.updated'),
          action: {
            id: part.id || part.callID || null,
            kind: 'tool',
            name: part.tool || part.name || 'tool',
            params: state.input || part.input || {},
            result: state.output || part.output || null,
            error: state.error || part.error || null,
            status: ['error', 'failed'].includes(status) ? 'error' : (completed ? 'success' : 'running')
          }
        });
      }
      return;
    }
    if (type === 'session.status') {
      const status = normalizeString(properties.status?.type || properties.status || 'working', 'working');
      turnEvents.emit({ type: 'status', phase: status, message: `OpenCode: ${status}` });
      return;
    }
    if (type === 'session.error') {
      const detail = properties.error?.data?.message || properties.error?.message || properties.error || 'OpenCode failed';
      state.error = new Error(String(detail));
      turnEvents.emit({ type: 'status', phase: 'error', message: `OpenCode error: ${detail}` });
    }
  }

  async _listModelsFromCli(providerFilter = '', forceRefresh = false, options = {}) {
    const command = await this._resolveOpenCodeCommand(options);
    const args = ['models', '--verbose'];
    if (forceRefresh) args.push('--refresh');
    if (providerFilter) args.push(providerFilter);

    const result = spawnSync(command, args, {
      cwd: await this._resolveWorkspaceRoot(options),
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...process.env,
        NO_COLOR: '1'
      },
      maxBuffer: 16 * 1024 * 1024
    });

    if (result.error || result.status !== 0) {
      const message = result.error?.message || `${result.stderr || result.stdout || ''}`.trim() || 'OpenCode model discovery failed';
      throw new Error(message);
    }

    const parsed = parseOpenCodeModelsVerboseOutput(result.stdout || '');
    return parsed;
  }

  async _getProviderMeta(options = {}, runtime = null) {
    const cwd = runtime?.cwd || await this._resolveWorkspaceRoot(options);
    const activeRuntime = runtime || await this._ensureRuntime(options, cwd);
    const [providerPayload, configPayload] = await Promise.all([
      this._request(activeRuntime, {
        method: 'get',
        url: '/provider',
        timeoutMs: STATUS_TIMEOUT_MS
      }),
      this._request(activeRuntime, {
        method: 'get',
        url: '/config/providers',
        timeoutMs: STATUS_TIMEOUT_MS
      })
    ]);

    const connected = Array.isArray(providerPayload?.connected) ? providerPayload.connected : [];
    const defaults = {
      ...(configPayload?.default && typeof configPayload.default === 'object' ? configPayload.default : {}),
      ...(providerPayload?.default && typeof providerPayload.default === 'object' ? providerPayload.default : {})
    };
    const all = Array.isArray(providerPayload?.all)
      ? providerPayload.all
      : (Array.isArray(configPayload?.providers) ? configPayload.providers : []);

    return {
      connected,
      defaults,
      all
    };
  }

  async _ensureRuntime(options = {}, cwd = '') {
    const scope = normalizeScopeOptions(options);
    const key = this._scopeKey(scope);
    const existing = this.runtimeMap.get(key) || null;
    if (existing) {
      if (existing.cwd !== cwd) {
        await this._disposeRuntime(key, existing);
      } else if (existing.readyPromise) {
        return existing.readyPromise;
      } else {
        try {
          await this._healthcheck(existing);
          existing.connected = true;
          return existing;
        } catch (_error) {
          await this._disposeRuntime(key, existing);
        }
      }
    }

    const command = await this._resolveOpenCodeCommand(scope);
    const port = await allocatePort(DEFAULT_HOSTNAME);
    const password = crypto.randomBytes(18).toString('base64url');
    const url = `http://${DEFAULT_HOSTNAME}:${port}`;
    const child = spawn(command, ['serve', '--hostname', DEFAULT_HOSTNAME, '--port', String(port)], {
      cwd,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
      env: {
        ...process.env,
        NO_COLOR: '1',
        OPENCODE_SERVER_USERNAME: DEFAULT_USERNAME,
        OPENCODE_SERVER_PASSWORD: password
      }
    });

    let stderr = '';
    let stdout = '';

    const runtime = {
      child,
      command,
      connected: false,
      cwd,
      key,
      password,
      requestControllers: new Set(),
      activeSessionIds: new Set(),
      startedAt: new Date().toISOString(),
      stderr,
      stdout,
      url,
      username: DEFAULT_USERNAME,
      spawnError: null,
      readyPromise: null
    };

    child.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 6000) {
        stdout = stdout.slice(stdout.length - 6000);
      }
      runtime.stdout = stdout;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 6000) {
        stderr = stderr.slice(stderr.length - 6000);
      }
      runtime.stderr = stderr;
    });
    child.on('error', error => {
      runtime.spawnError = error;
      runtime.connected = false;
    });

    this.runtimeMap.set(key, runtime);

    child.on('exit', () => {
      const active = this.runtimeMap.get(key);
      if (active === runtime) {
        this.runtimeMap.delete(key);
      }
      runtime.connected = false;
      runtime.readyPromise = null;
    });

    const readyPromise = (async () => {
      try {
        await this._waitForHealth(runtime);
        runtime.connected = true;
        await this.db.saveScopedSetting?.('llm.opencode.lastServerUrl', url, scope);
        return runtime;
      } catch (error) {
        await this._disposeRuntime(key, runtime);
        const detail = [error.message, stderr.trim(), stdout.trim()].filter(Boolean).join(' ');
        throw new Error(detail || 'OpenCode server did not become healthy');
      } finally {
        if (runtime.readyPromise === readyPromise) {
          runtime.readyPromise = null;
        }
      }
    })();

    runtime.readyPromise = readyPromise;
    return readyPromise;
  }

  async _shouldAutoStart(options = {}) {
    const configured = await this.db.getScopedSetting?.('llm.opencode.autoStart', options);
    return String(configured || 'true').trim().toLowerCase() !== 'false';
  }

  async _resolveOpenCodeCommand(options = {}) {
    const configured = normalizeString(
      process.env.LOCALAGENT_OPENCODE_PATH
      || process.env.OPENCODE_PATH
      || await this.db.getScopedSetting?.('llm.opencode.commandPath', options)
      || '',
      ''
    );
    if (process.platform === 'win32') {
      return resolveWindowsOpenCodeCommand(configured);
    }
    return configured || 'opencode';
  }

  async _healthcheck(runtime) {
    return this._request(runtime, {
      method: 'get',
      url: '/global/health',
      timeoutMs: STATUS_TIMEOUT_MS
    });
  }

  async _waitForHealth(runtime) {
    const startedAt = Date.now();
    let lastError = null;
    while ((Date.now() - startedAt) < STATUS_TIMEOUT_MS) {
      if (runtime.spawnError) {
        throw new Error(`Failed to start OpenCode: ${runtime.spawnError.message}`);
      }
      if (runtime.child.exitCode !== null && runtime.child.exitCode !== undefined) {
        throw new Error(`OpenCode server exited with code ${runtime.child.exitCode}`);
      }
      try {
        return await this._healthcheck(runtime);
      } catch (error) {
        lastError = error;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    throw lastError || new Error('Timed out waiting for OpenCode server health');
  }

  async _request(runtime, request = {}) {
    const controller = new AbortController();
    runtime.requestControllers.add(controller);
    try {
      const response = await nativeHttpRequest({
        url: new URL(request.url, runtime.url).toString(),
        method: request.method || 'get',
        data: request.data,
        headers: {
          Authorization: `Basic ${Buffer.from(`${runtime.username}:${runtime.password}`).toString('base64')}`
        },
        timeout: Number(request.timeoutMs || REQUEST_TIMEOUT_MS) || REQUEST_TIMEOUT_MS,
        signal: controller.signal,
        validateStatus: status => status >= 200 && status < 300
      });
      return response.data;
    } finally {
      runtime.requestControllers.delete(controller);
    }
  }

  async _abortRemoteSession(runtime, sessionId) {
    if (!sessionId) return false;
    try {
      await nativeHttpRequest({
        url: new URL(`/session/${encodeURIComponent(sessionId)}/abort`, runtime.url).toString(),
        method: 'post',
        headers: {
          Authorization: `Basic ${Buffer.from(`${runtime.username}:${runtime.password}`).toString('base64')}`
        },
        timeout: STATUS_TIMEOUT_MS,
        validateStatus: status => status >= 200 && status < 500
      });
      return true;
    } catch (_error) {
      return false;
    }
  }

  async _disposeRuntime(key, runtime) {
    if (!runtime) return;
    this.runtimeMap.delete(key);
    runtime.requestControllers?.forEach(controller => controller.abort());
    runtime.requestControllers?.clear?.();
    if (runtime.child && !runtime.child.killed) {
      runtime.child.kill();
    }
  }

  _scopeKey(scope = {}) {
    return normalizeString(scope?.userId || 'localuser', 'localuser');
  }

  _buildContinuityState(mode, reason, runtime = null, priorState = null) {
    const normalizedMode = normalizeString(mode, '');
    const label = normalizedMode === 'remote-reused'
      ? 'live remote'
      : (normalizedMode === 'history-replayed'
        ? 'history replay'
        : (normalizedMode === 'fresh-session' ? 'fresh remote' : normalizedMode));
    return {
      provider: DEFAULT_PROVIDER_ID,
      mode: normalizedMode || 'unknown',
      label,
      reason: normalizeString(reason, 'unknown'),
      externalRuntimeUrl: normalizeString(runtime?.url || priorState?.externalRuntimeUrl || '', ''),
      externalSessionId: normalizeString(priorState?.externalSessionId || '', ''),
      updatedAt: new Date().toISOString()
    };
  }

  async getSessionContinuityStatus(sessionId, options = {}) {
    const normalizedSessionId = normalizeSessionKey({ sessionId });
    if (!normalizedSessionId) return null;
    const scope = normalizeScopeOptions(options);
    const state = await this._readSessionState(normalizedSessionId, scope);
    if (!state || normalizeString(state.providerId || '', '').toLowerCase() !== DEFAULT_PROVIDER_ID) {
      return null;
    }
    const runtime = this.runtimeMap.get(this._scopeKey(scope)) || null;
    const currentRuntimeUrl = normalizeString(runtime?.url || '', '');
    const savedRuntimeUrl = normalizeString(state.externalRuntimeUrl || '', '');
    const currentSessionId = normalizeString(state.externalSessionId || '', '');
    const continuity = state.continuity && typeof state.continuity === 'object'
      ? { ...state.continuity }
      : this._buildContinuityState('fresh-session', 'state-restored', runtime, state);
    return {
      ...continuity,
      externalSessionId: currentSessionId || normalizeString(continuity.externalSessionId || '', ''),
      externalRuntimeUrl: savedRuntimeUrl || normalizeString(continuity.externalRuntimeUrl || '', ''),
      likelyReusable: Boolean(
        runtime
        && runtime.connected === true
        && savedRuntimeUrl
        && currentRuntimeUrl
        && savedRuntimeUrl === currentRuntimeUrl
        && currentSessionId
      ),
      liveRuntimeConnected: Boolean(runtime?.connected === true)
    };
  }

  _sessionStateKey(sessionId) {
    return `session.runtime.opencode.${sessionId}`;
  }

  async _readSessionState(sessionId, options = {}) {
    if (!this.db?.getScopedSetting) return null;
    try {
      const raw = await this.db.getScopedSetting(this._sessionStateKey(sessionId), options);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_error) {
      return null;
    }
  }

  async _writeSessionState(sessionId, options = {}, state = {}) {
    if (!this.db?.saveScopedSetting) return;
    await this.db.saveScopedSetting(this._sessionStateKey(sessionId), JSON.stringify(state), options);
  }
}

module.exports = {
  OpenCodeRuntimeManager,
  DEFAULT_PROVIDER_ID,
  buildOpenCodeModelRef,
  deriveOpenCodeModelBadge,
  deriveOpenCodeModelFlags,
  formatOpenCodeCostText,
  formatOpenCodeModelLabel,
  parseOpenCodeModelsVerboseOutput,
  resolveOpenCodeShimExecutable,
  splitOpenCodeModelRef
};
