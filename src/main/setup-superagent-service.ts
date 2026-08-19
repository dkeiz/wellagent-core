// @ts-nocheck
const {
  getProviderConnectionConfig
} = require('./llm-config');
const { getEffectiveLlmSelection } = require('./llm-state');
const { resolveEasyConnectHost } = require('./companion-network-utils');
const { configureCompanionServer, attachCompanionRelays } = require('./companion/companion-backend-dispatch');
const CompanionApiServer = require('./companion/companion-api-server');
const CompanionAuth = require('./companion-auth');
const { RemoteGatewayManager } = require('./companion/remote-gateway-manager');
const { quickSetupPlugin } = require('./plugin-setup-service');

const DISMISSED_ACTIONS_KEY = 'setupSuperagent.dismissedActions';
const CURATED_PLUGIN_IDS = ['searxng-search', 'http-tts-bridge'];

const SETUP_PRESETS = {
  chat_only: {
    label: 'Chat Only',
    icon: '💬',
    description: 'Just chat, no tools. Lightweight and private.',
    mainEnabled: true,
    groups: { web: false, files: 'off', terminal: 'off', unsafe: false, ports: false, memory: false },
    companion: false,
    plugins: []
  },
  research: {
    label: 'Research',
    icon: '🔍',
    description: 'Web research + file notes. Great for learning and collecting information.',
    mainEnabled: true,
    groups: { web: true, files: 'read', terminal: 'off', unsafe: false, ports: false, memory: true },
    companion: false,
    plugins: ['searxng-search']
  },
  developer: {
    label: 'Developer',
    icon: '💻',
    description: 'Code, terminal, files. Full development workflow.',
    mainEnabled: true,
    groups: { web: true, files: 'full', terminal: 'workspace', unsafe: false, ports: false, memory: true },
    companion: false,
    plugins: ['searxng-search']
  },
  power_user: {
    label: 'Power User',
    icon: '⚡',
    description: 'Everything on. Full capability suite with companion.',
    mainEnabled: true,
    groups: { web: true, files: 'full', terminal: 'system', unsafe: false, ports: true, memory: true },
    companion: true,
    plugins: ['searxng-search']
  }
};

