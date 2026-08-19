// @ts-nocheck
const {
    buildForcedIncompleteContract,
    buildSubagentIdentifiers,
    buildSubagentReminderPrompt
} = require('./subagent-contract');
const { isPrivateSessionId } = require('./private-session-store');

class AgentSubagentRunMethods {
    async getSubagentRun(runId, options = {}) {
        const normalizedRunId = String(runId || '').trim();
        if (!normalizedRunId) {
            return null;
        }

        if (this.subtaskRuntime) {
            try {
                const run = this.subtaskRuntime.getRun(normalizedRunId, options);
                if (run) {
                    return run;
                }
            } catch (error) {
            }
        }

        if (this.db?.getSubagentRun) {
            const numericId = normalizedRunId.match(/^\d+$/) ? Number(normalizedRunId) : null;
            if (numericId !== null) {
                try {
                    const dbRun = await this.db.getSubagentRun(numericId, options);
                    if (dbRun) {
                        return dbRun;
                    }
                } catch (error) {
                }
            }
        }

        if (this.db?.getAgent) {
            const agent = await this.db.getAgent(normalizedRunId, options);
            const run = this._agentAsSubagentRun(agent);
            if (run) {
                return run;
            }
        }

        return null;
    }

    async listSubagentRuns(filters = {}) {
        const {
            limit = 20,
            parentSessionId = null,
            subagentId = null,
            status = null
        } = filters || {};

        const matchesFilters = (run) => {
            if (!run) return false;
            if (run.private === true && !isPrivateSessionId(parentSessionId)) return false;
            if (parentSessionId !== null && String(run.parent_session_id) !== String(parentSessionId)) return false;
            if (subagentId !== null && Number(run.subagent_id) !== Number(subagentId)) return false;
            if (status !== null && String(run.status) !== String(status)) return false;
            return true;
        };

        const persistedRuns = this.subtaskRuntime
            ? this.subtaskRuntime.listRuns({ ...filters, limit: 100000, parentSessionId, subagentId, status })
            : [];
        const legacyDbRuns = this.db?.listSubagentRuns
            ? await this.db.listSubagentRuns({ ...filters, limit: 100000, parentSessionId, subagentId })
            : [];

        const merged = new Map();
        for (const run of Array.isArray(persistedRuns) ? persistedRuns : []) {
            if (!run || !run.run_id) continue;
            merged.set(String(run.run_id), run);
        }
        for (const run of Array.isArray(legacyDbRuns) ? legacyDbRuns : []) {
            if (!run || !run.id) continue;
            const key = String(run.run_id || run.id);
            if (merged.has(key)) continue;
            const normalized = {
                run_id: key,
                status: run.status || 'unknown',
                subagent_id: run.subagent_id,
                agent_name: run.agent_name || '',
                parent_session_id: run.parent_session_id ?? null,
                child_session_id: run.child_session_id ?? null,
                task: run.task || '',
                summary: run.result_summary || '',
                error: run.error || null,
                created_at: run.created_at || null,
                completed_at: run.completed_at || null,
                result: run.result_payload || null
            };
            if (matchesFilters(normalized)) {
                merged.set(key, normalized);
            }
        }

        // Guarantee manager visibility for live delegated runs even if file records are temporarily unreadable.
        for (const runId of this.pendingSubtasks.keys()) {
            const key = String(runId);
            if (merged.has(key)) continue;

            let recovered = null;
            try {
                recovered = this.subtaskRuntime?.getRun ? this.subtaskRuntime.getRun(key, filters) : null;
            } catch (error) {
                recovered = null;
            }

            const liveRun = recovered || {
                run_id: key,
                status: 'running',
                summary: 'Live delegated run is active but persisted run record is unreadable.',
                error: null,
                created_at: null,
                updated_at: null,
                parent_session_id: null,
                child_session_id: key,
                subagent_id: null,
                agent_name: '',
                subagent_mode: 'no_ui',
                contract_type: 'task_complete',
                result: null
            };

            if (matchesFilters(liveRun)) {
                merged.set(key, liveRun);
            }
        }

        if (this.db?.getAgents && parentSessionId === null && status === null) {
            const agents = await this.db.getAgents('sub', filters);
            for (const agent of Array.isArray(agents) ? agents : []) {
                const recovered = this._agentAsSubagentRun(agent);
                if (!recovered) continue;
                const key = String(recovered.run_id);
                if (!merged.has(key) && matchesFilters(recovered)) {
                    merged.set(key, recovered);
                }
            }
        }

        const runs = Array.from(merged.values())
            .filter(matchesFilters)
            .sort((a, b) => String(b.created_at || b.updated_at || b.run_id || '').localeCompare(String(a.created_at || a.updated_at || a.run_id || '')));

        return runs.slice(0, Math.max(1, Number(limit) || 20));
    }

