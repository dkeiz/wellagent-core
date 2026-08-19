const fs = require('fs');
const path = require('path');

const MAX_NODES = 1200;
const MAX_DEPTH = 12;
const MAX_OPEN_TABS = 12;
const DEFAULT_EXPANDED = ['', 'agents', 'plugins', 'workflows', 'memory', 'knowledge'];

const stateByAgent = new Map();

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function resolveAgentinRoot() {
    return path.resolve(__dirname, '..', '..');
}

function normalizeDir(candidate) {
    try {
        return path.resolve(String(candidate || ''));
    } catch (error) {
        return '';
    }
}

function isInside(baseDir, targetPath) {
    if (!baseDir || !targetPath) return false;
    const base = path.resolve(baseDir);
    const target = path.resolve(targetPath);
    return target === base || target.startsWith(base + path.sep);
}

function getAgentState(agentInfo) {
    const key = String(agentInfo?.id || agentInfo?.slug || agentInfo?.name || 'default');
    const agentinRoot = resolveAgentinRoot();
    const defaultRoot = agentinRoot;

    let state = stateByAgent.get(key);
    if (!state) {
        state = {
            rootPath: defaultRoot,
            expanded: new Set(DEFAULT_EXPANDED),
            openFiles: [],
            activeFile: '',
            workspaceTab: 'chat',
            pendingRootPath: '',
            allowedOutsideRoots: new Set()
        };
        stateByAgent.set(key, state);
    }

    if (!state.rootPath || !fs.existsSync(state.rootPath) || !fs.statSync(state.rootPath).isDirectory()) {
        state.rootPath = defaultRoot;
    }

    return { key, state, agentinRoot, defaultRoot };
}

function readTree(rootPath) {
    const visited = { count: 0 };

    function visit(relativePath = '', depth = 0) {
        if (visited.count >= MAX_NODES || depth > MAX_DEPTH) {
            return [];
        }

        const currentPath = path.join(rootPath, relativePath);
        if (!isInside(rootPath, currentPath) || !fs.existsSync(currentPath)) {
            return [];
        }

        let entries = [];
        try {
            entries = fs.readdirSync(currentPath, { withFileTypes: true })
                .filter(entry => !entry.name.startsWith('.'))
                .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
        } catch (error) {
            return [];
        }

        const nodes = [];
        for (const entry of entries) {
            if (visited.count >= MAX_NODES) break;
            const childRelative = path.join(relativePath, entry.name).replace(/\\/g, '/');
            const fullPath = path.join(rootPath, childRelative);
            if (!isInside(rootPath, fullPath)) continue;

            visited.count += 1;
            if (entry.isDirectory()) {
                nodes.push({
                    type: 'directory',
                    name: entry.name,
                    relativePath: childRelative,
                    children: visit(childRelative, depth + 1)
                });
                continue;
            }

            nodes.push({
                type: 'file',
                name: entry.name,
                relativePath: childRelative
            });
        }

        return nodes;
    }

    return visit('', 0);
}

function flattenVisibleTree(nodes, expandedSet, depth = 0, output = []) {
    for (const node of nodes) {
        const isDirectory = node.type === 'directory';
        const isExpanded = isDirectory ? expandedSet.has(node.relativePath) : false;
        output.push({
            ...node,
            depth,
            isExpanded
        });
        if (isDirectory && isExpanded) {
            flattenVisibleTree(node.children || [], expandedSet, depth + 1, output);
        }
    }
    return output;
}

function renderExplorerRows(rows, activeFile) {
    if (!rows.length) {
        return '<div class="agent-vs-empty">No files found in selected root.</div>';
    }

    return rows.map(row => {
        const indent = Math.min(14, row.depth) * 14;
        const commonStyle = `style="--row-indent:${indent}px"`;

        if (row.type === 'directory') {
            const icon = row.isExpanded ? '▾' : '▸';
            return `<button type="button" class="agent-vs-row directory" ${commonStyle}
                data-agent-ui-action="toggle-dir"
                data-relative-path="${escapeHtml(row.relativePath)}">
                <span class="agent-vs-indent"></span>
                <span class="agent-vs-twist">${icon}</span>
                <span class="agent-vs-label">${escapeHtml(row.name)}</span>
            </button>`;
        }

        const activeClass = activeFile === row.relativePath ? ' active' : '';
        return `<button type="button" class="agent-vs-row file${activeClass}" ${commonStyle}
            data-agent-ui-action="open-file"
            data-relative-path="${escapeHtml(row.relativePath)}">
            <span class="agent-vs-indent"></span>
            <span class="agent-vs-twist">·</span>
            <span class="agent-vs-label">${escapeHtml(row.name)}</span>
        </button>`;
    }).join('');
}

