// @ts-nocheck
const { nativeFetch: fetchImpl } = require('./net/native-fetch');

const DEFAULT_AUDIO_FETCH_TIMEOUT_MS = 120_000;

function traceTtsHttp(event, details = {}) {
  if (process.env.LOCALAGENT_TTS_TRACE !== '1') return;
  try {
    console.log(`[TtsHttpEntrypoint] ${JSON.stringify({ event, ...details })}`);
  } catch (_) {
    console.log(`[TtsHttpEntrypoint] ${event}`);
  }
}

function createTtsHttpEntrypoint(options = {}) {
  const getTtsService = typeof options.getTtsService === 'function'
    ? options.getTtsService
    : (() => options.ttsService || null);
  const audioFetchTimeoutMs = Math.max(1_000, Number(options.audioFetchTimeoutMs) || DEFAULT_AUDIO_FETCH_TIMEOUT_MS);

  async function captureAudioBase64(audioUrl) {
    const url = String(audioUrl || '').trim();
    if (!url) return '';
    const dataMatch = /^data:([^;,]+)?(;base64)?,(.*)$/i.exec(url);
    if (dataMatch) {
      const isBase64 = Boolean(dataMatch[2]);
      const payload = decodeURIComponent(dataMatch[3] || '');
      return isBase64 ? payload : Buffer.from(payload, 'utf8').toString('base64');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), audioFetchTimeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'audio/*,*/*' },
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`Audio capture failed with HTTP ${response.status}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer).toString('base64');
    } finally {
      clearTimeout(timeout);
    }
  }

  async function generateAudio(params = {}) {
    const ttsService = getTtsService();
    if (!ttsService?.speakAudio) {
      return {
        success: false,
        status: 503,
        error: 'TTS audio backend is unavailable'
      };
    }

    const result = await ttsService.speakAudio(params || {});
    traceTtsHttp('generateAudio', {
      success: result?.success === true,
      backend: result?.backend || '',
      pluginId: result?.pluginId || '',
      error: result?.error || '',
      textLength: String(params?.rawText ?? params?.text ?? '').length
    });
    if (!result?.success) {
      return {
        success: false,
        status: result?.fallback === 'browser-tts' ? 200 : 503,
        backend: result?.backend || '',
        pluginId: result?.pluginId || '',
        fallback: result?.fallback || '',
        speakText: result?.speakText || '',
        error: result?.error || 'TTS audio generation failed'
      };
    }

    const audio = result.result || {};
    let audioBase64 = audio.audioBase64 || audio.audio?.base64 || '';
    if (!audioBase64 && audio.audioUrl) {
      try {
        audioBase64 = await captureAudioBase64(audio.audioUrl);
      } catch (error) {
        traceTtsHttp('captureAudio.error', {
          backend: result.backend || '',
          pluginId: result.pluginId || '',
          error: error.message || String(error)
        });
        return {
          success: false,
          status: 502,
          backend: result.backend || '',
          pluginId: result.pluginId || '',
          error: error.message || 'Generated audio could not be captured'
        };
      }
    }
    if (!audioBase64) {
      return {
        success: false,
        status: 502,
        backend: result.backend || '',
        pluginId: result.pluginId || '',
        error: 'TTS audio generation returned no audio bytes'
      };
    }

    return {
      success: true,
      status: 200,
      backend: result.backend || '',
      pluginId: result.pluginId || '',
      provider: audio.provider || '',
      voice: audio.voice || '',
      durationMs: audio.durationMs || 0,
      mimeType: audio.mimeType || audio.audio?.mimeType || 'audio/wav',
      audioBase64
    };
  }

  return {
    generateAudio
  };
}

module.exports = {
  createTtsHttpEntrypoint
};
