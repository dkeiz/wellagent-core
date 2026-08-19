// @ts-nocheck
const fs = require('fs');
const path = require('path');
const { getDefaultAgents } = require('./agent-defaults');
const { buildRuntimePaths } = require('./runtime-paths');
const { resolveAgentScope, getScopedAgentBasePath } = require('./agent-ownership');

const { invokeMultipleSubAgents } = require('./agent-batch-invoker');
const SubtaskRuntime = require('./subtask-runtime');
const AgentSubagentContractMethods = require('./agent-subagent-contract-methods');
const AgentSubagentRunMethods = require('./agent-subagent-run-methods');

const DEFAULT_AGENT_ADDITION_SYNC_KEY = 'agents.defaultAdditionsSynced.v7.writing-comfy-setup-search-room-coding';
const DEFAULT_AGENT_PLUGIN_SYNC_KEY = 'agents.defaultPluginsSynced.v5.book-comfy-setup-room-coding';
const DEFAULT_AGENT_ADDITION_NAMES = ['Agents Room', 'Writing Studio', 'ComfyUI Studio', 'Setup Superagent', 'Search Agent', 'Coding'];

class AgentManager {
    constructor(db, dispatcher, agentLoop, agentMemory, sessionWorkspace = null, chainController = null, eventBus = null, subtaskRuntime = null, options = {}) {
        this.db = db;
        this.dispatcher = dispatcher;
        this.agentLoop = agentLoop;
        this.agentMemory = agentMemory;
        this.sessionWorkspace = sessionWorkspace;
        this.chainController = chainController;
        this.eventBus = eventBus;
        this.subtaskRuntime = subtaskRuntime || new SubtaskRuntime(db, sessionWorkspace, eventBus);
        this.pendingSubtasks = new Map();
        this.activeSubtaskCounts = new Map();
        this.providerSubtaskQueues = new Map();
        this.cancelledSubtaskRuns = new Set();
        this.pluginManager = options.pluginManager || null;
        this.toolPermissionService = options.toolPermissionService || null;
        this.userRegistry = options.userRegistry || null;
        this.basePath = options.basePath || buildRuntimePaths(options).agentBasePath;
        this.maxDelegatedCompletionRetries = Math.max(0, Number(options.maxDelegatedCompletionRetries) || 2);
    }

    setPluginManager(pluginManager) {
        this.pluginManager = pluginManager;
    }

    setToolPermissionService(toolPermissionService) {
        this.toolPermissionService = toolPermissionService || null;
    }

    _listUserScopes() {
        const scopes = [];
        const seen = new Set();
        const users = this.userRegistry?.listUsers ? this.userRegistry.listUsers() : [{ userId: 'localuser' }];
        for (const user of users) {
            const scope = resolveAgentScope({ userId: user?.userId || 'localuser' });
            if (seen.has(scope.userId)) continue;
            seen.add(scope.userId);
            scopes.push(scope);
        }
        if (!seen.has('localuser')) {
            scopes.unshift(resolveAgentScope({ userId: 'localuser' }));
        }
        return scopes;
    }

    _getScopedSettingKey(baseKey, options = {}) {
        const scope = resolveAgentScope(options);
        return scope.userId === 'localuser' ? baseKey : `${baseKey}.${scope.userId}`;
    }

    async initialize() {
        const dirs = [
            this.basePath,
            path.join(this.basePath, 'pro'),
            path.join(this.basePath, 'sub')
        ];
        for (const dir of dirs) {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        }

        const skipDefaultAgentBootstrap = process.env.LOCALAGENT_SKIP_AGENT_BOOTSTRAP === '1';
        for (const scope of this._listUserScopes()) {
            await this._migrateBackgroundDaemonOutOfPro(scope);
            await this._migrateDefaultAgentNames(scope);
            const existingAgents = await this.db.getAgents(null, scope);
            if (!skipDefaultAgentBootstrap) {
                await this._seedDefaultAgents(existingAgents, scope);
                await this._syncDefaultAgentAdditions(scope);
            }

            for (const agent of await this.db.getAgents(null, scope)) {
                this._ensureAgentFolder(agent, scope);
            }
        }

        if (this.subtaskRuntime) {
            this.subtaskRuntime.initialize();
        }
    }