function readFileSafe(rootPath, relativePath) {
    const normalizedRelative = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const absolutePath = path.resolve(rootPath, normalizedRelative);

    if (!isInside(rootPath, absolutePath)) {
        return { success: false, error: 'Requested path is outside selected root' };
    }

    if (!fs.existsSync(absolutePath)) {
        return { success: false, error: 'File not found' };
    }

    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) {
        return { success: false, error: 'Selected path is not a file' };
    }

    const maxBytes = 512 * 1024;
    if (stat.size > maxBytes) {
        return {
            success: false,
            error: `File is too large to preview (${Math.round(stat.size / 1024)} KB, max 512 KB)`
        };
    }

    try {
        return { success: true, content: fs.readFileSync(absolutePath, 'utf-8') };
    } catch (error) {
        return { success: false, error: `Failed to read file: ${error.message}` };
    }
}

function ensureOpenFile(state, relativePath) {
    const normalized = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalized) return;

    state.openFiles = state.openFiles.filter(item => item !== normalized);
    state.openFiles.unshift(normalized);
    if (state.openFiles.length > MAX_OPEN_TABS) {
        state.openFiles = state.openFiles.slice(0, MAX_OPEN_TABS);
    }
    state.activeFile = normalized;
    state.workspaceTab = normalized;
}

function closeOpenFile(state, relativePath) {
    const normalized = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const before = state.openFiles;
    const next = before.filter(item => item !== normalized);
    state.openFiles = next;

    if (state.activeFile === normalized) {
        state.activeFile = next[0] || '';
    }

    if (state.workspaceTab === normalized) {
        state.workspaceTab = next[0] || 'chat';
    }
}

function renderOpenTabs(state) {
    const chatActive = state.workspaceTab === 'chat';
    const chatTab = `<button type="button" class="agent-vs-chat-tab${chatActive ? ' active' : ''}"
        data-agent-ui-action="set-workspace-tab"
        data-tab-key="chat"
        title="Chat with this agent while browsing files">Chat here</button>`;
    const fileTabs = state.openFiles.map(relativePath => {
        const fileName = path.basename(relativePath);
        const isActive = relativePath === state.workspaceTab;
        return `<div class="agent-vs-subtab${isActive ? ' active' : ''}">
            <button type="button" class="agent-vs-subtab-main"
                data-agent-ui-action="set-workspace-tab"
                data-tab-key="${escapeHtml(relativePath)}"
                data-relative-path="${escapeHtml(relativePath)}"
                title="${escapeHtml(relativePath)}">${escapeHtml(fileName)}</button>
            <button type="button" class="agent-vs-subtab-close"
                data-agent-ui-action="close-file"
                data-relative-path="${escapeHtml(relativePath)}"
                title="Close">×</button>
        </div>`;
    }).join('');

    return `${chatTab}${fileTabs}`;
}

function canAccessRoot(agentinRoot, state, targetRoot) {
    if (!targetRoot) return false;
    if (isInside(agentinRoot, targetRoot)) return true;
    return state.allowedOutsideRoots.has(targetRoot);
}

function attemptRootChange(agentInfo, payload = {}) {
    const { state, agentinRoot } = getAgentState(agentInfo);
    const candidate = normalizeDir(payload.directoryPath || payload.rootPath || '');
    if (!candidate) {
        return { success: false, error: 'Missing directoryPath' };
    }

    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
        return { success: false, error: 'Requested directory does not exist' };
    }

    if (!canAccessRoot(agentinRoot, state, candidate)) {
        state.pendingRootPath = candidate;
        return {
            success: true,
            html: renderPanel(agentInfo)
        };
    }

    state.pendingRootPath = '';
    state.rootPath = candidate;
    state.openFiles = [];
    state.activeFile = '';
    state.expanded = new Set(DEFAULT_EXPANDED);
    return {
        success: true,
        html: renderPanel(agentInfo)
    };
}

function renderPermissionPrompt(state, agentinRoot) {
    const pending = state.pendingRootPath;
    if (!pending) return '';

    return `<div class="agent-vs-permission">
        <div class="agent-vs-permission-text">
            Requested directory is outside default root <code>${escapeHtml(agentinRoot)}</code><br>
            Requested: <code>${escapeHtml(pending)}</code>
        </div>
        <div class="agent-vs-permission-actions">
            <button type="button" class="btn-primary" data-agent-ui-action="approve-root-change">Allow</button>
            <button type="button" class="btn-secondary" data-agent-ui-action="deny-root-change">Deny</button>
        </div>
    </div>`;
}

