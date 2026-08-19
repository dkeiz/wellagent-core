// @ts-nocheck
/**
 * BaseAdapter — Abstract base for all LLM provider adapters.
 *
 * Each provider extends this and implements:
 *   call(messages, options)  → { content, model, usage, stopped? }
 *   getModels()              → string[]
 *   stop()                   — abort running request
 */
class BaseAdapter {
    constructor(name, db) {
        this.name = name;
        this.db = db;
        this.activeRequests = new Map();
        this._requestSeq = 0;
        this.lastModelDiscovery = {
            ok: null,
            source: 'unknown',
            authoritative: false,
            error: null,
            count: 0,
            at: null
        };
    }

    async call(messages, options = {}) {
        throw new Error(`${this.name}: call() not implemented`);
    }

    async getModels() {
        return [];
    }

    prepareMessagesForEstimate(messages) {
        return Array.isArray(messages) ? messages : [];
    }

    getLastModelDiscovery() {
        return { ...this.lastModelDiscovery };
    }

    stop(requestId = null) {
        const id = requestId ? String(requestId) : '';
        if (id) {
            const controller = this.activeRequests.get(id);
            if (!controller) return false;
            controller.abort();
            console.log(`[${this.name}] Generation stopped request=${id}`);
            return true;
        }

        if (this.activeRequests.size === 0) return false;
        for (const controller of this.activeRequests.values()) {
            controller.abort();
        }
        console.log(`[${this.name}] Generation stopped`);
        return true;
    }

    get isGenerating() {
        return this.activeRequests.size > 0;
    }

    getActiveRequestCount() {
        return this.activeRequests.size;
    }

    _nextRequestId() {
        this._requestSeq += 1;
        return `${this.name}-${Date.now()}-${this._requestSeq}`;
    }

    _startRequest(requestId = null) {
        const id = requestId ? String(requestId) : this._nextRequestId();
        const controller = new AbortController();
        this.activeRequests.set(id, controller);
        return { requestId: id, signal: controller.signal };
    }

    _endRequest(requestId) {
        if (requestId) {
            this.activeRequests.delete(String(requestId));
            return;
        }
        this.activeRequests.clear();
    }

    _recordModelDiscovery(meta = {}) {
        const models = Array.isArray(meta.models) ? meta.models : [];
        this.lastModelDiscovery = {
            ok: meta.ok === undefined ? true : Boolean(meta.ok),
            source: String(meta.source || 'unknown'),
            authoritative: Boolean(meta.authoritative),
            error: meta.error ? String(meta.error) : null,
            count: models.length,
            at: new Date().toISOString()
        };
        return models;
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
        return this.db.saveSetting(key, value);
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

    splitInlineReasoning(content, existingReasoning = '') {
        const text = String(content || '');
        const reasoning = String(existingReasoning || '').trim();
        if (!/<think>/i.test(text)) {
            return { content: text, reasoning };
        }
        const thinkRegex = /<think>([\s\S]*?)<\/think>/gi;
        const matches = [...text.matchAll(thinkRegex)];
        if (matches.length === 0) return { content: text, reasoning };
        const inline = matches.map(match => String(match[1] || '').trim()).filter(Boolean).join('\n\n');
        const cleaned = text.replace(thinkRegex, '').trim();
        return {
            content: cleaned,
            reasoning: reasoning ? `${reasoning}\n\n${inline}` : inline
        };
    }

    _normalizeResponse({ content, reasoning, toolCalls = [], model, usage, stopped = false, context_length }) {
        // Preserve authoritative session-context usage returned in provider output.
        // Estimation belongs downstream and only runs when this response has no real value.
        const promptTokens = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0) || 0;
        const completionTokens = Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0) || 0;
        const explicitContextTokens = Number(usage?.context_tokens ?? usage?.contextTokens ?? 0) || 0;
        const hasProviderContext = promptTokens > 0 && usage?.estimated !== true;
        const contextTokens = explicitContextTokens > 0 ? explicitContextTokens : promptTokens;
        const totalTokens = Number(usage?.total_tokens ?? (
            (promptTokens || completionTokens)
                ? promptTokens + completionTokens
                : 0
        )) || 0;
        const cachedTokens = usage?.prompt_tokens_details?.cached_tokens
            ?? usage?.input_tokens_details?.cached_tokens
            ?? usage?.cache_read_input_tokens
            ?? 0;
        const cacheWriteTokens = usage?.prompt_tokens_details?.cache_write_tokens
            ?? usage?.cache_creation_input_tokens
            ?? 0;
        const result = {
            content: content || '',
            reasoning: reasoning || '',
            toolCalls: Array.isArray(toolCalls) ? toolCalls : [],
            model: model || this.name,
            usage: {
                input_tokens: promptTokens || 0,
                prompt_tokens: promptTokens || 0,
                output_tokens: completionTokens || 0,
                completion_tokens: completionTokens || 0,
                total_tokens: totalTokens || 0,
                cached_tokens: cachedTokens || 0,
                cache_write_tokens: cacheWriteTokens || 0,
                prompt_tokens_details: usage?.prompt_tokens_details || null,
                context_tokens: hasProviderContext ? contextTokens : 0,
                estimated: !hasProviderContext
            },
            stopped
        };
        if (hasProviderContext) {
            result.context_tokens = contextTokens;
            result.source = 'provider';
        }
        if (context_length) result.context_length = context_length;
        return result;
    }
}

module.exports = BaseAdapter;
