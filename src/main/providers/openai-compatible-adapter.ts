// @ts-nocheck
const BaseAdapter = require('./base-adapter');
const { isProviderRequestCanceled, providerRequest } = require('./provider-http');
const { applyAnthropicImageInput, applyOpenAIImageInput } = require('./attachment-input');
const { consumeSse, createOpenAIAccumulator } = require('./provider-stream');

const RESERVED_OVERRIDE_KEYS = new Set(['model', 'messages', 'stream']);
const REQUEST_TIMEOUT_MS = 120000;
const MODEL_LIST_TIMEOUT_MS = 15000;

class OpenAICompatibleAdapter extends BaseAdapter {
    constructor(providerId, db, options = {}) {
        super(providerId, db);
        this.providerId = providerId;
        this.providerLabel = options.label || providerId;
        this.defaultBaseURL = options.defaultBaseURL || '';
        this.apiPrefix = options.apiPrefix || '';
        this.apiKeyOptional = options.apiKeyOptional === true;
        this.defaultHeaders = options.defaultHeaders || {};
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
        const runtimeConfig = options.runtimeConfig || {};
        const reasoningCaps = options.modelSpec?.capabilities?.reasoning || {};
        const localParams = await this._getLocalParams(options);
        let processedMessages = this._applyThinkingMode(
            messages,
            options.thinkingMode,
            runtimeConfig,
            reasoningCaps
        );
        processedMessages = this.providerId === 'anthropic'
            ? applyAnthropicImageInput(processedMessages, options.attachments)
            : applyOpenAIImageInput(processedMessages, options.attachments);

        const streamEnabled = Boolean(options.turnEvents?.emit);
        const requestBody = {
            model: localParams.modelOverride || options.model || '',
            messages: processedMessages,
            temperature: options.temperature ?? 0.7,
            stream: streamEnabled
        };
        if (streamEnabled && this.providerId !== 'anthropic') requestBody.stream_options = { include_usage: true };
        // CRITICAL WARNING: DO NOT hardcode a default max_tokens (like 1000) here or anywhere in this adapter!
        // Capping output tokens by default restricts the model output length and truncates responses.
        // Let the API provider / model config decide output limits by default unless options.max_tokens is explicitly provided.
        if (options.max_tokens != null) {
            requestBody.max_tokens = options.max_tokens;
        }
        this._applyPromptCacheHint(requestBody, options.promptCache);

        this._applyLocalRequestParams(requestBody, localParams.modelArgs);
        this._applyReasoningConfig(requestBody, runtimeConfig, reasoningCaps);
        this._applyRequestOverrides(requestBody, runtimeConfig.requestOverrides);

        // Anthropic Messages API uses a different format from OpenAI:
        // - system must be a top-level field, not inside messages
        // - max_tokens is required (not optional)
        // - auth uses x-api-key header, not Bearer
        if (this.providerId === 'anthropic') {
            this._preprocessForAnthropicApi(requestBody);
        }

        try {
            const endpointPath = this.providerId === 'anthropic' ? '/messages' : '/chat/completions';
            const response = await providerRequest({
                method: 'post',
                url: this._buildEndpoint(await this._getBaseURL(localParams, options), endpointPath),
                data: requestBody,
                    ...(streamEnabled ? { responseType: 'stream' } : {}),
                    signal,
                headers: await this._getHeaders(localParams, options)
            }, { timeoutMs: REQUEST_TIMEOUT_MS, label: `${this.providerLabel} generation` });

            if (streamEnabled) {
                options.turnEvents.emit({ type: 'status', phase: 'responding', message: `${this.providerLabel} is responding` });
                if (this.providerId === 'anthropic') {
                    const streamed = await this._consumeAnthropicStream(response.data, options.turnEvents);
                    this._endRequest(requestId);
                    return this._normalizeResponse({
                        content: streamed.content,
                        reasoning: streamed.reasoning,
                        model: streamed.model || options.model || this.providerId,
                        usage: streamed.usage,
                        context_length: runtimeConfig.contextWindow?.value || options.modelSpec?.runtime?.contextWindow?.value
                    });
                }
                const accumulator = createOpenAIAccumulator(options.turnEvents);
                await consumeSse(response.data, payload => accumulator.push(payload));
                this._endRequest(requestId);
                const streamed = accumulator.result();
                const split = this.splitInlineReasoning(streamed.content, streamed.reasoning);
                return this._normalizeResponse({
                    content: split.content,
                    reasoning: split.reasoning,
                    toolCalls: streamed.toolCalls,
                    model: streamed.model || options.model || this.providerId,
                    usage: streamed.usage,
                    context_length: runtimeConfig.contextWindow?.value || options.modelSpec?.runtime?.contextWindow?.value
                });
            }

            this._endRequest(requestId);

            let content = '';
            let reasoning = '';
            let usage = response.data?.usage;

            if (this.providerId === 'anthropic') {
                const contentBlocks = response.data?.content || [];
                content = contentBlocks
                    .filter(block => block.type === 'text')
                    .map(block => block.text)
                    .join('\n')
                    .trim();
                
                reasoning = contentBlocks
                    .filter(block => block.type === 'thinking')
                    .map(block => block.thinking || block.text || '')
                    .join('\n')
                    .trim();

                if (usage) {
                    const inputTokens = Number(usage.input_tokens || 0);
                    const cacheReadTokens = Number(usage.cache_read_input_tokens || 0);
                    const cacheWriteTokens = Number(usage.cache_creation_input_tokens || 0);
                    const contextTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
                    usage = {
                        prompt_tokens: contextTokens,
                        completion_tokens: usage.output_tokens || 0,
                        total_tokens: contextTokens + Number(usage.output_tokens || 0),
                        cache_read_input_tokens: cacheReadTokens,
                        cache_creation_input_tokens: cacheWriteTokens
                    };
                }
            } else {
                const message = response.data?.choices?.[0]?.message || {};
                content = this._coerceContent(message.content);
                reasoning = this._extractReasoning(message, response.data);
            }

            const split = this.splitInlineReasoning(content, reasoning);
            return this._normalizeResponse({
                content: split.content,
                reasoning: split.reasoning,
                model: response.data?.model || options.model || this.providerId,
                usage,
                context_length: runtimeConfig.contextWindow?.value || options.modelSpec?.runtime?.contextWindow?.value
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
            const localParams = await this._getLocalParams(options);
            const response = await providerRequest({
                method: 'get',
                url: this._buildEndpoint(await this._getBaseURL(localParams, options), '/models'),
                headers: await this._getHeaders(localParams, options)
            }, { timeoutMs: MODEL_LIST_TIMEOUT_MS, label: `${this.providerLabel} model list` });
            const models = this._extractModelIds(response.data);
            this._recordModelDiscovery({
                ok: true,
                source: 'remote',
                authoritative: true,
                models
            });
            return models;
        } catch (error) {
            console.error(`[${this.providerLabel}] Failed to fetch models:`, error.message);
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

    _applyPromptCacheHint(requestBody, promptCache = null) {
        if (!promptCache?.enabled) return;
        const key = String(promptCache.key || '').trim();

        // Real provider-side prompt caching is API-specific. OpenAI Chat
        // Completions supports cache routing by stable prompt_cache_key, and
        // then reports hits in usage.prompt_tokens_details.cached_tokens.
        // Other OpenAI-compatible servers often reject unknown fields, so do
        // not fake cache controls for them here.
        if (this.providerId !== 'openai' || !key) return;

        requestBody.prompt_cache_key = key.slice(0, 512);
        if (promptCache.retention === '24h') {
            requestBody.prompt_cache_retention = '24h';
        }
    }

    async _getBaseURL(localParams = null, requestOptions = {}) {
        const params = localParams || await this._getLocalParams(requestOptions);
        if (params.baseUrlOverride) {
            return this._normalizeBaseURL(params.baseUrlOverride);
        }
        const stored = await this._getSetting(`llm.${this.providerId}.url`, requestOptions);
        return this._normalizeBaseURL(stored || this.defaultBaseURL);
    }

    async _getHeaders(localParams = null, requestOptions = {}) {
        const params = localParams || await this._getLocalParams(requestOptions);
        const apiKey = params.apiKeyOverride || await this.db.getAPIKey(this.providerId, requestOptions) || await this._getSetting(`llm.${this.providerId}.apiKey`, requestOptions);
        if (!apiKey && !this.apiKeyOptional) {
            throw new Error(`${this.providerLabel} API key not configured`);
        }

        const headers = {
            'Content-Type': 'application/json',
            ...this.defaultHeaders
        };

        if (apiKey) {
            if (this.providerId === 'anthropic') {
                // Anthropic uses x-api-key header, not Bearer token.
                headers['x-api-key'] = apiKey;
            } else {
                headers.Authorization = `Bearer ${apiKey}`;
            }
        }

        return headers;
    }

    async _getLocalParams(requestOptions = {}) {
        if (this.providerId !== 'local-openai') {
            return { modelArgs: {}, serverArgs: {}, modelOverride: '', baseUrlOverride: '', apiKeyOverride: '' };
        }

        const modelParamsRaw = await this._getSetting(`llm.${this.providerId}.modelParams`, requestOptions);
        const serverParamsRaw = await this._getSetting(`llm.${this.providerId}.serverParams`, requestOptions);
        const modelArgs = this._parseCliLikeArgs(modelParamsRaw);
        const serverArgs = this._parseCliLikeArgs(serverParamsRaw);

        const modelOverride = String(
            modelArgs.named.model
            || modelArgs.named.model_id
            || modelArgs.named.modelid
            || ''
        ).trim();
        const baseUrlOverride = String(
            serverArgs.named.url
            || serverArgs.named.base_url
            || serverArgs.named.baseurl
            || serverArgs.named.address
            || ''
        ).trim();
        const apiKeyOverride = String(
            serverArgs.named.api_key
            || serverArgs.named.apikey
            || ''
        ).trim();

        return { modelArgs, serverArgs, modelOverride, baseUrlOverride, apiKeyOverride };
    }

    _parseCliLikeArgs(rawValue) {
        const input = String(rawValue || '').replace(/\s+/g, ' ').trim();
        const out = { named: {}, flags: [], positional: [] };
        if (!input) return out;

        const tokens = input.match(/"[^"]*"|'[^']*'|\S+/g) || [];
        const unquote = (value) => String(value || '').replace(/^['"]|['"]$/g, '');
        const normalizeKey = (value) => String(value || '').trim().replace(/^-+/, '').replace(/-/g, '_').toLowerCase();

        for (let i = 0; i < tokens.length; i += 1) {
            const token = tokens[i];
            if (!token.startsWith('-')) {
                out.positional.push(unquote(token));
                continue;
            }

            const eqIndex = token.indexOf('=');
            if (eqIndex > 0) {
                const key = normalizeKey(token.slice(0, eqIndex));
                const value = unquote(token.slice(eqIndex + 1));
                if (key) out.named[key] = value;
                continue;
            }

            const key = normalizeKey(token);
            const next = tokens[i + 1];
            if (next && !next.startsWith('-')) {
                out.named[key] = unquote(next);
                i += 1;
            } else {
                out.named[key] = true;
                out.flags.push(key);
            }
        }

        return out;
    }

    _parseMaybeNumber(value) {
        if (typeof value === 'number') return Number.isFinite(value) ? value : null;
        if (typeof value !== 'string') return null;
        if (!value.trim()) return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    _parseMaybeBoolean(value) {
        if (typeof value === 'boolean') return value;
        const normalized = String(value || '').trim().toLowerCase();
        if (!normalized) return null;
        if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
        if (['false', '0', 'no', 'off'].includes(normalized)) return false;
        return null;
    }

    _applyLocalRequestParams(requestBody, parsedArgs = {}) {
        if (this.providerId !== 'local-openai') return;
        const named = parsedArgs.named || {};

        const numericKeys = ['temperature', 'top_p', 'top_k', 'presence_penalty', 'frequency_penalty', 'max_tokens', 'min_tokens', 'seed', 'n'];
        for (const key of numericKeys) {
            if (!Object.prototype.hasOwnProperty.call(named, key)) continue;
            const parsed = this._parseMaybeNumber(named[key]);
            if (parsed !== null) requestBody[key] = parsed;
        }

        const booleanKeys = ['stream'];
        for (const key of booleanKeys) {
            if (!Object.prototype.hasOwnProperty.call(named, key)) continue;
            const parsed = this._parseMaybeBoolean(named[key]);
            if (parsed !== null) requestBody[key] = parsed;
        }

        for (const [key, value] of Object.entries(named)) {
            if (key === 'model' || key === 'model_id' || key === 'modelid') continue;
            if (key === 'url' || key === 'base_url' || key === 'baseurl' || key === 'address') continue;
            if (key === 'api_key' || key === 'apikey') continue;
            if (Object.prototype.hasOwnProperty.call(requestBody, key)) continue;
            requestBody[key] = value;
        }
    }

    _normalizeBaseURL(url) {
        return String(url || '').trim().replace(/\/+$/, '');
    }

    _buildEndpoint(baseURL, pathName) {
        const normalizedBase = this._normalizeBaseURL(baseURL);
        if (!normalizedBase) {
            throw new Error(`${this.providerLabel} base URL is not configured`);
        }

        if (!this.apiPrefix) {
            return `${normalizedBase}${pathName}`;
        }

        if (normalizedBase.toLowerCase().endsWith(this.apiPrefix.toLowerCase())) {
            return `${normalizedBase}${pathName}`;
        }

        return `${normalizedBase}${this.apiPrefix}${pathName}`;
    }

    _applyThinkingMode(messages, thinkingMode, runtimeConfig = {}, reasoningCaps = {}) {
        if (!thinkingMode || thinkingMode === 'off') return messages;
        if (!reasoningCaps.supported) return messages;
        if (reasoningCaps.parameterMode === 'openai_reasoning_effort') return messages;

        const result = [...messages];
        let hint;

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

    _applyReasoningConfig(requestBody, runtimeConfig = {}, reasoningCaps = {}) {
        if (!reasoningCaps.supported) return;
        if (reasoningCaps.parameterMode !== 'openai_reasoning_effort') return;

        const levels = Array.isArray(reasoningCaps.effortLevels) ? reasoningCaps.effortLevels : [];
        if (levels.length === 0) return;

        const desired = runtimeConfig.reasoning?.enabled
            ? runtimeConfig.reasoning?.effort
            : (levels.includes('minimal') ? 'minimal' : levels[0]);

        requestBody.reasoning_effort = levels.includes(desired) ? desired : levels[0];
    }

    _applyRequestOverrides(requestBody, requestOverrides) {
        if (!requestOverrides || typeof requestOverrides !== 'object' || Array.isArray(requestOverrides)) {
            return;
        }

        for (const [key, value] of Object.entries(requestOverrides)) {
            if (RESERVED_OVERRIDE_KEYS.has(key)) continue;
            requestBody[key] = value;
        }
    }

    _extractModelIds(payload = {}) {
        const raw = Array.isArray(payload?.data)
            ? payload.data
            : (Array.isArray(payload?.models) ? payload.models : []);

        return Array.from(new Set(raw
            .map(entry => {
                if (typeof entry === 'string') return entry;
                return entry?.id || entry?.name || entry?.model;
            })
            .filter(Boolean)
            .map(String)));
    }

    _extractReasoning(message = {}, payload = {}) {
        if (typeof message.reasoning === 'string' && message.reasoning.trim()) {
            return message.reasoning.trim();
        }

        if (typeof message.reasoning_content === 'string' && message.reasoning_content.trim()) {
            return message.reasoning_content.trim();
        }

        if (Array.isArray(message.content)) {
            const contentReasoning = message.content
                .map(part => {
                    if (!part || typeof part !== 'object') return '';
                    if (part.type === 'reasoning') {
                        return part.reasoning || part.text || part.content || '';
                    }
                    return '';
                })
                .filter(Boolean)
                .join('\n')
                .trim();
            if (contentReasoning) {
                return contentReasoning;
            }
        }

        const choiceReasoning = payload?.choices?.[0]?.reasoning;
        if (typeof choiceReasoning === 'string' && choiceReasoning.trim()) {
            return choiceReasoning.trim();
        }

        if (typeof payload.reasoning_content === 'string' && payload.reasoning_content.trim()) {
            return payload.reasoning_content.trim();
        }

        if (typeof payload.reasoning === 'string' && payload.reasoning.trim()) {
            return payload.reasoning.trim();
        }

        if (Array.isArray(payload.output)) {
            const outputReasoning = payload.output
                .map(item => {
                    if (!item || typeof item !== 'object') return '';
                    if (item.type === 'reasoning') {
                        return item.summary || item.text || item.content || item.reasoning || '';
                    }
                    return item.reasoning || item.reasoning_content || '';
                })
                .filter(Boolean)
                .join('\n')
                .trim();
            if (outputReasoning) {
                return outputReasoning;
            }
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

    async _consumeAnthropicStream(stream, turnEvents = null) {
        const state = { content: '', reasoning: '', model: '', usage: null };
        const emit = (event) => turnEvents?.emit?.(event);
        await consumeSse(stream, (payload = {}) => {
            const type = String(payload.type || '');
            if (type === 'message_start') {
                if (payload.message?.model) state.model = payload.message.model;
                if (payload.message?.usage) state.usage = payload.message.usage;
                return;
            }
            if (type === 'content_block_delta') {
                const delta = payload.delta || {};
                if (delta.type === 'text_delta' && delta.text) {
                    state.content += delta.text;
                    emit({ type: 'content.delta', text: delta.text });
                } else if (delta.type === 'thinking_delta' && delta.thinking) {
                    state.reasoning += delta.thinking;
                    emit({ type: 'reasoning.delta', text: delta.thinking });
                }
                return;
            }
            if (type === 'message_delta') {
                if (payload.usage) {
                    state.usage = {
                        input_tokens: payload.usage.input_tokens ?? state.usage?.input_tokens,
                        output_tokens: payload.usage.output_tokens ?? state.usage?.output_tokens
                    };
                }
                return;
            }
        });
        return state;
    }

    /**
     * Preprocess request body for Anthropic's Messages API format.
     * - Extracts system messages from the messages array into top-level `system` field
     * - Ensures max_tokens is set (Anthropic requires it)
     * - Uses `/messages` endpoint instead of `/chat/completions`
     */
    _preprocessForAnthropicApi(requestBody) {
        // Extract system messages into top-level `system` parameter.
        // Anthropic doesn't accept role:'system' in the messages array.
        const messages = requestBody.messages || [];
        const systemMessages = [];
        const nonSystemMessages = [];
        for (const msg of messages) {
            if (msg.role === 'system') {
                systemMessages.push(msg.content || '');
            } else {
                nonSystemMessages.push(msg);
            }
        }
        if (systemMessages.length > 0) {
            requestBody.system = systemMessages.join('\n\n');
        }
        requestBody.messages = nonSystemMessages;

        // Anthropic requires max_tokens. If not provided, use a sensible default.
        if (requestBody.max_tokens == null) {
            requestBody.max_tokens = 8192;
        }

        // Anthropic uses `model` but doesn't use `temperature` outside 0-1 range.
        if (requestBody.temperature != null) {
            requestBody.temperature = Math.min(1, Math.max(0, requestBody.temperature));
        }
    }
}

module.exports = OpenAICompatibleAdapter;