function renderPanel(agentInfo) {
    const { state, agentinRoot, defaultRoot } = getAgentState(agentInfo);
    const activeRoot = fs.existsSync(state.rootPath) ? state.rootPath : defaultRoot;
    if (state.rootPath !== activeRoot) {
        state.rootPath = activeRoot;
    }

    const tree = readTree(activeRoot);
    const rows = flattenVisibleTree(tree, state.expanded);

    if (state.activeFile && !state.openFiles.includes(state.activeFile)) {
        state.activeFile = '';
    }
    if (state.workspaceTab !== 'chat' && !state.openFiles.includes(state.workspaceTab)) {
        state.workspaceTab = state.activeFile || 'chat';
    }

    const selectedFile = state.workspaceTab !== 'chat'
        ? state.workspaceTab
        : state.activeFile;

    const preview = selectedFile
        ? readFileSafe(activeRoot, selectedFile)
        : { success: false, error: 'Select a file from the explorer.' };

    const previewText = preview.success ? preview.content : '';
    const previewMeta = selectedFile ? escapeHtml(selectedFile) : '';
    const showChatWorkspace = state.workspaceTab === 'chat';

    return `<section class="agent-vs-shell" aria-label="File Manager Explorer">
        <div class="agent-vs-toolbar">
            <div class="agent-vs-toolbar-left">
                <strong>Explorer</strong>
                <button type="button" class="agent-vs-btn agent-vs-open-folder" data-agent-ui-action="open-folder">Open Folder</button>
            </div>
            <div class="agent-vs-workspace-strip">
                <div class="agent-vs-subtabs">${renderOpenTabs(state)}</div>
            </div>
        </div>

        ${renderPermissionPrompt(state, agentinRoot)}

        <div class="agent-vs-body">
            <div class="agent-vs-tree" data-agent-ui-tree>
                ${renderExplorerRows(rows, state.activeFile)}
            </div>
            <div class="agent-vs-editor">
                <div class="agent-vs-chat-workspace"${showChatWorkspace ? '' : ' hidden'}>
                    <div class="agent-vs-chat-host" data-agent-ui-chat-host></div>
                </div>
                <div class="agent-vs-file-workspace"${showChatWorkspace ? ' hidden' : ''}>
                    <div class="agent-vs-preview-head">${previewMeta}</div>
                    <pre class="agent-vs-preview">${escapeHtml(previewText)}</pre>
                </div>
            </div>
        </div>
    </section>`;
}

