// @ts-nocheck
function registerTimerTools(server) {
  server.registerTool('timer', {
    name: 'timer',
    description: 'Set, list, pause, resume, and cancel backend timers that wake the current chat, agent, or workflow context when they fire.',
    userDescription: 'Schedule backend wake-up timers for the current context',
    example: 'TOOL:timer{"action":"set","id":"tea","delay":5,"unit":"minutes","message":"Tea is ready. Remind the user."}',
    exampleOutput: '{"ok":true,"id":"tea","status":"active","dueAt":"...","remainingMs":300000,"repeat":false}',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Operation: set | list | off | pause | resume'
        },
        id: {
          type: 'string',
          description: 'Timer id scoped to the current backend context'
        },
        delay: {
          type: 'number',
          description: 'Delay amount for set action'
        },
        unit: {
          type: 'string',
          description: 'Delay unit: ms | seconds | minutes | hours',
          default: 'seconds'
        },
        message: {
          type: 'string',
          description: 'Instruction included in the timer wake-up event',
          default: ''
        },
        repeat: {
          type: 'boolean',
          description: 'Repeat the timer after it fires',
          default: false
        }
      },
      required: ['action']
    }
  }, async (params, execution) => {
    if (!server._timerManager?.handle) {
      throw new Error('Timer manager is not available');
    }
    const result = await server._timerManager.handle(params, execution || {});
    if (server._artifactRegistry && String(params.action || '').toLowerCase() === 'set' && result?.ok) {
      const sessionId = server.getCurrentSessionId?.() || 'default';
      server._artifactRegistry.registerVirtual(sessionId, {
        name: `⏱ ${params.id || 'timer'} (${params.delay || '?'}${params.unit || 's'})`,
        kind: 'timer',
        source: 'timer',
        data: { id: params.id, delay: params.delay, unit: params.unit, message: params.message }
      });
    }
    return result;
  });
}

module.exports = { registerTimerTools };
