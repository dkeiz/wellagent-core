// @ts-nocheck
const { quickSetupPlugin } = require('../plugin-setup-service');

function registerPluginKnowledgeHandlers(ipcMain, runtime) {
  const { container, windowManager } = runtime;
  const getFromRuntime = (key) => runtime?.[key] || container?.optional?.(key) || null;
  const getPluginManager = () => getFromRuntime('pluginManager');
  const getRuntimePaths = () => getFromRuntime('runtimePaths');
  const getKnowledgeManager = () => getFromRuntime('knowledgeManager');
  const notifyPluginStateChanged = (pluginId, source) => {
    if (!windowManager) return;
    windowManager.send('plugins:state-changed', {
      pluginId,
      source: source || 'unknown',
      at: new Date().toISOString()
    });
  };

  function buildScopeOptions(event) {
    return { requestContext: event?.requestContext || null };
  }

  ipcMain.handle('plugins:list', async () => {
    const pm = getPluginManager();
    if (!pm) return [];
    return pm.listPlugins();
  });

  ipcMain.handle('plugins:scan', async (event, options = {}) => {
    const pm = getPluginManager();
    if (!pm) return { success: false, error: 'Plugin system not ready' };
    try {
      const result = pm.rescanPlugins
        ? await pm.rescanPlugins()
        : { total: pm.listPlugins().length, added: [] };
      return { success: true, ...result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('plugins:enable', async (event, pluginId, options = {}) => {
    const pm = getPluginManager();
    if (!pm) return { success: false, error: 'Plugin system not ready' };
    try {
      await pm.enablePlugin(pluginId, { ...buildScopeOptions(event), persistStatus: true });
      notifyPluginStateChanged(pluginId, 'enable');
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('plugins:disable', async (event, pluginId, options = {}) => {
    const pm = getPluginManager();
    if (!pm) return { success: false, error: 'Plugin system not ready' };
    try {
      await pm.disablePlugin(pluginId, { ...buildScopeOptions(event), persistStatus: true });
      notifyPluginStateChanged(pluginId, 'disable');
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('plugins:set-sidebar-visible', async (event, pluginId, visible, options = {}) => {
    const pm = getPluginManager();
    if (!pm) return { success: false, error: 'Plugin system not ready' };
    try {
      const result = pm.setPluginSidebarVisible(pluginId, visible === true, buildScopeOptions(event));
      notifyPluginStateChanged(pluginId, 'sidebar-visible');
      return { success: true, ...result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('plugins:get-config', async (event, pluginId) => {
    const pm = getPluginManager();
    if (!pm) return {};
    return pm.getPluginConfig(pluginId, buildScopeOptions(event));
  });

  ipcMain.handle('plugins:set-config', async (event, pluginId, key, value, options = {}) => {
    const pm = getPluginManager();
    if (!pm) return { success: false, error: 'Plugin system not ready' };
    try {
      await pm.setPluginConfig(pluginId, key, value, buildScopeOptions(event));
      notifyPluginStateChanged(pluginId, 'config');
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('plugins:inspect', async (event, pluginId) => {
    const pm = getPluginManager();
    if (!pm) return null;
    return pm.getPluginDetail(pluginId, buildScopeOptions(event));
  });

  ipcMain.handle('plugins:get-setup-ui', async (event, pluginId) => {
    const pm = getPluginManager();
    if (!pm?.getPluginSetupUI) return null;
    try {
      return await pm.getPluginSetupUI(pluginId, buildScopeOptions(event));
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('plugins:run-action', async (event, pluginId, action, params, options = {}) => {
    const pm = getPluginManager();
    if (!pm) return { success: false, error: 'Plugin system not ready' };
    try {
      const result = await pm.runPluginAction(pluginId, action, params || {}, buildScopeOptions(event));
      notifyPluginStateChanged(pluginId, `action:${action}`);
      return { success: true, result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('plugins:open-studio', async (event, options) => {
    if (!windowManager) return { success: false, error: 'Window manager not available' };
    try {
      windowManager.send('plugins:open-studio', options || {});
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('plugins:quick-setup', async (event, pluginName, options = {}) => {
    const pm = getPluginManager();
    const paths = getRuntimePaths();
    if (!pm || !paths?.pluginsDir) {
      return { success: false, error: 'Plugin system not ready' };
    }
    try {
      const setup = await quickSetupPlugin({
        pluginName,
        pluginManager: pm,
        pluginsDir: paths.pluginsDir,
        scopeOptions: buildScopeOptions(event)
      });

      if (windowManager) windowManager.send('plugins:open-studio', { focusPluginId: setup.pluginId });
      notifyPluginStateChanged(setup.pluginId, 'quick-setup');

      return { success: true, pluginId: setup.pluginId, enabled: setup.enabled === true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('plugins:get-sidebar-widgets', async () => {
    const pm = getPluginManager();
    if (!pm || !pm.getSidebarWidgets) return [];
    return pm.getSidebarWidgets();
  });

  ipcMain.handle('plugins:run-sidebar-widget-action', async (event, widgetId, action, params = {}) => {
    const pm = getPluginManager();
    if (!pm?.runSidebarWidgetAction) {
      return { success: false, error: 'Plugin sidebar widget actions are unavailable' };
    }
    try {
      const result = await pm.runSidebarWidgetAction(widgetId, action, params || {});
      notifyPluginStateChanged(String(widgetId || ''), `sidebar:${action}`);
      return { success: true, result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('knowledge:list', async (event, options) => {
    const km = getKnowledgeManager();
    if (!km) return [];
    return km.listItems(options || {});
  });

  ipcMain.handle('knowledge:stats', async () => {
    const km = getKnowledgeManager();
    if (!km) return { total: 0, active: 0, staged: 0 };
    return km.getStats();
  });

  ipcMain.handle('knowledge:confirm', async (event, slug, options = {}) => {
    const km = getKnowledgeManager();
    if (!km) return { success: false, error: 'Knowledge system not ready' };
    try {
      await km.promoteStaged(slug);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('knowledge:reject', async (event, slug, options = {}) => {
    const km = getKnowledgeManager();
    if (!km) return { success: false, error: 'Knowledge system not ready' };
    try {
      await km.rejectStaged(slug);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('knowledge:tree', async () => {
    const km = getKnowledgeManager();
    if (!km) return { library: [], staging: [], stats: {} };
    return km.getKnowledgeTree();
  });
}

module.exports = { registerPluginKnowledgeHandlers };