const PANEL_CSS = `
.agent-vs-shell {
    border: 1px solid var(--border-color);
    border-radius: 8px;
    overflow: hidden;
    background: var(--card-bg);
    margin-bottom: 0.75rem;
}

.agent-vs-toolbar {
    display: grid;
    grid-template-columns: minmax(180px, 36%) 1fr;
    align-items: center;
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--border-color);
    background: rgba(127, 127, 127, 0.06);
}

.agent-vs-toolbar-left {
    display: inline-flex;
    gap: 0.5rem;
    align-items: center;
    padding: 0 0.6rem;
    border-right: 1px solid var(--border-color);
    min-height: 100%;
}

.agent-vs-btn {
    border: 1px solid var(--border-color);
    border-radius: 6px;
    background: transparent;
    color: var(--text-primary);
    padding: 0.25rem 0.5rem;
    font-size: 0.8rem;
    cursor: pointer;
}

.agent-vs-workspace-strip {
    display: flex;
    align-items: stretch;
    min-width: 0;
    flex: 1;
    justify-content: flex-start;
    margin-left: 0;
    padding: 0 0.3rem;
}

.agent-vs-permission {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.6rem;
    padding: 0.6rem;
    border-bottom: 1px solid var(--border-color);
    background: rgba(255, 186, 69, 0.1);
}

.agent-vs-permission-text {
    font-size: 0.78rem;
    line-height: 1.35;
}

.agent-vs-permission-actions {
    display: inline-flex;
    gap: 0.5rem;
}

.agent-vs-body {
    display: grid;
    grid-template-columns: minmax(180px, 36%) 1fr;
    min-height: 56vh;
    height: 56vh;
}

.agent-vs-tree {
    border-right: 1px solid var(--border-color);
    overflow: auto;
    max-height: 56vh;
    padding: 0.35rem 0;
}

.agent-vs-row {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    width: 100%;
    border: none;
    background: transparent;
    color: var(--text-primary);
    padding: 0.2rem 0.4rem;
    cursor: pointer;
    text-align: left;
}

.agent-vs-row:hover {
    background: rgba(127, 127, 127, 0.12);
}

.agent-vs-row.file.active {
    background: rgba(56, 139, 253, 0.22);
}

.agent-vs-indent {
    width: var(--row-indent, 0px);
    min-width: var(--row-indent, 0px);
}

.agent-vs-twist {
    width: 12px;
    color: var(--text-secondary);
    text-align: center;
    font-size: 0.82rem;
}

.agent-vs-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.84rem;
}

.agent-vs-editor {
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
}

.agent-vs-open-folder {
    white-space: nowrap;
    font-size: 0.78rem;
    padding: 0.3rem 0.55rem;
    align-self: center;
    border-radius: 4px;
}

.agent-vs-subtabs {
    display: flex;
    align-items: stretch;
    gap: 0.2rem;
    padding-top: 0.2rem;
    overflow-x: auto;
    min-width: 0;
    flex: 1;
    border-bottom: none;
    margin-left: 0;
}

.agent-vs-subtabs-empty {
    color: var(--text-secondary);
    font-size: 0.78rem;
    padding: 0.45rem 0.5rem;
}

.agent-vs-subtab {
    display: inline-flex;
    align-items: center;
    border: 1px solid var(--border-color);
    border-bottom: none;
    border-top-left-radius: 6px;
    border-top-right-radius: 6px;
    background: rgba(127, 127, 127, 0.06);
    overflow: hidden;
}

.agent-vs-chat-tab {
    display: inline-flex;
    align-items: center;
    border: 1px solid var(--border-color);
    border-bottom: none;
    border-top-left-radius: 6px;
    border-top-right-radius: 6px;
    background: rgba(127, 127, 127, 0.03);
    padding: 0.25rem 0.5rem;
    font-size: 0.78rem;
    color: var(--text-primary);
    white-space: nowrap;
    cursor: pointer;
}

.agent-vs-chat-tab.active {
    background: rgba(56, 139, 253, 0.2);
}

.agent-vs-subtab.active {
    background: rgba(56, 139, 253, 0.2);
}

.agent-vs-subtab-main,
.agent-vs-subtab-close {
    border: none;
    background: transparent;
    color: var(--text-primary);
    cursor: pointer;
}

.agent-vs-subtab-main {
    max-width: 180px;
    padding: 0.25rem 0.45rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 0.78rem;
}

.agent-vs-subtab-close {
    padding: 0.25rem 0.36rem;
    opacity: 0.72;
}

.agent-vs-preview-head {
    padding: 0.42rem 0.55rem;
    border-bottom: 1px solid var(--border-color);
    font-size: 0.74rem;
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.agent-vs-preview {
    margin: 0;
    padding: 0.6rem;
    overflow: auto;
    max-height: none;
    height: 100%;
    font-size: 0.77rem;
    line-height: 1.42;
    white-space: pre-wrap;
}

.agent-vs-chat-workspace {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
    border-top: 1px solid var(--border-color);
}

.agent-vs-chat-host {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
    width: 100%;
    overflow: hidden;
}

.agent-vs-file-workspace {
    display: flex;
    flex-direction: column;
    min-height: 0;
    height: 100%;
}

.agent-vs-chat-workspace[hidden],
.agent-vs-file-workspace[hidden] {
    display: none !important;
}

.agent-vs-chat-host .messages-container {
    min-height: 0;
    height: 100%;
    max-height: 100%;
    overflow-y: auto !important;
    overflow-x: hidden !important;
    margin: 0;
    border-radius: 0;
}

.agent-vs-empty {
    padding: 0.5rem;
    color: var(--text-secondary);
    font-size: 0.82rem;
}

@media (max-width: 900px) {
    .agent-vs-body {
        grid-template-columns: 1fr;
        min-height: 44vh;
        height: 44vh;
    }

    .agent-vs-tree {
        max-height: 40vh;
        border-right: none;
        border-bottom: 1px solid var(--border-color);
    }

    .agent-vs-workspace-strip {
        margin-left: 0.35rem;
    }
}
`;

