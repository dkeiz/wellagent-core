'use strict';

const path = require('path');

const DEFAULT_BUILTIN_MODEL = 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice';
const DEFAULT_CLONE_MODEL = 'Qwen/Qwen3-TTS-12Hz-1.7B-Base';
const DEFAULT_PIPER_VOICE_ID = 'en_US-lessac-medium';
const KNOWN_QWEN_MODELS = [
  'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice',
  'Qwen/Qwen3-TTS-12Hz-1.7B-Base',
  'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice',
  'Qwen/Qwen3-TTS-12Hz-0.6B-Base'
];

function parseBool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value == null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function parseJsonObject(raw, fallback = {}) {
  try {
    const parsed = JSON.parse(String(raw || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

function splitCommand(raw) {
  const text = String(raw || '').trim();
  if (!text) return ['python'];
  const parts = [];
  const regex = /[^\s"]+|"([^"]*)"/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    parts.push(match[1] != null ? match[1] : match[0]);
  }
  return parts.length ? parts : ['python'];
}

function normalizeModelOverrides(rawOverrides, qwenModelsRoot) {
  const result = {};
  const parsed = rawOverrides && typeof rawOverrides === 'object' ? rawOverrides : {};
  for (const [key, value] of Object.entries(parsed)) {
    const modelId = String(key || '').trim();
    const modelPath = String(value || '').trim();
    if (modelId && modelPath) {
      result[modelId] = modelPath;
    }
  }

  const root = String(qwenModelsRoot || '').trim();
  if (root) {
    for (const modelId of KNOWN_QWEN_MODELS) {
      if (result[modelId]) continue;
      result[modelId] = path.join(root, modelId.split('/').pop());
    }
  }
  return result;
}

function getPluginConfig(context) {
  const qwenModelsRoot = String(context.getConfig('qwenModelsRoot') || '').trim();
  const modelPathsJson = parseJsonObject(context.getConfig('modelPathsJson'));
  return {
    pythonCommand: String(context.getConfig('pythonCommand') || 'python').trim() || 'python',
    backendHost: String(context.getConfig('backendHost') || '127.0.0.1').trim() || '127.0.0.1',
    backendPort: parseNumber(context.getConfig('backendPort'), 58001),
    backendAutoStart: parseBool(context.getConfig('backendAutoStart'), true),
    backendStartupTimeoutMs: Math.max(parseNumber(context.getConfig('backendStartupTimeoutMs'), 60000), 60000),
    builtinModel: String(context.getConfig('builtinModel') || DEFAULT_BUILTIN_MODEL).trim() || DEFAULT_BUILTIN_MODEL,
    cloneModel: String(context.getConfig('cloneModel') || DEFAULT_CLONE_MODEL).trim() || DEFAULT_CLONE_MODEL,
    qwenModelsRoot,
    modelPathOverrides: normalizeModelOverrides(modelPathsJson, qwenModelsRoot),
    piperSourceDir: String(context.getConfig('piperSourceDir') || '').trim(),
    piperVoiceId: String(context.getConfig('piperVoiceId') || DEFAULT_PIPER_VOICE_ID).trim() || DEFAULT_PIPER_VOICE_ID,
    selectedProvider: String(context.getConfig('selectedProvider') || 'fast-qwen').trim() || 'fast-qwen',
    selectedVoice: String(context.getConfig('selectedVoice') || '').trim(),
    voiceDescription: String(context.getConfig('voiceDescription') || '').trim()
  };
}

module.exports = {
  DEFAULT_BUILTIN_MODEL,
  DEFAULT_CLONE_MODEL,
  DEFAULT_PIPER_VOICE_ID,
  KNOWN_QWEN_MODELS,
  getPluginConfig,
  parseBool,
  parseJsonObject,
  splitCommand
};
