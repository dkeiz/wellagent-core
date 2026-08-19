const fs = require('fs');
const path = require('path');

const VIEW_MODES = new Set(['nested', 'split', 'linear']);
const MAX_CHILDREN = 10;
const stateByAgent = new Map();

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\"/g, '&quot;');
}

function escapeAttribute(value) {
    return escapeHtml(value).replace(/'/g, '&#39;');
}

function listFiles(dirPath) {
    if (!dirPath || !fs.existsSync(dirPath)) return [];
    return fs.readdirSync(dirPath, { withFileTypes: true })
        .filter(entry => entry.isFile() && !entry.name.startsWith('.'))
        .map(entry => {
            const fullPath = path.join(dirPath, entry.name);
            const stat = fs.statSync(fullPath);
            return {
                name: entry.name,
                size: stat.size,
                modifiedAt: stat.mtime
            };
        })
        .sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
}

function formatTime(dateLike) {
    const date = new Date(dateLike || Date.now());
    if (Number.isNaN(date.getTime())) return 'just now';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function normalizeMode(value) {
    const mode = String(value || '').trim().toLowerCase();
    if (VIEW_MODES.has(mode)) return mode;
    return 'nested';
}

function getAgentState(agentInfo) {
    const key = String(agentInfo?.id || agentInfo?.slug || agentInfo?.name || 'default');
    if (!stateByAgent.has(key)) {
        stateByAgent.set(key, {
            viewMode: 'nested',
            runSubagentWithChatUi: true,
            runChildInsideAgent: true,
            activeChildId: '',
            children: [],
            sequence: 1
        });
    }
    const state = stateByAgent.get(key);
    if (!VIEW_MODES.has(state.viewMode)) {
        state.viewMode = 'nested';
    }
    if (!Array.isArray(state.children)) {
        state.children = [];
    }
    if (typeof state.sequence !== 'number' || state.sequence < 1) {
        state.sequence = 1;
    }
    if (typeof state.runSubagentWithChatUi !== 'boolean') {
        state.runSubagentWithChatUi = true;
    }
    if (typeof state.runChildInsideAgent !== 'boolean') {
        state.runChildInsideAgent = true;
    }
    return state;
}

function findChild(state, childId) {
    const id = String(childId || '').trim();
    return state.children.find(child => child.id === id) || null;
}

function createChild(state) {
    const nextNumber = state.sequence;
    state.sequence += 1;
    const id = `child-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const child = {
        id,
        title: `Research Child ${nextNumber}`,
        sessionId: '',
        provider: '',
        model: '',
        compact: false,
        status: 'idle',
        lastActiveAt: new Date().toISOString()
    };
    state.children.push(child);
    state.activeChildId = child.id;
    return child;
}

function trimChildren(state) {
    if (state.children.length <= MAX_CHILDREN) return;
    state.children = state.children.slice(0, MAX_CHILDREN);
    if (!state.children.some(child => child.id === state.activeChildId)) {
        state.activeChildId = state.children[0]?.id || '';
    }
}

function renderMetrics(agentInfo, tasks, outputs) {
    const taskLine = tasks[0]
        ? `${tasks[0].name}`
        : 'No task files yet.';

    return `
        <div class="research-summary-strip">
            <div class="research-summary-item"><strong>${tasks.length}</strong><span>Plans</span></div>
            <div class="research-summary-item"><strong>${outputs.length}</strong><span>Outputs</span></div>
            <div class="research-summary-item research-summary-task"><strong>Tasks</strong><span>${escapeHtml(taskLine)}</span></div>
        </div>
    `;
}

function renderViewModeButton(mode, activeMode, icon, title) {
    return `
        <button type="button"
            class="research-view-btn${mode === activeMode ? ' active' : ''}"
            data-agent-ui-action="set-view-mode"
            data-view-mode="${mode}"
            title="${escapeAttribute(title)}"
            aria-label="${escapeAttribute(title)}">${icon}</button>
    `;
}

function renderOptionToggle(optionKey, checked, label) {
    return `
        <button type="button"
            class="research-option-toggle${checked ? ' checked' : ''}"
            data-agent-ui-action="toggle-option"
            data-option-key="${escapeAttribute(optionKey)}"
            data-option-value="${checked ? 'false' : 'true'}"
            title="${escapeAttribute(label)}">
            <span class="research-option-box">${checked ? '✓' : ''}</span>
            <span class="research-option-label">${escapeHtml(label)}</span>
        </button>
    `;
}

function renderChildCard(child, index, activeChildId) {
    const isActive = child.id === activeChildId;
    const isCompact = Boolean(child.compact);
    const statusClass = `status-${String(child.status || 'idle').toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`;
    return `
        <article class="research-child-card${isActive ? ' active' : ''}${isCompact ? ' compact' : ''}" data-child-id="${escapeAttribute(child.id)}" data-child-session-id="${escapeAttribute(child.sessionId || '')}">
            <header class="research-child-head">
                <button type="button" class="research-child-title-btn" data-agent-ui-action="set-active-child" data-child-id="${escapeAttribute(child.id)}" title="Open ${escapeAttribute(child.title)}">
                    <span class="research-child-index">${index + 1}</span>
                    <span class="research-child-title">${escapeHtml(child.title)}</span>
                </button>
                <span class="research-child-status ${statusClass}">${escapeHtml(child.status || 'idle')}</span>
                <button type="button" class="research-mini-btn" data-agent-ui-action="toggle-child-compact" data-child-id="${escapeAttribute(child.id)}" title="Compact/expand">${isCompact ? '▾' : '▴'}</button>
                <button type="button" class="research-mini-btn danger" data-agent-ui-action="remove-child" data-child-id="${escapeAttribute(child.id)}" title="Close child">×</button>
            </header>

            <div class="research-child-controls" ${isCompact ? 'hidden' : ''}>
                <select class="research-child-provider compact-select" data-research-provider data-child-id="${escapeAttribute(child.id)}" data-value="${escapeAttribute(child.provider || '')}" title="Provider"></select>
                <select class="research-child-model compact-select" data-research-model data-child-id="${escapeAttribute(child.id)}" data-value="${escapeAttribute(child.model || '')}" title="Model"></select>
                <button type="button" class="icon-btn-sm" data-research-artifacts-btn data-child-id="${escapeAttribute(child.id)}" title="Artifacts">🗂</button>
                <button type="button" class="icon-btn-sm" data-research-refresh-btn data-child-id="${escapeAttribute(child.id)}" title="Refresh child messages">↻</button>
                <span class="research-child-time">${escapeHtml(formatTime(child.lastActiveAt))}</span>
            </div>

            <div class="research-child-artifacts" data-research-artifacts="${escapeAttribute(child.id)}" hidden></div>
            <div class="research-child-messages" data-research-messages="${escapeAttribute(child.id)}" ${isCompact ? 'hidden' : ''}>No messages yet.</div>

            <form class="research-child-input-row" data-research-send-form data-child-id="${escapeAttribute(child.id)}" ${isCompact ? 'hidden' : ''}>
                <textarea class="research-child-input" data-research-input="${escapeAttribute(child.id)}" rows="2" placeholder="Type task for this child subagent..."></textarea>
                <button type="submit" class="send-button research-child-send">Send</button>
            </form>
        </article>
    `;
}

function renderChildren(state) {
    if (!state.children.length) {
        return '<div class="research-children-empty"></div>';
    }
    const cards = state.children
        .map((child, index) => renderChildCard(child, index, state.activeChildId))
        .join('');
    return `
        <div class="research-children-scroll">
            <div class="research-children-grid mode-${escapeAttribute(state.viewMode)}">${cards}</div>
        </div>
    `;
}

function buildStatePayload(state) {
    return {
        viewMode: state.viewMode,
        runSubagentWithChatUi: Boolean(state.runSubagentWithChatUi),
        runChildInsideAgent: Boolean(state.runChildInsideAgent),
        activeChildId: state.activeChildId,
        children: state.children.map(child => ({
            id: child.id,
            title: child.title,
            sessionId: child.sessionId || '',
            provider: child.provider || '',
            model: child.model || '',
            compact: Boolean(child.compact),
            status: child.status || 'idle',
            lastActiveAt: child.lastActiveAt || new Date().toISOString()
        }))
    };
}

function renderPanel(agentInfo) {
    const state = getAgentState(agentInfo);
    trimChildren(state);

    const home = agentInfo.folderPath || '';
    const tasks = listFiles(path.join(home, 'tasks'));
    const outputs = listFiles(path.join(home, 'outputs'));
    const payload = buildStatePayload(state);

    return `<section class="research-orch-shell" data-research-orch-root data-ro-state="${escapeAttribute(JSON.stringify(payload))}">
        <header class="research-orch-topbar">
            <strong>Research Orchestrator</strong>
            <div class="research-view-modes" role="group" aria-label="Child view mode">
                ${renderViewModeButton('nested', state.viewMode, '▭', 'Children integrated')}
                ${renderViewModeButton('split', state.viewMode, '◫', 'Two children side-by-side')}
                ${renderViewModeButton('linear', state.viewMode, '☰', 'Linear compact list')}
            </div>
            <button type="button" class="research-add-child" data-agent-ui-action="add-child" title="Create child chat">+ Child</button>
            <div class="research-options-group">
                ${renderOptionToggle('runSubagentWithChatUi', state.runSubagentWithChatUi, 'run subagent with chat ui')}
                ${renderOptionToggle('runChildInsideAgent', state.runChildInsideAgent, 'run child inside agent')}
            </div>
        </header>
        ${renderMetrics(agentInfo, tasks, outputs)}
        <section class="research-super-chat-wrap">
            <div class="research-super-chat-head">Superagent chat</div>
            <div class="research-super-chat-host" data-agent-ui-chat-host></div>
        </section>
        <section class="research-children-wrap${state.children.length ? ' has-children' : ''}">
            ${renderChildren(state)}
        </section>
    </section>`;
}

const css = `
.research-orch-shell {
    display: grid;
    gap: 7px;
    border: 1px solid var(--border-color);
    border-radius: 8px;
    background: var(--card-bg);
    margin-bottom: 8px;
    padding: 8px;
}

.research-orch-topbar {
    display: flex;
    align-items: center;
    gap: 7px;
    min-height: 28px;
}

.research-view-modes {
    display: inline-flex;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    overflow: hidden;
}

.research-view-btn {
    min-width: 26px;
    min-height: 24px;
    border: 0;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
}

.research-view-btn + .research-view-btn {
    border-left: 1px solid var(--border-color);
}

.research-view-btn:hover,
.research-view-btn.active {
    color: var(--text-primary);
    background: rgba(74, 158, 255, 0.16);
}

.research-add-child {
    min-height: 24px;
    padding: 0 8px;
    border: 1px solid var(--border-color);
    border-radius: 5px;
    background: transparent;
    color: var(--text-primary);
    cursor: pointer;
}

.research-options-group {
    display: inline-grid;
    gap: 4px;
    margin-left: auto;
}

.research-option-toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 22px;
    padding: 1px 6px;
    border: 1px solid transparent;
    border-radius: 5px;
    background: transparent;
    cursor: pointer;
    color: var(--text-primary);
}

.research-option-toggle:hover {
    border-color: var(--border-color);
    background: rgba(127, 127, 127, 0.08);
}

.research-option-box {
    width: 14px;
    height: 14px;
    border: 1px solid var(--border-color);
    border-radius: 3px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    line-height: 1;
    color: transparent;
    background: var(--card-bg);
}

.research-option-toggle.checked .research-option-box {
    color: var(--text-primary);
    border-color: var(--primary-color);
    background: color-mix(in srgb, var(--primary-color), transparent 84%);
}

.research-option-label {
    font-size: var(--text-xs);
    color: var(--text-secondary);
    white-space: nowrap;
}

.research-summary-strip {
    display: grid;
    grid-template-columns: 70px 70px minmax(220px, 1fr);
    gap: 8px;
    align-items: stretch;
}

.research-summary-item {
    display: flex;
    flex-direction: column;
    min-width: 0;
}

.research-summary-item strong {
    font-size: var(--text-md);
    line-height: 1.1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.research-summary-item span {
    color: var(--text-secondary);
    font-size: var(--text-xs);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.research-super-chat-wrap {
    border: 1px solid var(--border-color);
    border-radius: 6px;
    overflow: hidden;
}

.research-super-chat-head {
    min-height: 24px;
    padding: 2px 8px;
    border-bottom: 1px solid var(--border-color);
    color: var(--text-secondary);
    font-size: var(--text-xs);
}

.research-super-chat-host {
    display: flex;
    height: 260px;
    overflow: hidden;
}

.research-super-chat-host .messages-container {
    border-radius: 0;
    padding: 10px;
    min-height: 100%;
    height: 100%;
    max-height: none;
    overflow-y: auto !important;
    overflow-x: hidden !important;
}

.research-children-wrap {
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 7px;
}

.research-children-wrap.has-children {
    max-height: 34vh;
}

.research-children-scroll {
    max-height: calc(34vh - 14px);
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
}

.research-children-scroll::-webkit-scrollbar {
    width: 8px;
}

.research-children-scroll::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, var(--text-secondary), transparent 45%);
    border-radius: 8px;
}

.research-children-grid {
    display: grid;
    gap: 7px;
}

.research-children-grid.mode-nested {
    grid-template-columns: 1fr;
}

.research-children-grid.mode-split {
    grid-template-columns: 1fr 1fr;
}

.research-children-grid.mode-linear {
    grid-template-columns: 1fr;
}

.research-children-empty {
    border: 1px dashed var(--border-color);
    border-radius: 6px;
    min-height: 22px;
}

.research-child-card {
    border: 1px solid var(--border-color);
    border-radius: 6px;
    background: color-mix(in srgb, var(--card-bg), transparent 12%);
    padding: 5px;
    display: grid;
    gap: 6px;
}

.research-child-card.active {
    border-color: var(--primary-color);
}

.research-child-head {
    display: flex;
    align-items: center;
    gap: 5px;
    min-height: 22px;
}

.research-child-title-btn {
    border: 0;
    background: transparent;
    color: var(--text-primary);
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    min-width: 0;
    flex: 1;
    text-align: left;
    padding: 0;
}

.research-child-index {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: 1px solid var(--border-color);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    color: var(--text-secondary);
}

.research-child-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-sm);
}

.research-child-status {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    border-radius: 999px;
    border: 1px solid var(--border-color);
    padding: 1px 6px;
    color: var(--text-secondary);
    background: var(--bg-secondary);
}

.research-child-status.status-running {
    color: #1f7a3d;
    border-color: #6ac48f;
    background: color-mix(in srgb, #6ac48f, transparent 84%);
}

.research-child-status.status-idle {
    color: var(--text-secondary);
}

.research-child-status.status-done,
.research-child-status.status-completed {
    color: #175f44;
    border-color: #63cba0;
    background: color-mix(in srgb, #63cba0, transparent 84%);
}

.research-mini-btn {
    min-width: 22px;
    min-height: 22px;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
}

.research-mini-btn.danger {
    color: #ad4b4b;
}

.research-child-controls {
    display: grid;
    grid-template-columns: minmax(82px, 0.24fr) minmax(140px, 0.48fr) auto auto minmax(46px, auto);
    align-items: center;
    gap: 5px;
}

.research-child-provider,
.research-child-model {
    max-width: none;
    width: 100%;
}

.research-child-time {
    color: var(--text-secondary);
    font-size: 11px;
    justify-self: end;
}

.research-child-messages {
    min-height: 78px;
    max-height: 150px;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: rgba(127, 127, 127, 0.06);
    padding: 5px;
    overflow: auto;
    color: var(--text-primary);
    font-size: var(--text-sm);
    white-space: pre-wrap;
}

.research-child-message {
    margin-bottom: 6px;
    line-height: 1.35;
}

.research-child-message:last-child {
    margin-bottom: 0;
}

.research-child-message-role {
    color: var(--text-secondary);
    font-size: 11px;
    margin-right: 4px;
}

.research-child-input-row {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 5px;
    align-items: end;
}

.research-child-input {
    width: 100%;
    min-height: 36px;
    max-height: 96px;
    resize: vertical;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    padding: 5px;
    background: var(--chat-bg);
    color: var(--text-primary);
}

.research-child-send {
    min-width: 64px;
}

.research-child-artifacts {
    border: 1px dashed var(--border-color);
    border-radius: 4px;
    padding: 5px;
    display: grid;
    gap: 4px;
}

.research-child-artifact-item {
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: transparent;
    color: var(--text-primary);
    text-align: left;
    min-height: 24px;
    padding: 0 6px;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.research-child-artifact-preview {
    font-size: 11px;
    color: var(--text-secondary);
    white-space: pre-wrap;
    max-height: 120px;
    overflow: auto;
    border-top: 1px dashed var(--border-color);
    padding-top: 4px;
}

.research-child-card.compact .research-child-controls,
.research-child-card.compact .research-child-artifacts,
.research-child-card.compact .research-child-messages,
.research-child-card.compact .research-child-input-row {
    display: none;
}

.research-children-grid.mode-linear .research-child-card:not(.active) .research-child-controls,
.research-children-grid.mode-linear .research-child-card:not(.active) .research-child-artifacts,
.research-children-grid.mode-linear .research-child-card:not(.active) .research-child-messages,
.research-children-grid.mode-linear .research-child-card:not(.active) .research-child-input-row {
    display: none;
}

@media (max-width: 980px) {
    .research-summary-strip {
        grid-template-columns: 1fr 1fr;
    }

    .research-summary-task,
    .research-summary-task {
        grid-column: span 2;
    }

    .research-children-grid.mode-split {
        grid-template-columns: 1fr;
    }

    .research-children-grid.mode-split .research-child-card:nth-child(n + 3) {
        grid-column: auto;
    }

    .research-child-controls {
        grid-template-columns: 1fr 1fr auto auto;
    }

    .research-child-time {
        display: none;
    }
}
`;

module.exports = {
    onEnable(context) {
        context.registerChatUI({
            title: 'Research Orchestrator',
            renderPanel,
            css,
            actions: {
                refresh({ agentInfo }) {
                    return { success: true, html: renderPanel(agentInfo), css };
                },
                'set-view-mode'({ agentInfo, payload }) {
                    const state = getAgentState(agentInfo);
                    state.viewMode = normalizeMode(payload.viewMode);
                    return { success: true, html: renderPanel(agentInfo), css };
                },
                'toggle-option'({ agentInfo, payload }) {
                    const state = getAgentState(agentInfo);
                    const key = String(payload.optionKey || '').trim();
                    const value = String(payload.optionValue || '').toLowerCase() === 'true';
                    if (key === 'runSubagentWithChatUi') {
                        state.runSubagentWithChatUi = value;
                    } else if (key === 'runChildInsideAgent') {
                        state.runChildInsideAgent = value;
                    }
                    return { success: true, html: renderPanel(agentInfo), css };
                },
                'add-child'({ agentInfo }) {
                    const state = getAgentState(agentInfo);
                    if (state.children.length >= MAX_CHILDREN) {
                        return { success: true, html: renderPanel(agentInfo), css };
                    }
                    createChild(state);
                    return { success: true, html: renderPanel(agentInfo), css };
                },
                'remove-child'({ agentInfo, payload }) {
                    const state = getAgentState(agentInfo);
                    const targetId = String(payload.childId || '');
                    state.children = state.children.filter(child => child.id !== targetId);
                    if (!state.children.some(child => child.id === state.activeChildId)) {
                        state.activeChildId = state.children[0]?.id || '';
                    }
                    return { success: true, html: renderPanel(agentInfo), css };
                },
                'toggle-child-compact'({ agentInfo, payload }) {
                    const state = getAgentState(agentInfo);
                    const child = findChild(state, payload.childId);
                    if (child) {
                        child.compact = !child.compact;
                        child.lastActiveAt = new Date().toISOString();
                    }
                    return { success: true, html: renderPanel(agentInfo), css };
                },
                'set-active-child'({ agentInfo, payload }) {
                    const state = getAgentState(agentInfo);
                    const child = findChild(state, payload.childId);
                    if (child) {
                        state.activeChildId = child.id;
                        child.lastActiveAt = new Date().toISOString();
                    }
                    return { success: true, html: renderPanel(agentInfo), css };
                },
                'link-child-session'({ agentInfo, payload }) {
                    const state = getAgentState(agentInfo);
                    const child = findChild(state, payload.childId);
                    if (child) {
                        child.sessionId = String(payload.sessionId || child.sessionId || '');
                        child.lastActiveAt = new Date().toISOString();
                    }
                    return { success: true };
                },
                'set-child-llm'({ agentInfo, payload }) {
                    const state = getAgentState(agentInfo);
                    const child = findChild(state, payload.childId);
                    if (child) {
                        child.provider = String(payload.provider || child.provider || '');
                        child.model = String(payload.model || child.model || '');
                        child.lastActiveAt = new Date().toISOString();
                    }
                    return { success: true };
                },
                'touch-child'({ agentInfo, payload }) {
                    const state = getAgentState(agentInfo);
                    const child = findChild(state, payload.childId);
                    if (child) {
                        child.status = String(payload.status || child.status || 'idle');
                        child.lastActiveAt = new Date().toISOString();
                    }
                    return { success: true };
                }
            },
            onTabActivated(agentInfo, payload, pluginContext) {
                const state = getAgentState(agentInfo);
                trimChildren(state);
                pluginContext.log(`Research orchestrator UI active for ${agentInfo.name}`);
            }
        });
        context.log('Research Orchestrator workspace UI registered');
    },
    onDisable() {
        stateByAgent.clear();
        console.log('[agent-research-orchestrator-ui] Disabled');
    }
};
