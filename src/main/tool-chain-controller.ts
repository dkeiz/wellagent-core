// @ts-nocheck
/**
 * Tool Chain Controller
 * 
 * Manages multi-step tool execution with auto-continuation.
 * When LLM calls a tool and gets a result, this controller decides
 * whether to continue (if LLM just echoed the result) or stop.
 */

const { stripToolPatterns: stripToolText } = require('./ipc/shared-utils');
const { isPrivateSessionId } = require('./private-session-store');
const { getEffectiveLlmSelection } = require('./llm-state');

class ToolChainController {
    constructor(dispatcher, mcpServer, db) {
        this.dispatcher = dispatcher;
        this.mcpServer = mcpServer;
        this.db = db;
        this.maxChainSteps = Number.POSITIVE_INFINITY;
        this.currentChain = []; // Last completed chain, exposed for workflow learning
        this.activeRunStates = new Set();
        this.sessionQueues = new Map();
        this.stoppedRuns = new Set(); // Run-scoped aborts for delegated subagents
        this.workflowManager = null; // Set via setWorkflowManager()
        this.localShardProcessManager = null;
        this.codexRuntimeManager = null;
        this.autoCapture = false; // Toggle via setAutoCapture()
        this.nonDedupeTools = new Set([
            'subagent',
            'run_subagent'
        ]);
    }

    /**
     * Set the workflow manager for auto-capture
     */
    setWorkflowManager(wm) {
        this.workflowManager = wm;
    }

    setLocalShardProcessManager(manager) {
        this.localShardProcessManager = manager || null;
    }

    setCodexRuntimeManager(manager) {
        this.codexRuntimeManager = manager || null;
    }

    async _tryRunOnShard(message, conversationHistory = [], options = {}) {
        const rawAgentId = options.agentId;
        const normalizedAgentId = Number(String(rawAgentId ?? '').trim());
        const agentId = Number.isInteger(normalizedAgentId) && normalizedAgentId > 0
            ? normalizedAgentId
            : null;
        if (options.skipShardDelegation === true) {
            return null;
        }
        if (!agentId || !this.localShardProcessManager?.runAgentTurn) {
            return null;
        }
        try {
            return await this.localShardProcessManager.runAgentTurn({
                agentId,
                history: conversationHistory,
                message,
                options,
                sessionId: options.sessionId || null
            }, { requestContext: options.requestContext || null });
        } catch (error) {
            if (/not configured for sharded execution/i.test(String(error?.message || ''))) {
                return null;
            }
            throw error;
        }
    }

    async _tryRunOnRuntime(message, conversationHistory = [], options = {}) {
        const scopeOptions = {
            requestContext: options.requestContext || null,
            userId: options.userId || undefined
        };
        const selection = await getEffectiveLlmSelection(this.db, scopeOptions);
        const provider = String(
            options.provider
            || selection.provider
            || this.dispatcher?.aiService?.getCurrentProvider?.()
            || ''
        ).trim().toLowerCase();
        const runtimeProvider = this.dispatcher?.aiService?.getRuntimeProvider?.(provider)
            || (this.codexRuntimeManager?.isRuntimeProvider?.(provider) ? this.codexRuntimeManager : null);
        if (!provider || !runtimeProvider?.runTurn) {
            return null;
        }
        return runtimeProvider.runTurn({
            ...options,
            provider,
            mode: options.mode || 'chat',
            message,
            history: conversationHistory
        }, scopeOptions);
    }

    /**
     * Toggle auto-capture of successful tool chains as workflows
     */
    setAutoCapture(enabled) {
        this.autoCapture = enabled;
        console.log(`[Chain] Auto-capture ${enabled ? 'enabled' : 'disabled'}`);
    }

    /**
     * Stop the current chain
     */
    stopChain(runId = null) {
        const scopedRunId = String(runId || '').trim();
        if (scopedRunId) {
            this.stoppedRuns.add(scopedRunId);
            for (const state of this.activeRunStates) {
                if (state.runId === scopedRunId) state.stopped = true;
            }
            console.log(`[Chain] Chain stopped by user for run ${scopedRunId}`);
            return;
        }
        for (const state of this.activeRunStates) state.stopped = true;
        console.log('[Chain] Chain stopped by user');
    }

