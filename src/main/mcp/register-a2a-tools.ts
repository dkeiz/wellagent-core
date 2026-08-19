// @ts-nocheck
function registerA2ATools(server) {
  server.registerTool('a2a_op', {
    name: 'a2a_op',
    description: 'A2A and interop operations. Actions: list_targets, describe_target, probe_target, call_target, discover_a2a, get_run.',
    userDescription: 'Discover and call A2A or external interop targets',
    example: 'TOOL:a2a_op{"action":"list_targets"}',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Operation: list_targets | describe_target | probe_target | call_target | discover_a2a | get_run'
        },
        targetId: {
          type: 'string',
          description: 'Target identifier for describe/probe/call actions'
        },
        url: {
          type: 'string',
          description: 'Remote A2A base URL or card URL for discovery'
        },
        prompt: {
          type: 'string',
          description: 'Prompt text for call_target'
        },
        payload: {
          type: 'object',
          description: 'Structured payload for workflow or advanced target calls'
        },
        stream: {
          type: 'boolean',
          description: 'Use streaming mode when supported'
        },
        runId: {
          type: 'string',
          description: 'Run ID for get_run'
        }
      },
      required: ['action']
    }
  }, async (params) => {
    const manager = server._a2aManager;
    if (!manager) {
      return { error: 'A2AManager not initialized' };
    }

    const action = String(params.action || '').trim().toLowerCase();
    if (action === 'list_targets') {
      return manager.listTargets();
    }
    if (action === 'describe_target') {
      return manager.describeTarget(params.targetId);
    }
    if (action === 'probe_target') {
      return manager.probeTarget(params.targetId);
    }
    if (action === 'call_target') {
      return manager.callTarget(params.targetId, {
        prompt: params.prompt,
        payload: params.payload,
        workflow: params.payload,
        stream: params.stream === true
      });
    }
    if (action === 'discover_a2a') {
      return manager.discoverA2A(params.url);
    }
    if (action === 'get_run') {
      return manager.getRun(params.runId);
    }

    return { error: `Unknown a2a_op action: ${params.action}` };
  });
}

module.exports = { registerA2ATools };
