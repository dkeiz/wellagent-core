// ---------------------------------------------------------------------------
// lib/inference/dispatcher.ts — Inference dispatcher
// ---------------------------------------------------------------------------

import { ScopedSettingsAccessor } from '../core/settings';
import type { Provider, ProviderCallOptions } from './provider';
import type {
  LLMResponse,
  Message,
  SettingsStore,
  DispatchOptions,
  Logger,
} from '../core/types';

/**
 * Routes inference requests to the appropriate provider.
 *
 * Resolves which provider + model to use based on:
 * 1. Explicit options (`options.provider`, `options.model`)
 * 2. Stored user settings (`llm.provider`, `llm.model`)
 * 3. Default fallback (first registered provider)
 *
 * Usage:
 * ```typescript
 * const dispatcher = new Dispatcher(db, { providers: [ollama, openrouter] });
 * const response = await dispatcher.dispatch('Hello', history, { model: 'llama3' });
 * ```
 */
export class Dispatcher extends ScopedSettingsAccessor {
  private _providers: Map<string, Provider>;
  private _logger: Logger;

  constructor(db: SettingsStore, options: { providers?: Provider[]; logger?: Logger } = {}) {
    super(db);
    this._providers = new Map();
    this._logger = options.logger ?? console;

    if (options.providers) {
      for (const provider of options.providers) {
        this.registerProvider(provider);
      }
    }
  }

  /**
   * Register a provider adapter.
   */
  registerProvider(provider: Provider): void {
    this._providers.set(provider.name, provider);
  }

  /**
   * Remove a provider adapter.
   */
  removeProvider(name: string): boolean {
    return this._providers.delete(name);
  }

  /**
   * Get a provider by name.
   */
  getProvider(name: string): Provider | null {
    return this._providers.get(name) ?? null;
  }

  /**
   * List all registered provider names.
   */
  listProviders(): string[] {
    return Array.from(this._providers.keys());
  }

  /**
   * Dispatch an inference request.
   *
   * Builds the message array from prompt + history, resolves the provider,
   * and returns the LLM response.
   */
  async dispatch(
    prompt: string,
    history: Message[] = [],
    options: DispatchOptions = {}
  ): Promise<LLMResponse> {
    const provider = await this._resolveProvider(options);

    // Build messages
    const messages: Message[] = [];

    // System prompt
    if (options.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }

    // History
    messages.push(...history);

    // Current prompt
    if (prompt) {
      messages.push({ role: 'user', content: prompt });
    }

    const callOptions: ProviderCallOptions = {
      model: options.model,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      contextWindow: options.contextWindow,
      thinkingMode: options.thinkingMode,
      thinkingBudget: options.thinkingBudget,
      signal: options.signal,
      requestContext: options.requestContext,
      userId: options.userId,
    };

    this._logger.log?.(`[Dispatcher] Routing to "${provider.name}" model="${callOptions.model || 'default'}"`);

    return provider.call(messages, callOptions);
  }

  /**
   * Stop a running request by provider name.
   */
  stop(providerName?: string, requestId?: string | null): boolean {
    if (providerName) {
      const provider = this._providers.get(providerName);
      return provider?.stop(requestId) ?? false;
    }
    // Stop all providers
    let stopped = false;
    for (const provider of this._providers.values()) {
      if (provider.stop(requestId)) stopped = true;
    }
    return stopped;
  }

  /**
   * Whether any provider is generating.
   */
  get isGenerating(): boolean {
    for (const provider of this._providers.values()) {
      if (provider.isGenerating) return true;
    }
    return false;
  }

  /**
   * Resolve which provider to use.
   */
  private async _resolveProvider(options: DispatchOptions = {}): Promise<Provider> {
    // 1. Explicit provider option
    if (options.provider) {
      const provider = this._providers.get(options.provider);
      if (provider) return provider;
      this._logger.warn?.(`[Dispatcher] Requested provider "${options.provider}" not registered`);
    }

    // 2. Stored setting
    const storedProvider = await this._getSetting('llm.provider', options);
    if (storedProvider) {
      const provider = this._providers.get(storedProvider);
      if (provider) return provider;
    }

    // 3. First registered
    const first = this._providers.values().next();
    if (!first.done) return first.value;

    throw new Error('[Dispatcher] No providers registered');
  }
}
