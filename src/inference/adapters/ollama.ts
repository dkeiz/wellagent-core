// ---------------------------------------------------------------------------
// lib/inference/adapters/ollama.ts — Ollama provider adapter
// ---------------------------------------------------------------------------

import { Provider, type ProviderCallOptions } from '../provider';
import type { LLMResponse, Message, SettingsStore, Logger } from '../../core/types';

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';

/**
 * Ollama provider adapter.
 *
 * Connects to a local or remote Ollama instance via its REST API.
 *
 * Usage:
 * ```typescript
 * const ollama = new OllamaAdapter(db, { baseUrl: 'http://localhost:11434' });
 * const models = await ollama.getModels();
 * const response = await ollama.call(messages, { model: 'llama3' });
 * ```
 */
export class OllamaAdapter extends Provider {
  private _baseUrl: string;
  private _defaultModel: string;

  constructor(db: SettingsStore, options: { baseUrl?: string; model?: string; logger?: Logger } = {}) {
    super('ollama', db, options);
    const envHost = typeof process !== 'undefined' ? process.env?.OLLAMA_HOST : undefined;
    this._baseUrl = options.baseUrl || (envHost ? `http://${envHost}` : DEFAULT_BASE_URL);
    this._defaultModel = options.model || 'llama3';
  }

  async call(messages: Message[], options: ProviderCallOptions = {}): Promise<LLMResponse> {
    const model = options.model || this._defaultModel;
    const { requestId, signal } = this._startRequest(options.requestId);

    try {
      const body: any = {
        model,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        stream: false,
        options: {},
      };

      if (options.temperature !== undefined) body.options.temperature = options.temperature;
      if (options.maxTokens !== undefined) body.options.num_predict = options.maxTokens;
      if (options.contextWindow !== undefined) body.options.num_ctx = options.contextWindow;

      const response = await fetch(`${this._baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => response.statusText);
        throw new Error(`Ollama API error ${response.status}: ${errorText}`);
      }

      const data: any = await response.json();

      return this._normalizeResponse({
        content: data.message?.content || '',
        reasoning: '',
        model: data.model || model,
        usage: {
          prompt_tokens: data.prompt_eval_count || 0,
          completion_tokens: data.eval_count || 0,
          total_tokens: (data.prompt_eval_count || 0) + (data.eval_count || 0),
          cached_tokens: 0,
          cache_write_tokens: 0,
        },
        stopped: data.done === true,
        context_length: data.context_length,
      });
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        return this._normalizeResponse({ content: '', stopped: true, model });
      }
      throw error;
    } finally {
      this._endRequest(requestId);
    }
  }

  async getModels(forceRefresh: boolean = false): Promise<string[]> {
    if (!forceRefresh && this._cachedModels.length > 0) {
      return this._cachedModels;
    }

    try {
      const response = await fetch(`${this._baseUrl}/api/tags`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data: any = await response.json();
      const models = (data.models || []).map((m: any) => m.name || m.model);
      return this._recordModelDiscovery(models, { source: 'ollama-api' });
    } catch (error: any) {
      this._recordModelDiscovery([], { error: error?.message });
      return [];
    }
  }

  /**
   * Check if Ollama is reachable.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this._baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
