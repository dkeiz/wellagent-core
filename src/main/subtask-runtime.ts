// @ts-nocheck
const fs = require('fs');
const path = require('path');
const { buildSubagentIdentifiers } = require('./subagent-contract');
const { isPrivateSessionId } = require('./private-session-store');
const { buildRuntimePaths } = require('./runtime-paths');
const { resolveAgentScope } = require('./agent-ownership');
const {
    appendJsonLine,
    appendTraceSection,
    ensureDir,
    generateRunId,
    initRunBase,
    listRunDirectories,
    readJson,
    writeJson,
    writeTraceFile
} = require('./run-store-utils');

function hasRunScopeFilter(input = {}) {
    return Boolean(input && typeof input === 'object' && (
        input.userId || input.user_id || (input.requestContext && typeof input.requestContext === 'object')
    ));
}

function matchesOwnedRun(run, input = {}) {
    if (!hasRunScopeFilter(input)) return true;
    const scope = resolveAgentScope(input);
    return String(run?.user_id || 'localuser').trim() === scope.userId;
}

class SubtaskRuntime {
    constructor(db, sessionWorkspace = null, eventBus = null, basePath = null, options = {}) {
        this.db = db;
        this.sessionWorkspace = sessionWorkspace;
        this.eventBus = eventBus;
        this.basePath = basePath || buildRuntimePaths().subtaskBasePath;
        this.runsPath = path.join(this.basePath, 'runs');
        this.inboxesPath = path.join(this.basePath, 'inboxes');
        this.persistConversationMessage = typeof options.persistConversationMessage === 'function'
            ? options.persistConversationMessage
            : null;
        this.notifyConversationUpdate = typeof options.notifyConversationUpdate === 'function'
            ? options.notifyConversationUpdate
            : null;
        this.privateRuns = new Map();
    }

    initialize() {
        initRunBase(this.basePath, ['runs', 'inboxes']);
        this.cleanupStale(24);
    }

    createRun({
        parentSessionId = null,
        subagentId,
        agentName,
        task,
        contractType = 'task_complete',
        expectedOutput = '',
        subagentMode = 'no_ui',
        provider = null,
        queue_provider = null,
        concurrency_mode = 'queued',
        runtimePolicyProfile = 'strict-subagent', runtimePolicyGrants = {},
        requestContext = null
    }) {
        const scope = resolveAgentScope({ requestContext });
        if (isPrivateSessionId(parentSessionId)) {
            return this._createPrivateRun({
                parentSessionId,
                subagentId,
                agentName,
                task,
                contractType,
                expectedOutput,
                subagentMode,
                provider,
                queue_provider,
                concurrency_mode,
                runtimePolicyProfile,
                runtimePolicyGrants,
                requestContext: scope.requestContext,
                userId: scope.userId
            });
        }

        this.cleanupStale(24);
        const runId = this._generateRunId();
        const runDir = path.join(this.runsPath, runId);
        const childSessionId = runId;
        const artifactsDir = path.join(runDir, 'artifacts');
        const workspaceDir = this.sessionWorkspace
            ? this.sessionWorkspace.getWorkspacePath(childSessionId)
            : path.join(runDir, 'workspace');
        const requestPath = path.join(runDir, 'request.json');
        const statusPath = path.join(runDir, 'status.json');
        const resultPath = path.join(runDir, 'result.json');
        const messagesPath = path.join(runDir, 'messages.jsonl');
        const tracePath = path.join(runDir, 'trace.md');

        ensureDir(runDir);
        ensureDir(artifactsDir);
        ensureDir(workspaceDir);

        const createdAt = new Date().toISOString();
        const request = {
            run_id: runId,
            parent_session_id: parentSessionId,
            child_session_id: childSessionId,
            subagent_id: subagentId,
            identifiers: buildSubagentIdentifiers({
                run_id: runId,
                parent_session_id: parentSessionId,
                child_session_id: childSessionId,
                subagent_id: subagentId
            }),
            agent_name: agentName,
            task,
            contract_type: contractType,
            expected_output: expectedOutput,
            subagent_mode: subagentMode,
            provider: provider || null,
            queue_provider: queue_provider || null,
            concurrency_mode: String(concurrency_mode || 'queued').trim().toLowerCase() === 'parallel' ? 'parallel' : 'queued',
            runtime_policy_profile: runtimePolicyProfile,
            runtime_policy_grants: runtimePolicyGrants && typeof runtimePolicyGrants === 'object' ? runtimePolicyGrants : {},
            request_context: scope.requestContext,
            user_id: scope.userId,
            created_at: createdAt,
            run_dir: runDir,
            workspace_dir: workspaceDir,
            request_path: requestPath,
            status_path: statusPath,
            result_path: resultPath,
            messages_path: messagesPath,
            trace_path: tracePath,
            artifacts_dir: artifactsDir
        };

        const status = {
            run_id: runId,
            status: 'queued',
            created_at: createdAt,
            updated_at: createdAt,
            parent_session_id: parentSessionId,
            child_session_id: childSessionId,
            subagent_id: subagentId,
            identifiers: buildSubagentIdentifiers({
                run_id: runId,
                parent_session_id: parentSessionId,
                child_session_id: childSessionId,
                subagent_id: subagentId
            }),
            agent_name: agentName,
            contract_type: contractType,
            subagent_mode: subagentMode,
            provider: provider || null,
            queue_provider: queue_provider || null,
            concurrency_mode: String(concurrency_mode || 'queued').trim().toLowerCase() === 'parallel' ? 'parallel' : 'queued',
            runtime_policy_profile: runtimePolicyProfile,
            runtime_policy_grants: runtimePolicyGrants && typeof runtimePolicyGrants === 'object' ? runtimePolicyGrants : {},
            request_context: scope.requestContext,
            user_id: scope.userId,
            summary: '',
            error: null,
            delivered_to_parent: false,
            delivery_path: null,
            run_dir: runDir,
            workspace_dir: workspaceDir,
            result_path: resultPath,
            messages_path: messagesPath,
            trace_path: tracePath
        };

        writeJson(requestPath, request);
        writeJson(statusPath, status);
        this._writeTraceHeader(tracePath, request);

        return this.getRun(runId);
    }

