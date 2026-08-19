// @ts-nocheck
function registerWorkflowTools(server) {
  server.registerTool('workflow_op', {
    name: 'workflow_op',
    description: 'Unified workflow operations. Actions: list, execute, run, get_run, list_runs, create, copy, delete. Workflows may contain tool steps and agent steps.',
    userDescription: 'Run workflow operations',
    example: 'TOOL:workflow_op{"action":"list"}',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Operation: list | execute | run | get_run | list_runs | create | copy | delete'
        },
        id: { type: 'number', description: 'Workflow ID for execute/run/delete' },
        run_id: { type: 'string', description: 'Workflow run identifier for get_run' },
        mode: { type: 'string', description: 'Run mode for action=run', default: 'auto' },
        param_overrides: { type: 'object', description: 'Optional tool parameter overrides', default: {} },
        limit: { type: 'number', description: 'Max runs for list_runs', default: 20 },
        workflow_id: { type: 'number', description: 'Optional filter for list_runs' },
        status: { type: 'string', description: 'Optional status filter for list_runs' },
        name: { type: 'string', description: 'Workflow name for create' },
        description: { type: 'string', description: 'Workflow description for create' },
        tool_chain: { type: 'array', description: 'Workflow steps for create. Tool step: {type:"tool",tool,params}. Agent step: {type:"agent",agent,goal,input,required_output,final}.' },
        source_id: { type: 'number', description: 'Source workflow ID for copy' },
        new_name: { type: 'string', description: 'New name for copied workflow' }
      },
      required: ['action']
    }
  }, async (params) => {
    const wm = server._workflowManager;
    if (!wm) return { error: 'Workflow manager not initialized' };

    const currentExecutionContext = typeof server.getCurrentExecutionContext === 'function'
      ? server.getCurrentExecutionContext()
      : null;
    const requestContext = currentExecutionContext?.requestContext || null;
    const requestedBySessionId = currentExecutionContext?.sessionId ?? server.getCurrentSessionId?.() ?? null;
    const principal = currentExecutionContext?.principal || null;
    const scopeOptions = { requestContext };
    const action = String(params.action || '').toLowerCase();
    if (action === 'list') {
      const workflows = await wm.getWorkflows(scopeOptions);
      return workflows.map(workflow => ({
        id: workflow.id,
        name: workflow.name,
        description: workflow.description,
        tools: (workflow.tool_chain || []).map(step => step.tool || `agent:${step.agent || step.id || step.name || 'step'}`),
        success_count: workflow.success_count || 0,
        failure_count: workflow.failure_count || 0,
        last_used: workflow.last_used,
        created_at: workflow.created_at
      }));
    }

    if (action === 'execute') {
      if (!params.id) return { error: 'id is required for execute action' };
      return wm.executeWorkflow(params.id, params.param_overrides || {}, {
        requestedBySessionId,
        requestContext,
        executionContext: currentExecutionContext,
        principal
      });
    }

    if (action === 'run') {
      if (!params.id) return { error: 'id is required for run action' };
      return wm.runWorkflow(params.id, {
        mode: params.mode || 'auto',
        paramOverrides: params.param_overrides || {},
        requestedBySessionId,
        requestContext,
        executionContext: currentExecutionContext,
        principal
      });
    }

    if (action === 'get_run') {
      if (!params.run_id) return { error: 'run_id is required for get_run action' };
      return wm.getWorkflowRun(params.run_id, { requestContext });
    }

    if (action === 'list_runs') {
      return wm.listWorkflowRuns({
        limit: params.limit || 20,
        workflowId: params.workflow_id,
        status: params.status
      }, {
        requestContext
      });
    }

    if (action === 'create') {
      if (!params.name || !Array.isArray(params.tool_chain)) {
        return { error: 'name and tool_chain are required for create action' };
      }
      const result = await wm.captureWorkflow(
        params.name,
        params.tool_chain.map(step => {
          if (String(step.type || '').toLowerCase() === 'agent' || !step.tool) {
            return {
              type: 'agent',
              id: step.id,
              agent: step.agent,
              name: step.name,
              goal: step.goal,
              input: step.input,
              required_output: step.required_output,
              output_schema: step.output_schema,
              final: step.final === true,
              prompt: step.prompt,
              llm: step.llm,
              provider: step.provider,
              model: step.model,
              on_model_error: step.on_model_error
            };
          }
          return {
            type: 'tool',
            id: step.id,
            tool: step.tool,
            params: step.params || {},
            params_from: step.params_from
          };
        }),
        params.name,
        scopeOptions
      );
      return { success: true, id: result.id, name: params.name };
    }

    if (action === 'copy') {
      if (!params.source_id) return { error: 'source_id is required for copy action' };
      return wm.copyWorkflow(params.source_id, params.new_name, scopeOptions);
    }

    if (action === 'delete') {
      if (!params.id) return { error: 'id is required for delete action' };
      await wm.deleteWorkflow(params.id, scopeOptions);
      return { success: true, deleted_id: params.id };
    }

    return { error: `Unknown workflow action: ${params.action}` };
  });
}

module.exports = { registerWorkflowTools };