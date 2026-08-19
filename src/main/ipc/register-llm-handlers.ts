// @ts-nocheck
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SPEC_FILE, getProviderCatalogModels, getProviderConnectionConfig, getProviderProfiles, getProviderSpec,
  getModelRuntimeConfig, saveProviderConnectionConfig, saveModelRuntimeConfig } = require('../llm-config');
const { getEffectiveLlmSelection, getKnownModelsForProvider, orderModelsByRecentUse, rememberLastWorkingModel,
  rememberTestedModel, saveActiveSelection } = require('../llm-state');
const { getGenericSettingValue } = require('../settings-security');
const { getActiveModelContext, saveActiveModelContext } = require('../model-context-settings');
const { providerRequest } = require('../providers/provider-http');
const { DEFAULT_PROMPT_USER_ID, resolvePromptScope } = require('../prompt-ownership');
const { failureMetadata, shouldRefreshCache, successMetadata } = require('../model-cache-policy');

function registerLlmHandlers(ipcMain, runtime) {
  const {
    db,
    aiService,
    codexRuntimeManager,
    opencodeRuntimeManager,
    promptFileManager
  } = runtime;

  function broadcastCompanionLlmSettingsChange(reason = 'llm-settings') {
    const companionServer = runtime.container?.optional?.('companionServer');
    companionServer?.broadcastStateChanged?.('llm', { reason });
  }

  function getRequestContext(event) {
    return event?.requestContext || null;
  }

  function buildScopeOptions(event) {
    return {
      requestContext: getRequestContext(event)
    };
  }
  function isOwnerPromptScope(event) {
    return resolvePromptScope(buildScopeOptions(event)).userId === DEFAULT_PROMPT_USER_ID;
  }

  async function readScopedSetting(key, scopeOptions = {}) {
    if (typeof db.getScopedSetting === 'function' && scopeOptions && (scopeOptions.requestContext || scopeOptions.userId)) {
      return db.getScopedSetting(key, scopeOptions);
    }
    return db.getSetting(key);
  }

  async function writeScopedSetting(key, value, scopeOptions = {}) {
    if (typeof db.saveScopedSetting === 'function') {
      return db.saveScopedSetting(key, value, scopeOptions);
    }
    return db.saveSetting(key, value);
  }

  async function syncResolvedRuntime(provider, model, runtimeConfig = null, scopeOptions = {}) {
    let resolvedRuntime = null;
    if (!provider || !model) {
      return resolvedRuntime;
    }

    if (runtimeConfig) {
      const savedRuntime = await saveModelRuntimeConfig(db, provider, model, runtimeConfig, scopeOptions);
      resolvedRuntime = savedRuntime.runtime;
    } else {
      const currentRuntime = await getModelRuntimeConfig(db, provider, model, scopeOptions);
      resolvedRuntime = currentRuntime.runtime;
    }

    if (resolvedRuntime) {
      await writeScopedSetting('llm.thinkingMode', resolvedRuntime.reasoning?.enabled ? 'think' : 'off', scopeOptions);
      await writeScopedSetting('llm.showThinking', resolvedRuntime.reasoning?.visibility === 'hide' ? 'false' : 'true', scopeOptions);
      await writeScopedSetting('llm.thinkingVisibility', resolvedRuntime.reasoning?.visibility || 'show', scopeOptions);
      broadcastCompanionLlmSettingsChange('runtime-sync');
    }

    return resolvedRuntime;
  }

  const DISCOVERED_MODELS_SETTING = 'llm.discoveredModels';
  const DISCOVERED_MODEL_OPTIONS_SETTING = 'llm.discoveredModelOptions';

  function normalizeProviderId(provider) {
    return String(provider || '').trim().toLowerCase();
  }

  function normalizeModelList(models = []) {
    const seen = new Set();
    const output = [];
    for (const model of Array.isArray(models) ? models : []) {
      const value = String(model || '').trim();
      if (!value) continue;
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(value);
    }
    return output;
  }

  async function getDiscoveredModelStore(scopeOptions = {}) {
    const raw = await readScopedSetting(DISCOVERED_MODELS_SETTING, scopeOptions);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  async function saveDiscoveredModelStore(store, scopeOptions = {}) {
    await writeScopedSetting(DISCOVERED_MODELS_SETTING, JSON.stringify(store || {}), scopeOptions);
  }

  async function rememberDiscoveredModels(provider, models = [], scopeOptions = {}) {
    const providerId = normalizeProviderId(provider);
    const normalized = normalizeModelList(models);
    if (!providerId) return normalized;

    const store = await getDiscoveredModelStore(scopeOptions);
    if (normalized.length === 0) {
      return normalized;
    }

    store[providerId] = successMetadata(store[providerId]);
    store[providerId] = {
      ...store[providerId],
      models: normalized,
    };
    await saveDiscoveredModelStore(store, scopeOptions);
    return normalized;
  }
  async function getCachedDiscoveredModels(provider, scopeOptions = {}) {
    const providerId = normalizeProviderId(provider);
    if (!providerId) return [];
    const store = await getDiscoveredModelStore(scopeOptions);
    return normalizeModelList(store[providerId]?.models || []);
  }

  async function upsertDiscoveredModel(provider, model, scopeOptions = {}) {
    const providerId = normalizeProviderId(provider);
    const normalizedModel = String(model || '').trim();
    if (!providerId || !normalizedModel) return;
    const store = await getDiscoveredModelStore(scopeOptions);
    const current = store[providerId] || {};
    store[providerId] = {
      ...current,
      models: normalizeModelList([...(current.models || []), normalizedModel])
    };
    await saveDiscoveredModelStore(store, scopeOptions);
  }

  function normalizeModelOptions(modelOptions = []) {
    const seen = new Set();
    const output = [];
    for (const option of Array.isArray(modelOptions) ? modelOptions : []) {
      const value = String(typeof option === 'string' ? option : option?.value || '').trim();
      if (!value) continue;
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      output.push({
        value,
        label: String(typeof option === 'string' ? option : option?.label || value).trim() || value,
        sourceProviderId: String(option?.sourceProviderId || '').trim(),
        free: option?.free === true,
        included: option?.included === true,
        costText: String(option?.costText || '').trim(),
        contextWindow: Number(option?.contextWindow || 0) || null
      });
    }
    return output;
  }

  function buildSimpleModelOptions(models = []) {
    return normalizeModelOptions(normalizeModelList(models).map(value => ({ value, label: value })));
  }

  async function getDiscoveredModelOptionStore(scopeOptions = {}) {
    const raw = await readScopedSetting(DISCOVERED_MODEL_OPTIONS_SETTING, scopeOptions);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  async function saveDiscoveredModelOptionStore(store, scopeOptions = {}) {
    await writeScopedSetting(DISCOVERED_MODEL_OPTIONS_SETTING, JSON.stringify(store || {}), scopeOptions);
  }

  async function rememberDiscoveredModelOptions(provider, modelOptions = [], scopeOptions = {}) {
    const providerId = normalizeProviderId(provider);
    const normalized = normalizeModelOptions(modelOptions);
    if (!providerId) return normalized;

    const store = await getDiscoveredModelOptionStore(scopeOptions);
    if (normalized.length === 0) {
      return normalized;
    }

    store[providerId] = successMetadata(store[providerId]);
    store[providerId] = {
      ...store[providerId],
      items: normalized,
    };
    await saveDiscoveredModelOptionStore(store, scopeOptions);
    return normalized;
  }

  async function getCachedDiscoveredModelOptions(provider, scopeOptions = {}) {
    const providerId = normalizeProviderId(provider);
    if (!providerId) return [];
    const store = await getDiscoveredModelOptionStore(scopeOptions);
    return normalizeModelOptions(store[providerId]?.items || []);
  }

  async function upsertDiscoveredModelOption(provider, option, scopeOptions = {}) {
    const providerId = normalizeProviderId(provider);
    const normalized = normalizeModelOptions([option]);
    if (!providerId || normalized.length === 0) return;
    const store = await getDiscoveredModelOptionStore(scopeOptions);
    const current = store[providerId] || {};
    store[providerId] = {
      ...current,
      items: normalizeModelOptions([...(current.items || []), ...normalized])
    };
    await saveDiscoveredModelOptionStore(store, scopeOptions);
  }

  async function getProviderCacheEntry(provider, scopeOptions = {}) {
    const providerId = normalizeProviderId(provider);
    const store = providerId === 'opencode'
      ? await getDiscoveredModelOptionStore(scopeOptions)
      : await getDiscoveredModelStore(scopeOptions);
    return store[providerId] || null;
  }

  async function markProviderCacheFailure(provider, error, scopeOptions = {}) {
    const providerId = normalizeProviderId(provider);
    if (!providerId) return;
    if (providerId === 'opencode') {
      const store = await getDiscoveredModelOptionStore(scopeOptions);
      store[providerId] = failureMetadata(providerId, store[providerId], error);
      await saveDiscoveredModelOptionStore(store, scopeOptions);
      return;
    }
    const store = await getDiscoveredModelStore(scopeOptions);
    store[providerId] = failureMetadata(providerId, store[providerId], error);
    await saveDiscoveredModelStore(store, scopeOptions);
  }

  function getProviderDiscoveryMeta(provider) {
    const providerId = normalizeProviderId(provider);
    return aiService.getProviderDiscoveryMeta?.(providerId) || {
      ok: null,
      source: 'unknown',
      authoritative: false,
      error: null,
      count: 0,
      at: null
    };
  }
  function shouldDisableFlashAttention(provider, model) {
    const providerId = normalizeProviderId(provider);
    const modelId = String(model || '').trim().toLowerCase();
    if (providerId !== 'lmstudio' || !modelId) return false;

    // Local LM Studio issue pattern: Qwen 3.5/3.6 30B+ A3B variants can fail with Flash Attention on some GPUs.
    const qwenMatch = /qwen[\s\-_/]*3(\.5|\.6)?/.test(modelId);
    const a3bMatch = /\ba3b\b/.test(modelId);
    const largeFamilyMatch = /\b(30b|32b|35b|70b)\b/.test(modelId);
    return qwenMatch && a3bMatch && largeFamilyMatch;
  }

  function withLmstudioLoadOverride(config = {}) {
    const next = { ...(config || {}) };
    const runtimeConfig = { ...(next.runtimeConfig || {}) };
    const lmstudio = { ...(runtimeConfig.lmstudio || {}) };
    const loadConfig = { ...(lmstudio.loadConfig || {}) };
    // Required stable config for qwen/qwen3.6-35b-a3b based on known-good LM Studio run.
    if (!Object.prototype.hasOwnProperty.call(loadConfig, 'flash_attention')) loadConfig.flash_attention = false;
    if (!Object.prototype.hasOwnProperty.call(loadConfig, 'context_length')) loadConfig.context_length = 32768;
    if (!Object.prototype.hasOwnProperty.call(loadConfig, 'eval_batch_size')) loadConfig.eval_batch_size = 256;
    if (!Object.prototype.hasOwnProperty.call(loadConfig, 'num_experts')) loadConfig.num_experts = 8;
    if (!Object.prototype.hasOwnProperty.call(loadConfig, 'offload_kv_cache_to_gpu')) loadConfig.offload_kv_cache_to_gpu = true;
    lmstudio.loadConfig = loadConfig;
    runtimeConfig.lmstudio = lmstudio;
    if (!runtimeConfig.contextWindow?.value) {
      runtimeConfig.contextWindow = { ...(runtimeConfig.contextWindow || {}), value: 32768 };
    }
    if (!runtimeConfig.reasoning || typeof runtimeConfig.reasoning !== 'object') {
      runtimeConfig.reasoning = { enabled: false, visibility: 'show', effort: null, maxTokens: null };
    } else if (runtimeConfig.reasoning.enabled === undefined || runtimeConfig.reasoning.enabled === null) {
      runtimeConfig.reasoning = { ...runtimeConfig.reasoning, enabled: false };
    }
    next.runtimeConfig = runtimeConfig;
    return next;
  }

  function mergeLmstudioLoadedConfigIntoRuntime(runtimeConfig = {}, loadedConfig = {}) {
    const nextRuntime = { ...(runtimeConfig || {}) };
    const lmstudio = { ...(nextRuntime.lmstudio || {}) };
    const loadConfig = { ...(lmstudio.loadConfig || {}) };

    if (Number.isFinite(Number(loadedConfig.context_length))) {
      const contextLength = Number(loadedConfig.context_length);
      loadConfig.context_length = contextLength;
      nextRuntime.contextWindow = { ...(nextRuntime.contextWindow || {}), value: contextLength };
    }
    if (Number.isFinite(Number(loadedConfig.eval_batch_size))) loadConfig.eval_batch_size = Number(loadedConfig.eval_batch_size);
    if (Number.isFinite(Number(loadedConfig.num_experts))) loadConfig.num_experts = Number(loadedConfig.num_experts);
    if (typeof loadedConfig.flash_attention === 'boolean') loadConfig.flash_attention = loadedConfig.flash_attention;
    if (typeof loadedConfig.offload_kv_cache_to_gpu === 'boolean') loadConfig.offload_kv_cache_to_gpu = loadedConfig.offload_kv_cache_to_gpu;

    lmstudio.loadConfig = loadConfig;
    nextRuntime.lmstudio = lmstudio;
    return nextRuntime;
  }

  async function getCatalogAwareModels(provider, discovered = [], discoveryMeta = null, scopeOptions = {}) {
    const providerId = normalizeProviderId(provider);
    const providerSpec = getProviderSpec(providerId);
    const normalizedDiscovered = normalizeModelList(discovered);
    const cachedDiscovered = await getCachedDiscoveredModels(providerId, scopeOptions);
    const explicitKnownModels = await getKnownModelsForProvider(db, providerId, [], scopeOptions);
    const meta = discoveryMeta && typeof discoveryMeta === 'object'
      ? discoveryMeta
      : getProviderDiscoveryMeta(providerId);
    if (normalizedDiscovered.length > 0 && meta?.ok !== false) {
      await rememberDiscoveredModels(providerId, normalizedDiscovered, scopeOptions);
    }
    const authoritativeDiscovery = meta?.ok === true
      && meta?.authoritative === true
      && normalizedDiscovered.length > 0;
    const authoritativeModels = authoritativeDiscovery
      ? normalizedDiscovered
      : (providerSpec?.settings?.supportsModelDiscovery && normalizedDiscovered.length === 0
          ? cachedDiscovered
          : []);
    if (authoritativeModels.length > 0) {
      return orderModelsByRecentUse(db, providerId, authoritativeModels, scopeOptions);
    }
    const replaceCodexCatalog = (providerId === 'openai' || providerId === 'local-codex')
      && (normalizedDiscovered.length > 0 || cachedDiscovered.length > 0);
    const seededModels = [
      ...(replaceCodexCatalog ? [] : getProviderCatalogModels(providerId)),
      ...normalizedDiscovered,
      ...(authoritativeDiscovery ? [] : cachedDiscovered),
      ...explicitKnownModels
    ];
    let models = [];
    try {
      models = await getKnownModelsForProvider(db, providerId, seededModels, scopeOptions);
    } catch (error) {
      console.error(`[LLM] Failed to merge known models for ${providerId}:`, error?.message || error);
      return normalizeModelList([
        ...seededModels,
        ...explicitKnownModels
      ]);
    }
    if (models.length === 0 && providerSpec?.settings?.supportsModelDiscovery) {
      return getKnownModelsForProvider(db, providerId, getProviderCatalogModels(providerId), scopeOptions);
    }

    return models;
  }

  async function getCatalogAwareModelOptions(provider, discoveredOptions = [], discoveryMeta = null, scopeOptions = {}) {
    const providerId = normalizeProviderId(provider);
    if (providerId !== 'opencode') {
      const discoveredModels = normalizeModelOptions(discoveredOptions).map(option => option.value);
      const models = await getCatalogAwareModels(providerId, discoveredModels, discoveryMeta, scopeOptions);
      return buildSimpleModelOptions(models);
    }

    const belongsToOpenCode = option => {
      const sourceProviderId = normalizeProviderId(option?.sourceProviderId);
      const value = String(option?.value || '').trim().toLowerCase();
      return sourceProviderId === 'opencode' || value.startsWith('opencode/');
    };
    const normalizedDiscovered = normalizeModelOptions(discoveredOptions).filter(belongsToOpenCode);
    const cachedDiscovered = (await getCachedDiscoveredModelOptions(providerId, scopeOptions)).filter(belongsToOpenCode);
    const explicitKnownModels = await getKnownModelsForProvider(db, providerId, [], scopeOptions);
    const explicitKnownOptions = buildSimpleModelOptions(explicitKnownModels).filter(belongsToOpenCode);
    const meta = discoveryMeta && typeof discoveryMeta === 'object'
      ? discoveryMeta
      : getProviderDiscoveryMeta(providerId);
    const mergeOptions = (...lists) => {
      const seen = new Set();
      const output = [];
      for (const list of lists) {
        for (const option of normalizeModelOptions(list)) {
          const key = option.value.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          output.push(option);
        }
      }
      return output;
    };
    const orderOptions = async options => {
      const normalized = mergeOptions(options);
      const byValue = new Map(normalized.map(option => [option.value.toLowerCase(), option]));
      const orderedModels = await orderModelsByRecentUse(db, providerId, [...byValue.keys()], scopeOptions);
      return orderedModels.map(model => byValue.get(model.toLowerCase())).filter(Boolean);
    };

    if (meta.authoritative === true && meta.ok !== false) {
      await rememberDiscoveredModelOptions(providerId, normalizedDiscovered, scopeOptions);
      await rememberDiscoveredModels(providerId, normalizedDiscovered.map(option => option.value), scopeOptions);
      return orderOptions(normalizedDiscovered);
    }
    if (meta?.ok === false) {
      return orderOptions(cachedDiscovered.length > 0
        ? cachedDiscovered
        : mergeOptions(normalizedDiscovered, explicitKnownOptions));
    }
    return orderOptions(cachedDiscovered.length > 0
      ? cachedDiscovered
      : mergeOptions(normalizedDiscovered, explicitKnownOptions));
  }
  function normalizeConnectionPayload(config = {}) {
    const connection = { ...(config.connection || {}) };
    const normalizeArgs = (value) => String(value || '').replace(/\s+/g, ' ').trim();

    if (config.apiKey !== undefined) {
      connection.apiKey = config.apiKey;
    }
    if (config.url !== undefined) {
      connection.url = config.url;
    }
    if (connection.modelParams !== undefined) {
      connection.modelParams = normalizeArgs(connection.modelParams);
    }
    if (connection.serverParams !== undefined) {
      connection.serverParams = normalizeArgs(connection.serverParams);
    }

    return connection;
  }

  function buildLmstudioEndpoint(baseUrl, endpointPath) {
    const rawBase = String(baseUrl || '').trim() || 'http://localhost:1234';
    const rawPath = String(endpointPath || '').trim();
    const normalizedPath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
    try {
      const parsed = new URL(rawBase);
      if (parsed.hostname === 'localhost') {
        parsed.hostname = '127.0.0.1';
      }
      const pathname = (parsed.pathname || '/').replace(/\/+$/, '') || '/';
      const hasV1 = pathname === '/v1' || pathname.endsWith('/v1');
      const basePath = hasV1 ? pathname : `${pathname === '/' ? '' : pathname}/v1`;
      parsed.pathname = `${basePath}${normalizedPath}`;
      return parsed.toString();
    } catch (_) {
      const fallback = rawBase.replace(/\/+$/, '');
      return `${fallback}/v1${normalizedPath}`;
    }
  }

  async function getLmstudioApiKey(scopeOptions = {}) {
    const stored = await db.getAPIKey?.('lmstudio', scopeOptions);
    if (stored) return stored;
    const legacy = await readScopedSetting('llm.lmstudio.apiKey', scopeOptions);
    if (legacy && db.setAPIKey) {
      await db.setAPIKey('lmstudio', legacy, scopeOptions);
    }
    return legacy;
  }

  async function discoverLmstudioModelsDirect(scopeOptions = {}) {
    const urlSetting = await readScopedSetting('llm.lmstudio.url', scopeOptions);
    const apiKey = await getLmstudioApiKey(scopeOptions);
    const endpoint = buildLmstudioEndpoint(urlSetting || 'http://localhost:1234', '/models');
    const headers = {};
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    const response = await providerRequest({
      method: 'get',
      url: endpoint,
      headers
    }, { timeoutMs: 12000, label: 'LM Studio direct model discovery' });
    const payload = response.data || {};
    const rawModels = Array.isArray(payload?.data)
      ? payload.data
      : (Array.isArray(payload?.models) ? payload.models : []);
    return normalizeModelList(rawModels.map(model => {
      if (typeof model === 'string') return model;
      return model?.id || model?.name || '';
    }));
  }

  async function getLmstudioLoadedInstanceConfig(modelKey, scopeOptions = {}) {
    const key = String(modelKey || '').trim().toLowerCase();
    if (!key) return null;
    const urlSetting = await readScopedSetting('llm.lmstudio.url', scopeOptions);
    const apiKey = await getLmstudioApiKey(scopeOptions);
    const base = String(urlSetting || 'http://localhost:1234').trim() || 'http://localhost:1234';
    let nativeEndpoint = '';
    try {
      const parsed = new URL(base);
      if (parsed.hostname === 'localhost') parsed.hostname = '127.0.0.1';
      const pathname = (parsed.pathname || '/').replace(/\/+$/, '') || '/';
      const rootPath = pathname.endsWith('/v1') ? pathname.slice(0, -3) || '/' : pathname;
      const trimmedRoot = rootPath.replace(/\/+$/, '');
      parsed.pathname = `${trimmedRoot === '' || trimmedRoot === '/' ? '' : trimmedRoot}/api/v1/models`;
      nativeEndpoint = parsed.toString();
    } catch (_) {
      nativeEndpoint = `${base.replace(/\/+$/, '')}/api/v1/models`;
    }
    const headers = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const response = await providerRequest({
      method: 'get',
      url: nativeEndpoint,
      headers
    }, { timeoutMs: 12000, label: 'LM Studio loaded model config' });
    const models = Array.isArray(response?.data?.models) ? response.data.models : [];
    const match = models.find(entry => String(entry?.key || '').trim().toLowerCase() === key);
    const loaded = Array.isArray(match?.loaded_instances) ? match.loaded_instances : [];
    if (loaded.length === 0) return null;
    return loaded[0]?.config || null;
  }

  function buildLmstudioNativeModelsEndpoint(baseUrl) {
    const base = String(baseUrl || 'http://localhost:1234').trim() || 'http://localhost:1234';
    try {
      const parsed = new URL(base);
      if (parsed.hostname === 'localhost') parsed.hostname = '127.0.0.1';
      const pathname = (parsed.pathname || '/').replace(/\/+$/, '') || '/';
      const rootPath = pathname.endsWith('/v1') ? pathname.slice(0, -3) || '/' : pathname;
      const trimmedRoot = rootPath.replace(/\/+$/, '');
      parsed.pathname = `${trimmedRoot === '' || trimmedRoot === '/' ? '' : trimmedRoot}/api/v1/models`;
      return parsed.toString();
    } catch (_) {
      return `${base.replace(/\/+$/, '')}/api/v1/models`;
    }
  }

  async function enforceLmstudioLoadedConfig(model, runtimeConfig = {}, scopeOptions = {}) {
    const modelId = String(model || '').trim();
    if (!modelId) return null;

    const urlSetting = await readScopedSetting('llm.lmstudio.url', scopeOptions);
    const apiKey = await getLmstudioApiKey(scopeOptions);
    const nativeModelsEndpoint = buildLmstudioNativeModelsEndpoint(urlSetting || 'http://localhost:1234');
    const nativeLoadEndpoint = nativeModelsEndpoint.replace(/\/models(\?.*)?$/i, '/models/load$1');
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const requested = runtimeConfig?.lmstudio?.loadConfig || {};
    const desired = {};
    if (typeof requested.flash_attention === 'boolean') desired.flash_attention = requested.flash_attention;
    if (Number.isFinite(Number(requested.context_length))) desired.context_length = Number(requested.context_length);
    if (Number.isFinite(Number(requested.eval_batch_size))) desired.eval_batch_size = Number(requested.eval_batch_size);
    if (Number.isFinite(Number(requested.num_experts))) desired.num_experts = Number(requested.num_experts);
    if (typeof requested.offload_kv_cache_to_gpu === 'boolean') desired.offload_kv_cache_to_gpu = requested.offload_kv_cache_to_gpu;
    if (Object.keys(desired).length === 0) return null;

    const modelsResponse = await providerRequest({
      method: 'get',
      url: nativeModelsEndpoint,
      headers
    }, { timeoutMs: 12000, label: 'LM Studio native model list' });
    const models = Array.isArray(modelsResponse?.data?.models) ? modelsResponse.data.models : [];
    const entry = models.find(item => String(item?.key || '').trim().toLowerCase() === modelId.toLowerCase());
    const current = Array.isArray(entry?.loaded_instances) && entry.loaded_instances[0]?.config
      ? entry.loaded_instances[0].config
      : null;

    const keys = Object.keys(desired);
    const mismatch = !current || keys.some(key => current[key] !== desired[key]);
    if (!mismatch) return current;

    const attempts = [
      { ...desired },
      (() => {
        const reduced = {};
        if (typeof desired.flash_attention === 'boolean') reduced.flash_attention = desired.flash_attention;
        if (Number.isFinite(Number(desired.context_length))) reduced.context_length = Number(desired.context_length);
        return reduced;
      })(),
      (() => {
        const minimal = {};
        if (typeof desired.flash_attention === 'boolean') minimal.flash_attention = desired.flash_attention;
        return minimal;
      })()
    ].filter(payload => Object.keys(payload).length > 0);

    let lastError = null;
    for (const attempt of attempts) {
      try {
        const loadPayload = { model: modelId, ...attempt, echo_load_config: true };
        const loadResponse = await providerRequest({
          method: 'post',
          url: nativeLoadEndpoint,
          data: loadPayload,
          headers
        }, { timeoutMs: 30000, label: 'LM Studio model load' });
        return loadResponse?.data?.load_config || null;
      } catch (error) {
        lastError = error;
      }
    }

    // Some LM Studio builds can keep prior runtime knobs while model is already loaded.
    // Force a clean reload as a final fallback.
    try {
      const unloadEndpoint = nativeModelsEndpoint.replace(/\/models(\?.*)?$/i, '/models/unload$1');
      await providerRequest({
        method: 'post',
        url: unloadEndpoint,
        data: { model: modelId },
        headers
      }, { timeoutMs: 20000, label: 'LM Studio model unload' });
      const fallbackAttempt = attempts[0] || {};
      const loadPayload = { model: modelId, ...fallbackAttempt, echo_load_config: true };
      const loadResponse = await providerRequest({
        method: 'post',
        url: nativeLoadEndpoint,
        data: loadPayload,
        headers
      }, { timeoutMs: 45000, label: 'LM Studio model reload' });
      return loadResponse?.data?.load_config || null;
    } catch (error) {
      lastError = error;
    }

    if (lastError) {
      const sourceError = lastError?.cause || lastError;
      const detail = sourceError?.response?.data
        ? ` ${JSON.stringify(sourceError.response.data).slice(0, 600)}`
        : '';
      throw new Error(`${sourceError.message}${detail}`);
    }
    return null;
  }

  async function loadResolvedModels(providerId, forceRefresh = false, scopeOptions = {}) {
    let discovered = [];
    let discoveryMeta = getProviderDiscoveryMeta(providerId);
    try {
      discovered = await aiService.getModels(providerId, forceRefresh, scopeOptions);
      discoveryMeta = getProviderDiscoveryMeta(providerId);
      if (providerId === 'lmstudio') {
        const direct = await discoverLmstudioModelsDirect(scopeOptions);
        if (direct.length > 0) {
          console.log(`[LMStudio] Using direct discovered model list (${direct.length})`);
          return getCatalogAwareModels(providerId, direct, {
            ok: true,
            source: 'remote',
            authoritative: true,
            error: null,
            count: direct.length,
            at: new Date().toISOString()
          }, scopeOptions);
        }
      }
      return getCatalogAwareModels(providerId, discovered, discoveryMeta, scopeOptions);
    } catch (error) {
      console.error(`Failed to fetch models for ${providerId}:`, error);
      try {
        return await getCatalogAwareModels(providerId, discovered, {
          ok: false,
          source: discoveryMeta?.source || 'remote',
          authoritative: discoveryMeta?.authoritative === true,
          error: error.message,
          count: normalizeModelList(discovered).length,
          at: new Date().toISOString()
        }, scopeOptions);
      } catch (_) {
        const fallback = normalizeModelList(discovered);
        if (fallback.length > 0) {
          console.warn(`[LLM] Returning discovered model fallback for ${providerId}: ${fallback.length} model(s)`);
          return fallback;
        }
        return [];
      }
    }
  }

  async function loadCachedProviderModels(providerId, scopeOptions = {}) {
    if (providerId === 'opencode') {
      return getCatalogAwareModelOptions(providerId, [], {
        ok: null,
        source: 'cache',
        authoritative: false
      }, scopeOptions);
    }
    return getCatalogAwareModels(providerId, [], {
      ok: null,
      source: 'cache',
      authoritative: false
    }, scopeOptions);
  }

  const providerCacheRefreshes = new Map();
  async function refreshProviderModelCache(providerId, scopeOptions = {}, options = {}) {
    const normalizedProvider = normalizeProviderId(providerId);
    const scopeId = String(scopeOptions?.userId || scopeOptions?.requestContext?.userId || DEFAULT_PROMPT_USER_ID).trim().toLowerCase();
    const refreshKey = `${scopeId}::${normalizedProvider}`;
    const cacheEntry = await getProviderCacheEntry(normalizedProvider, scopeOptions);
    if (!shouldRefreshCache(normalizedProvider, cacheEntry, { force: options.force === true })) {
      return loadCachedProviderModels(normalizedProvider, scopeOptions);
    }
    if (providerCacheRefreshes.has(refreshKey)) {
      return providerCacheRefreshes.get(refreshKey);
    }
    const refresh = (async () => {
      try {
        if (normalizedProvider === 'opencode') {
          const modelOptions = await opencodeRuntimeManager.getModelOptions('', true, scopeOptions);
          const meta = getProviderDiscoveryMeta(normalizedProvider);
          if (meta?.ok === false || modelOptions.length === 0) throw new Error(meta?.error || 'OpenCode returned an empty model list');
          return getCatalogAwareModelOptions(normalizedProvider, modelOptions, meta, scopeOptions);
        }
        const models = await aiService.getModels(normalizedProvider, true, scopeOptions);
        const meta = getProviderDiscoveryMeta(normalizedProvider);
        if (meta?.ok === false || models.length === 0) throw new Error(meta?.error || `${normalizedProvider} returned an empty model list`);
        return getCatalogAwareModels(normalizedProvider, models, meta, scopeOptions);
      } catch (error) {
        await markProviderCacheFailure(normalizedProvider, error?.message || error, scopeOptions);
        if (options.throwOnFailure === true) throw error;
        return loadCachedProviderModels(normalizedProvider, scopeOptions);
      } finally {
        providerCacheRefreshes.delete(refreshKey);
      }
    })();
    providerCacheRefreshes.set(refreshKey, refresh);
    return refresh;
  }

  function queueProviderModelCacheRefresh(providerId, scopeOptions = {}) {
    refreshProviderModelCache(providerId, scopeOptions)
      .catch(error => console.warn(`[LLM] Async cache refresh failed for ${providerId}:`, error?.message || error));
  }

  ipcMain.handle('getProviderModels', async (event, provider) => {
    try {
      const providerId = normalizeProviderId(provider);
      const models = await loadCachedProviderModels(providerId, buildScopeOptions(event));
      queueProviderModelCacheRefresh(providerId, buildScopeOptions(event));
      return { status: 'success', models };
    } catch (error) {
      return { status: 'error', message: error.message };
    }
  });

  ipcMain.handle('checkProviderStatus', async (event, provider) => {
    try {
      const providerId = normalizeProviderId(provider);
      const models = await loadCachedProviderModels(providerId, buildScopeOptions(event));
      const cache = await getProviderCacheEntry(providerId, buildScopeOptions(event));
      queueProviderModelCacheRefresh(providerId, buildScopeOptions(event));
      return { connected: models.length > 0, cached: true, updatedAt: cache?.updatedAt || null, lastError: cache?.lastError || null };
    } catch (error) {
      return { connected: false };
    }
  });

  ipcMain.handle('setActiveModel', async (event, provider, model) => {
    await saveActiveSelection(db, provider, model, buildScopeOptions(event));
    return { success: true };
  });

  ipcMain.handle('llm:get-model-options', async (event, provider, forceRefresh = false) => {
    const providerId = normalizeProviderId(provider);
    const scopeOptions = buildScopeOptions(event);
    if (!forceRefresh) {
      const cached = await loadCachedProviderModels(providerId, scopeOptions);
      queueProviderModelCacheRefresh(providerId, scopeOptions);
      return providerId === 'opencode' ? cached : buildSimpleModelOptions(cached);
    }
    const refreshed = await refreshProviderModelCache(providerId, scopeOptions, { force: true });
    return providerId === 'opencode' ? refreshed : buildSimpleModelOptions(refreshed);
  });

  ipcMain.handle('llm:get-models', async (event, provider, forceRefresh = false) => {
    const providerId = normalizeProviderId(provider);
    const scopeOptions = buildScopeOptions(event);
    if (!forceRefresh) {
      const cached = await loadCachedProviderModels(providerId, scopeOptions);
      queueProviderModelCacheRefresh(providerId, scopeOptions);
      return providerId === 'opencode'
        ? normalizeModelOptions(cached).map(option => option.value)
        : cached;
    }
    const refreshed = await refreshProviderModelCache(providerId, scopeOptions, { force: true });
    return providerId === 'opencode' ? normalizeModelOptions(refreshed).map(option => option.value) : refreshed;
  });
  ipcMain.handle('llm:save-config', async (event, config) => {
    try {
      const scopeOptions = buildScopeOptions(event);
      let nextConfig = { ...(config || {}) };
      if (normalizeProviderId(nextConfig.provider) === 'lmstudio' && nextConfig.model) {
        try {
          const loadedConfig = await getLmstudioLoadedInstanceConfig(nextConfig.model, scopeOptions);
          if (loadedConfig && typeof loadedConfig === 'object') {
            nextConfig.runtimeConfig = mergeLmstudioLoadedConfigIntoRuntime(nextConfig.runtimeConfig || {}, loadedConfig);
          }
        } catch (error) {
          console.warn(`[LMStudio] Could not import loaded model config for ${nextConfig.model}: ${error.message}`);
        }
      }
      if (shouldDisableFlashAttention(nextConfig.provider, nextConfig.model)) {
        nextConfig = withLmstudioLoadOverride(nextConfig);
      }
      if (normalizeProviderId(nextConfig.provider) === 'lmstudio' && nextConfig.model) {
        try {
          const appliedConfig = await enforceLmstudioLoadedConfig(nextConfig.model, nextConfig.runtimeConfig || {}, scopeOptions);
          if (appliedConfig && typeof appliedConfig === 'object') {
            nextConfig.runtimeConfig = mergeLmstudioLoadedConfigIntoRuntime(nextConfig.runtimeConfig || {}, appliedConfig);
          }
        } catch (error) {
          console.warn(`[LMStudio] Failed to enforce model load config for ${nextConfig.model}: ${error.message}`);
        }
      }

      if (nextConfig.concurrencyEnabled !== undefined) {
        await writeScopedSetting('llm.concurrency.enabled', nextConfig.concurrencyEnabled ? 'true' : 'false', scopeOptions);
      }
      await saveActiveSelection(db, nextConfig.provider, nextConfig.model, scopeOptions);

      const providerSpec = getProviderSpec(nextConfig.provider);
      const connection = normalizeConnectionPayload(nextConfig);
      if (providerSpec?.settings?.connectionFields?.length) {
        await saveProviderConnectionConfig(db, nextConfig.provider, connection, scopeOptions);
      }
      if (nextConfig.apiKey !== undefined && !providerSpec?.settings?.connectionFields?.some(field => field.id === 'apiKey')) {
        if (nextConfig.apiKey) {
          await db.setAPIKey(nextConfig.provider, nextConfig.apiKey, scopeOptions);
        }
      }
      if (nextConfig.url !== undefined && !providerSpec?.settings?.connectionFields?.some(field => field.id === 'url')) {
        await writeScopedSetting(`llm.${nextConfig.provider}.url`, nextConfig.url, scopeOptions);
      }

      if (nextConfig.provider === 'qwen') {
        const existingMode = await readScopedSetting('llm.qwen.mode', scopeOptions);
        const existingUseOAuth = (await readScopedSetting('llm.qwen.useOAuth', scopeOptions)) === 'true';
        const mode = nextConfig.mode || existingMode || 'cli';
        const useOAuth = nextConfig.useOAuth !== undefined
          ? nextConfig.useOAuth === true
          : (mode === 'oauth' || existingUseOAuth);
        await writeScopedSetting('llm.qwen.mode', mode, scopeOptions);
        await writeScopedSetting('llm.qwen.useOAuth', useOAuth ? 'true' : 'false', scopeOptions);
      } else if (nextConfig.provider === 'openai') {
        await writeScopedSetting('llm.openai.transport', 'api-key', scopeOptions);
      } else if (nextConfig.provider === 'opencode') {
        if (nextConfig.opencodeCommandPath !== undefined) {
          await writeScopedSetting('llm.opencode.commandPath', String(nextConfig.opencodeCommandPath || '').trim(), scopeOptions);
        }
        if (nextConfig.opencodeAutoStart !== undefined) {
          await writeScopedSetting('llm.opencode.autoStart', nextConfig.opencodeAutoStart ? 'true' : 'false', scopeOptions);
        }
      } else if (nextConfig.useOAuth) {
        await writeScopedSetting(`llm.${nextConfig.provider}.useOAuth`, 'true', scopeOptions);
      }

      await aiService.setProvider(nextConfig.provider, scopeOptions);

      let resolvedRuntime = null;
      if (nextConfig.model) {
        await rememberTestedModel(db, nextConfig.provider, nextConfig.model, scopeOptions);
        await upsertDiscoveredModel(nextConfig.provider, nextConfig.model, scopeOptions);
        if (nextConfig.provider === 'opencode') {
          await upsertDiscoveredModelOption(nextConfig.provider, { value: nextConfig.model, label: nextConfig.model }, scopeOptions);
        }
        resolvedRuntime = await syncResolvedRuntime(nextConfig.provider, nextConfig.model, nextConfig.runtimeConfig || null, scopeOptions);
      }

      refreshProviderModelCache(nextConfig.provider, scopeOptions)
        .catch(err => console.error(`Stale model-cache refresh failed for ${nextConfig.provider}:`, err));

      return { success: true, runtimeConfig: resolvedRuntime };
    } catch (error) {
      console.error('Failed to save LLM config:', error);
      throw error;
    }
  });

  ipcMain.handle('llm:fetch-qwen-oauth', async (event) => {
    try {
      const oauthPath = path.join(os.homedir(), '.qwen', 'oauth_creds.json');
      if (fs.existsSync(oauthPath)) {
        const oauthData = fs.readFileSync(oauthPath, 'utf-8');
        const creds = JSON.parse(oauthData);
        const scopeOptions = buildScopeOptions(event);
        if (db.setCredential) {
          await db.setCredential('llm.qwen.oauthCreds', JSON.stringify(creds), scopeOptions);
          await writeScopedSetting('llm.qwen.oauthCreds', '', scopeOptions);
        } else {
          await writeScopedSetting('llm.qwen.oauthCreds', JSON.stringify(creds), scopeOptions);
        }
        await writeScopedSetting('llm.qwen.useOAuth', 'true', scopeOptions);
        return creds;
      }
      throw new Error('Qwen OAuth credentials not found at ~/.qwen/oauth_creds.json');
    } catch (error) {
      console.error('Failed to fetch Qwen OAuth:', error);
      throw error;
    }
  });

  ipcMain.handle('llm:get-config', async (event) => {
    try {
      const scopeOptions = buildScopeOptions(event);
      const { provider, model, source } = await getEffectiveLlmSelection(db, scopeOptions);
      const config = { provider, model };
      config.selectionSource = source;
      config.concurrencyEnabled = (await readScopedSetting('llm.concurrency.enabled', scopeOptions)) === 'true';

      if (provider) {
        config.providerLabel = getProviderSpec(provider)?.label || provider;
        const connection = await getProviderConnectionConfig(db, provider, scopeOptions);
        const keyInfo = typeof db.getAPIKeyInfo === 'function'
          ? await db.getAPIKeyInfo(provider, scopeOptions)
          : { configured: Boolean(await db.getAPIKey(provider, scopeOptions)) };
        const url = await readScopedSetting(`llm.${provider}.url`, scopeOptions);
        const mode = await readScopedSetting(`llm.${provider}.mode`, scopeOptions);
        const useOAuth = await readScopedSetting(`llm.${provider}.useOAuth`, scopeOptions);
        config.connection = connection;
        config.apiKeyConfigured = Boolean(connection.apiKeyConfigured || keyInfo.configured);
        config.apiKeyEncrypted = Boolean(connection.apiKeyEncrypted || keyInfo.encrypted);
        if (connection.url || url) config.url = connection.url || url;
        if (mode) config.mode = mode;
        if (useOAuth === 'true') config.useOAuth = true;
        if (provider === 'openai') {
          config.transport = 'api-key';
        }
        if (provider === 'opencode') {
          config.opencodeAutoStart = (await readScopedSetting('llm.opencode.autoStart', scopeOptions)) !== 'false';
          config.opencodeCommandPath = await readScopedSetting('llm.opencode.commandPath', scopeOptions) || '';
        }
      }

      if (provider && model) {
        const activeContext = await getActiveModelContext(db, scopeOptions);
        config.runtimeConfig = activeContext.runtimeConfig;
        config.modelSpec = activeContext.spec;
      }

      return config;
    } catch (error) {
      console.error('Failed to get LLM config:', error);
      return {};
    }
  });

  ipcMain.handle('llm:get-provider-connection-config', async (event, provider) => {
    if (!provider) return {};
    return getProviderConnectionConfig(db, provider, buildScopeOptions(event));
  });

  ipcMain.handle('llm:get-provider-profiles', async () => {
    return {
      specFile: SPEC_FILE,
      providers: getProviderProfiles()
    };
  });
  ipcMain.handle('llm:get-model-discovery-meta', async (event, provider) => {
    const scopeOptions = buildScopeOptions(event);
    const providerId = normalizeProviderId(provider);
    const meta = getProviderDiscoveryMeta(providerId);
    return {
      provider: providerId,
      runtimeKind: providerId === 'local-codex' ? 'direct-responses' : (providerId === 'opencode' ? 'opencode-serve' : ''),
      ...meta
    };
  });

  ipcMain.handle('llm:local-codex-status', async (event) => {
    if (!codexRuntimeManager?.getStatus) {
      return { installed: false, loggedIn: false, error: 'Codex provider unavailable' };
    }
    return codexRuntimeManager.getStatus(buildScopeOptions(event));
  });

  ipcMain.handle('llm:local-codex-login', async () => {
    if (!codexRuntimeManager?.launchLogin) {
      return { launched: false, error: 'Codex provider unavailable' };
    }
    return codexRuntimeManager.launchLogin();
  });

  ipcMain.handle('llm:local-codex-reset-session', async (event, sessionId) => {
    if (!codexRuntimeManager?.resetSession) {
      return { success: false, error: 'Codex provider unavailable' };
    }
    return codexRuntimeManager.resetSession(sessionId, buildScopeOptions(event));
  });

  ipcMain.handle('llm:local-codex-diagnostics', async (event, sessionId = null) => {
    if (!codexRuntimeManager?.getDiagnostics) {
      return { providerId: 'local-codex', error: 'Codex provider unavailable' };
    }
    return codexRuntimeManager.getDiagnostics(sessionId, buildScopeOptions(event));
  });

  ipcMain.handle('llm:opencode-status', async (event) => {
    return opencodeRuntimeManager?.getStatus
      ? opencodeRuntimeManager.getStatus(buildScopeOptions(event))
      : { installed: false, serverRunning: false, error: 'OpenCode runtime unavailable' };
  });

  ipcMain.handle('llm:opencode-refresh-models', async (event) => {
    return opencodeRuntimeManager?.getModelOptions
      ? opencodeRuntimeManager.getModelOptions('', true, buildScopeOptions(event))
      : [];
  });

  ipcMain.handle('llm:get-model-profile', async (event, provider, model) => {
    if (!provider || !model) return null;
    const { spec, runtime } = await getModelRuntimeConfig(db, provider, model, buildScopeOptions(event));
    return {
      specFile: SPEC_FILE,
      spec,
      runtimeConfig: runtime
    };
  });

  ipcMain.handle('llm:save-model-runtime', async (event, { provider, model, runtimeConfig }) => {
    if (!provider || !model) {
      throw new Error('Provider and model are required');
    }

    const saved = await saveModelRuntimeConfig(db, provider, model, runtimeConfig, buildScopeOptions(event));
    const scopeOptions = buildScopeOptions(event);
    const active = await getEffectiveLlmSelection(db, scopeOptions);
    if (active.provider === provider && active.model === model) {
      await syncResolvedRuntime(provider, model, saved.runtime, scopeOptions);
    }

    return {
      success: true,
      specFile: SPEC_FILE,
      spec: saved.spec,
      runtimeConfig: saved.runtime
    };
  });

  ipcMain.handle('stop-generation', async () => {
    const stopped = aiService.stopGeneration();
    if (runtime.chainController && runtime.chainController.stopChain) {
      runtime.chainController.stopChain();
    }
    return { stopped };
  });

  ipcMain.handle('is-generating', async () => ({ generating: aiService.isGenerating }));
  ipcMain.handle('get-ai-providers', async () => aiService.getProviders());
  ipcMain.handle('get-providers', async () => aiService.getProviders());
  ipcMain.handle('get-models', async (event, provider) => {
    const providerId = normalizeProviderId(provider);
    const cached = await loadCachedProviderModels(providerId, buildScopeOptions(event));
    queueProviderModelCacheRefresh(providerId, buildScopeOptions(event));
    return providerId === 'opencode' ? normalizeModelOptions(cached).map(option => option.value) : cached;
  });

  ipcMain.handle('qwen:refresh-models', async (event) => {
    try {
      const models = await aiService.getModels('qwen', false, buildScopeOptions(event));
      return { success: true, models };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('llm:test-model', async (event, { provider, model }) => {
    try {
      if (provider === 'local-codex') {
        const result = await codexRuntimeManager.testModel(model, buildScopeOptions(event));
        await rememberTestedModel(db, provider, model, buildScopeOptions(event));
        await upsertDiscoveredModel(provider, model, buildScopeOptions(event));
        await rememberLastWorkingModel(db, provider, model, buildScopeOptions(event));
        await saveActiveSelection(db, provider, model, buildScopeOptions(event));
        await aiService.setProvider(provider, buildScopeOptions(event));
        const runtimeConfig = await syncResolvedRuntime(provider, model, null, buildScopeOptions(event));
        return {
          success: true,
          model: result.model,
          content: result.content,
          remembered: true,
          runtimeConfig
        };
      }
      if (provider === 'opencode') {
        const result = await opencodeRuntimeManager.testModel(model, buildScopeOptions(event));
        await rememberTestedModel(db, provider, model, buildScopeOptions(event));
        await upsertDiscoveredModel(provider, model, buildScopeOptions(event));
        await upsertDiscoveredModelOption(provider, { value: model, label: model }, buildScopeOptions(event));
        await rememberLastWorkingModel(db, provider, model, buildScopeOptions(event));
        await saveActiveSelection(db, provider, model, buildScopeOptions(event));
        await aiService.setProvider(provider, buildScopeOptions(event));
        const runtimeConfig = await syncResolvedRuntime(provider, model, null, buildScopeOptions(event));
        return {
          success: true,
          model: result.model,
          content: result.content,
          remembered: true,
          runtimeConfig
        };
      }
      const adapter = aiService.adapters[provider];
      if (!adapter) return { success: false, error: `Unknown provider: ${provider}` };
      const result = await adapter.call(
        [{ role: 'user', content: 'hello' }],
        { model, max_tokens: 10, requestContext: getRequestContext(event) }
      );
      await rememberTestedModel(db, provider, model, buildScopeOptions(event));
      await upsertDiscoveredModel(provider, model, buildScopeOptions(event));
      await rememberLastWorkingModel(db, provider, model, buildScopeOptions(event));
      await saveActiveSelection(db, provider, model, buildScopeOptions(event));
      await aiService.setProvider(provider, buildScopeOptions(event));
      const runtimeConfig = await syncResolvedRuntime(provider, model, null, buildScopeOptions(event));
      return {
        success: true,
        model: result.model,
        content: result.content,
        remembered: true,
        runtimeConfig
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('llm:set-thinking-mode', async (event, mode) => {
    const scopeOptions = buildScopeOptions(event);
    const { provider, model } = await getEffectiveLlmSelection(db, scopeOptions);

    if (provider && model) {
      const profile = await getModelRuntimeConfig(db, provider, model, scopeOptions);
      const saved = await saveModelRuntimeConfig(db, provider, model, {
        reasoning: {
          ...profile.runtime.reasoning,
          enabled: mode === 'think'
        }
      }, scopeOptions);
      await writeScopedSetting('llm.thinkingMode', saved.runtime.reasoning.enabled ? 'think' : 'off', scopeOptions);
      await writeScopedSetting('llm.showThinking', saved.runtime.reasoning.visibility === 'hide' ? 'false' : 'true', scopeOptions);
      await writeScopedSetting('llm.thinkingVisibility', saved.runtime.reasoning.visibility || 'show', scopeOptions);
    } else {
      await writeScopedSetting('llm.thinkingMode', mode, scopeOptions);
    }

    broadcastCompanionLlmSettingsChange('thinking-mode');
    return { success: true, mode };
  });

  ipcMain.handle('llm:get-thinking-mode', async (event) => {
    const scopeOptions = buildScopeOptions(event);
    const { provider, model } = await getEffectiveLlmSelection(db, scopeOptions);

    if (provider && model) {
      const { runtime } = await getModelRuntimeConfig(db, provider, model, scopeOptions);
      return {
        mode: runtime.reasoning.enabled ? 'think' : 'off',
        showThinking: runtime.reasoning.visibility !== 'hide',
        visibility: runtime.reasoning.visibility
      };
    }

    const mode = await readScopedSetting('llm.thinkingMode', scopeOptions) || 'off';
    const show = await readScopedSetting('llm.showThinking', scopeOptions);
    return { mode, showThinking: show !== 'false', visibility: await readScopedSetting('llm.thinkingVisibility', scopeOptions) || 'show' };
  });

  ipcMain.handle('llm:set-show-thinking', async (event, show) => {
    const scopeOptions = buildScopeOptions(event);
    const { provider, model } = await getEffectiveLlmSelection(db, scopeOptions);

    if (provider && model) {
      const profile = await getModelRuntimeConfig(db, provider, model, scopeOptions);
      const saved = await saveModelRuntimeConfig(db, provider, model, {
        reasoning: {
          ...profile.runtime.reasoning,
          visibility: show ? 'show' : 'hide'
        }
      }, scopeOptions);
      await writeScopedSetting('llm.showThinking', saved.runtime.reasoning.visibility === 'hide' ? 'false' : 'true', scopeOptions);
      await writeScopedSetting('llm.thinkingVisibility', saved.runtime.reasoning.visibility || 'show', scopeOptions);
    } else {
      await writeScopedSetting('llm.showThinking', show ? 'true' : 'false', scopeOptions);
    }
    broadcastCompanionLlmSettingsChange('thinking-visibility');
    return { success: true };
  });

  ipcMain.handle('verify-qwen-key', async (event, apiKey) => {
    if (!apiKey || apiKey.trim() === '') {
      return { success: false, error: 'API key cannot be empty' };
    }
    try {
      const response = await providerRequest({
        method: 'get',
        url: 'https://dashscope.aliyuncs.com/api/v1/models',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      }, { timeoutMs: 10000, label: 'Qwen API key verification' });
      if (response.data && response.data.data && Array.isArray(response.data.data)) {
        return { success: true, modelCount: response.data.data.length };
      }
      return { success: false, error: 'Invalid API response format' };
    } catch (error) {
      let errorMessage = 'API key verification failed';
      const sourceError = error.cause || error;
      if (sourceError.response) {
        if (sourceError.response.status === 401) {
          errorMessage = 'Invalid API key: Unauthorized';
        } else if (sourceError.response.data && sourceError.response.data.error) {
          errorMessage = `API error: ${sourceError.response.data.error.message || sourceError.response.data.error}`;
        } else {
          errorMessage = `API returned status ${sourceError.response.status}`;
        }
      } else if (sourceError.request) {
        errorMessage = 'No response from Qwen API server';
      } else {
        errorMessage = `Request setup error: ${sourceError.message}`;
      }
      return { success: false, error: errorMessage };
    }
  });

  ipcMain.handle('set-ai-provider', async (event, provider) => {
    const scopeOptions = buildScopeOptions(event);
    const active = await getEffectiveLlmSelection(db, scopeOptions);
    await saveActiveSelection(db, provider, active.model, scopeOptions);
    await aiService.setProvider(provider, scopeOptions);
    return { success: true, provider };
  });

  ipcMain.handle('set-ai-model', async (event, model) => {
    const scopeOptions = buildScopeOptions(event);
    const active = await getEffectiveLlmSelection(db, scopeOptions);
    await saveActiveSelection(db, active.provider, model, scopeOptions);
    return { success: true };
  });

  ipcMain.handle('set-system-prompt', async (event, prompt) => {
    const scopeOptions = buildScopeOptions(event);
    if (promptFileManager) {
      await promptFileManager.saveSystemPrompt(prompt, true, scopeOptions);
    } else {
      await writeScopedSetting('system_prompt', prompt, scopeOptions);
    }
    await aiService.setSystemPrompt(prompt, scopeOptions);
    return { success: true };
  });

  ipcMain.handle('get-system-prompt', async (event) => {
    try {
      const scopeOptions = buildScopeOptions(event);
      if (promptFileManager) {
        return await promptFileManager.loadSystemPrompt(scopeOptions);
      }
      const prompt = await readScopedSetting('system_prompt', scopeOptions);
      return prompt || 'You are a helpful AI assistant.';
    } catch (error) {
      console.error('Error getting system prompt:', error);
      return 'You are a helpful AI assistant.';
    }
  });

  ipcMain.handle('get-context-setting', async (event) => {
    try {
      const active = await getActiveModelContext(db, buildScopeOptions(event));
      const discovered = active && !active.configurable
        ? await aiService.getProviderContextWindow?.(active.provider, active.model, buildScopeOptions(event)) : null;
      return discovered || active?.contextWindow ? String(discovered || active.contextWindow) : '';
    } catch (error) {
      console.error('Error getting context setting:', error);
      return '';
    }
  });

  ipcMain.handle('set-context-setting', async (event, value) => {
    try {
      const result = await saveActiveModelContext(db, value, buildScopeOptions(event));
      broadcastCompanionLlmSettingsChange('context-window');
      console.log(`[Context] ${result.provider}/${result.model}=${result.contextWindow}`);
      return result;
    } catch (error) {
      console.error('Context save error:', error.message);
      throw error;
    }
  });

  ipcMain.handle('get-setting-value', async (event, key) => {
    try {
      return await getGenericSettingValue(db, key, buildScopeOptions(event));
    } catch (error) {
      console.error(`Error getting setting ${key}:`, error);
      return null;
    }
  });
  ipcMain.handle('prompt:get-paths', async (event) => {
    if (!promptFileManager) return { error: 'PromptFileManager not initialized' };
    return promptFileManager.getPaths(buildScopeOptions(event));
  });

  ipcMain.handle('prompt:sync-from-files', async (event) => {
    if (!promptFileManager) return { error: 'PromptFileManager not initialized' };
    const scopeOptions = buildScopeOptions(event);
    await promptFileManager.syncFromFiles(scopeOptions);
    const systemPrompt = await promptFileManager.loadSystemPrompt(scopeOptions);
    await aiService.setSystemPrompt(systemPrompt, scopeOptions);
    return { success: true };
  });

  ipcMain.handle('prompt:sync-to-files', async (event) => {
    if (!promptFileManager) return { error: 'PromptFileManager not initialized' };
    await promptFileManager.syncToFiles(buildScopeOptions(event));
    return { success: true };
  });

  ipcMain.handle('prompt:get-system', async (event) => {
    if (!promptFileManager) {
      const prompt = await readScopedSetting('system_prompt', buildScopeOptions(event));
      return prompt || 'You are a helpful AI assistant.';
    }
    return promptFileManager.loadSystemPrompt(buildScopeOptions(event));
  });

  ipcMain.handle('prompt:set-system', async (event, content) => {
    const scopeOptions = buildScopeOptions(event);
    if (promptFileManager) {
      await promptFileManager.saveSystemPrompt(content, true, scopeOptions);
    } else {
      await writeScopedSetting('system_prompt', content, scopeOptions);
    }
    await aiService.setSystemPrompt(content, scopeOptions);
    return { success: true };
  });

  ipcMain.handle('prompt:get-rules-from-files', async (event) => {
    if (!promptFileManager) return [];
    return promptFileManager.loadRulesFromFiles(buildScopeOptions(event));
  });

}

module.exports = { registerLlmHandlers };
