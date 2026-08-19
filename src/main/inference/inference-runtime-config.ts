// @ts-nocheck
const { getModelRuntimeConfig, saveModelRuntimeConfig, sanitizeRuntimeConfig } = require('../llm-config');

class InferenceRuntimeConfig {
  constructor({ db, aiService }) {
    this.db = db;
    this.aiService = aiService;
    this.runtimeContextCache = new Map();
  }

  _buildScopeOptions(options = {}) {
    const userId = String(options?.userId || '').trim();
    return {
      requestContext: options?.requestContext || null,
      userId: userId || undefined
    };
  }

  async _getSetting(key, options = {}) {
    const scopeOptions = this._buildScopeOptions(options);
    if (this.db?.getScopedSetting && (scopeOptions.requestContext || scopeOptions.userId)) {
      return this.db.getScopedSetting(key, scopeOptions);
    }
    return this.db.getSetting(key);
  }

  async resolveContextWindow({ provider, model, modelSpec, runtimeConfig, requestContext = null, userId = null }) {
    const scopeOptions = { requestContext, userId };
    if (!model) {
      const savedContext = await this._getSetting('context_window', scopeOptions);
      const parsedContext = Number.parseInt(savedContext, 10);
      return Number.isFinite(parsedContext) && parsedContext > 0 ? parsedContext : null;
    }

    let effectiveSpec = modelSpec;
    let effectiveRuntime = runtimeConfig;
    if (!effectiveRuntime) {
      const config = await this.loadModelRuntime(provider, model, scopeOptions);
      effectiveSpec = config.spec;
      effectiveRuntime = config.runtime;
    }

    if (effectiveSpec && effectiveRuntime) effectiveRuntime = sanitizeRuntimeConfig(effectiveSpec, effectiveRuntime);

    const contextCaps = effectiveSpec?.capabilities?.contextWindow || {};
    if (!contextCaps.configurable && this.aiService?.getProviderContextWindow) {
      const providerContextWindow = await this.aiService.getProviderContextWindow(provider, model, scopeOptions);
      if (providerContextWindow) return providerContextWindow;
      return null;
    }

    return effectiveRuntime?.contextWindow?.value || effectiveSpec?.runtime?.contextWindow?.value || null;
  }

  async loadModelRuntime(provider, model, options = {}) {
    return getModelRuntimeConfig(this.db, provider, model, options);
  }

  sanitizeResolvedRuntime(modelSpec, runtimeConfig = {}) {
    return sanitizeRuntimeConfig(modelSpec, runtimeConfig);
  }

  async rememberWorkingRuntimeParams(provider, model, modelSpec, runtimeConfig, response, options = {}) {
    if (!provider || !model || !modelSpec || response?.stopped) {
      return;
    }

    const contextCaps = modelSpec.capabilities?.contextWindow || {};
    const contextLength = runtimeConfig?.contextWindow?.value || response?.context_length;
    if (contextCaps.configurable && contextLength) {
      const normalizedLength = Number(contextLength);
      if (!Number.isFinite(normalizedLength) || normalizedLength <= 0) {
        return;
      }
      const cacheKey = `${provider}:${model}`;
      const cachedLength = this.runtimeContextCache.get(cacheKey);
      if (cachedLength === normalizedLength) {
        return;
      }
      if (
        cachedLength === undefined &&
        runtimeConfig?.contextWindow?.value === normalizedLength
      ) {
        this.runtimeContextCache.set(cacheKey, normalizedLength);
        return;
      }
      await saveModelRuntimeConfig(this.db, provider, model, {
        contextWindow: { value: normalizedLength }
      }, options);
      this.runtimeContextCache.set(cacheKey, normalizedLength);
    }
  }
}

module.exports = { InferenceRuntimeConfig };
