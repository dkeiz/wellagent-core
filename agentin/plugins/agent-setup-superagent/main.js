function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function badgeClass(status) {
  return String(status || 'unknown').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
}

function profileLabel(profile) {
  return profile === 'fresh' ? 'Fresh Install' : 'Existing User';
}

function stageLabel(stage) {
  if (stage === 'configuration_missing') return 'Needs Core Config';
  if (stage === 'init_missing') return 'Needs Init';
  if (stage === 'tuning_available') return 'Tuning Available';
  return 'Ready';
}

function buildWizardModel(assessment, focusStepId = '') {
  const state = assessment?.state || {};
  const capabilities = state.capabilities || {};
  const curatedPlugins = Array.isArray(state.curatedPlugins) ? state.curatedPlugins : [];
  const searxng = curatedPlugins.find((plugin) => plugin.id === 'searxng-search') || null;
  const llmConfigured = state.llm?.configured === true;
  const baseinitCompleted = state.baseinit?.completed === true;
  const mainEnabled = capabilities.mainEnabled === true;
  const webEnabled = Array.isArray(capabilities.enabledGroups) && capabilities.enabledGroups.includes('web');
  const companionEnabled = state.companion?.enabled === true;

  const steps = [
    {
      id: 'provider',
      title: 'Connect A Model',
      caption: 'Required',
      status: llmConfigured ? 'ready' : 'current',
      description: llmConfigured
        ? `Using ${state.llm.provider} / ${state.llm.model}.`
        : 'Choose a provider, enter credentials if needed, and pick the model this workspace should use.',
      primaryAction: llmConfigured
        ? null
        : {
          label: 'Open Model Setup',
          actionName: 'open-workspace-tab',
          payload: { tab: 'api' }
        },
      secondaryAction: llmConfigured
        ? null
        : {
          label: 'Why Manual?',
          actionName: 'show-manual-step',
          payload: {
            title: 'Configure LLM Provider',
            description: 'Provider setup may require API keys or login, so the wizard opens the API tab instead of guessing credentials.'
          }
        }
    },
    {
      id: 'baseinit',
      title: 'Run BaseInit',
      caption: 'Required',
      status: !llmConfigured ? 'blocked' : (baseinitCompleted ? 'ready' : 'current'),
      description: baseinitCompleted
        ? 'Base runtime checks and background services are initialized.'
        : (llmConfigured
          ? 'Normalize the environment once. This is the first safe setup action the agent can run for you.'
          : 'Model setup comes first. After that, run BaseInit to finalize the local runtime.')
    },
    {
      id: 'capabilities',
      title: 'Enable Tools',
      caption: 'Required',
      status: !llmConfigured ? 'blocked' : (mainEnabled ? 'ready' : 'current'),
      description: mainEnabled
        ? `Main capability switch is on${Array.isArray(capabilities.enabledGroups) && capabilities.enabledGroups.length ? ` with ${capabilities.enabledGroups.join(', ')}` : ''}.`
        : 'Turn on the main capability switch so web, files, terminal, and other tools are actually usable.'
    },
    {
      id: 'companion',
      title: 'Bring Companion Online',
      caption: 'Recommended',
      status: (!llmConfigured || !baseinitCompleted) ? 'blocked' : (state.companion?.running ? 'ready' : (companionEnabled ? 'current' : 'current')),
      description: state.companion?.running
        ? `${state.companion.host}:${state.companion.port} is live.`
        : 'Enable or refresh the local companion service once core setup is stable.'
    },
    {
      id: 'searxng',
      title: 'Web Search Plugin',
      caption: 'Optional',
      status: (!llmConfigured || !baseinitCompleted || !webEnabled)
        ? 'blocked'
        : (searxng?.enabled ? 'ready' : 'current'),
      description: searxng?.enabled
        ? 'SearXNG quick setup is already enabled.'
        : 'Enable the curated SearXNG plugin for a lightweight search path when web tools are on.'
    }
  ];

  const setPrimaryAction = (stepId, primaryAction, secondaryAction = null) => {
    const step = steps.find((entry) => entry.id === stepId);
    if (!step) return;
    step.primaryAction = primaryAction;
    step.secondaryAction = secondaryAction;
  };

  setPrimaryAction('baseinit',
    !llmConfigured ? {
      label: 'Go To Model Setup',
      actionName: 'open-workspace-tab',
      payload: { tab: 'api' }
    } : (baseinitCompleted ? null : {
      label: 'Run BaseInit Now',
      actionName: 'run-setup-action',
      payload: { setupAction: 'run_baseinit', setupParams: {} }
    })
  );

  setPrimaryAction('capabilities',
    !llmConfigured ? {
      label: 'Go To Model Setup',
      actionName: 'open-workspace-tab',
      payload: { tab: 'api' }
    } : (mainEnabled ? {
      label: 'Review Tool Access',
      actionName: 'open-workspace-tab',
      payload: { tab: 'mcp' }
    } : {
      label: 'Enable Tools Now',
      actionName: 'run-setup-action',
      payload: { setupAction: 'set_capability_main', setupParams: { enabled: true } }
    }),
    {
      label: 'Open Tool Controls',
      actionName: 'open-workspace-tab',
      payload: { tab: 'mcp' }
    }
  );

  setPrimaryAction('companion',
    (!llmConfigured || !baseinitCompleted) ? {
      label: llmConfigured ? 'Run BaseInit First' : 'Go To Model Setup',
      actionName: llmConfigured ? 'focus-step' : 'open-workspace-tab',
      payload: llmConfigured ? { stepId: 'baseinit' } : { tab: 'api' }
    } : (state.companion?.running ? {
      label: 'Open Companion Settings',
      actionName: 'open-workspace-tab',
      payload: { tab: 'settings' }
    } : {
      label: companionEnabled ? 'Start Companion Now' : 'Enable Companion',
      actionName: 'run-setup-action',
      payload: { setupAction: 'enable_companion', setupParams: {} }
    }),
    {
      label: 'Open Companion Settings',
      actionName: 'open-workspace-tab',
      payload: { tab: 'settings' }
    }
  );

  setPrimaryAction('searxng',
    (!llmConfigured || !baseinitCompleted || !webEnabled) ? {
      label: !llmConfigured ? 'Go To Model Setup' : (!baseinitCompleted ? 'Run BaseInit First' : 'Enable Web Tools'),
      actionName: !llmConfigured ? 'open-workspace-tab' : (!baseinitCompleted ? 'focus-step' : 'run-setup-action'),
      payload: !llmConfigured
        ? { tab: 'api' }
        : (!baseinitCompleted
          ? { stepId: 'baseinit' }
          : { setupAction: 'set_capability_group', setupParams: { groupId: 'web', enabled: true } })
    } : (searxng?.enabled ? {
      label: 'Open Plugin Studio',
      actionName: 'open-plugin-studio',
      payload: { pluginId: 'searxng-search' }
    } : {
      label: 'Enable SearXNG',
      actionName: 'run-setup-action',
      payload: { setupAction: 'plugin_quick_setup', setupParams: { pluginName: 'searxng' } }
    }),
    {
      label: 'Open Plugin Studio',
      actionName: 'open-plugin-studio',
      payload: { pluginId: 'searxng-search' }
    }
  );

  const currentStep = steps.find((step) => step.id === focusStepId)
    || steps.find((step) => step.status === 'current')
    || steps.find((step) => step.status !== 'ready')
    || steps[steps.length - 1];
  const upcomingSteps = steps.filter((step) => step.id !== currentStep?.id && step.status !== 'ready').slice(0, 2);
  const completedCount = steps.filter((step) => step.status === 'ready').length;

  return {
    steps,
    currentStep,
    upcomingSteps,
    completedCount,
    totalSteps: steps.length
  };
}