    async clearSubagentRuns(filters = {}) {
        let legacyResult = { removed: 0, kept: 0, failed: 0 };
        if (this.db?.listSubagentRuns && typeof this.db.run === 'function') {
            const terminalStatuses = new Set(['failed', 'completed', 'task_complete', 'task_failed', 'cancelled', 'stopped']);
            const onlyFinished = filters?.onlyFinished !== false;
            const includeRunning = filters?.includeRunning === true;
            const matchText = String(filters?.matchText || '').trim().toLowerCase();
            const allowedIds = Array.isArray(filters?.runIds)
                ? new Set(filters.runIds.map(value => String(value || '').trim()).filter(Boolean))
                : null;
            const legacyRuns = await this.db.listSubagentRuns({
                ...filters,
                limit: 100000,
                parentSessionId: filters?.parentSessionId ?? null,
                subagentId: filters?.subagentId ?? null
            });
            for (const run of Array.isArray(legacyRuns) ? legacyRuns : []) {
                const runId = String(run.run_id || run.id || '').trim();
                const status = String(run.status || '').trim().toLowerCase();
                const running = status === 'queued' || status === 'running' || status === 'cancelling';
                if (allowedIds && !allowedIds.has(runId)) {
                    legacyResult.kept++;
                    continue;
                }
                if (filters?.status !== null && filters?.status !== undefined && String(run.status) !== String(filters.status)) {
                    legacyResult.kept++;
                    continue;
                }
                if (onlyFinished && !terminalStatuses.has(status)) {
                    legacyResult.kept++;
                    continue;
                }
                if (!includeRunning && running) {
                    legacyResult.kept++;
                    continue;
                }
                if (matchText) {
                    const haystack = [runId, run.agent_name, run.task, run.parent_session_id]
                        .map(value => String(value || '').toLowerCase())
                        .join(' ');
                    if (!haystack.includes(matchText)) {
                        legacyResult.kept++;
                        continue;
                    }
                }
                try {
                    this.db.run('DELETE FROM subagent_runs WHERE id = ?', [Number(run.id || runId)]);
                    legacyResult.removed++;
                } catch (error) {
                    legacyResult.failed++;
                }
            }
        }
        if (this.subtaskRuntime && typeof this.subtaskRuntime.clearRuns === 'function') {
            const result = this.subtaskRuntime.clearRuns(filters);
            return {
                ...result,
                removed: Number(result.removed || 0) + legacyResult.removed,
                kept: Number(result.kept || 0) + legacyResult.kept,
                failed: Number(result.failed || 0) + legacyResult.failed,
                success: result.success !== false && legacyResult.failed === 0
            };
        }
        if (legacyResult.removed || legacyResult.kept || legacyResult.failed) {
            return { success: legacyResult.failed === 0, ...legacyResult };
        }
        return { success: false, removed: 0, kept: 0, failed: 0, error: 'Subagent run cleanup is unavailable' };
    }

