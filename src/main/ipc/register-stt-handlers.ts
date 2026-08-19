// @ts-nocheck
const SttService = require('../stt-service');

function registerSttHandlers(ipcMain, runtime) {
  const service = runtime.container?.optional?.('sttService') || new SttService({
    db: runtime.db,
    runtimePaths: runtime.container?.optional?.('runtimePaths'),
    pluginManager: runtime.container?.optional?.('pluginManager')
  });

  function getRequestContext(event) {
    return event?.requestContext || null;
  }

  function buildScopeOptions(event) {
    return {
      requestContext: getRequestContext(event)
    };
  }

  ipcMain.handle('stt:get-contract', async () => service.getContract());

  ipcMain.handle('stt:get-settings', async (event) => service.getSettings(buildScopeOptions(event)));

  ipcMain.handle('stt:save-settings', async (event, settings) => {
    return service.saveSettings(settings || {}, buildScopeOptions(event));
  });

  ipcMain.handle('stt:list-providers', async (event, options = {}) => {
    return service.listProviders(options || {});
  });

  ipcMain.handle('stt:transcribe-audio', async (event, params = {}) => {
    return service.transcribeAudio({ ...(params || {}), requestContext: event?.requestContext || params?.requestContext || null });
  });
}

module.exports = { registerSttHandlers };