// @ts-nocheck
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { getProviderCachePolicy } = require('./model-cache-policy');
const { buildCodexResponseBody } = require('./codex/codex-responses-mapper');
const { requestCodexResponse } = require('./codex/codex-responses-client');

const DEFAULT_PROVIDER_ID = 'local-codex';
const DEFAULT_MODELS = [
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini'
];
const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const DEFAULT_CONTEXT_LENGTH = 258400;
const REQUEST_TIMEOUT_MS = 45000;
const AUTH_REFRESH_SKEW_MS = 2 * 60 * 1000;
const MAX_MODEL_PAGES = 20;

function normalizeString(value, fallback = '') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function normalizeScopeOptions(options = {}) {
  const requestContext = options?.requestContext || null;
  const userId = normalizeString(options?.userId || requestContext?.userId || '', '');
  return {
    requestContext,
    userId: userId || 'localuser'
  };
}

function coerceErrorMessage(error, fallback = 'Codex request failed') {
  return normalizeString(
    error?.message
    || error?.error?.message
    || error,
    fallback
  );
}

function parseJson(value, fallback = null) {
  if (value && typeof value === 'object') return value;
  try {
    return JSON.parse(String(value || ''));
  } catch (_error) {
    return fallback;
  }
}

function decodeJwtPayload(token) {
  const encoded = String(token || '').split('.')[1];
  if (!encoded) throw new Error('Codex returned an invalid access token');
  const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
}

function accountIdFromToken(token) {
  const payload = decodeJwtPayload(token);
  return normalizeString(
    payload?.['https://api.openai.com/auth']?.chatgpt_account_id
    || payload?.organizations?.[0]?.id
    || payload?.chatgpt_account_id,
    ''
  );
}

function tokenExpiryFromToken(token) {
  const expiresAt = Number(decodeJwtPayload(token)?.exp || 0) * 1000;
  return Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : 0;
}

function normalizeUsage(usage = {}) {
  const input = Number(
    usage.inputTokens?.total
    ?? usage.inputTokens
    ?? usage.input_tokens
    ?? 0
  ) || 0;
  const output = Number(
    usage.outputTokens?.total
    ?? usage.outputTokens
    ?? usage.output_tokens
    ?? 0
  ) || 0;
  const cached = Number(
    usage.inputTokens?.cacheRead
    ?? usage.inputTokenDetails?.cacheReadTokens
    ?? usage.cachedInputTokens
    ?? usage.input_tokens_details?.cached_tokens
    ?? 0
  ) || 0;
  const reasoning = Number(
    usage.outputTokenDetails?.reasoningTokens
    ?? usage.reasoningOutputTokens
    ?? usage.output_tokens_details?.reasoning_tokens
    ?? 0
  ) || 0;
  return {
    input_tokens: input,
    prompt_tokens: input,
    output_tokens: output,
    completion_tokens: output,
    total_tokens: Number(usage.totalTokens ?? usage.total_tokens ?? input + output) || input + output,
    cached_tokens: cached,
    reasoning_output_tokens: reasoning,
    estimated: input <= 0
  };
}

function imageMediaType(attachment = {}) {
  const supplied = normalizeString(attachment.mimeType || attachment.mediaType, '');
  if (supplied.startsWith('image/')) return supplied;
  const extension = path.extname(String(attachment.path || '')).toLowerCase();
  return ({
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif'
  })[extension] || 'image/png';
}

class CodexRuntimeManager {
  constructor(options = {}) {
    this.db = options.db || null;
    this.windowManager = options.windowManager || null;
    this.runtimePaths = options.runtimePaths || {};
    this.dispatcher = options.dispatcher || null;
    this.mcpServer = options.mcpServer || this.dispatcher?.mcpServer || null;
    this.activeProfile = options.activeProfile || null;
    this.runtimeMap = new Map();
    this.runtimeStartPromises = new Map();
    this.authCache = new Map();
    this.authPromises = new Map();
    this.sessionSalt = crypto.randomBytes(16);
    this.activeRequests = new Map();
    this.codexBaseUrl = options.codexBaseUrl || CODEX_BASE_URL;
    this.codexHttpRequest = options.codexHttpRequest || null;
    this.modelCache = { models: [], updatedAt: 0 };
    this.modelMetadata = new Map();
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
    return normalizeString(providerId, '').toLowerCase() === DEFAULT_PROVIDER_ID;
  }