    async closeSubagentRun(runId, options = {}) {
        const normalizedRunId = String(runId || '').trim();
        if (!normalizedRunId) {
            return { success: false, removed: 0, error: 'runId is required' };
        }
        const run = await this.getSubagentRun(normalizedRunId, options);
        if (!run) {
            return { success: true, removed: 0, alreadyClosed: true };
        }

        if (run.source === 'agent') {
            if (this.chainController && typeof this.chainController.stopChain === 'function') {
                this.chainController.stopChain(String(run.run_id));
            }
            if (this.toolPermissionService && run.run_id) {
                this.toolPermissionService.clearRunScopedGrant(run.run_id);
            }
            // Actually delete the agent record so it disappears from both the
            // manager list and the sidebar widget. The previous behaviour only
            // set status='closed', which left the agent permanently stuck.
            await this.deleteAgent(run.subagent_id, options);
            this.eventBus?.publish('subagent:closed', {
                runId: String(run.run_id),
                subagentId: run.subagent_id,
                agentName: run.agent_name,
                status: 'closed'
            });
            this.eventBus?.sendToRenderer?.('agent-update');
            return { success: true, removed: 1, closed: true, run: { ...run, status: 'closed' } };
        }

        const runKey = String(run.run_id || normalizedRunId);
        // Cancel and WAIT for the execution loop to actually terminate before deleting files.
        if (this.pendingSubtasks.has(runKey)) {
            await this.cancelSubagentRun(runKey, 'Closed by user', options);
        } else {
            if (this.toolPermissionService && run.run_id) {
                this.toolPermissionService.clearRunScopedGrant(run.run_id);
            }
            if (this.chainController && typeof this.chainController.stopChain === 'function') {
                this.chainController.stopChain(runKey);
            }
        }

        // Now that execution has terminated, it is safe to delete run files.
        const result = await this.clearSubagentRuns({
            ...options,
            onlyFinished: false,
            includeRunning: true,
            runIds: [runKey, String(run.id || '')].filter(Boolean)
        });

        return {
            ...result,
            closed: Number(result.removed || 0) > 0,
            run
        };
    }

    async waitForSubagentRun(runId, timeoutMs = 30000, options = {}) {
        const timeout = Math.max(100, Number(timeoutMs) || 30000);
        const started = Date.now();

        while (Date.now() - started < timeout) {
            const pending = this.pendingSubtasks.get(runId);
            if (pending) {
                await Promise.race([
                    pending.catch(() => null),
                    new Promise(resolve => setTimeout(resolve, 25))
                ]);
            }

            const run = await this.getSubagentRun(runId, options);
            if (run && ['failed', 'task_failed'].includes(String(run.status))) {
                if (pending) {
                    await pending.catch(() => null);
                }
                return run;
            }
            if (run && run.result) {
                if (pending) {
                    await pending.catch(() => null);
                    return this.getSubagentRun(runId, options);
                }
                return run;
            }

            await new Promise(resolve => setTimeout(resolve, 25));
        }

        throw new Error(`Timed out waiting for subagent run ${runId}`);
    }

    _isSubagentRunCancelled(runId) {
        return this.cancelledSubtaskRuns.has(String(runId));
    }

    _consumeCancelledSubagentRun(runId) {
        this.cancelledSubtaskRuns.delete(String(runId));
    }

    _assertSubagentRunNotCancelled(runId) {
        if (this._isSubagentRunCancelled(runId)) {
            throw new Error('Cancelled by user');
        }
    }

    _isCancellationError(error) {
        return String(error?.message || '').toLowerCase().includes('cancelled by user');
    }

