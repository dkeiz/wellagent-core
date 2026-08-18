// ---------------------------------------------------------------------------
// lib/inference/adapters/openai-compatible.ts — Full OpenAI-compatible adapter
// ---------------------------------------------------------------------------

import { Provider, type ProviderCallOptions } from '../provider';
import type { LLMResponse, Message, SettingsStore, Logger } from '../../core/types';

const REQUEST_TIMEOUT_MS = 120000;
const MODEL_LIST_TIMEOUT_MS = 15000;
const RESERVED_OVERRIDE_KEYS = new Set(['model', 'messages', 'stream']);

/** Extended options for the OpenAI-compatible adapter. */
export interface OpenAIAdapterOptions {
  name?: string;
  /** Label shown in logs / UI. */
  label?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  /** API path prefix (e.g. '/v1'). Auto-appended if not already in baseUrl. */
  apiPrefix?: string;
  /** Whether API key is optional (e.g. for local servers). */
  apiKeyOptional?: boolean;
  /** Additional headers to include in every request. */
  defaultHeaders?: Record<string, string>;
  /** Settings key for storing API key. */
  apiKeySettingPath?: string;
  logger?: Logger;
}

/**
 * OpenAI-compatible provider adapter.
 *
 * Works with any API that implements the OpenAI chat completions format:
 * OpenAI, Groq, DeepSeek, Mistral, Together, local vLLM, Anthropic, etc.
 *
 * Features:
 * - Anthropic Messages API auto-detection and preprocessing
 * - Reasoning extraction (OpenAI, DeepSeek, Anthropic thinking blocks)
 * - Thinking mode injection
 * - Reasoning effort control (OpenAI o-series)
 * - Prompt cache hints (OpenAI)
 * - Request overrides passthrough
 * - Local-OpenAI CLI parameter parsing
 * - Multi-format content coercion (string, array, content blocks)
 * - Request lifecycle management (abort, timeout)
 *
 * Usage:
 * ```typescript
 * const provider = new OpenAICompatibleAdapter(db, {
 *   name: 'groq',
 *   baseUrl: 'https://api.groq.com/openai/v1',
 *   apiKey: 'gsk_...',
 *   model: 'llama-3.1-70b',
 * });
 * const response = await provider.call([{ role: 'user', content: 'Hello' }]);
 * ```
 */
export class OpenAICompatibleAdapter extends Provider {
  private _baseUrl: string;
  private _apiKey: string;
  private _defaultModel: string;
  private _apiKeySettingPath: string;
  private _apiPrefix: string;
  private _apiKeyOptional: boolean;
  private _defaultHeaders: Record<string, string>;
  private _label: string;

