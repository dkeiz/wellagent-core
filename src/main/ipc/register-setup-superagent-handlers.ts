// @ts-nocheck
function registerSetupSuperagentHandlers(ipcMain, runtime) {
  const { setupSuperagentService } = runtime;

  function buildScopeOptions(event) {
    return { requestContext: event?.requestContext || null };
  }

  ipcMain.handle('setup-superagent:get-assessment', async (event, options = {}) => {
    if (!setupSuperagentService?.getAssessment) {
      return { success: false, error: 'Setup superagent service unavailable' };
    }
    try {
      const assessment = await setupSuperagentService.getAssessment({ ...(options || {}), ...buildScopeOptions(event) });
      return { success: true, assessment };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('setup-superagent:run-action', async (event, input = {}) => {
    if (!setupSuperagentService?.runAction) {
      return { success: false, error: 'Setup superagent service unavailable' };
    }
    try {
      return await setupSuperagentService.runAction(input || {}, buildScopeOptions(event));
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('setup-superagent:dismiss-action', async (event, actionId) => {
    if (!setupSuperagentService?.dismissAction) {
      return { success: false, error: 'Setup superagent service unavailable' };
    }
    try {
      return await setupSuperagentService.dismissAction(actionId, buildScopeOptions(event));
    } catch (error) {
      return { success: false, error: error.message };
    }
  });
}

module.exports = { registerSetupSuperagentHandlers };