    _createPrivateRun({
        parentSessionId = null,
        subagentId,
        agentName,
        task,
        contractType = 'task_complete',
        expectedOutput = '',
        subagentMode = 'no_ui',
        provider = null,
        queue_provider = null,
        concurrency_mode = 'queued',
        runtimePolicyProfile = 'strict-subagent', runtimePolicyGrants = {},
        requestContext = null,
        userId = 'localuser'
    }) {
        const scope = { requestContext, userId };
        const runId = this._generatePrivateRunId();
        const childSessionId = runId;
        const workspaceDir = this.sessionWorkspace
            ? this.sessionWorkspace.getWorkspacePath(childSessionId)
            : null;
        const createdAt = new Date().toISOString();
        const normalizedConcurrency = String(concurrency_mode || 'queued').trim().toLowerCase() === 'parallel'
            ? 'parallel'
            : 'queued';
        const identifiers = buildSubagentIdentifiers({
            run_id: runId,
            parent_session_id: parentSessionId,
            child_session_id: childSessionId,
            subagent_id: subagentId
        });
        const request = {
            private: true,
            run_id: runId,
            parent_session_id: parentSessionId,
            child_session_id: childSessionId,
            subagent_id: subagentId,
            identifiers,
            agent_name: agentName,
            task,
            contract_type: contractType,
            expected_output: expectedOutput,
            subagent_mode: subagentMode,
            provider: provider || null,
            queue_provider: queue_provider || null,
            concurrency_mode: normalizedConcurrency,
            runtime_policy_profile: runtimePolicyProfile,
            runtime_policy_grants: runtimePolicyGrants && typeof runtimePolicyGrants === 'object' ? runtimePolicyGrants : {},
            request_context: scope.requestContext,
            user_id: scope.userId,
            created_at: createdAt,
            run_dir: null,
            workspace_dir: workspaceDir,
            request_path: null,
            status_path: null,
            result_path: null,
            messages_path: null,
            trace_path: null,
            artifacts_dir: workspaceDir
        };
        const status = {
            private: true,
            run_id: runId,
            status: 'queued',
            created_at: createdAt,
            updated_at: createdAt,
            parent_session_id: parentSessionId,
            child_session_id: childSessionId,
            subagent_id: subagentId,
            identifiers,
            agent_name: agentName,
            contract_type: contractType,
            subagent_mode: subagentMode,
            provider: provider || null,
            queue_provider: queue_provider || null,
            concurrency_mode: normalizedConcurrency,
            runtime_policy_profile: runtimePolicyProfile,
            runtime_policy_grants: runtimePolicyGrants && typeof runtimePolicyGrants === 'object' ? runtimePolicyGrants : {},
            request_context: scope.requestContext,
            user_id: scope.userId,
            summary: '',
            error: null,
            delivered_to_parent: false,
            delivery_path: null,
            run_dir: null,
            workspace_dir: workspaceDir,
            result_path: null,
            messages_path: null,
            trace_path: null
        };
        this.privateRuns.set(runId, { request, status, result: null });
        return this.getRun(runId);
    }