    async _executeDelegatedRun(run, agent, task, contractType, expectedOutput) {
        this._assertSubagentRunNotCancelled(run.run_id);
        const traceHooks = this._createTraceHooks(run.run_id);
        const taskPrompt = this._buildSubAgentTask(task, contractType, expectedOutput, run);
        await this._persistDelegatedPrompt(run.run_id, run.child_session_id, taskPrompt, {
            delegated: true,
            parent_session_id: run.parent_session_id,
            run_id: run.run_id,
            subagent_id: run.subagent_id
        });

        this.subtaskRuntime.markRunning(run.run_id);
        const identifiers = buildSubagentIdentifiers(run);
        this.eventBus?.publish('subagent:started', {
            runId: run.run_id,
            parentSessionId: run.parent_session_id,
            childSessionId: run.child_session_id,
            subagentId: run.subagent_id,
            agentName: run.agent_name,
            subagentMode: run.subagent_mode || 'no_ui',
            identifiers
        });

        try {
            let prompt = taskPrompt;
            let history = [];
            let result = null;
            let validation = null;
            let remindersSent = 0;

            while (true) {
                this._assertSubagentRunNotCancelled(run.run_id);
                const dispatchProvider = String(run.provider || '').trim().toLowerCase() || null;
                const concurrencyMode = String(run.concurrency_mode || 'queued').trim().toLowerCase() === 'parallel'
                    ? 'parallel'
                    : 'queued';
                result = this.chainController
                    ? await this.chainController.executeWithChaining(
                        prompt,
                        history,
                        {
                            mode: 'chat',
                            sessionId: run.child_session_id,
                            agentId: agent.id,
                            subagentRunId: run.run_id,
                            runtimePolicyProfile: run.runtime_policy_profile || 'strict-subagent',
                            runtimePolicyGrants: run.runtime_policy_grants || {},
                            principal: {
                                type: 'subagent',
                                id: `subagent:${run.subagent_id}:${run.run_id}`,
                                profile: run.runtime_policy_profile || 'strict-subagent'
                            },
                            includeTools: true,
                            includeRules: false,
                            skipMemoryOnStart: true,
                            provider: dispatchProvider || undefined,
                            concurrencyMode,
                            completionTools: ['complete_subtask'],
                            maxChainSteps: 24,
                            trace: traceHooks
                        }
                    )
                    : await this.dispatcher.dispatch(
                        prompt,
                        history,
                        {
                            mode: 'chat',
                            sessionId: run.child_session_id,
                            agentId: agent.id,
                            runtimePolicyProfile: run.runtime_policy_profile || 'strict-subagent',
                            runtimePolicyGrants: run.runtime_policy_grants || {},
                            principal: {
                                type: 'subagent',
                                id: `subagent:${run.subagent_id}:${run.run_id}`,
                                profile: run.runtime_policy_profile || 'strict-subagent'
                            },
                            includeTools: true,
                            includeRules: false,
                            skipMemoryOnStart: true,
                            provider: dispatchProvider || undefined,
                            concurrencyMode
                        }
                    );
                this._assertSubagentRunNotCancelled(run.run_id);

                if (!this.chainController && result?.content) {
                    this.subtaskRuntime.appendMessage(run.run_id, {
                        role: 'assistant',
                        content: result.content
                    });
                }

                validation = this._resolveSubagentCompletion(result, run.child_session_id, contractType);
                if (validation.ok) {
                    break;
                }

                if (remindersSent >= this.maxDelegatedCompletionRetries) {
                    validation = {
                        ok: true,
                        contract: buildForcedIncompleteContract(
                            contractType,
                            validation,
                            remindersSent,
                            result
                        )
                    };
                    break;
                }

                remindersSent += 1;
                history = await this._loadSubagentConversationHistory(run.child_session_id);
                prompt = buildSubagentReminderPrompt(contractType, validation, remindersSent);
                await this._persistDelegatedPrompt(run.run_id, run.child_session_id, prompt, {
                    delegated: true,
                    auto_generated: true,
                    kind: 'backend_completion_reminder',
                    reminder_attempt: remindersSent,
                    run_id: run.run_id,
                    subagent_id: run.subagent_id
                });
            }

            const contract = validation.contract;
            const completedRun = this.subtaskRuntime.completeRun(run.run_id, {
                contract,
                artifacts: contract.artifacts,
                raw_response: result?.content || ''
            });
            const delivery = await this.subtaskRuntime.deliverToParent(run.run_id, {
                status: contract.status,
                summary: contract.summary,
                contract
            });

            this.eventBus?.publish('subagent:completed', {
                runId: run.run_id,
                parentSessionId: run.parent_session_id,
                childSessionId: run.child_session_id,
                subagentId: run.subagent_id,
                agentName: run.agent_name,
                subagentMode: run.subagent_mode || 'no_ui',
                summary: contract.summary,
                status: contract.status,
                deliveryPath: delivery?.delivery_path || null,
                identifiers
            });

            return completedRun;
        } catch (error) {
            if (this._isCancellationError(error) && this.subtaskRuntime?.cancelRun) {
                const stoppedRun = this.subtaskRuntime.cancelRun(run.run_id, 'Stopped by user');
                this.eventBus?.publish('subagent:failed', {
                    runId: run.run_id,
                    parentSessionId: run.parent_session_id,
                    childSessionId: run.child_session_id,
                    subagentId: run.subagent_id,
                    agentName: run.agent_name,
                    subagentMode: run.subagent_mode || 'no_ui',
                    error: 'Stopped by user',
                    status: 'stopped',
                    cancelled: true,
                    identifiers
                });
                return stoppedRun;
            }

            const failedRun = this.subtaskRuntime.failRun(run.run_id, error.message);
            await this.subtaskRuntime.deliverToParent(run.run_id, {
                status: 'failed',
                summary: error.message,
                contract: {
                    status: 'delivery_error',
                    summary: error.message,
                    data: {},
                    artifacts: [],
                    notes: ''
                }
            });
            this.eventBus?.publish('subagent:failed', {
                runId: run.run_id,
                parentSessionId: run.parent_session_id,
                childSessionId: run.child_session_id,
                subagentId: run.subagent_id,
                agentName: run.agent_name,
                subagentMode: run.subagent_mode || 'no_ui',
                error: error.message,
                identifiers
            });
            return failedRun;
        } finally {
            try {
                if (this.toolPermissionService) {
                    this.toolPermissionService.clearRunScopedGrant(run.run_id);
                }
            } catch (cleanupError) {
                console.error('[AgentManager] Cleanup clearRunScopedGrant error:', cleanupError.message);
            }
            this._consumeCancelledSubagentRun(run.run_id);
            try {
                await this._setSubagentActive(agent.id, false, {
                    runId: run.run_id,
                    requestContext: run.request_context || null,
                    userId: run.user_id || undefined
                });
            } catch (cleanupError) {
                console.error('[AgentManager] Cleanup _setSubagentActive error:', cleanupError.message);
            }
        }
    }

