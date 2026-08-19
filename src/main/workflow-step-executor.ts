// @ts-nocheck
const fs = require('fs');
const { getEffectiveLlmSelection } = require('./llm-state');

function deepGet(source, dottedPath) {
  const parts = String(dottedPath || '').split('.').filter(Boolean);
  let current = source;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current) && /^\d+$/.test(part)) {
      current = current[Number(part)];
    } else {
      current = current[part];
    }
  }
  return current;
}

function extractJsonObject(text) {
  const content = String(text || '').trim();
  if (!content) return null;

  const fenced = content.match(/```json\s*([\s\S]*?)```/i) || content.match(/```\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : content;
  try {
    return JSON.parse(candidate);
  } catch (_) {
    // Fall through to brace extraction.
  }

  const start = candidate.indexOf('{');
  if (start === -1) return null;

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
    if (inString) continue;
    if (char === '{') depth++;
    if (char === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, index + 1));
        } catch (_) {
          return null;
        }
      }
    }
  }
  return null;
}

function resolveTemplate(value, context) {
  if (typeof value !== 'string') {
    if (Array.isArray(value)) return value.map(item => resolveTemplate(item, context));
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, resolveTemplate(item, context)])
      );
    }
    return value;
  }

  const trimmed = value.trim();
  const wholeMatch = trimmed.match(/^\{\{\s*([^}]+?)\s*\}\}$/);
  if (wholeMatch) {
    return resolveReference(wholeMatch[1], context);
  }

  return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, ref) => {
    const resolved = resolveReference(ref, context);
    if (resolved === undefined || resolved === null) return '';
    return typeof resolved === 'string' ? resolved : JSON.stringify(resolved);
  });
}

function resolveReference(ref, context) {
  const key = String(ref || '').trim();
  if (key === 'previous' || key === 'previous.result') return context.previousResult;
  if (key === 'previous.output') return context.previousOutput;
  if (key === 'workflow.input' || key === 'input') return context.workflowInput;
  if (key.startsWith('input.')) return deepGet(context.workflowInput, key.slice('input.'.length));
  if (key.startsWith('steps.')) return deepGet(context, key);
  if (key.startsWith('workflow.')) return deepGet(context.workflow, key.slice('workflow.'.length));
  return deepGet(context, key);
}

function normalizeStep(step, index) {
  const type = String(step?.type || (step?.tool ? 'tool' : 'agent')).toLowerCase();
  const id = String(step?.id || step?.name || step?.tool || `step_${index + 1}`)
    .toLowerCase()
    .replace(/[^a-z0-9_/-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return { ...step, type, id };
}

class WorkflowStepExecutor {
  constructor({ mcpServer, dispatcher, workflowManager }) {
    this.mcpServer = mcpServer;
    this.dispatcher = dispatcher;
    this.workflowManager = workflowManager;
  }

  async executeSteps(workflow, paramOverrides = {}, options = {}) {
    const results = [];
    const state = {
      workflow,
      workflowInput: paramOverrides?._input || paramOverrides?.input || {},
      steps: {},
      previousResult: null,
      previousOutput: null,
      finalOutput: null
    };
    let success = true;

    for (let index = 0; index < workflow.tool_chain.length; index++) {
      const step = normalizeStep(workflow.tool_chain[index], index);
      try {
        const stepResult = step.type === 'agent'
          ? await this._executeAgentStep(step, workflow, state, options)
          : await this._executeToolStep(step, workflow, paramOverrides, state, options);

        results.push(stepResult);
        state.steps[step.id] = stepResult;
        state.previousResult = stepResult.result;
        state.previousOutput = stepResult.output;
        if (stepResult.finalOutput) state.finalOutput = stepResult.finalOutput;

        if (typeof options.onStep === 'function') {
          await options.onStep({ ...stepResult });
        }
      } catch (error) {
        success = false;
        const failed = {
          id: step.id,
          type: step.type,
          tool: step.tool,
          agent: step.agent,
          success: false,
          error: error.message
        };
        results.push(failed);
        if (typeof options.onStep === 'function') {
          await options.onStep({ ...failed });
        }
        break;
      }
    }

    const last = results[results.length - 1] || null;
    return {
      workflow,
      success,
      results,
      finalOutput: state.finalOutput || last?.finalOutput || last?.output || last?.result || null
    };
  }

  async _executeToolStep(step, workflow, paramOverrides, state, options = {}) {
    const toolName = String(step.tool || '').trim();
    if (!toolName) throw new Error(`Workflow step "${step.id}" is missing tool`);

    let params;
    if (step.params_from) {
      params = resolveTemplate(step.params_from, state);
    } else if (step.params !== undefined) {
      params = resolveTemplate(step.params || {}, state);
    } else if (state.previousOutput?.next_params && typeof state.previousOutput.next_params === 'object') {
      params = state.previousOutput.next_params;
    } else {
      params = {};
    }
    params = { ...(params || {}), ...(paramOverrides[toolName] || {}), ...(paramOverrides[step.id] || {}) };

    const baseExecutionContext = options.executionContext && typeof options.executionContext === 'object'
      ? { ...options.executionContext }
      : {};
    const sessionId = options.requestedBySessionId || baseExecutionContext.sessionId || null;
    const requestContext = options.requestContext || baseExecutionContext.requestContext || null;
    const principal = options.principal || baseExecutionContext.principal || null;
    const toolContext = {
      ...baseExecutionContext,
      source: 'workflow',
      workflowId: workflow.id,
      workflowRunId: options.workflowRunId || baseExecutionContext.workflowRunId || null,
      sessionId,
      requestContext
    };
    if (principal) {
      toolContext.principal = principal;
    }

    const result = await this.mcpServer.executeTool(toolName, params, null, {
      context: toolContext
    });
    if (result && result.needsPermission) {
      const error = new Error('Permission required');
      error.needsPermission = true;
      throw error;
    }

    return {
      id: step.id,
      type: 'tool',
      tool: toolName,
      params,
      success: true,
      result,
      output: result?.result !== undefined ? result.result : result
    };
  }

  async _executeAgentStep(step, workflow, state, options) {
    if (!this.dispatcher) {
      throw new Error('Workflow agent steps require an inference dispatcher');
    }

    const agentPrompt = this._loadWorkflowAgentPrompt(workflow, step);
    const requiredOutput = step.required_output || step.output_schema || (
      step.final ? { answer: 'string', summary: 'string', data: 'object' } : { next_params: 'object' }
    );
    const input = step.input !== undefined
      ? resolveTemplate(step.input, state)
      : (state.previousOutput !== null ? state.previousOutput : state.previousResult);

    const prompt = this._buildAgentPrompt({
      step,
      workflow,
      agentPrompt,
      input,
      requiredOutput,
      nextTool: this._findNextTool(workflow, step.id)
    });

    const baseExecutionContext = options.executionContext && typeof options.executionContext === 'object'
      ? options.executionContext
      : {};
    const requestContext = options.requestContext || baseExecutionContext.requestContext || null;
    const dispatchOptions = {
      ...await this._resolveAgentLlmOptions(step, options),
      mode: 'internal',
      includeTools: false,
      includeRules: false,
      includeEnv: true,
      skipMemoryOnStart: true,
      skipLock: options.skipAgentLock === true,
      preemptible: true,
      sessionId: options.requestedBySessionId || baseExecutionContext.sessionId || null,
      agentId: baseExecutionContext.agentId || null,
      requestContext
    };
    if (options.principal || baseExecutionContext.principal) {
      dispatchOptions.principal = options.principal || baseExecutionContext.principal;
    }

    const response = await this.dispatcher.dispatch(prompt, [], dispatchOptions).catch(async (error) => {
      if (this._shouldFallbackToDefault(step)) {
        const fallback = await this._defaultLlmOptions();
        return this.dispatcher.dispatch(prompt, [], {
          ...dispatchOptions,
          ...fallback
        });
      }
      throw error;
    });
    const parsed = extractJsonObject(response?.content);
    if (!parsed) {
      throw new Error(`Agent step "${step.id}" did not return valid JSON`);
    }

    const output = this._normalizeAgentOutput(parsed, step);
    return {
      id: step.id,
      type: 'agent',
      agent: step.agent || step.name || step.id,
      goal: step.goal || '',
      success: true,
      result: {
        content: response.content,
        model: response.model,
        usage: response.usage || null
      },
      output,
      finalOutput: step.final === true ? output : null
    };
  }

  _loadWorkflowAgentPrompt(workflow, step) {
    if (step.prompt || step.system) return String(step.prompt || step.system);
    const agentName = String(step.agent || step.name || step.id || '').trim();
    if (!agentName || !this.workflowManager?.resolveWorkflowAgentPath) return '';
    const agentPath = this.workflowManager.resolveWorkflowAgentPath(workflow, agentName);
    if (agentPath && fs.existsSync(agentPath)) {
      return fs.readFileSync(agentPath, 'utf-8');
    }
    return '';
  }

  _findNextTool(workflow, currentStepId) {
    const chain = workflow.tool_chain || [];
    const index = chain.findIndex((raw, i) => normalizeStep(raw, i).id === currentStepId);
    for (let nextIndex = index + 1; nextIndex < chain.length; nextIndex++) {
      const next = normalizeStep(chain[nextIndex], nextIndex);
      if (next.type === 'tool') return next.tool || null;
    }
    return null;
  }

  _buildAgentPrompt({ step, workflow, agentPrompt, input, requiredOutput, nextTool }) {
    const parts = [
      'You are a workflow-local agent step.',
      'You do not execute tools. You do not continue or stop the workflow.',
      'Your only job is to transform the provided input into the required JSON output.',
      'Return only valid JSON. Do not use markdown fences.',
      '',
      `Workflow: ${workflow.name}`,
      `Step: ${step.id}`,
      `Goal: ${step.goal || 'Transform input for the workflow.'}`
    ];
    if (agentPrompt) {
      parts.push('', '<agent_instructions>', agentPrompt, '</agent_instructions>');
    }
    if (nextTool) {
      parts.push('', `Next tool: ${nextTool}`);
    }
    parts.push(
      '',
      '<required_output>',
      JSON.stringify(requiredOutput, null, 2),
      '</required_output>',
      '',
      '<input>',
      JSON.stringify(input, null, 2),
      '</input>'
    );
    return parts.join('\n');
  }

  _normalizeAgentOutput(parsed, step) {
    if (step.final === true) {
      return {
        answer: parsed.answer || parsed.summary || JSON.stringify(parsed),
        summary: parsed.summary || parsed.answer || '',
        data: parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed
      };
    }
    if (parsed.next_params && typeof parsed.next_params === 'object') return parsed;
    if (step.wrap_output === false) return parsed;
    return { next_params: parsed };
  }

  async _resolveAgentLlmOptions(step, options) {
    const llm = step.llm && typeof step.llm === 'object' ? step.llm : {};
    const provider = String(step.provider || llm.provider || '').trim();
    const model = String(step.model || llm.model || '').trim();
    if (!provider && !model) return {};
    return {
      provider: provider || undefined,
      model: model || undefined,
      runtimeConfig: llm.runtimeConfig || undefined,
      thinkingMode: llm.thinkingMode || undefined,
      temperature: Number.isFinite(Number(llm.temperature)) ? Number(llm.temperature) : undefined,
      max_tokens: Number.isFinite(Number(llm.max_tokens)) ? Number(llm.max_tokens) : undefined,
      workflowAgentLlm: true,
      workflowAgentFallback: this._fallbackMode(step, options)
    };
  }

  async _defaultLlmOptions() {
    if (!this.dispatcher?.db) return {};
    const selection = await getEffectiveLlmSelection(this.dispatcher.db);
    return {
      provider: selection.provider || undefined,
      model: selection.model || undefined
    };
  }

  _fallbackMode(step, options) {
    const llm = step.llm && typeof step.llm === 'object' ? step.llm : {};
    return String(step.on_model_error || llm.on_error || options.onAgentModelError || 'default').toLowerCase();
  }

  _shouldFallbackToDefault(step, options = {}) {
    return this._fallbackMode(step, options) !== 'error';
  }
}

module.exports = {
  WorkflowStepExecutor,
  extractJsonObject,
  resolveTemplate,
  normalizeStep
};
