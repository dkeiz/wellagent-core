// @ts-nocheck
const {
    assessCompletionQuality,
    buildCompletionCandidate,
    normalizeCompletionPayload,
    summarizePlainText
} = require('./subagent-contract');
const { isPrivateSessionId } = require('./private-session-store');

class AgentSubagentContractMethods {
    _buildSubAgentTask(task, contractType, expectedOutput = '', run = null) {
        const outputHint = expectedOutput && String(expectedOutput).trim() ? String(expectedOutput).trim() : 'Return the most useful structured fields for the task in the data object.';
        const runGuidance = run?.private === true
            ? `This is a private delegated task. Do not rely on durable run files or trace files; keep intermediate work in the private workspace only when needed.
`
            : run
            ? `Run files for this delegated task:
- Run Folder: ${run.run_dir}
- Status File: ${run.status_path}
- Result File: ${run.result_path}
- Trace File: ${run.trace_path}
- Workspace Directory: ${run.workspace_dir}

Your parent may inspect this run folder later if clarification is needed. Keep your work legible, and use workspace files for large intermediate output when useful.
`
            : '';

        return `You are being invoked as a sub-agent by another agent.

Complete only the requested task. Use available tools if needed.
When the completion tool "complete_subtask" is available, call it to finish the run.
If tool call is unavailable, return a strict JSON object (no wrappers, no markdown) matching the completion envelope below.
Silent stop is invalid. If the result is empty, blocked, or unavailable, deliver that noticed outcome instead of stopping.

Required completion envelope:
- status: short outcome label. "${contractType}" is preferred for a strong result, but labels like "partial", "empty", "blocked", or "task_failed" are valid too
- summary: short human-readable outcome
- data: structured object with the actual result or outcome details
- artifacts: array of files created or relied on for the result
- notes: optional string

The parent is authoritative. It may accept your envelope, recall you, or send a new task based on what you deliver.

Expected output details:
${outputHint}

${runGuidance}

Task:
${task}`;
    }

    _extractJsonObject(text) {
        const content = String(text || '').trim();
        if (!content) return null;

        const fencedMatch = content.match(/```json\s*([\s\S]*?)```/i) || content.match(/```\s*([\s\S]*?)```/i);
        const candidate = fencedMatch ? fencedMatch[1].trim() : content;

        try {
            return JSON.parse(candidate);
        } catch (error) {
        }

        const start = candidate.indexOf('{');
        if (start === -1) {
            return null;
        }

        let depth = 0;
        let inString = false;
        let escapeNext = false;

        for (let index = start; index < candidate.length; index++) {
            const char = candidate[index];

            if (escapeNext) {
                escapeNext = false;
                continue;
            }

            if (char === '\\') {
                escapeNext = true;
                continue;
            }

            if (char === '"') {
                inString = !inString;
                continue;
            }

            if (inString) {
                continue;
            }

            if (char === '{') {
                depth++;
            } else if (char === '}') {
                depth--;
                if (depth === 0) {
                    try {
                        return JSON.parse(candidate.slice(start, index + 1));
                    } catch (error) {
                        return null;
                    }
                }
            }
        }

        return null;
    }

    _summarizePlainText(text) {
        return summarizePlainText(text);
    }

    _normalizeWorkspaceArtifacts(sessionId) {
        if (!this.sessionWorkspace) {
            return [];
        }

        return this.sessionWorkspace.listFiles(sessionId).map(file => ({
            path: file.path,
            name: file.name,
            size: file.size,
            created: file.created instanceof Date ? file.created.toISOString() : file.created,
            description: 'Generated in sub-agent workspace',
            source: 'workspace'
        }));
    }

    _mergeArtifacts(contractArtifacts, workspaceArtifacts) {
        const merged = new Map();

        const pushArtifact = (artifact, fallbackSource) => {
            if (!artifact || typeof artifact !== 'object') {
                return;
            }

            const pathValue = artifact.path ? String(artifact.path) : '';
            const nameValue = artifact.name ? String(artifact.name) : '';
            const key = nameValue || pathValue;
            if (!key) {
                return;
            }

            const existing = merged.get(key) || {};
            merged.set(key, {
                ...existing,
                ...artifact,
                path: pathValue || existing.path || '',
                name: nameValue || existing.name || '',
                source: artifact.source || existing.source || fallbackSource
            });
        };

        contractArtifacts.forEach(artifact => pushArtifact(artifact, 'contract'));
        workspaceArtifacts.forEach(artifact => pushArtifact(artifact, 'workspace'));

        return Array.from(merged.values());
    }

    async _persistSubagentConversation(sessionId, role, content, metadata = null) {
        if (isPrivateSessionId(sessionId)) {
            return;
        }
        if (!this.db || typeof this.db.addConversation !== 'function' || !sessionId || !content) {
            return;
        }
        const runScope = this.subtaskRuntime?.getRun ? this.subtaskRuntime.getRun(sessionId) : null;
        try {
            await this.db.addConversation({ role, content, metadata }, sessionId, {
                requestContext: runScope?.request_context || null,
                userId: runScope?.user_id || undefined
            });
        } catch (error) {
            console.error('[AgentManager] Failed to persist subagent conversation:', error.message);
        }
    }