function renderActionButton(label, actionName, payload = {}, extraClass = '') {
  return `<button type="button"
    class="${extraClass ? `${extraClass} ` : ''}setup-superagent-action-btn"
    data-agent-ui-action="${actionName}"
    data-agent-ui-payload='${escapeHtml(JSON.stringify(payload))}'>${escapeHtml(label)}</button>`;
}

function renderStepRail(steps, activeId) {
  return steps.map((step, index) => `<button type="button"
    class="setup-superagent-step${step.id === activeId ? ' active' : ''}"
    data-agent-ui-action="focus-step"
    data-agent-ui-payload='${escapeHtml(JSON.stringify({ stepId: step.id }))}'>
    <span class="setup-superagent-step-index">${index + 1}</span>
    <span class="setup-superagent-step-copy">
      <strong>${escapeHtml(step.title)}</strong>
      <small>${escapeHtml(step.caption)} · ${escapeHtml(step.status)}</small>
    </span>
  </button>`).join('');
}

function renderUpcomingSteps(steps) {
  if (!steps.length) {
    return '<div class="setup-superagent-empty">No remaining core setup steps.</div>';
  }
  return steps.map((step) => `<article class="setup-superagent-mini-card">
    <div class="setup-superagent-mini-head">
      <strong>${escapeHtml(step.title)}</strong>
      <span class="setup-superagent-badge ${badgeClass(step.status)}">${escapeHtml(step.status)}</span>
    </div>
    <p>${escapeHtml(step.description)}</p>
    ${step.primaryAction ? renderActionButton(step.primaryAction.label, step.primaryAction.actionName, step.primaryAction.payload, 'setup-superagent-secondary-btn') : ''}
  </article>`).join('');
}