  getLastModelDiscovery() {
    return { ...this.lastModelDiscovery };
  }

  setAgentManager(_agentManager) {
    // LocalAgent already owns agents and tools; the direct transport needs no agent bridge.
  }

  get isGenerating() {
    return this.activeRequests.size > 0;
  }

  stop() {
    const hadActiveWork = this.activeRequests.size > 0 || this.runtimeMap.size > 0;
    for (const controller of this.activeRequests.values()) {
      controller.abort();
    }
    this.activeRequests.clear();
    for (const runtime of Array.from(this.runtimeMap.values())) {
      this._disposeRuntime(runtime, 'Codex auth broker stopped');
    }
    this.authCache.clear();
    this.authPromises.clear();
    this.runtimeStartPromises.clear();
    return hadActiveWork;
  }

  _recordModelDiscovery(meta = {}) {
    const models = Array.isArray(meta.models) ? meta.models : [];
    this.lastModelDiscovery = {
      ok: meta.ok === undefined ? true : Boolean(meta.ok),
      source: String(meta.source || 'unknown'),
      authoritative: Boolean(meta.authoritative),
      error: meta.error ? String(meta.error) : null,
      count: models.length,
      at: new Date().toISOString()
    };
    return models;
  }

  async getModels(forceRefreshOrOptions = false, maybeOptions = {}) {
    const forceRefresh = forceRefreshOrOptions === true;
    const options = typeof forceRefreshOrOptions === 'object' && forceRefreshOrOptions && !Array.isArray(forceRefreshOrOptions)
      ? forceRefreshOrOptions
      : (maybeOptions || {});
    const cachePolicy = getProviderCachePolicy(DEFAULT_PROVIDER_ID);
    const cacheIsFresh = this.modelCache.models.length > 0
      && Date.now() - this.modelCache.updatedAt < cachePolicy.ttlMs;
    if (!forceRefresh && cacheIsFresh) {
      const models = this.modelCache.models.slice();
      this._recordModelDiscovery({ ok: true, source: 'cache', authoritative: true, models });
      return models;
    }

    try {
      const scope = normalizeScopeOptions(options);
      await this._getAuth(scope, { forceRefresh });
      const runtime = await this._ensureRuntime(scope);
      const models = [];
      let cursor = null;
      let pageCount = 0;
      do {
        const result = await this._request(runtime, 'model/list', {
          includeHidden: false,
          limit: 100,
          ...(cursor ? { cursor } : {})
        });
        const page = Array.isArray(result?.data) ? result.data : [];
        for (const item of page) {
          if (item?.hidden) continue;
          const id = normalizeString(item?.model || item?.id || item?.slug, '');
          if (!id) continue;
          models.push(id);
          this.modelMetadata.set(id, { ...item });
        }
        cursor = normalizeString(result?.nextCursor, '') || null;
        pageCount += 1;
      } while (cursor && pageCount < MAX_MODEL_PAGES);

      const discovered = Array.from(new Set(models));
      if (discovered.length === 0) throw new Error('Codex returned an empty model list');
      this.modelCache = { models: discovered.slice(), updatedAt: Date.now() };
      this._recordModelDiscovery({ ok: true, source: 'live', authoritative: true, models: discovered });
      return discovered;
    } catch (error) {
      const cached = this.modelCache.models.length > 0
        ? this.modelCache.models.slice()
        : DEFAULT_MODELS.slice();
      this._recordModelDiscovery({
        ok: false,
        source: this.modelCache.models.length > 0 ? 'cache' : 'static',
        authoritative: this.modelCache.models.length > 0,
        error: coerceErrorMessage(error, 'Codex model discovery failed'),
        models: cached
      });
      return cached;
    }
  }

