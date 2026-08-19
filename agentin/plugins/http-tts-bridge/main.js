'use strict';

const { DEFAULT_BUILTIN_MODEL, DEFAULT_CLONE_MODEL, DEFAULT_PIPER_VOICE_ID, getPluginConfig, parseJsonObject } = require('./lib/config');
const { createProcessState, getBackendStatus, requestBackendJson, startBackend, stopBackend } = require('./lib/backend-runtime');
const { copyVoiceSourceFile, importPiperAssets } = require('./lib/file-actions');
const { buildRuntimePaths } = require('./lib/runtime-paths');
const { buildVoiceCatalog, resolveVoiceChoice } = require('./lib/tts-routing');

const PLUGIN_ID = 'http-tts-bridge';
const RUNTIME = createProcessState();

async function ensureDefaults(context) {
  const defaults = {
    pythonCommand: 'python',
    backendHost: '127.0.0.1',
    backendPort: '58001',
    backendAutoStart: 'false',
    backendStartupTimeoutMs: '60000',
    builtinModel: DEFAULT_BUILTIN_MODEL,
    cloneModel: DEFAULT_CLONE_MODEL,
    qwenModelsRoot: '',
    modelPathsJson: '{}',
    piperSourceDir: '',
    piperVoiceId: DEFAULT_PIPER_VOICE_ID,
    selectedProvider: 'fast-qwen',
    selectedVoice: '',
    voiceDescription: ''
  };

  for (const [key, value] of Object.entries(defaults)) {
    if (context.getConfig(key) == null) {
      await context.setConfig(key, value);
    }
  }
}

async function ensureBackendIfNeeded(context) {
  return startBackend(RUNTIME, context);
}

function beginBackendStart(context) {
  startBackend(RUNTIME, context).catch(error => {
    RUNTIME.lastError = error.message || String(error);
    context.log(`Embedded backend start failed: ${RUNTIME.lastError}`);
  });
}

async function getModelsPayload(context) {
  await ensureBackendIfNeeded(context);
  const [models, backend] = await Promise.all([
    requestBackendJson(RUNTIME, context, '/api/models'),
    getBackendStatus(RUNTIME)
  ]);
  return {
    ...models,
    backend,
    recommended: {
      builtinModel: getPluginConfig(context).builtinModel,
      cloneModel: getPluginConfig(context).cloneModel,
      piperVoiceId: getPluginConfig(context).piperVoiceId
    }
  };
}

async function ensureSelectedModel(context, params = {}) {
  const config = getPluginConfig(context);
  const selection = resolveVoiceChoice(params, config);
  if (!selection.usePlugin) {
    throw new Error('Browser provider does not use the embedded TTS plugin backend');
  }

  const models = await getModelsPayload(context);
  const loadedModel = String(models.loaded_model || '').trim();
  if (loadedModel === selection.modelName) {
    return selection;
  }

  const body = {
    model_name: selection.modelName,
    auto_download: false
  };
  if (selection.provider === 'fast-qwen') {
    body.tts_engine = 'faster_qwen3_tts';
  }
  await requestBackendJson(RUNTIME, context, '/api/models/select', {
    method: 'POST',
    body
  });
  return selection;
}

function resolveStyle(params = {}, config = {}, selection = {}) {
  if (params?.style !== undefined) return String(params.style || '').trim() || null;
  if (selection.provider === 'fast-qwen') {
    return String(config.voiceDescription || '').trim() || null;
  }
  return null;
}

function normalizeAudioResult(result, selection) {
  const durationMs = Number(result.duration || 0) * 1000;
  return {
    ok: result.success !== false,
    voice: selection.selectedVoiceId,
    mimeType: result.mime_type || 'audio/wav',
    audioUrl: result.audio_url
      ? new URL(result.audio_url, RUNTIME.baseUrl).toString()
      : '',
    audioBase64: result.audio_base64 || '',
    durationMs: Number.isFinite(durationMs) ? Math.round(durationMs) : 0,
    provider: selection.provider
  };
}