    async initializeUser(userId, sourceUserId = null) {
        const scope = resolveAgentScope({ userId });
        const userAgentRoot = getScopedAgentBasePath(this.basePath, scope);
        fs.mkdirSync(userAgentRoot, { recursive: true });

        if (sourceUserId) {
            const sourceScope = resolveAgentScope({ userId: sourceUserId });
            const sourceAgents = await this.db.getAgents(null, sourceScope);
            for (const sourceAgent of sourceAgents) {
                const config = this._parseAgentConfig(sourceAgent.config);
                const created = await this.createAgent({
                    name: sourceAgent.name,
                    type: sourceAgent.type,
                    icon: sourceAgent.icon,
                    system_prompt: sourceAgent.system_prompt,
                    description: sourceAgent.description,
                    config
                }, scope);
                const sourceFolder = this._getAgentFolderPath(sourceAgent, sourceScope);
                const targetFolder = this._getAgentFolderPath(created, scope);
                for (const durableName of ['memory', 'config', 'tasks']) {
                    const sourcePath = path.join(sourceFolder, durableName);
                    const targetPath = path.join(targetFolder, durableName);
                    if (!fs.existsSync(sourcePath)) continue;
                    fs.cpSync(sourcePath, targetPath, { recursive: true, force: true });
                }
            }
        } else {
            await this._seedDefaultAgents([], scope);
            await this._syncDefaultAgentAdditions(scope);
        }

        const agents = await this.db.getAgents(null, scope);
        for (const agent of agents) this._ensureAgentFolder(agent, scope);
        return { userId: scope.userId, agentCount: agents.length, agentRoot: userAgentRoot };
    }

    async _seedDefaultAgents(existingAgents = null, options = {}) {
        const scope = resolveAgentScope(options);
        const seedSettingKey = this._getScopedSettingKey('agents.defaultsSeeded.v1', scope);
        const seedState = await this.db.getSetting(seedSettingKey);
        if (String(seedState || '').toLowerCase() === 'true') {
            return;
        }

        const defaults = getDefaultAgents();
        const currentAgents = existingAgents || await this.db.getAgents(null, scope);
        const existingNames = new Set(currentAgents
            .map(agent => String(agent.name || '').trim().toLowerCase()));
        let created = 0;

        for (const agentDef of defaults) {
            if (existingNames.has(String(agentDef.name).trim().toLowerCase())) {
                continue;
            }
            try {
                await this.createAgent(agentDef, scope);
                created++;
            } catch (e) {
                console.error(`[AgentManager] Failed to seed agent "${agentDef.name}":`, e.message);
            }
        }

        await this.db.saveSetting(seedSettingKey, 'true');
        if (created > 0) {
            console.log(`[AgentManager] Seeded ${created} default agent(s) for ${scope.userId}`);
        }
    }

