// @ts-nocheck
const { getModelRuntimeConfig, saveModelRuntimeConfig } = require('./llm-config');
const { getEffectiveLlmSelection } = require('./llm-state');

function normalizeContextWindow(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 2048 || parsed > 262144) {
    throw new Error('Context window must be between 2048 and 262144');
  }
  return parsed;
}

async function readSetting(db, key, options = {}) {
  if (db?.getScopedSetting && (options?.requestContext || options?.userId)) {
    return db.getScopedSetting(key, options);
  }
  return db.getSetting(key);
}

async function deleteSetting(db, key, options = {}) {
  if (db?.deleteScopedSetting && (options?.requestContext || options?.userId)) {
    return db.deleteScopedSetting(key, options);
  }
  if (db?.deleteSetting) return db.deleteSetting(key);
  return db.saveSetting(key, '');
}

async function getActiveModelContext(db, options = {}) {
  const selection = await getEffectiveLlmSelection(db, options);
  if (!selection.provider || !selection.model) return null;
  let profile = await getModelRuntimeConfig(db, selection.provider, selection.model, options);
  const configurable = profile.spec?.capabilities?.contextWindow?.configurable === true;
  if (configurable) {
    const legacyRaw = await readSetting(db, 'context_window', options);
    const legacyValue = Number.parseInt(legacyRaw, 10);
    const configuredValue = Number(profile.runtime?.contextWindow?.value || 0);
    const defaultValue = Number(profile.spec?.runtime?.contextWindow?.value || 0);
    const generatedDefault = configuredValue > 0 && configuredValue === defaultValue;
    if ((profile.runtime?.__contextWindowConfigured !== true || generatedDefault)
      && Number.isFinite(legacyValue) && legacyValue > 0) {
      profile = await saveModelRuntimeConfig(db, selection.provider, selection.model, {
        contextWindow: { value: legacyValue }
      }, options);
    }
    if (legacyRaw !== null && legacyRaw !== undefined) {
      await deleteSetting(db, 'context_window', options);
    }
  }
  return {
    provider: selection.provider,
    model: selection.model,
    configurable,
    contextWindow: configurable ? (Number(profile.runtime?.contextWindow?.value || 0) || null) : null,
    spec: profile.spec,
    runtimeConfig: profile.runtime
  };
}

async function saveActiveModelContext(db, value, options = {}) {
  const requested = normalizeContextWindow(value);
  const active = await getActiveModelContext(db, options);
  if (!active) throw new Error('Select a provider and model before setting context size');
  if (!active.configurable) {
    throw new Error(`Context size is controlled by ${active.provider} for ${active.model}`);
  }

  const saved = await saveModelRuntimeConfig(db, active.provider, active.model, {
    contextWindow: { value: requested }
  }, options);
  return {
    success: true,
    provider: active.provider,
    model: active.model,
    contextWindow: saved.runtime.contextWindow.value,
    runtimeConfig: saved.runtime
  };
}

module.exports = {
  getActiveModelContext,
  normalizeContextWindow,
  saveActiveModelContext
};