async function speakAction(params, context) {
  const text = String(params?.text || '').trim();
  if (!text) {
    throw new Error('Text is required');
  }
  const config = getPluginConfig(context);
  const selection = await ensureSelectedModel(context, params);
  const result = await requestBackendJson(RUNTIME, context, '/api/agent/speak', {
    method: 'POST',
    body: {
      text,
      voice: selection.backendVoice,
      language: 'auto',
      style: resolveStyle(params, config, selection),
      include_base64: params?.includeBase64 !== false,
      output_format: 'wav',
      metadata: params?.metadata || null
    },
    timeoutMs: 120000
  });
  return normalizeAudioResult(result, selection);
}

async function listVoicesAction(context) {
  await ensureBackendIfNeeded(context);
  const [voicesResponse, modelsResponse, backend] = await Promise.all([
    requestBackendJson(RUNTIME, context, '/api/voices'),
    requestBackendJson(RUNTIME, context, '/api/models'),
    getBackendStatus(RUNTIME)
  ]);
  return {
    success: true,
    voices: buildVoiceCatalog(voicesResponse, modelsResponse),
    builtinVoices: voicesResponse.builtin_voices || [],
    customVoices: voicesResponse.custom_voices || [],
    modelItems: modelsResponse.items || [],
    backend
  };
}

async function healthCheckAction() {
  return getBackendStatus(RUNTIME);
}

async function startBackendAction(context) {
  await startBackend(RUNTIME, context);
  return getBackendStatus(RUNTIME);
}

async function stopBackendAction() {
  await stopBackend(RUNTIME);
  return getBackendStatus(RUNTIME);
}

async function restartBackendAction(context) {
  await stopBackend(RUNTIME);
  await startBackend(RUNTIME, context);
  return getBackendStatus(RUNTIME);
}

async function getStreamPlanAction(params, context) {
  const text = String(params?.text || '').trim();
  if (!text) {
    throw new Error('Text is required');
  }
  const config = getPluginConfig(context);
  const selection = await ensureSelectedModel(context, params);
  return {
    ok: true,
    transport: 'sse',
    provider: selection.provider,
    voice: selection.selectedVoiceId,
    url: new URL('/api/agent/speak/stream', RUNTIME.baseUrl).toString(),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: {
      text,
      voice: selection.backendVoice,
      language: 'auto',
      style: resolveStyle(params, config, selection),
      output_format: 'wav'
    }
  };
}


async function downloadModelAction(params, context) {
  const modelName = String(params?.modelName || params?.model_name || '').trim();
  if (!modelName) {
    throw new Error('modelName is required');
  }
  await ensureBackendIfNeeded(context);
  return requestBackendJson(RUNTIME, context, '/api/models/download', {
    method: 'POST',
    body: { model_name: modelName },
    timeoutMs: 15000
  });
}

async function getDownloadStatusAction(params, context) {
  const taskId = String(params?.taskId || params?.task_id || '').trim();
  if (!taskId) {
    throw new Error('taskId is required');
  }
  await ensureBackendIfNeeded(context);
  return requestBackendJson(RUNTIME, context, `/api/models/download/${encodeURIComponent(taskId)}`);
}

async function setModelFolderAction(params, context) {
  const modelName = String(params?.modelName || params?.model_name || '').trim();
  const folderPath = String(params?.folderPath || params?.folder_path || '').trim();
  if (!modelName || !folderPath) {
    throw new Error('modelName and folderPath are required');
  }

  const current = parseJsonObject(context.getConfig('modelPathsJson'));
  current[modelName] = folderPath;
  await context.setConfig('modelPathsJson', JSON.stringify(current));
  await stopBackend(RUNTIME);
  return getModelsPayload(context);
}

async function importPiperAssetsAction(params, context) {
  const config = getPluginConfig(context);
  const sourceDir = String(params?.sourceDir || params?.source_dir || config.piperSourceDir || '').trim();
  const voiceId = String(params?.voiceId || params?.voice_id || config.piperVoiceId || DEFAULT_PIPER_VOICE_ID).trim();
  const paths = buildRuntimePaths(context.pluginId, context.pluginDir);

  if (sourceDir && sourceDir !== config.piperSourceDir) {
    await context.setConfig('piperSourceDir', sourceDir);
  }

  const copied = importPiperAssets({
    sourceDir,
    targetPiperDir: paths.piperDir,
    voiceId
  });
  let models = null;
  try {
    models = await getModelsPayload(context);
  } catch (error) {
    copied.modelRefreshWarning = error.message || String(error);
  }
  return {
    ...copied,
    models
  };
}