function renderSetupSnapshot(assessment) {
  const state = assessment?.state || {};
  const llmText = state.llm?.configured ? `${state.llm.provider} / ${state.llm.model}` : 'Not configured';
  const companion = state.companion || {};
  const toolsEnabled = state.capabilities?.mainEnabled ? 'On' : 'Off';
  return `<div class="setup-superagent-snapshot">
    <div><span>Model</span><strong>${escapeHtml(llmText)}</strong></div>
    <div><span>Tools</span><strong>${escapeHtml(toolsEnabled)}</strong></div>
    <div><span>Companion</span><strong>${escapeHtml(companion.running ? `${companion.host}:${companion.port}` : 'Offline')}</strong></div>
  </div>`;
}

function renderPresetPicker(assessment) {
  const presets = assessment?.state?.presets || {};
  const entries = Object.entries(presets);
  if (!entries.length) return '';
  const cards = entries.map(([key, preset]) => `<button type="button"
    class="setup-superagent-preset-card"
    data-agent-ui-action="apply-preset"
    data-agent-ui-payload='${escapeHtml(JSON.stringify({ preset: key }))}'>
    <span class="setup-superagent-preset-icon">${escapeHtml(preset.icon || '📦')}</span>
    <strong>${escapeHtml(preset.label || key)}</strong>
    <span>${escapeHtml(preset.description || '')}</span>
  </button>`).join('');
  return `<section class="setup-superagent-presets">
    <div class="setup-superagent-section-head">
      <h4>Quick Start — Pick a Profile</h4>
      <span>One click to configure everything</span>
    </div>
    <div class="setup-superagent-preset-grid">${cards}</div>
  </section>`;
}

function renderToggleSwitch(groupId, label, enabled, icon = '') {
  return `<button type="button"
    class="setup-superagent-toggle${enabled ? ' on' : ''}"
    data-agent-ui-action="toggle-group"
    data-agent-ui-payload='${escapeHtml(JSON.stringify({ groupId }))}'>
    ${icon ? `<span class="setup-superagent-toggle-icon">${escapeHtml(icon)}</span>` : ''}
    <span class="setup-superagent-toggle-label">${escapeHtml(label)}</span>
    <span class="setup-superagent-toggle-track"><span class="setup-superagent-toggle-thumb"></span></span>
  </button>`;
}

function renderModeSelector(settingName, currentMode, modes, actionName) {
  const buttons = modes.map(mode => `<button type="button"
    class="setup-superagent-mode-btn${mode === currentMode ? ' active' : ''}"
    data-agent-ui-action="${actionName}"
    data-agent-ui-payload='${escapeHtml(JSON.stringify({ mode }))}'>${escapeHtml(mode)}</button>`).join('');
  return `<div class="setup-superagent-mode-group">
    <span class="setup-superagent-toggle-label">${escapeHtml(settingName)}</span>
    <div class="setup-superagent-mode-track">${buttons}</div>
  </div>`;
}

