// @ts-nocheck
const PROFILE_GROUP_FIELDS = {
    unsafe: 'unsafe_enabled',
    web: 'web_enabled',
    ports: 'ports_enabled',
    visual: 'visual_enabled'
};
const TERMINAL_MODES = new Set(['off', 'workspace', 'system']);
const AGENT_PRESETS = {
    developer: {
        id: 'developer',
        label: 'Developer',
        profile: {
            main_enabled: true,
            preset_id: 'developer',
            files_mode: 'full',
            terminal_mode: 'workspace',
            unsafe_enabled: true,
            web_enabled: true,
            terminal_enabled: true,
            ports_enabled: true,
            visual_enabled: false
        }
    }
};

class ToolPermissionService {
    constructor({ db, capabilityManager, mcpServer, agentManager, store }) {
        this.db = db;
        this.capabilityManager = capabilityManager;
        this.mcpServer = mcpServer;
        this.agentManager = agentManager;
        this.store = store;
        this.runScopedGrants = new Map();
    }

    async initialize() {
        await this.store.initialize();
    }

    async resolveContext(context = {}) {
        const resolvedAgentId = await this._resolveAgentId(context);
        if (!resolvedAgentId) {
            return this._buildGlobalContext();
        }

        await this.ensureAgentProfile(resolvedAgentId, { requestContext: context.requestContext || null });
        const profileRow = this.store.getAgentProfile(resolvedAgentId);
        const agentToolStates = this.store.getAgentToolStates(resolvedAgentId);
        const global = await this._buildGlobalContext();
        const groups = { ...global.groups };

        groups.files = String(profileRow?.files_mode || global.groups.files || 'read');
        groups.terminal = this._normalizeTerminalMode(profileRow?.terminal_mode, profileRow?.terminal_enabled);
        for (const [groupId, field] of Object.entries(PROFILE_GROUP_FIELDS)) {
            if (profileRow && Object.prototype.hasOwnProperty.call(profileRow, field)) {
                groups[groupId] = profileRow[field] === 1;
            }
        }

        const output = {
            scope: 'agent',
            agentId: resolvedAgentId,
            mainEnabled: profileRow ? profileRow.main_enabled === 1 : global.mainEnabled,
            groups,
            toolStates: {},
            activeToolNames: [],
            source: {
                agentProfile: true
            }
        };

        const toolNames = this._getAllKnownTools();
        for (const toolName of toolNames) {
            if (!await this._isToolVisibleForAgent(toolName, resolvedAgentId, context)) {
                output.toolStates[toolName] = false;
                continue;
            }
            const active = await this._resolveToolActiveForAgent({
                toolName,
                agentToolStates,
                groups,
                mainEnabled: output.mainEnabled,
                global,
                profileRow
            });
            output.toolStates[toolName] = active;
            if (active) output.activeToolNames.push(toolName);
        }

        return output;
    }

    async isToolAllowed({ toolName, context = {} }) {
        const normalizedTool = String(toolName);
        const resolved = await this.resolveContext(context);
        const resolvedAllowed = resolved.toolStates[normalizedTool] === true;
        if (resolvedAllowed) return true;

        const runGrant = this.getRunScopedGrant(context?.subagentRunId || null);
        if (runGrant && runGrant.safeTools.has(normalizedTool)) {
            return true;
        }
        return false;
    }

    async getContextActiveToolNames(context = {}) {
        const resolved = await this.resolveContext(context);
        const output = new Set(resolved.activeToolNames.slice());
        const runGrant = this.getRunScopedGrant(context?.subagentRunId || null);
        if (runGrant) {
            runGrant.safeTools.forEach(toolName => output.add(toolName));
        }
        return Array.from(output);
    }

    async getTerminalMode(context = {}) {
        const resolved = await this.resolveContext(context);
        return this._normalizeTerminalMode(resolved.groups?.terminal);
    }

    setRunScopedGrant(runId, agentId, contract = {}) {
        const key = String(runId || '').trim();
        if (!key) return;

        const safeTools = new Set(
            this._coerceToolList(contract.safeTools || contract.safe_tools)
                .filter(toolName => !this._isUnsafeTool(toolName))
        );
        const unsafeTools = new Set(this._coerceToolList(contract.unsafeTools || contract.unsafe_tools));
        this.runScopedGrants.set(key, {
            agentId: agentId ? Number(agentId) : null,
            safeTools,
            unsafeTools
        });
    }

    clearRunScopedGrant(runId) {
        const key = String(runId || '').trim();
        if (!key) return;
        this.runScopedGrants.delete(key);
    }

