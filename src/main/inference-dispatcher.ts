// @ts-nocheck
const { getEffectiveLlmSelection } = require('./llm-state');
const { InferenceScheduler } = require('./inference/inference-scheduler');
const { InferenceRuntimeConfig } = require('./inference/inference-runtime-config');
const { InferencePromptBuilder } = require('./inference/inference-prompt-builder');
const { InferenceRetryPolicy } = require('./inference/inference-retry-policy');
const { estimateMessageTokens, estimateTextTokens } = require('./conversation-context');

class InferenceDispatcher {
    constructor(aiService, db, mcpServer) {
        this.aiService = aiService;
        this.db = db;
        this.mcpServer = mcpServer;
        this.agentManager = null;
        this.promptFileManager = null;
        this.scheduler = new InferenceScheduler({ aiService, db });
        this.runtimeConfigResolver = new InferenceRuntimeConfig({ db, aiService });
        this.promptBuilder = new InferencePromptBuilder({
            aiService,
            db,
            mcpServer,
            getAgentManager: () => this.agentManager,
            getPromptFileManager: () => this.promptFileManager
        });
        this.codexRuntimeManager = null;
        this.retryPolicy = new InferenceRetryPolicy();
        this.aiService?.setRetryCancellationHandler?.((provider) => this.retryPolicy.cancel(provider));
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

    setAgentManager(agentManager) {
        this.agentManager = agentManager;
    }

    setPromptFileManager(promptFileManager) {
        this.promptFileManager = promptFileManager || null;
    }

    setCodexRuntimeManager(codexRuntimeManager) {
        this.codexRuntimeManager = codexRuntimeManager || null;
    }

    async resolveContextWindow(options = {}) {
        const scopeOptions = this._buildScopeOptions(options);
        let provider = String(options.provider || '').trim().toLowerCase();
        let model = options.model;
        if (!provider || !model) {
            const selection = await getEffectiveLlmSelection(this.db, scopeOptions);
            provider = provider || selection.provider || String(this.aiService.getCurrentProvider() || 'ollama').trim().toLowerCase() || 'ollama';
            model = model || selection.model;
        }
        if (!provider) {
            provider = String(this.aiService.getCurrentProvider() || 'ollama').trim().toLowerCase() || 'ollama';
        }
        if (!model) {
            const savedContext = await this._getSetting('context_window', scopeOptions);
            const parsedContext = Number.parseInt(savedContext, 10);
            return Number.isFinite(parsedContext) && parsedContext > 0 ? parsedContext : 8192;
        }

        let modelSpec = options.modelSpec;
        let runtimeConfig = options.runtimeConfig;
        if (!runtimeConfig) {
            const config = await this.runtimeConfigResolver.loadModelRuntime(provider, model, scopeOptions);
            modelSpec = config.spec;
            runtimeConfig = config.runtime;
        }

        return this.runtimeConfigResolver.resolveContextWindow({
            provider,
            model,
            modelSpec,
            runtimeConfig,
            ...scopeOptions
        });
    }

    async estimateContextUsage(prompt, history = [], options = {}) {
        const mode = options.mode || 'chat';
        const scopeOptions = this._buildScopeOptions(options);
        const selection = await getEffectiveLlmSelection(this.db, scopeOptions);
        const provider = String(
            options.provider
            || selection.provider
            || this.aiService.getCurrentProvider()
            || 'ollama'
        ).trim().toLowerCase() || 'ollama';
        const model = options.model || selection.model || null;
        const includeTools = options.includeTools ?? (mode === 'chat');
        const includeTextTools = includeTools && provider !== 'local-codex';
        const includeRules = options.includeRules ?? (mode === 'chat');
        const includeEnv = options.includeEnv ?? (mode === 'chat' || mode === 'internal');
        const skipMemoryOnStart = options.skipMemoryOnStart === true;

        let modelSpec = options.modelSpec;
        let runtimeConfig = options.runtimeConfig;
        if (!runtimeConfig && model) {
            const resolved = await this.runtimeConfigResolver.loadModelRuntime(provider, model, scopeOptions);
            modelSpec = resolved.spec;
            runtimeConfig = resolved.runtime;
        }
        if (modelSpec && runtimeConfig) {
            runtimeConfig = this.runtimeConfigResolver.sanitizeResolvedRuntime(modelSpec, runtimeConfig);
        }

        let thinkingMode = options.thinkingMode;
        if (!thinkingMode) {
            if (runtimeConfig?.reasoning) {
                thinkingMode = runtimeConfig.reasoning.enabled ? 'think' : 'off';
            }
            const savedThinkingMode = await this._getSetting('llm.thinkingMode', scopeOptions);
            if (!runtimeConfig?.reasoning && savedThinkingMode && savedThinkingMode !== 'off') {
                thinkingMode = savedThinkingMode;
            }
        }

        const agentId = options.agentId || null;
        const nativeWorkspaceRoot = this.mcpServer?.getExecutionRoot
            ? await this.mcpServer.getExecutionRoot({
                sessionId: options.sessionId || null,
                agentId,
                requestContext: options.requestContext || null
            })
            : null;
        const systemPrompt = options.systemPrompt !== undefined
            ? String(options.systemPrompt || '')
            : await this.promptBuilder.buildSystemPrompt({
                includeTools: includeTextTools,
                includeRules,
                includeEnv,
                skipMemoryOnStart,
                sessionId: options.sessionId,
                agentId,
                requestContext: options.requestContext || null,
                completionTools: options.completionTools || [],
                nativeWorkspaceRoot
            });

        let nativeTools = [];
        if (includeTools && (provider === 'ollama' || provider === 'local-codex')) {
            const toolContext = {
                sessionId: options.sessionId || null,
                agentId,
                requestContext: options.requestContext || null
            };
            const activeTools = this.mcpServer?.getActiveToolsForContext
                ? await this.mcpServer.getActiveToolsForContext(toolContext)
                : [];
            const completionTools = this.mcpServer?.getToolsByNames
                ? this.mcpServer.getToolsByNames(options.completionTools || [], { includeInternal: true })
                : [];
            const mergedTools = [...activeTools];
            for (const tool of completionTools) {
                if (!mergedTools.some(existing => existing.name === tool.name)) mergedTools.push(tool);
            }
            nativeTools = mergedTools.map(tool => ({
                type: 'function',
                function: {
                    name: tool.name,
                    description: tool.description || '',
                    parameters: tool.inputSchema || { type: 'object', properties: {} }
                }
            }));
        }

        let messages = [
            { role: 'system', content: systemPrompt },
            ...history,
            ...(prompt ? [{ role: 'user', content: prompt }] : [])
        ];
        if (this.aiService?.prepareMessagesForEstimate) {
            messages = await this.aiService.prepareMessagesForEstimate(provider, messages, {
                ...options,
                model,
                modelSpec,
                runtimeConfig,
                thinkingMode
            });
        }
        const messageTokens = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
        const nativeToolTokens = nativeTools.length > 0
            ? estimateTextTokens(JSON.stringify(nativeTools)) + 6
            : 0;
        const tokens = messageTokens + nativeToolTokens;
        const contextWindow = await this.resolveContextWindow({
            provider,
            model,
            modelSpec,
            runtimeConfig,
            ...scopeOptions
        });

        return {
            tokens,
            contextWindow,
            totalMessages: messages.length,
            components: {
                messages: messageTokens,
                nativeTools: nativeToolTokens
            }
        };
    }

    async dispatch(prompt, history = [], options = {}) {
        const mode = options.mode || 'chat';
        const preemptible = options.preemptible === true;
        const scopeOptions = this._buildScopeOptions(options);
        const selection = await getEffectiveLlmSelection(this.db, scopeOptions);
        const includeTools = options.includeTools ?? (mode === 'chat');
        const includeRules = options.includeRules ?? (mode === 'chat');
        const includeEnv = options.includeEnv ?? (mode === 'chat' || mode === 'internal');
        const skipMemoryOnStart = options.skipMemoryOnStart === true;
        if (!options.model && selection.model) {
            options.model = selection.model;
        }
        const provider = String(
            options.provider
            || selection.provider
            || this.aiService.getCurrentProvider()
            || 'ollama'
        ).trim().toLowerCase() || 'ollama';
        options.turnEvents?.emit?.({ type: 'status', phase: 'connecting', message: `Connecting to ${provider}`, provider });
        if (this.aiService.isRuntimeProvider(provider)) {
            const runtimeProvider = this.aiService.getRuntimeProvider(provider) || this.codexRuntimeManager;
            if (!runtimeProvider?.runTurn) {
                throw new Error(`Runtime provider unavailable: ${provider}`);
            }
            if (!options.runtimeConfig && options.model) {
                const { spec, runtime } = await this.runtimeConfigResolver.loadModelRuntime(provider, options.model, scopeOptions);
                options.modelSpec = spec;
                options.runtimeConfig = runtime;
            }
            if (options.modelSpec && options.runtimeConfig) {
                options.runtimeConfig = this.runtimeConfigResolver.sanitizeResolvedRuntime(options.modelSpec, options.runtimeConfig);
            }
            const runRuntime = () => runtimeProvider.runTurn({
                ...options,
                provider,
                mode,
                includeTools,
                includeRules,
                includeEnv,
                skipMemoryOnStart,
                prompt,
                message: prompt,
                history
            }, scopeOptions);
            return this.retryPolicy.run(runRuntime, this._buildRetryOptions(options, provider));
        }
        const concurrencyMode = this.scheduler.normalizeConcurrencyMode(
            options.concurrencyMode || options.concurrency_mode || (options.skipLock ? 'parallel' : 'queued')
        );
        this.scheduler.preemptBackgroundIfNeeded(mode, preemptible);

        if (!options.runtimeConfig && options.model) {
            const { spec, runtime } = await this.runtimeConfigResolver.loadModelRuntime(provider, options.model, scopeOptions);
            options.modelSpec = spec;
            options.runtimeConfig = runtime;
        }

        if (options.modelSpec && options.runtimeConfig) {
            options.runtimeConfig = this.runtimeConfigResolver.sanitizeResolvedRuntime(options.modelSpec, options.runtimeConfig);
        }

        const scheduling = await this.scheduler.resolveSchedulingDecision({
            provider,
            concurrencyMode,
            modelSpec: options.modelSpec,
            runtimeConfig: options.runtimeConfig,
            ...scopeOptions
        });

        if (!options.thinkingMode) {
            if (options.runtimeConfig?.reasoning) {
                options.thinkingMode = options.runtimeConfig.reasoning.enabled ? 'think' : 'off';
            }
            const thinkingMode = await this._getSetting('llm.thinkingMode', scopeOptions);
            if (!options.runtimeConfig?.reasoning && thinkingMode && thinkingMode !== 'off') {
                options.thinkingMode = thinkingMode;
            }
        }

        const agentId = options.agentId || null;
        const nativeWorkspaceRoot = this.mcpServer?.getExecutionRoot
            ? await this.mcpServer.getExecutionRoot({
                sessionId: options.sessionId || null,
                agentId,
                requestContext: options.requestContext || null
            })
            : null;
        const systemPrompt = options.systemPrompt !== undefined
            ? String(options.systemPrompt || '')
            : await this.promptBuilder.buildSystemPrompt({
                includeTools,
                includeRules,
                includeEnv,
                skipMemoryOnStart,
                sessionId: options.sessionId,
                agentId,
                requestContext: options.requestContext || null,
                completionTools: options.completionTools || [],
                nativeWorkspaceRoot
            });

        if (includeTools && provider === 'ollama') {
            const toolContext = {
                sessionId: options.sessionId || null,
                agentId,
                requestContext: options.requestContext || null
            };
            const activeTools = this.mcpServer?.getActiveToolsForContext
                ? await this.mcpServer.getActiveToolsForContext(toolContext)
                : [];
            options.tools = activeTools.map(tool => ({
                type: 'function',
                function: {
                    name: tool.name,
                    description: tool.description || '',
                    parameters: tool.inputSchema || { type: 'object', properties: {} }
                }
            }));
        }

        const messages = [
            { role: 'system', content: systemPrompt },
            ...history,
            ...(prompt ? [{ role: 'user', content: prompt }] : [])
        ];
        const promptCache = this._buildPromptCacheHint({
            provider,
            model: options.model,
            mode,
            sessionId: options.sessionId,
            agentId,
            systemPrompt
        });

        const execute = async () => {
            console.log(`[Dispatcher] mode=${mode} model=${options.model || 'default'} tools=${includeTools} rules=${includeRules} provider=${provider} concurrency=${scheduling.effectiveMode} lane=${scheduling.laneKey || 'none'} historyLen=${history.length}`);
            const response = await this.retryPolicy.run(
                () => this.aiService.sendMessage(messages, { ...options, ...scopeOptions, provider, promptCache }),
                this._buildRetryOptions(options, provider)
            );
            response.renderContext = {
                provider,
                model: options.model || response.model || '',
                runtimeConfig: options.runtimeConfig ? JSON.parse(JSON.stringify(options.runtimeConfig)) : null,
                requestContext: scopeOptions.requestContext || null,
                concurrency: {
                    requestedMode: scheduling.requestedMode,
                    effectiveMode: scheduling.effectiveMode,
                    needsEnablement: scheduling.needsEnablement
                }
            };
            response.concurrency = {
                requested_mode: scheduling.requestedMode,
                effective_mode: scheduling.effectiveMode,
                provider,
                lane: scheduling.laneKey || null,
                global_enabled: scheduling.globalEnabled,
                needs_enablement: scheduling.needsEnablement
            };
            await this.runtimeConfigResolver.rememberWorkingRuntimeParams(provider, options.model, options.modelSpec, options.runtimeConfig, response, scopeOptions);
            return response;
        };

        return this.scheduler.executeScheduled(scheduling.laneKey, execute, { mode, preemptible, provider });
    }

    confirmRetry(requestId) {
        return this.retryPolicy.confirm(requestId);
    }

    _buildRetryOptions(options, provider) {
        const retryOptions = { ...options, provider };
        if (!retryOptions.onRetryStatus && options.sessionId && this.aiService?.windowManager?.send) {
            retryOptions.onRetryStatus = (status) => this.aiService.windowManager.send('inference-retry-status', status);
        }
        return retryOptions;
    }

    async _buildSystemPrompt(options = {}) {
        return this.promptBuilder.buildSystemPrompt(options);
    }

    async _buildToolContext(options = {}) {
        return this.promptBuilder.buildToolContext(options);
    }

    async _rememberWorkingRuntimeParams(provider, model, modelSpec, runtimeConfig, response, options = {}) {
        return this.runtimeConfigResolver.rememberWorkingRuntimeParams(provider, model, modelSpec, runtimeConfig, response, options);
    }

    _buildPromptCacheHint({ provider, model, mode, sessionId, agentId, systemPrompt }) {
        if (mode !== 'chat') return null;
        const scopedSession = String(sessionId || 'default').trim() || 'default';
        const scopedAgent = String(agentId || 'chat').trim() || 'chat';
        const scopedModel = String(model || 'default').trim() || 'default';
        const promptFingerprint = this._hashPromptFingerprint(systemPrompt);
        return {
            enabled: true,
            key: `localagent:${provider || 'provider'}:${scopedModel}:${scopedAgent}:${scopedSession}:${promptFingerprint}`,
            retention: provider === 'openrouter' ? '1h' : null
        };
    }

    _hashPromptFingerprint(text) {
        const s = String(text || '');
        const sample = s.slice(0, 200);
        let hash = 5381;
        for (let i = 0; i < sample.length; i++) {
            hash = ((hash << 5) + hash + sample.charCodeAt(i)) >>> 0;
        }
        return `${s.length}x${hash.toString(36)}`;
    }
}

module.exports = InferenceDispatcher;