    _resolveSubagentCompletion(response, sessionId, contractType) {
        const candidate = buildCompletionCandidate(
            response,
            contractType,
            (text) => this._extractJsonObject(text)
        );
        if (!candidate.payload) {
            return {
                ok: false,
                retryable: true,
                reason: 'missing_completion_contract',
                message: candidate.source === 'missing'
                    ? 'Sub-agent completion payload missing; expected complete_subtask call or strict JSON result.'
                    : 'Sub-agent returned plain text instead of the required completion envelope.',
                candidate
            };
        }

        const payload = {
            ...candidate.payload,
            status: candidate.payload.status || candidate.inferredStatus,
            summary: candidate.payload.summary
                || summarizePlainText(candidate.rawContent || JSON.stringify(candidate.payload.data || {})),
            data: candidate.payload.data && typeof candidate.payload.data === 'object' && !Array.isArray(candidate.payload.data)
                ? candidate.payload.data
                : {},
            artifacts: Array.isArray(candidate.payload.artifacts) ? candidate.payload.artifacts : [],
            notes: candidate.payload.notes === undefined || candidate.payload.notes === null
                ? ''
                : candidate.payload.notes
        };

        let normalized;
        try {
            normalized = normalizeCompletionPayload(payload, { preferredStatus: contractType });
        } catch (error) {
            return {
                ok: false,
                retryable: true,
                reason: 'invalid_completion_contract',
                message: error.message,
                candidate
            };
        }

        const workspaceArtifacts = this._normalizeWorkspaceArtifacts(sessionId);
        const contract = {
            ...normalized,
            artifacts: this._mergeArtifacts(normalized.artifacts, workspaceArtifacts)
        };
        const quality = assessCompletionQuality(contract, candidate);
        if (!quality.ok) {
            return {
                ok: false,
                retryable: true,
                reason: quality.reason,
                message: quality.message,
                candidate,
                contract
            };
        }

        return {
            ok: true,
            retryable: false,
            candidate,
            contract
        };
    }

    async _loadSubagentConversationHistory(sessionId) {
        if (isPrivateSessionId(sessionId)) {
            return [];
        }
        if (!this.db || typeof this.db.getConversations !== 'function') {
            return [];
        }

        const runScope = this.subtaskRuntime?.getRun ? this.subtaskRuntime.getRun(sessionId) : null;
        const messages = await this.db.getConversations(100, sessionId, {
            requestContext: runScope?.request_context || null,
            userId: runScope?.user_id || undefined
        });
        return (Array.isArray(messages) ? messages : [])
            .map(message => ({
                role: message.role,
                content: String(message.content || '')
            }))
            .filter(message => message.content.trim().length > 0);
    }

    async _persistDelegatedPrompt(runId, sessionId, content, metadata = {}) {
        this.subtaskRuntime.appendMessage(runId, {
            role: 'user',
            content,
            metadata
        });
        await this._persistSubagentConversation(sessionId, 'user', content, metadata);
    }

    async _setSubagentActive(agentId, active, options = {}) {
        const current = this.activeSubtaskCounts.get(agentId) || 0;
        const next = active ? current + 1 : Math.max(0, current - 1);
        this.activeSubtaskCounts.set(agentId, next);
        const runScope = options?.runId && this.subtaskRuntime?.getRun ? this.subtaskRuntime.getRun(options.runId) : null;
        await this.db.updateAgent(agentId, { status: next > 0 ? 'active' : 'idle' }, {
            requestContext: runScope?.request_context || options?.requestContext || null,
            userId: runScope?.user_id || options?.userId || undefined
        });
    }

    _createTraceHooks(runId) {
        if (!this.subtaskRuntime) {
            return null;
        }

        const run = this.subtaskRuntime.getRun(runId);
        if (run?.private === true) {
            return null;
        }
        const sessionId = run?.child_session_id || null;

        return {
            onAssistantMessage: async ({ content }) => {
                const visibleContent = this.chainController?.stripToolPatterns
                    ? this.chainController.stripToolPatterns(content)
                    : String(content || '').trim();
                if (!visibleContent) {
                    return;
                }
                this.subtaskRuntime.appendMessage(runId, {
                    role: 'assistant',
                    content: visibleContent
                });
                await this._persistSubagentConversation(sessionId, 'assistant', visibleContent);
            },
            onSyntheticUserMessage: async ({ content, kind }) => {
                this.subtaskRuntime.appendMessage(runId, {
                    role: 'user',
                    content,
                    metadata: {
                        auto_generated: true,
                        kind: kind || 'synthetic_user'
                    }
                });
                await this._persistSubagentConversation(sessionId, 'user', content, {
                    auto_generated: true,
                    kind: kind || 'synthetic_user'
                });
            },
            onToolResult: async ({ toolName, params, success, result, error }) => {
                this.subtaskRuntime.appendToolEvent(runId, {
                    tool_name: toolName,
                    params,
                    success,
                    result,
                    error
                });
                const label = success
                    ? `Tool ${toolName} succeeded:\n${JSON.stringify(result, null, 2)}`
                    : `Tool ${toolName} failed: ${error || 'Unknown error'}`;
                await this._persistSubagentConversation(sessionId, 'system', label, {
                    tool_name: toolName,
                    params,
                    success
                });
            }
        };
    }

}

module.exports = AgentSubagentContractMethods;