  async getStatus(options = {}) {
    const command = this._resolveCodexCommand();
    const version = spawnSync(command, ['--version'], {
      encoding: 'utf8',
      windowsHide: true
    });
    if (version.error || version.status !== 0) {
      return {
        installed: false,
        loggedIn: false,
        path: fs.existsSync(command) ? command : '',
        error: version.error?.message || `${version.stderr || version.stdout || ''}`.trim() || 'Codex CLI not found',
        models: DEFAULT_MODELS.slice(),
        transport: 'direct-responses'
      };
    }

    try {
      const runtime = await this._ensureRuntime(options);
      const auth = await this._request(runtime, 'getAuthStatus', {
        includeToken: false,
        refreshToken: false
      }, 10000);
      const authMethod = normalizeString(auth?.authMethod, '');
      return {
        installed: true,
        loggedIn: Boolean(authMethod),
        authMethod: authMethod || null,
        path: command,
        version: `${version.stdout || version.stderr || ''}`.trim(),
        requiresOpenaiAuth: auth?.requiresOpenaiAuth === true,
        models: await this.getModels(false, options),
        transport: 'direct-responses',
        credentialsStoredByLocalAgent: false
      };
    } catch (error) {
      return {
        installed: true,
        loggedIn: false,
        path: command,
        version: `${version.stdout || version.stderr || ''}`.trim(),
        error: coerceErrorMessage(error, 'Codex auth broker did not respond'),
        models: DEFAULT_MODELS.slice(),
        transport: 'direct-responses'
      };
    }
  }

