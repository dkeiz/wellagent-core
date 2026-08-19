// @ts-nocheck
const fs = require('fs');
const path = require('path');
const BaseAdapter = require('./base-adapter');
const { isProviderRequestCanceled, providerRequest } = require('./provider-http');
const { applyDashScopeImageInput, imageAttachments } = require('./attachment-input');
const { consumeSse } = require('./provider-stream');

/**
 * QwenAdapter — Qwen/DashScope API + CLI mode.
 *
 * Supports two modes:
 *   - api: DashScope REST API with API key
 *   - cli: local qwen CLI command
 *
 * Thinking mode uses /think or /nothink prefix (Qwen3 native).
 */
class QwenAdapter extends BaseAdapter {
    constructor(db) {
        super('qwen', db);
        this.baseURL = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation';

        // Model cache with TTL
        this.modelCache = {
            models: [],
            lastSuccess: 0
        };
    }

    async prepareMessagesForEstimate(messages, options = {}) {
        const mode = await this._getSetting('llm.qwen.mode', options) || 'cli';
        return this._applyThinkingMode(
            messages,
            options.thinkingMode,
            options.modelSpec?.capabilities?.reasoning || {},
            mode
        );
    }

    async call(messages, options = {}) {
        const mode = await this._getSetting('llm.qwen.mode', options) || 'cli';

        if (mode === 'cli') {
            return this._callCLI(messages, options);
        } else {
            return this._callAPI(messages, options, mode);
        }
    }

