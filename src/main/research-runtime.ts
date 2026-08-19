// @ts-nocheck
const fs = require('fs');
const path = require('path');
const { buildRuntimePaths, buildScopedMutableRuntimePaths } = require('./runtime-paths');
const { normalizeUserId, requireUserScope } = require('./user-scope');
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

class ResearchRuntime {
  constructor(workflowManager, knowledgeManager = null, eventBus = null, basePath = null, options = {}) {
    this.workflowManager = workflowManager;
    this.knowledgeManager = knowledgeManager;
    this.eventBus = eventBus;
    this.basePath = basePath || buildRuntimePaths(options).researchBasePath;
    this.agentinRoot = path.resolve(options.agentinRoot || path.dirname(this.basePath));
    this.runtimePathOptions = { ...options, agentinRoot: this.agentinRoot };
    this.runsPath = path.join(this.basePath, 'runs');
    this.pendingRuns = new Map();
  }

  _resolveScope(options = {}) {
    return requireUserScope(options);
  }

  _getScopedResearchPaths(options = {}) {
    const scope = this._resolveScope(options);
    const runtimePaths = buildScopedMutableRuntimePaths({
      ...this.runtimePathOptions,
      userId: scope.userId,
      requestContext: scope.requestContext,
      researchBasePath: null
    });
    return {
      scope,
      basePath: runtimePaths.researchBasePath,
      runsPath: path.join(runtimePaths.researchBasePath, 'runs')
    };
  }