  async launchLogin() {
    this.authCache.clear();
    const command = this._resolveCodexCommand();
    const child = spawn(command, ['login'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    child.unref();
    return { launched: true };
  }

  async resetSession(sessionId) {
    const key = normalizeString(sessionId, '');
    return {
      success: true,
      sessionId: key || null,
      stateless: true
    };
  }

  getConversationCapabilities() {
    return {
      continuity: 'local-history',
      manualCompaction: 'local',
      usageReporting: 'provider'
    };
  }

  getModelContextWindow(_model, _options = {}) {
    return DEFAULT_CONTEXT_LENGTH;
  }

  async compactConversation() {
    throw new Error('Direct Codex uses LocalAgent conversation compaction');
  }

  async getDiagnostics(sessionId = null, options = {}) {
    const scope = normalizeScopeOptions(options);
    const runtime = this.runtimeMap.get(this._scopeKey(scope)) || null;
    const auth = this.authCache.get(this._scopeKey(scope)) || null;
    return {
      providerId: DEFAULT_PROVIDER_ID,
      transport: 'direct-responses',
      credentialsStoredByLocalAgent: false,
      authBroker: runtime ? {
        connected: runtime.connected === true,
        startedAt: runtime.startedAt,
        pid: runtime.child?.pid || null,
        command: runtime.command
      } : null,
      credential: auth ? {
        cachedInMemory: true,
        expiresAt: auth.expiresAt ? new Date(auth.expiresAt).toISOString() : null
      } : {
        cachedInMemory: false,
        expiresAt: null
      },
      session: {
        id: normalizeString(sessionId, '') || null,
        providerThread: null,
        localHistory: true
      },
      activeRequests: this.activeRequests.size
    };
  }

  async testModel(model, options = {}) {
    const response = await this.runTurn({
      ...options,
      model: normalizeString(model, DEFAULT_MODELS[0]),
      mode: 'internal',
      includeTools: false,
      includeRules: false,
      includeEnv: false,
      systemPrompt: 'Reply briefly.',
      prompt: 'Reply with hello.',
      history: [],
      runtimeConfig: {
        ...(options.runtimeConfig || {}),
        reasoning: { enabled: true, effort: 'low' }
      }
    }, options);
    return { model: response.model, content: response.content };
  }

  async runTurn(input = {}, options = {}) {
    const scope = normalizeScopeOptions({
      ...options,
      requestContext: input.requestContext || options.requestContext || null,
      userId: input.userId || options.userId
    });
    const model = normalizeString(
      input.model
      || await this.db?.getScopedSetting?.('llm.model', scope)
      || DEFAULT_MODELS[0],
      DEFAULT_MODELS[0]
    );
    const requestId = crypto.randomUUID();
    const controller = new AbortController();
    this.activeRequests.set(requestId, controller);
    input.turnEvents?.emit?.({
      type: 'status',
      phase: 'connecting',
      message: 'Connecting to Codex',
      provider: DEFAULT_PROVIDER_ID
    });

    try {
      try {
        return await this._runDirectTurn({ ...input, model }, scope, controller.signal);
      } catch (error) {
        if (!this._isAuthenticationError(error) || controller.signal.aborted) throw error;
        this.authCache.delete(this._scopeKey(scope));
        return await this._runDirectTurn({ ...input, model }, scope, controller.signal, true);
      }
    } finally {
      this.activeRequests.delete(requestId);
    }
  }

  async _runDirectTurn(input, scope, abortSignal, forceRefreshAuth = false) {
    const auth = await this._getAuth(scope, { forceRefresh: forceRefreshAuth });
    const system = input.systemPrompt !== undefined
      ? String(input.systemPrompt || '')
      : await this._buildSystemPrompt(input);
    const messages = this._buildMessages(input.history || [], input.prompt ?? input.message ?? '', input.attachments || []);
    const definitions = input.includeTools === false
      ? []
      : await this._resolveTools(input);
    const effort = this._resolveReasoningEffort(input);
    input.turnEvents?.emit?.({
      type: 'status',
      phase: 'thinking',
      message: 'Codex is working',
      provider: DEFAULT_PROVIDER_ID
    });

    const body = buildCodexResponseBody({
      model: input.model,
      system,
      messages,
      tools: definitions,
      reasoningEffort: effort
    });
    const streamed = await requestCodexResponse({
      baseUrl: this.codexBaseUrl,
      accessToken: auth.accessToken,
      accountId: auth.accountId,
      sessionId: this._sessionHeader(input),
      body,
      signal: abortSignal,
      timeoutMs: REQUEST_TIMEOUT_MS,
      turnEvents: input.turnEvents || null,
      requestImpl: this.codexHttpRequest || undefined
    });
    const usage = normalizeUsage(streamed.usage);
    input.turnEvents?.emit?.({ type: 'usage.updated', usage });

    return {
      content: streamed.content,
      reasoning: streamed.reasoning,
      model: input.model,
      usage,
      // Provider-returned output metadata is the source of truth. Do not accumulate turns.
      context_tokens: usage.input_tokens,
      source: 'provider',
      toolCalls: streamed.toolCalls.map(call => ({
        id: call.toolCallId,
        type: 'function',
        function: {
          name: call.toolName,
          arguments: JSON.stringify(call.input || {})
        }
      })),
      context_length: this._resolveContextLength(input),
      runtimeTrace: streamed.partTypes.map(type => ({ type })),
      terminalState: streamed.terminalState,
      responseId: streamed.responseId,
      renderContext: {
        provider: DEFAULT_PROVIDER_ID,
        model: input.model,
        requestContext: scope.requestContext || null,
        runtimeConfig: input.runtimeConfig || null
      }
    };
  }

  async _buildSystemPrompt(input = {}) {
    if (!this.dispatcher?._buildSystemPrompt) return '';
    return this.dispatcher._buildSystemPrompt({
      includeTools: false,
      includeRules: input.includeRules === undefined ? true : input.includeRules === true,
      includeEnv: input.includeEnv === undefined ? true : input.includeEnv === true,
      skipMemoryOnStart: input.skipMemoryOnStart === true,
      sessionId: input.sessionId || null,
      agentId: input.agentId || null,
      requestContext: input.requestContext || null,
      completionTools: [],
      nativeWorkspaceRoot: await this._resolveWorkspaceRoot(input)
    });
  }

  async _resolveWorkspaceRoot(input = {}) {
    if (this.mcpServer?.getExecutionRoot) {
      return this.mcpServer.getExecutionRoot({
        sessionId: input.sessionId || null,
        agentId: input.agentId || null,
        requestContext: input.requestContext || null
      });
    }
    return null;
  }

  async _resolveTools(input = {}) {
    if (!this.mcpServer) return [];
    const context = {
      sessionId: input.sessionId || null,
      agentId: input.agentId || null,
      requestContext: input.requestContext || null
    };
    const active = this.mcpServer.getActiveToolsForContext
      ? await this.mcpServer.getActiveToolsForContext(context)
      : [];
    const completionNames = Array.isArray(input.completionTools) ? input.completionTools : [];
    const completion = this.mcpServer.getToolsByNames
      ? this.mcpServer.getToolsByNames(completionNames, { includeInternal: true })
      : [];
    const merged = [];
    const seen = new Set();
    for (const definition of [...active, ...completion]) {
      const name = normalizeString(definition?.name, '');
      if (!name || seen.has(name)) continue;
      seen.add(name);
      merged.push({ ...definition, name });
    }
    return merged;
  }

  _buildMessages(history = [], prompt = '', attachments = []) {
    const output = [];
    const pendingCalls = new Map();
    for (const raw of Array.isArray(history) ? history : []) {
      const role = normalizeString(raw?.role, '').toLowerCase();
      if (role === 'system') continue;
      if (role === 'user') {
        output.push({ role: 'user', content: String(raw.content || '') });
        continue;
      }
      if (role === 'assistant') {
        const calls = Array.isArray(raw.tool_calls) ? raw.tool_calls : [];
        if (calls.length === 0) {
          output.push({ role: 'assistant', content: String(raw.content || '') });
          continue;
        }
        const content = [];
        if (raw.content) content.push({ type: 'text', text: String(raw.content) });
        for (const call of calls) {
          const toolCallId = normalizeString(call?.id || call?.toolCallId, crypto.randomUUID());
          const toolName = normalizeString(call?.function?.name || call?.toolName, '');
          if (!toolName) continue;
          const input = parseJson(call?.function?.arguments, call?.input || {}) || {};
          content.push({ type: 'tool-call', toolCallId, toolName, input });
          const queue = pendingCalls.get(toolName) || [];
          queue.push(toolCallId);
          pendingCalls.set(toolName, queue);
        }
        if (content.length > 0) output.push({ role: 'assistant', content });
        continue;
      }
      if (role === 'tool') {
        const toolName = normalizeString(raw.tool_name || raw.toolName, '');
        const queue = pendingCalls.get(toolName) || [];
        const toolCallId = normalizeString(raw.tool_call_id || raw.toolCallId || queue.shift(), '');
        if (!toolName || !toolCallId) {
          output.push({ role: 'user', content: `Tool result (${toolName || 'unknown'}): ${String(raw.content || '')}` });
          continue;
        }
        pendingCalls.set(toolName, queue);
        const parsed = parseJson(raw.content, null);
        output.push({
          role: 'tool',
          content: [{
            type: 'tool-result',
            toolCallId,
            toolName,
            output: parsed && typeof parsed === 'object'
              ? { type: 'json', value: parsed }
              : { type: 'text', value: String(raw.content || '') }
          }]
        });
      }
    }

    const imageParts = [];
    for (const attachment of Array.isArray(attachments) ? attachments : []) {
      if (attachment?.type !== 'image' || !attachment.path || !fs.existsSync(attachment.path)) continue;
      imageParts.push({
        type: 'image',
        image: fs.readFileSync(attachment.path),
        mediaType: imageMediaType(attachment)
      });
    }
    if (prompt || imageParts.length > 0) {
      output.push({
        role: 'user',
        content: imageParts.length > 0
          ? [{ type: 'text', text: String(prompt || '') }, ...imageParts]
          : String(prompt || '')
      });
    }
    return output;
  }

  _resolveReasoningEffort(input = {}) {
    const reasoning = input.runtimeConfig?.reasoning;
    if (reasoning?.enabled === false) return null;
    const requested = normalizeString(reasoning?.effort, '');
    const supported = this.modelMetadata.get(input.model)?.supportedReasoningEfforts;
    const allowed = Array.isArray(supported)
      ? supported.map(item => normalizeString(item?.reasoningEffort || item?.effort || item, '')).filter(Boolean)
      : [];
    if (requested && (allowed.length === 0 || allowed.includes(requested))) return requested;
    return normalizeString(
      this.modelMetadata.get(input.model)?.defaultReasoningEffort,
      requested || 'medium'
    );
  }

  _resolveContextLength(input = {}) {
    const values = [
      input.runtimeConfig?.contextWindow?.value,
      input.modelSpec?.runtime?.contextWindow?.value,
      input.modelSpec?.capabilities?.contextWindow?.max,
      DEFAULT_CONTEXT_LENGTH
    ];
    for (const value of values) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return DEFAULT_CONTEXT_LENGTH;
  }

  _sessionHeader(input = {}) {
    const key = normalizeString(input.sessionId || input.requestContext?.sessionId, '');
    if (!key) return crypto.randomUUID();
    const hex = crypto.createHash('sha256').update(this.sessionSalt).update(key).digest('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  }

  async _getAuth(options = {}, { forceRefresh = false } = {}) {
    const scope = normalizeScopeOptions(options);
    const scopeKey = this._scopeKey(scope);
    const cached = this.authCache.get(scopeKey);
    if (
      !forceRefresh
      && cached?.accessToken
      && cached?.accountId
      && (!cached.expiresAt || cached.expiresAt - Date.now() > AUTH_REFRESH_SKEW_MS)
    ) {
      return cached;
    }

    const pending = this.authPromises.get(scopeKey);
    if (pending) return pending;
    const refresh = this._refreshAuth(scope, scopeKey);
    this.authPromises.set(scopeKey, refresh);
    try {
      return await refresh;
    } finally {
      if (this.authPromises.get(scopeKey) === refresh) this.authPromises.delete(scopeKey);
    }
  }

  async _refreshAuth(scope, scopeKey) {
    const runtime = await this._ensureRuntime(scope);
    await this._request(runtime, 'account/read', { refreshToken: true }, REQUEST_TIMEOUT_MS);
    const auth = await this._request(runtime, 'getAuthStatus', {
      includeToken: true,
      refreshToken: false
    }, 10000);
    const accessToken = normalizeString(auth?.authToken, '');
    if (!accessToken) throw new Error('Codex is not signed in');
    const accountId = accountIdFromToken(accessToken);
    if (!accountId) throw new Error('Codex account identity was unavailable');
    const credential = {
      accessToken,
      accountId,
      expiresAt: tokenExpiryFromToken(accessToken)
    };
    this.authCache.set(scopeKey, credential);
    return credential;
  }

  _isAuthenticationError(error) {
    const message = coerceErrorMessage(error, '').toLowerCase();
    return /\b401\b|unauthenticated|unauthorized|invalid[_ -]?token|expired[_ -]?token/.test(message);
  }

  async _ensureRuntime(options = {}) {
    const scope = normalizeScopeOptions(options);
    const scopeKey = this._scopeKey(scope);
    const pending = this.runtimeStartPromises.get(scopeKey);
    if (pending) return pending;
    const existing = this.runtimeMap.get(scopeKey);
    if (existing?.connected) return existing;
    if (existing) this._disposeRuntime(existing, 'Codex auth broker restarted');
    const start = this._startRuntime(scopeKey);
    this.runtimeStartPromises.set(scopeKey, start);
    try {
      return await start;
    } finally {
      if (this.runtimeStartPromises.get(scopeKey) === start) this.runtimeStartPromises.delete(scopeKey);
    }
  }

  async _startRuntime(scopeKey) {
    const command = this._resolveCodexCommand();
    const child = spawn(command, ['app-server'], {
      cwd: this.activeProfile?.rootPath || this.runtimePaths?.agentinRoot || process.cwd(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const runtime = {
      child,
      command,
      scopeKey,
      startedAt: new Date().toISOString(),
      nextId: 1,
      connected: true,
      pending: new Map(),
      stderr: [],
      lineBuffer: ''
    };
    this.runtimeMap.set(scopeKey, runtime);
    child.stdout.on('data', chunk => this._handleStdout(runtime, chunk));
    child.stderr.on('data', chunk => {
      runtime.stderr.push(chunk.toString());
      if (runtime.stderr.length > 40) runtime.stderr.splice(0, runtime.stderr.length - 40);
    });
    child.on('error', error => this._failRuntime(runtime, new Error(`Codex auth broker failed: ${error.message}`)));
    child.on('exit', (code, signal) => {
      if (!runtime.connected) return;
      const detail = code !== null ? ` with code ${code}` : (signal ? ` (${signal})` : '');
      this._failRuntime(runtime, new Error(`Codex auth broker exited${detail}`));
    });

    try {
      await this._request(runtime, 'initialize', {
        clientInfo: {
          name: 'localagent_desktop',
          title: 'LocalAgent Desktop',
          version: '0.2.0'
        },
        capabilities: { experimentalApi: true }
      }, 30000);
      this._notify(runtime, { method: 'initialized', params: {} });
      return runtime;
    } catch (error) {
      this._disposeRuntime(runtime, coerceErrorMessage(error));
      throw error;
    }
  }

  _handleStdout(runtime, chunk) {
    runtime.lineBuffer += chunk.toString();
    let newlineIndex = runtime.lineBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = runtime.lineBuffer.slice(0, newlineIndex).trim();
      runtime.lineBuffer = runtime.lineBuffer.slice(newlineIndex + 1);
      newlineIndex = runtime.lineBuffer.indexOf('\n');
      if (!line) continue;
      try {
        this._handleMessage(runtime, JSON.parse(line));
      } catch (_error) {
        // Non-protocol output is ignored and never treated as credential data.
      }
    }
  }

  _handleMessage(runtime, payload) {
    if (payload?.method && payload?.id !== undefined) {
      this._notify(runtime, { id: payload.id, result: {} });
      return;
    }
    if (!payload || payload.id === undefined) return;
    const pending = runtime.pending.get(payload.id);
    if (!pending) return;
    runtime.pending.delete(payload.id);
    if (payload.error) {
      pending.reject(new Error(normalizeString(payload.error?.message || payload.error, 'Codex request failed')));
      return;
    }
    pending.resolve(payload.result);
  }

  async _request(runtime, method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (!runtime?.connected) throw new Error('Codex auth broker is not connected');
    const id = runtime.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        runtime.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, timeoutMs);
      runtime.pending.set(id, {
        resolve: value => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: error => {
          clearTimeout(timer);
          reject(error);
        }
      });
      this._notify(runtime, { method, id, params });
    });
  }

  _notify(runtime, payload) {
    if (!runtime?.connected || !runtime.child?.stdin?.writable) return;
    runtime.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  _failRuntime(runtime, error) {
    if (!runtime?.connected) return;
    runtime.connected = false;
    for (const pending of runtime.pending.values()) pending.reject(error);
    runtime.pending.clear();
    if (this.runtimeMap.get(runtime.scopeKey) === runtime) this.runtimeMap.delete(runtime.scopeKey);
  }

  _disposeRuntime(runtime, reason = 'Codex auth broker stopped') {
    this._failRuntime(runtime, new Error(reason));
    try {
      runtime.child.stdin.end();
    } catch (_error) {
      // ignore
    }
    try {
      runtime.child.kill();
    } catch (_error) {
      // ignore
    }
  }

  _scopeKey(_scope = {}) {
    return DEFAULT_PROVIDER_ID;
  }

  _resolveCodexCommand() {
    const configured = process.env.LOCALAGENT_CODEX_PATH || process.env.CODEX_CLI_PATH;
    if (configured && fs.existsSync(configured)) return configured;
    const fromPath = process.platform === 'win32'
      ? this._findOnPath('codex.exe') || this._findOnPath('codex.cmd')
      : this._findOnPath('codex');
    if (fromPath) return fromPath;
    if (process.platform === 'win32') {
      const extensionMatch = this._findNewestCodexInExtensions(path.join(os.homedir(), '.vscode', 'extensions'));
      if (extensionMatch) return extensionMatch;
    }
    return process.platform === 'win32' ? 'codex.exe' : 'codex';
  }

  _findOnPath(binary) {
    for (const entry of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
      const candidate = path.join(entry, binary);
      if (fs.existsSync(candidate)) return candidate;
    }
    return '';
  }

  _findNewestCodexInExtensions(root) {
    if (!fs.existsSync(root)) return '';
    return fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.startsWith('openai.chatgpt-'))
      .map(entry => path.join(root, entry.name, 'bin', 'windows-x86_64', 'codex.exe'))
      .filter(candidate => fs.existsSync(candidate))
      .sort()
      .reverse()[0] || '';
  }
}

module.exports = {
  CodexRuntimeManager,
  DEFAULT_PROVIDER_ID,
  DEFAULT_MODELS,
  CODEX_BASE_URL,
  DEFAULT_CONTEXT_LENGTH
};