    getRunScopedGrant(runId) {
        const key = String(runId || '').trim();
        if (!key) return null;
        return this.runScopedGrants.get(key) || null;
    }

    async ensureAgentProfile(agentId, options = {}) {
        const current = this.store.getAgentProfile(agentId);
        if (current) return current;

        const global = await this._buildGlobalContext();
        const profile = {
            main_enabled: global.mainEnabled,
            preset_id: '',
            files_mode: global.groups.files || 'read',
            terminal_mode: this._normalizeTerminalMode(global.groups.terminal),
            unsafe_enabled: global.groups.unsafe === true,
            web_enabled: global.groups.web === true,
            terminal_enabled: this._normalizeTerminalMode(global.groups.terminal) !== 'off',
            ports_enabled: global.groups.ports === true,
            // External capture is opt-in for every newly created agent profile.
            // Existing stored profiles retain their previous value.
            visual_enabled: false
        };
        this.store.setAgentProfile(agentId, profile);

        const initialToolStates = {};
        for (const toolName of this._getAllKnownTools()) {
            const isGlobalActive = global.toolStates[toolName] === true;
            const isUnsafe = this._isUnsafeTool(toolName);
            const isScoped = await this._isToolScopedToAgent(toolName, agentId, options);

            if (isGlobalActive || isUnsafe || isScoped) {
                initialToolStates[toolName] = isScoped ? true : isGlobalActive;
            }
        }
        this.store.setManyAgentToolStates(agentId, initialToolStates);
        return this.store.getAgentProfile(agentId);
    }

    async getAgentProfile(agentId, options = {}) {
        await this.ensureAgentProfile(agentId, options);
        const profile = this.store.getAgentProfile(agentId);
        const resolved = await this.resolveContext({ agentId, requestContext: options.requestContext || null });
        return {
            profile,
            toolStates: resolved.toolStates,
            activePresetId: String(profile?.preset_id || '').trim()
        };
    }

    async setAgentGroup(agentId, groupId, value, options = {}) {
        await this.ensureAgentProfile(agentId, options);
        const row = this.store.getAgentProfile(agentId) || {};
        const next = this._cloneProfileRow(row);

        if (groupId === 'main') {
            next.main_enabled = Boolean(value);
        } else if (groupId === 'files') {
            const filesMode = ['off', 'read', 'full'].includes(String(value)) ? String(value) : 'read';
            next.files_mode = filesMode;
        } else if (groupId === 'terminal') {
            const terminalMode = this._normalizeTerminalMode(value);
            next.terminal_mode = terminalMode;
            next.terminal_enabled = terminalMode !== 'off';
        } else if (PROFILE_GROUP_FIELDS[groupId]) {
            next[PROFILE_GROUP_FIELDS[groupId]] = Boolean(value);
        } else {
            throw new Error(`Unsupported groupId "${groupId}"`);
        }

        if (!this._hasProfileChanged(this._cloneProfileRow(row), next)) {
            return this.getAgentProfile(agentId, options);
        }
        if (String(row.preset_id || '').trim()) {
            next.preset_id = '';
        }
        this.store.setAgentProfile(agentId, next);
        return this.getAgentProfile(agentId, options);
    }

    async setAgentTool(agentId, toolName, active, options = {}) {
        await this.ensureAgentProfile(agentId, options);
        const normalizedTool = String(toolName || '').trim();
        const row = this.store.getAgentProfile(agentId) || {};
        const rawToolStates = this.store.getAgentToolStates(agentId);
        const resolved = await this.resolveContext({ agentId, requestContext: options.requestContext || null });
        const requested = Boolean(active);
        const hasExplicitState = Object.prototype.hasOwnProperty.call(rawToolStates, normalizedTool);

        if (!String(row.preset_id || '').trim() && hasExplicitState && rawToolStates[normalizedTool] === requested) {
            return { success: true, agentId, toolName: normalizedTool, active: Boolean(active) };
        }
        if (
            String(row.preset_id || '').trim()
            && !hasExplicitState
            && resolved.toolStates[normalizedTool] === requested
        ) {
            return { success: true, agentId, toolName: normalizedTool, active: requested };
        }

        if (String(row.preset_id || '').trim()) {
            this.store.setAgentProfile(agentId, {
                ...this._cloneProfileRow(row),
                preset_id: ''
            });
        }
        this.store.setAgentToolState(agentId, normalizedTool, requested);
        return { success: true, agentId, toolName: normalizedTool, active: requested };
    }

    async resetAgentProfile(agentId, options = {}) {
        this.store.deleteAgentProfile(agentId);
        await this.ensureAgentProfile(agentId, options);
        return this.getAgentProfile(agentId, options);
    }