function renderQuickToggles(assessment) {
  const state = assessment?.state || {};
  const capabilities = state.capabilities || {};
  const groupsConfig = Array.isArray(capabilities.groupsConfig) ? capabilities.groupsConfig : [];
  const companion = state.companion || {};
  const curatedPlugins = Array.isArray(state.curatedPlugins) ? state.curatedPlugins : [];

  // Standard on/off groups
  const simpleGroups = groupsConfig.filter(g =>
    g.id !== 'files' && g.id !== 'terminal'
  );
  const toggles = simpleGroups.map(group =>
    renderToggleSwitch(group.id, group.name || group.id, group.enabled, group.icon || '')
  ).join('');

  // Files mode selector
  const filesGroup = groupsConfig.find(g => g.id === 'files');
  const filesMode = filesGroup?.mode || 'off';
  const filesModeSelector = renderModeSelector('Files', filesMode, ['off', 'read', 'full'], 'set-files-mode');

  // Terminal mode selector
  const terminalGroup = groupsConfig.find(g => g.id === 'terminal');
  const terminalMode = terminalGroup?.mode || 'off';
  const terminalModeSelector = renderModeSelector('Terminal', terminalMode, ['off', 'workspace', 'system'], 'set-terminal-mode');

  // Companion toggle
  const companionToggle = renderToggleSwitch('companion', 'Companion', companion.running || companion.enabled, '🌐');

  // Curated plugins
  const pluginToggles = curatedPlugins.map(plugin =>
    renderToggleSwitch(`plugin:${plugin.id}`, plugin.name || plugin.id, plugin.enabled, '🔌')
  ).join('');

  return `<section class="setup-superagent-toggles">
    <div class="setup-superagent-section-head">
      <h4>⚡ Quick Toggles</h4>
      <span>Flip settings instantly</span>
    </div>
    <div class="setup-superagent-toggle-grid">
      ${toggles}
      ${filesModeSelector}
      ${terminalModeSelector}
      ${companionToggle}
      ${pluginToggles}
    </div>
  </section>`;
}

