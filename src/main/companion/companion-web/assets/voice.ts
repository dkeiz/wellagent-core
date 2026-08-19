// @ts-nocheck
(function bootstrapCompanionVoice(global) {
  function extractAudioPayload(response) {
    const root = response && typeof response === 'object' ? response : {};
    const nested = root.result && typeof root.result === 'object' ? root.result : {};
    const audioNode = nested.audio && typeof nested.audio === 'object' ? nested.audio : {};
    return {
      success: root.success !== false,
      error: root.error || nested.error || '',
      mimeType: root.mimeType || nested.mimeType || audioNode.mimeType || 'audio/wav',
      audioBase64: root.audioBase64 || nested.audioBase64 || audioNode.base64 || '',
      audioUrl: root.audioUrl || nested.audioUrl || audioNode.url || '',
      audioPath: root.audioPath || nested.audioPath || ''
    };
  }

  function base64ToBlobUrl(base64, mimeType) {
    const binary = global.atob(String(base64 || ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: mimeType || 'audio/wav' });
    return global.URL.createObjectURL(blob);
  }

  function base64ToArrayBuffer(base64) {
    const binary = global.atob(String(base64 || ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  async function prepareSpeechPlayback() {
    if (!this.speechAudioContext) {
      const AudioCtor = global.AudioContext || global.webkitAudioContext;
      this.speechAudioContext = AudioCtor ? new AudioCtor() : null;
    }
    if (this.speechAudioContext && this.speechAudioContext.state === 'suspended') {
      try {
        await this.speechAudioContext.resume();
      } catch (_) {}
    }
    return this.speechAudioContext || null;
  }

  async function playBase64Speech(base64, mimeType) {
    const audioContext = await this.prepareSpeechPlayback();
    if (audioContext) {
      const audioBuffer = await audioContext.decodeAudioData(base64ToArrayBuffer(base64).slice(0));
      const source = audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioContext.destination);
      this.speechSources = [source];
      return new Promise((resolve) => {
        source.onended = () => resolve();
        source.start(0);
      });
    }

    const blobUrl = base64ToBlobUrl(base64, mimeType);
    try {
      await this.playBackendSpeech(blobUrl);
    } finally {
      try { global.URL.revokeObjectURL(blobUrl); } catch (_) {}
    }
  }

  function playBackendSpeech(audioUrl) {
    return new Promise((resolve, reject) => {
      this.speechAudio = new Audio(audioUrl);
      this.speechAudio.onended = () => resolve();
      this.speechAudio.onerror = () => reject(new Error('Audio playback failed'));
      this.speechAudio.play().catch(reject);
    });
  }

  function stopSpeechPlayback() {
    if (Array.isArray(this.speechSources)) {
      for (const source of this.speechSources) {
        try { source.stop(0); } catch (_) {}
      }
      this.speechSources = [];
    }
    if (this.speechAudio) {
      try {
        this.speechAudio.pause();
        this.speechAudio.currentTime = 0;
      } catch (_) {}
      this.speechAudio = null;
    }
    this.speakingMessageIndex = -1;
  }

  function speakWithBrowserTts(text) {
    const synth = global.speechSynthesis;
    if (!synth) {
      throw new Error('Browser speech synthesis is unavailable');
    }
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    return new Promise((resolve, reject) => {
      utterance.onend = () => resolve();
      utterance.onerror = (event) => {
        if (event.error === 'canceled' || event.error === 'interrupted') {
          resolve();
        } else {
          reject(new Error(event.error || 'Browser speech failed'));
        }
      };
      synth.speak(utterance);
    });
  }

  async function speakMessage(index) {
    const message = this.messages[index];
    const rawText = String((message && message.content) || '');
    if (!rawText.trim()) return;

    if (this.speakingMessageIndex === index) {
      this.stopSpeechPlayback();
      this.renderMessages();
      return;
    }

    this.stopSpeechPlayback();
    if (global.speechSynthesis) global.speechSynthesis.cancel();
    this.speakingMessageIndex = index;
    this.renderMessages();

    try {
      await this.prepareSpeechPlayback();
      const response = await this.client.speakText(rawText);

      if (response?.mode === 'companion-browser-tts') {
        const speakText = String(response.speakText || '').trim();
        if (!speakText) throw new Error('No companion speech text returned');
        await speakWithBrowserTts(speakText);
        return;
      }

      const audio = extractAudioPayload(response);
      const audioUrl = (audio.audioPath ? `${this.client.baseUrl}${audio.audioPath}` : '') || audio.audioUrl;
      if (!audio.success) {
        throw new Error(audio.error || 'Backend TTS audio is unavailable');
      }
      if (audio.audioBase64) {
        await this.playBase64Speech(audio.audioBase64, audio.mimeType);
      } else if (audioUrl) {
        await this.playBackendSpeech(audioUrl);
      } else {
        throw new Error(audio.error || 'Backend TTS audio is unavailable');
      }
    } catch (error) {
      try {
        await speakWithBrowserTts(rawText);
      } catch (browserError) {
        this.showToast(browserError.message || 'Speech playback is unavailable.', 'error');
      }
    } finally {
      this.stopSpeechPlayback();
      this.renderMessages();
    }
  }

  global.LocalAgentCompanionVoice = {
    methods: {
      prepareSpeechPlayback,
      playBase64Speech,
      stopSpeechPlayback,
      playBackendSpeech,
      speakMessage
    }
  };
})(window);
