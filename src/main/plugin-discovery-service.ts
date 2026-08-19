// @ts-nocheck
const fs = require('fs');
const path = require('path');
const { validatePluginRuntimePermissions } = require('./runtime-policy');
const PluginStateStore = require('./plugin-state-store');

function createPluginRecord({ manifest, pluginDir, existing, visibleInSidebar }) {
  return {
    manifest,
    dir: pluginDir,
    status: 'disabled',
    persistedStatus: existing?.status || 'disabled',
    visibleInSidebar,
    module: null,
    context: null,
    handlers: [],
    chatUIs: [],
    managedProcesses: new Set()
  };
}

class PluginDiscoveryService {
  constructor(options = {}) {
    this.pluginsDir = options.pluginsDir;
    this.stateStore = options.stateStore || new PluginStateStore(options.db);
    this.logger = options.logger || console;
  }

  ensureDir() {
    if (!fs.existsSync(this.pluginsDir)) {
      fs.mkdirSync(this.pluginsDir, { recursive: true });
    }
  }

  scanInto(plugins, options = {}) {
    if (!fs.existsSync(this.pluginsDir)) return { scanned: 0, loaded: 0, skipped: 0 };
    const preserveExisting = options.preserveExisting === true;
    let scanned = 0;
    let loaded = 0;
    let skipped = 0;

    const dirs = fs.readdirSync(this.pluginsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const dir of dirs) {
      const pluginDir = path.join(this.pluginsDir, dir.name);
      const manifestPath = path.join(pluginDir, 'plugin.json');
      if (!fs.existsSync(manifestPath)) continue;
      scanned++;

      try {
        const manifest = this._readManifest(manifestPath);
        const validation = this._validateManifest(manifest);
        if (!validation.ok) {
          this.logger.warn?.(`[PluginDiscovery] Invalid manifest in ${dir.name}: ${validation.issues.join('; ')}`);
          skipped++;
          continue;
        }

        const runtimeValidation = validatePluginRuntimePermissions(manifest);
        if (!runtimeValidation.ok) {
          this.logger.warn?.(
            `[PluginDiscovery] Invalid runtimePermissions in ${dir.name}: ${runtimeValidation.issues.join('; ')}`
          );
          skipped++;
          continue;
        }

        const existing = this.stateStore.ensurePluginRow(manifest);
        const current = plugins.get(manifest.id);

        if (preserveExisting && current) {
          current.manifest = manifest;
          current.dir = pluginDir;
          current.persistedStatus = existing?.status || current.persistedStatus || 'disabled';
          current.visibleInSidebar = this.readPluginSidebarVisible(manifest.id);
          if (!current.managedProcesses) {
            current.managedProcesses = new Set();
          }
          loaded++;
          continue;
        }

        plugins.set(manifest.id, createPluginRecord({
          manifest,
          pluginDir,
          existing,
          visibleInSidebar: this.readPluginSidebarVisible(manifest.id)
        }));
        loaded++;
      } catch (error) {
        this.logger.error?.(`[PluginDiscovery] Failed to read manifest in ${dir.name}:`, error.message);
        skipped++;
      }
    }

    return { scanned, loaded, skipped };
  }

  sidebarVisibleSettingKey(pluginId) {
    return this.stateStore.sidebarVisibleSettingKey(pluginId);
  }

  readPluginSidebarVisible(pluginId) {
    return this.stateStore.readSidebarVisible(pluginId);
  }

  _readManifest(manifestPath) {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  }

  _validateManifest(manifest) {
    const issues = [];
    if (!manifest || typeof manifest !== 'object') {
      issues.push('manifest must be an object');
    } else {
      if (!manifest.id) issues.push('missing id');
      if (!manifest.name) issues.push('missing name');
      if (!manifest.main) issues.push('missing main');
    }
    return { ok: issues.length === 0, issues };
  }

}

module.exports = {
  PluginDiscoveryService,
  createPluginRecord
};
