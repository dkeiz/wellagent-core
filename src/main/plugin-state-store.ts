// @ts-nocheck
class PluginStateStore {
  constructor(db) {
    this.db = db;
  }

  ensurePluginRow(manifest) {
    const existing = this.db.get('SELECT id, status FROM plugins WHERE id = ?', [manifest.id]);
    if (!existing) {
      const initialStatus = manifest?.defaultEnabled === true ? 'enabled' : 'disabled';
      this.db.run(
        'INSERT INTO plugins (id, name, version, status) VALUES (?, ?, ?, ?)',
        [manifest.id, manifest.name, manifest.version || '0.0.0', initialStatus]
      );
      return { id: manifest.id, status: initialStatus };
    }
    return existing;
  }

  _scopeOptions(options = {}) {
    const requestContext = options?.requestContext || null;
    const userId = String(options?.userId || options?.user_id || requestContext?.userId || requestContext?.user_id || '').trim();
    return userId ? { ...options, requestContext, userId } : options;
  }

  statusSettingKey(pluginId) {
    return `plugin-state.${pluginId}.status`;
  }

  errorSettingKey(pluginId) {
    return `plugin-state.${pluginId}.error`;
  }

  getStatus(pluginId, options = {}) {
    const scopeOptions = this._scopeOptions(options);
    try {
      if (this.db?._getScopedSettingStorageKey && (scopeOptions?.requestContext || scopeOptions?.userId)) {
        const row = this.db.get('SELECT value FROM settings WHERE key = ?', [this.db._getScopedSettingStorageKey(this.statusSettingKey(pluginId), scopeOptions)]);
        return row?.value || null;
      }
      const row = this.db.get('SELECT status FROM plugins WHERE id = ?', [pluginId]);
      return row?.status || null;
    } catch (_) {
      return null;
    }
  }

  updateStatus(pluginId, status, error = null, options = {}) {
    const scopeOptions = this._scopeOptions(options);
    if (this.db?._getScopedSettingStorageKey && (scopeOptions?.requestContext || scopeOptions?.userId)) {
      this.db.run('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)', [this.db._getScopedSettingStorageKey(this.statusSettingKey(pluginId), scopeOptions), status]);
      this.db.run('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)', [this.db._getScopedSettingStorageKey(this.errorSettingKey(pluginId), scopeOptions), error || '']);
      return;
    }
    this.db.run(
      'UPDATE plugins SET status = ?, error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [status, error, pluginId]
    );
  }

  sidebarVisibleSettingKey(pluginId) {
    return `plugin-ui.${pluginId}.visibleInSidebar`;
  }

  readSidebarVisible(pluginId, options = {}) {
    const scopeOptions = this._scopeOptions(options);
    try {
      if (this.db?._getScopedSettingStorageKey && (scopeOptions?.requestContext || scopeOptions?.userId)) {
        const setting = this.db.get('SELECT value FROM settings WHERE key = ?', [this.db._getScopedSettingStorageKey(this.sidebarVisibleSettingKey(pluginId), scopeOptions)]);
        if (setting?.value != null) {
          return String(setting.value).toLowerCase() === 'true';
        }
      }
    } catch (_) {}

    try {
      const row = this.db.get('SELECT visible_in_sidebar FROM plugins WHERE id = ?', [pluginId]);
      if (row && row.visible_in_sidebar != null) {
        return row.visible_in_sidebar !== 0;
      }
    } catch (_) {}

    return true;
  }

  setSidebarVisible(pluginId, visible, options = {}) {
    const visibleInSidebar = visible === true;
    const scopeOptions = this._scopeOptions(options);
    if (this.db?._getScopedSettingStorageKey && (scopeOptions?.requestContext || scopeOptions?.userId)) {
      this.db.run('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)', [this.db._getScopedSettingStorageKey(this.sidebarVisibleSettingKey(pluginId), scopeOptions), String(visibleInSidebar)]);
      return visibleInSidebar;
    }
    try {
      this.db.run(
        'UPDATE plugins SET visible_in_sidebar = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [visibleInSidebar ? 1 : 0, pluginId]
      );
    } catch (_) {
      this.db.run(
        'INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
        [this.sidebarVisibleSettingKey(pluginId), String(visibleInSidebar)]
      );
    }
    return visibleInSidebar;
  }
}

module.exports = PluginStateStore;