    _parseAgentConfig(raw) {
        if (!raw) return {};
        if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
        if (typeof raw !== 'string') return {};
        try {
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch (_) {
            return {};
        }
    }

    _defaultAgentAdditions() {
        const wanted = new Set(DEFAULT_AGENT_ADDITION_NAMES.map(name => name.toLowerCase()));
        return getDefaultAgents().filter(agent => wanted.has(String(agent.name || '').toLowerCase()));
    }

    _buildDefaultAgentRepair(existing, agentDef) {
        const patch = {};
        if (String(existing.type || '').toLowerCase() !== String(agentDef.type || 'pro').toLowerCase()) {
            patch.type = agentDef.type || 'pro';
        }
        if (!existing.icon && agentDef.icon) patch.icon = agentDef.icon;
        if (!existing.description && agentDef.description) patch.description = agentDef.description;
        if (!existing.system_prompt && agentDef.system_prompt) patch.system_prompt = agentDef.system_prompt;

        const existingConfig = this._parseAgentConfig(existing.config);
        const requiredPlugin = agentDef.config?.chat_ui_plugin;
        if (requiredPlugin && existingConfig.chat_ui_plugin !== requiredPlugin) {
            patch.config = { ...existingConfig, chat_ui_plugin: requiredPlugin };
        }

        const folderName = this._getSafeFolderName(agentDef.name);
        const folderPath = `${agentDef.type || 'pro'}/${folderName}`;
        if (!existing.folder_path) patch.folder_path = folderPath;

        return patch;
    }

    async _syncDefaultAgentAdditions(options = {}) {
        const scope = resolveAgentScope(options);
        const syncSettingKey = this._getScopedSettingKey(DEFAULT_AGENT_ADDITION_SYNC_KEY, scope);
        const syncState = await this.db.getSetting(syncSettingKey);
        if (String(syncState || '').toLowerCase() === 'true') return;

        const additions = this._defaultAgentAdditions();
        const agents = await this.db.getAgents(null, scope);
        const existingByName = new Map(
            agents.map(agent => [String(agent.name || '').trim().toLowerCase(), agent])
        );

        let created = 0;
        let repaired = 0;
        let errors = 0;
        for (const agentDef of additions) {
            const key = String(agentDef.name || '').trim().toLowerCase();
            const existing = existingByName.get(key);
            if (!existing) {
                try {
                    await this.createAgent(agentDef, scope);
                    created++;
                } catch (e) {
                    errors++;
                    console.error(`[AgentManager] Failed to add default agent "${agentDef.name}":`, e.message);
                }
                continue;
            }

            const patch = this._buildDefaultAgentRepair(existing, agentDef);
            if (Object.keys(patch).length > 0) {
                try {
                    this._ensureAgentFolder({ ...existing, ...patch, name: agentDef.name }, scope);
                    await this.updateAgent(existing.id, patch, scope);
                    repaired++;
                } catch (e) {
                    errors++;
                    console.error(`[AgentManager] Failed to repair default agent "${agentDef.name}":`, e.message);
                }
            }
        }

        if (errors === 0) {
            await this.db.saveSetting(syncSettingKey, 'true');
        }
        if (created > 0 || repaired > 0) {
            console.log(`[AgentManager] Synced default agent additions for ${scope.userId}: ${created} created, ${repaired} repaired`);
        }
    }

    async syncDefaultAgentPlugins(pluginManager = this.pluginManager) {
        if (!pluginManager?.enablePlugin) {
            return { success: false, error: 'PluginManager unavailable', enabled: [] };
        }
        const syncState = await this.db.getSetting(DEFAULT_AGENT_PLUGIN_SYNC_KEY);
        if (String(syncState || '').toLowerCase() === 'true') {
            return { success: true, skipped: true, enabled: [] };
        }

        const pluginIds = new Set();
        for (const agentDef of this._defaultAgentAdditions()) {
            const pluginId = String(agentDef.config?.chat_ui_plugin || '').trim();
            if (pluginId) pluginIds.add(pluginId);
        }

        const enabled = [];
        const missing = [];
        const errors = [];
        for (const pluginId of pluginIds) {
            if (pluginManager.plugins && !pluginManager.plugins.has(pluginId)) {
                missing.push(pluginId);
                continue;
            }
            try {
                await pluginManager.enablePlugin(pluginId, { persistStatus: true, userId: 'localuser' });
                enabled.push(pluginId);
            } catch (e) {
                errors.push({ pluginId, error: e.message });
                console.error(`[AgentManager] Failed to enable default agent plugin "${pluginId}":`, e.message);
            }
        }

        if (errors.length === 0 && missing.length === 0) {
            await this.db.saveSetting(DEFAULT_AGENT_PLUGIN_SYNC_KEY, 'true');
        }
        return { success: errors.length === 0, enabled, missing, errors };
    }

    _ensureAgentFolder(agent, options = {}) {
        const folderPath = this._getAgentFolderPath(agent, options);
        const subDirs = agent.type === 'pro'
            ? ['memory', 'config', 'sessions', 'tasks', 'outputs']
            : ['temp', 'sessions', 'tasks', 'outputs'];

        if (!fs.existsSync(folderPath)) {
            fs.mkdirSync(folderPath, { recursive: true });
        }
        for (const sub of subDirs) {
            const subPath = path.join(folderPath, sub);
            if (!fs.existsSync(subPath)) {
                fs.mkdirSync(subPath, { recursive: true });
            }
        }

        const systemFile = path.join(folderPath, 'system.md');
        if (!fs.existsSync(systemFile) && agent.system_prompt) {
            fs.writeFileSync(systemFile, agent.system_prompt, 'utf-8');
        }
    }

    _getAgentFolderPath(agent, options = {}) {
        const safeName = this._getSafeFolderName(agent.name || `agent-${agent.id || 'unknown'}`);
        const relativePath = String(agent.folder_path || path.join(agent.type || 'pro', safeName)).replace(/\\/g, '/');
        const scope = resolveAgentScope({ ...options, userId: agent.user_id || agent.userId });
        const base = path.resolve(getScopedAgentBasePath(this.basePath, scope));
        const resolved = path.resolve(base, relativePath);
        if (resolved !== base && !resolved.startsWith(base + path.sep)) {
            throw new Error('Agent folder path is outside the agent root');
        }
        return resolved;
    }

    _getSafeFolderName(name) {
        return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
    }

    async _migrateBackgroundDaemonOutOfPro(options = {}) {
        const scope = resolveAgentScope(options);
        const agents = await this.db.getAgents(null, scope);
        for (const agent of agents) {
            const name = String(agent?.name || '').trim().toLowerCase();
            if (name !== 'background daemon') continue;
            if (String(agent?.type || '').toLowerCase() !== 'pro') continue;
            const folderName = this._getSafeFolderName(agent.name || 'background-daemon');
            await this.db.updateAgent(agent.id, {
                type: 'daemon',
                folder_path: `daemon/${folderName}`
            }, scope);
        }
    }

    async _migrateDefaultAgentNames(options = {}) {
        const scope = resolveAgentScope(options);
        const agents = await this.db.getAgents(null, scope);
        const byName = new Map(
            agents.map((agent) => [String(agent?.name || '').trim().toLowerCase(), agent])
        );
        const migrations = [
            { oldName: 'web researcher', newName: 'web search', displayName: 'Web Search' },
            { oldName: 'book writer', newName: 'writing studio', displayName: 'Writing Studio' }
        ];
        for (const migration of migrations) {
            if (!byName.has(migration.oldName) || byName.has(migration.newName)) continue;
            const source = byName.get(migration.oldName);
            await this.db.updateAgent(source.id, { name: migration.displayName }, scope);
            byName.delete(migration.oldName);
            byName.set(migration.newName, { ...source, name: migration.displayName });
        }
    }

    async createAgent({ name, type = 'pro', icon = '🤖', system_prompt, description, config }, options = {}) {
        const folderName = this._getSafeFolderName(name);
        const folderPath = `${type}/${folderName}`;
        const scope = resolveAgentScope(options);
        const agent = await this.db.addAgent({
            name, type, icon, system_prompt, description, config, folder_path: folderPath
        }, scope);
        this._ensureAgentFolder({ ...agent, type, name }, scope);
        return agent;
    }

    async updateAgent(id, data, options = {}) {
        const scope = resolveAgentScope(options);
        const result = await this.db.updateAgent(id, data, scope);
        if (data.system_prompt) {
            const agent = await this.db.getAgent(id, scope);
            if (agent) {
                const folderPath = this._getAgentFolderPath(agent, scope);
                const systemFile = path.join(folderPath, 'system.md');
                fs.writeFileSync(systemFile, data.system_prompt, 'utf-8');
            }
        }
        return result;
    }

    async setAgentSidebarVisible(id, visible, options = {}) {
        const visibleInSidebar = visible === true;
        const scope = resolveAgentScope(options);
        await this.db.updateAgent(id, { visible_in_sidebar: visibleInSidebar ? 1 : 0 }, scope);
        return { id, visibleInSidebar, user_id: scope.userId };
    }

    async deleteAgent(id, options = {}) {
        const scope = resolveAgentScope(options);
        const agent = await this.db.getAgent(id, scope);
        const folderPath = agent ? this._getAgentFolderPath(agent, scope) : null;
        const result = await this.db.deleteAgent(id, scope);
        let folderRemoved = false;
        if (folderPath && fs.existsSync(folderPath)) {
            fs.rmSync(folderPath, { recursive: true, force: true });
            folderRemoved = true;
        }
        return { ...result, folderRemoved };
    }

    async getAgents(type = null, options = {}) {
        return await this.db.getAgents(type, resolveAgentScope(options));
    }

    async getAgent(id, options = {}) {
        return await this.db.getAgent(id, resolveAgentScope(options));
    }

    _agentAsSubagentRun(agent) {
        if (!agent || agent.type !== 'sub') {
            return null;
        }
        return {
            id: agent.id,
            run_id: String(agent.id),
            status: agent.status || 'idle',
            subagent_id: agent.id,
            agent_name: agent.name || `Subagent ${agent.id}`,
            parent_session_id: null,
            child_session_id: null,
            task: agent.description || '',
            summary: '',
            error: null,
            created_at: agent.created_at || null,
            completed_at: null,
            subagent_mode: 'no_ui',
            source: 'agent'
        };
    }

    async activateAgent(agentId, options = {}) {
        const scope = resolveAgentScope(options);
        const agent = await this.db.getAgent(agentId, scope);
        if (!agent) throw new Error(`Agent ${agentId} not found`);
        await this.db.updateAgent(agentId, { status: 'active' }, scope);
        let session = await this.db.getAgentSession(agentId, scope);
        if (!session) {
            session = await this.db.createAgentSession(agentId, null, scope);
        }
        return { agent, sessionId: session.id };
    }

    async deactivateAgent(agentId, options = {}) {
        const scope = resolveAgentScope(options);
        const agent = await this.db.getAgent(agentId, scope);
        if (!agent) return;
        if (agent.type === 'pro') {
            try {
                await this.compactAgent(agentId, scope);
            } catch (e) {
                console.error(`[AgentManager] Compact failed for agent ${agentId}:`, e.message);
            }
        }
        await this.db.updateAgent(agentId, { status: 'idle' }, scope);
    }

    async compactAgent(agentId, options = {}) {
        const scope = resolveAgentScope(options);
        const agent = await this.db.getAgent(agentId, scope);
        if (!agent || agent.type !== 'pro') return;
        const session = await this.db.getAgentSession(agentId, scope);
        if (!session) return;
        const messages = await this.db.getConversations(100, session.id, scope);
        if (messages.length < 4) return;
        const historyText = messages
            .map(m => `${m.role}: ${m.content}`)
            .slice(-20)
            .join('\n');
        try {
            const result = await this.dispatcher.dispatch(
                `Summarize this conversation concisely. Focus on key decisions, findings, and action items:\n\n${historyText}`,
                [],
                { mode: 'internal', includeTools: false, includeRules: false, requestContext: scope.requestContext }
            );
            const folderPath = this._getAgentFolderPath(agent, scope);
            const compactFile = path.join(folderPath, 'memory', 'compact.md');
            const timestamp = new Date().toISOString();
            const entry = `\n\n---\n[${timestamp}] Session Compact\n${result.content}\n`;
            fs.appendFileSync(compactFile, entry);
            console.log(`[AgentManager] Compacted agent "${agent.name}" to ${compactFile}`);
        } catch (e) {
            console.error('[AgentManager] Compact dispatch failed:', e.message);
        }
    }

    getAgentSystemPrompt(agent) {
        const folderPath = this._getAgentFolderPath(agent);
        const systemFile = path.join(folderPath, 'system.md');

        try {
            if (fs.existsSync(systemFile)) {
                return fs.readFileSync(systemFile, 'utf-8');
            }
        } catch (e) {
            console.error('[AgentManager] Failed to read agent system.md:', e.message);
        }

        return agent.system_prompt || '';
    }

    getAgentMemory(agent) {
        const folderPath = this._getAgentFolderPath(agent);
        const compactFile = path.join(folderPath, 'memory', 'compact.md');

        try {
            if (fs.existsSync(compactFile)) {
                return fs.readFileSync(compactFile, 'utf-8');
            }
        } catch (e) {
        }

        return null;
    }

    async resolveAgentFolder(agentId, options = {}) {
        const scope = resolveAgentScope(options);
        const agent = await this.db.getAgent(agentId, scope);
        if (!agent) return null;
        return this._getAgentFolderPath(agent, scope);
    }

    async invokeMultipleSubAgents(parentSessionId, tasks, options = {}) {
        return invokeMultipleSubAgents(this, parentSessionId, tasks, options);
    }

    async onAppQuit() {
        for (const scope of this._listUserScopes()) {
            const agents = await this.db.getAgents(null, scope);
            for (const agent of agents) {
                if (agent.status === 'active') {
                    await this.deactivateAgent(agent.id, scope);
                }
            }
        }
    }
}

function applyMixin(target, sourcePrototype) {
    const descriptors = Object.getOwnPropertyDescriptors(sourcePrototype);
    delete descriptors.constructor;
    Object.defineProperties(target, descriptors);
}

applyMixin(AgentManager.prototype, AgentSubagentContractMethods.prototype);
applyMixin(AgentManager.prototype, AgentSubagentRunMethods.prototype);

module.exports = AgentManager;
