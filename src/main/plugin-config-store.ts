// @ts-nocheck
const { decryptSecret, encryptSecret } = require('./secure-secret-store');
const { SECRET_SETTING_REDACTION, isSecretSettingKey } = require('./settings-security');

function normalizePluginConfigKey(key) {
    const normalized = String(key || '').trim();
    if (!normalized) throw new Error('Plugin config key is required');
    return normalized;
}

function pluginSettingKey(pluginId, key) {
    return `plugin.${pluginId}.${key}`;
}

function credentialName(pluginId, key) {
    return pluginSettingKey(pluginId, key);
}

function credentialProviderName(name) {
    return `credential:${String(name || '').trim().toLowerCase()}`;
}

function isSchemaSecretField(definition = {}) {
    return definition?.secret === true || String(definition?.type || '').toLowerCase() === 'password';
}

class PluginConfigStore {
    constructor(db) {
        this.db = db;
    }

    isSecret(pluginId, manifest, key) {
        const normalized = normalizePluginConfigKey(key);
        const schema = manifest?.configSchema || {};
        return isSchemaSecretField(schema[normalized]) || isSecretSettingKey(pluginSettingKey(pluginId, normalized));
    }

    load(pluginId, manifest = {}, options = {}) {
        const scopeOptions = this._requireScope(options, 'plugin config load');
        const includeSecrets = scopeOptions.includeSecrets === true;
        const config = {};
        const prefix = `plugin.${pluginId}.`;
        const settings = this._getAllSettings(scopeOptions);
        const seen = new Set();

        for (const [fullKey, value] of Object.entries(settings)) {
            if (!fullKey.startsWith(prefix)) continue;
            const key = fullKey.slice(prefix.length);
            seen.add(key);
            if (this.isSecret(pluginId, manifest, key)) {
                this._loadSecret(config, pluginId, key, value, includeSecrets, scopeOptions);
            } else {
                config[key] = value;
            }
        }

        for (const key of this._manifestSecretKeys(manifest)) {
            if (seen.has(key)) continue;
            const credential = this._getCredential(credentialName(pluginId, key), scopeOptions);
            if (credential == null) continue;
            config[key] = includeSecrets ? credential : SECRET_SETTING_REDACTION;
        }

        return config;
    }

    get(pluginId, manifest = {}, key, options = {}) {
        const scopeOptions = this._requireScope(options, 'plugin config read');
        const normalized = normalizePluginConfigKey(key);
        const includeSecrets = scopeOptions.includeSecrets === true;
        if (this.isSecret(pluginId, manifest, normalized)) {
            const credential = this._getCredential(credentialName(pluginId, normalized), scopeOptions);
            if (credential != null) return includeSecrets ? credential : SECRET_SETTING_REDACTION;
            const row = this._getSetting(pluginSettingKey(pluginId, normalized), scopeOptions);
            if (!row || String(row.value || '') === '') return undefined;
            if (this._setCredential(credentialName(pluginId, normalized), row.value, scopeOptions)) {
                this._deleteSetting(pluginSettingKey(pluginId, normalized), scopeOptions);
            }
            return includeSecrets ? String(row.value || '') : SECRET_SETTING_REDACTION;
        }
        const row = this._getSetting(pluginSettingKey(pluginId, normalized), scopeOptions);
        if (!row) return undefined;
        return row.value;
    }

    set(pluginId, manifest = {}, key, value, options = {}) {
        const scopeOptions = this._requireScope(options, 'plugin config write');
        const normalized = normalizePluginConfigKey(key);
        if (this.isSecret(pluginId, manifest, normalized)) {
            return this._setSecret(pluginId, normalized, value, scopeOptions);
        }

        this._setSetting(pluginSettingKey(pluginId, normalized), String(value), scopeOptions);
        return { key: normalized, value: String(value), secret: false, preserved: false };
    }

    _resolveScope(options = {}) {
        const requestContext = options?.requestContext || null;
        const userId = String(options?.userId || options?.user_id || requestContext?.userId || requestContext?.user_id || '').trim();
        return { requestContext, userId };
    }

    _requireScope(options = {}, label = 'plugin config operation') {
        const scope = this._resolveScope(options);
        if (!scope.userId) {
            throw new Error(label + ' requires a concrete user');
        }
        return { ...options, requestContext: scope.requestContext, userId: scope.userId };
    }

