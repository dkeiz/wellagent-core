// @ts-nocheck
const BaseAdapter = require('./base-adapter');
const { isProviderRequestCanceled, providerRequest } = require('./provider-http');
const { applyOpenAIImageInput } = require('./attachment-input');
const { consumeSse, createOpenAIAccumulator } = require('./provider-stream');

const REQUEST_TIMEOUT_MS = 120000;
const MODEL_LIST_TIMEOUT_MS = 15000;

/**
 * LMStudioAdapter — LM Studio local server (OpenAI-compatible API).
 *
 * Uses /v1/chat/completions for inference, /v1/models for listing.
 * Supports thinking mode via <think> tags.
 */
class LMStudioAdapter extends BaseAdapter {
    constructor(db, options = {}) {
        super('lmstudio', db);
        this.baseURL = 'http://localhost:1234';
        this._appliedLoadConfig = new Map();
        this._onSoftAlert = typeof options.onSoftAlert === 'function' ? options.onSoftAlert : null;
        this._softAlertCache = new Set();
    }

    prepareMessagesForEstimate(messages, options = {}) {
        return this._applyThinkingMode(
            messages,
            options.thinkingMode,
            options.runtimeConfig || {},
            options.modelSpec?.capabilities?.reasoning || {}
        );
    }

    async call(messages, options = {}) {
        const { requestId, signal } = this._startRequest();

        // Load custom URL if saved
        const savedURL = await this._getSetting('llm.lmstudio.url', options);
        const url = savedURL || this.baseURL;

        // Apply thinking mode via system prompt hint
        const processedMessages = applyOpenAIImageInput(this._applyThinkingMode(
            messages,
            options.thinkingMode,
            options.runtimeConfig || {},
            options.modelSpec?.capabilities?.reasoning || {}
        ), options.attachments);

        const streamEnabled = Boolean(options.turnEvents?.emit);
        const requestBody = {
            model: options.model || '',
            messages: processedMessages,
            temperature: options.temperature ?? 0.7,
            stream: streamEnabled
        };
        if (streamEnabled) requestBody.stream_options = { include_usage: true };
        // CRITICAL WARNING: DO NOT hardcode a default max_tokens (like 1000 or -1) here or anywhere in this adapter!
        // Capping output tokens by default restricts the model output length and truncates responses.
        // Let the API provider / model config decide output limits by default unless options.max_tokens is explicitly provided.
        if (options.max_tokens != null) {
            requestBody.max_tokens = options.max_tokens;
        }

        const requestOverrides = options.runtimeConfig?.requestOverrides;
        if (requestOverrides && typeof requestOverrides === 'object' && !Array.isArray(requestOverrides)) {
            Object.entries(requestOverrides).forEach(([key, value]) => {
                if (key === 'model' || key === 'messages' || key === 'stream') return;
                requestBody[key] = value;
            });
        }

        try {
            await this._ensureModelLoadConfig(url, options.model, options.runtimeConfig || {}, options.modelSpec || {}, options);
            const response = await providerRequest({
                method: 'post',
                url: this._buildEndpoint(url, '/chat/completions'),
                data: requestBody,
                ...(streamEnabled ? { responseType: 'stream' } : {}),
                signal,
                headers: await this._getHeaders(options)
            }, { timeoutMs: REQUEST_TIMEOUT_MS, label: 'LM Studio generation' });

            if (streamEnabled) {
                const accumulator = createOpenAIAccumulator(options.turnEvents);
                options.turnEvents.emit({ type: 'status', phase: 'responding', message: 'LM Studio is responding' });
                await consumeSse(response.data, payload => accumulator.push(payload));
                this._endRequest(requestId);
                const streamed = accumulator.result();
                const split = this.splitInlineReasoning(streamed.content, streamed.reasoning);
                return this._normalizeResponse({
                    content: split.content,
                    reasoning: split.reasoning,
                    toolCalls: streamed.toolCalls,
                    model: streamed.model || options.model,
                    usage: streamed.usage,
                    context_length: options.runtimeConfig?.contextWindow?.value || options.modelSpec?.runtime?.contextWindow?.value
                });
            }

            this._endRequest(requestId);
            const message = response.data?.choices?.[0]?.message || {};
            const content = this._coerceContent(message.content);
            const reasoning = this._extractReasoning(message, response.data);
            const split = this.splitInlineReasoning(content, reasoning);

            const normalized = this._normalizeResponse({
                content: split.content,
                reasoning: split.reasoning,
                model: response.data.model,
                usage: response.data.usage,
                context_length: options.runtimeConfig?.contextWindow?.value || options.modelSpec?.runtime?.contextWindow?.value
            });
            const stats = response?.data?.stats || {};
            const tps = Number(stats.tokensPerSecond ?? stats.tokens_per_second ?? response?.data?.tokensPerSecond ?? response?.data?.tokens_per_second);
            if (Number.isFinite(tps) && tps > 0) {
                normalized.tokens_per_second = tps;
            }
            return normalized;
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
            const savedURL = await this._getSetting('llm.lmstudio.url', options);
            const url = savedURL || this.baseURL;
            const response = await providerRequest({
                method: 'get',
                url: this._buildEndpoint(url, '/models'),
                headers: await this._getHeaders(options)
            }, { timeoutMs: MODEL_LIST_TIMEOUT_MS, label: 'LM Studio model list' });

            const payload = response.data || {};
            const rawModels = Array.isArray(payload?.data)
                ? payload.data
                : (Array.isArray(payload?.models) ? payload.models : []);

            const models = rawModels
                .map(model => {
                    if (typeof model === 'string') return model.trim();
                    return String(model?.id || model?.name || '').trim();
                })
                .filter(Boolean);

            this._recordModelDiscovery({
                ok: true,
                source: 'remote',
                authoritative: true,
                models
            });
            return models;
        } catch (error) {
            console.error('[LMStudio] Failed to fetch models:', error.message);
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

    _buildNativeApiEndpoint(baseUrl, endpointPath) {
        const rawBase = String(baseUrl || '').trim() || this.baseURL;
        const rawPath = String(endpointPath || '').trim();
        const normalizedPath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;

        let parsed;
        try {
            parsed = new URL(rawBase);
            if (parsed.hostname === 'localhost') {
                parsed.hostname = '127.0.0.1';
            }
        } catch (_) {
            const fallback = rawBase.replace(/\/+$/, '');
            return `${fallback}/api/v1${normalizedPath}`;
        }

        const pathname = (parsed.pathname || '/').replace(/\/+$/, '') || '/';
        const basePath = pathname.endsWith('/v1')
            ? pathname.slice(0, -3) || '/'
            : pathname;
        const trimmedBase = basePath.replace(/\/+$/, '');
        parsed.pathname = `${trimmedBase === '' || trimmedBase === '/' ? '' : trimmedBase}/api/v1${normalizedPath}`;
        return parsed.toString();
    }

    _extractLoadConfig(runtimeConfig = {}, modelSpec = {}) {
        const loadConfig = runtimeConfig?.lmstudio?.loadConfig;
        const scopedLoadConfig = (loadConfig && typeof loadConfig === 'object' && !Array.isArray(loadConfig))
            ? loadConfig
            : {};
        const out = {};
        if (typeof scopedLoadConfig.flash_attention === 'boolean') out.flash_attention = scopedLoadConfig.flash_attention;
        const contextCandidate = scopedLoadConfig.context_length
            ?? runtimeConfig?.contextWindow?.value
            ?? modelSpec?.runtime?.contextWindow?.value;
        const contextLength = Number.parseInt(contextCandidate, 10);
        if (Number.isFinite(contextLength) && contextLength > 0) out.context_length = contextLength;
        if (Number.isFinite(scopedLoadConfig.eval_batch_size)) out.eval_batch_size = Number(scopedLoadConfig.eval_batch_size);
        if (Number.isFinite(scopedLoadConfig.num_experts)) out.num_experts = Number(scopedLoadConfig.num_experts);
        if (typeof scopedLoadConfig.offload_kv_cache_to_gpu === 'boolean') out.offload_kv_cache_to_gpu = scopedLoadConfig.offload_kv_cache_to_gpu;
        return Object.keys(out).length ? out : null;
    }

    async _ensureModelLoadConfig(baseUrl, model, runtimeConfig = {}, modelSpec = {}, options = {}) {
        const modelId = String(model || '').trim();
        if (!modelId) return;
        const loadConfig = this._extractLoadConfig(runtimeConfig, modelSpec);
        if (!loadConfig) return;

        const cacheKey = modelId.toLowerCase();
        const signature = JSON.stringify(loadConfig);
        if (this._appliedLoadConfig.get(cacheKey) === signature) return;

        const payload = {
            model: modelId,
            ...loadConfig,
            echo_load_config: true
        };
        const endpoint = this._buildNativeApiEndpoint(baseUrl, '/models/load');
        try {
            const response = await providerRequest({
                method: 'post',
                url: endpoint,
                data: payload,
                headers: {
                    'Content-Type': 'application/json',
                    ...(await this._getHeaders(options))
                }
            }, { timeoutMs: 30000, label: 'LM Studio model load config' });
            const applied = response?.data?.load_config || {};
            if (Object.prototype.hasOwnProperty.call(loadConfig, 'flash_attention')) {
                const actual = applied.flash_attention;
                if (actual !== loadConfig.flash_attention) {
                    console.warn(`[LMStudio] Requested flash_attention=${loadConfig.flash_attention}, server applied=${actual}`);
                    const alertKey = `${cacheKey}:flash_attention_mismatch:${actual}`;
                    if (!this._softAlertCache.has(alertKey)) {
                        this._softAlertCache.add(alertKey);
                        this._emitSoftAlert(`LM Studio model "${modelId}" loaded with Flash Attention=${String(actual)}. Expected OFF. Check LM Studio load backend/settings.`, 'warning');
                    }
                }
            }
            this._appliedLoadConfig.set(cacheKey, signature);
        } catch (error) {
            console.warn(`[LMStudio] Model load config apply failed for ${modelId}: ${error.message}`);
            const alertKey = `${cacheKey}:load_config_error:${error.message}`;
            if (!this._softAlertCache.has(alertKey)) {
                this._softAlertCache.add(alertKey);
                this._emitSoftAlert(`LM Studio load-config check failed for "${modelId}": ${error.message}`, 'warning');
            }
        }
    }

    _emitSoftAlert(message, level = 'info') {
        if (!this._onSoftAlert) return;
        try {
            this._onSoftAlert({
                provider: 'lmstudio',
                level,
                message
            });
        } catch (_) {
            // Do not fail inference on notification errors.
        }
    }

    _buildEndpoint(baseUrl, endpointPath) {
        const rawBase = String(baseUrl || '').trim() || this.baseURL;
        const rawPath = String(endpointPath || '').trim();
        const normalizedPath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;

        let parsed;
        try {
            parsed = new URL(rawBase);
            if (parsed.hostname === 'localhost') {
                parsed.hostname = '127.0.0.1';
            }
        } catch (_) {
            const fallback = rawBase.replace(/\/+$/, '');
            return `${fallback}/v1${normalizedPath}`;
        }

        const pathname = (parsed.pathname || '/').replace(/\/+$/, '') || '/';
        const hasV1 = pathname === '/v1' || pathname.endsWith('/v1');
        const basePath = hasV1 ? pathname : `${pathname === '/' ? '' : pathname}/v1`;
        parsed.pathname = `${basePath}${normalizedPath}`;
        return parsed.toString();
    }

    async _getHeaders(options = {}) {
        let apiKey = await this.db.getAPIKey?.('lmstudio', options) || null;
        if (!apiKey) {
            apiKey = await this._getSetting('llm.lmstudio.apiKey', options);
            if (apiKey && this.db.setAPIKey) {
                await this.db.setAPIKey('lmstudio', apiKey, options);
            }
        }
        const headers = {};
        if (apiKey) {
            headers['Authorization'] = `Bearer ${apiKey}`;
        }
        return headers;
    }

    /**
     * LM Studio models with thinking support use <think> tags naturally.
     * We add a system hint to encourage or suppress reasoning.
     */
    _applyThinkingMode(messages, thinkingMode, runtimeConfig = {}, reasoningCaps = {}) {
        if (!thinkingMode || thinkingMode === 'off') return messages;
        if (!reasoningCaps.supported) return messages;

        const result = [...messages];
        let hint;

        if (runtimeConfig.reasoning?.visibility === 'hide') {
            hint = 'Reason internally if needed, but do not expose chain-of-thought or thinking tags in the final answer.';
        } else {
            hint = thinkingMode === 'think'
                ? 'Show your reasoning step by step inside <think></think> tags before giving your final answer.'
                : 'Do not include any reasoning or thinking tags. Give your answer directly.';
        }

        // Append to system message if exists, or prepend new one
        if (result.length > 0 && result[0].role === 'system') {
            result[0] = { ...result[0], content: result[0].content + '\n\n' + hint };
        } else {
            result.unshift({ role: 'system', content: hint });
        }
        return result;
    }

    _extractReasoning(message = {}, payload = {}) {
        if (typeof message.reasoning === 'string' && message.reasoning.trim()) {
            return message.reasoning.trim();
        }

        if (typeof message.reasoning_content === 'string' && message.reasoning_content.trim()) {
            return message.reasoning_content.trim();
        }

        if (typeof payload.reasoning_content === 'string' && payload.reasoning_content.trim()) {
            return payload.reasoning_content.trim();
        }

        return '';
    }

    _coerceContent(value) {
        if (typeof value === 'string') return value;
        if (!Array.isArray(value)) return '';

        return value
            .map(part => {
                if (typeof part === 'string') return part;
                return part?.text || part?.content || '';
            })
            .filter(Boolean)
            .join('\n')
            .trim();
    }
}

module.exports = LMStudioAdapter;