    async cancelSubagentRun(runId, reason = 'Cancelled by user', options = {}) {
        const normalizedRunId = String(runId || '').trim();
        if (!normalizedRunId) {
            return { success: false, error: 'runId is required' };
        }

        const resolveLiveRunKey = async (inputId) => {
            const direct = String(inputId || '').trim();
            if (!direct) return null;
            if (this.pendingSubtasks.has(direct)) return direct;

            const run = await this.getSubagentRun(direct, options);
            if (!run) return null;
            const candidates = [
                run.run_id,
                run.child_session_id,
                run.id
            ].map(value => String(value || '').trim()).filter(Boolean);
            return candidates.find(candidate => this.pendingSubtasks.has(candidate)) || null;
        };

        const liveRunKey = await resolveLiveRunKey(normalizedRunId);
        if (liveRunKey) {
            this.cancelledSubtaskRuns.add(liveRunKey);
            if (this.chainController && typeof this.chainController.stopChain === 'function') {
                this.chainController.stopChain(liveRunKey);
            }
            try {
                if (this.subtaskRuntime && typeof this.subtaskRuntime.cancelRun === 'function') {
                    this.subtaskRuntime.cancelRun(liveRunKey, String(reason || 'Stopped by user'));
                }
            } catch (error) {
            }

            // Await the live execution promise so the loop actually terminates
            // before we tell the caller it's cancelled.
            const pendingPromise = this.pendingSubtasks.get(liveRunKey);
            if (pendingPromise) {
                try {
                    await Promise.race([
                        pendingPromise,
                        new Promise(resolve => setTimeout(resolve, 8000))
                    ]);
                } catch (error) {
                    // Swallow — the run may throw on cancellation, that's expected.
                }
            }

            const run = await this.getSubagentRun(liveRunKey, options);
            if (run) {
                this.eventBus?.publish('subagent:failed', {
                    runId: run.run_id || liveRunKey,
                    parentSessionId: run.parent_session_id,
                    childSessionId: run.child_session_id,
                    subagentId: run.subagent_id,
                    agentName: run.agent_name,
                    subagentMode: run.subagent_mode || 'no_ui',
                    error: String(reason || 'Stopped by user'),
                    status: 'stopped',
                    cancelled: true,
                    identifiers: buildSubagentIdentifiers(run)
                });
            }
            return { success: true, run: run || { run_id: liveRunKey, status: 'stopped' } };
        }

        const run = await this.getSubagentRun(normalizedRunId, options);
        if (!run) {
            return { success: false, error: `Subagent run "${normalizedRunId}" not found` };
        }

        if (run.source === 'agent') {
            await this.deactivateAgent(run.subagent_id, options);
            if (this.chainController && typeof this.chainController.stopChain === 'function') {
                this.chainController.stopChain(String(run.run_id));
            }
            if (this.toolPermissionService && run.run_id) {
                this.toolPermissionService.clearRunScopedGrant(run.run_id);
            }
            return { success: true, run: { ...run, status: 'idle' } };
        }

        const status = String(run.status || '');
        if (['failed', 'completed', 'task_complete', 'task_failed', 'cancelled', 'stopped'].includes(status)) {
            if (this.chainController && typeof this.chainController.stopChain === 'function') {
                this.chainController.stopChain(normalizedRunId);
            }
            if (this.toolPermissionService && run.run_id) {
                this.toolPermissionService.clearRunScopedGrant(run.run_id);
            }
            this.eventBus?.publish('subagent:failed', {
                runId: run.run_id || normalizedRunId,
                parentSessionId: run.parent_session_id,
                childSessionId: run.child_session_id,
                subagentId: run.subagent_id,
                agentName: run.agent_name,
                subagentMode: run.subagent_mode || 'no_ui',
                error: String(reason || 'Stopped by user'),
                status,
                cancelled: true,
                identifiers: buildSubagentIdentifiers(run)
            });
            return { success: true, run, alreadyTerminal: true };
        }

        this.cancelledSubtaskRuns.add(normalizedRunId);
        if (this.chainController && typeof this.chainController.stopChain === 'function') {
            this.chainController.stopChain(normalizedRunId);
        }
        if (this.subtaskRuntime && typeof this.subtaskRuntime.cancelRun === 'function') {
            try {
                this.subtaskRuntime.cancelRun(normalizedRunId, String(reason || 'Stopped by user'));
            } catch (error) {
            }
        }
        if (this.db?.run && String(run.id || '').match(/^\d+$/)) {
            try {
                this.db.run(
                    `UPDATE subagent_runs
                     SET status = 'stopped', error = NULL, result_summary = ?, completed_at = CURRENT_TIMESTAMP
                     WHERE id = ?`,
                    [String(reason || 'Stopped by user'), Number(run.id)]
                );
            } catch (error) {
            }
        }
        if (this.toolPermissionService && run.run_id) {
            this.toolPermissionService.clearRunScopedGrant(run.run_id);
        }

        this.eventBus?.publish('subagent:failed', {
            runId: run.run_id,
            parentSessionId: run.parent_session_id,
            childSessionId: run.child_session_id,
            subagentId: run.subagent_id,
            agentName: run.agent_name,
            subagentMode: run.subagent_mode || 'no_ui',
            error: String(reason || 'Stopped by user'),
            status: 'stopped',
            cancelled: true,
            identifiers: buildSubagentIdentifiers(run)
        });

        return { success: true, run: await this.getSubagentRun(normalizedRunId, options) };
    }