    _getAllSettings(options = {}) {
        if (typeof this.db?.getAllSettingsSync === 'function') {
            return this.db.getAllSettingsSync(options);
        }
        const rows = this.db?.all ? this.db.all('SELECT key, value FROM settings') : [];
        return rows.reduce((acc, row) => {
            acc[row.key] = row.value;
            return acc;
        }, {});
    }

    _scopedSettingKey(settingKey, options = {}) {
        if (typeof this.db?._getScopedSettingStorageKey === 'function') {
            return this.db._getScopedSettingStorageKey(settingKey, options);
        }
        return settingKey;
    }

    _loadSecret(config, pluginId, key, legacyValue, includeSecrets, options = {}) {
        const name = credentialName(pluginId, key);
        let credential = this._getCredential(name, options);
        const hasLegacyValue = legacyValue != null && String(legacyValue) !== '';

        if (credential == null && hasLegacyValue && this._setCredential(name, legacyValue, options)) {
            credential = String(legacyValue);
            this._deleteSetting(pluginSettingKey(pluginId, key), options);
        }

        if (credential != null) {
            config[key] = includeSecrets ? credential : SECRET_SETTING_REDACTION;
        } else if (hasLegacyValue) {
            config[key] = includeSecrets ? String(legacyValue) : SECRET_SETTING_REDACTION;
        }
    }

    _setSecret(pluginId, key, value, options = {}) {
        if (String(value) === SECRET_SETTING_REDACTION) {
            return { key, secret: true, preserved: true };
        }

        const name = credentialName(pluginId, key);
        const nextValue = String(value || '');
        if (!nextValue) {
            this._deleteCredential(name, options);
            this._deleteSetting(pluginSettingKey(pluginId, key), options);
            return { key, value: '', secret: true, preserved: false };
        }

        if (!this._setCredential(name, nextValue, options)) {
            this._setSetting(pluginSettingKey(pluginId, key), nextValue, options);
        } else {
            this._deleteSetting(pluginSettingKey(pluginId, key), options);
        }
        return { key, value: nextValue, secret: true, preserved: false };
    }

    _manifestSecretKeys(manifest = {}) {
        return Object.entries(manifest.configSchema || {})
            .filter(([, definition]) => isSchemaSecretField(definition))
            .map(([key]) => key);
    }

    _getCredential(name, options = {}) {
        if (!this.db?.get) return null;
        const scope = this._requireScope(options, 'plugin setting scope');
        try {
            const row = this.db.get(
                'SELECT key, encrypted FROM api_keys WHERE provider = ? AND COALESCE(user_id, ?) = ?',
                [credentialProviderName(name), 'owner', scope.userId]
            );
            if (!row) return null;
            return decryptSecret(row.key, Boolean(row.encrypted));
        } catch (error) {
            return null;
        }
    }

    _getSetting(settingKey, options = {}) {
        try {
            return this.db.get('SELECT value FROM settings WHERE key = ?', [this._scopedSettingKey(settingKey, options)]);
        } catch (error) {
            return null;
        }
    }

    _setSetting(settingKey, value, options = {}) {
        this.db.run(
            'INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
            [this._scopedSettingKey(settingKey, options), value]
        );
    }

    _setCredential(name, value, options = {}) {
        if (!this.db?.run) return false;
        const scope = this._requireScope(options, 'plugin credential write');
        try {
            const encrypted = encryptSecret(value);
            this.db.run(
                'INSERT OR REPLACE INTO api_keys (provider, user_id, key, encrypted) VALUES (?, ?, ?, ?)',
                [credentialProviderName(name), scope.userId, encrypted.value, encrypted.encrypted ? 1 : 0]
            );
            return this._getCredential(name, options) === String(value);
        } catch (error) {
            return false;
        }
    }

    _deleteCredential(name, options = {}) {
        const scope = this._requireScope(options, 'plugin credential delete');
        try {
            this.db.run('DELETE FROM api_keys WHERE provider = ? AND COALESCE(user_id, ?) = ?', [credentialProviderName(name), 'owner', scope.userId]);
        } catch (error) {}
    }

    _deleteSetting(settingKey, options = {}) {
        try {
            this.db.run('DELETE FROM settings WHERE key = ?', [this._scopedSettingKey(settingKey, options)]);
        } catch (error) {}
    }
}

module.exports = {
    PluginConfigStore,
    credentialName,
    credentialProviderName,
    pluginSettingKey
};