function renderPanel(assessment, options = {}) {
  const note = options.note || '';
  const wizard = buildWizardModel(assessment, options.focusStepId || '');
  const currentStep = wizard.currentStep;
  const primaryAction = currentStep?.primaryAction || null;
  const secondaryAction = currentStep?.secondaryAction || null;
  const progressText = `${wizard.completedCount}/${wizard.totalSteps} ready`;

  return `<section class="setup-superagent-shell" aria-label="Setup Superagent">
    <div class="setup-superagent-hero">
      <div>
        <div class="setup-superagent-kicker">Guided Setup</div>
        <strong>Setup Superagent</strong>
        <p>${escapeHtml(assessment?.summary || 'No assessment available yet.')}</p>
      </div>
      <div class="setup-superagent-hero-meta">
        <span class="setup-superagent-mode">${escapeHtml(profileLabel(assessment?.userProfile || 'returning'))}</span>
        <span class="setup-superagent-mode">${escapeHtml(stageLabel(assessment?.setupStage || 'ready'))}</span>
        <button type="button" class="setup-superagent-secondary-btn" data-agent-ui-action="refresh">Refresh</button>
      </div>
    </div>
    ${renderSetupSnapshot(assessment)}
    <div class="setup-superagent-note"${note ? '' : ' hidden'}>${escapeHtml(note)}</div>
    <div class="setup-superagent-layout">
      <aside class="setup-superagent-rail">
        <div class="setup-superagent-rail-head">
          <strong>Progress</strong>
          <span>${escapeHtml(progressText)}</span>
        </div>
        <div class="setup-superagent-step-list">${renderStepRail(wizard.steps, currentStep?.id || '')}</div>
      </aside>
      <div class="setup-superagent-main">
        <section class="setup-superagent-current">
          <div class="setup-superagent-current-head">
            <div>
              <div class="setup-superagent-kicker">Current Step</div>
              <h3>${escapeHtml(currentStep?.title || 'Setup')}</h3>
            </div>
            <span class="setup-superagent-badge ${badgeClass(currentStep?.status)}">${escapeHtml(currentStep?.caption || '')}</span>
          </div>
          <p>${escapeHtml(currentStep?.description || 'No action required.')}</p>
          <div class="setup-superagent-current-actions">
            ${primaryAction ? renderActionButton(primaryAction.label, primaryAction.actionName, primaryAction.payload) : ''}
            ${secondaryAction ? renderActionButton(secondaryAction.label, secondaryAction.actionName, secondaryAction.payload, 'setup-superagent-secondary-btn') : ''}
          </div>
        </section>
        <section class="setup-superagent-next">
          <div class="setup-superagent-section-head">
            <h4>After This</h4>
            <span>The next 1-2 guided moves</span>
          </div>
          <div class="setup-superagent-mini-grid">${renderUpcomingSteps(wizard.upcomingSteps)}</div>
        </section>
        ${assessment?.state?.capabilities?.mainEnabled ? renderQuickToggles(assessment) : ''}
        ${assessment?.userMode === 'new' ? renderPresetPicker(assessment) : ''}
        <section class="setup-superagent-next">
          <div class="setup-superagent-section-head">
            <h4>Manual Surfaces</h4>
            <span>Open the right workspace when setup needs user input</span>
          </div>
          <div class="setup-superagent-manual-actions">
            ${renderActionButton('Model Settings', 'open-workspace-tab', { tab: 'api' }, 'setup-superagent-secondary-btn')}
            ${renderActionButton('Companion Settings', 'open-workspace-tab', { tab: 'settings' }, 'setup-superagent-secondary-btn')}
            ${renderActionButton('Tool Controls', 'open-workspace-tab', { tab: 'mcp' }, 'setup-superagent-secondary-btn')}
            ${renderActionButton('Plugin Studio', 'open-plugin-studio', { pluginId: 'searxng-search' }, 'setup-superagent-secondary-btn')}
          </div>
        </section>
      </div>
    </div>
  </section>`;
}

