// @ts-nocheck
function normalizeProvider(provider) {
  return String(provider || '').trim().toLowerCase();
}

function normalizeModel(model) {
  return String(model || '').trim();
}

function parseJsonObject(rawValue) {
  if (!rawValue) return {};
  try {
    const parsed = JSON.parse(rawValue);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    return {};
  }
}

function appendUnique(target, value, seen) {
  const normalized = normalizeModel(value);
  if (!normalized) return;
  const key = normalized.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  target.push(normalized);
}

function isOllamaCloudModel(model) {
  const normalized = normalizeModel(model).toLowerCase();
  return normalized.includes('-cloud') || normalized.includes(':cloud');
}

function normalizeScopeOptions(options = {}) {
  const userId = String(options?.userId || '').trim();
  return {
    requestContext: options?.requestContext || null,
    userId: userId || undefined
  };
}

async function readSetting(db, key, options = {}) {
  const scopeOptions = normalizeScopeOptions(options);
  if (db?.getScopedSetting && (scopeOptions.requestContext || scopeOptions.userId)) {
    return db.getScopedSetting(key, scopeOptions);
  }
  return db.getSetting(key);
}

async function writeSetting(db, key, value, options = {}) {
  const scopeOptions = normalizeScopeOptions(options);
  if (db?.saveScopedSetting && (scopeOptions.requestContext || scopeOptions.userId)) {
    return db.saveScopedSetting(key, value, scopeOptions);
  }
  return db.saveSetting(key, value);
}

async function getTestedModelMap(db, options = {}) {
  const rawValue = await readSetting(db, 'llm.testedModels', options);
  const parsed = parseJsonObject(rawValue);
  const output = {};

  for (const [provider, models] of Object.entries(parsed)) {
    if (!Array.isArray(models)) continue;
    output[normalizeProvider(provider)] = models
      .map(model => normalizeModel(model))
      .filter(Boolean);
  }

  return output;
}

async function saveTestedModelMap(db, testedModels, options = {}) {
  await writeSetting(db, 'llm.testedModels', JSON.stringify(testedModels), options);
}

async function rememberTestedModel(db, provider, model, options = {}) {
  const normalizedProvider = normalizeProvider(provider);
  const normalizedModel = normalizeModel(model);
  if (!normalizedProvider || !normalizedModel) return [];

  const testedModels = await getTestedModelMap(db, options);
  const providerModels = Array.isArray(testedModels[normalizedProvider]) ? testedModels[normalizedProvider] : [];
  const nextModels = [];
  const seen = new Set();

  appendUnique(nextModels, normalizedModel, seen);
  providerModels.forEach(entry => appendUnique(nextModels, entry, seen));

  testedModels[normalizedProvider] = nextModels;
  await saveTestedModelMap(db, testedModels, options);
  return nextModels;
}

async function rememberLastWorkingModel(db, provider, model, options = {}) {
  const normalizedProvider = normalizeProvider(provider);
  const normalizedModel = normalizeModel(model);
  if (!normalizedProvider || !normalizedModel) return null;

  await writeSetting(db, 'llm.lastWorkingProvider', normalizedProvider, options);
  await writeSetting(db, 'llm.lastWorkingModel', normalizedModel, options);
  await rememberTestedModel(db, normalizedProvider, normalizedModel, options);
  return { provider: normalizedProvider, model: normalizedModel };
}

async function getLastWorkingSelection(db, options = {}) {
  const provider = normalizeProvider(await readSetting(db, 'llm.lastWorkingProvider', options));
  const model = normalizeModel(await readSetting(db, 'llm.lastWorkingModel', options));
  if (!provider && !model) {
    return null;
  }

  return {
    provider: provider || null,
    model: model || null
  };
}

async function getEffectiveLlmSelection(db, options = {}) {
  await migrateLegacyCodexSelection(db, options);
  const lastWorking = await getLastWorkingSelection(db, options);
  const configuredProvider = normalizeProvider(
    await readSetting(db, 'llm.provider', options) || await readSetting(db, 'ai_provider', options)
  );
  const configuredModel = normalizeModel(await readSetting(db, 'llm.model', options));

  if (configuredProvider || configuredModel) {
    const provider = configuredProvider || lastWorking?.provider || 'ollama';
    const model = configuredProvider
      ? (configuredModel || null)
      : ((lastWorking?.provider || '') === provider ? (lastWorking?.model || null) : null);
    return {
      provider,
      model,
      source: 'configured'
    };
  }

  if (lastWorking && (lastWorking.provider || lastWorking.model)) {
    return {
      provider: lastWorking.provider || 'ollama',
      model: lastWorking.model || null,
      source: 'last-working'
    };
  }

  return {
    provider: 'ollama',
    model: null,
    source: 'default'
  };
}