    getRun(runId, options = {}) {
        const privateRun = this.privateRuns.get(String(runId));
        if (privateRun) {
            if (!matchesOwnedRun(privateRun.request, options)) {
                return null;
            }
            return {
                ...privateRun.request,
                ...privateRun.status,
                result: privateRun.result || null
            };
        }

        const requestPath = path.join(this.runsPath, String(runId), 'request.json');
        if (!fs.existsSync(requestPath)) {
            return null;
        }

        const request = readJson(requestPath) || {};
        const status = readJson(request.status_path) || {};
        const result = fs.existsSync(request.result_path)
            ? readJson(request.result_path)
            : null;
        const run = {
            ...request,
            ...status,
            result
        };
        return matchesOwnedRun(run, options) ? run : null;
    }

    listRuns(filters = {}) {
        const {
            limit = 20,
            parentSessionId = null,
            subagentId = null,
            status = null
        } = filters;

        const persistedRuns = fs.existsSync(this.runsPath)
            ? fs.readdirSync(this.runsPath, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .map(entry => {
                try {
                    return this.getRun(entry.name, filters);
                } catch (error) {
                    console.error(`[SubtaskRuntime] Failed to read run "${entry.name}":`, error.message);
                    return null;
                }
            })
            .filter(Boolean)
            .filter(run => parentSessionId === null || String(run.parent_session_id) === String(parentSessionId))
            .filter(run => subagentId === null || Number(run.subagent_id) === Number(subagentId))
            .filter(run => status === null || String(run.status) === String(status))
            : [];

        const privateRuns = Array.from(this.privateRuns.keys())
            .map(runId => this.getRun(runId, filters))
            .filter(Boolean)
            .filter(run => parentSessionId !== null && String(run.parent_session_id) === String(parentSessionId))
            .filter(run => subagentId === null || Number(run.subagent_id) === Number(subagentId))
            .filter(run => status === null || String(run.status) === String(status));

        const runs = [...privateRuns, ...persistedRuns]
            .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));