  constructor(db: SettingsStore, options: OpenAIAdapterOptions = {}) {
    super(options.name || 'openai-compatible', db, options);
    this._baseUrl = (options.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    this._apiKey = options.apiKey || '';
    this._defaultModel = options.model || 'gpt-4o-mini';
    this._apiKeySettingPath = options.apiKeySettingPath || `llm.${this.name}.apiKey`;
    this._apiPrefix = options.apiPrefix || '';
    this._apiKeyOptional = options.apiKeyOptional === true;
    this._defaultHeaders = options.defaultHeaders || {};
    this._label = options.label || this.name;
  }

  // ---- Main API ----

  async call(messages: Message[], options: ProviderCallOptions = {}): Promise<LLMResponse> {
    const model = options.model || this._defaultModel;
    const apiKey = await this._resolveApiKey(options);
    const { requestId, signal } = this._startRequest(options.requestId);

    const reasoningCaps = (options as any).modelSpec?.capabilities?.reasoning || {};
    const runtimeConfig = (options as any).runtimeConfig || {};

    // Apply thinking mode to messages
    const processedMessages = this._applyThinkingMode(
      messages, options.thinkingMode, runtimeConfig, reasoningCaps
    );

    const body: any = {
      model,
      messages: processedMessages.map(m => ({
        role: m.role,
        content: m.content,
        ...(m.name ? { name: m.name } : {}),
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      })),
      stream: false,
    };

    // Temperature
    if (options.temperature !== undefined) body.temperature = options.temperature;
    else body.temperature = 0.7;

    // Max tokens — DO NOT hardcode a default, let the API decide
    if (options.maxTokens != null) body.max_tokens = options.maxTokens;

    // Prompt cache hint (OpenAI)
    this._applyPromptCacheHint(body, (options as any).promptCache);

    // Reasoning effort (OpenAI o-series)
    this._applyReasoningConfig(body, runtimeConfig, reasoningCaps);

    // Request overrides passthrough
    this._applyRequestOverrides(body, runtimeConfig.requestOverrides);

    // Local-OpenAI CLI params
    if (this.name === 'local-openai') {
      await this._applyLocalParams(body, options);
    }

    // Anthropic preprocessing
    const isAnthropic = this.name === 'anthropic';
    if (isAnthropic) {
      this._preprocessForAnthropic(body);
    }

    const endpointPath = isAnthropic ? '/messages' : '/chat/completions';

    try {
      const response = await fetch(this._buildEndpoint(endpointPath), {
        method: 'POST',
        headers: await this._buildHeaders(apiKey, isAnthropic),
        body: JSON.stringify(body),
        signal: signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => response.statusText);
        throw new Error(`${this._label} API error ${response.status}: ${errorText}`);
      }

      const data: any = await response.json();
      let content = '';
      let reasoning = '';
      let usage = data.usage;

      if (isAnthropic) {
        // Anthropic content blocks format
        const blocks = data.content || [];
        content = blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
        reasoning = blocks.filter((b: any) => b.type === 'thinking').map((b: any) => b.thinking || b.text || '').join('\n').trim();

        if (usage) {
          usage = {
            prompt_tokens: usage.input_tokens || 0,
            completion_tokens: usage.output_tokens || 0,
            total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
            cached_tokens: usage.cache_read_input_tokens || 0,
            cache_write_tokens: usage.cache_creation_input_tokens || 0,
          };
        }
      } else {
        // OpenAI format
        const message = data.choices?.[0]?.message || {};
        content = this._coerceContent(message.content);
        reasoning = this._extractReasoning(message, data);
      }

      return this._normalizeResponse({
        content,
        reasoning,
        model: data.model || model,
        usage,
        stopped: data.choices?.[0]?.finish_reason === 'stop',
        context_length: runtimeConfig.contextWindow?.value || (options as any).modelSpec?.runtime?.contextWindow?.value,
      });
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        return this._normalizeResponse({ content: '[Generation stopped by user]', stopped: true, model });
      }
      throw error;
    } finally {
      this._endRequest(requestId);
    }
  }

