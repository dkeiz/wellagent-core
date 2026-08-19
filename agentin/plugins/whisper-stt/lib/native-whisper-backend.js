// @ts-nocheck
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const DEFAULT_MODEL_ID = 'Xenova/whisper-base';
const DEFAULT_TIMEOUT_MS = 45000;

function resolveRootPath(...parts) {
  return path.resolve(__dirname, '..', '..', '..', '..', ...parts);
}

function findChunk(buffer, chunkId) {
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    if (id === chunkId) {
      return { offset: dataOffset, size };
    }
    offset = dataOffset + size + (size % 2);
  }
  return null;
}

function decodeWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) {
    throw new Error('WAV audio is empty or too small');
  }
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Only WAV audio is supported by native STT');
  }

  const fmt = findChunk(buffer, 'fmt ');
  const data = findChunk(buffer, 'data');
  if (!fmt || !data) throw new Error('Invalid WAV: missing fmt or data chunk');

  const audioFormat = buffer.readUInt16LE(fmt.offset);
  const channels = buffer.readUInt16LE(fmt.offset + 2);
  const sampleRate = buffer.readUInt32LE(fmt.offset + 4);
  const bitsPerSample = buffer.readUInt16LE(fmt.offset + 14);
  if (!channels || !sampleRate) throw new Error('Invalid WAV format');
  if (![1, 3].includes(audioFormat)) {
    throw new Error(`Unsupported WAV encoding: ${audioFormat}`);
  }
  if (audioFormat === 1 && ![16, 24, 32].includes(bitsPerSample)) {
    throw new Error(`Unsupported PCM bit depth: ${bitsPerSample}`);
  }
  if (audioFormat === 3 && bitsPerSample !== 32) {
    throw new Error('Only 32-bit float WAV is supported for IEEE float audio');
  }

  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.floor(data.size / (bytesPerSample * channels));
  const samples = new Float32Array(frameCount);

  for (let frame = 0; frame < frameCount; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      const sampleOffset = data.offset + ((frame * channels + channel) * bytesPerSample);
      let value = 0;
      if (audioFormat === 3) {
        value = buffer.readFloatLE(sampleOffset);
      } else if (bitsPerSample === 16) {
        value = buffer.readInt16LE(sampleOffset) / 32768;
      } else if (bitsPerSample === 24) {
        value = buffer.readIntLE(sampleOffset, 3) / 8388608;
      } else {
        value = buffer.readInt32LE(sampleOffset) / 2147483648;
      }
      sum += Math.max(-1, Math.min(1, value));
    }
    samples[frame] = sum / channels;
  }

  return {
    audio: samples,
    sampleRate,
    durationMs: Math.round((frameCount / sampleRate) * 1000)
  };
}

function isWavBuffer(buffer) {
  return Buffer.isBuffer(buffer)
    && buffer.length >= 12
    && buffer.toString('ascii', 0, 4) === 'RIFF'
    && buffer.toString('ascii', 8, 12) === 'WAVE';
}

function detectAudioMimeType(buffer, declaredMimeType = '') {
  const declared = String(declaredMimeType || '').split(';', 1)[0].trim().toLowerCase();
  if (isWavBuffer(buffer)) return 'audio/wav';
  if (Buffer.isBuffer(buffer) && buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp') return 'audio/mp4';
  if (Buffer.isBuffer(buffer) && buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return 'audio/webm';
  if (Buffer.isBuffer(buffer) && buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
  if (Buffer.isBuffer(buffer) && buffer.length >= 3 && buffer.toString('ascii', 0, 3) === 'ID3') return 'audio/mpeg';
  if (Buffer.isBuffer(buffer) && buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  return declared || 'application/octet-stream';
}

function suffixForMime(mimeType) {
  if (['audio/wav', 'audio/wave', 'audio/x-wav'].includes(mimeType)) return '.wav';
  if (mimeType === 'audio/mp4') return '.m4a';
  if (mimeType === 'audio/mpeg' || mimeType === 'audio/mp3') return '.mp3';
  if (mimeType === 'audio/ogg') return '.ogg';
  if (mimeType === 'audio/webm') return '.webm';
  if (mimeType === 'audio/aac') return '.aac';
  return '.bin';
}

function convertToWav(buffer, mimeType, timeoutMs) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'localagent-stt-audio-'));
    const inputPath = path.join(dir, `input${suffixForMime(mimeType)}`);
    const outputPath = path.join(dir, 'output.wav');
    const cleanup = () => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    };

    try {
      fs.writeFileSync(inputPath, buffer);
    } catch (error) {
      cleanup();
      reject(error);
      return;
    }

    execFile('ffmpeg', [
      '-loglevel',
      'error',
      '-y',
      '-i',
      inputPath,
      '-ac',
      '1',
      '-ar',
      '16000',
      '-f',
      'wav',
      outputPath
    ], {
      timeout: Math.max(1000, Math.min(30000, timeoutMs)),
      windowsHide: true,
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      try {
        if (error) {
          reject(new Error(`Audio conversion failed: ${stderr || stdout || error.message}`));
          return;
        }
        resolve(fs.readFileSync(outputPath));
      } catch (readError) {
        reject(readError);
      } finally {
        cleanup();
      }
    });
  });
}

