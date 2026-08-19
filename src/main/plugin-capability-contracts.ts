// @ts-nocheck
const CONTRACTS = {
  tts: {
    id: 'tts.v1',
    capability: 'tts',
    version: 1,
    actions: ['speak', 'stop', 'listVoices', 'previewVoice', 'healthCheck'],
    speakParams: ['text', 'voice', 'speed', 'agent', 'sessionId'],
    speakResult: {
      audio: {
        kind: 'url | base64 | none',
        url: 'string',
        base64: 'string',
        mimeType: 'string'
      },
      voice: 'string',
      durationMs: 'number'
    }
  },
  stt: {
    id: 'stt.v1',
    capability: 'stt',
    version: 1,
    actions: ['transcribeAudio'],
    transcribeParams: ['audioBase64', 'mimeType', 'language', 'prompt'],
    transcribeResult: {
      text: 'string',
      detectedLanguage: 'string',
      durationMs: 'number',
      segmentCount: 'number',
      provider: 'string'
    }
  }
};

function getCapabilityContract(capability) {
  return CONTRACTS[String(capability || '').trim()] || null;
}

function getManifestCapabilityContract(manifest, capability) {
  const capabilityName = String(capability || '').trim();
  const declared = manifest?.capabilityContracts?.[capabilityName]
    || manifest?.contracts?.[capabilityName]
    || {};
  const base = getCapabilityContract(capabilityName);
  if (!base) return null;
  return {
    ...base,
    ...declared,
    id: declared.id || base.id,
    capability: capabilityName,
    version: Number(declared.version || base.version)
  };
}

function normalizeTtsVoice(voice) {
  if (typeof voice === 'string') {
    return { id: voice, name: voice };
  }
  if (!voice || typeof voice !== 'object') return null;
  const id = String(voice.id || voice.name || voice.voice || '').trim();
  if (!id) return null;
  return {
    id,
    name: String(voice.name || voice.label || id),
    language: voice.language || voice.lang || '',
    gender: voice.gender || '',
    description: voice.description || ''
  };
}

function normalizeTtsVoices(raw) {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.voices)
      ? raw.voices
      : Array.isArray(raw?.data)
        ? raw.data
        : [];
  return list.map(normalizeTtsVoice).filter(Boolean);
}

function normalizeTtsSpeakResult(raw = {}) {
  const audio = raw.audio && typeof raw.audio === 'object' ? raw.audio : {};
  const url = audio.url || raw.audioUrl || raw.audio_url || raw.url || '';
  const base64 = audio.base64 || raw.audioBase64 || raw.audio_base64 || raw.base64 || '';
  const mimeType = audio.mimeType || audio.mime_type || raw.mimeType || raw.mime_type || 'audio/wav';
  const kind = url ? 'url' : base64 ? 'base64' : 'none';
  const durationMs = Number(raw.durationMs ?? raw.duration_ms ?? 0);

  return {
    ok: raw.ok !== false && kind !== 'none',
    contract: 'tts.v1',
    provider: raw.provider || raw.engine || '',
    voice: raw.voice || raw.voiceId || raw.voice_id || '',
    durationMs: Number.isFinite(durationMs) ? durationMs : 0,
    audio: {
      kind,
      url: String(url || ''),
      base64: String(base64 || ''),
      mimeType: String(mimeType || 'audio/wav')
    },
    audioUrl: String(url || ''),
    audioBase64: String(base64 || ''),
    mimeType: String(mimeType || 'audio/wav'),
    marks: Array.isArray(raw.marks) ? raw.marks : []
  };
}

function normalizeSttTranscriptionResult(raw = {}) {
  const text = String(raw.text || raw.transcript || raw.transcription || '').trim();
  const detectedLanguage = String(raw.detectedLanguage || raw.detected_language || raw.language || '').trim();
  const provider = String(raw.provider || raw.model || '').trim();
  const durationSeconds = Number(raw.durationSeconds ?? raw.duration_seconds ?? raw.duration ?? 0);
  const durationMs = Number(raw.durationMs ?? raw.duration_ms ?? (Number.isFinite(durationSeconds) ? durationSeconds * 1000 : 0));
  const segmentCount = Number(raw.segmentCount ?? raw.segment_count ?? raw.segments_found ?? 0);

  return {
    ok: raw.success !== false,
    contract: 'stt.v1',
    text,
    detectedLanguage,
    durationMs: Number.isFinite(durationMs) ? Math.round(durationMs) : 0,
    segmentCount: Number.isFinite(segmentCount) ? Math.max(0, Math.round(segmentCount)) : 0,
    provider
  };
}

module.exports = {
  CONTRACTS,
  getCapabilityContract,
  getManifestCapabilityContract,
  normalizeSttTranscriptionResult,
  normalizeTtsSpeakResult,
  normalizeTtsVoices
};
