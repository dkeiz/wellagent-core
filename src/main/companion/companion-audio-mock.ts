// @ts-nocheck
function createMockWavBase64() {
  const sampleRate = 16000;
  const seconds = 1;
  const samples = sampleRate * seconds;
  const bytesPerSample = 2;
  const dataBytes = samples * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataBytes);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * bytesPerSample, 28);
  buffer.writeUInt16LE(bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < samples; i += 1) {
    const envelope = Math.sin(Math.PI * i / samples);
    const sample = Math.sin(2 * Math.PI * 660 * i / sampleRate) * envelope;
    buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 0x7fff), 44 + i * bytesPerSample);
  }

  return buffer.toString('base64');
}

function createCompanionAudioMock(options = {}) {
  const audioBase64 = createMockWavBase64();
  const failTts = options.failTts === true || process.env.LOCALAGENT_COMPANION_AUDIO_MOCK_TTS_FAIL === '1';

  return {
    ttsHttpEntrypoint: {
      async generateAudio() {
        if (failTts) {
          return { success: false, status: 503, error: 'Mock TTS failure requested' };
        }
        return {
          success: true,
          status: 200,
          mimeType: 'audio/wav',
          audioBase64,
          durationMs: 1000,
          backend: 'mock-companion-audio'
        };
      }
    }
  };
}

module.exports = {
  createCompanionAudioMock
};
