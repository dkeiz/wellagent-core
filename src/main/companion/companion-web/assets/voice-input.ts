// @ts-nocheck
(function bootstrapCompanionVoiceInput(global) {
  function openSecureSetup() {
    const target = `/companion/bootstrap${global.location.search || ''}`;
    global.location.href = target;
  }

  async function toggleVoiceInput() {
    if (this.transcribingVoice) return;
    if (this.getPermissions().mediaUpload === false) {
      this.showToast('This companion device cannot send voice input.', 'error');
      return;
    }
    if (hasNativeVoiceBridge()) {
      await this.toggleNativeVoiceInput();
      return;
    }
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      this.mediaRecorder.stop();
      return;
    }

    if (!global.navigator.mediaDevices || !global.navigator.mediaDevices.getUserMedia) {
      const reason = global.isSecureContext
        ? 'Browser microphone APIs are unavailable in this browser.'
        : `Chrome blocks in-page microphone capture on insecure origin ${global.location.origin}.`;
      this.showToast(reason, 'error');
      if (!global.isSecureContext) openSecureSetup();
      return;
    }
    if (typeof global.MediaRecorder === 'undefined') {
      this.showToast('MediaRecorder is not supported in this browser.', 'error');
      return;
    }

    try {
      const mimeType = this.pickVoiceMimeType();
      this.voiceChunks = [];
      this.voiceStream = await global.navigator.mediaDevices.getUserMedia({ audio: true });
      this.mediaRecorder = mimeType
        ? new MediaRecorder(this.voiceStream, { mimeType })
        : new MediaRecorder(this.voiceStream);
      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size) this.voiceChunks.push(event.data);
      };
      this.mediaRecorder.onerror = () => {
        this.showToast('Voice recording failed.', 'error');
        this.stopVoiceRecording(true);
      };
      this.mediaRecorder.onstop = async () => {
        const blob = new Blob(this.voiceChunks, {
          type: (this.mediaRecorder && this.mediaRecorder.mimeType) || mimeType || 'audio/webm'
        });
        this.stopVoiceRecording(true);
        await this.transcribeVoiceBlob(blob);
      };
      this.mediaRecorder.start();
      this.ui.voiceButton.textContent = 'Recording';
      this.ui.voiceButton.classList.add('active');
      this.ui.voiceButton.classList.add('voice-recording');
      this.showToast('Recording... Click Mic again to stop and transcribe.', 'info');
    } catch (error) {
      this.stopVoiceRecording(true);
      const msg = String(error.message || error.name || '');
      if (msg.includes('NotAllowedError') || msg.includes('Permission')) {
        this.showToast('Microphone permission denied. Allow mic access in Chrome settings.', 'error');
      } else if (msg.includes('NotFoundError') || msg.includes('no audio')) {
        this.showToast('No microphone found. Connect a microphone and try again.', 'error');
      } else if (!global.isSecureContext) {
        this.showToast(`Chrome blocked microphone capture on insecure origin ${global.location.origin}.`, 'error');
        openSecureSetup();
      } else {
        this.showToast(msg || 'Failed to start microphone capture', 'error');
      }
    }
  }

  function hasNativeVoiceBridge() {
    return Boolean(global.ReactNativeWebView && global.ReactNativeWebView.postMessage);
  }

  function getNativeBridgeNonce() {
    return String(global.__LOCALAGENT_NATIVE_BRIDGE_NONCE__ || '');
  }

  function postNativeVoiceMessage(type) {
    const nonce = getNativeBridgeNonce();
    if (!nonce) return;
    global.ReactNativeWebView.postMessage(JSON.stringify({ type, nonce }));
  }

  async function toggleNativeVoiceInput() {
    if (this.nativeVoiceRecording) {
      this.ui.voiceButton.disabled = true;
      this.ui.voiceButton.textContent = 'Saving...';
      postNativeVoiceMessage('localagent.voice.stop');
      return;
    }

    this.nativeVoiceRecording = true;
    this.ui.voiceButton.textContent = 'Starting...';
    this.ui.voiceButton.classList.add('active');
    this.ui.voiceButton.classList.add('voice-recording');
    postNativeVoiceMessage('localagent.voice.start');
  }

  function installNativeVoiceBridge() {
    if (!hasNativeVoiceBridge()) return;
    this.nativeVoiceRecording = false;
    global.LocalAgentCompanionNativeVoice = {
      handleNativeEvent: (payload) => this.handleNativeVoiceEvent(payload)
    };
  }

  async function handleNativeVoiceEvent(payload = {}) {
    if (payload.nonce !== getNativeBridgeNonce()) return;
    const type = String(payload.type || '');
    if (type === 'recording-started') {
      this.ui.voiceButton.disabled = false;
      this.ui.voiceButton.textContent = 'Recording';
      this.ui.voiceButton.classList.add('active');
      this.ui.voiceButton.classList.add('voice-recording');
      this.showToast('Recording in Android app... Click Mic again to stop.', 'info');
      return;
    }

    if (type === 'recording-ready') {
      this.nativeVoiceRecording = false;
      this.ui.voiceButton.disabled = false;
      this.ui.voiceButton.textContent = 'Transcribing...';
      this.ui.voiceButton.classList.remove('voice-recording');
      const blob = base64ToBlob(String(payload.base64 || ''), String(payload.contentType || 'audio/mp4'));
      await this.transcribeVoiceBlob(blob);
      return;
    }

    if (type === 'error') {
      this.nativeVoiceRecording = false;
      this.ui.voiceButton.disabled = false;
      this.ui.voiceButton.textContent = 'Mic';
      this.ui.voiceButton.classList.remove('active');
      this.ui.voiceButton.classList.remove('voice-recording');
      this.showToast(payload.error || 'Android microphone failed.', 'error');
    }
  }

  function base64ToBlob(base64, contentType) {
    const binary = atob(base64 || '');
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new Blob([bytes], { type: contentType || 'audio/mp4' });
  }

  function pickVoiceMimeType() {
    if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
      return '';
    }
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    return candidates.find((entry) => MediaRecorder.isTypeSupported(entry)) || '';
  }

  function stopVoiceRecording(force = false) {
    if (force && this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      try { this.mediaRecorder.stop(); } catch (_) {}
    }
    if (this.voiceStream) {
      this.voiceStream.getTracks().forEach((track) => track.stop());
    }
    this.voiceStream = null;
    this.mediaRecorder = null;
    this.ui.voiceButton.textContent = 'Mic';
    this.ui.voiceButton.classList.remove('active');
    this.ui.voiceButton.classList.remove('voice-recording');
  }

  async function transcribeVoiceBlob(blob) {
    this.transcribingVoice = true;
    this.ui.voiceButton.disabled = true;
    this.ui.voiceButton.textContent = 'Transcribing...';
    try {
      if (!blob.size) {
        this.showToast('No voice captured.', 'info');
        return;
      }

      let transcript = '';
      let transcriptionError = '';
      try {
        const result = await this.client.transcribeBlob(blob, { sessionId: this.activeSessionId || '' });
        transcript = String(result.transcript || result.text || '').trim();
      } catch (error) {
        transcriptionError = error.message || 'Transcription failed';
      }

      await this.uploadVoiceArtifact(blob, transcript);
      await Promise.all([this.loadMessages(), this.loadArtifacts(), this.loadSessions()]);
      if (transcript) {
        this.ui.composerInput.value = '';
        this.showToast('Voice message sent.', 'success');
      } else if (transcriptionError) {
        this.showToast(`Voice uploaded without transcript. ${transcriptionError}`, 'info');
      } else {
        this.showToast('Voice uploaded without transcript.', 'info');
      }
    } catch (error) {
      this.showToast(error.message || 'Voice upload failed', 'error');
    } finally {
      this.transcribingVoice = false;
      this.ui.voiceButton.disabled = false;
      this.ui.voiceButton.textContent = 'Mic';
    }
  }

  global.LocalAgentCompanionVoiceInput = {
    methods: {
      toggleVoiceInput,
      toggleNativeVoiceInput,
      installNativeVoiceBridge,
      handleNativeVoiceEvent,
      pickVoiceMimeType,
      stopVoiceRecording,
      transcribeVoiceBlob
    }
  };
})(window);
