// @ts-nocheck
class CompanionPermissions {
  _presets() {
    return {
      'read-only': {
        id: 'read-only',
        label: 'Read Only',
        channels: [
          'get-chat-sessions', 'switch-chat-session',
          'get-conversations', 'get-session-artifacts', 'read-session-artifact',
          'capability:get-state', 'get-agents', 'llm:get-config',
          'daemon:memory-status', 'daemon:workflow-status'
        ],
        endpoints: []
      },
      'chat-only': {
        id: 'chat-only',
        label: 'Chat Only',
        channels: [
          'create-chat-session', 'get-chat-sessions', 'switch-chat-session',
          'get-conversations', 'send-message', 'stop-generation',
          'get-session-artifacts', 'read-session-artifact'
        ],
        endpoints: ['companion:stt:transcribe', 'backend:voice:generate']
      },
      standard: {
        id: 'standard',
        label: 'Standard',
        channels: [
          'companion:status', 'companion:list-devices', 'companion:get-pairing',
          'create-chat-session', 'get-chat-sessions', 'switch-chat-session',
          'get-conversations', 'send-message', 'stop-generation',
          'clear-chat-session', 'get-session-artifacts', 'read-session-artifact',
          'capability:get-state', 'get-agents', 'llm:get-config',
          'capability:set-main', 'capability:set-group', 'llm:set-thinking-mode',
          'daemon:memory-status', 'daemon:workflow-status',
          'daemon:memory-start', 'daemon:memory-stop',
          'daemon:workflow-start', 'daemon:workflow-stop',
          'task-queue:list'
        ],
        endpoints: ['companion:stt:transcribe', 'backend:voice:generate']
      },
      full: {
        id: 'full',
        label: 'Full Access',
        channels: [
          'companion:status', 'companion:list-devices', 'companion:get-pairing',
          'create-chat-session', 'get-chat-sessions', 'switch-chat-session',
          'get-conversations', 'send-message', 'stop-generation',
          'clear-chat-session', 'get-session-artifacts', 'read-session-artifact',
          'capability:get-state', 'get-agents', 'llm:get-config',
          'capability:set-main', 'capability:set-group', 'llm:set-thinking-mode',
          'activate-agent', 'deactivate-agent',
          'daemon:memory-status', 'daemon:workflow-status',
          'daemon:memory-start', 'daemon:memory-stop',
          'daemon:workflow-start', 'daemon:workflow-stop',
          'task-queue:list', 'task-queue:approve', 'task-queue:defer', 'task-queue:cancel'
        ],
        endpoints: ['companion:stt:transcribe', 'backend:voice:generate']
      }
    };
  }

  listPresets() {
    return Object.values(this._presets());
  }

  getDefaultScope(presetId) {
    const preset = this._presets()[presetId];
    if (!preset) return { channels: [], endpoints: [] };
    return { preset: preset.id, channels: [...preset.channels], endpoints: [...preset.endpoints] };
  }

  isChannelAllowed(devicePermissions, channel) {
    const preset = this._presets()[devicePermissions?.preset] || this._presets().standard;
    if (!preset.channels.includes(channel)) return false;
    if (channel.startsWith('capability:set') && devicePermissions?.settingsWrite === false) return false;
    if (channel.startsWith('llm:set') && devicePermissions?.settingsWrite === false) return false;
    if (['activate-agent', 'deactivate-agent'].includes(channel) && devicePermissions?.agentManagement !== true) return false;
    if (channel.startsWith('daemon:') && !channel.endsWith('-status') && devicePermissions?.daemonControl === false) return false;
    return true;
  }

  isCompanionEndpointAllowed(devicePermissions, endpoint) {
    const preset = this._presets()[devicePermissions?.preset] || this._presets().standard;
    if (!preset.endpoints.includes(endpoint)) return false;

    if (endpoint === 'companion:stt:transcribe' && devicePermissions?.mediaUpload === false) return false;
    return true;
  }
}

module.exports = CompanionPermissions;