    async applyAgentPreset(agentId, presetId, options = {}) {
        await this.ensureAgentProfile(agentId, options);
        const preset = AGENT_PRESETS[String(presetId || '').trim().toLowerCase()];
        if (!preset) {
            throw new Error(`Unsupported preset "${presetId}"`);
        }
        this.store.setAgentProfile(agentId, { ...preset.profile });
        this.store.clearAgentToolStates(agentId);
        return this.getAgentProfile(agentId, options);
    }

    async deleteAgentProfile(agentId) {
        this.store.deleteAgentProfile(agentId);
        return { success: true, agentId: Number(agentId) };
    }

    async syncUnsafeFromGlobal() {
        const global = await this._buildGlobalContext();
        const unsafeEnabled = global.groups.unsafe === true;
        const unsafeTools = this._getUnsafeToolNames();
        const ids = this.store.listProfileAgentIds();

        for (const agentId of ids) {
            const row = this.store.getAgentProfile(agentId);
            if (!row) continue;
            if (String(row.preset_id || '').trim() === 'developer') {
                continue;
            }
            this.store.setAgentProfile(agentId, {
                ...this._cloneProfileRow(row),
                unsafe_enabled: unsafeEnabled,
                preset_id: ''
            });

            unsafeTools.forEach(toolName => {
                this.store.setAgentToolState(agentId, toolName, global.toolStates[toolName] === true);
            });
        }
    }

