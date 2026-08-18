// ---------------------------------------------------------------------------
// lib/inference/provider.ts — LLM Provider adapter base class
// ---------------------------------------------------------------------------

import { ScopedSettingsAccessor } from '../core/settings';
import type {
  LLMResponse,
  TokenUsage,
  ModelDiscoveryMeta,
  ModelSpec,
  SettingsStore,
  Message,
  Logger,
} from '../core/types';

/** Options for a provider call. */
export interface ProviderCallOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  contextWindow?: number;
  thinkingMode?: string;
  thinkingBudget?: number;
  stream?: boolean;
  signal?: AbortSignal;
  requestId?: string;
  requestContext?: any;
  userId?: string;
  onToken?: (token: string) => void;
  onThinking?: (text: string) => void;
  [key: string]: any;
}

/**
 * Abstract base class for LLM provider adapters.
 *
 * Provides:
 * - Scoped settings (via ScopedSettingsAccessor)
 * - Request lifecycle tracking (start/end/abort)
 * - Response normalization (token usage, content extraction)
 * - Model discovery metadata
 *
 * Subclasses implement `call()` and `getModels()`.
 *
 * Usage:
 * ```typescript
 * class MyProvider extends Provider {
 *   constructor(db) { super('my-provider', db); }
 *   async call(messages, options) { ... }
 *   async getModels() { return ['model-a', 'model-b']; }
 * }
 * ```
 */
export abstract class Provider extends ScopedSettingsAccessor {
  readonly name: string;

  protected _activeRequests: Map<string, AbortController>;
  protected _requestSeq: number;
  protected _discoveryMeta: ModelDiscoveryMeta;
  protected _cachedModels: string[];
  protected _logger: Logger;

  constructor(name: string, db: SettingsStore, options: { logger?: Logger } = {}) {
    super(db);
    this.name = name;
    this._activeRequests = new Map();
    this._requestSeq = 0;
    this._discoveryMeta = {
      ok: null,
      source: '',
      authoritative: false,
      error: null,
      count: 0,
      at: null,
    };
    this._cachedModels = [];
    this._logger = options.logger ?? console;
  }

  /**
   * Send messages to the provider and get a response.
   * Must be implemented by each adapter.
   */
  abstract call(messages: Message[], options?: ProviderCallOptions): Promise<LLMResponse>;

  /**
   * List available models from this provider.
   * Must be implemented by each adapter.
   */
  abstract getModels(forceRefresh?: boolean, options?: any): Promise<string[]>;

  /**
   * Whether there are active (in-flight) requests.
   */
  get isGenerating(): boolean {
    return this._activeRequests.size > 0;
  }

  /**
   * Stop a specific request by ID, or all requests if no ID given.
   * Returns true if anything was actually stopped.
   */
  stop(requestId?: string | null): boolean {
    if (requestId) {
      const controller = this._activeRequests.get(requestId);
      if (controller) {
        controller.abort();
        this._activeRequests.delete(requestId);
        return true;
      }
      return false;
    }
    // Stop all
    let stopped = false;
    for (const [id, controller] of this._activeRequests) {
      controller.abort();
      this._activeRequests.delete(id);
      stopped = true;
    }
    return stopped;
  }

  /**
   * Get model discovery metadata.
   */
  getDiscoveryMeta(): ModelDiscoveryMeta {
    return { ...this._discoveryMeta };
  }

  /**
   * Start tracking a request. Returns the requestId and an AbortSignal.
   */
  protected _startRequest(requestId?: string): { requestId: string; signal: AbortSignal } {
    const id = requestId || `req-${++this._requestSeq}-${Date.now()}`;
    const controller = new AbortController();
    this._activeRequests.set(id, controller);
    return { requestId: id, signal: controller.signal };
  }

  /**
   * End tracking a request (cleanup).
   */
  protected _endRequest(requestId?: string): void {
    if (requestId) {
      this._activeRequests.delete(requestId);
    }
  }

  /**
   * Normalize a raw provider response into a consistent LLMResponse shape.
   * Handles the various ways providers report token usage.
   */
  protected _normalizeResponse(raw: {
    content?: string;
    reasoning?: string;
    model?: string;
    usage?: any;
    stopped?: boolean;
    context_length?: number;
    [key: string]: any;
  }): LLMResponse {
    const usage = raw.usage || {};
    const normalizedUsage: TokenUsage = {
      prompt_tokens: usage.prompt_tokens ?? usage.promptTokens ?? 0,
      completion_tokens: usage.completion_tokens ?? usage.completionTokens ?? 0,
      total_tokens: usage.total_tokens ?? usage.totalTokens ?? 0,
      cached_tokens: usage.cached_tokens ?? usage.cachedTokens
        ?? usage.prompt_tokens_details?.cached_tokens ?? 0,
      cache_write_tokens: usage.cache_write_tokens ?? usage.cacheWriteTokens
        ?? usage.prompt_tokens_details?.cache_write_tokens ?? 0,
      prompt_tokens_details: usage.prompt_tokens_details ?? null,
    };

    // Auto-compute total if not provided
    if (!normalizedUsage.total_tokens && (normalizedUsage.prompt_tokens || normalizedUsage.completion_tokens)) {
      normalizedUsage.total_tokens = normalizedUsage.prompt_tokens + normalizedUsage.completion_tokens;
    }

    return {
      content: String(raw.content ?? ''),
      reasoning: String(raw.reasoning ?? ''),
      model: String(raw.model ?? this.name),
      usage: normalizedUsage,
      stopped: raw.stopped === true,
      context_length: raw.context_length,
    };
  }

  /**
   * Record model discovery results.
   */
  protected _recordModelDiscovery(models: string[], meta?: Partial<ModelDiscoveryMeta>): string[] {
    this._cachedModels = models;
    this._discoveryMeta = {
      ok: models.length > 0,
      source: meta?.source || this.name,
      authoritative: meta?.authoritative ?? true,
      error: meta?.error ?? null,
      count: models.length,
      at: new Date().toISOString(),
    };
    return models;
  }
}
