// @ts-nocheck
const { redactSettingsForRenderer, saveGenericSetting } = require('../settings-security');

function registerWorkflowHandlers(ipcMain, runtime) {
  const {
    db,
    aiService,
    workflowManager,
    windowManager
  } = runtime;

  function getRequestContext(event) {
    return event?.requestContext || null;
  }

  function buildScopeOptions(event) {
    return {
      requestContext: getRequestContext(event)
    };
  }

  function buildWorkflowExecutionOptions(event, options = {}) {
    const requestContext = getRequestContext(event);
    const requestedBySessionId = String(options.sessionId || requestContext?.sessionId || '').trim() || null;
    return {
      requestedBySessionId,
      requestContext,
      executionContext: requestContext
        ? {
            source: requestContext.source || 'ipc',
            sessionId: requestedBySessionId,
            requestContext
          }
        : null
    };
  }

  ipcMain.handle('get-workflows', async (event) => {
    try {
      if (workflowManager) {
        return await workflowManager.getWorkflows(buildScopeOptions(event));
      }
      return await db.getWorkflows(buildScopeOptions(event));
    } catch (error) {
      console.error('[IPC] get-workflows error:', error);
      return [];
    }
  });

  ipcMain.handle('save-workflow', async (event, workflow) => {
    try {
      const result = await workflowManager.captureWorkflow(
        workflow.name || 'unnamed',
        (workflow.tool_chain || []).map(s => {
          if (String(s.type || '').toLowerCase() === 'agent' || !s.tool) {
            return {
              type: 'agent',
              id: s.id,
              agent: s.agent,
              name: s.name,
              goal: s.goal,
              input: s.input,
              required_output: s.required_output,
              output_schema: s.output_schema,
              final: s.final === true,
              prompt: s.prompt,
              llm: s.llm,
              provider: s.provider,
              model: s.model,
              on_model_error: s.on_model_error
            };
          }
          return {
            type: 'tool',
            id: s.id,
            tool: s.tool,
            params: s.params || {},
            params_from: s.params_from
          };
        }),
        workflow.name,
        buildScopeOptions(event)
      );
      windowManager.send('workflow-update');
      return { success: true, workflow: result };
    } catch (error) {
      console.error('[IPC] save-workflow error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('delete-workflow', async (event, workflowId) => {
    try {
      await workflowManager.deleteWorkflow(workflowId, buildScopeOptions(event));
      windowManager.send('workflow-update');
      return { success: true };
    } catch (error) {
      console.error('[IPC] delete-workflow error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('run-workflow', async (event, workflowId) => {
    try {
      const result = await workflowManager.executeWorkflow(
        workflowId,
        {},
        buildWorkflowExecutionOptions(event)
      );
      windowManager.send('workflow-update');
      return { success: true, ...result };
    } catch (error) {
      console.error('[IPC] run-workflow error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('execute-workflow', async (event, workflowId, paramOverrides = {}) => {
    try {
      const result = await workflowManager.executeWorkflow(
        workflowId,
        paramOverrides,
        buildWorkflowExecutionOptions(event)
      );
      windowManager.send('workflow-update');
      return { success: true, ...result };
    } catch (error) {
      console.error('[IPC] execute-workflow error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('run-workflow-advanced', async (event, workflowId, options = {}) => {
    try {
      const executionOptions = buildWorkflowExecutionOptions(event, options || {});
      const result = await workflowManager.runWorkflow(workflowId, {
        mode: options.mode || 'auto',
        paramOverrides: options.paramOverrides || {},
        requestedBySessionId: executionOptions.requestedBySessionId,
        requestContext: executionOptions.requestContext,
        executionContext: executionOptions.executionContext
      });
      windowManager.send('workflow-update');
      return { success: true, ...result };
    } catch (error) {
      console.error('[IPC] run-workflow-advanced error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('get-workflow-run', async (event, runId) => {
    try {
      return await workflowManager.getWorkflowRun(runId, {
        requestContext: getRequestContext(event)
      });
    } catch (error) {
      console.error('[IPC] get-workflow-run error:', error);
      return null;
    }
  });

  ipcMain.handle('list-workflow-runs', async (event, filters = {}) => {
    try {
      return await workflowManager.listWorkflowRuns(filters || {}, {
        requestContext: getRequestContext(event)
      });
    } catch (error) {
      console.error('[IPC] list-workflow-runs error:', error);
      return [];
    }
  });

  ipcMain.handle('capture-workflow', async (event, trigger, toolChain, name = null) => {
    try {
      const result = await workflowManager.captureWorkflow(trigger, toolChain, name, buildScopeOptions(event));
      windowManager.send('workflow-update');
      return { success: true, workflow: result };
    } catch (error) {
      console.error('[IPC] capture-workflow error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('search-workflows', async (event, query) => {
    try {
      return await workflowManager.findMatchingWorkflows(query, buildScopeOptions(event));
    } catch (error) {
      console.error('[IPC] search-workflows error:', error);
      return [];
    }
  });

  ipcMain.handle('copy-workflow', async (event, workflowId, newName = null) => {
    try {
      const result = await workflowManager.copyWorkflow(workflowId, newName, buildScopeOptions(event));
      windowManager.send('workflow-update');
      return { success: true, workflow: result };
    } catch (error) {
      console.error('[IPC] copy-workflow error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('update-workflow', async (event, workflowId, data) => {
    try {
      const result = await workflowManager.updateWorkflow(workflowId, data, buildScopeOptions(event));
      windowManager.send('workflow-update');
      return { success: true, workflow: result };
    } catch (error) {
      console.error('[IPC] update-workflow error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('get-settings', async (event) => {
    const settings = redactSettingsForRenderer(await db.getAllSettings(buildScopeOptions(event)));
    const apiKeys = {};
    for (const provider of aiService.getProviders()) {
      const info = typeof db.getAPIKeyInfo === 'function'
        ? await db.getAPIKeyInfo(provider, buildScopeOptions(event))
        : { configured: Boolean(await db.getAPIKey(provider, buildScopeOptions(event))) };
      apiKeys[provider] = info.configured ? 'configured' : '';
    }
    return { ...settings, apiKeys };
  });

  ipcMain.handle('update-settings', async (event, settings) => {
    const scopeOptions = buildScopeOptions(event);
    for (const [key, value] of Object.entries(settings)) {
      await saveGenericSetting(db, key, value, scopeOptions);
    }
    return { success: true };
  });
  ipcMain.handle('open-new-window', async () => {
    if (!windowManager?.openAuxWindow) {
      return { success: false, error: 'Window manager not initialized' };
    }
    windowManager.openAuxWindow();
    return { success: true };
  });

  ipcMain.handle('set-api-key', async (event, provider, key) => {
    await db.setAPIKey(provider, key, buildScopeOptions(event));
    return { success: true };
  });
}

module.exports = { registerWorkflowHandlers };