function parseJsonObject(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

function parseJsonArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function normalizeBool(value) {
  return value === true || value === 1 || String(value || '').toLowerCase() === 'true';
}

function buildCheck(id, title, status, detail, extra = {}) {
  return { id, title, status, detail, ...extra };
}

function countEnabledPlugins(curatedPlugins = []) {
  return curatedPlugins.filter((plugin) => plugin && plugin.enabled === true).length;
}

class SetupSuperagentService {
  constructor(container, options = {}) {
    this.container = container;
    this.db = options.db || container.get('db');
    this.sessionInitManager = options.sessionInitManager || container.optional('sessionInitManager');
    this.capabilityManager = options.capabilityManager || container.optional('capabilityManager');
    this.windowManager = options.windowManager || container.optional('windowManager');
    this.eventBus = options.eventBus || container.optional('eventBus');
  }

  _getScopeOptions(options = {}) {
    return options && typeof options === 'object' ? options : {};
  }

  async _getScopedSetting(baseKey, options = {}) {
    const scopeOptions = this._getScopeOptions(options);
    if (this.sessionInitManager?.getScopedSetting) {
      return this.sessionInitManager.getScopedSetting(baseKey, scopeOptions);
    }
    if (this.db?.getScopedSetting && (scopeOptions.requestContext || scopeOptions.userId)) {
      return this.db.getScopedSetting(baseKey, scopeOptions);
    }
    return this.db.getSetting(baseKey);
  }

  async _saveScopedSetting(baseKey, value, options = {}) {
    const scopeOptions = this._getScopeOptions(options);
    if (this.sessionInitManager?.saveScopedSetting) {
      return this.sessionInitManager.saveScopedSetting(baseKey, value, scopeOptions);
    }
    if (this.db?.saveScopedSetting && (scopeOptions.requestContext || scopeOptions.userId)) {
      return this.db.saveScopedSetting(baseKey, value, scopeOptions);
    }
    return this.db.saveSetting(baseKey, value);
  }

  async _getLlmSelection(options = {}) {
    return getEffectiveLlmSelection(this.db, this._getScopeOptions(options));
  }

  async getAssessment(options = {}) {
    const scopeOptions = this._getScopeOptions(options);
    const maxRecommendations = Math.max(1, Math.min(2, Number(options.maxRecommendations) || 2));
    const dismissed = options.includeDismissed === true ? [] : await this.getDismissedActionIds(scopeOptions);
    const state = await this.readCurrentState(scopeOptions);
    const llmConfigured = state.llm.configured === true;
    const baseinitCompleted = state.baseinit.completed === true;
    const mainEnabled = state.capabilities.mainEnabled === true;
    const looksUsed = this.looksLikeExistingUser(state);

    const checks = [
      buildCheck(
        'baseinit',
        'Base Setup',
        baseinitCompleted ? 'ready' : 'needs_action',
        baseinitCompleted
          ? `Completed ${state.baseinit.timestamp ? `at ${state.baseinit.timestamp}` : 'previously'}.`
          : 'Initial setup has not been completed yet.'
      ),
      buildCheck(
        'llm',
        'LLM Provider',
        llmConfigured ? 'ready' : 'manual',
        llmConfigured
          ? `${state.llm.provider} / ${state.llm.model}`
          : 'Provider or model is not configured yet.'
      ),
      buildCheck(
        'capabilities',
        'Capabilities',
        mainEnabled ? 'ready' : 'needs_action',
        mainEnabled
          ? `Main switch is on. Enabled groups: ${state.capabilities.enabledGroups.join(', ') || 'none'}.`
          : 'Main capability switch is off, so tools are unavailable.'
      ),
      buildCheck(
        'companion',
        'Companion',
        state.companion.running ? 'ready' : (state.companion.enabled ? 'partial' : 'needs_action'),
        state.companion.running
          ? `${state.companion.host}:${state.companion.port} is live.`
          : (state.companion.enabled
            ? 'Companion is enabled in settings but not currently running.'
            : 'Companion is disabled.')
      ),
      buildCheck(
        'plugins',
        'Curated Plugins',
        state.curatedPlugins.some((plugin) => plugin.enabled) ? 'ready' : 'optional',
        state.curatedPlugins.map((plugin) => `${plugin.name}: ${plugin.enabled ? 'enabled' : 'disabled'}`).join(' | ')
      )
    ];

    const recommendedActions = [];
    const manualActions = [];

    const pushRecommended = (action) => {
      if (!action) return;
      if (dismissed.includes(action.id)) return;
      if (recommendedActions.some((entry) => entry.id === action.id)) return;
      recommendedActions.push(action);
    };

    const pushManual = (action) => {
      if (!action) return;
      if (manualActions.some((entry) => entry.id === action.id)) return;
      manualActions.push(action);
    };

    if (!baseinitCompleted) {
      pushRecommended(this.buildAction('run_baseinit'));
    }

    if (!llmConfigured) {
      pushManual(this.buildAction('configure_llm'));
    }

    if (llmConfigured && !mainEnabled) {
      pushRecommended(this.buildAction('enable_capability_main'));
    }

    if (llmConfigured && !state.companion.enabled && baseinitCompleted) {
      pushRecommended(this.buildAction('enable_companion'));
    }

    const searxngPlugin = state.curatedPlugins.find((plugin) => plugin.id === 'searxng-search');
    const webGroupEnabled = state.capabilities.enabledGroups.includes('web');
    if (llmConfigured && baseinitCompleted && !searxngPlugin?.enabled && webGroupEnabled) {
      pushRecommended(this.buildAction('quick_setup_searxng'));
    }

    if (state.capabilities.enabledGroups.includes('web') === false && llmConfigured) {
      pushRecommended(this.buildAction('enable_web_capability'));
    }

    const actionableCount = recommendedActions.length + manualActions.length;
    const userProfile = looksUsed ? 'returning' : 'fresh';
    let setupStage = 'ready';
    if (!baseinitCompleted && llmConfigured) {
      setupStage = 'init_missing';
    } else if (!llmConfigured) {
      setupStage = 'configuration_missing';
    } else if (actionableCount > 0) {
      setupStage = 'tuning_available';
    }

    let userMode = 'advanced';
    if (setupStage === 'configuration_missing' && userProfile === 'fresh') {
      userMode = 'new';
    } else if (setupStage !== 'ready') {
      userMode = 'partial';
    }

    return {
      generatedAt: new Date().toISOString(),
      userMode,
      userProfile,
      setupStage,
      summary: this.buildSummary({
        userMode,
        userProfile,
        setupStage,
        state,
        recommendedActions,
        manualActions
      }),
      checks,
      recommendedActions: recommendedActions.slice(0, maxRecommendations),
      manualActions,
      dismissedActionIds: dismissed,
      state
    };
  }

  looksLikeExistingUser(state) {
    const llmConfigured = state.llm?.configured === true;
    const mainEnabled = state.capabilities?.mainEnabled === true;
    const enabledGroups = Array.isArray(state.capabilities?.enabledGroups)
      ? state.capabilities.enabledGroups.length
      : 0;
    const companionRunning = state.companion?.running === true;
    const companionEnabled = state.companion?.enabled === true;
    const enabledCuratedPlugins = countEnabledPlugins(state.curatedPlugins || []);
    return llmConfigured || mainEnabled || enabledGroups > 0 || companionRunning || companionEnabled || enabledCuratedPlugins > 0;
  }

  buildSummary({ userMode, userProfile, setupStage, state, recommendedActions, manualActions }) {
    if (setupStage === 'configuration_missing') {
      if (userProfile === 'fresh') {
        return 'This looks like a fresh setup. Configure an LLM provider first, then finish the remaining setup steps.';
      }
      return 'This looks like an existing install with missing core model configuration. Restore the LLM provider first.';
    }
    if (setupStage === 'init_missing') {
      return 'This looks like an existing setup, but BaseInit was never completed or never recorded. Run it once to normalize the environment.';
    }
    if (userMode === 'new') {
      return 'This setup is still in onboarding. Complete the first core setup steps before optional enhancements.';
    }
    if (recommendedActions.length > 0) {
      return `This setup is usable. Recommended next change: ${recommendedActions[0].title}.`;
    }
    if (manualActions.length > 0) {
      return `This setup is mostly ready. Remaining manual step: ${manualActions[0].title}.`;
    }
    return 'This setup looks advanced and ready. No immediate core setup changes are required.';
  }

  async readCurrentState(options = {}) {
    const scopeOptions = this._getScopeOptions(options);
    const [
      baseinitCompleted,
      baseinitTimestamp,
      selection,
      sessionInit,
      capabilityState,
      toolStates,
      companionStatus,
      curatedPlugins,
      appliedPreset
    ] = await Promise.all([
      this.sessionInitManager?.getBaseInitState
        ? this.sessionInitManager.getBaseInitState(scopeOptions).then((state) => state.completed ? 'true' : 'false').catch(() => this._getScopedSetting('baseinit.completed', scopeOptions))
        : this._getScopedSetting('baseinit.completed', scopeOptions),
      this.sessionInitManager?.getBaseInitState
        ? this.sessionInitManager.getBaseInitState(scopeOptions).then((state) => state.timestamp || '').catch(() => this._getScopedSetting('baseinit.timestamp', scopeOptions))
        : this._getScopedSetting('baseinit.timestamp', scopeOptions),
      this._getLlmSelection(scopeOptions),
      this.sessionInitManager?.detectStartType
        ? this.sessionInitManager.detectStartType(this.container.optional('memoryDaemon')?.running === true, scopeOptions).catch(() => null)
        : null,
      Promise.resolve(this.capabilityManager?.getState ? this.capabilityManager.getState() : null),
      typeof this.db.getToolStates === 'function' ? this.db.getToolStates(scopeOptions).catch(() => ({})) : {},
      this.getCompanionStatus(scopeOptions),
      this.getCuratedPluginState(scopeOptions),
      this._getScopedSetting('setupSuperagent.appliedPreset', scopeOptions).catch(() => '')
    ]);

    const normalizedProvider = String(selection?.provider || '').trim();
    const normalizedModel = String(selection?.model || '').trim();
    const connection = normalizedProvider
      ? await getProviderConnectionConfig(this.db, normalizedProvider, scopeOptions).catch(() => ({}))
      : {};

    const enabledGroups = [];
    for (const [groupId, value] of Object.entries(capabilityState?.groups || {})) {
      if (typeof value === 'boolean' ? value : String(value || '') !== 'off') {
        enabledGroups.push(groupId);
      }
    }

    const groupsConfig = this.capabilityManager?.getGroupsConfig
      ? this.capabilityManager.getGroupsConfig()
      : [];

    return {
      baseinit: {
        completed: normalizeBool(baseinitCompleted),
        timestamp: baseinitTimestamp || '',
        coldStart: sessionInit || null
      },
      llm: {
        configured: Boolean(normalizedProvider && normalizedModel),
        provider: normalizedProvider || '',
        model: normalizedModel || '',
        connectionConfigured: Object.keys(connection || {}).length > 0,
        connection
      },
      capabilities: {
        mainEnabled: capabilityState?.mainEnabled === true,
        enabledGroups,
        groupsConfig,
        activeToolCount: Number(capabilityState?.activeToolCount || 0),
        toolStates: toolStates || {}
      },
      companion: companionStatus,
      curatedPlugins,
      presets: SETUP_PRESETS,
      appliedPreset: String(appliedPreset || '').trim() || null
    };
  }

  async getCuratedPluginState(options = {}) {
    const pluginManager = this.container.optional('pluginManager');
    if (!pluginManager?.listPlugins) {
      return CURATED_PLUGIN_IDS.map((id) => ({
        id,
        name: id,
        enabled: false,
        status: 'unavailable',
        config: {}
      }));
    }

    const plugins = pluginManager.listPlugins();
    return Promise.all(CURATED_PLUGIN_IDS.map(async (pluginId) => {
      const plugin = plugins.find((entry) => entry.id === pluginId);
      return {
        id: pluginId,
        name: plugin?.name || pluginId,
        enabled: plugin?.status === 'enabled',
        status: plugin?.status || 'disabled',
        visibleInSidebar: plugin?.visibleInSidebar !== false,
        config: pluginManager.getPluginConfig ? await pluginManager.getPluginConfig(pluginId, this._getScopeOptions(options)) : {}
      };
    }));
  }

  async getCompanionStatus(options = {}) {
    const scopeOptions = this._getScopeOptions(options);
    const enabled = normalizeBool(await this._getScopedSetting('companion.enabled', scopeOptions));
    const host = String(await this._getScopedSetting('companion.host', scopeOptions) || '0.0.0.0');
    const port = Number(await this._getScopedSetting('companion.port', scopeOptions)) || 8790;
    const devices = parseJsonArray(await this._getScopedSetting('companion.devices', scopeOptions));
    const companionServer = this.container.optional('companionServer');
    return {
      enabled,
      running: enabled && Boolean(companionServer?.server),
      host,
      port,
      pairedDevices: devices.length,
      connectedDevices: enabled ? Number(companionServer?._wsClients?.size || 0) + Number(companionServer?._remoteWsClients?.size || 0) : 0
    };
  }

  buildAction(id) {
    const catalog = {
      run_baseinit: {
        id,
        kind: 'safe',
        title: 'Run BaseInit',
        description: 'Initialize the base runtime checks and enable background services.',
        action: 'run_baseinit',
        params: {}
      },
      configure_llm: {
        id,
        kind: 'manual',
        title: 'Configure LLM Provider',
        description: 'Open the API settings and provide the provider/model details manually.',
        action: 'configure_llm',
        params: {}
      },
      enable_capability_main: {
        id,
        kind: 'safe',
        title: 'Enable Main Capabilities',
        description: 'Turn on the main capability switch so tools are available.',
        action: 'set_capability_main',
        params: { enabled: true }
      },
      enable_web_capability: {
        id,
        kind: 'safe',
        title: 'Enable Web Capability',
        description: 'Turn on the web capability group for search and fetch tools.',
        action: 'set_capability_group',
        params: { groupId: 'web', enabled: true }
      },
      enable_companion: {
        id,
        kind: 'safe',
        title: 'Enable Companion',
        description: 'Start the companion server with the saved or default host and port.',
        action: 'enable_companion',
        params: {}
      },
      quick_setup_searxng: {
        id,
        kind: 'safe',
        title: 'Quick Setup SearXNG',
        description: 'Enable the bundled SearXNG plugin for lightweight web search support.',
        action: 'plugin_quick_setup',
        params: { pluginName: 'searxng' }
      }
    };
    return catalog[id] ? { ...catalog[id] } : null;
  }

  async runAction(input = {}, options = {}) {
    const scopeOptions = this._getScopeOptions(options);
    const action = String(input.action || '').trim();
    const params = input.params && typeof input.params === 'object' ? input.params : {};
    if (!action) {
      throw new Error('Setup action is required');
    }

    let result;
    switch (action) {
      case 'run_baseinit':
        result = await this.runBaseInit(scopeOptions);
        break;
      case 'set_capability_main':
        result = await this.setCapabilityMain(params.enabled);
        break;
      case 'set_capability_group':
        result = await this.setCapabilityGroup(params.groupId, params.enabled);
        break;
      case 'set_files_mode':
        result = await this.setFilesMode(params.mode);
        break;
      case 'set_terminal_mode':
        result = await this.setTerminalMode(params.mode);
        break;
      case 'set_tool_active':
        result = await this.setToolActive(params.toolName, params.active, scopeOptions);
        break;
      case 'plugin_enable':
        result = await this.enablePlugin(params.pluginId, scopeOptions);
        break;
      case 'plugin_quick_setup':
        result = await this.quickSetupPlugin(params.pluginName, scopeOptions);
        break;
      case 'plugin_set_config':
        result = await this.setPluginConfig(params.pluginId, params.key, params.value, scopeOptions);
        break;
      case 'enable_companion':
        result = await this.enableCompanion(params, scopeOptions);
        break;
      case 'apply_preset':
        result = await this.applyPreset(params.preset || params.presetName, scopeOptions);
        break;
      case 'dismiss_action':
        result = await this.dismissAction(String(params.actionId || input.actionId || '').trim(), scopeOptions);
        break;
      case 'configure_llm':
        result = {
          success: false,
          manual: true,
          error: 'LLM configuration requires manual input in the provider settings UI.'
        };
        break;
      default:
        throw new Error(`Unsupported setup action "${action}"`);
    }

    return {
      success: result?.success !== false,
      action,
      result,
      assessment: await this.getAssessment(scopeOptions)
    };
  }

  async dismissAction(actionId, options = {}) {
    const normalized = String(actionId || '').trim();
    if (!normalized) return { success: false, error: 'actionId is required' };
    const current = await this.getDismissedActionIds(options);
    if (!current.includes(normalized)) {
      current.push(normalized);
      await this._saveScopedSetting(DISMISSED_ACTIONS_KEY, JSON.stringify(current), options);
    }
    return { success: true, actionId: normalized };
  }

  async getDismissedActionIds(options = {}) {
    const raw = await this._getScopedSetting(DISMISSED_ACTIONS_KEY, options);
    return parseJsonArray(raw).map((value) => String(value || '').trim()).filter(Boolean);
  }

  async runBaseInit(options = {}) {
    const scopeOptions = this._getScopeOptions(options);
    const baseInitState = this.sessionInitManager?.getBaseInitState
      ? await this.sessionInitManager.getBaseInitState(scopeOptions).catch(() => null)
      : null;
    const completed = baseInitState ? baseInitState.completed === true : normalizeBool(await this._getScopedSetting('baseinit.completed', scopeOptions));
    if (completed) {
      return { success: true, alreadyCompleted: true };
    }
    const report = await this.sessionInitManager?.buildBaseInitReport?.(scopeOptions);
    const memoryDaemon = this.container.optional('memoryDaemon');
    const workflowScheduler = this.container.optional('workflowScheduler');
    if (memoryDaemon && !memoryDaemon.running) await memoryDaemon.start();
    if (workflowScheduler && !workflowScheduler.running) await workflowScheduler.start();
    if (this.sessionInitManager?.markBaseInitComplete) {
      await this.sessionInitManager.markBaseInitComplete(scopeOptions);
    } else {
      await this._saveScopedSetting('baseinit.completed', 'true', scopeOptions);
      await this._saveScopedSetting('baseinit.timestamp', new Date().toISOString(), scopeOptions);
      await this._saveScopedSetting('baseinit.daemonEnabled', 'true', scopeOptions);
    }
    this.eventBus?.publish?.('init:baseinit-complete', { report });
    return { success: true, report: report || null };
  }

  async setCapabilityMain(enabled) {
    if (!this.capabilityManager?.setMainEnabled) {
      return { success: false, error: 'Capability manager unavailable' };
    }
    const value = this.capabilityManager.setMainEnabled(enabled === true);
    this.windowManager?.send?.('capability-update', this.capabilityManager.getState());
    return { success: true, mainEnabled: value };
  }

  async setCapabilityGroup(groupId, enabled) {
    const normalized = String(groupId || '').trim();
    if (!normalized) return { success: false, error: 'groupId is required' };
    if (!this.capabilityManager?.setGroupEnabled) {
      return { success: false, error: 'Capability manager unavailable' };
    }
    const value = this.capabilityManager.setGroupEnabled(normalized, enabled === true);
    this.windowManager?.send?.('capability-update', this.capabilityManager.getState());
    return { success: value === true, groupId: normalized, enabled: enabled === true };
  }

  async setToolActive(toolName, active, options = {}) {
    const normalized = String(toolName || '').trim();
    if (!normalized) return { success: false, error: 'toolName is required' };
    if (typeof this.db.setToolActive !== 'function') {
      return { success: false, error: 'Tool state storage is unavailable' };
    }
    await this.db.setToolActive(normalized, active === true, this._getScopeOptions(options));
    const mcpServer = this.container.optional('mcpServer');
    if (mcpServer?.setToolActiveState) {
      await mcpServer.setToolActiveState(normalized, active === true);
    }
    if (active === true && this.capabilityManager?.getGroupForTool) {
      const groupId = this.capabilityManager.getGroupForTool(normalized);
      if (groupId && !this.capabilityManager.isGroupEnabled(groupId)) {
        this.capabilityManager.setGroupEnabled(groupId, true);
      }
      this.windowManager?.send?.('capability-update', this.capabilityManager.getState());
    }
    return { success: true, toolName: normalized, active: active === true };
  }

  async setFilesMode(mode) {
    const normalized = String(mode || '').trim();
    if (!['off', 'read', 'full'].includes(normalized)) {
      return { success: false, error: 'Invalid files mode. Use: off, read, full' };
    }
    if (!this.capabilityManager?.setFilesMode) {
      return { success: false, error: 'Capability manager unavailable' };
    }
    const value = this.capabilityManager.setFilesMode(normalized);
    this.windowManager?.send?.('capability-update', this.capabilityManager.getState());
    return { success: true, mode: value };
  }

  async setTerminalMode(mode) {
    const normalized = String(mode || '').trim();
    if (!['off', 'workspace', 'system'].includes(normalized)) {
      return { success: false, error: 'Invalid terminal mode. Use: off, workspace, system' };
    }
    if (!this.capabilityManager?.setTerminalMode) {
      return { success: false, error: 'Capability manager unavailable' };
    }
    const value = this.capabilityManager.setTerminalMode(normalized);
    this.windowManager?.send?.('capability-update', this.capabilityManager.getState());
    return { success: true, mode: value };
  }

  async applyPreset(presetName, options = {}) {
    const normalized = String(presetName || '').trim().toLowerCase();
    const preset = SETUP_PRESETS[normalized];
    if (!preset) {
      const available = Object.keys(SETUP_PRESETS).join(', ');
      return { success: false, error: `Unknown preset "${normalized}". Available: ${available}` };
    }

    const applied = [];

    // 1. Main switch
    if (this.capabilityManager?.setMainEnabled) {
      this.capabilityManager.setMainEnabled(preset.mainEnabled);
      applied.push('mainEnabled');
    }

    // 2. Capability groups
    for (const [groupId, value] of Object.entries(preset.groups || {})) {
      if (groupId === 'files' && this.capabilityManager?.setFilesMode) {
        this.capabilityManager.setFilesMode(value);
        applied.push(`files:${value}`);
      } else if (groupId === 'terminal' && this.capabilityManager?.setTerminalMode) {
        this.capabilityManager.setTerminalMode(value);
        applied.push(`terminal:${value}`);
      } else if (this.capabilityManager?.setGroupEnabled) {
        this.capabilityManager.setGroupEnabled(groupId, value === true);
        applied.push(`${groupId}:${value}`);
      }
    }

    // 3. Companion
    if (preset.companion === true) {
      const companionResult = await this.enableCompanion({}, options);
      if (companionResult.success) applied.push('companion');
    }

    // 4. Plugins
    for (const pluginName of (preset.plugins || [])) {
      try {
        await this.quickSetupPlugin(pluginName, options);
        applied.push(`plugin:${pluginName}`);
      } catch (_) {
        // Plugin setup is best-effort
      }
    }

    this.windowManager?.send?.('capability-update', this.capabilityManager?.getState?.());
    await this._saveScopedSetting('setupSuperagent.appliedPreset', normalized, options);

    return {
      success: true,
      preset: normalized,
      label: preset.label,
      applied
    };
  }

  async quickToggle(target, options = {}) {
    const normalized = String(target || '').trim().toLowerCase();
    if (!normalized) return { success: false, error: 'target is required' };

    // Main switch
    if (normalized === 'main' || normalized === 'capabilities') {
      const current = this.capabilityManager?.isMainEnabled?.() === true;
      return this.setCapabilityMain(!current);
    }

    // Companion
    if (normalized === 'companion') {
      const status = await this.getCompanionStatus(options);
      if (status.running) {
        return { success: true, note: 'Companion is already running. Stopping requires manual action.' };
      }
      return this.enableCompanion({}, options);
    }

    // Curated plugins
    if (normalized.startsWith('plugin:')) {
      const pluginName = normalized.slice(7);
      return this.quickSetupPlugin(pluginName, options);
    }

    // Capability groups
    if (this.capabilityManager?.isGroupEnabled) {
      const current = this.capabilityManager.isGroupEnabled(normalized);
      return this.setCapabilityGroup(normalized, !current);
    }

    return { success: false, error: `Unknown toggle target "${normalized}"` };
  }

  async quickCheck(target, options = {}) {
    const normalized = String(target || '').trim().toLowerCase();
    if (!normalized || normalized === 'all') {
      return { success: true, result: await this.readCurrentState(options) };
    }
    if (normalized === 'companion') {
      return { success: true, result: await this.getCompanionStatus(options) };
    }
    if (normalized === 'llm' || normalized === 'provider') {
      const selection = await this._getLlmSelection(options);
      const provider = String(selection?.provider || '').trim();
      const model = String(selection?.model || '').trim();
      return { success: true, result: { configured: Boolean(provider && model), provider, model } };
    }
    if (normalized === 'capabilities' || normalized === 'tools') {
      const state = this.capabilityManager?.getState?.() || {};
      return { success: true, result: state };
    }
    if (normalized === 'plugins') {
      return { success: true, result: await this.getCuratedPluginState() };
    }
    return { success: false, error: `Unknown check target "${normalized}"` };
  }

  async enablePlugin(pluginId, options = {}) {
    const normalized = String(pluginId || '').trim();
    const pluginManager = this.container.optional('pluginManager');
    if (!normalized) return { success: false, error: 'pluginId is required' };
    if (!pluginManager?.enablePlugin) return { success: false, error: 'Plugin manager unavailable' };
    await pluginManager.enablePlugin(normalized, { ...this._getScopeOptions(options), persistStatus: true });
    this.windowManager?.send?.('plugins:state-changed', {
      pluginId: normalized,
      source: 'setup-superagent',
      at: new Date().toISOString()
    });
    return { success: true, pluginId: normalized };
  }

  async quickSetupPlugin(pluginName, options = {}) {
    const normalized = String(pluginName || '').trim();
    const pluginManager = this.container.optional('pluginManager');
    const runtimePaths = this.container.optional('runtimePaths');
    if (!normalized) return { success: false, error: 'pluginName is required' };
    if (!pluginManager || !runtimePaths?.pluginsDir) {
      return { success: false, error: 'Plugin system not ready' };
    }
    const result = await quickSetupPlugin({
      pluginName: normalized,
      pluginManager,
      pluginsDir: runtimePaths.pluginsDir,
      scopeOptions: this._getScopeOptions(options)
    });
    this.windowManager?.send?.('plugins:state-changed', {
      pluginId: result.pluginId,
      source: 'setup-superagent',
      at: new Date().toISOString()
    });
    return { success: true, ...result };
  }

  async setPluginConfig(pluginId, key, value, options = {}) {
    const pluginManager = this.container.optional('pluginManager');
    if (!pluginManager?.setPluginConfig) return { success: false, error: 'Plugin manager unavailable' };
    await pluginManager.setPluginConfig(String(pluginId || '').trim(), String(key || '').trim(), value, this._getScopeOptions(options));
    this.windowManager?.send?.('plugins:state-changed', {
      pluginId: String(pluginId || '').trim(),
      source: 'setup-superagent',
      at: new Date().toISOString()
    });
    return { success: true, pluginId, key, value };
  }

  getCompanionAuth() {
    const existing = this.container.optional('companionAuth');
    if (existing) return existing;
    const auth = new CompanionAuth(this.db, { userRegistry: this.container.optional('userRegistry') || null });
    this.container.replace('companionAuth', auth);
    return auth;
  }

  getRemoteGatewayManager() {
    let manager = this.container.optional('remoteGatewayManager');
    if (manager) return manager;
    manager = new RemoteGatewayManager({
      db: this.db,
      getCompanionServer: () => this.container.optional('companionServer')
    });
    this.container.replace('remoteGatewayManager', manager);
    return manager;
  }

  async enableCompanion(params = {}, options = {}) {
    const scopeOptions = this._getScopeOptions(options);
    const host = resolveEasyConnectHost(params.host || await this._getScopedSetting('companion.host', scopeOptions) || '0.0.0.0');
    const port = Number(params.port || await this._getScopedSetting('companion.port', scopeOptions)) || 8790;
    const existing = this.container.optional('companionServer');
    if (existing?.server) {
      return { success: true, alreadyRunning: true, status: await this.getCompanionStatus(scopeOptions) };
    }

    const companionServer = new CompanionApiServer({
      host,
      port,
      tlsManager: this.container.optional('companionTlsManager')
    });
    companionServer.setRemoteGatewayManager(this.getRemoteGatewayManager());
    configureCompanionServer({
      companionServer,
      container: this.container,
      db: this.db,
      companionAuth: this.getCompanionAuth()
    });
    attachCompanionRelays({
      companionServer,
      eventBus: this.eventBus,
      windowManager: this.windowManager,
      getCompanionServer: () => this.container.optional('companionServer')
    });

    await companionServer.start();
    this.container.replace('companionServer', companionServer);
    await this._saveScopedSetting('companion.host', host, scopeOptions);
    await this._saveScopedSetting('companion.port', String(port), scopeOptions);
    await this._saveScopedSetting('companion.enabled', 'true', scopeOptions);
    return {
      success: true,
      status: await this.getCompanionStatus(scopeOptions)
    };
  }
}

module.exports = { SetupSuperagentService, parseJsonObject };