module.exports = {
    onEnable(context) {
        context.registerChatUI({
            title: 'Agent Files',
            css: PANEL_CSS,
            renderPanel,
            actions: {
                refresh({ agentInfo }) {
                    return { success: true, html: renderPanel(agentInfo) };
                },
                'use-default-root'({ agentInfo }) {
                    const { state, defaultRoot } = getAgentState(agentInfo);
                    state.pendingRootPath = '';
                    state.rootPath = defaultRoot;
                    state.openFiles = [];
                    state.activeFile = '';
                    state.expanded = new Set(DEFAULT_EXPANDED);
                    return { success: true, html: renderPanel(agentInfo) };
                },
                'use-agent-home'({ agentInfo }) {
                    const home = normalizeDir(agentInfo?.folderPath || '');
                    if (!home || !fs.existsSync(home) || !fs.statSync(home).isDirectory()) {
                        return { success: true, html: renderPanel(agentInfo) };
                    }
                    return attemptRootChange(agentInfo, { directoryPath: home });
                },
                'open-folder'({ agentInfo }) {
                    const home = normalizeDir(agentInfo?.folderPath || '');
                    if (home && fs.existsSync(home) && fs.statSync(home).isDirectory()) {
                        return attemptRootChange(agentInfo, { directoryPath: home });
                    }
                    const { defaultRoot } = getAgentState(agentInfo);
                    return attemptRootChange(agentInfo, { directoryPath: defaultRoot });
                },
                'set-workspace-tab'({ agentInfo, payload }) {
                    const { state } = getAgentState(agentInfo);
                    const tabKey = String(payload.tabKey || '').replace(/\\/g, '/');
                    if (tabKey === 'chat') {
                        state.workspaceTab = 'chat';
                        return { success: true, html: renderPanel(agentInfo) };
                    }
                    if (tabKey && state.openFiles.includes(tabKey)) {
                        state.workspaceTab = tabKey;
                        state.activeFile = tabKey;
                    }
                    return { success: true, html: renderPanel(agentInfo) };
                },
                'set-root-directory'({ agentInfo, payload }) {
                    return attemptRootChange(agentInfo, payload);
                },
                'approve-root-change'({ agentInfo }) {
                    const { state } = getAgentState(agentInfo);
                    if (!state.pendingRootPath) {
                        return { success: true, html: renderPanel(agentInfo) };
                    }
                    const pending = state.pendingRootPath;
                    state.allowedOutsideRoots.add(pending);
                    state.rootPath = pending;
                    state.pendingRootPath = '';
                    state.openFiles = [];
                    state.activeFile = '';
                    state.expanded = new Set(DEFAULT_EXPANDED);
                    return { success: true, html: renderPanel(agentInfo) };
                },
                'deny-root-change'({ agentInfo }) {
                    const { state } = getAgentState(agentInfo);
                    state.pendingRootPath = '';
                    return { success: true, html: renderPanel(agentInfo) };
                },
                'toggle-dir'({ agentInfo, payload }) {
                    const { state } = getAgentState(agentInfo);
                    const relativePath = String(payload.relativePath || '').replace(/\\/g, '/');
                    if (state.expanded.has(relativePath)) {
                        state.expanded.delete(relativePath);
                    } else {
                        state.expanded.add(relativePath);
                    }
                    return { success: true, html: renderPanel(agentInfo) };
                },
                'open-file'({ agentInfo, payload }) {
                    const { state } = getAgentState(agentInfo);
                    const relativePath = String(payload.relativePath || '').replace(/\\/g, '/');
                    if (!relativePath) {
                        return { success: true, html: renderPanel(agentInfo) };
                    }
                    ensureOpenFile(state, relativePath);
                    const parentDir = path.posix.dirname(relativePath);
                    if (parentDir && parentDir !== '.') {
                        let current = '';
                        parentDir.split('/').forEach(part => {
                            current = current ? `${current}/${part}` : part;
                            state.expanded.add(current);
                        });
                    }
                    return { success: true, html: renderPanel(agentInfo) };
                },
                'close-file'({ agentInfo, payload }) {
                    const { state } = getAgentState(agentInfo);
                    closeOpenFile(state, payload.relativePath);
                    return { success: true, html: renderPanel(agentInfo) };
                }
            },
            onTabActivated(agentInfo, payload, pluginContext) {
                pluginContext.log(`File explorer active for ${agentInfo.name}`);
            }
        });
        context.log('Agent VS-style file browser UI registered');
    },
    onDisable() {
        stateByAgent.clear();
        console.log('[agent-file-browser] Disabled');
    }
};
