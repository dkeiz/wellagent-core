// @ts-nocheck
function registerToolsCapabilityHandlers(ipcMain, runtime) {
  const {
    db,
    mcpServer,
    windowManager,
    capabilityManager,
    toolPermissionService,
    requestContextService
  } = runtime;

  async function buildToolExecutionContext(event, overrides = {}) {
    const requestContext = event?.requestContext || overrides?.requestContext || null;
    let sessionId = overrides?.sessionId || requestContext?.sessionId || null;
    if (!sessionId && requestContextService?.getPreferredSessionId) {
      sessionId = await requestContextService.getPreferredSessionId(db, requestContext || {}).catch(() => null);
    }
    if (!sessionId) sessionId = mcpServer.getCurrentSessionId?.() || null;
    let agentId = overrides?.agentId || requestContext?.agentId || null;
    if (!agentId && sessionId && db?.getChatSessionById) {
      const session = await db.getChatSessionById(sessionId, { requestContext }).catch(() => null);
      agentId = session?.agent_id || null;
    }
    return {
      ...(overrides || {}),
      sessionId,
      agentId,
      source: overrides?.source || requestContext?.source || 'ipc',
      requestContext
    };
  }

  ipcMain.handle('execute-tool', async (event, toolName, params) => {
    try {
      const result = await mcpServer.executeTool(toolName, params, null, {
        context: await buildToolExecutionContext(event)
      });
      return { success: true, result };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('get-mcp-tools', async (event, context = {}) => {
    if (context?.inventory === true || context?.mode === 'inventory') {
      return mcpServer.getTools();
    }
    if (mcpServer.getToolsForContext) {
      return mcpServer.getToolsForContext(context || {});
    }
    return mcpServer.getTools();
  });
  ipcMain.handle('get-mcp-tool-inventory', async () => mcpServer.getTools());
  ipcMain.handle('get-mcp-tools-documentation', async () => mcpServer.getToolsDocumentation());
  ipcMain.handle('get-tool-groups', async () => mcpServer.getToolGroups());

  ipcMain.handle('activate-tool-group', async (event, groupId) => {
    try {
      const result = await mcpServer.activateGroup(groupId);
      return { success: true, ...result };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('deactivate-tool-group', async (event, groupId) => {
    try {
      const result = await mcpServer.deactivateGroup(groupId);
      return { success: true, ...result };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('get-active-tools', async () => mcpServer.getActiveTools());

  ipcMain.handle('execute-mcp-tool', async (event, toolName, params) => {
    try {
      const result = await mcpServer.executeTool(toolName, params, null, {
        context: await buildToolExecutionContext(event)
      });
      if (result.needsPermission) {
        windowManager.send('tool-permission-request', result);
        return { needsPermission: true, toolName, params };
      }
      return { success: true, result };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('execute-mcp-tool-once', async (event, toolName, params, options = {}) => {
    try {
      const result = await mcpServer.executeTool(toolName, params, null, {
        allowOutsideExecutionRootOnce: options?.allowOutsideExecutionRootOnce === true,
        allowExternalCaptureOnce: options?.allowExternalCaptureOnce === true,
        context: await buildToolExecutionContext(event, options?.context || {})
      });
      if (result.needsPermission) {
        windowManager.send('tool-permission-request', result);
        return { needsPermission: true, toolName, params };
      }
      return { success: true, result };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('get-tool-calls', async (event, sessionId = null, limit = 100, cursor = null) => {
    try {
      return await db.getToolCalls(sessionId, limit, { requestContext: event?.requestContext || null, cursor });
    } catch (error) {
      console.error('Failed to get tool calls:', error);
      return [];
    }
  });

  ipcMain.handle('get-tool-states', async () => {
    try {
      return await db.getToolStates();
    } catch (error) {
      console.error('Failed to get tool states:', error);
      return {};
    }
  });

  ipcMain.handle('set-tool-active', async (event, toolName, active, context = {}) => {
    try {
      const agentId = context?.agentId ? Number(context.agentId) : null;
      if (agentId && toolPermissionService) {
        await toolPermissionService.setAgentTool(agentId, toolName, active);
      } else {
        await db.setToolActive(toolName, active);
        if (mcpServer.setToolActiveState) {
          await mcpServer.setToolActiveState(toolName, active);
        }
        if (toolPermissionService) {
          await toolPermissionService.syncUnsafeFromGlobal();
        }

        if (active && capabilityManager) {
          const groupId = capabilityManager.getGroupForTool(toolName);
          if (groupId && !capabilityManager.isGroupEnabled(groupId)) {
            capabilityManager.setGroupEnabled(groupId, true);
            console.log(`[IPC] Auto-enabled capability group '${groupId}' because tool '${toolName}' was enabled`);
          }
          windowManager.send('capability-update', capabilityManager.getState());
        } else if (!active && capabilityManager) {
          windowManager.send('capability-update', capabilityManager.getState());
        }
      }

      console.log(`[IPC] Tool ${toolName} ${active ? 'enabled' : 'disabled'} (DB + memory)`);
      return { success: true, toolName, active, scope: agentId ? 'agent' : 'global' };
    } catch (error) {
      console.error('Failed to set tool active state:', error);
      throw error;
    }
  });

  ipcMain.handle('create-custom-tool', async (event, toolData) => {
    try {
      await mcpServer.executeTool('create_tool', toolData);
      if (capabilityManager) {
        windowManager.send('capability-update', capabilityManager.getState());
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('get-custom-tools', async () => {
    try {
      return await db.getCustomTools();
    } catch (error) {
      return [];
    }
  });

  ipcMain.handle('delete-custom-tool', async (event, toolName) => {
    try {
      await db.deleteCustomTool(toolName);
      mcpServer.tools.delete(toolName);
      if (capabilityManager) {
        capabilityManager.customToolSafety.delete(toolName);
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('update-custom-tool', async (event, existingName, updates = {}) => {
    try {
      const updated = await db.updateCustomTool(existingName, updates);
      const oldName = String(existingName || '');
      if (oldName && oldName !== updated.name) {
        mcpServer.tools.delete(oldName);
        if (capabilityManager) {
          const wasSafe = capabilityManager.isCustomToolSafe(oldName);
          capabilityManager.unregisterCustomTool(oldName);
          capabilityManager.registerCustomTool(updated.name, wasSafe);
        }
      } else if (capabilityManager && !capabilityManager.customToolSafety.has(updated.name)) {
        capabilityManager.registerCustomTool(updated.name, false);
      }

      mcpServer.tools.delete(updated.name);
      mcpServer.registerCustomTool({
        name: updated.name,
        description: updated.description,
        code: updated.code,
        input_schema: JSON.parse(updated.input_schema || '{}')
      });
      if (capabilityManager) {
        windowManager.send('capability-update', capabilityManager.getState());
      }
      return { success: true, tool: updated };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('capability:get-state', async () => {
    if (!capabilityManager) return { error: 'CapabilityManager not initialized' };
    return capabilityManager.getState();
  });

  ipcMain.handle('capability:get-groups', async () => {
    if (!capabilityManager) return [];
    return capabilityManager.getGroupsConfig();
  });

  ipcMain.handle('capability:set-main', async (event, enabled) => {
    if (!capabilityManager) return { error: 'CapabilityManager not initialized' };
    const result = capabilityManager.setMainEnabled(enabled);
    windowManager.send('capability-update', capabilityManager.getState());
    return { success: true, mainEnabled: result };
  });

  ipcMain.handle('capability:set-group', async (event, groupId, enabled) => {
    if (!capabilityManager) return { error: 'CapabilityManager not initialized' };
    const result = capabilityManager.setGroupEnabled(groupId, enabled);
    if (groupId === 'unsafe' && toolPermissionService) {
      await toolPermissionService.syncUnsafeFromGlobal();
    }
    windowManager.send('capability-update', capabilityManager.getState());
    return { success: result };
  });

  ipcMain.handle('capability:set-files-mode', async (event, mode) => {
    if (!capabilityManager) return { error: 'CapabilityManager not initialized' };
    try {
      const result = capabilityManager.setFilesMode(mode);
      windowManager.send('capability-update', capabilityManager.getState());
      return { success: true, mode: result };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('capability:set-terminal-mode', async (event, mode) => {
    if (!capabilityManager?.setTerminalMode) return { error: 'CapabilityManager terminal modes unavailable' };
    try {
      const result = capabilityManager.setTerminalMode(mode);
      windowManager.send('capability-update', capabilityManager.getState());
      return { success: true, mode: result };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  function buildPermissionContext(event, context = {}) {
    return { ...(context || {}), requestContext: event?.requestContext || context?.requestContext || null };
  }

  ipcMain.handle('capability:get-active-tools', async (event, context = {}) => {
    if (!toolPermissionService) {
      if (mcpServer.getActiveToolsForContext) {
        const tools = await mcpServer.getActiveToolsForContext(buildPermissionContext(event, context));
        return tools.map((tool) => tool.name).filter(Boolean);
      }
      if (!capabilityManager) return mcpServer.getActiveTools().map(t => t.name);
      return capabilityManager.getActiveTools().filter((toolName) => {
        const def = mcpServer.tools.get(toolName)?.definition;
        return def && def.internal !== true;
      });
    }
    const names = await toolPermissionService.getContextActiveToolNames(buildPermissionContext(event, context));
    return names.filter((toolName) => {
      const def = mcpServer.tools.get(toolName)?.definition;
      return def && def.internal !== true;
    });
  });

  ipcMain.handle('permissions:get-context', async (event, context = {}) => {
    if (!toolPermissionService) return { error: 'ToolPermissionService not initialized' };
    return toolPermissionService.resolveContext(buildPermissionContext(event, context));
  });

  ipcMain.handle('permissions:get-agent-profile', async (event, agentId) => {
    if (!toolPermissionService) return { error: 'ToolPermissionService not initialized' };
    return toolPermissionService.getAgentProfile(agentId, { requestContext: event?.requestContext || null });
  });

  ipcMain.handle('permissions:set-agent-group', async (event, agentId, groupId, value) => {
    if (!toolPermissionService) return { error: 'ToolPermissionService not initialized' };
    return toolPermissionService.setAgentGroup(agentId, groupId, value, { requestContext: event?.requestContext || null });
  });

  ipcMain.handle('permissions:set-agent-tool', async (event, agentId, toolName, active) => {
    if (!toolPermissionService) return { error: 'ToolPermissionService not initialized' };
    return toolPermissionService.setAgentTool(agentId, toolName, active, { requestContext: event?.requestContext || null });
  });

  ipcMain.handle('permissions:apply-agent-preset', async (event, agentId, presetId) => {
    if (!toolPermissionService) return { error: 'ToolPermissionService not initialized' };
    return toolPermissionService.applyAgentPreset(agentId, presetId, { requestContext: event?.requestContext || null });
  });

  ipcMain.handle('permissions:reset-agent-profile', async (event, agentId) => {
    if (!toolPermissionService) return { error: 'ToolPermissionService not initialized' };
    return toolPermissionService.resetAgentProfile(agentId, { requestContext: event?.requestContext || null });
  });

  ipcMain.handle('capability:add-port-listener', async (event, listener) => {
    if (!capabilityManager) return { error: 'CapabilityManager not initialized' };
    const result = capabilityManager.addPortListener(listener);
    return { success: true, listener: result };
  });

  ipcMain.handle('capability:remove-port-listener', async (event, port) => {
    if (!capabilityManager) return { error: 'CapabilityManager not initialized' };
    capabilityManager.removePortListener(port);
    return { success: true };
  });

  ipcMain.handle('capability:get-port-listeners', async () => {
    if (!capabilityManager) return [];
    return capabilityManager.getPortListeners();
  });

  ipcMain.handle('capability:set-custom-tool-safe', async (event, toolName, isSafe) => {
    if (!capabilityManager) return { error: 'CapabilityManager not initialized' };
    capabilityManager.setCustomToolSafe(toolName, isSafe);
    return { success: true };
  });
}

module.exports = { registerToolsCapabilityHandlers };
