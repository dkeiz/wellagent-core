// @ts-nocheck
const OllamaAdapter = require('./providers/ollama-adapter');
const LMStudioAdapter = require('./providers/lmstudio-adapter');
const OpenRouterAdapter = require('./providers/openrouter-adapter');
const OpenAICompatibleAdapter = require('./providers/openai-compatible-adapter');
const QwenAdapter = require('./providers/qwen-adapter');
const { getEffectiveLlmSelection } = require('./llm-state');

class AIService {
  constructor(db, mcpServer = null, options = {}) {
    this.db = db;
    this.mcpServer = mcpServer;
    this.windowManager = options.windowManager || null;
    this.currentProvider = 'ollama';
    this.systemPrompt = 'You are a helpful AI assistant with access to calendar and todo functions.';
    this.runtimeProviders = {};
    this.retryCancellationHandler = null;

    this.adapters = {
      ollama: new OllamaAdapter(db),
      lmstudio: new LMStudioAdapter(db, {
        onSoftAlert: ({ message, level = 'info', provider = 'lmstudio' } = {}) => {
          if (!this.windowManager?.send || !message) return;
          this.windowManager.send('llm-soft-alert', { provider, level, message });
        }
      }),
      openrouter: new OpenRouterAdapter(db),
      qwen: new QwenAdapter(db),
      openai: new OpenAICompatibleAdapter('openai', db, {
        label: 'OpenAI',
        defaultBaseURL: 'https://api.openai.com/v1',
        apiPrefix: '/v1'
      }),
      groq: new OpenAICompatibleAdapter('groq', db, {
        label: 'Groq',
        defaultBaseURL: 'https://api.groq.com/openai/v1',
        apiPrefix: '/v1'
      }),
      deepseek: new OpenAICompatibleAdapter('deepseek', db, {
        label: 'DeepSeek',
        defaultBaseURL: 'https://api.deepseek.com/v1',
        apiPrefix: '/v1'
      }),
      mistral: new OpenAICompatibleAdapter('mistral', db, {
        label: 'Mistral',
        defaultBaseURL: 'https://api.mistral.ai/v1',
        apiPrefix: '/v1'
      }),
      anthropic: new OpenAICompatibleAdapter('anthropic', db, {
        label: 'Anthropic',
        defaultBaseURL: 'https://api.anthropic.com/v1',
        apiPrefix: '/v1',
        defaultHeaders: {
          'anthropic-version': '2023-06-01'
        }
      }),
      byok: new OpenAICompatibleAdapter('byok', db, {
        label: 'BYOK',
        apiPrefix: '/v1',
        apiKeyOptional: true
      }),
      'local-openai': new OpenAICompatibleAdapter('local-openai', db, {
        label: 'Local Server',
        defaultBaseURL: 'http://127.0.0.1:8000/v1',
        apiPrefix: '/v1',
        apiKeyOptional: true
      })
    };
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

  async _saveSetting(key, value, options = {}) {
    const scopeOptions = this._buildScopeOptions(options);
    if (this.db?.saveScopedSetting && (scopeOptions.requestContext || scopeOptions.userId)) {
      return this.db.saveScopedSetting(key, value, scopeOptions);
    }
    return this.db.setSetting(key, value);
  }

  stopGeneration(provider = null) {
    const targetProvider = String(provider || this.currentProvider || '').trim().toLowerCase();
    const retryStopped = this.retryCancellationHandler?.(provider ? targetProvider : null) === true;
    const runtimeProvider = this.runtimeProviders[targetProvider];
    if (runtimeProvider?.stop) {
      return runtimeProvider.stop() === true || retryStopped;
    }
    const adapter = this.adapters[targetProvider];
    if (adapter) {
      return adapter.stop() === true || retryStopped;
    }
    return retryStopped;
  }

  setRetryCancellationHandler(handler) {
    this.retryCancellationHandler = typeof handler === 'function' ? handler : null;
  }

  get isGenerating() {
    const runtimeProvider = this.runtimeProviders[this.currentProvider];
    if (runtimeProvider?.isGenerating) {
      return runtimeProvider.isGenerating;
    }
    const adapter = this.adapters[this.currentProvider];
    return adapter ? adapter.isGenerating : false;
  }

  setRuntimeProvider(providerId, provider) {
    const normalizedProvider = String(providerId || '').trim().toLowerCase();
    if (!normalizedProvider || !provider) return;
    this.runtimeProviders[normalizedProvider] = provider;
  }

  getRuntimeProvider(providerId = null) {
    const normalizedProvider = String(providerId || this.currentProvider || '').trim().toLowerCase();
    return this.runtimeProviders[normalizedProvider] || null;
  }

  isRuntimeProvider(providerId = null) {
    return Boolean(this.getRuntimeProvider(providerId));
  }

  getProviderDiscoveryMeta(providerId = null) {
    const normalizedProvider = String(providerId || this.currentProvider || '').trim().toLowerCase();
    const runtimeProvider = this.runtimeProviders[normalizedProvider];
    if (runtimeProvider?.getLastModelDiscovery) {
      return runtimeProvider.getLastModelDiscovery();
    }
    return this.adapters[normalizedProvider]?.getLastModelDiscovery?.() || {
      ok: null,
      source: 'unknown',
      authoritative: false,
      error: null,
      count: 0,
      at: null
    };
  }

  async initialize() {
    const ownerScope = { userId: 'localuser' };
    const { provider } = await getEffectiveLlmSelection(this.db, ownerScope);
    this.currentProvider = provider || 'ollama';
    console.log('AI Service initialized with provider:', this.currentProvider);

    const savedPrompt = await this._getSetting('system_prompt', ownerScope);
    if (savedPrompt) this.systemPrompt = savedPrompt;
  }

  async sendMessage(messages, options = {}) {
    const targetProvider = String(options.provider || this.currentProvider || '').trim().toLowerCase();
    const adapter = this.adapters[targetProvider];
    if (!adapter) {
      throw new Error(`Unsupported provider: ${targetProvider || this.currentProvider}`);
    }

    try {
      return await adapter.call(messages, options);
    } catch (error) {
      console.error(`[AIService] ${targetProvider} error:`, error.message);
      throw error;
    }
  }

  async prepareMessagesForEstimate(provider, messages, options = {}) {
    const targetProvider = String(provider || this.currentProvider || '').trim().toLowerCase();
    const adapter = this.adapters[targetProvider];
    if (!adapter?.prepareMessagesForEstimate) {
      return Array.isArray(messages) ? messages : [];
    }
    return adapter.prepareMessagesForEstimate(messages, options);
  }

  async getProviderContextWindow(provider, model, options = {}) {
    const targetProvider = String(provider || this.currentProvider || '').trim().toLowerCase();
    const runtimeProvider = this.runtimeProviders[targetProvider];
    if (runtimeProvider?.getModelContextWindow && model) {
      const runtimeContextWindow = Number(await runtimeProvider.getModelContextWindow(model, options));
      return Number.isFinite(runtimeContextWindow) && runtimeContextWindow > 0 ? runtimeContextWindow : null;
    }
    const adapter = this.adapters[targetProvider];
    if (!adapter?.getModelContextWindow || !model) return null;
    const contextWindow = Number(await adapter.getModelContextWindow(model, options));
    return Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : null;
  }

  async getModels(provider = null, forceRefresh = false, options = {}) {
    const targetProvider = provider || this.currentProvider;
    const runtimeProvider = this.runtimeProviders[targetProvider];
    if (runtimeProvider?.getModels) {
      try {
        return await runtimeProvider.getModels(forceRefresh, options);
      } catch (error) {
        console.error(`Error fetching runtime models from ${targetProvider}:`, error.message);
        return [];
      }
    }
    const adapter = this.adapters[targetProvider];
    if (!adapter) return [];

    try {
      return await adapter.getModels(forceRefresh, options);
    } catch (error) {
      console.error(`Error fetching models from ${targetProvider}:`, error.message);
      return [];
    }
  }

  async setProvider(provider, options = {}) {
    if (!this.adapters[provider] && !this.runtimeProviders[provider]) {
      throw new Error(`Unknown provider: ${provider}`);
    }
    this.currentProvider = provider;
    await this._saveSetting('llm.provider', provider, options);
    console.log('Provider changed to:', provider);
  }

  async setSystemPrompt(prompt, options = {}) {
    const scopeOptions = this._buildScopeOptions(options);
    if (!scopeOptions.userId || scopeOptions.userId === 'localuser') {
      this.systemPrompt = prompt;
    }
    await this._saveSetting('system_prompt', prompt, scopeOptions);
  }

  async setAPIKey(provider, key, options = {}) {
    if (!this.adapters[provider]) {
      throw new Error(`Unknown provider: ${provider}`);
    }
    await this.db.setAPIKey(provider, key, this._buildScopeOptions(options));
  }

  getCurrentProvider() {
    return this.currentProvider;
  }

  getSystemPrompt() {
    return this.systemPrompt;
  }

  getProviders() {
    return Array.from(new Set([
      ...Object.keys(this.adapters),
      ...Object.keys(this.runtimeProviders)
    ]));
  }
}

module.exports = AIService;