    _startDelegatedRun(run, agent, task, contractType, expectedOutput, queueProvider = null) {
        const execute = () => this._executeDelegatedRun(run, agent, task, contractType, expectedOutput)
            .catch(error => {
                console.error('[AgentManager] Delegated subtask failed:', error.message);
                return null;
            });
        let pending = execute();

        pending = pending.finally(() => {
            this.pendingSubtasks.delete(run.run_id);
        });
        this.pendingSubtasks.set(run.run_id, pending);
        return pending;
    }

    async invokeSubAgent(parentSessionId, subAgentId, task, options = {}) {
        const agent = await this.db.getAgent(subAgentId, options);
        if (!agent || agent.type !== 'sub') {
            throw new Error(`Sub-agent ${subAgentId} not found or not a sub-agent`);
        }

        const contractType = options.contractType || 'task_complete';
        const expectedOutput = options.expectedOutput || '';
        const subagentModeRaw = String(options.subagentMode || 'no_ui').trim().toLowerCase();
        const subagentMode = subagentModeRaw === 'ui' ? 'ui' : 'no_ui';
        const provider = String(options.provider || '').trim().toLowerCase();
        const queueProvider = String(options.queueProvider || '').trim();
        const concurrencyMode = String(options.concurrencyMode || options.concurrency_mode || 'queued').trim().toLowerCase() === 'parallel'
            ? 'parallel'
            : 'queued';
        const runtimePolicyProfile = this._normalizeSubagentRuntimePolicyProfile(options.runtimePolicyProfile || options.runtime_policy_profile);
        const runtimePolicyGrants = options.runtimePolicyGrants && typeof options.runtimePolicyGrants === 'object'
            ? options.runtimePolicyGrants
            : (options.runtime_policy_grants && typeof options.runtime_policy_grants === 'object' ? options.runtime_policy_grants : {});
        const run = this.subtaskRuntime.createRun({
            parentSessionId,
            subagentId: subAgentId,
            agentName: agent.name,
            task,
            contractType,
            expectedOutput,
            subagentMode,
            provider: provider || null,
            queue_provider: queueProvider || null,
            concurrency_mode: concurrencyMode,
            runtimePolicyProfile,
            runtimePolicyGrants,
            requestContext: options.requestContext || null
        });

        if (this.toolPermissionService && options.permissionsContract) {
            this.toolPermissionService.setRunScopedGrant(run.run_id, subAgentId, options.permissionsContract);
        }

        await this._setSubagentActive(subAgentId, true, {
            ...options,
            runId: run.run_id
        });
        const identifiers = buildSubagentIdentifiers({
            ...run,
            parent_session_id: parentSessionId,
            subagent_id: subAgentId
        });
        this.eventBus?.publish('subagent:queued', {
            runId: run.run_id,
            parentSessionId,
            childSessionId: run.child_session_id,
            subagentId: subAgentId,
            agentName: agent.name,
            subagentMode,
            identifiers
        });

        this._startDelegatedRun(run, agent, task, contractType, expectedOutput, queueProvider || null);

        return {
            accepted: true,
            success: true,
            runId: run.run_id,
            run_id: run.run_id,
            agentId: subAgentId,
            agentName: agent.name,
            childSessionId: run.child_session_id,
            child_session_id: run.child_session_id,
            parentSessionId,
            parent_session_id: parentSessionId,
            contractType,
            contract_type: contractType,
            subagentMode,
            subagent_mode: subagentMode,
            provider: provider || null,
            concurrency_mode: concurrencyMode,
            runtimePolicyProfile,
            runtime_policy_profile: runtimePolicyProfile,
            runtimePolicyGrants,
            runtime_policy_grants: runtimePolicyGrants,
            status: run.status,
            identifiers,
            runDir: run.run_dir,
            run_dir: run.run_dir,
            resultPath: run.result_path,
            result_path: run.result_path,
            tracePath: run.trace_path,
            trace_path: run.trace_path,
            workspaceDir: run.workspace_dir,
            workspace_dir: run.workspace_dir
        };
    }

    _normalizeSubagentRuntimePolicyProfile(rawProfile) {
        const value = String(rawProfile || '').trim().toLowerCase();
        if (value === 'wide' || value === 'wide-agent') return 'wide-agent';
        if (value === 'normal' || value === 'normal-agent') return 'normal-agent';
        if (value === 'strict' || value === 'strict-subagent') return 'strict-subagent';
        return 'strict-subagent';
    }

}

module.exports = AgentSubagentRunMethods;