  _findRequestPath(runId, options = {}) {
    const scoped = this._getScopedResearchPaths(options);
    const scopedPath = path.join(scoped.runsPath, String(runId), 'request.json');
    if (fs.existsSync(scopedPath)) {
      return scopedPath;
    }

    const defaultPath = path.join(this.runsPath, String(runId), 'request.json');
    if (fs.existsSync(defaultPath)) {
      return defaultPath;
    }

    const usersRoot = path.join(this.agentinRoot, 'users');
    if (!fs.existsSync(usersRoot)) {
      return null;
    }
    for (const entry of fs.readdirSync(usersRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(usersRoot, entry.name, 'research', 'runs', String(runId), 'request.json');
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  initialize() {
    initRunBase(this.basePath, ['runs']);
  }

  async startResearch(params = {}, options = {}) {
    const goal = String(params.goal || '').trim();
    if (!goal) {
      throw new Error('start_research requires goal');
    }
    if (!params.baseline_workflow_id) {
      throw new Error('start_research requires baseline_workflow_id');
    }

    const scope = this._resolveScope(options);
    const run = this._createRun({
      goal,
      baselineWorkflowId: Number(params.baseline_workflow_id),
      baselineParamOverrides: params.baseline_param_overrides || {},
      variants: this._normalizeVariants(params.variants || []),
      options: {
        workflowMode: params.workflow_mode || 'auto',
        scoringMethod: params.scoring_method || 'model-selected',
        requestedBySessionId: params.session_id || null,
        autoSaveKnowledge: params.auto_save_knowledge !== false
      },
      scope
    });

    const pending = this._executeResearch(run.run_id, scope)
      .catch(error => {
        console.error('[ResearchRuntime] Research run failed:', error.message);
        return null;
      })
      .finally(() => {
        this.pendingRuns.delete(run.run_id);
      });

    this.pendingRuns.set(run.run_id, pending);
    return {
      accepted: true,
      run_id: run.run_id,
      status: run.status,
      user_id: run.requested_by_user_id,
      run_dir: run.run_dir,
      result_path: run.result_path,
      report_path: run.final_report_path
    };
  }

  getRun(runId, options = {}) {
    const requestPath = this._findRequestPath(runId, options);
    if (!requestPath || !fs.existsSync(requestPath)) return null;
    const request = readJson(requestPath);
    const status = readJson(request.status_path);
    const result = fs.existsSync(request.result_path) ? readJson(request.result_path) : null;
    const scope = this._resolveScope(options);
    const requestedByUserId = normalizeUserId(request?.requested_by_user_id || 'localuser', 'localuser');
    if (requestedByUserId !== scope.userId) {
      return null;
    }
    return { ...request, ...status, result };
  }

  listRuns(filters = {}, options = {}) {
    const { limit = 20, status = null } = filters;
    const scoped = this._getScopedResearchPaths(options);
    const runs = listRunDirectories(scoped.runsPath)
      .map(id => this.getRun(id, scoped.scope))
      .filter(Boolean)
      .filter(run => status === null || String(run.status) === String(status))
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    return runs.slice(0, Math.max(1, Number(limit) || 20));
  }

  async waitForRun(runId, timeoutMs = 120000, options = {}) {
    const timeout = Math.max(500, Number(timeoutMs) || 120000);
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const pending = this.pendingRuns.get(runId);
      if (pending) {
        await Promise.race([pending.catch(() => null), new Promise(resolve => setTimeout(resolve, 50))]);
      }
      const run = this.getRun(runId, options);
      if (run && ['completed', 'failed'].includes(String(run.status))) {
        return run;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for research run ${runId}`);
  }

  _createRun({ goal, baselineWorkflowId, baselineParamOverrides, variants, options, scope }) {
    const scoped = this._getScopedResearchPaths(scope);
    initRunBase(scoped.basePath, ['runs']);

    const runId = generateRunId('research');
    const runDir = path.join(scoped.runsPath, runId);
    const artifactsDir = path.join(runDir, 'artifacts');
    ensureDir(runDir);
    ensureDir(artifactsDir);

    const requestPath = path.join(runDir, 'request.json');
    const statusPath = path.join(runDir, 'status.json');
    const resultPath = path.join(runDir, 'result.json');
    const tracePath = path.join(runDir, 'trace.md');
    const planPath = path.join(runDir, 'research_plan.json');
    const iterationsPath = path.join(runDir, 'iterations.jsonl');
    const scoreboardPath = path.join(runDir, 'scoreboard.json');
    const reportPath = path.join(runDir, 'final_report.md');
    const createdAt = new Date().toISOString();

    const request = {
      run_id: runId,
      goal,
      baseline_workflow_id: baselineWorkflowId,
      baseline_param_overrides: baselineParamOverrides,
      variants,
      options,
      requested_by_user_id: scope.userId,
      request_context: cloneRecord(scope.requestContext || null),
      created_at: createdAt,
      run_dir: runDir,
      artifacts_dir: artifactsDir,
      request_path: requestPath,
      status_path: statusPath,
      result_path: resultPath,
      trace_path: tracePath,
      research_plan_path: planPath,
      iterations_path: iterationsPath,
      scoreboard_path: scoreboardPath,
      final_report_path: reportPath
    };
    const status = {
      run_id: runId,
      status: 'queued',
      summary: '',
      error: null,
      user_id: scope.userId,
      created_at: createdAt,
      updated_at: createdAt,
      run_dir: runDir,
      result_path: resultPath,
      trace_path: tracePath
    };

    writeJson(requestPath, request);
    writeJson(statusPath, status);
    writeTraceFile(tracePath, [
      '# Research Run Trace',
      '',
      `- Run ID: ${runId}`,
      `- User ID: ${scope.userId}`,
      `- Goal: ${goal}`,
      `- Baseline Workflow ID: ${baselineWorkflowId}`,
      `- Variant Count: ${variants.length}`,
      ''
    ]);
    writeJson(planPath, {
      goal,
      user_id: scope.userId,
      baseline: {
        workflow_id: baselineWorkflowId,
        param_overrides: baselineParamOverrides
      },
      variants,
      scoring_method: options.scoringMethod,
      workflow_mode: options.workflowMode,
      generated_at: createdAt
    });
    return this.getRun(runId, scope);
  }

  _normalizeVariants(variants) {
    if (!Array.isArray(variants)) return [];
    return variants.map((variant, index) => ({
      id: variant.id || `V${index + 1}`,
      name: variant.name || `Variant ${index + 1}`,
      workflow_id: Number(variant.workflow_id),
      param_overrides: variant.param_overrides || {},
      mode: variant.mode || 'auto',
      notes: variant.notes || '',
      use_subagent: variant.use_subagent === true
    })).filter(v => Number.isFinite(v.workflow_id));
  }

  async _executeResearch(runId, options = {}) {
    const run = this.getRun(runId, options);
    if (!run) {
      throw new Error(`Research run not found: ${runId}`);
    }

    writeJson(run.status_path, {
      ...readJson(run.status_path),
      status: 'running',
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });

    const iterations = [];
    const appendIteration = (entry) => {
      appendJsonLine(run.iterations_path, entry);
      appendTraceSection(run.trace_path, `${entry.kind} ${entry.id}`, `\`\`\`json\n${JSON.stringify(entry, null, 2)}\n\`\`\``);
      iterations.push(entry);
    };

    const baseline = await this._runWorkflowExperiment({
      id: 'B0',
      kind: 'baseline',
      workflowId: run.baseline_workflow_id,
      paramOverrides: run.baseline_param_overrides || {},
      mode: run.options?.workflowMode || 'auto',
      sessionId: run.options?.requestedBySessionId || null,
      requestContext: run.request_context || null
    });
    appendIteration(baseline);

    let variants = Array.isArray(run.variants) ? [...run.variants] : [];
    if (variants.length < 2) {
      variants = variants.concat([
        { id: 'V1', name: 'Auto Variant 1', workflow_id: run.baseline_workflow_id, param_overrides: {}, mode: run.options?.workflowMode || 'auto', notes: 'Auto-generated variant' },
        { id: 'V2', name: 'Auto Variant 2', workflow_id: run.baseline_workflow_id, param_overrides: {}, mode: run.options?.workflowMode || 'auto', notes: 'Auto-generated variant' }
      ]).slice(0, 2);
    }

    for (const variant of variants) {
      const result = await this._runWorkflowExperiment({
        id: variant.id,
        kind: 'variant',
        workflowId: variant.workflow_id,
        paramOverrides: variant.param_overrides || {},
        mode: variant.mode || run.options?.workflowMode || 'auto',
        sessionId: run.options?.requestedBySessionId || null,
        requestContext: run.request_context || null,
        metadata: {
          name: variant.name,
          notes: variant.notes || '',
          use_subagent: variant.use_subagent === true
        }
      });
      appendIteration(result);
    }

    const scored = this._scoreIterations(iterations);
    writeJson(run.scoreboard_path, {
      run_id: run.run_id,
      user_id: run.requested_by_user_id,
      generated_at: new Date().toISOString(),
      scoring_method: run.options?.scoringMethod || 'model-selected',
      entries: scored
    });

    const winner = scored.find(entry => entry.kind === 'variant') || scored[0] || null;
    const stopReason = winner ? 'winner_found' : 'blocked';
    const summary = winner
      ? `Winner ${winner.id} score=${winner.score.toFixed(2)} success=${winner.success}`
      : 'No winner found';

    const report = this._buildReport(run, scored, winner, stopReason);
    fs.writeFileSync(run.final_report_path, report, 'utf-8');

    const completedAt = new Date().toISOString();
    const resultPayload = {
      run_id: run.run_id,
      user_id: run.requested_by_user_id,
      completed_at: completedAt,
      goal: run.goal,
      scoring_method: run.options?.scoringMethod || 'model-selected',
      baseline,
      ranking: scored,
      winner,
      stop_reason: stopReason,
      report_path: run.final_report_path
    };
    writeJson(run.result_path, resultPayload);
    writeJson(run.status_path, {
      ...readJson(run.status_path),
      status: 'completed',
      summary,
      error: null,
      completed_at: completedAt,
      updated_at: completedAt
    });

    if (run.options?.autoSaveKnowledge !== false) {
      await this._saveToKnowledge(run, resultPayload);
    }

    this.eventBus?.publish?.('research:run-completed', {
      runId: run.run_id,
      userId: run.requested_by_user_id,
      goal: run.goal,
      winnerId: winner?.id || null
    });

    return this.getRun(run.run_id, { userId: run.requested_by_user_id, requestContext: run.request_context || null });
  }

  async _runWorkflowExperiment({ id, kind, workflowId, paramOverrides, mode, sessionId, requestContext = null, metadata = {} }) {
    const started = Date.now();
    let workflowRun = null;
    let workflowRunId = null;
    let success = false;
    let error = null;
    let steps = 0;

    try {
      const workflowOptions = {
        mode,
        paramOverrides,
        requestedBySessionId: sessionId,
        requestContext
      };
      const ack = await this.workflowManager.runWorkflow(workflowId, workflowOptions);

      if (ack?.run_id) {
        workflowRunId = ack.run_id;
        if (ack.immediate) {
          workflowRun = await this.workflowManager.getWorkflowRun(workflowRunId, { requestContext });
        } else {
          workflowRun = await this.workflowManager.waitForWorkflowRun(workflowRunId, 120000, { requestContext });
        }
      } else {
        success = Boolean(ack?.result?.success);
      }

      success = success || Boolean(workflowRun?.result?.success || workflowRun?.status === 'completed');
      steps = Array.isArray(workflowRun?.result?.results) ? workflowRun.result.results.length : 0;
      if (!success) {
        error = workflowRun?.result?.error || workflowRun?.error || null;
      }
    } catch (runError) {
      success = false;
      error = runError.message;
    }

    const durationMs = Date.now() - started;
    return {
      id,
      kind,
      workflow_id: workflowId,
      workflow_run_id: workflowRunId,
      mode,
      success,
      duration_ms: durationMs,
      steps,
      error,
      metadata
    };
  }

  _scoreIterations(iterations) {
    const candidates = iterations.filter(entry => entry.kind === 'baseline' || entry.kind === 'variant');
    const durations = candidates.map(c => c.duration_ms).filter(n => Number.isFinite(n) && n >= 0);
    const minDuration = durations.length ? Math.min(...durations) : 1;
    const maxDuration = durations.length ? Math.max(...durations) : minDuration;
    const durationRange = Math.max(1, maxDuration - minDuration);

    const scored = candidates.map(entry => {
      const successScore = entry.success ? 70 : 0;
      const speedScore = Math.max(0, 30 * (1 - ((entry.duration_ms - minDuration) / durationRange)));
      const score = successScore + speedScore;
      return {
        ...entry,
        score: Number(score.toFixed(2))
      };
    });

    return scored.sort((a, b) => b.score - a.score);
  }

  _buildReport(run, scored, winner, stopReason) {
    const lines = [
      '# Research Report',
      '',
      `User ID: ${run.requested_by_user_id}`,
      `Goal: ${run.goal}`,
      `Scoring Method: ${run.options?.scoringMethod || 'model-selected'}`,
      `Stop Reason: ${stopReason}`,
      '',
      '## Ranking',
      ''
    ];
    for (const entry of scored) {
      lines.push(`- ${entry.id} (${entry.kind}) score=${entry.score} success=${entry.success} duration_ms=${entry.duration_ms} steps=${entry.steps}`);
    }
    lines.push('', '## Winner', '');
    if (winner) {
      lines.push(`- ID: ${winner.id}`);
      lines.push(`- Workflow ID: ${winner.workflow_id}`);
      lines.push(`- Workflow Run ID: ${winner.workflow_run_id || 'n/a'}`);
      lines.push(`- Score: ${winner.score}`);
    } else {
      lines.push('- No winner identified');
    }
    return `${lines.join('\n')}\n`;
  }

  async _saveToKnowledge(run, resultPayload) {
    if (!this.knowledgeManager || typeof this.knowledgeManager.createItem !== 'function') {
      return null;
    }
    const winner = resultPayload.winner;
    const report = [
      `Research Goal: ${run.goal}`,
      `User ID: ${run.requested_by_user_id}`,
      `Winner: ${winner ? winner.id : 'none'}`,
      `Workflow Run: ${winner?.workflow_run_id || 'n/a'}`,
      `Score: ${winner?.score ?? 'n/a'}`,
      `Report Path: ${run.final_report_path}`,
      `Result Path: ${run.result_path}`
    ].join('\n');
    try {
      return await this.knowledgeManager.createItem({
        title: `Research: ${run.goal.substring(0, 80)}`,
        content: report,
        category: 'research',
        tags: ['research', 'workflow', 'empirical'],
        source: 'research-runtime',
        confidence: 0.75
      });
    } catch (error) {
      console.error('[ResearchRuntime] Failed to persist knowledge:', error.message);
      return null;
    }
  }
}

module.exports = ResearchRuntime;
