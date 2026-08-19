// @ts-nocheck
const BaseAdapter = require('./base-adapter');
const { isProviderRequestCanceled, providerRequest } = require('./provider-http');
const { applyOllamaImageInput } = require('./attachment-input');
const { consumeNdjson } = require('./provider-stream');
const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
const REQUEST_TIMEOUT_MS = 120000;

/**
 * OllamaAdapter — Ollama local + cloud model support.
 *
 * Uses /api/chat for inference, /api/tags for model listing.
 * Supports AbortController, context window (num_ctx), and thinking mode.
 */
class OllamaAdapter extends BaseAdapter {
    constructor(db) {
        super('ollama', db);
        this._modelContextWindows = new Map();
    }

    prepareMessagesForEstimate(messages, options = {}) {
        return this._applyThinkingMode(
            messages,
            options.thinkingMode,
            options.modelSpec?.capabilities?.reasoning || {},
            options.runtimeConfig || {}
        );
    }

    async call(messages, options = {}) {
        const { requestId, signal } = this._startRequest();
        const runtimeConfig = options.runtimeConfig || {};
        let contextLength = runtimeConfig.contextWindow?.value || options.modelSpec?.runtime?.contextWindow?.value || 8192;

        // If the user has not explicitly configured a context window for this model,
        // discover the model's real context length via /api/show instead of silently
        // sending the tiny 8192 default (which makes Ollama truncate older turns).
        if (!(await this._isContextWindowConfigured(options))) {
            const discovered = await this.getModelContextWindow(options.model, options);
            if (discovered && discovered > contextLength) contextLength = discovered;
        }

        // Apply thinking mode if set
        const processedMessages = applyOllamaImageInput(this._applyThinkingMode(
            messages,
            options.thinkingMode,
            options.modelSpec?.capabilities?.reasoning || {},
            runtimeConfig
        ), options.attachments);

        const streamEnabled = Boolean(options.turnEvents?.emit);
        const requestBody = {
            model: options.model,
            messages: processedMessages,
            stream: streamEnabled,
            options: {
                temperature: options.temperature ?? 0.7,
                top_p: options.top_p ?? 0.9,
                num_ctx: contextLength
            }
        };
        if (Array.isArray(options.tools) && options.tools.length > 0) {
            requestBody.tools = options.tools;
        }
        const requestedTokens = Number(options.max_tokens || options.num_predict);
        if (Number.isFinite(requestedTokens) && requestedTokens > 0) {
            requestBody.options.num_predict = Math.ceil(requestedTokens);
        }

        console.log(`[Ollama] model=${options.model} num_ctx=${contextLength}`);

        try {
            const baseURL = await this._getBaseURL(options);
            const response = await providerRequest({
                method: 'post',
                url: `${baseURL}/api/chat`,
                data: requestBody,
                ...(streamEnabled ? { responseType: 'stream' } : {}),
                signal,
                headers: await this._getHeaders(options)
            }, { timeoutMs: REQUEST_TIMEOUT_MS, label: 'Ollama generation' });

            if (streamEnabled) {
                let content = '';
                let reasoning = '';
                let last = {};
                let toolCalls = [];
                options.turnEvents.emit({ type: 'status', phase: 'responding', message: 'Ollama is responding' });
                await consumeNdjson(response.data, (payload) => {
                    last = payload || last;
                    const message = payload?.message || {};
                    const text = this._coerceContent(message.content);
                    const thought = this._coerceContent(message.reasoning_content || message.reasoning || message.thinking);
                    if (text) {
                        content += text;
                        options.turnEvents.emit({ type: 'content.delta', text });
                    }
                    if (thought) {
                        reasoning += thought;
                        options.turnEvents.emit({ type: 'reasoning.delta', text: thought });
                    }
                    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
                        toolCalls = message.tool_calls;
                        message.tool_calls.forEach((call, index) => options.turnEvents.emit({
                            type: 'action.started',
                            action: {
                                id: call.id || `ollama-tool-${index}`,
                                kind: 'tool',
                                name: call.function?.name || call.name || 'tool',
                                params: call.function?.arguments || call.arguments || {},
                                status: 'running'
                            }
                        }));
                    }
                    if (payload?.done) {
                        options.turnEvents.emit({
                            type: 'usage.updated',
                            usage: this._extractUsage(payload)
                        });
                    }
                });
                this._endRequest(requestId);
                return this._normalizeResponse({
                    content,
                    reasoning,
                    toolCalls,
                    model: last.model || options.model,
                    context_length: contextLength,
                    usage: this._extractUsage(last)
                });
            }

            this._endRequest(requestId);
            const message = response.data?.message || {};
            const content = this._coerceContent(message.content);
            const reasoning = this._coerceContent(
                message.reasoning_content
                || message.reasoning
                || message.thinking
                || response.data?.reasoning_content
                || response.data?.reasoning
                || response.data?.thinking
            );
            const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

            return this._normalizeResponse({
                content,
                reasoning,
                toolCalls,
                model: response.data.model,
                context_length: contextLength,
                usage: this._extractUsage(response.data)
            });
        } catch (error) {
            this._endRequest(requestId);

            if (isProviderRequestCanceled(error)) {
                return this._normalizeResponse({
                    content: '[Generation stopped by user]',
                    model: options.model,
                    stopped: true
                });
            }
            throw error;
        }
    }

    async getModels(forceRefresh = false, options = {}) {
        try {
            const baseURL = await this._getBaseURL(options);
            const response = await providerRequest({
                method: 'get',
                url: `${baseURL}/api/tags`,
                headers: await this._getHeaders(options)
            }, { timeoutMs: 15000, label: 'Ollama model list' });
            const models = (Array.isArray(response.data?.models) ? response.data.models : [])
                .map(entry => String(entry?.name || '').trim())
                .filter(Boolean);
            this._recordModelDiscovery({
                ok: true,
                source: 'remote',
                authoritative: true,
                models
            });
            return models;
        } catch (error) {
            console.error('[Ollama] Failed to fetch models:', error.message);
            this._recordModelDiscovery({
                ok: false,
                source: 'remote',
                authoritative: true,
                error: error.message,
                models: []
            });
            return [];
        }
    }

    async getModelContextWindow(model, options = {}) {
        const modelId = String(model || '').trim();
        if (!modelId) return null;
        const cacheKey = modelId.toLowerCase();
        const cached = this._modelContextWindows.get(cacheKey);
        if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.value;

        try {
            const baseURL = await this._getBaseURL(options);
            const response = await providerRequest({
                method: 'post',
                url: `${baseURL}/api/show`,
                data: { model: modelId, name: modelId },
                headers: await this._getHeaders(options)
            }, { timeoutMs: 8000, label: 'Ollama model details' });
            const info = response.data?.model_info || {};
            let contextLength = 0;
            for (const [key, value] of Object.entries(info)) {
                if (String(key).endsWith('.context_length')) {
                    const parsed = Number(value);
                    if (Number.isFinite(parsed) && parsed > contextLength) contextLength = parsed;
                }
            }
            if (contextLength > 0) {
                this._modelContextWindows.set(cacheKey, { value: contextLength, at: Date.now() });
                return contextLength;
            }
            return null;
        } catch (error) {
            console.warn(`[Ollama] Failed to discover context length for ${modelId}: ${error.message}`);
            return null;
        }
    }

    async _isContextWindowConfigured(options = {}) {
        const model = String(options.model || '').trim();
        if (!model) return false;
        try {
            const { getStoredModelOverrides, getOverrideKey } = require('../llm-config');
            const overrides = await getStoredModelOverrides(this.db, options);
            const key = getOverrideKey('ollama', model);
            const stored = overrides[key];
            return Boolean(stored && Object.prototype.hasOwnProperty.call(stored, 'contextWindow'));
        } catch (_) {
            return false;
        }
    }

    async _getBaseURL(options = {}) {
        const stored = await this._getSetting('llm.ollama.url', options);
        const envHost = process.env.OLLAMA_HOST || '';
        const envURL = /^https?:\/\//i.test(envHost) ? envHost : (envHost ? `http://${envHost}` : '');
        return this._normalizeBaseURL(stored || envURL || DEFAULT_OLLAMA_URL);
    }

    async _getHeaders(options = {}) {
        const apiKey = await this.db.getAPIKey('ollama', options) || await this._getSetting('llm.ollama.apiKey', options);
        const headers = { 'Content-Type': 'application/json' };
        if (apiKey) {
            headers.Authorization = `Bearer ${apiKey}`;
        }
        return headers;
    }

    _extractUsage(payload = {}) {
        const promptTokens = Number(payload?.prompt_eval_count);
        const completionTokens = Number(payload?.eval_count);
        const hasPromptTokens = Number.isFinite(promptTokens) && promptTokens > 0;
        const hasCompletionTokens = Number.isFinite(completionTokens) && completionTokens > 0;
        return {
            prompt_tokens: hasPromptTokens ? promptTokens : 0,
            completion_tokens: hasCompletionTokens ? completionTokens : 0,
            total_tokens: hasPromptTokens
                ? promptTokens + (hasCompletionTokens ? completionTokens : 0)
                : 0
        };
    }

    _normalizeBaseURL(url) {
        const raw = String(url || '').trim();
        if (!raw) return DEFAULT_OLLAMA_URL;
        const withProtocol = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
        return withProtocol.replace(/\/+$/, '');
    }

    /**
     * Apply thinking mode for Qwen3/DeepSeek-style models.
     * Prepends /think or /nothink to the last user message.
     */
    _applyThinkingMode(messages, thinkingMode, reasoningCaps = {}, runtimeConfig = {}) {
        if (!thinkingMode || thinkingMode === 'off') return messages;
        if (!reasoningCaps.supported) return messages;

        const result = [...messages];
        if (reasoningCaps.parameterMode === 'prompt_hint') {
            const effort = runtimeConfig?.reasoning?.effort;
            const effortText = effort ? ` Target reasoning effort: ${effort}.` : '';
            const hint = runtimeConfig?.reasoning?.visibility === 'hide'
                ? 'Reason internally if needed, but do not expose chain-of-thought in the final answer.'
                : (thinkingMode === 'think'
                    ? `Show concise reasoning before the final answer when the model supports it.${effortText}`
                    : 'Give the answer directly without exposed reasoning unless strictly required.');
            if (result.length > 0 && result[0].role === 'system') {
                result[0] = { ...result[0], content: `${result[0].content}\n\n${hint}` };
            } else {
                result.unshift({ role: 'system', content: hint });
            }
            return result;
        }

        // Default Ollama reasoning control uses slash directives.
        for (let i = result.length - 1; i >= 0; i--) {
            if (result[i].role === 'user') {
                const prefix = thinkingMode === 'think' ? '/think\n' : '/nothink\n';
                result[i] = { ...result[i], content: prefix + result[i].content };
                break;
            }
        }
        return result;
    }

    _coerceContent(value) {
        if (typeof value === 'string') return value;
        if (!Array.isArray(value)) return '';

        return value
            .map(part => {
                if (typeof part === 'string') return part;
                return part?.text || part?.content || part?.reasoning || '';
            })
            .filter(Boolean)
            .join('\n')
            .trim();
    }
}

module.exports = OllamaAdapter;