    async _callAPI(messages, options, mode = 'api') {
        const { requestId, signal } = this._startRequest();
        try {
            let apiKey = await this.db.getAPIKey('qwen', options) || await this._getSetting('llm.qwen.apiKey', options);
            const useOAuth = mode === 'oauth' || (await this._getSetting('llm.qwen.useOAuth', options)) === 'true';

            if (useOAuth) {
                apiKey = await this._getApiKeyFromOAuth(options);
            }

            if (!apiKey) throw new Error('Qwen API key not configured');

            const runtimeConfig = options.runtimeConfig || {};
            const reasoningConfig = runtimeConfig.reasoning || {};
            const reasoningCaps = options.modelSpec?.capabilities?.reasoning || {};
            const hasImages = imageAttachments(options.attachments).length > 0;
            const processedMessages = applyDashScopeImageInput(
                this._applyThinkingMode(messages, options.thinkingMode, reasoningCaps, mode),
                options.attachments
            );

            const requestBody = {
                model: options.model || 'qwen-turbo',
                messages: processedMessages
            };

            if (reasoningCaps.parameterMode === 'qwen_enable_thinking' && reasoningCaps.supported) {
                requestBody.parameters = {
                    result_format: 'message',
                    enable_thinking: reasoningConfig.enabled
                };

                if (reasoningCaps.maxTokens && reasoningConfig.maxTokens) {
                    requestBody.parameters.thinking_budget = reasoningConfig.maxTokens;
                }
            }

            const streamEnabled = Boolean(options.turnEvents?.emit);
            if (streamEnabled) {
                requestBody.stream = true;
                if (!requestBody.parameters) requestBody.parameters = {};
                requestBody.parameters.result_format = 'message';
                requestBody.parameters.incremental_output = true;
            }

            const headers = {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            };
            if (streamEnabled) {
                headers['X-DashScope-SSE'] = 'enable';
                headers['Accept'] = 'text/event-stream';
            }

            const response = await providerRequest({
                method: 'post',
                url: hasImages
                    ? this.baseURL.replace('/text-generation/', '/multimodal-generation/')
                    : this.baseURL,
                data: requestBody,
                ...(streamEnabled ? { responseType: 'stream' } : {}),
                signal,
                headers
            }, { timeoutMs: 120000, label: 'Qwen generation' });

            if (streamEnabled) {
                options.turnEvents.emit({ type: 'status', phase: 'responding', message: 'Qwen is responding' });
                let content = '';
                let reasoning = '';
                let model = options.model;
                let usage = null;
                await consumeSse(response.data, (payload) => {
                    const choices = payload?.output?.choices || payload?.choices || [];
                    const message = choices[0]?.message || {};
                    if (message.role === 'assistant' && message.content === '' && !message.reasoning_content && !message.thinking) {
                        return;
                    }
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
                    if (payload?.output?.model || payload?.model) model = payload?.output?.model || payload?.model;
                    if (payload?.usage || payload?.output?.usage) usage = payload?.usage || payload?.output?.usage;
                });
                this._endRequest(requestId);
                const split = this.splitInlineReasoning(content, reasoning);
                return this._normalizeResponse({
                    content: split.content,
                    reasoning: split.reasoning,
                    model: model || options.model,
                    usage: usage || null,
                    context_length: runtimeConfig.contextWindow?.value || options.modelSpec?.runtime?.contextWindow?.value
                });
            }

            this._endRequest(requestId);

            const normalized = this._extractMessage(response.data);

            return this._normalizeResponse({
                content: normalized.content,
                reasoning: normalized.reasoning,
                model: response.data.model || response.data.output?.model,
                usage: response.data.usage || response.data.output?.usage,
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
            const sourceError = error.cause || error;
            console.error('[Qwen API] Error:', sourceError.response?.data || sourceError.message);
            throw new Error(`Qwen API failed: ${sourceError.response?.data?.error?.message || sourceError.message}`);
        }
    }

    async _callCLI(messages, options) {
        if (imageAttachments(options.attachments).length > 0) {
            throw new Error('Qwen CLI transport does not support image attachments; select the Qwen API transport');
        }
        const processedMessages = this._applyThinkingMode(
            messages,
            options.thinkingMode,
            options.modelSpec?.capabilities?.reasoning || {},
            'cli'
        );
        const prompt = this._formatMessagesForCli(processedMessages);
        const model = String(options.model || '');
        const args = [];
        if (model && model !== 'qwen-cli') {
            args.push('--model', model);
        }
        args.push('--prompt', prompt);

        const { requestId, signal } = this._startRequest();
        let result;
        try {
            result = await this._runQwenCli(args, 30000, signal);
        } finally {
            this._endRequest(requestId);
        }
        if (result.stopped) {
            return this._normalizeResponse({
                content: '[Generation stopped by user]',
                model: options.model || 'qwen-cli',
                stopped: true
            });
        }
        if (result.code !== 0) {
            console.error('[Qwen CLI] Error:', result.error || result.stderr);
            throw new Error(`Qwen CLI failed: ${result.error?.message || result.stderr || `exit code ${result.code}`}`);
        }
        return this._normalizeResponse({
            content: result.stdout.trim(),
            model: options.model || 'qwen-cli',
            context_length: options.runtimeConfig?.contextWindow?.value || options.modelSpec?.runtime?.contextWindow?.value,
            usage: { total_tokens: 0 }
        });
    }

    _runQwenCli(args, timeoutMs, signal = null) {
        const { spawn } = require('child_process');
        if (signal?.aborted) {
            return Promise.resolve({ stdout: '', stderr: '', code: 130, error: null, stopped: true });
        }
        return new Promise((resolve) => {
            const launch = this._resolveQwenLaunch();
            const child = spawn(launch.command, [...launch.argsPrefix, ...args], {
                shell: false,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe']
            });
            let stdout = '';
            let stderr = '';
            let settled = false;
            let timeout = null;
            const finish = (payload) => {
                if (settled) return;
                settled = true;
                if (timeout) clearTimeout(timeout);
                if (signal?.removeEventListener) {
                    signal.removeEventListener('abort', onAbort);
                }
                resolve(payload);
            };
            const onAbort = () => {
                try {
                    child.kill();
                } catch (_) {
                }
                finish({ stdout, stderr, code: 130, error: null, stopped: true });
            };
            if (signal?.addEventListener) {
                signal.addEventListener('abort', onAbort, { once: true });
            }
            timeout = setTimeout(() => {
                try {
                    child.kill();
                } catch (_) {
                }
                finish({
                    stdout,
                    stderr,
                    code: 124,
                    error: new Error(`Qwen CLI timed out after ${timeoutMs}ms`)
                });
            }, timeoutMs);

            child.stdout.on('data', chunk => {
                stdout += String(chunk);
            });
            child.stderr.on('data', chunk => {
                stderr += String(chunk);
            });
            child.on('error', error => {
                finish({ stdout, stderr, code: 1, error });
            });
            child.on('exit', code => {
                finish({ stdout, stderr, code: Number(code || 0), error: null });
            });
        });
    }

    _formatMessagesForCli(messages = []) {
        return messages.map(message => {
            const role = String(message?.role || 'user').toUpperCase();
            const content = this._coerceContent(message?.content);
            return `${role}:\n${content}`;
        }).join('\n\n');
    }

    _getQwenCommand() {
        return this._resolveQwenLaunch().command;
    }

    _resolveQwenLaunch() {
        const configured = String(process.env.LOCALAGENT_QWEN_PATH || process.env.QWEN_CLI_PATH || '').trim();
        if (process.platform !== 'win32') {
            return { command: configured || 'qwen', argsPrefix: [] };
        }

        const candidates = [];
        if (configured) candidates.push(configured);
        for (const entry of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
            candidates.push(path.join(entry, 'qwen.cmd'));
            candidates.push(path.join(entry, 'qwen.exe'));
        }

        for (const candidate of candidates) {
            if (!fs.existsSync(candidate)) continue;
            const extension = path.extname(candidate).toLowerCase();
            if (extension === '.js' || extension === '.cjs' || extension === '.mjs') {
                return { command: process.execPath, argsPrefix: [candidate] };
            }
            if (extension === '.cmd') {
                const entrypoint = path.join(
                    path.dirname(candidate),
                    'node_modules',
                    '@qwen-code',
                    'qwen-code',
                    'cli-entry.js'
                );
                if (fs.existsSync(entrypoint)) {
                    return { command: process.execPath, argsPrefix: [entrypoint] };
                }
                continue;
            }
            return { command: candidate, argsPrefix: [] };
        }

        throw new Error('Qwen CLI not found on PATH');
    }

    async getModels(forceRefresh = false, options = {}) {
        const oneWeek = 7 * 24 * 60 * 60 * 1000;

        if (!forceRefresh && this.modelCache.models.length > 0 &&
            Date.now() - this.modelCache.lastSuccess < oneWeek) {
            this._recordModelDiscovery({
                ok: true,
                source: 'cache',
                authoritative: false,
                models: this.modelCache.models
            });
            return this.modelCache.models;
        }

        try {
            let models = await this._fetchModels(options);
            let source = models && models.length > 0 ? 'remote' : 'cli';

            if (!models || models.length === 0) {
                models = await this._fetchModelsCLI();
            }

            this.modelCache.models = models;
            this.modelCache.lastSuccess = Date.now();
            this._recordModelDiscovery({
                ok: true,
                source,
                authoritative: true,
                models
            });
            return models;
        } catch (error) {
            console.error('[Qwen] Model fetch failed:', error.message);

            try {
                const cliModels = await this._fetchModelsCLI();
                if (cliModels.length > 0) {
                    this.modelCache.models = cliModels;
                    this.modelCache.lastSuccess = Date.now();
                    this._recordModelDiscovery({
                        ok: true,
                        source: 'cli',
                        authoritative: true,
                        models: cliModels
                    });
                    return cliModels;
                }
            } catch (cliError) {
                console.error('[Qwen] CLI model fetch failed:', cliError.message);
            }

            if (this.modelCache.models.length > 0) {
                this._recordModelDiscovery({
                    ok: false,
                    source: 'cache-fallback',
                    authoritative: false,
                    error: error.message,
                    models: this.modelCache.models
                });
                return this.modelCache.models;
            }
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
    async _fetchModels(options = {}) {
        // Try OAuth first
        const useOAuth = await this._getSetting('llm.qwen.useOAuth', options);
        if (useOAuth === 'true') {
            return this._fetchModelsOAuth(options);
        }

        // Try API key
        const apiKey = await this.db.getAPIKey('qwen', options) || await this._getSetting('llm.qwen.apiKey', options);
        if (apiKey) {
            try {
                const response = await providerRequest({
                    method: 'get',
                    url: 'https://dashscope.aliyuncs.com/api/v1/models',
                    headers: { 'Authorization': `Bearer ${apiKey}` }
                }, { timeoutMs: 120000, label: 'Qwen model list' });
                const models = this._extractModelsFromApiResponse(response.data);
                if (models.length > 0) {
                    return models;
                }
            } catch (error) {
                console.error('[Qwen] API key model fetch failed:', error.message);
            }
        }

        return [];
    }

    async _fetchModelsOAuth(options = {}) {
        const apiKey = await this._getApiKeyFromOAuth(options);

        const response = await providerRequest({
            method: 'get',
            url: 'https://dashscope.aliyuncs.com/api/v1/models',
            headers: { 'Authorization': `Bearer ${apiKey}` }
        }, { timeoutMs: 120000, label: 'Qwen OAuth model list' });

        const models = this._extractModelsFromApiResponse(response.data);
        if (models.length === 0) throw new Error('Empty model list');
        return models;
    }

    async _getApiKeyFromOAuth(options = {}) {
        let oauthCredsStr = await this.db.getCredential?.('llm.qwen.oauthCreds', options) || null;
        if (!oauthCredsStr) {
            oauthCredsStr = await this._getSetting('llm.qwen.oauthCreds', options);
            if (oauthCredsStr && this.db.setCredential) {
                await this.db.setCredential('llm.qwen.oauthCreds', oauthCredsStr, options);
                if (this._saveSetting) { await this._saveSetting('llm.qwen.oauthCreds', '', options); }
            }
        }
        if (!oauthCredsStr) throw new Error('OAuth enabled but no credentials found');

        const oauthCreds = JSON.parse(oauthCredsStr);
        const token = oauthCreds.access_token || oauthCreds.token || oauthCreds.id_token || oauthCreds.accessToken;
        if (!token) throw new Error('No access token available');

        // Get API key from OAuth token
        const apiKeyResponse = await providerRequest({
            method: 'get',
            url: 'https://portal.qwen.ai/api/v1/auth/api_key',
            headers: { 'Authorization': `Bearer ${token}` }
        }, { timeoutMs: 120000, label: 'Qwen OAuth API key exchange' });

        const apiKey = apiKeyResponse?.data?.api_key || apiKeyResponse?.data?.data?.api_key || apiKeyResponse?.data?.key;
        if (!apiKey) throw new Error('Failed to retrieve API key from OAuth');
        return apiKey;
    }

    _extractModelsFromApiResponse(payload) {
        const raw = [];
        if (Array.isArray(payload?.data)) raw.push(...payload.data);
        if (Array.isArray(payload?.models)) raw.push(...payload.models);
        if (Array.isArray(payload?.output?.models)) raw.push(...payload.output.models);

        const models = raw
            .map(m => (typeof m === 'string' ? m : (m?.id || m?.model || m?.name || m?.model_id)))
            .filter(Boolean)
            .map(String);

        return Array.from(new Set(models));
    }

    async _fetchModelsCLI() {
        const argCandidates = [
            ['models'],
            ['list-models'],
            ['model', 'list'],
            ['list', 'models'],
            ['--models'],
            ['--list-models']
        ];

        for (const args of argCandidates) {
            try {
                const result = await this._runQwenCli(args, 8000);
                if (result.error && !result.stdout && !result.stderr) throw result.error;
                const text = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
                const parsed = this._parseModelsFromCliText(text);
                if (parsed.length > 0) return parsed;
            } catch (_) {
                // Try next candidate
            }
        }

        return [];
    }

    _parseModelsFromCliText(text) {
        if (!text) return [];

        const stop = new Set(['model', 'models', 'name', 'available', 'installed', 'default']);
        const out = new Set();

        for (const line of text.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || /^[-=|+]+$/.test(trimmed)) continue;

            const first = trimmed.split(/\s+/)[0];
            if (!first) continue;
            if (stop.has(first.toLowerCase())) continue;
            if (!/^[a-zA-Z0-9._:/-]{3,}$/.test(first)) continue;

            out.add(first);
        }

        return Array.from(out);
    }

    /**
     * Qwen3 natively supports /think and /nothink prefixes.
     */
    _applyThinkingMode(messages, thinkingMode, reasoningCaps = {}, mode = 'api') {
        if (!thinkingMode || thinkingMode === 'off') return messages;
        if (!reasoningCaps.supported) return messages;
        if (reasoningCaps.parameterMode === 'qwen_enable_thinking' && mode !== 'cli') return messages;

        const result = [...messages];
        for (let i = result.length - 1; i >= 0; i--) {
            if (result[i].role === 'user') {
                const prefix = thinkingMode === 'think' ? '/think\n' : '/nothink\n';
                result[i] = { ...result[i], content: prefix + result[i].content };
                break;
            }
        }
        return result;
    }

    _extractMessage(payload = {}) {
        const directMessage = payload?.choices?.[0]?.message;
        const outputMessage = payload?.output?.choices?.[0]?.message;
        const message = directMessage || outputMessage || {};

        const content = this._coerceContent(message.content);
        const reasoning = this._coerceContent(
            message.thinking ||
            message.reasoning_content ||
            message.reasoning ||
            payload?.thinking ||
            payload?.reasoning_content ||
            payload?.reasoning ||
            payload?.output?.reasoning_content ||
            payload?.output?.thinking
        );

        return { content, reasoning };
    }

    _coerceContent(value) {
        if (typeof value === 'string') return value;
        if (Array.isArray(value)) {
            return value
                .map(part => {
                    if (typeof part === 'string') return part;
                    return part?.text || part?.content || '';
                })
                .filter(Boolean)
                .join('\n')
                .trim();
        }
        return '';
    }
}

module.exports = QwenAdapter;
