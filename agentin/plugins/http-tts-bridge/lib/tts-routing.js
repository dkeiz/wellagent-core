'use strict';

function normalizeProvider(provider, voiceId) {
  const explicit = String(provider || '').trim().toLowerCase();
  if (explicit === 'browser' || explicit === 'fast-qwen' || explicit === 'piper') {
    return explicit;
  }

  const voice = String(voiceId || '').trim().toLowerCase();
  if (voice.startsWith('piper:')) return 'piper';
  if (voice.startsWith('qwen-builtin:') || voice.startsWith('qwen-clone:')) return 'fast-qwen';
  return 'fast-qwen';
}

function resolveVoiceChoice(params = {}, config = {}) {
  const rawVoice = String(params.voice || config.selectedVoice || '').trim();
  const provider = normalizeProvider(params.provider || config.selectedProvider, rawVoice);

  if (provider === 'browser') {
    return {
      provider,
      selectedVoiceId: 'browser',
      backendVoice: '',
      modelName: '',
      usePlugin: false
    };
  }

  if (provider === 'piper') {
    const voiceName = rawVoice.startsWith('piper:')
      ? rawVoice.slice('piper:'.length)
      : (rawVoice || config.piperVoiceId || 'en_US-lessac-medium');
    return {
      provider: 'piper',
      selectedVoiceId: `piper:${voiceName}`,
      backendVoice: voiceName,
      modelName: `piper:${voiceName}`,
      usePlugin: true,
      voiceKind: 'piper'
    };
  }

  if (rawVoice.startsWith('qwen-clone:')) {
    const voiceName = rawVoice.slice('qwen-clone:'.length) || 'clone_voice';
    return {
      provider: 'fast-qwen',
      selectedVoiceId: `qwen-clone:${voiceName}`,
      backendVoice: voiceName,
      modelName: config.cloneModel,
      usePlugin: true,
      voiceKind: 'clone'
    };
  }

  const builtinVoice = rawVoice.startsWith('qwen-builtin:')
    ? rawVoice.slice('qwen-builtin:'.length)
    : (rawVoice || 'serena');
  return {
    provider: 'fast-qwen',
    selectedVoiceId: `qwen-builtin:${builtinVoice}`,
    backendVoice: builtinVoice,
    modelName: config.builtinModel,
    usePlugin: true,
    voiceKind: 'builtin'
  };
}

function buildVoiceCatalog(voiceResponse = {}, modelsResponse = {}) {
  const builtinVoices = Array.isArray(voiceResponse.builtin_voices) ? voiceResponse.builtin_voices : [];
  const customVoices = Array.isArray(voiceResponse.custom_voices) ? voiceResponse.custom_voices : [];
  const modelItems = Array.isArray(modelsResponse.items) ? modelsResponse.items : [];

  const voices = [];
  for (const voice of builtinVoices) {
    voices.push({
      id: `qwen-builtin:${voice.name}`,
      name: voice.name,
      provider: 'fast-qwen',
      kind: 'builtin',
      description: voice.description || 'Fast Qwen built-in voice'
    });
  }
  for (const voice of customVoices) {
    voices.push({
      id: `qwen-clone:${voice.name}`,
      name: voice.name,
      provider: 'fast-qwen',
      kind: 'clone',
      description: voice.description || 'Prepared custom Qwen clone voice'
    });
  }
  return voices;
}

module.exports = {
  buildVoiceCatalog,
  normalizeProvider,
  resolveVoiceChoice
};
