// @ts-nocheck
const {
  getCapabilityContract,
  normalizeSttTranscriptionResult
} = require('./plugin-capability-contracts');
const DEFAULT_STT_PLUGIN_ID = 'whisper-stt';

class SttService {
  constructor({ db, runtimePaths, pluginManager }) {
    this.db = db;
    this.runtimePaths = runtimePaths || null;
    this.pluginManager = pluginManager || null;
  }

  _buildScopeOptions(options = {}) {
    const userId = String(options?.userId || '').trim();
    return {
      requestContext: options?.requestContext || null,
      userId: userId || undefined
    };
  }

  async _getSetting(key, options = {}) {
    const scopeOptions = this._buildScopeOptions(options);
    if (this.db?.getScopedSetting && (scopeOptions.requestContext || scopeOptions.userId)) {
      return this.db.getScopedSetting(key, scopeOptions);
    }
    return this.db.getSetting(key);
  }

  async _saveSetting(key, value, options = {}) {
    const scopeOptions = this._buildScopeOptions(options);
    if (this.db?.saveScopedSetting && (scopeOptions.requestContext || scopeOptions.userId)) {
      return this.db.saveScopedSetting(key, value, scopeOptions);
    }
    return this.db.saveSetting(key, value);
  }

  getContract() {
    return getCapabilityContract('stt');
  }

  async getSettings(options = {}) {
    return {
      defaultPluginId: await this._getSetting('stt.defaultPluginId', options) || ''
    };
  }

  async saveSettings(settings = {}, options = {}) {
    if (settings.defaultPluginId !== undefined) {
      await this._saveSetting('stt.defaultPluginId', String(settings.defaultPluginId || ''), options);
    }
    return this.getSettings(options);
  }

  _isEnabledProvider(provider) {
    return String(provider?.status || '').trim().toLowerCase() === 'enabled';
  }

  _pluginProviders({ enabledOnly = true } = {}) {
    if (!this.pluginManager?.getPluginsByCapability) return [];
    return this.pluginManager.getPluginsByCapability('stt', { enabledOnly })
      .filter(provider => !enabledOnly || this._isEnabledProvider(provider))
      .map(provider => ({ ...provider, contract: provider.contract || this.getContract() }));
  }

  listProviders(options = {}) {
    return this._pluginProviders(options);
  }

  async _resolveSelectedPluginId(options = {}) {
    const settings = await this.getSettings(options);
    const providers = this._pluginProviders({ enabledOnly: true });
    if (settings.defaultPluginId && providers.some(provider => provider.id === settings.defaultPluginId)) {
      return settings.defaultPluginId;
    }
    if (providers.some(provider => provider.id === DEFAULT_STT_PLUGIN_ID)) {
      return DEFAULT_STT_PLUGIN_ID;
    }
    return '';
  }

  async getStatusSnapshot(options = {}) {
    const tiers = this.listProviders({ enabledOnly: false });
    return {
      tiers,
      activeProvider: await this._resolveSelectedPluginId(options) || null
    };
  }

  _buildSuccess(providerId, raw, backend = 'embedded-stt') {
    const normalized = normalizeSttTranscriptionResult(raw);
    const error = String(raw?.error || raw?.message || '').trim();
    const success = normalized.ok && Boolean(normalized.text);
    return {
      success,
      backend,
      providerId,
      result: normalized,
      text: normalized.text,
      transcript: normalized.text,
      error: success ? '' : (error || (normalized.text ? 'STT provider returned an unsuccessful result' : 'STT returned an empty transcript')),
      detectedLanguage: normalized.detectedLanguage,
      durationMs: normalized.durationMs,
      segmentCount: normalized.segmentCount
    };
  }

  async _transcribeWithPlugin(pluginId, params = {}) {
    if (!this.pluginManager?.runPluginAction) return null;
    try {
      const result = await this.pluginManager.runPluginAction(pluginId, 'transcribeAudio', {
        audioBase64: String(params.audioBase64 || params.audio_base64 || '').trim(),
        mimeType: String(params.mimeType || params.mime_type || '').trim() || 'audio/webm',
        language: String(params.language || '').trim() || null,
        prompt: String(params.prompt || '').trim() || null
      });
      return this._buildSuccess(pluginId, result, 'plugin-stt');
    } catch (error) {
      return { success: false, backend: 'plugin-stt', providerId: pluginId, error: error.message };
    }
  }

  async transcribeAudio(params = {}) {
    const audioBase64 = String(params.audioBase64 || params.audio_base64 || '').trim();
    if (!audioBase64) {
      return { success: false, error: 'Audio data is required' };
    }

    const errors = [];

    const pluginId = await this._resolveSelectedPluginId(params);
    if (pluginId) {
      const result = await this._transcribeWithPlugin(pluginId, params);
      if (result && result.success) {
        return result;
      }
      errors.push('Selected STT plugin (' + pluginId + ') failed: ' + (result?.error || 'Unknown error'));
    }

    if (pluginId !== DEFAULT_STT_PLUGIN_ID) {
      const providers = this._pluginProviders({ enabledOnly: true });
      if (providers.some(provider => provider.id === DEFAULT_STT_PLUGIN_ID)) {
        const fallback = await this._transcribeWithPlugin(DEFAULT_STT_PLUGIN_ID, params);
        if (fallback?.success) return fallback;
        errors.push('Whisper STT plugin failed: ' + (fallback?.error || 'Unknown error'));
      }
    }

    return {
      success: false,
      error: errors.length > 0
        ? 'STT failed:\n' + errors.join('\n')
        : 'STT failed: no enabled STT plugin is available'
    };
  }
}

module.exports = SttService;