function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

class NativeWhisperSttBackend {
  constructor({ cacheDir = '', modelId = DEFAULT_MODEL_ID } = {}) {
    this.cacheDir = cacheDir || resolveRootPath('data', 'whisper-cache');
    this.modelId = modelId || DEFAULT_MODEL_ID;
    this.pipelinePromise = null;
  }

  getAvailability() {
    const modelDir = path.join(this.cacheDir, ...this.modelId.split('/'));
    const encoder = path.join(modelDir, 'onnx', 'encoder_model.onnx');
    const decoder = path.join(modelDir, 'onnx', 'decoder_model_merged.onnx');
    const ready = fs.existsSync(encoder) && fs.existsSync(decoder);
    return {
      ok: ready,
      ready,
      backend: 'native-whisper',
      modelId: this.modelId,
      cacheDir: this.cacheDir,
      error: ready ? '' : `Missing local Whisper ONNX cache at ${modelDir}`
    };
  }

  async _loadPipeline() {
    if (this.pipelinePromise) return this.pipelinePromise;
    this.pipelinePromise = (async () => {
      const status = this.getAvailability();
      if (!status.ready) throw new Error(status.error);
      process.env.ORT_LOG_SEVERITY_LEVEL = process.env.ORT_LOG_SEVERITY_LEVEL || '3';
      const transformers = await import('@xenova/transformers');
      transformers.env.cacheDir = this.cacheDir;
      transformers.env.allowLocalModels = true;
      transformers.env.allowRemoteModels = false;
      return transformers.pipeline('automatic-speech-recognition', this.modelId, {
        quantized: false
      });
    })();
    return this.pipelinePromise;
  }

  async transcribeAudio(params = {}) {
    const startedAt = Date.now();
    const declaredMimeType = String(params.mimeType || params.mime_type || 'audio/wav').split(';', 1)[0].trim().toLowerCase();
    const audioBase64 = String(params.audioBase64 || params.audio_base64 || '').trim();
    if (!audioBase64) throw new Error('audioBase64 is required');
    const timeoutMs = Math.max(1000, Math.min(120000, Number(params.timeoutMs || params.timeout_ms || DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS));
    const rawAudio = Buffer.from(audioBase64, 'base64');
    const mimeType = detectAudioMimeType(rawAudio, declaredMimeType);
    const converted = !['audio/wav', 'audio/wave', 'audio/x-wav'].includes(mimeType);
    const wavAudio = converted
      ? await withTimeout(convertToWav(rawAudio, mimeType, timeoutMs), timeoutMs, 'Native STT audio conversion')
      : rawAudio;
    const decoded = decodeWav(wavAudio);
    const transcriber = await withTimeout(this._loadPipeline(), timeoutMs, 'Native STT model load');
    const result = await withTimeout(transcriber(decoded.audio, {
      sampling_rate: decoded.sampleRate,
      language: String(params.language || 'english').trim() || 'english',
      task: 'transcribe'
    }), timeoutMs, 'Native STT transcription');

    return {
      success: true,
      text: String(result?.text || '').trim(),
      detected_language: String(params.language || '').trim(),
      duration_ms: decoded.durationMs,
      elapsed_ms: Date.now() - startedAt,
      segment_count: 1,
      provider: 'native-whisper',
      model: this.modelId,
      input_mime_type: mimeType,
      converted
    };
  }
}

module.exports = {
  NativeWhisperSttBackend,
  decodeWav,
  detectAudioMimeType
};