    async _isToolScopedToAgent(toolName, agentId, options = {}) {
        const def = this.mcpServer?.tools?.get(toolName)?.definition;
        const scopes = Array.isArray(def?.agentScopeSlugs) ? def.agentScopeSlugs : [];
        if (scopes.length === 0) return false;
        if (!agentId || !this.agentManager?.getAgent) return false;
        const agent = await this.agentManager.getAgent(agentId, { requestContext: options.requestContext || null });
        if (!agent) return false;
        const slug = this.agentManager?._getSafeFolderName
            ? this.agentManager._getSafeFolderName(agent.name)
            : String(agent.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        return scopes.includes(String(slug || '').trim().toLowerCase());
    }

    async _isToolVisibleForAgent(toolName, agentId = null, options = {}) {
        const def = this.mcpServer?.tools?.get(toolName)?.definition;
        const scopes = Array.isArray(def?.agentScopeSlugs) ? def.agentScopeSlugs : [];
        if (scopes.length === 0) return true;
        if (!agentId) return false;
        return this._isToolScopedToAgent(toolName, agentId, options);
    }

    _coerceToolList(list) {
        if (!Array.isArray(list)) return [];
        return list
            .map(value => String(value || '').trim())
            .filter(Boolean);
    }

    _getUnsafeToolNames() {
        const groups = this.capabilityManager?.getGroupsConfig?.() || [];
        const unsafe = groups.find(group => group.id === 'unsafe');
        return Array.isArray(unsafe?.allTools || unsafe?.tools) ? [...new Set(unsafe.allTools || unsafe.tools)] : [];
    }

    _isUnsafeTool(toolName) {
        const unsafeSet = new Set(this._getUnsafeToolNames());
        if (unsafeSet.has(toolName)) return true;
        return this.capabilityManager?.isCustomToolSafe?.(toolName) === false
            && this.capabilityManager?.customToolSafety?.has(toolName);
    }

    _getSafeTools() {
        const list = this.capabilityManager?.config?.safeTools?.tools;
        return Array.isArray(list) ? list.slice() : [];
    }

    _getAllKnownTools() {
        const fromRegistry = this.mcpServer?.getTools?.() || [];
        const names = new Set(fromRegistry.map(tool => String(tool.name || '').trim()).filter(Boolean));
        this._getSafeTools().forEach(name => names.add(String(name)));

        const groups = this.capabilityManager?.getGroupsConfig?.() || [];
        groups.forEach(group => {
            (group.allTools || group.tools || []).forEach(name => names.add(String(name)));
        });
        return Array.from(names);
    }

    _isGroupAllowedForTool(groupId, toolName, filesMode) {
        if (!groupId) return true;
        if (groupId === 'files') {
            const groups = this.capabilityManager?.getGroupsConfig?.() || [];
            const filesGroup = groups.find(group => group.id === 'files');
            const modes = filesGroup?.modes || {};
            const modeTools = new Set(modes[String(filesMode || 'read')] || []);
            return modeTools.has(toolName);
        }
        if (groupId === 'terminal') {
            return this._normalizeTerminalMode(filesMode) !== 'off';
        }
        return true;
    }

    async _resolveToolActiveForAgent({ toolName, agentToolStates, groups, mainEnabled, global, profileRow = null }) {
        if (!mainEnabled) return false;

        // Safe tools are intentionally always available while the main switch
        // is on, including when an older profile carries a stale false override.
        if (this._getSafeTools().includes(toolName)) return true;

        const groupId = this.capabilityManager?.getGroupForTool?.(toolName) || null;
        if (groupId) {
            const groupValue = groups[groupId];
            if (groupId !== 'files' && groupId !== 'terminal' && groupValue !== true) return false;
            const modeValue = groupId === 'terminal' ? groups.terminal : groups.files;
            if (!this._isGroupAllowedForTool(groupId, toolName, modeValue)) return false;
        }

        if (Object.prototype.hasOwnProperty.call(agentToolStates, toolName)) {
            return agentToolStates[toolName] === true;
        }

        if (String(profileRow?.preset_id || '').trim() === 'developer') {
            return true;
        }

        if (this._isUnsafeTool(toolName)) {
            return global.toolStates[toolName] === true;
        }

        // Inherit the global resolved state for normal tools when the agent has
        // no explicit override. This keeps older agent profiles from silently
        // losing newly added safe tools such as display_content.
        return global.toolStates[toolName] === true;
    }

    async _buildGlobalContext() {
        const groups = {};
        const groupsConfig = this.capabilityManager?.getGroupsConfig?.() || [];
        groupsConfig.forEach(group => {
            groups[group.id] = group.id === 'files' || group.id === 'terminal'
                ? (group.mode || (group.id === 'terminal' ? 'workspace' : 'read'))
                : group.enabled === true;
        });

        const mainEnabled = this.capabilityManager?.isMainEnabled?.() !== false;
        const toolStates = {};
        const activeToolNames = [];
        const toolNames = this._getAllKnownTools();
        for (const toolName of toolNames) {
            if (!await this._isToolVisibleForAgent(toolName, null)) {
                toolStates[toolName] = false;
                continue;
            }
            const active = await this.mcpServer.getToolActiveState(toolName);
            const capabilityAllowed = this.capabilityManager?.isToolActive
                ? this.capabilityManager.isToolActive(toolName)
                : true;
            const isSafe = this._getSafeTools().includes(toolName);
            toolStates[toolName] = mainEnabled && capabilityAllowed && (isSafe || active);
            if (toolStates[toolName]) activeToolNames.push(toolName);
        }

        return {
            scope: 'global',
            agentId: null,
            mainEnabled,
            groups,
            toolStates,
            activeToolNames,
            source: {
                agentProfile: false
            }
        };
    }

    async _resolveAgentId(context = {}) {
        if (context.agentId !== null && context.agentId !== undefined) {
            return Number(context.agentId) || null;
        }
        const sessionId = context.sessionId;
        if (sessionId === null || sessionId === undefined || !this.db?.get) {
            return null;
        }
        const row = this.db?.getChatSessionById
            ? await this.db.getChatSessionById(sessionId, { requestContext: context.requestContext || null })
            : this.db.get('SELECT agent_id FROM chat_sessions WHERE id = ?', [sessionId]);
        return row?.agent_id ? Number(row.agent_id) : null;
    }

    _cloneProfileRow(row = {}) {
        return {
            main_enabled: row.main_enabled === 1 || row.main_enabled === true,
            preset_id: String(row.preset_id || '').trim(),
            files_mode: row.files_mode || 'read',
            terminal_mode: this._normalizeTerminalMode(row.terminal_mode, row.terminal_enabled),
            unsafe_enabled: row.unsafe_enabled === 1 || row.unsafe_enabled === true,
            web_enabled: row.web_enabled === 1 || row.web_enabled === true,
            terminal_enabled: this._normalizeTerminalMode(row.terminal_mode, row.terminal_enabled) !== 'off',
            ports_enabled: row.ports_enabled === 1 || row.ports_enabled === true,
            visual_enabled: row.visual_enabled === 1 || row.visual_enabled === true
        };
    }

    _hasProfileChanged(current = {}, next = {}) {
        return [
            'main_enabled',
            'preset_id',
            'files_mode',
            'terminal_mode',
            'unsafe_enabled',
            'web_enabled',
            'terminal_enabled',
            'ports_enabled',
            'visual_enabled'
        ].some((key) => current[key] !== next[key]);
    }

    _normalizeTerminalMode(value, legacyEnabled = true) {
        const normalized = String(value || '').trim().toLowerCase();
        if (TERMINAL_MODES.has(normalized)) return normalized;
        return legacyEnabled === 0 || legacyEnabled === false ? 'off' : 'workspace';
    }
}

module.exports = ToolPermissionService;