async function copyVoiceSourceAction(params, context) {
  const sourceFilePath = String(params?.sourceFilePath || params?.source_file_path || '').trim();
  const paths = buildRuntimePaths(context.pluginId, context.pluginDir);
  return copyVoiceSourceFile({
    sourceFilePath,
    targetVoicesDir: paths.voicesDir
  });
}

async function listVoiceSourceFilesAction(context) {
  await ensureBackendIfNeeded(context);
  return requestBackendJson(RUNTIME, context, '/api/voices/source-files');
}

async function prepareVoiceAction(params, context) {
  const speakerName = String(params?.speakerName || params?.speaker_name || '').trim();
  const sourceFile = String(params?.sourceFile || params?.source_file || '').trim();
  if (!speakerName || !sourceFile) {
    throw new Error('speakerName and sourceFile are required');
  }
  await ensureBackendIfNeeded(context);
  return requestBackendJson(RUNTIME, context, '/api/voices/prepare', {
    method: 'POST',
    body: {
      speaker_name: speakerName,
      source_file: sourceFile,
      description: String(params?.description || '').trim() || null
    },
    timeoutMs: 15000
  });
}

async function getVoicePrepareStatusAction(params, context) {
  const taskId = String(params?.taskId || params?.task_id || '').trim();
  if (!taskId) {
    throw new Error('taskId is required');
  }
  await ensureBackendIfNeeded(context);
  return requestBackendJson(RUNTIME, context, `/api/voices/prepare/${encodeURIComponent(taskId)}`);
}

async function getPerformanceAction(context) {
  await ensureBackendIfNeeded(context);
  const [snapshot, backend] = await Promise.all([
    requestBackendJson(RUNTIME, context, '/api/performance'),
    getBackendStatus(RUNTIME)
  ]);
  return {
    ...snapshot,
    backend
  };
}

module.exports = {
  async onEnable(context) {
    await ensureDefaults(context);
    const config = getPluginConfig(context);
    if (config.backendAutoStart) {
      beginBackendStart(context);
    }
    context.log('TTS plugin ready');
  },

  async onDisable() {
    await stopBackend(RUNTIME);
  },

  async runAction(action, params, context) {
    if (action === 'speak') return speakAction(params || {}, context);
    if (action === 'previewVoice') return speakAction(params || {}, context);
    if (action === 'stop') return { ok: true, localOnly: true };
    if (action === 'listVoices') return listVoicesAction(context);
    if (action === 'healthCheck') return healthCheckAction();
    if (action === 'getBackendStatus') return healthCheckAction();
    if (action === 'startBackend') return startBackendAction(context);
    if (action === 'stopBackend') return stopBackendAction();
    if (action === 'restartBackend') return restartBackendAction(context);
    if (action === 'getModels') return getModelsPayload(context);
    if (action === 'downloadModel') return downloadModelAction(params || {}, context);
    if (action === 'getDownloadStatus') return getDownloadStatusAction(params || {}, context);
    if (action === 'setModelFolder') return setModelFolderAction(params || {}, context);
    if (action === 'importPiperAssets') return importPiperAssetsAction(params || {}, context);
    if (action === 'copyVoiceSource') return copyVoiceSourceAction(params || {}, context);
    if (action === 'listVoiceSourceFiles') return listVoiceSourceFilesAction(context);
    if (action === 'prepareVoice') return prepareVoiceAction(params || {}, context);
    if (action === 'getVoicePrepareStatus') return getVoicePrepareStatusAction(params || {}, context);
    if (action === 'getStreamPlan') return getStreamPlanAction(params || {}, context);
    if (action === 'getPerformance') return getPerformanceAction(context);
    throw new Error(`Unknown plugin action: ${action}`);
  },

  _test: {
    PLUGIN_ID,
    RUNTIME,
    buildVoiceCatalog,
    resolveVoiceChoice
  }
};
