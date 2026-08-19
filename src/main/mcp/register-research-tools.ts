// @ts-nocheck
function getResearchScopeOptions(server) {
  const currentExecutionContext = typeof server.getCurrentExecutionContext === 'function'
    ? server.getCurrentExecutionContext()
    : null;
  return { requestContext: currentExecutionContext?.requestContext || null };
}
function registerResearchTools(server) {
  server.registerTool('research_op', {
    name: 'research_op',
    description: 'Unified research operations. Actions: start, get, list.',
    userDescription: 'Run research operations',
    example: 'TOOL:research_op{"action":"list","limit":10}',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Operation: start | get | list' },
        run_id: { type: 'string', description: 'Research run identifier for get action' },
        limit: { type: 'number', description: 'Max runs for list action', default: 20 },
        status: { type: 'string', description: 'Optional status filter for list action' },
        goal: { type: 'string', description: 'Research goal for start action' },
        baseline_workflow_id: { type: 'number', description: 'Baseline workflow ID for start action' },
        baseline_param_overrides: { type: 'object', description: 'Optional baseline overrides', default: {} },
        variants: { type: 'array', description: 'Variant workflow configs', default: [] },
        workflow_mode: { type: 'string', description: 'Workflow mode label', default: 'auto' },
        scoring_method: { type: 'string', description: 'Scoring method label', default: 'model-selected' },
        auto_save_knowledge: { type: 'boolean', description: 'Persist research summary to knowledge', default: true }
      },
      required: ['action']
    }
  }, async (params) => {
    const runtime = server._researchRuntime;
    if (!runtime) return { error: 'Research runtime not initialized' };

    const action = String(params.action || '').toLowerCase();
    if (action === 'start') {
      if (!params.goal || !params.baseline_workflow_id) {
        return { error: 'goal and baseline_workflow_id are required for start action' };
      }
      return runtime.startResearch({
        ...params,
        session_id: server.getCurrentSessionId?.() || null
      });
    }

    if (action === 'get') {
      if (!params.run_id) return { error: 'run_id is required for get action' };
      return runtime.getRun(params.run_id, getResearchScopeOptions(server));
    }

    if (action === 'list') {
      return runtime.listRuns({
        limit: params.limit || 20,
        status: params.status
      });
    }

    return { error: `Unknown research action: ${params.action}` };
  });
}

module.exports = { registerResearchTools };


