'use strict';

const { NativeWhisperSttBackend } = require('./lib/native-whisper-backend');

let backend = null;

function getBackend(context) {
  if (!backend) {
    backend = new NativeWhisperSttBackend({
      cacheDir: context?.config?.cacheDir || ''
    });
  }
  return backend;
}

module.exports = {
  async onEnable(context) {
    context.log('Whisper STT plugin enabled');
  },

  async onDisable() {
    backend = null;
  },

  async runAction(action, params, context) {
    if (action === 'transcribeAudio') {
      return getBackend(context).transcribeAudio(params);
    }
    if (action === 'getBackendStatus' || action === 'healthCheck') {
      return getBackend(context).getAvailability();
    }
    throw new Error('Unknown Whisper STT action: ' + action);
  }
};