    _isStopped(options = {}, runState = null) {
        const scopedRunId = String(options.subagentRunId || '').trim();
        return runState?.stopped === true || Boolean(scopedRunId && this.stoppedRuns.has(scopedRunId));
    }

    async _emitTrace(trace, hookName, payload) {
        if (!trace || typeof trace[hookName] !== 'function') {
            return;
        }

        try {
            await trace[hookName](payload);
        } catch (error) {
            console.error(`[Chain] Trace hook ${hookName} failed:`, error.message);
        }
    }

    /**
     * Strip TOOL: patterns from text (brace-depth aware)
     */
    stripToolPatterns(text) {
        return stripToolText(text);
    }

    _decodeXmlEntities(text) {
        return String(text || '')
            .replace(/&quot;/gi, '"')
            .replace(/&apos;/gi, "'")
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/&amp;/gi, '&');
    }

    _coerceInvokeParamValue(rawValue) {
        const value = this._decodeXmlEntities(rawValue).trim();
        if (!value) return '';

        if ((value.startsWith('{') && value.endsWith('}')) || (value.startsWith('[') && value.endsWith(']'))) {
            try {
                return JSON.parse(value);
            } catch (_) {
                return value;
            }
        }

        if (/^-?\d+(\.\d+)?$/.test(value)) {
            const parsed = Number(value);
            if (Number.isFinite(parsed)) {
                return parsed;
            }
        }

        if (/^(true|false)$/i.test(value)) {
            return value.toLowerCase() === 'true';
        }

        if (/^null$/i.test(value)) {
            return null;
        }

        return value;
    }

    _normalizeInvokeToolCalls(text) {
        const source = String(text || '');
        const invokePattern = /<invoke\s+name\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/invoke>/gi;
        const toolLines = [];
        let match;

        while ((match = invokePattern.exec(source)) !== null) {
            const toolName = String(match[1] || '').trim();
            if (!toolName) continue;

            const params = {};
            const body = String(match[2] || '');
            const paramPattern = /<parameter\s+name\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/parameter>/gi;
            let paramMatch;
            while ((paramMatch = paramPattern.exec(body)) !== null) {
                const key = String(paramMatch[1] || '').trim();
                if (!key) continue;
                params[key] = this._coerceInvokeParamValue(paramMatch[2] || '');
            }

            toolLines.push(`TOOL:${toolName}${JSON.stringify(params)}`);
        }

        if (toolLines.length === 0) {
            return source;
        }

        return `${source}\n${toolLines.join('\n')}`;
    }

    _getDuplicateExecution(call, executedToolCalls = new Map()) {
        if (!call || !call.toolName) {
            return null;
        }
        if (this.nonDedupeTools.has(call.toolName)) {
            return null;
        }

        const dedupeKey = `${call.toolName}:${JSON.stringify(call.params)}`;
        return Array.from(executedToolCalls.values())
            .find(prev => `${prev.toolName}:${JSON.stringify(prev.params)}` === dedupeKey) || null;
    }

    _shouldSkipDuplicate(call, executedToolCalls) {
        return Boolean(this._getDuplicateExecution(call, executedToolCalls));
    }

    _buildToolResultsMessage(toolContext, originalUserMessage) {
        return `<tool_results>\n${toolContext}\n</tool_results>\n\n<original_user_question>${originalUserMessage}</original_user_question>\nThe tool results above were auto-generated by the backend. Based on these results, provide a natural, helpful answer to the original user question shown above. Do NOT call these same tools again.`;
    }

    _extractLlmAttachments(result) {
        const attachments = Array.isArray(result?.llmAttachments) ? result.llmAttachments : [];
        return attachments.filter(attachment => (
            attachment?.type === 'image'
            && typeof attachment.path === 'string'
            && attachment.path.trim()
        ));
    }

    _publicToolResult(result) {
        if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
        const { llmAttachments, ...publicResult } = result;
        return publicResult;
    }

    _buildDispatchOptions(options = {}, completionTools = new Set()) {
        const dispatchOptions = {
            mode: options.mode || 'chat',
            sessionId: options.sessionId,
            agentId: options.agentId
        };
        const passthroughKeys = [
            'provider',
            'model',
            'modelSpec',
            'runtimeConfig',
            'thinkingMode',
            'temperature',
            'max_tokens',
            'concurrencyMode',
            'concurrency_mode',
            'runtimePolicyProfile',
            'runtime_policy_profile',
            'runtimePolicyGrants',
            'runtime_policy_grants',
            'policyProfile',
            'principal',
            'requestContext',
            'systemPrompt',
            'subagentRunId',
            'includeTools',
            'includeRules',
            'includeEnv',
            'skipMemoryOnStart',
            'skipLock',
            'preemptible',
            'attachments',
            'turnEvents',
            'onRetryStatus'
        ];

        for (const key of passthroughKeys) {
            if (options[key] !== undefined) {
                dispatchOptions[key] = options[key];
            }
        }
        if (completionTools.size > 0) {
            dispatchOptions.completionTools = Array.from(completionTools);
        }
        return dispatchOptions;
    }

    _buildToolExecutionContext(options = {}) {
        const context = {
            sessionId: options.sessionId,
            source: options.mode === 'chat' ? 'chat-llm' : (options.mode || 'unknown'),
            agentId: options.agentId || null,
            subagentRunId: options.subagentRunId || null
        };
        const runtimePolicyProfile = options.runtimePolicyProfile
            || options.runtime_policy_profile
            || options.policyProfile
            || null;
        const runtimePolicyGrants = options.runtimePolicyGrants
            || options.runtime_policy_grants
            || null;
        if (runtimePolicyProfile) context.runtimePolicyProfile = runtimePolicyProfile;
        if (runtimePolicyGrants) context.runtimePolicyGrants = runtimePolicyGrants;
        if (options.principal) context.principal = options.principal;
        if (options.requestContext) context.requestContext = options.requestContext;
        return context;
    }

    /**
     * Execute a message with tool chaining support
     * @param {string} message - User message
     * @param {Array} conversationHistory - Previous conversation
     * @param {Object} options - Additional options
     * @returns {Object} Final response with chain info
     */
    async executeWithChaining(message, conversationHistory = [], options = {}) {
        const sessionId = String(options.sessionId || '').trim();
        const userId = String(options.requestContext?.userId || options.userId || 'localuser').trim();
        if (!sessionId) return this._executeWithChaining(message, conversationHistory, options);
        const queueKey = `${userId}:${sessionId}`;
        const previous = this.sessionQueues.get(queueKey) || Promise.resolve();
        const run = previous.catch(() => {}).then(() => this._executeWithChaining(message, conversationHistory, options));
        this.sessionQueues.set(queueKey, run);
        try {
            return await run;
        } finally {
            if (this.sessionQueues.get(queueKey) === run) this.sessionQueues.delete(queueKey);
        }
    }

    async _executeWithChaining(message, conversationHistory = [], options = {}) {
        const runState = {
            chain: [],
            executedToolCalls: new Map(),
            stopped: false,
            runId: String(options.subagentRunId || options.chainRunId || '').trim()
        };
        this.activeRunStates.add(runState);
        try {
        const isPrivateMode = options.private === true || isPrivateSessionId(options.sessionId);
        const completionTools = new Set(options.completionTools || []);
        const trace = isPrivateMode ? null : (options.trace || null);
        let stepCount = 0;
        let currentMessage = message;
        let originalUserMessage = message; // Keep reference to user's actual question
        let workingHistory = [...conversationHistory];
        let finalResponse = null;
        let lastLLMResponse = null; // Track last response for fallback
        const activeLlmAttachments = (Array.isArray(options.attachments) ? options.attachments : [])
            .filter(attachment => attachment?.type === 'image' && attachment.path);

        const shardResponse = await this._tryRunOnShard(message, conversationHistory, options);
        if (shardResponse) {
            return {
                ...shardResponse,
                chain: {
                    steps: 1,
                    tools: [],
                    private: isPrivateMode,
                    remote: true
                }
            };
        }

        const maxSteps = await this._resolveMaxChainSteps(options);

        while (stepCount < maxSteps) {
            // Check if chain was stopped by user
            if (this._isStopped(options, runState)) {
                console.log('[Chain] Chain stopped by user');
                break;
            }

            stepCount++;
            console.log(`[Chain] Step ${stepCount}: Processing message`);

            // Send message to LLM via dispatcher.
            // On continuation steps, currentMessage is null — tool results are in workingHistory.
            const dispatchOptions = this._buildDispatchOptions(options, completionTools);
            if (stepCount > 1) {
                dispatchOptions.skipMemoryOnStart = true;
                delete dispatchOptions.attachments;
                if (activeLlmAttachments.length > 0) {
                    dispatchOptions.attachments = activeLlmAttachments;
                }
            }

            const response = await this.dispatcher.dispatch(currentMessage, workingHistory, dispatchOptions);
            if (this._isStopped(options, runState)) {
                console.log('[Chain] Chain stopped by user');
                break;
            }
            lastLLMResponse = response;

            // Parse tool calls from response
            const parseableResponse = response.reasoning
                ? `<think>\n${response.reasoning}\n</think>\n${response.content || ''}`
                : response.content;
            const normalizedContent = this._normalizeInvokeToolCalls(String(parseableResponse || ''));
            const textualToolCalls = this.mcpServer.parseToolCall(normalizedContent);
            const nativeToolCalls = Array.isArray(response.toolCalls) && response.toolCalls.length > 0
                ? this.mcpServer.parseToolCall(JSON.stringify({ tool_calls: response.toolCalls }))
                : [];
            const nativeCallKeys = new Set(nativeToolCalls.map(call => (
                call.toolName + ':' + JSON.stringify(call.params)
            )));
            const toolCalls = [...textualToolCalls];
            for (const call of nativeToolCalls) {
                const duplicate = toolCalls.some(existing => (
                    existing.toolName === call.toolName
                    && JSON.stringify(existing.params) === JSON.stringify(call.params)
                ));
                if (!duplicate) toolCalls.push(call);
            }
            await this._emitTrace(trace, 'onAssistantMessage', {
                step: stepCount,
                content: response.content,
                toolCalls
            });

            if (toolCalls.length === 0) {
                // No tool calls - this is the final answer
                // Clean any leftover TOOL: patterns from content
                finalResponse = {
                    ...response,
                    content: this.stripToolPatterns(response.content) || response.content
                };
                break;
            }

            // Execute tool calls
            const toolResults = [];
            let attemptedThisStep = false;
            for (const call of toolCalls) {
                try {
                    if (this._isStopped(options, runState)) {
                        console.log('[Chain] Chain stopped by user');
                        break;
                    }
                    // Check for duplicate tool call
                    const duplicateExecution = this._getDuplicateExecution(call, runState.executedToolCalls);
                    if (duplicateExecution) {
                        console.log(`[Chain] Skipping duplicate tool call: ${call.toolName}`);
                        attemptedThisStep = true;
                        toolResults.push({
                            toolCallId: call.toolCallId,
                            tool: call.toolName,
                            params: call.params,
                            timestamp: duplicateExecution.timestamp,
                            success: duplicateExecution.success === true,
                            result: duplicateExecution.result,
                            error: duplicateExecution.error
                        });
                        continue;
                    }
                    attemptedThisStep = true;
                    await this._emitTrace(trace, 'onToolQueued', {
                        step: stepCount,
                        toolCallId: call.toolCallId,
                        toolName: call.toolName,
                        params: call.params
                    });

                    // Pass tool call ID to executeTool
                    const result = await this.mcpServer.executeTool(
                        call.toolName,
                        call.params,
                        call.toolCallId,  // Pass the unique ID
                        {
                            context: this._buildToolExecutionContext(options)
                        }
                    );
                    const llmAttachments = this._extractLlmAttachments(result?.result);
                    let publicResult = this._publicToolResult(result?.result);
                    const visionCapability = options.modelSpec?.capabilities?.modalities?.vision;
                    if (llmAttachments.length > 0 && visionCapability === false) {
                        publicResult = {
                            ...publicResult,
                            inspection: {
                                attached: false,
                                reason: 'active_model_does_not_support_vision'
                            }
                        };
                    } else if (llmAttachments.length > 0) {
                        for (const attachment of llmAttachments) {
                            const duplicate = activeLlmAttachments.some(existing => (
                                existing.type === attachment.type && existing.path === attachment.path
                            ));
                            if (!duplicate) activeLlmAttachments.push(attachment);
                        }
                    }

                    if (completionTools.has(call.toolName)) {
                        finalResponse = {
                            content: this.stripToolPatterns(response.content) || response.content,
                            reasoning: response.reasoning || '',
                            model: response.model,
                            usage: response.usage,
                            chainComplete: true,
                            completionTool: call.toolName,
                            completionResult: result.result,
                            renderContext: response.renderContext
                        };
                        break;
                    }

                    // Check if it's the special end_answer tool
                    if (call.toolName === 'end_answer') {
                        finalResponse = {
                            content: result.result?.answer || this.stripToolPatterns(response.content) || response.content,
                            reasoning: response.reasoning || '',
                            model: response.model,
                            usage: response.usage,
                            chainComplete: true,
                            renderContext: response.renderContext
                        };
                        break;
                    }

                    // Check for permission requirement
                    if (result && result.needsPermission) {
                        // Return the LLM's text (stripped of TOOL: calls) with permission info
                        finalResponse = {
                            content: this.stripToolPatterns(response.content) || response.content,
                            reasoning: response.reasoning || '',
                            model: response.model,
                            needsPermission: true,
                            permissionRequest: result,
                            renderContext: response.renderContext
                        };
                        break;
                    }
                    // Track this execution
                    runState.executedToolCalls.set(call.toolCallId, {
                        toolName: call.toolName,
                        params: call.params,
                        success: true,
                        result: publicResult,
                        timestamp: result.timestamp
                    });

                    toolResults.push({
                        toolCallId: call.toolCallId,  // Include unique ID
                        tool: call.toolName,
                        params: call.params,
                        timestamp: result.timestamp,  // Include timestamp
                        success: true,
                        result: publicResult  // Unwrap the actual result
                    });
                    await this._emitTrace(trace, 'onToolResult', {
                        step: stepCount,
                        toolCallId: call.toolCallId,
                        toolName: call.toolName,
                        params: call.params,
                        success: true,
                        result: publicResult,
                        timestamp: result.timestamp
                    });

                    if (!isPrivateMode) {
                        // Add to current chain for workflow learning
                        runState.chain.push({
                            tool: call.toolName,
                            params: call.params,
                            result: publicResult
                        });
                    }

                } catch (error) {
                    runState.executedToolCalls.set(call.toolCallId, {
                        toolName: call.toolName,
                        params: call.params,
                        success: false,
                        error: error.message,
                        timestamp: new Date().toISOString()
                    });
                    toolResults.push({
                        toolCallId: call.toolCallId,
                        tool: call.toolName,
                        params: call.params,
                        success: false,
                        error: error.message
                    });
                    await this._emitTrace(trace, 'onToolResult', {
                        step: stepCount,
                        toolCallId: call.toolCallId,
                        toolName: call.toolName,
                        params: call.params,
                        success: false,
                        error: error.message
                    });
                }
            }

            // If we got a final response (end_answer or permission needed), break
            if (finalResponse) break;
            if (!attemptedThisStep) {
                finalResponse = {
                    ...response,
                    content: this.stripToolPatterns(response.content) || response.content
                };
                break;
            }

            // Build tool results context with tracking metadata
            const toolContext = toolResults.map(r => {
                if (r.success) {
                    return `[Tool Call ID: ${r.toolCallId}]
Tool: "${r.tool}"
Timestamp: ${r.timestamp}
Result: ${JSON.stringify(r.result)}

✓ This tool was successfully executed. Do NOT call it again with the same parameters.`;
                } else {
                    return `[Tool Call ID: ${r.toolCallId}]
Tool: "${r.tool}"
Error: ${r.error}`;
                }
            }).join('\n\n---\n\n');

            if (nativeToolCalls.length > 0) {
                if (stepCount === 1) {
                    workingHistory.push({ role: 'user', content: originalUserMessage });
                }
                workingHistory.push({
                    role: 'assistant',
                    content: response.content || '',
                    tool_calls: response.toolCalls
                });
                for (const result of toolResults) {
                    const resultKey = result.tool + ':' + JSON.stringify(result.params);
                    if (!nativeCallKeys.has(resultKey)) continue;
                    workingHistory.push({
                        role: 'tool',
                        tool_name: result.tool,
                        content: JSON.stringify(result.success
                            ? { success: true, result: result.result, timestamp: result.timestamp }
                            : { success: false, error: result.error })
                    });
                }
                const nativeReminder = `<original_user_question>${originalUserMessage}</original_user_question>\nContinue answering this request using the successful tool results above. Do not call a successfully completed tool again with the same parameters. Do not lose or replace the original request.`;
                workingHistory.push({ role: 'user', content: nativeReminder });
                await this._emitTrace(trace, 'onSyntheticUserMessage', {
                    step: stepCount,
                    content: nativeReminder,
                    kind: 'native_tool_continuation'
                });

                const textualResults = toolResults.filter(result => (
                    !nativeCallKeys.has(result.tool + ':' + JSON.stringify(result.params))
                ));
                if (textualResults.length > 0) {
                    const textualContext = textualResults.map(result => result.success
                        ? `Tool: "${result.tool}"\nResult: ${JSON.stringify(result.result)}`
                        : `Tool: "${result.tool}"\nError: ${result.error}`
                    ).join('\n\n---\n\n');
                    const textualResultsMessage = this._buildToolResultsMessage(textualContext, originalUserMessage);
                    workingHistory.push({ role: 'user', content: textualResultsMessage });
                    await this._emitTrace(trace, 'onSyntheticUserMessage', {
                        step: stepCount,
                        content: textualResultsMessage,
                        kind: 'tool_results'
                    });
                }
            } else {
                const toolResultsMessage = this._buildToolResultsMessage(toolContext, originalUserMessage);
                // Textual formats continue through the existing normalized
                // assistant + synthetic tool-results continuation.
                workingHistory.push({ role: 'assistant', content: response.content });
                workingHistory.push({ role: 'user', content: toolResultsMessage });
                await this._emitTrace(trace, 'onSyntheticUserMessage', {
                    step: stepCount,
                    content: toolResultsMessage,
                    kind: 'tool_results'
                });
            }

            // CRITICAL FIX: Set to null so sendMessage doesn't add another empty user message
            currentMessage = null;
        }

        // Handle case where loop ended without finalResponse (maxSteps exceeded)
        if (!finalResponse && lastLLMResponse) {
            console.log('[Chain] Max steps reached, using last response');
            finalResponse = {
                ...lastLLMResponse,
                content: this.stripToolPatterns(lastLLMResponse.content) || 'I ran into an issue processing your request. Please try again.',
                chainExhausted: true,
                maxChainSteps: maxSteps,
                reasoning: lastLLMResponse.reasoning || '',
                renderContext: lastLLMResponse.renderContext
            };
        }

        // Safety: ensure we always return something
        if (!finalResponse) {
            if (this._isStopped(options, runState)) {
                finalResponse = { content: '', stopped: true, reasoning: '', renderContext: null };
            } else {
                const error = new Error('Tool chain ended without a final model response');
                error.code = 'TOOL_CHAIN_NO_FINAL_RESPONSE';
                throw error;
            }
        }

        // Add chain metadata to response
        finalResponse.chain = {
            steps: stepCount,
            tools: isPrivateMode ? [] : runState.chain.map(c => c.tool),
            private: isPrivateMode
        };

        // Auto-capture successful chains as workflows (2+ unique tools)
        if (!isPrivateMode && this.autoCapture && this.workflowManager && runState.chain.length >= 2 && !finalResponse.chainExhausted) {
            try {
                const originalMsg = options._originalMessage || message || '';
                await this.workflowManager.captureWorkflow(originalMsg, runState.chain, null, { requestContext: options.requestContext || null });
                console.log(`[Chain] Auto-captured workflow from ${runState.chain.length}-step chain`);
            } catch (err) {
                console.error('[Chain] Auto-capture failed:', err.message);
            }
        }

        this.currentChain = runState.chain.slice();
        return finalResponse;
        } finally {
            this.activeRunStates.delete(runState);
            if (runState.runId) this.stoppedRuns.delete(runState.runId);
        }
    }

    async _resolveMaxChainSteps(options = {}) {
        const fromOptions = Number(options.maxChainSteps);
        if (Number.isFinite(fromOptions) && fromOptions > 0) {
            return Math.max(1, Math.floor(fromOptions));
        }

        if (this.db && typeof this.db.getSetting === 'function') {
            try {
                const setting = await this.db.getSetting('tool_chain_max_steps');
                const parsed = Number(setting);
                if (Number.isFinite(parsed) && parsed > 0) {
                    return Math.max(1, Math.floor(parsed));
                }
            } catch (error) {
                // Fall through to default.
            }
        }

        return this.maxChainSteps;
    }

    /**
     * Get the current tool chain (for workflow learning)
     */
    getCurrentChain() {
        return this.currentChain;
    }

    /**
     * Clear the current chain
     */
    clearChain() {
        this.currentChain = [];
    }
}

module.exports = ToolChainController;
