// @ts-nocheck
const fs = require('fs');
const path = require('path');
const { buildRuntimePaths } = require('./runtime-paths');
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
const {
  canAccessWorkflowRun,
  getRequestUserId,
  normalizeRequestContext
} = require('./workflow-request-context');

function cloneRecord(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'object') {
    return value;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return { ...value };
  }
}

function normalizeOptionalString(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

class WorkflowRuntime {
  constructor(workflowManager, eventBus = null, basePath = null) {
    this.workflowManager = workflowManager;
    this.eventBus = eventBus;
    this.basePath = basePath || buildRuntimePaths().workflowBasePath;
    this.runsPath = path.join(this.basePath, 'runs');
    this.pendingRuns = new Map();
  }

  initialize() {
    initRunBase(this.basePath, ['runs']);
    this.cleanupStale(72);
  }

  async startRun({
    workflowId,
    mode = 'auto', paramOverrides = {},
    requestedBySessionId = null,
    requestContext = null,
    executionContext = null,
    principal = null
  }) {
    const workflow = await this.workflowManager.getWorkflowByIdWithChain(workflowId, requestContext ? { requestContext } : {});
    if (!workflow) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    const resolvedMode = this.workflowManager.resolveRunMode(workflow.tool_chain, mode);
    const run = this._createRunRecord({
      workflow,
      requestedBySessionId,
      requestedMode: mode,
      resolvedMode,
      paramOverrides,
      requestContext,
      executionContext,
      principal
    });

    if (resolvedMode === 'sync') {
      this._markRunning(run.run_id);
      const completed = await this._executeRun(run.run_id);
      return {
        accepted: true,
        immediate: true,
        run_id: run.run_id,
        status: completed.status,
        mode: completed.resolved_mode,
        result: completed.result
      };
    }

    const pending = this._executeRun(run.run_id)
      .catch(error => {
        console.error('[WorkflowRuntime] Async run failed:', error.message);
        return null;
      })
      .finally(() => {
        this.pendingRuns.delete(run.run_id);
      });
    this.pendingRuns.set(run.run_id, pending);

    return {
      accepted: true,
      immediate: false,
      run_id: run.run_id,
      status: 'queued',
      mode: resolvedMode,
      run_dir: run.run_dir,
      result_path: run.result_path,
      trace_path: run.trace_path
    };
  }

  getRun(runId, options = {}) {
    const requestPath = path.join(this.runsPath, String(runId), 'request.json');
    if (!fs.existsSync(requestPath)) return null;

    const request = readJson(requestPath);
    const status = readJson(request.status_path);
    const result = fs.existsSync(request.result_path) ? readJson(request.result_path) : null;
    const run = { ...request, ...status, result };
    if (options.requestContext && !canAccessWorkflowRun(run, options.requestContext)) {
      return null;
    }
    return run;
  }

  listRuns(filters = {}, options = {}) {
    const { limit = 20, workflowId = null, status = null } = filters;
    const runs = listRunDirectories(this.runsPath)
      .map(id => this.getRun(id))
      .filter(Boolean)
      .filter(run => workflowId === null || Number(run.workflow_id) === Number(workflowId))
      .filter(run => status === null || String(run.status) === String(status))
      .filter(run => !options.requestContext || canAccessWorkflowRun(run, options.requestContext))
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));

    return runs.slice(0, Math.max(1, Number(limit) || 20));
  }

  async waitForRun(runId, timeoutMs = 30000, options = {}) {
    const timeout = Math.max(100, Number(timeoutMs) || 30000);
    const started = Date.now();

    while (Date.now() - started < timeout) {
      const pending = this.pendingRuns.get(runId);
      if (pending) {
        await Promise.race([
          pending.catch(() => null),
          new Promise(resolve => setTimeout(resolve, 25))
        ]);
      }

      const run = this.getRun(runId, options);
      if (!run) return null;
      if (['completed', 'failed'].includes(String(run.status))) {
        return run;
      }

      await new Promise(resolve => setTimeout(resolve, 25));
    }

    throw new Error(`Timed out waiting for workflow run ${runId}`);
  }

  cleanupStale(maxAgeHours = 72) {
    if (!fs.existsSync(this.runsPath)) return 0;
    let cleaned = 0;
    const cutoff = Date.now() - (Math.max(1, Number(maxAgeHours) || 72) * 60 * 60 * 1000);

    for (const runId of listRunDirectories(this.runsPath)) {
      const runDir = path.join(this.runsPath, runId);
      try {
        const stat = fs.statSync(runDir);
        if (stat.mtimeMs >= cutoff) continue;
        const run = this.getRun(runId);
        if (String(run?.status || '') === 'running') continue;
        fs.rmSync(runDir, { recursive: true, force: true });
        cleaned++;
      } catch (error) {
        console.error('[WorkflowRuntime] Failed to cleanup stale run:', error.message);
      }
    }

    return cleaned;
  }

  _createRunRecord({
    workflow,
    requestedBySessionId,
    requestedMode,
    resolvedMode,
    paramOverrides,
    requestContext = null,
    executionContext = null,
    principal = null
  }) {
    const runId = generateRunId('workflow');
    const runDir = path.join(this.runsPath, runId);
    const artifactsDir = path.join(runDir, 'artifacts');
    const requestPath = path.join(runDir, 'request.json');
    const statusPath = path.join(runDir, 'status.json');
    const resultPath = path.join(runDir, 'result.json');
    const eventsPath = path.join(runDir, 'events.jsonl');
    const tracePath = path.join(runDir, 'trace.md');

    ensureDir(runDir);
    ensureDir(artifactsDir);

    const createdAt = new Date().toISOString();
    const normalizedRequestContext = requestContext && typeof requestContext === 'object'
      ? normalizeRequestContext(requestContext)
      : null;
    const storedExecutionContext = executionContext && typeof executionContext === 'object'
      ? cloneRecord(executionContext)
      : null;
    const storedPrincipal = principal && typeof principal === 'object'
      ? cloneRecord(principal)
      : (principal ?? null);
    const requestedByUserId = getRequestUserId(normalizedRequestContext);

    const requestedByDeviceId = normalizeOptionalString(
      normalizedRequestContext?.deviceId || normalizedRequestContext?.device_id
    );
    const requestedByRequestId = normalizeOptionalString(
      normalizedRequestContext?.requestId || normalizedRequestContext?.request_id
    );
    const requestedByAgentId = normalizeOptionalString(
      normalizedRequestContext?.agentId
      || normalizedRequestContext?.agent_id
      || storedExecutionContext?.agentId
      || storedExecutionContext?.agent_id
    );
    const request = {
      run_id: runId,
      workflow_id: workflow.id,
      workflow_name: workflow.name,
      requested_by_session_id: requestedBySessionId,
      requested_by_user_id: requestedByUserId,
      requested_by_device_id: requestedByDeviceId,
      requested_by_request_id: requestedByRequestId,
      requested_by_agent_id: requestedByAgentId,
      requested_mode: requestedMode,
      resolved_mode: resolvedMode,
      param_overrides: paramOverrides || {},
      request_context: normalizedRequestContext ? cloneRecord(normalizedRequestContext) : null,
      principal: storedPrincipal,
      execution_context: storedExecutionContext,
      created_at: createdAt,
      run_dir: runDir,
      artifacts_dir: artifactsDir,
      request_path: requestPath,
      status_path: statusPath,
      result_path: resultPath,
      events_path: eventsPath,
      trace_path: tracePath
    };
    const status = {
      run_id: runId,
      workflow_id: workflow.id,
      workflow_name: workflow.name,
      status: 'queued',
      summary: '',
      error: null,
      created_at: createdAt,
      updated_at: createdAt,
      run_dir: runDir,
      result_path: resultPath,
      trace_path: tracePath,
      resolved_mode: resolvedMode
    };

    writeJson(requestPath, request);
    writeJson(statusPath, status);
    writeTraceFile(tracePath, [
      '# Workflow Run Trace',
      '',
      `- Run ID: ${runId}`,
      `- Workflow: ${workflow.name} (#${workflow.id})`,
      `- Requested Mode: ${requestedMode}`,
      `- Resolved Mode: ${resolvedMode}`,
      `- Session: ${requestedBySessionId === null ? 'none' : requestedBySessionId}`,
      `- User: ${requestedByUserId}`,
      ''
    ]);
    return this.getRun(runId);
  }

  _markRunning(runId) {
    const run = this.getRun(runId);
    if (!run) return null;
    const status = {
      ...readJson(run.status_path),
      status: 'running',
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    writeJson(run.status_path, status);
    this.eventBus?.publish?.('workflow:run-started', {
      runId: run.run_id,
      workflowId: run.workflow_id,
      workflowName: run.workflow_name
    });
    return this.getRun(runId);
  }

  async _executeRun(runId) {
    const run = this._markRunning(runId);
    if (!run) {
      throw new Error(`Workflow run not found: ${runId}`);
    }

    try {
      const execution = await this.workflowManager.executeWorkflowSteps(
        run.workflow_id,
        run.param_overrides || {},
        {
          requestedBySessionId: run.requested_by_session_id || null,
          requestContext: run.request_context || null,
          executionContext: run.execution_context || null,
          principal: run.principal || null,
          workflowRunId: run.run_id,
          onStep: ({ id, type, tool, agent, success, result, output, error }) => {
            const event = {
              timestamp: new Date().toISOString(),
              id,
              type: type || 'tool',
              tool,
              agent,
              success,
              result: success ? result : null,
              output: success ? output : null,
              error: success ? null : error
            };
            appendJsonLine(run.events_path, event);
            appendTraceSection(
              run.trace_path,
              `step ${id || tool || agent}`,
              success
                ? `\`\`\`json\n${JSON.stringify(output !== undefined ? output : result, null, 2)}\n\`\`\``
                : `Error: ${error}`
            );
          }
        }
      );

      const completedAt = new Date().toISOString();
      const resultPayload = {
        run_id: run.run_id,
        workflow_id: run.workflow_id,
        workflow_name: run.workflow_name,
        completed_at: completedAt,
        success: execution.success,
        results: execution.results,
        final_output: execution.finalOutput || null,
        summary: execution.success
          ? (execution.finalOutput?.summary || `Workflow completed (${execution.results.length} step${execution.results.length === 1 ? '' : 's'})`)
          : `Workflow failed at step ${execution.results.findIndex(r => !r.success) + 1}`
      };
      writeJson(run.result_path, resultPayload);
      let delivery = null;
      if (execution.success && run.requested_by_session_id && this.workflowManager.deliverRunResultToSession) {
        delivery = await this.workflowManager.deliverRunResultToSession(run, resultPayload, {
          requestContext: run.request_context || null
        });
        if (delivery?.sessionId) {
          this.eventBus?.sendToRenderer?.('conversation-update', { sessionId: delivery.sessionId });
        }
      }
      writeJson(run.status_path, {
        ...readJson(run.status_path),
        status: execution.success ? 'completed' : 'failed',
        summary: resultPayload.summary,
        error: execution.success ? null : (execution.results.find(r => !r.success)?.error || 'Workflow failed'),
        delivered_to_session_id: delivery?.sessionId || null,
        completed_at: completedAt,
        updated_at: completedAt
      });
      appendTraceSection(run.trace_path, `completion @ ${completedAt}`, resultPayload.summary);
      this.eventBus?.publish?.('workflow:run-completed', {
        runId: run.run_id,
        workflowId: run.workflow_id,
        workflowName: run.workflow_name,
        success: execution.success,
        finalOutput: execution.finalOutput || null,
        deliveredToSessionId: delivery?.sessionId || null
      });
      return this.getRun(run.run_id);
    } catch (error) {
      const failedAt = new Date().toISOString();
      writeJson(run.result_path, {
        run_id: run.run_id,
        workflow_id: run.workflow_id,
        workflow_name: run.workflow_name,
        completed_at: failedAt,
        success: false,
        error: error.message
      });
      writeJson(run.status_path, {
        ...readJson(run.status_path),
        status: 'failed',
        summary: '',
        error: error.message,
        completed_at: failedAt,
        updated_at: failedAt
      });
      appendTraceSection(run.trace_path, `failure @ ${failedAt}`, error.message);
      this.eventBus?.publish?.('workflow:run-failed', {
        runId: run.run_id,
        workflowId: run.workflow_id,
        workflowName: run.workflow_name,
        error: error.message
      });
      return this.getRun(run.run_id);
    }
  }
}

module.exports = WorkflowRuntime;