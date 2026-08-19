// @ts-nocheck
(function bootstrapCompanionApp(global) {
  const {
    escapeHtml,
    formatBytes,
    formatDateTime,
    formatGroupLabel,
  } = global.LocalAgentCompanionUtils;

  function settlePromises(tasks) {
    return Promise.all(tasks.map((task) => Promise.resolve(task).catch(() => null)));
  }

  function normalizeConnectionState(update) {
    if (typeof update === 'boolean') {
      return update
        ? { connected: true, mode: 'live', detail: 'Live updates connected.' }
        : { connected: false, mode: 'offline', detail: '' };
    }
    return {
      connected: update && update.connected === true,
      mode: String((update && update.mode) || 'offline').trim() || 'offline',
      detail: String((update && update.detail) || '').trim()
    };
  }

  function normalizePairingError(error, hadSavedSession) {
    const raw = String((error && error.message) || 'Pairing failed.').trim();
    if (raw === 'No active pairing') {
      return hadSavedSession
        ? 'This pairing code was already used. The app is already paired on this device. Reload to restore the saved session.'
        : 'This pairing code is no longer active. Generate a fresh code from the desktop app and try again.';
    }
    if (raw === 'Invalid pairing code') {
      return 'The pairing code does not match the current desktop code.';
    }
    if (raw === 'Invalid session token') {
      return 'The saved mobile session is no longer valid. Pair again with a fresh desktop code.';
    }
    return raw;
  }

  class CompanionApp {
    constructor() {
      this.client = new global.LocalAgentCompanionClient(global.location.origin);
      this.sessions = [];
      this.messages = [];
      this.agents = [];
      this.artifacts = [];
      this.snapshot = null;
      this.activeSessionId = '';
      this.generating = false;
      this.mediaRecorder = null;
      this.voiceStream = null;
      this.voiceChunks = [];
      this.transcribingVoice = false;
      this.speechAudio = null;
      this.speakingMessageIndex = -1;
      this.layout = 'mobile';
      this.leftSidebarOpen = false;
      this.rightSidebarOpen = false;
      this.pollTimer = null;
      this.changedSessionIds = new Set();
      this.resyncInFlight = null;
      this.connectionState = { connected: false, mode: 'offline', detail: '' };
      this.updateHandlers = global.LocalAgentCompanionUpdates.createUpdateHandlers(this);
      this.ui = this.collectUi();
      this.activity = global.LocalAgentCompanionActivity.createActivityController(this);
      if (this.installNativeVoiceBridge) this.installNativeVoiceBridge();
      this.bindEvents();
      this.applyPrefill();
      this.refreshLayout();
      this.bootstrap();
    }

    collectUi() {
      return {
        authScreen: document.getElementById('auth-screen'),
        appShell: document.getElementById('app-shell'),
        overlay: document.getElementById('shell-overlay'),
        pairCode: document.getElementById('pair-code'),
        authButton: document.getElementById('auth-btn'),
        authError: document.getElementById('auth-err'),
        leftSidebar: document.getElementById('left-sidebar'),
        rightSidebar: document.getElementById('right-sidebar'),
        toggleLeftSidebar: document.getElementById('toggle-left-sidebar-btn'),
        toggleRightSidebar: document.getElementById('toggle-right-sidebar-btn'),
        closeLeftSidebar: document.getElementById('close-left-sidebar-btn'),
        closeRightSidebar: document.getElementById('close-right-sidebar-btn'),
        logoutButton: document.getElementById('logout-btn'),
        wsStatus: document.getElementById('ws-status'),
        topbarSubtitle: document.getElementById('topbar-subtitle'),
        layoutBadge: document.getElementById('layout-badge'),
        activeSessionTitle: document.getElementById('active-session-title'),
        modelSummary: document.getElementById('model-summary'),
        capabilitySummary: document.getElementById('capability-summary'),
        toastStack: document.getElementById('toast-stack'),
        newSessionButton: document.getElementById('new-session-btn'),
        sessionList: document.getElementById('session-list'),
        refreshAgentsButton: document.getElementById('refresh-agents-btn'),
        agentList: document.getElementById('agent-list'),
        messageList: document.getElementById('message-list'),
        dropHint: document.getElementById('drop-hint'),
        composerInput: document.getElementById('composer-input'),
        attachButton: document.getElementById('attach-btn'),
        voiceButton: document.getElementById('voice-btn'),
        artifactShortcut: document.getElementById('artifact-shortcut-btn'),
        scrollBottomButton: document.getElementById('scroll-bottom-btn'),
        sendButton: document.getElementById('send-btn'),
        stopButton: document.getElementById('stop-btn'),
        fileInput: document.getElementById('file-input'),
        refreshSnapshotButton: document.getElementById('refresh-snapshot-btn'),
        thinkingValue: document.getElementById('thinking-value'),
        toolsValue: document.getElementById('tools-value'),
        memoryValue: document.getElementById('memory-value'),
        workflowValue: document.getElementById('workflow-value'),
        devicesValue: document.getElementById('devices-value'),
        toggleThinkingButton: document.getElementById('toggle-thinking-btn'),
        toggleToolsButton: document.getElementById('toggle-tools-btn'),
        toggleMemoryButton: document.getElementById('toggle-memory-btn'),
        toggleWorkflowButton: document.getElementById('toggle-workflow-btn'),
        refreshArtifactsButton: document.getElementById('refresh-artifacts-btn'),
        capabilityGroupList: document.getElementById('capability-group-list'),
        artifactList: document.getElementById('artifact-list'),
        artifactDialog: document.getElementById('artifact-dialog'),
        artifactDialogTitle: document.getElementById('artifact-dialog-title'),
        artifactDialogBody: document.getElementById('artifact-dialog-body'),
        closeArtifactDialogButton: document.getElementById('close-artifact-dialog-btn')
      };
    }

    bindEvents() {
      this.ui.authButton.addEventListener('click', () => this.handlePairAndConnect());
      this.ui.pairCode.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') this.handlePairAndConnect();
      });

      this.ui.toggleLeftSidebar.addEventListener('click', () => this.toggleSidebar('left'));
      this.ui.toggleRightSidebar.addEventListener('click', () => this.toggleSidebar('right'));
      this.ui.closeLeftSidebar.addEventListener('click', () => this.closeSidebars());
      this.ui.closeRightSidebar.addEventListener('click', () => this.closeSidebars());
      this.ui.overlay.addEventListener('click', () => this.closeSidebars());
      this.ui.logoutButton.addEventListener('click', () => this.logout());

      this.ui.newSessionButton.addEventListener('click', () => this.createSession());
      this.ui.refreshAgentsButton.addEventListener('click', () => this.loadAgents());
      this.ui.sendButton.addEventListener('click', () => this.sendMessage());
      this.ui.stopButton.addEventListener('click', () => this.stopGeneration());
      this.ui.attachButton.addEventListener('click', () => this.ui.fileInput.click());
      this.ui.fileInput.addEventListener('change', () => {
        this.uploadFiles(Array.from(this.ui.fileInput.files || []));
        this.ui.fileInput.value = '';
      });
      this.ui.voiceButton.addEventListener('click', () => this.toggleVoiceInput());
      this.ui.artifactShortcut.addEventListener('click', () => this.toggleSidebar('right', true));
      this.ui.scrollBottomButton.addEventListener('click', () => this.scrollMessagesToBottom());
      this.ui.refreshSnapshotButton.addEventListener('click', () => this.refreshSnapshot());
      this.ui.refreshArtifactsButton.addEventListener('click', () => this.loadArtifacts());
      this.ui.toggleThinkingButton.addEventListener('click', () => this.toggleThinkingMode());
      this.ui.toggleToolsButton.addEventListener('click', () => this.toggleTools());
      this.ui.toggleMemoryButton.addEventListener('click', () => this.toggleDaemon('memory'));
      this.ui.toggleWorkflowButton.addEventListener('click', () => this.toggleDaemon('workflow'));
      this.ui.closeArtifactDialogButton.addEventListener('click', () => this.closeArtifactDialog());

      this.ui.composerInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          this.sendMessage();
        }
      });

      global.addEventListener('resize', () => this.refreshLayout());
      global.addEventListener('dragover', (event) => {
        if (this.ui.appShell.hidden) return;
        event.preventDefault();
        this.ui.dropHint.hidden = false;
      });
      global.addEventListener('dragleave', (event) => {
        if (event.relatedTarget) return;
        this.ui.dropHint.hidden = true;
      });
      global.addEventListener('drop', (event) => {
        if (this.ui.appShell.hidden) return;
        event.preventDefault();
        this.ui.dropHint.hidden = true;
        this.uploadFiles(Array.from((event.dataTransfer && event.dataTransfer.files) || []));
      });
    }

    applyPrefill() {
      const params = new URLSearchParams(global.location.search);
      const queryCode = params.get('code') || params.get('pairingCode') || '';
      this.prefilledDeviceName = String(params.get('device') || params.get('deviceName') || '').trim();
      if (queryCode) this.ui.pairCode.value = queryCode;
    }

    async bootstrap() {
      await this.loadUiState();
      const restored = await this.client.autoLogin();
      if (!restored) return;
      try {
        await this.showApp();
      } catch (error) {
        this.client.disconnectWebSocket();
        this.setShellVisible(false);
        this.ui.authError.textContent = `Saved session found, but workspace restore failed: ${error.message || 'unknown error'}`;
      }
    }

    async loadUiState() {
      try {
        const response = await this.client.getUiState();
        if (response && response.success && response.ui) {
          global.LocalAgentCompanionUiState.apply(response.ui);
        }
      } catch (_) {}
    }

    resolveDeviceName() {
      return this.prefilledDeviceName || this.client.getDefaultDeviceName();
    }

    setShellVisible(showApp) {
      this.ui.authScreen.hidden = showApp;
      this.ui.appShell.hidden = !showApp;
    }

    async handlePairAndConnect() {
      const pairingCode = String(this.ui.pairCode.value || '').trim();
      const deviceName = this.resolveDeviceName();
      const hadSavedSession = Boolean(this.client.savedSessionToken());
      if (!pairingCode) {
        this.ui.authError.textContent = 'Enter the pairing code from your desktop.';
        return;
      }

      this.ui.authButton.disabled = true;
      const originalLabel = this.ui.authButton.textContent;
      this.ui.authButton.textContent = 'Pairing...';
      this.ui.authError.textContent = '';
      try {
        await this.client.pair(pairingCode, deviceName);
        this.ui.authButton.textContent = 'Loading workspace...';
        this.ui.authError.textContent = 'Pairing accepted. Loading the desktop workspace...';
        await this.showApp();
      } catch (error) {
        this.client.disconnectWebSocket();
        this.setShellVisible(false);
        this.ui.authError.textContent = normalizePairingError(error, hadSavedSession);
      } finally {
        this.ui.authButton.disabled = false;
        this.ui.authButton.textContent = originalLabel;
      }
    }

    async showApp() {
      this.setShellVisible(true);
      try {
        this.client.connectWebSocket(
          (message) => this.handleWsMessage(message),
          (state) => this.applyConnectionState(state),
          () => global.LocalAgentCompanionUpdates.resyncAfterReconnect(this)
        );
        await settlePromises([
          this.refreshSnapshot(true),
          this.loadSessions(true),
          this.loadAgents(true),
          this.activity.loadTaskQueue()
        ]);
        await this.ensureActiveSession();
        await settlePromises([this.loadMessages(), this.loadArtifacts()]);
        this.renderLayout();
        this.ensurePolling();
        this.ui.composerInput.focus();
      } catch (error) {
        this.client.disconnectWebSocket();
        this.setShellVisible(false);
        throw error;
      }
    }

    async ensureActiveSession() {
      if (this.activeSessionId) return true;
      if (this.sessions[0] && this.sessions[0].id) {
        this.activeSessionId = this.sessions[0].id;
        return true;
      }
      const response = await this.client.createChatSession();
      const session = response && response.result != null ? response.result : response;
      if (!session || !session.id) {
        throw new Error('Failed to create an initial chat session.');
      }
      this.activeSessionId = session.id;
      await this.loadSessions();
      return true;
    }

    logout() {
      this.stopSpeechPlayback();
      this.stopVoiceRecording(true);
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.pollTimer = null;
      this.client.logout();
      this.setShellVisible(false);
      this.ui.authError.textContent = '';
      this.applyConnectionState({ connected: false, mode: 'offline', detail: '' });
    }

    refreshLayout() {
      const desktop = global.matchMedia('(min-width: 1100px)').matches;
      this.layout = desktop ? 'desktop' : 'mobile';
      document.documentElement.setAttribute('data-companion-layout', this.layout);
      this.ui.layoutBadge.textContent = this.layout === 'desktop' ? 'Desktop Web' : 'Mobile Web';
      if (desktop) {
        this.leftSidebarOpen = false;
        this.rightSidebarOpen = false;
        this.closeSidebars();
      }
    }

    toggleSidebar(which, forceOpen = false) {
      if (this.layout === 'desktop') return;
      if (which === 'left') {
        this.leftSidebarOpen = forceOpen || !this.leftSidebarOpen;
        this.rightSidebarOpen = false;
      } else {
        this.rightSidebarOpen = forceOpen || !this.rightSidebarOpen;
        this.leftSidebarOpen = false;
      }
      this.renderLayout();
    }

    closeSidebars() {
      this.leftSidebarOpen = false;
      this.rightSidebarOpen = false;
      this.renderLayout();
    }

    renderLayout() {
      const desktop = this.layout === 'desktop';
      this.ui.leftSidebar.classList.toggle('open', desktop || this.leftSidebarOpen);
      this.ui.rightSidebar.classList.toggle('open', desktop || this.rightSidebarOpen);
      this.ui.overlay.hidden = desktop || (!this.leftSidebarOpen && !this.rightSidebarOpen);
    }

    applyConnectionState(update) {
      this.connectionState = normalizeConnectionState(update);
      const connected = this.connectionState.connected === true;
      const live = this.connectionState.mode === 'live';
      this.ui.wsStatus.classList.toggle('online', connected);
      this.ui.wsStatus.classList.toggle('offline', !connected);
      if (this.snapshot && this.snapshot.llm && this.snapshot.llm.model) {
        this.ui.topbarSubtitle.textContent = live
          ? `Model • ${this.snapshot.llm.model}`
          : `${this.connectionState.detail || 'Connected without live updates.'} • Model ${this.snapshot.llm.model}`;
      } else if (!connected) {
        this.ui.topbarSubtitle.textContent = this.connectionState.detail || 'Disconnected. Reconnecting if possible...';
      }
      if (this.snapshot) this.renderSnapshot();
    }

    handleWsMessage(message) {
      if (!message || typeof message !== 'object') return;
      const handler = this.updateHandlers[message.type];
      if (handler) {
        Promise.resolve(handler(message.payload || {}, message)).catch((error) => {
          this.showToast(error.message || `Failed to handle ${message.type}`, 'error');
        });
      }
    }

    showToast(message, type = 'info') {
      const toast = document.createElement('div');
      toast.className = `toast toast-${type}`;
      toast.textContent = String(message || '');
      this.ui.toastStack.appendChild(toast);
      global.setTimeout(() => {
        toast.remove();
      }, 3200);
    }

    getPermissions() {
      return (this.snapshot && this.snapshot.companion && this.snapshot.companion.permissions) || {};
    }

    async refreshSnapshot(throwOnError = false) {
      try {
        const response = await this.client.getSettingsSnapshot();
        if (!response.success) return;
        this.snapshot = response.snapshot || null;
        if (this.snapshot && this.snapshot.ui) global.LocalAgentCompanionUiState.apply(this.snapshot.ui);
        this.renderSnapshot();
      } catch (error) {
        if (throwOnError) throw error;
        this.showToast(error.message || 'Failed to load companion snapshot', 'error');
      }
    }

    renderSnapshot() {
      const snapshot = this.snapshot;
      const llm = (snapshot && snapshot.llm) || {};
      const caps = (snapshot && snapshot.capabilities) || {};
      const daemons = (snapshot && snapshot.daemons) || {};
      const companion = (snapshot && snapshot.companion) || {};

      this.ui.topbarSubtitle.textContent = llm.model
        ? (this.connectionState.mode === 'live'
          ? `Model • ${llm.model}`
          : `${this.connectionState.detail || 'Connected without live updates.'} • Model ${llm.model}`)
        : 'Connected to desktop companion';
      this.ui.modelSummary.textContent = llm.model
        ? `Model / ${llm.model}`
        : 'Model: —';
      this.ui.capabilitySummary.textContent = `Tools: ${caps.mainEnabled ? 'ON' : 'OFF'} • ${caps.activeToolCount || 0} active`;
      this.ui.thinkingValue.textContent = llm.thinkingMode || '—';
      this.ui.toolsValue.textContent = caps.mainEnabled ? `ON (${caps.activeToolCount || 0})` : 'OFF';
      this.ui.memoryValue.textContent = daemons.memoryRunning ? 'Running' : 'Stopped';
      this.ui.workflowValue.textContent = daemons.workflowRunning ? 'Running' : 'Stopped';
      const liveConnectedDevices = this.connectionState.connected ? Math.max(Number(companion.connectedDevices || 0), 1) : Number(companion.connectedDevices || 0);
      this.ui.devicesValue.textContent = this.connectionState.connected
        ? `${liveConnectedDevices} connected (live)`
        : `${liveConnectedDevices} connected (polling)`;
      this.ui.toggleThinkingButton.textContent = llm.thinkingMode === 'off' ? 'Enable Thinking' : 'Disable Thinking';
      this.ui.toggleToolsButton.textContent = caps.mainEnabled ? 'Disable Tools' : 'Enable Tools';
      this.ui.toggleMemoryButton.textContent = daemons.memoryRunning ? 'Stop Memory' : 'Start Memory';
      this.ui.toggleWorkflowButton.textContent = daemons.workflowRunning ? 'Stop Workflow' : 'Start Workflow';

      const permissions = this.getPermissions();
      const canWriteSettings = permissions.settingsWrite !== false;
      const canManageAgents = permissions.agentManagement !== false;
      const canControlDaemons = permissions.daemonControl !== false;
      const canUploadMedia = permissions.mediaUpload !== false;

      this.ui.toggleThinkingButton.disabled = !canWriteSettings;
      this.ui.toggleToolsButton.disabled = !canWriteSettings;
      this.ui.toggleMemoryButton.disabled = !canControlDaemons;
      this.ui.toggleWorkflowButton.disabled = !canControlDaemons;
      this.ui.attachButton.disabled = !canUploadMedia;
      this.ui.voiceButton.disabled = this.transcribingVoice || !canUploadMedia;
      this.ui.refreshAgentsButton.disabled = false;
      this.ui.agentList.classList.toggle('readonly', !canManageAgents);

      this.renderCapabilityGroups();
      this.renderAgents();
    }

    renderCapabilityGroups() {
      const groups = Object.entries((this.snapshot && this.snapshot.capabilities && this.snapshot.capabilities.groups) || {});
      const canWriteSettings = this.getPermissions().settingsWrite !== false;
      if (!groups.length) {
        this.ui.capabilityGroupList.innerHTML = '<div class="empty-state">No capability groups reported.</div>';
        return;
      }

      this.ui.capabilityGroupList.innerHTML = groups.map(([groupId, value]) => {
        const label = escapeHtml(formatGroupLabel(groupId));
        if (typeof value === 'boolean') {
          return `
            <button class="capability-chip ${value ? 'active' : ''}" data-group-id="${escapeHtml(groupId)}" ${canWriteSettings ? '' : 'disabled'}>
              <span>${label}</span>
              <strong>${value ? 'ON' : 'OFF'}</strong>
            </button>
          `;
        }
        return `
          <div class="capability-chip static">
            <span>${label}</span>
            <strong>${escapeHtml(String(value))}</strong>
          </div>
        `;
      }).join('');

      this.ui.capabilityGroupList.querySelectorAll('[data-group-id]').forEach((button) => {
        button.addEventListener('click', () => this.toggleCapabilityGroup(button.dataset.groupId));
      });
    }

    async toggleCapabilityGroup(groupId) {
      const current = this.snapshot && this.snapshot.capabilities && this.snapshot.capabilities.groups
        ? this.snapshot.capabilities.groups[groupId]
        : undefined;
      if (typeof current !== 'boolean') return;
      try {
        await this.client.setCapabilityGroup(groupId, !current);
        await this.refreshSnapshot();
      } catch (error) {
        this.showToast(error.message || `Failed to update ${formatGroupLabel(groupId)}`, 'error');
      }
    }

    async loadSessions(throwOnError = false) {
      try {
        const previousActiveSessionId = this.activeSessionId;
        const response = await this.client.listChatSessions(20);
        this.sessions = Array.isArray(response.result) ? response.result : [];
        const backendCurrentSessionId = String(response.currentSessionId || response.currentSession?.id || '').trim();
        if (backendCurrentSessionId) {
          this.activeSessionId = backendCurrentSessionId;
          this.changedSessionIds.delete(backendCurrentSessionId);
        }
        if (this.activeSessionId && !this.sessions.some((session) => String(session.id) === String(this.activeSessionId))) {
          this.activeSessionId = (this.sessions[0] && this.sessions[0].id) || '';
        }
        if (!this.activeSessionId && this.sessions[0] && this.sessions[0].id) {
          this.activeSessionId = this.sessions[0].id;
        }
        this.renderSessions();
        if (previousActiveSessionId !== this.activeSessionId && !this.ui.appShell.hidden) {
          await Promise.all([this.loadMessages(), this.loadArtifacts()]);
        }
      } catch (error) {
        if (throwOnError) throw error;
        this.showToast(error.message || 'Failed to load sessions', 'error');
      }
    }

    renderSessions() {
      const items = this.sessions.slice(0, 20).map((session) => {
        const label = escapeHtml((session.first_message || session.title || 'Chat').slice(0, 36));
        const active = String(session.id) === String(this.activeSessionId);
        const changed = this.changedSessionIds.has(String(session.id));
        return `
          <button class="session-item ${active ? 'active' : ''} ${changed ? 'changed' : ''}" data-session-id="${escapeHtml(session.id)}">
            <span class="session-title">${label}${changed ? ' *' : ''}</span>
            <span class="session-meta">${escapeHtml(formatDateTime(session.created_at || session.updated_at))}</span>
          </button>
        `;
      }).join('');
      this.ui.sessionList.innerHTML = items || '<div class="empty-state">No sessions yet.</div>';
      this.ui.sessionList.querySelectorAll('[data-session-id]').forEach((button) => {
        button.addEventListener('click', () => this.switchSession(button.dataset.sessionId));
      });
    }

    async createSession() {
      try {
        const response = await this.client.createChatSession();
        if (response.result && response.result.id) {
          this.activeSessionId = response.result.id;
          await this.loadSessions();
          await this.loadMessages();
          await this.loadArtifacts();
          this.closeSidebars();
        }
      } catch (error) {
        this.showToast(error.message || 'Failed to create session', 'error');
      }
    }

    async switchSession(sessionId) {
      if (!sessionId) return;
      this.stopSpeechPlayback();
      this.activeSessionId = sessionId;
      this.changedSessionIds.delete(String(sessionId));
      try {
        await this.client.switchChatSession(sessionId);
        await Promise.all([this.loadMessages(), this.loadArtifacts()]);
        this.renderSessions();
        this.closeSidebars();
      } catch (error) {
        this.showToast(error.message || 'Failed to switch session', 'error');
      }
    }

    async loadMessages() {
      if (!this.activeSessionId) {
        this.messages = [];
        this.renderMessages();
        return;
      }
      try {
        const response = await this.client.getMessages(this.activeSessionId, 80);
        this.messages = Array.isArray(response.result) ? response.result : [];
        await this.client.prepareArtifactTickets(this.activeSessionId, this.messages);
        this.renderMessages();
      } catch (error) {
        this.showToast(error.message || 'Failed to load messages', 'error');
      }
    }

    renderMessages() {
      const activeSession = this.sessions.find((entry) => String(entry.id) === String(this.activeSessionId));
      this.ui.activeSessionTitle.textContent = (activeSession && (activeSession.title || activeSession.first_message)) || 'Conversation';

      const items = this.messages.map((message, index) => {
        const role = String(message.role || 'assistant');
        const content = String(message.content || '');
        const thinkingVisibility = (this.snapshot && this.snapshot.llm && this.snapshot.llm.thinkingVisibility)
          || (this.snapshot && this.snapshot.llm && this.snapshot.llm.showThinking === false ? 'hide' : 'show');
        const bodyHtml = global.LocalAgentCompanionMessageRenderer.renderMessage(role, content, {
          thinkingVisibility,
          artifactUrlFor: (fileName) => this.activeSessionId ? this.client.getArtifactUrl(this.activeSessionId, fileName) : ''
        });
        const source = role === 'user' && message.metadata && message.metadata.sourceLabel
          ? `<span class="message-origin">${escapeHtml(message.metadata.sourceLabel)}</span>`
          : '';
        const timestamp = message.timestamp ? `<div class="message-time">${escapeHtml(formatDateTime(message.timestamp))}</div>` : '';
        const speakButton = role === 'assistant' && content.trim()
          ? `<button class="message-action ${this.speakingMessageIndex === index ? 'active' : ''}" data-speak-index="${index}">${this.speakingMessageIndex === index ? 'Stop' : 'Listen'}</button>`
          : '';
        return `
          <article class="message-card message-${escapeHtml(role)}">
            <div class="message-head">
              <span class="message-role">${escapeHtml(role)}${source}</span>
              ${timestamp}
            </div>
            <div class="message-body">${bodyHtml}</div>
            ${speakButton ? `<div class="message-actions">${speakButton}</div>` : ''}
          </article>
        `;
      }).join('');
      // Add generating indicator when AI is processing
      const generatingHtml = this.generating
        ? '<div class="message-card message-assistant generating-indicator"><div class="message-body">Generating response<span class="generating-dots">...</span></div></div>'
        : '';

      this.ui.messageList.innerHTML = (items || '<div class="empty-message-state">No messages yet. Start a conversation.</div>') + generatingHtml;
      this.ui.messageList.querySelectorAll('[data-speak-index]').forEach((button) => {
        button.addEventListener('click', () => this.speakMessage(Number(button.dataset.speakIndex)));
      });
      this.scrollMessagesToBottom();
    }

    scrollMessagesToBottom() {
      this.ui.messageList.scrollTop = this.ui.messageList.scrollHeight;
    }

    ensurePolling() {
      if (this.pollTimer) return;
      this.pollTimer = global.setInterval(() => {
        if (this.ui.appShell.hidden || global.document.hidden || this.generating) return;
        this.loadSessions();
        if (this.activeSessionId) Promise.all([this.loadMessages(), this.loadArtifacts()]).catch(() => {});
      }, 4500);
    }

    async sendMessage() {
      const raw = String(this.ui.composerInput.value || '');
      const text = raw.trim();
      if (!text || this.generating) return;

      if (text.startsWith('/')) {
        this.ui.composerInput.value = '';
        await this.runCommand(text);
        return;
      }

      if (!this.activeSessionId) {
        await this.createSession();
      }
      if (!this.activeSessionId) return;

      this.ui.composerInput.value = '';
      this.generating = true;
      this.ui.sendButton.hidden = true;
      this.ui.stopButton.hidden = false;

      // Optimistic: show user message immediately in the message list
      this.messages.push({ role: 'user', content: text });
      this.renderMessages();

      try {
        const response = await this.client.sendMessage(text, this.activeSessionId);
        if (response.result && response.result.sessionId) {
          this.activeSessionId = response.result.sessionId;
        }
        await Promise.all([this.loadMessages(), this.loadSessions(), this.loadArtifacts()]);
      } catch (error) {
        this.showToast(error.message || 'Send failed', 'error');
        // Reload messages to remove the optimistic entry and show actual state
        await this.loadMessages();
      } finally {
        this.generating = false;
        this.ui.sendButton.hidden = false;
        this.ui.stopButton.hidden = true;
      }
    }

    async stopGeneration() {
      try {
        await this.client.stopGeneration();
      } catch (_) {}
      this.generating = false;
      this.ui.sendButton.hidden = false;
      this.ui.stopButton.hidden = true;
    }

    async runCommand(text) {
      const [command, ...args] = text.slice(1).split(/\s+/);
      const arg = args.join(' ');
      try {
        if (command === 'new') {
          await this.createSession();
          return;
        }
        if (command === 'stop') {
          await this.stopGeneration();
          return;
        }
        if (command === 'clear' && this.activeSessionId) {
          await this.client.clearChatSession(this.activeSessionId);
          await this.loadMessages();
          return;
        }
        if (command === 'think') {
          await this.client.setThinkingMode(arg === 'off' ? 'off' : 'think');
          await this.refreshSnapshot();
          return;
        }
        if (command === 'agents') {
          await this.loadAgents();
          this.toggleSidebar('left', true);
          return;
        }
        if (command === 'tools') {
          await this.refreshSnapshot();
          this.toggleSidebar('right', true);
          return;
        }
        this.showToast(`Unknown command: /${command}`, 'info');
      } catch (error) {
        this.showToast(error.message || 'Command failed', 'error');
      }
    }

    async loadAgents(throwOnError = false) {
      try {
        const response = await this.client.listAgents();
        this.agents = Array.isArray(response.result) ? response.result : [];
        this.renderAgents();
      } catch (error) {
        if (throwOnError) throw error;
        this.showToast(error.message || 'Failed to load agents', 'error');
      }
    }

    renderAgents() {
      const canManageAgents = this.getPermissions().agentManagement !== false;
      const items = this.agents.map((agent) => {
        const active = agent.active === true;
        return `
          <div class="agent-card">
            <div class="agent-main">
              <strong>${escapeHtml(agent.name || `Agent ${agent.id}`)}</strong>
              <span>${escapeHtml(agent.type || 'agent')}</span>
            </div>
            <button class="agent-toggle ${active ? 'active' : ''}" data-agent-id="${escapeHtml(agent.id)}" ${canManageAgents ? '' : 'disabled'}>
              ${active ? 'Active' : 'Inactive'}
            </button>
          </div>
        `;
      }).join('');
      this.ui.agentList.innerHTML = items || '<div class="empty-state">No agents configured.</div>';
      this.ui.agentList.querySelectorAll('[data-agent-id]').forEach((button) => {
        button.addEventListener('click', () => this.toggleAgent(button.dataset.agentId));
      });
    }

    async toggleAgent(agentId) {
      if (this.getPermissions().agentManagement === false) return;
      const agent = this.agents.find((entry) => String(entry.id) === String(agentId));
      if (!agent) return;
      try {
        if (agent.active) {
          await this.client.setAgentActive(agentId, false);
        } else {
          await this.client.setAgentActive(agentId, true);
        }
        await this.loadAgents();
      } catch (error) {
        this.showToast(error.message || 'Failed to update agent', 'error');
      }
    }

    async loadArtifacts() {
      if (!this.activeSessionId) {
        this.artifacts = [];
        this.renderArtifacts();
        return;
      }
      try {
        const response = await this.client.getSessionArtifacts(this.activeSessionId);
        this.artifacts = Array.isArray(response.result && response.result.files)
          ? response.result.files
          : Array.isArray(response.files) ? response.files : [];
        this.renderArtifacts();
      } catch (error) {
        this.showToast(error.message || 'Failed to load artifacts', 'error');
      }
    }

    renderArtifacts() {
      const items = this.artifacts.map((artifact) => `
        <button class="artifact-item" data-artifact-name="${escapeHtml(artifact.name)}">
          <strong>${escapeHtml(artifact.name)}</strong>
          <span>${escapeHtml(artifact.kind || 'file')} • ${escapeHtml(formatBytes(artifact.size))}</span>
        </button>
      `).join('');
      this.ui.artifactList.innerHTML = items || '<div class="empty-state">No artifacts for this session.</div>';
      this.ui.artifactList.querySelectorAll('[data-artifact-name]').forEach((button) => {
        button.addEventListener('click', () => this.openArtifact(button.dataset.artifactName));
      });
    }

    async openArtifact(fileName) {
      if (!this.activeSessionId || !fileName) return;
      const artifact = this.artifacts.find((entry) => entry.name === fileName);
      if (!artifact) return;

      this.ui.artifactDialogTitle.textContent = fileName;
      this.ui.artifactDialogBody.innerHTML = '<div class="artifact-loading">Loading…</div>';
      this.ui.artifactDialog.showModal();

      try {
        if (artifact.kind === 'text') {
          const response = await this.client.readSessionArtifact(this.activeSessionId, fileName);
          const payload = response && response.result != null ? response.result : response;
          if (!payload || !payload.success) {
            throw new Error((payload && payload.error) || 'Unable to open text artifact');
          }
          this.ui.artifactDialogBody.innerHTML = `<pre class="artifact-text">${escapeHtml(payload.content || '')}</pre>`;
          return;
        }

        const url = await this.client.getArtifactUrlWithTicket(this.activeSessionId, fileName);
        if (artifact.kind === 'image') {
          this.ui.artifactDialogBody.innerHTML = `<img class="artifact-image" alt="${escapeHtml(fileName)}" src="${url}">`;
          return;
        }
        if (artifact.kind === 'audio') {
          this.ui.artifactDialogBody.innerHTML = `<audio controls class="artifact-audio" src="${url}"></audio>`;
          return;
        }
        if (artifact.kind === 'video') {
          this.ui.artifactDialogBody.innerHTML = `<video controls class="artifact-video" src="${url}"></video>`;
          return;
        }

        this.ui.artifactDialogBody.innerHTML = `
          <div class="artifact-binary">
            <p>This artifact is not previewable inline.</p>
            <a class="primary-btn artifact-open-link" href="${url}" target="_blank" rel="noreferrer">Open file</a>
          </div>
        `;
      } catch (error) {
        this.ui.artifactDialogBody.innerHTML = `<div class="artifact-error">${escapeHtml(error.message || 'Failed to open artifact')}</div>`;
      }
    }

    async uploadVoiceArtifact(blob, transcript = '', options = {}) {
      if (!this.activeSessionId) {
        await this.ensureActiveSession();
      }
      if (!this.activeSessionId) {
        throw new Error('No active session available for voice upload');
      }
      return this.client.uploadFile(blob, {
        sessionId: this.activeSessionId,
        caption: transcript,
        ...(options.sendAsMessage === false ? { sendAsMessage: false } : {})
      });
    }

    closeArtifactDialog() {
      this.ui.artifactDialog.close();
    }

    async uploadFiles(files) {
      if (!files.length) return;
      if (this.getPermissions().mediaUpload === false) {
        this.showToast('This companion device cannot upload files.', 'error');
        return;
      }
      if (!this.activeSessionId) {
        await this.createSession();
      }
      if (!this.activeSessionId) return;

      for (const file of files) {
        try {
          await this.client.uploadFile(file, { sessionId: this.activeSessionId });
          this.showToast(`Uploaded ${file.name}`, 'success');
        } catch (error) {
          this.showToast(error.message || `Upload failed for ${file.name}`, 'error');
        }
      }

      await Promise.all([this.loadMessages(), this.loadArtifacts()]);
    }

    async toggleThinkingMode() {
      const current = (this.snapshot && this.snapshot.llm && this.snapshot.llm.thinkingMode) || 'off';
      const next = current === 'off' ? 'think' : 'off';
      try {
        await this.client.setThinkingMode(next);
        await this.refreshSnapshot();
      } catch (error) {
        this.showToast(error.message || 'Failed to toggle thinking', 'error');
      }
    }

    async toggleTools() {
      const current = this.snapshot && this.snapshot.capabilities && this.snapshot.capabilities.mainEnabled === true;
      try {
        await this.client.setCapabilityMain(!current);
        await this.refreshSnapshot();
      } catch (error) {
        this.showToast(error.message || 'Failed to toggle tools', 'error');
      }
    }

    async toggleDaemon(kind) {
      try {
        if (kind === 'memory') {
          const running = this.snapshot && this.snapshot.daemons && this.snapshot.daemons.memoryRunning === true;
          await this.client.setDaemonRunning('memory', !running);
        } else {
          const running = this.snapshot && this.snapshot.daemons && this.snapshot.daemons.workflowRunning === true;
          await this.client.setDaemonRunning('workflow', !running);
        }
        await this.refreshSnapshot();
      } catch (error) {
        this.showToast(error.message || `Failed to toggle ${kind} daemon`, 'error');
      }
    }
  }

  if (global.LocalAgentCompanionVoice && global.LocalAgentCompanionVoice.methods) {
    Object.assign(CompanionApp.prototype, global.LocalAgentCompanionVoice.methods);
  }
  if (global.LocalAgentCompanionVoiceInput && global.LocalAgentCompanionVoiceInput.methods) {
    Object.assign(CompanionApp.prototype, global.LocalAgentCompanionVoiceInput.methods);
  }

  global.addEventListener('DOMContentLoaded', () => {
    global.localAgentCompanionApp = new CompanionApp();
  });
})(window);