        return runs.slice(0, Math.max(1, Number(limit) || 20));
    }

    clearRuns(filters = {}) {
        const {
            parentSessionId = null,
            subagentId = null,
            status = null,
            onlyFinished = true,
            includeRunning = false,
            matchText = '',
            runIds = null
        } = filters || {};

        if (!fs.existsSync(this.runsPath)) {
            return { success: true, removed: 0, kept: 0, failed: 0 };
        }

        const normalizedMatch = String(matchText || '').trim().toLowerCase();
        const allowedRunIds = Array.isArray(runIds)
            ? new Set(runIds.map((value) => String(value || '').trim()).filter(Boolean))
            : null;
        const terminalStatuses = new Set(['failed', 'completed', 'task_complete', 'task_failed', 'cancelled', 'stopped']);

        let removed = 0;
        let kept = 0;
        let failed = 0;

        for (const entry of fs.readdirSync(this.runsPath, { withFileTypes: true })) {
            if (!entry.isDirectory()) {
                continue;
            }

            const run = this.getRun(entry.name, filters);
            if (!run) {
                continue;
            }

            const runStatus = String(run.status || '').trim().toLowerCase();
            const isRunningStatus = runStatus === 'queued' || runStatus === 'running' || runStatus === 'cancelling';

            if (allowedRunIds && !allowedRunIds.has(String(run.run_id || '').trim())) {
                kept++;
                continue;
            }
            if (parentSessionId !== null && String(run.parent_session_id) !== String(parentSessionId)) {
                kept++;
                continue;
            }
            if (subagentId !== null && Number(run.subagent_id) !== Number(subagentId)) {
                kept++;
                continue;
            }
            if (status !== null && String(run.status) !== String(status)) {
                kept++;
                continue;
            }
            if (onlyFinished && !terminalStatuses.has(runStatus)) {
                kept++;
                continue;
            }
            if (!includeRunning && isRunningStatus) {
                kept++;
                continue;
            }
            if (normalizedMatch) {
                const haystack = [
                    run.run_id,
                    run.agent_name,
                    run.task,
                    run.parent_session_id
                ].map((value) => String(value || '').toLowerCase()).join(' ');
                if (!haystack.includes(normalizedMatch)) {
                    kept++;
                    continue;
                }
            }

            try {
                fs.rmSync(run.run_dir, { recursive: true, force: true });
                if (this.sessionWorkspace && run.child_session_id) {
                    this.sessionWorkspace.cleanup(run.child_session_id);
                }
                removed++;
            } catch (error) {
                failed++;
                console.error('[SubtaskRuntime] Failed to clear run:', error.message);
            }
        }

        return { success: failed === 0, removed, kept, failed };
    }

    clearPrivateRunsForSession(sessionId) {
        if (!sessionId) {
            return { success: true, removed: 0 };
        }
        let removed = 0;
        for (const [runId, record] of Array.from(this.privateRuns.entries())) {
            const run = this.getRun(runId);
            if (
                String(run?.parent_session_id || '') !== String(sessionId)
                && String(run?.child_session_id || '') !== String(sessionId)
            ) {
                continue;
            }
            if (this.sessionWorkspace && run?.child_session_id) {
                this.sessionWorkspace.cleanup(run.child_session_id);
            }
            this.privateRuns.delete(record.request.run_id);
            removed++;
        }
        return { success: true, removed };
    }

    updateStatus(runId, patch = {}) {
        const privateRecord = this.privateRuns.get(String(runId));
        if (privateRecord) {
            privateRecord.status = {
                ...privateRecord.status,
                ...patch,
                run_id: privateRecord.request.run_id,
                updated_at: new Date().toISOString()
            };
            return this.getRun(runId);
        }

        const run = this.getRun(runId);
        if (!run) {
            throw new Error(`Subtask run not found: ${runId}`);
        }

        const nextStatus = {
            ...readJson(run.status_path),
            ...patch,
            run_id: run.run_id,
            updated_at: new Date().toISOString()
        };

        writeJson(run.status_path, nextStatus);
        return this.getRun(runId);
    }

    markRunning(runId) {
        return this.updateStatus(runId, {
            status: 'running',
            started_at: new Date().toISOString()
        });
    }

    appendMessage(runId, message) {
        if (this.privateRuns.has(String(runId))) {
            return {
                timestamp: new Date().toISOString(),
                type: 'message',
                role: message.role || 'system',
                content: '',
                metadata: { private_trace_suppressed: true }
            };
        }

        const run = this.getRun(runId);
        if (!run) {
            throw new Error(`Subtask run not found: ${runId}`);
        }

        const entry = {
            timestamp: new Date().toISOString(),
            type: 'message',
            role: message.role || 'system',
            content: String(message.content || ''),
            metadata: message.metadata || null
        };

        appendJsonLine(run.messages_path, entry);
        appendTraceSection(run.trace_path, `${entry.role} @ ${entry.timestamp}`, entry.content);
        return entry;
    }

    appendToolEvent(runId, event) {
        if (this.privateRuns.has(String(runId))) {
            return {
                timestamp: new Date().toISOString(),
                type: 'tool',
                tool_name: event.tool_name,
                success: event.success !== false,
                private_trace_suppressed: true
            };
        }

        const run = this.getRun(runId);
        if (!run) {
            throw new Error(`Subtask run not found: ${runId}`);
        }

        const entry = {
            timestamp: new Date().toISOString(),
            type: 'tool',
            tool_name: event.tool_name,
            success: event.success !== false,
            params: event.params || {},
            result: event.result,
            error: event.error || null
        };

        appendJsonLine(run.messages_path, entry);
        const body = entry.success
            ? `Params:\n\n\`\`\`json\n${JSON.stringify(entry.params, null, 2)}\n\`\`\`\n\nResult:\n\n\`\`\`json\n${JSON.stringify(entry.result, null, 2)}\n\`\`\``
            : `Params:\n\n\`\`\`json\n${JSON.stringify(entry.params, null, 2)}\n\`\`\`\n\nError:\n\n${entry.error}`;
        appendTraceSection(run.trace_path, `tool ${entry.tool_name} @ ${entry.timestamp}`, body);
        return entry;
    }

    completeRun(runId, completion) {
        const privateRecord = this.privateRuns.get(String(runId));
        if (privateRecord) {
            const payload = {
                run_id: privateRecord.request.run_id,
                completed_at: new Date().toISOString(),
                contract: completion.contract,
                artifacts: completion.artifacts || completion.contract?.artifacts || [],
                raw_response: '',
                summary: completion.contract?.summary || '',
                private: true
            };
            privateRecord.result = payload;
            this.updateStatus(runId, {
                status: completion.contract?.status || 'completed',
                summary: completion.contract?.summary || '',
                error: null,
                completed_at: payload.completed_at
            });
            return this.getRun(runId);
        }

        const run = this.getRun(runId);
        if (!run) {
            throw new Error(`Subtask run not found: ${runId}`);
        }

        const payload = {
            run_id: run.run_id,
            completed_at: new Date().toISOString(),
            contract: completion.contract,
            artifacts: completion.artifacts || completion.contract?.artifacts || [],
            raw_response: completion.raw_response || '',
            summary: completion.contract?.summary || ''
        };

        writeJson(run.result_path, payload);
        this.updateStatus(runId, {
            status: completion.contract?.status || 'completed',
            summary: completion.contract?.summary || '',
            error: null,
            completed_at: payload.completed_at
        });

        appendTraceSection(
            run.trace_path,
            `completion @ ${payload.completed_at}`,
            `\`\`\`json\n${JSON.stringify(payload.contract, null, 2)}\n\`\`\``
        );

        return this.getRun(runId);
    }

    failRun(runId, error) {
        const privateRecord = this.privateRuns.get(String(runId));
        if (privateRecord) {
            const message = String(error || 'Unknown error');
            const completedAt = new Date().toISOString();
            privateRecord.result = {
                run_id: privateRecord.request.run_id,
                completed_at: completedAt,
                error: message,
                private: true
            };
            this.updateStatus(runId, {
                status: 'failed',
                summary: '',
                error: message,
                completed_at: completedAt
            });
            return this.getRun(runId);
        }

        const run = this.getRun(runId);
        if (!run) {
            throw new Error(`Subtask run not found: ${runId}`);
        }

        const message = String(error || 'Unknown error');
        const completedAt = new Date().toISOString();
        const payload = {
            run_id: run.run_id,
            completed_at: completedAt,
            error: message
        };

        writeJson(run.result_path, payload);
        this.updateStatus(runId, {
            status: 'failed',
            summary: '',
            error: message,
            completed_at: completedAt
        });

        appendTraceSection(run.trace_path, `failure @ ${completedAt}`, message);
        return this.getRun(runId);
    }

    cancelRun(runId, reason = 'Stopped by user') {
        const privateRecord = this.privateRuns.get(String(runId));
        if (privateRecord) {
            const message = String(reason || 'Stopped by user');
            const completedAt = new Date().toISOString();
            privateRecord.result = {
                run_id: privateRecord.request.run_id,
                completed_at: completedAt,
                stopped: true,
                reason: message,
                private: true
            };
            this.updateStatus(runId, {
                status: 'stopped',
                summary: message,
                error: null,
                completed_at: completedAt
            });
            return this.getRun(runId);
        }

        const run = this.getRun(runId);
        if (!run) {
            throw new Error(`Subtask run not found: ${runId}`);
        }

        const message = String(reason || 'Stopped by user');
        const completedAt = new Date().toISOString();
        const payload = {
            run_id: run.run_id,
            completed_at: completedAt,
            stopped: true,
            reason: message
        };

        writeJson(run.result_path, payload);
        this.updateStatus(runId, {
            status: 'stopped',
            summary: message,
            error: null,
            completed_at: completedAt
        });

        appendTraceSection(run.trace_path, `stopped @ ${completedAt}`, message);
        return this.getRun(runId);
    }

    async deliverToParent(runId, delivery) {
        const run = this.getRun(runId);
        if (!run || run.parent_session_id === null || run.parent_session_id === undefined) {
            return null;
        }

        const parentSessionId = String(run.parent_session_id);
        if (run.private === true || isPrivateSessionId(parentSessionId)) {
            const deliveryId = `private-delivery-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const record = {
                private: true,
                delivery_id: deliveryId,
                created_at: new Date().toISOString(),
                parent_session_id: run.parent_session_id,
                run_id: run.run_id,
                child_session_id: run.child_session_id,
                subagent_id: run.subagent_id,
                identifiers: buildSubagentIdentifiers(run),
                agent_name: run.agent_name,
                run_dir: null,
                result_path: null,
                status: delivery.status,
                summary: delivery.summary,
                contract_type: run.contract_type,
                delivered_to_parent: false,
                consumed_at: null,
                contract: delivery.contract,
                delivery_path: null
            };
            const conversationWriter = this.persistConversationMessage || null;
            if (conversationWriter) {
                await conversationWriter({
                    role: 'system',
                    content: this._buildParentDeliveryMessage(run, record),
                    metadata: {
                        private: true,
                        subtask_delivery: {
                            delivery_id: deliveryId,
                            run_id: run.run_id,
                            contract_type: run.contract_type
                        }
                    }
                }, parentSessionId);
                record.delivered_to_parent = true;
                this.updateStatus(run.run_id, {
                    delivered_to_parent: true,
                    delivery_path: null
                });
                this.notifyConversationUpdate?.(parentSessionId);
            }
            return record;
        }

        const inboxDir = path.join(this.inboxesPath, parentSessionId);
        ensureDir(inboxDir);

        const deliveryId = `delivery-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const deliveryPath = path.join(inboxDir, `${deliveryId}.json`);
        const record = {
            delivery_id: deliveryId,
            created_at: new Date().toISOString(),
            parent_session_id: run.parent_session_id,
            run_id: run.run_id,
            child_session_id: run.child_session_id,
            subagent_id: run.subagent_id,
            identifiers: buildSubagentIdentifiers(run),
            agent_name: run.agent_name,
            run_dir: run.run_dir,
            result_path: run.result_path,
            status: delivery.status,
            summary: delivery.summary,
            contract_type: run.contract_type,
            delivered_to_parent: false,
            consumed_at: null,
            contract: delivery.contract
        };

        writeJson(deliveryPath, record);

        let deliveredToParent = false;
        const numericParentId = String(run.parent_session_id).match(/^\d+$/)
            ? Number(run.parent_session_id)
            : null;
        const targetSessionId = numericParentId !== null ? numericParentId : run.parent_session_id;
        const conversationWriter = this.persistConversationMessage
            || (numericParentId !== null && this.db?.addConversation
                ? async (message, sessionId) => this.db.addConversation(message, sessionId)
                : null);

        if (conversationWriter) {
            const content = this._buildParentDeliveryMessage(run, record);
            try {
                await conversationWriter({
                    role: 'system',
                    content,
                    metadata: {
                        subtask_delivery: {
                            delivery_id: deliveryId,
                            run_id: run.run_id,
                            contract_type: run.contract_type,
                            result_path: run.result_path,
                            run_dir: run.run_dir
                        }
                    }
                }, targetSessionId);
                deliveredToParent = true;
                record.delivered_to_parent = true;
                writeJson(deliveryPath, record);
                this.updateStatus(run.run_id, {
                    delivered_to_parent: true,
                    delivery_path: deliveryPath
                });
                try {
                    if (this.notifyConversationUpdate) {
                        this.notifyConversationUpdate(targetSessionId);
                    } else {
                        this.eventBus?.sendToRenderer?.('conversation-update', { sessionId: targetSessionId });
                    }
                } catch (error) {
                    console.error('[SubtaskRuntime] Failed to relay conversation update:', error.message);
                }
            } catch (error) {
                console.error('[SubtaskRuntime] Failed to deliver subtask result to parent session:', error.message);
                this.updateStatus(run.run_id, {
                    delivered_to_parent: false,
                    delivery_path: deliveryPath
                });
            }
        } else {
            this.updateStatus(run.run_id, {
                delivered_to_parent: false,
                delivery_path: deliveryPath
            });
        }

        return {
            ...record,
            delivery_path: deliveryPath,
            delivered_to_parent: deliveredToParent
        };
    }

    cleanupStale(maxAgeHours = 24) {
        if (!fs.existsSync(this.runsPath)) {
            return 0;
        }

        let cleaned = 0;
        const cutoff = Date.now() - (Math.max(1, Number(maxAgeHours) || 24) * 60 * 60 * 1000);

        for (const runId of listRunDirectories(this.runsPath)) {
            const runDir = path.join(this.runsPath, runId);
            try {
                const stat = fs.statSync(runDir);
                if (stat.mtimeMs >= cutoff) {
                    continue;
                }

                const run = this.getRun(runId);
                const status = String(run?.status || '');
                if (status === 'queued' || status === 'running') {
                    continue;
                }

                fs.rmSync(runDir, { recursive: true, force: true });
                if (this.sessionWorkspace && run?.child_session_id) {
                    this.sessionWorkspace.cleanup(run.child_session_id);
                }
                cleaned++;
            } catch (error) {
                console.error('[SubtaskRuntime] Failed to purge stale run:', error.message);
            }
        }

        return cleaned;
    }

    _buildParentDeliveryMessage(run, delivery) {
        const contractBlock = this._formatParentDeliveryContract(delivery?.contract, delivery);
        const identifiers = buildSubagentIdentifiers(run);
        if (run.private === true || delivery?.private === true) {
            return [
                `Private sub-agent "${run.agent_name}" completed a delegated task.`,
                `Status: ${delivery.status}`,
                `Summary: ${delivery.summary}`,
                `Run ID: ${identifiers.run_id || 'n/a'}`,
                '',
                'Structured Result:',
                '```json',
                contractBlock,
                '```'
            ].join('\n');
        }

        return [
            `Sub-agent "${run.agent_name}" completed a delegated task.`,
            `Status: ${delivery.status}`,
            `Summary: ${delivery.summary}`,
            `Run ID: ${identifiers.run_id || 'n/a'}`,
            `Child Session ID: ${identifiers.child_session_id || 'n/a'}`,
            `Parent Session ID: ${identifiers.parent_session_id || 'none'}`,
            `Sub-agent ID: ${identifiers.subagent_id || 'n/a'}`,
            '',
            'Structured Result:',
            '```json',
            contractBlock,
            '```',
            `Run Folder: ${run.run_dir}`,
            `Result File: ${run.result_path}`,
            'Inspect the run files only if you need deeper debugging or the structured result was truncated.'
        ].join('\n');
    }

    _formatParentDeliveryContract(contract, delivery) {
        const normalized = {
            status: contract?.status || delivery?.status || '',
            summary: contract?.summary || delivery?.summary || '',
            data: contract?.data && typeof contract.data === 'object' && !Array.isArray(contract.data)
                ? contract.data
                : {},
            artifacts: Array.isArray(contract?.artifacts) ? contract.artifacts : [],
            notes: contract?.notes ? String(contract.notes) : ''
        };

        const json = JSON.stringify(normalized, null, 2);
        if (json.length <= 6000) {
            return json;
        }

        const truncated = {
            status: normalized.status,
            summary: normalized.summary,
            data_preview: JSON.stringify(normalized.data).slice(0, 2400),
            artifacts: normalized.artifacts.slice(0, 10),
            notes: normalized.notes,
            truncated: true,
            truncation_note: 'Full contract is available in the result file.'
        };

        return JSON.stringify(truncated, null, 2);
    }

    _writeTraceHeader(tracePath, request) {
        const lines = [
            '# Delegated Subtask Trace',
            '',
            `- Run ID: ${request.run_id}`,
            `- Agent: ${request.agent_name} (#${request.subagent_id})`,
            `- Parent Session: ${request.parent_session_id === null ? 'none' : request.parent_session_id}`,
            `- Child Session: ${request.child_session_id}`,
            `- Contract: ${request.contract_type}`,
            `- Workspace: ${request.workspace_dir}`,
            '',
            'The parent may inspect this run folder if clarification is needed.',
            ''
        ];
        writeTraceFile(tracePath, lines);
    }

    _generateRunId() {
        return generateRunId('subtask');
    }

    _generatePrivateRunId() {
        return `private-${generateRunId('subtask')}`;
    }

    _readJson(filePath) {
        return readJson(filePath);
    }

    _writeJson(filePath, payload) {
        writeJson(filePath, payload);
    }

    _appendJsonLine(filePath, payload) {
        appendJsonLine(filePath, payload);
    }

    _appendTraceSection(tracePath, title, body) {
        appendTraceSection(tracePath, title, body);
    }

    _ensureDir(dirPath) {
        ensureDir(dirPath);
    }

}

module.exports = SubtaskRuntime;