const css = `
.setup-superagent-shell {
  border: 1px solid var(--border-color);
  border-radius: 14px;
  padding: 14px;
  margin-bottom: 12px;
  background:
    radial-gradient(circle at top right, rgba(219, 185, 97, 0.15), transparent 32%),
    linear-gradient(180deg, rgba(31, 53, 84, 0.07), rgba(31, 53, 84, 0.02));
}
.setup-superagent-kicker,
.setup-superagent-note,
.setup-superagent-hero p,
.setup-superagent-snapshot span,
.setup-superagent-step-copy small,
.setup-superagent-section-head span,
.setup-superagent-mini-card p,
.setup-superagent-empty {
  color: var(--text-secondary);
  font-size: var(--text-xs);
}
.setup-superagent-hero,
.setup-superagent-hero-meta,
.setup-superagent-current-head,
.setup-superagent-current-actions,
.setup-superagent-mini-head,
.setup-superagent-manual-actions,
.setup-superagent-rail-head {
  display: flex;
  gap: 10px;
}
.setup-superagent-hero,
.setup-superagent-current-head,
.setup-superagent-mini-head,
.setup-superagent-rail-head {
  align-items: flex-start;
  justify-content: space-between;
}
.setup-superagent-hero {
  margin-bottom: 12px;
}
.setup-superagent-hero-meta,
.setup-superagent-current-actions,
.setup-superagent-manual-actions {
  align-items: center;
  flex-wrap: wrap;
}
.setup-superagent-mode,
.setup-superagent-badge {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--border-color);
  border-radius: 999px;
  padding: 4px 10px;
  background: rgba(255, 255, 255, 0.45);
  font-size: var(--text-xs);
  text-transform: capitalize;
}
.setup-superagent-badge.ready {
  background: rgba(37, 119, 62, 0.12);
}
.setup-superagent-badge.current,
.setup-superagent-badge.needs_action {
  background: rgba(180, 118, 24, 0.14);
}
.setup-superagent-badge.blocked {
  background: rgba(92, 102, 120, 0.12);
}
.setup-superagent-snapshot,
.setup-superagent-layout,
.setup-superagent-mini-grid {
  display: grid;
  gap: 12px;
}
.setup-superagent-snapshot {
  grid-template-columns: repeat(3, minmax(0, 1fr));
  margin-bottom: 10px;
}
.setup-superagent-snapshot div,
.setup-superagent-rail,
.setup-superagent-current,
.setup-superagent-next,
.setup-superagent-mini-card {
  border: 1px solid var(--border-color);
  border-radius: 10px;
  padding: 10px;
  background: var(--card-bg);
}
.setup-superagent-layout {
  grid-template-columns: minmax(220px, 280px) minmax(0, 1fr);
}
.setup-superagent-main {
  display: grid;
  gap: 12px;
}
.setup-superagent-step-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 10px;
}
.setup-superagent-step {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  padding: 9px;
  border: 1px solid var(--border-color);
  border-radius: 9px;
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
  text-align: left;
}
.setup-superagent-step.active {
  border-color: rgba(212, 152, 31, 0.55);
  background: rgba(212, 152, 31, 0.08);
}
.setup-superagent-step-index {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 999px;
  border: 1px solid var(--border-color);
  font-size: var(--text-xs);
  flex: 0 0 auto;
}
.setup-superagent-step-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.setup-superagent-current h3,
.setup-superagent-section-head h4 {
  margin: 0;
}
.setup-superagent-current p,
.setup-superagent-mini-card p {
  margin: 8px 0 0;
}
.setup-superagent-section-head {
  margin-bottom: 8px;
}
.setup-superagent-mini-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.setup-superagent-note {
  margin-bottom: 10px;
}
.setup-superagent-action-btn,
.setup-superagent-secondary-btn {
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 7px 11px;
  background: rgba(212, 152, 31, 0.12);
  color: var(--text-primary);
  cursor: pointer;
}
.setup-superagent-secondary-btn {
  background: transparent;
}
.setup-superagent-manual-actions {
  justify-content: flex-start;
}
@media (max-width: 980px) {
  .setup-superagent-layout,
  .setup-superagent-snapshot,
  .setup-superagent-mini-grid {
    grid-template-columns: 1fr;
  }
  .setup-superagent-preset-grid {
    grid-template-columns: 1fr 1fr;
  }
}
.setup-superagent-presets,
.setup-superagent-toggles {
  border: 1px solid var(--border-color);
  border-radius: 10px;
  padding: 10px;
  background: var(--card-bg);
}
.setup-superagent-preset-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  margin-top: 8px;
}
.setup-superagent-preset-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 12px 8px;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
  text-align: center;
  transition: border-color 0.15s, background 0.15s;
}
.setup-superagent-preset-card:hover {
  border-color: rgba(212, 152, 31, 0.55);
  background: rgba(212, 152, 31, 0.06);
}
.setup-superagent-preset-icon {
  font-size: 24px;
  line-height: 1;
}
.setup-superagent-preset-card strong {
  font-size: var(--text-sm);
}
.setup-superagent-preset-card span:last-child {
  font-size: var(--text-xs);
  color: var(--text-secondary);
  line-height: 1.3;
}
.setup-superagent-toggle-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  gap: 6px;
  margin-top: 8px;
}
.setup-superagent-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.setup-superagent-toggle:hover {
  border-color: rgba(212, 152, 31, 0.4);
}
.setup-superagent-toggle-icon {
  font-size: 14px;
  flex: 0 0 auto;
}
.setup-superagent-toggle-label {
  flex: 1;
  font-size: var(--text-sm);
  text-align: left;
}
.setup-superagent-toggle-track {
  width: 32px;
  height: 18px;
  border-radius: 999px;
  background: rgba(127, 127, 127, 0.25);
  position: relative;
  flex: 0 0 auto;
  transition: background 0.15s;
}
.setup-superagent-toggle.on .setup-superagent-toggle-track {
  background: rgba(37, 160, 80, 0.6);
}
.setup-superagent-toggle-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--text-primary);
  transition: left 0.15s;
}
.setup-superagent-toggle.on .setup-superagent-toggle-thumb {
  left: 16px;
}
.setup-superagent-mode-group {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
}
.setup-superagent-mode-track {
  display: inline-flex;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  overflow: hidden;
  margin-left: auto;
}
.setup-superagent-mode-btn {
  min-width: 56px;
  min-height: 22px;
  border: 0;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: var(--text-xs);
  text-transform: capitalize;
  padding: 2px 8px;
  transition: background 0.12s, color 0.12s;
}
.setup-superagent-mode-btn + .setup-superagent-mode-btn {
  border-left: 1px solid var(--border-color);
}
.setup-superagent-mode-btn:hover {
  background: rgba(127, 127, 127, 0.1);
  color: var(--text-primary);
}
.setup-superagent-mode-btn.active {
  background: rgba(212, 152, 31, 0.16);
  color: var(--text-primary);
}
.setup-superagent-health-widget {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  cursor: pointer;
  border: 0;
  background: transparent;
  color: var(--text-primary);
  width: 100%;
  text-align: left;
}
.setup-superagent-health-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: 0 0 auto;
}
.setup-superagent-health-dot.green { background: #25a050; }
.setup-superagent-health-dot.yellow { background: #d4981f; }
.setup-superagent-health-dot.red { background: #c0392b; }
.setup-superagent-health-text {
  font-size: var(--text-xs);
  color: var(--text-secondary);
  margin-left: auto;
}
`;