async function migrateLegacyCodexSelection(db, options = {}) {
  const configuredProvider = normalizeProvider(await readSetting(db, 'llm.provider', options));
  const lastWorkingProvider = normalizeProvider(await readSetting(db, 'llm.lastWorkingProvider', options));
  const transport = String(await readSetting(db, 'llm.openai.transport', options) || '').trim().toLowerCase();
  if (transport !== 'codex-cli') {
    return false;
  }

  let migrated = false;
  if (configuredProvider === 'openai') {
    await writeSetting(db, 'llm.provider', 'local-codex', options);
    migrated = true;
  }
  if (lastWorkingProvider === 'openai') {
    await writeSetting(db, 'llm.lastWorkingProvider', 'local-codex', options);
    migrated = true;
  }
  return migrated;
}

async function saveActiveSelection(db, provider, model, options = {}) {
  const normalizedProvider = normalizeProvider(provider);
  const normalizedModel = normalizeModel(model);
  if (!normalizedProvider) return null;

  await writeSetting(db, 'llm.provider', normalizedProvider, options);
  if (normalizedModel) {
    await writeSetting(db, 'llm.model', normalizedModel, options);
    await rememberTestedModel(db, normalizedProvider, normalizedModel, options);
    if (normalizedProvider === 'ollama') {
      const isCloudModel = isOllamaCloudModel(normalizedModel);
      await writeSetting(db, 'llm.modelType', isCloudModel ? 'cloud' : 'local', options);
    }
    await writeSetting(db, 'llm.lastWorkingModel', normalizedModel, options);
  } else {
    await writeSetting(db, 'llm.model', '', options);
    await writeSetting(db, 'llm.lastWorkingModel', '', options);
  }
  await writeSetting(db, 'llm.lastWorkingProvider', normalizedProvider, options);

  return {
    provider: normalizedProvider,
    model: normalizedModel || null
  };
}

async function getKnownModelsForProvider(db, provider, discoveredModels = [], options = {}) {
  const normalizedProvider = normalizeProvider(provider);
  const knownModels = [];
  const seen = new Set();
  const testedModels = await getTestedModelMap(db, options);
  const effective = await getEffectiveLlmSelection(db, options);
  const configuredProvider = normalizeProvider(await readSetting(db, 'llm.provider', options));
  const configuredModel = normalizeModel(await readSetting(db, 'llm.model', options));

  (testedModels[normalizedProvider] || []).forEach(model => appendUnique(knownModels, model, seen));

  if (effective.provider === normalizedProvider) {
    appendUnique(knownModels, effective.model, seen);
  }

  if (configuredProvider === normalizedProvider) {
    appendUnique(knownModels, configuredModel, seen);
  }
  discoveredModels.forEach(model => appendUnique(knownModels, model, seen));

  return knownModels;
}

async function orderModelsByRecentUse(db, provider, models = [], options = {}) {
  const normalizedProvider = normalizeProvider(provider);
  const available = [];
  const availableSeen = new Set();
  models.forEach(model => appendUnique(available, model, availableSeen));
  const availableByKey = new Map(available.map(model => [model.toLowerCase(), model]));
  const ordered = [];
  const orderedSeen = new Set();
  const lastWorking = await getLastWorkingSelection(db, options);
  if (lastWorking?.provider === normalizedProvider) {
    appendUnique(ordered, availableByKey.get(normalizeModel(lastWorking.model).toLowerCase()), orderedSeen);
  }
  const testedModels = await getTestedModelMap(db, options);
  (testedModels[normalizedProvider] || []).forEach(model => {
    appendUnique(ordered, availableByKey.get(model.toLowerCase()), orderedSeen);
  });
  available.forEach(model => appendUnique(ordered, model, orderedSeen));
  return ordered;
}

module.exports = {
  getEffectiveLlmSelection,
  getKnownModelsForProvider,
  getLastWorkingSelection,
  getTestedModelMap,
  migrateLegacyCodexSelection,
  orderModelsByRecentUse,
  rememberLastWorkingModel,
  rememberTestedModel,
  saveActiveSelection
};