  async getModels(forceRefresh: boolean = false, options: any = {}): Promise<string[]> {
    if (!forceRefresh && this._cachedModels.length > 0) {
      return this._cachedModels;
    }

    try {
      const apiKey = await this._resolveApiKey(options);
      const headers: Record<string, string> = { ...this._defaultHeaders };
      if (apiKey) {
        if (this.name === 'anthropic') {
          headers['x-api-key'] = apiKey;
        } else {
          headers['Authorization'] = `Bearer ${apiKey}`;
        }
      }

      const response = await fetch(this._buildEndpoint('/models'), {
        headers,
        signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data: any = await response.json();
      const models = this._extractModelIds(data);
      return this._recordModelDiscovery(models, { source: `${this._label}-api` });
    } catch (error: any) {
      this._logger.warn?.(`[${this._label}] Failed to fetch models:`, error?.message);
      this._recordModelDiscovery([], { error: error?.message });
      return [];
    }
  }

  // ---- Reasoning extraction ----

  /**
   * Extract reasoning/thinking from various response formats:
   * - message.reasoning (DeepSeek)
   * - message.reasoning_content (OpenAI o-series)
   * - message.content[].type === 'reasoning' (array-format)
   * - choices[0].reasoning (some providers)
   * - payload.output[].type === 'reasoning' (Responses API)
   */
  private _extractReasoning(message: any, payload: any): string {
    if (typeof message.reasoning === 'string' && message.reasoning.trim()) {
      return message.reasoning.trim();
    }
    if (typeof message.reasoning_content === 'string' && message.reasoning_content.trim()) {
      return message.reasoning_content.trim();
    }

    // Array-format content with reasoning blocks
    if (Array.isArray(message.content)) {
      const parts = message.content
        .filter((p: any) => p?.type === 'reasoning')
        .map((p: any) => p.reasoning || p.text || p.content || '')
        .filter(Boolean)
        .join('\n')
        .trim();
      if (parts) return parts;
    }

    // Choices-level reasoning
    const choiceReasoning = payload?.choices?.[0]?.reasoning;
    if (typeof choiceReasoning === 'string' && choiceReasoning.trim()) {
      return choiceReasoning.trim();
    }

    // Top-level reasoning fields
    for (const field of ['reasoning_content', 'reasoning']) {
      if (typeof payload?.[field] === 'string' && payload[field].trim()) {
        return payload[field].trim();
      }
    }

    // Responses API output array
    if (Array.isArray(payload?.output)) {
      const outputReasoning = payload.output
        .map((item: any) => {
          if (item?.type === 'reasoning') return item.summary || item.text || item.content || item.reasoning || '';
          return item?.reasoning || item?.reasoning_content || '';
        })
        .filter(Boolean)
        .join('\n')
        .trim();
      if (outputReasoning) return outputReasoning;
    }

    return '';
  }

  /**
   * Coerce content from string or array format.
   */
  private _coerceContent(value: any): string {
    if (typeof value === 'string') return value;
    if (!Array.isArray(value)) return '';
    return value
      .map((part: any) => {
        if (typeof part === 'string') return part;
        return part?.text || part?.content || '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  // ---- Thinking mode ----

  /**
   * Apply thinking mode instructions to messages.
   */
  private _applyThinkingMode(
    messages: Message[],
    thinkingMode: string | undefined,
    runtimeConfig: any,
    reasoningCaps: any
  ): Message[] {
    if (!thinkingMode || thinkingMode === 'off') return messages;
    if (!reasoningCaps.supported) return messages;
    // Skip if using native reasoning_effort parameter
    if (reasoningCaps.parameterMode === 'openai_reasoning_effort') return messages;

    const result = [...messages];
    let hint: string;

    if (runtimeConfig.reasoning?.visibility === 'hide') {
      hint = 'Reason internally if needed, but do not reveal chain-of-thought or thinking tags in the final answer.';
    } else {
      hint = thinkingMode === 'think'
        ? 'Show concise reasoning before the final answer when the model supports it.'
        : 'Give the answer directly without exposed reasoning unless it is strictly required.';
    }

    if (result.length > 0 && result[0].role === 'system') {
      result[0] = { ...result[0], content: `${result[0].content}\n\n${hint}` };
    } else {
      result.unshift({ role: 'system', content: hint });
    }

    return result;
  }

  // ---- Reasoning effort (OpenAI o-series) ----

  private _applyReasoningConfig(body: any, runtimeConfig: any, reasoningCaps: any): void {
    if (!reasoningCaps.supported) return;
    if (reasoningCaps.parameterMode !== 'openai_reasoning_effort') return;

    const levels: string[] = Array.isArray(reasoningCaps.effortLevels) ? reasoningCaps.effortLevels : [];
    if (levels.length === 0) return;

    const desired = runtimeConfig.reasoning?.enabled
      ? runtimeConfig.reasoning?.effort
      : (levels.includes('minimal') ? 'minimal' : levels[0]);

    body.reasoning_effort = levels.includes(desired) ? desired : levels[0];
  }

  // ---- Prompt cache ----

  private _applyPromptCacheHint(body: any, promptCache: any): void {
    if (!promptCache?.enabled) return;
    const key = String(promptCache.key || '').trim();
    if (this.name !== 'openai' || !key) return;

    body.prompt_cache_key = key.slice(0, 512);
    if (promptCache.retention === '24h') {
      body.prompt_cache_retention = '24h';
    }
  }

  // ---- Request overrides ----

  private _applyRequestOverrides(body: any, overrides: any): void {
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return;
    for (const [key, value] of Object.entries(overrides)) {
      if (RESERVED_OVERRIDE_KEYS.has(key)) continue;
      body[key] = value;
    }
  }

  // ---- Anthropic preprocessing ----

  /**
   * Converts OpenAI-format request to Anthropic Messages API format:
   * - System messages → top-level `system` field
   * - Ensures max_tokens is set (required by Anthropic)
   * - Clamps temperature to [0, 1]
   */
  private _preprocessForAnthropic(body: any): void {
    const messages: any[] = body.messages || [];
    const systemMessages: string[] = [];
    const nonSystemMessages: any[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemMessages.push(msg.content || '');
      } else {
        nonSystemMessages.push(msg);
      }
    }

    if (systemMessages.length > 0) {
      body.system = systemMessages.join('\n\n');
    }
    body.messages = nonSystemMessages;

    // Anthropic requires max_tokens
    if (body.max_tokens == null) body.max_tokens = 8192;

    // Clamp temperature to [0, 1]
    if (body.temperature != null) {
      body.temperature = Math.min(1, Math.max(0, body.temperature));
    }
  }

  // ---- Local-OpenAI CLI params ----

  private async _applyLocalParams(body: any, options: any): Promise<void> {
    const modelParamsRaw = await this._getSetting(`llm.${this.name}.modelParams`, options);
    const parsed = this._parseCliArgs(modelParamsRaw);

    const numericKeys = ['temperature', 'top_p', 'top_k', 'presence_penalty', 'frequency_penalty', 'max_tokens', 'min_tokens', 'seed', 'n'];
    for (const key of numericKeys) {
      if (parsed[key] !== undefined) {
        const val = Number(parsed[key]);
        if (Number.isFinite(val)) body[key] = val;
      }
    }

    // Pass through unknown params
    for (const [key, value] of Object.entries(parsed)) {
      if (key === 'model' || key === 'url' || key === 'base_url' || key === 'api_key') continue;
      if (body[key] !== undefined) continue;
      body[key] = value;
    }
  }

  private _parseCliArgs(raw: any): Record<string, any> {
    const input = String(raw || '').trim();
    if (!input) return {};

    const result: Record<string, any> = {};
    const tokens = input.match(/"[^"]*"|'[^']*'|\S+/g) || [];

    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (!t.startsWith('-')) continue;

      const eqIdx = t.indexOf('=');
      if (eqIdx > 0) {
        const key = t.slice(0, eqIdx).replace(/^-+/, '').replace(/-/g, '_').toLowerCase();
        result[key] = t.slice(eqIdx + 1).replace(/^['"]|['"]$/g, '');
      } else {
        const key = t.replace(/^-+/, '').replace(/-/g, '_').toLowerCase();
        const next = tokens[i + 1];
        if (next && !next.startsWith('-')) {
          result[key] = next.replace(/^['"]|['"]$/g, '');
          i++;
        } else {
          result[key] = true;
        }
      }
    }
    return result;
  }

  // ---- Helpers ----

  private async _resolveApiKey(options: any = {}): Promise<string> {
    if (this._apiKey) return this._apiKey;
    const stored = await this._getSetting(this._apiKeySettingPath, options);
    if (stored) return stored;
    // Try alternate key path
    const altKey = await this._getSetting(`llm.${this.name}.apiKey`, options);
    return altKey || '';
  }

  private async _buildHeaders(apiKey: string, isAnthropic: boolean): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this._defaultHeaders,
    };

    if (apiKey) {
      if (isAnthropic) {
        headers['x-api-key'] = apiKey;
      } else {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }
    } else if (!this._apiKeyOptional) {
      throw new Error(`${this._label} API key not configured`);
    }

    return headers;
  }

  private _buildEndpoint(pathName: string): string {
    let base = this._baseUrl;
    if (!base) throw new Error(`${this._label} base URL is not configured`);

    if (this._apiPrefix && !base.toLowerCase().endsWith(this._apiPrefix.toLowerCase())) {
      base = `${base}${this._apiPrefix}`;
    }

    return `${base}${pathName}`;
  }

  /**
   * Extract model IDs from various response formats.
   */
  private _extractModelIds(payload: any): string[] {
    const raw: any[] = Array.isArray(payload?.data)
      ? payload.data
      : (Array.isArray(payload?.models) ? payload.models : []);

    return Array.from(new Set(
      raw.map((entry: any) => {
        if (typeof entry === 'string') return entry;
        return entry?.id || entry?.name || entry?.model;
      })
      .filter(Boolean)
      .map(String)
    ));
  }
}
