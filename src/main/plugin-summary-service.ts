// @ts-nocheck
class PluginSummaryService {
  list(plugins) {
    const result = [];
    for (const [id, plugin] of plugins) {
      result.push({
        id,
        name: plugin.manifest.name,
        version: plugin.manifest.version || '0.0.0',
        description: plugin.manifest.description || '',
        agentSlug: plugin.manifest.agentSlug || null,
        agentSlugs: plugin.manifest.agentSlugs || [],
        capabilities: this._capabilities(plugin),
        capabilityContracts: this._capabilityContracts(plugin),
        status: plugin.status,
        visibleInSidebar: plugin.visibleInSidebar !== false,
        handlerCount: plugin.handlers.length,
        handlers: plugin.handlers.map(handler => handler.toolName),
        chatUICount: plugin.chatUIs?.length || 0
      });
    }
    return result;
  }

  detail(plugins, pluginId, options = {}) {
    const plugin = plugins.get(pluginId);
    if (!plugin) return null;
    const loadConfig = options.loadConfig || (() => ({}));
    return {
      id: pluginId,
      manifest: plugin.manifest,
      status: plugin.status,
      visibleInSidebar: plugin.visibleInSidebar !== false,
      capabilities: this._capabilities(plugin),
      capabilityContracts: this._capabilityContracts(plugin),
      handlers: plugin.handlers.map(handler => ({
        name: handler.name,
        toolName: handler.toolName,
        description: handler.definition.description
      })),
      config: loadConfig(pluginId)
    };
  }

  _capabilities(plugin) {
    return Array.isArray(plugin.manifest.capabilities) ? plugin.manifest.capabilities : [];
  }

  _capabilityContracts(plugin) {
    return plugin.manifest.capabilityContracts || plugin.manifest.contracts || {};
  }
}

module.exports = PluginSummaryService;
