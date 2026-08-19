// @ts-nocheck
const TtsService = require('../tts-service');

function registerTtsHandlers(ipcMain, runtime) {
  const service = runtime.container?.optional?.('ttsService') || new TtsService({
    db: runtime.db,
    pluginManager: runtime.pluginManager,
    agentManager: runtime.agentManager,
  });

  function getRequestContext(event) {
    return event?.requestContext || null;
  }

  function buildScopeOptions(event) {
    return {
      requestContext: getRequestContext(event)
    };
  }

  ipcMain.handle('tts:get-settings', async (event) => service.getSettings(buildScopeOptions(event)));

  ipcMain.handle('tts:get-contract', async () => service.getContract());

  ipcMain.handle('tts:save-settings', async (event, settings) => {
    try {
      return { success: true, settings: await service.saveSettings(settings || {}, buildScopeOptions(event)) };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('tts:list-providers', async (event, options = {}) => {
    return service.listProviders(options || {});
  });

  ipcMain.handle('tts:list-voices', async (event, params = {}) => {
    return service.listVoices({ ...(params || {}), requestContext: event?.requestContext || params?.requestContext || null });
  });

  ipcMain.handle('tts:speak', async (event, params = {}) => {
    return service.speak({ ...(params || {}), requestContext: event?.requestContext || params?.requestContext || null });
  });

  ipcMain.handle('tts:speak-audio', async (event, params = {}) => {
    return service.speakAudio({ ...(params || {}), requestContext: event?.requestContext || params?.requestContext || null });
  });

  ipcMain.handle('tts:stop', async (event, params = {}) => {
    return service.stop({ ...(params || {}), requestContext: event?.requestContext || params?.requestContext || null });
  });
}

module.exports = { registerTtsHandlers };