module.exports = {
  async onEnable(context) {
    async function renderAssessment(options = {}) {
      const assessment = await context.setupSuperagent.getAssessment();
      return { assessment, html: renderPanel(assessment, options), css };
    }

    context.registerChatUI({
      title: 'Setup Superagent',
      async renderPanel() {
        const { html } = await renderAssessment();
        return html;
      },
      css,
      actions: {
        async refresh() {
          const { html } = await renderAssessment({ note: 'Setup snapshot refreshed.' });
          return { success: true, html, css };
        },
        async 'focus-step'({ payload }) {
          const { html } = await renderAssessment({
            focusStepId: String(payload?.stepId || '').trim(),
            note: ''
          });
          return { success: true, html, css };
        },
        async 'run-setup-action'({ payload }) {
          const result = await context.setupSuperagent.runAction({
            action: payload?.setupAction,
            params: payload?.setupParams || {}
          });
          const note = result?.result?.error
            ? result.result.error
            : `${payload?.setupAction || 'Action'} completed.`;
          return {
            success: result?.success !== false,
            html: renderPanel(result.assessment, { note }),
            css
          };
        },
        async 'apply-preset'({ payload }) {
          const presetName = String(payload?.preset || '').trim();
          if (!presetName) {
            return { success: false, error: 'Missing preset name' };
          }
          const result = await context.setupSuperagent.runAction({
            action: 'apply_preset',
            params: { preset: presetName }
          });
          const presetLabel = result?.result?.label || presetName;
          const note = result?.success !== false
            ? `✅ ${presetLabel} preset applied!`
            : (result?.result?.error || 'Preset application failed.');
          return {
            success: result?.success !== false,
            html: renderPanel(result.assessment, { note }),
            css
          };
        },
        async 'toggle-group'({ payload }) {
          const groupId = String(payload?.groupId || '').trim();
          if (!groupId) {
            return { success: false, error: 'Missing groupId' };
          }
          let result;
          if (groupId === 'companion') {
            result = await context.setupSuperagent.runAction({
              action: 'enable_companion',
              params: {}
            });
          } else if (groupId.startsWith('plugin:')) {
            const pluginName = groupId.slice(7).replace(/-search$/, '');
            result = await context.setupSuperagent.runAction({
              action: 'plugin_quick_setup',
              params: { pluginName }
            });
          } else {
            // Read current state to determine toggle direction
            const assessment = await context.setupSuperagent.getAssessment();
            const groupsConfig = assessment?.state?.capabilities?.groupsConfig || [];
            const group = groupsConfig.find(g => g.id === groupId);
            const currentEnabled = group?.enabled === true;
            result = await context.setupSuperagent.runAction({
              action: 'set_capability_group',
              params: { groupId, enabled: !currentEnabled }
            });
          }
          const note = result?.success !== false
            ? `✅ ${groupId} toggled.`
            : (result?.result?.error || 'Toggle failed.');
          return {
            success: result?.success !== false,
            html: renderPanel(result.assessment, { note }),
            css
          };
        },
        async 'set-files-mode'({ payload }) {
          const mode = String(payload?.mode || '').trim();
          const result = await context.setupSuperagent.runAction({
            action: 'set_files_mode',
            params: { mode }
          });
          const note = result?.success !== false
            ? `✅ Files mode set to ${mode}.`
            : (result?.result?.error || 'Mode change failed.');
          return {
            success: result?.success !== false,
            html: renderPanel(result.assessment, { note }),
            css
          };
        },
        async 'set-terminal-mode'({ payload }) {
          const mode = String(payload?.mode || '').trim();
          const result = await context.setupSuperagent.runAction({
            action: 'set_terminal_mode',
            params: { mode }
          });
          const note = result?.success !== false
            ? `✅ Terminal mode set to ${mode}.`
            : (result?.result?.error || 'Mode change failed.');
          return {
            success: result?.success !== false,
            html: renderPanel(result.assessment, { note }),
            css
          };
        },
        async 'dismiss-setup-action'({ payload }) {
          const actionId = String(payload?.actionId || '').trim();
          await context.setupSuperagent.dismissAction(actionId);
          const { html } = await renderAssessment({ note: 'Recommendation dismissed.' });
          return { success: true, html, css };
        },
        async 'show-manual-step'({ payload }) {
          const title = String(payload?.title || 'Manual step');
          const description = String(payload?.description || 'Open the relevant settings and complete the step manually.');
          const { html } = await renderAssessment({ note: `${title}: ${description}` });
          return { success: true, html, css };
        },
        async 'open-workspace-tab'({ payload }) {
          const tab = String(payload?.tab || '').trim();
          const labels = { api: 'Model settings', settings: 'Settings', mcp: 'Tool controls' };
          const { html } = await renderAssessment({
            note: labels[tab] ? `${labels[tab]} opened.` : 'Workspace tab opened.'
          });
          return {
            success: true,
            html,
            css,
            openSidebarTab: tab || undefined
          };
        },
        async 'open-plugin-studio'({ payload }) {
          const pluginId = String(payload?.pluginId || '').trim();
          const { html } = await renderAssessment({
            note: pluginId ? `Plugin Studio opened for ${pluginId}.` : 'Plugin Studio opened.'
          });
          return {
            success: true,
            html,
            css,
            openPluginStudio: pluginId ? { focusPluginId: pluginId } : {}
          };
        }
      }
    });

    // Sidebar health widget
    context.registerSidebarWidget({
      id: 'setup-health',
      title: 'Setup Health',
      chrome: false,
      async renderPanel() {
        try {
          const assessment = await context.setupSuperagent.getAssessment();
          const wizard = buildWizardModel(assessment);
          const stage = assessment?.setupStage || 'ready';
          const dotColor = stage === 'ready' ? 'green' : (stage === 'configuration_missing' ? 'red' : 'yellow');
          const label = stage === 'ready' ? 'All set' : stageLabel(stage);
          return `<button type="button" class="setup-superagent-health-widget" data-agent-ui-action="open-setup-chat" title="Open Setup Superagent">
            <span class="setup-superagent-health-dot ${dotColor}"></span>
            <span>🧭 Setup</span>
            <span class="setup-superagent-health-text">${escapeHtml(label)} · ${wizard.completedCount}/${wizard.totalSteps}</span>
          </button>`;
        } catch (_) {
          return '<span style="font-size:var(--text-xs);color:var(--text-secondary);padding:4px 8px">Setup unavailable</span>';
        }
      },
      css,
      actions: {
        async 'open-setup-chat'() {
          return {
            success: true,
            openAgentSlug: 'setup-superagent'
          };
        },
        async refresh() {
          return { success: true, refresh: true };
        }
      }
    });
  }
};
