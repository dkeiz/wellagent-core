// @ts-nocheck
const fs = require('fs');
const path = require('path');
const { buildRuntimePaths, buildScopedMutableRuntimePaths } = require('./runtime-paths');
const { externalWebFetch, localProbeFetch } = require('./network-policy');
const { resolveAgentScope } = require('./agent-ownership');
const { getEffectiveLlmSelection } = require('./llm-state');

class SessionInitManager {
    constructor(db, agentMemory, eventBus, options = {}) {
        this.db = db;
        this.agentMemory = agentMemory;
        this.eventBus = eventBus;
        this.COLD_START_THRESHOLD = 8 * 60 * 60 * 1000;

        const runtimePaths = options.runtimePaths || buildRuntimePaths({
            ...options,
            agentinRoot: options.agentinPath || options.agentinRoot
        });
        this.runtimePathOptions = {
            ...options,
            agentinRoot: options.agentinPath || runtimePaths.agentinRoot
        };
        this.agentinPath = options.agentinPath || runtimePaths.agentinRoot;
        this.templatePath = options.templatePath || path.join(this.agentinPath, 'prompts/templates/cold-start-discovery.md');
        this.connectorsDir = options.connectorsDir || runtimePaths.connectorsDir;
        this.userProfilePath = options.userProfilePath || runtimePaths.userProfilePath;
        this.memoryBasePath = options.memoryBasePath || runtimePaths.memoryBasePath;
    }

    _resolveDbScope(options = {}) {
        return resolveAgentScope(options);
    }

    _resolveScopedPaths(options = {}) {
        const scope = this._resolveDbScope(options);
        return buildScopedMutableRuntimePaths({
            ...this.runtimePathOptions,
            ...scope,
            connectorsDir: null,
            knowledgeBaseDir: null,
            memoryBasePath: null,
            researchBasePath: null,
            userProfilePath: null
        });
    }

    _getScopedSettingKey(baseKey, options = {}) {
        const scope = this._resolveDbScope(options);
        return scope.userId === 'localuser' ? baseKey : `${baseKey}.${scope.userId}`;
    }

    async _getScopedSetting(baseKey, options = {}) {
        return this.db.getSetting(this._getScopedSettingKey(baseKey, options));
    }

    async _saveScopedSetting(baseKey, value, options = {}) {
        return this.db.saveSetting(this._getScopedSettingKey(baseKey, options), value);
    }

    async getScopedSetting(baseKey, options = {}) {
        return this._getScopedSetting(baseKey, options);
    }

    async saveScopedSetting(baseKey, value, options = {}) {
        return this._saveScopedSetting(baseKey, value, options);
    }

    async getBaseInitState(options = {}) {
        const [completed, timestamp, daemonEnabled] = await Promise.all([
            this._getScopedSetting('baseinit.completed', options),
            this._getScopedSetting('baseinit.timestamp', options),
            this._getScopedSetting('baseinit.daemonEnabled', options)
        ]);
        return {
            completed: String(completed || '').toLowerCase() === 'true',
            timestamp: String(timestamp || '').trim(),
            daemonEnabled: String(daemonEnabled || '').toLowerCase() === 'true'
        };
    }

    async markBaseInitComplete(options = {}) {
        const timestamp = new Date().toISOString();
        await this._saveScopedSetting('baseinit.completed', 'true', options);
        await this._saveScopedSetting('baseinit.timestamp', timestamp, options);
        await this._saveScopedSetting('baseinit.daemonEnabled', 'true', options);
        return { completed: true, timestamp, daemonEnabled: true };
    }

    async detectStartType(daemonRunning = false, options = {}) {
        const lastActivity = await this._getScopedSetting('session.lastActivity', options);
        const now = Date.now();

        let hoursSince = 999;
        if (lastActivity) {
            const lastTime = new Date(lastActivity).getTime();
            hoursSince = (now - lastTime) / (60 * 60 * 1000);
        }

        const isColdStart = hoursSince >= (this.COLD_START_THRESHOLD / (60 * 60 * 1000)) || !daemonRunning;
        return { isColdStart, hoursSinceLastActivity: Math.round(hoursSince * 10) / 10 };
    }

    async recordActivity(options = {}) {
        await this._saveScopedSetting('session.lastActivity', new Date().toISOString(), options);
    }

    async buildColdStartPrompt(hoursInactive, options = {}) {
        const capabilities = await this._scanCapabilities(options);
        const recentMemory = await this._getRecentMemory(options);
        const userProfile = await this._getUserProfile(options);
        const template = this._loadTemplate();

        return template
            .replace('{hours_inactive}', Math.round(hoursInactive).toString())
            .replace('{capabilities_summary}', capabilities)
            .replace('{recent_memory}', recentMemory)
            .replace('{user_profile}', userProfile);
    }

    async buildBaseInitReport(options = {}) {
        const dbScope = this._resolveDbScope(options);
        const report = {
            model: null,
            connectivity: {},
            capabilities: null,
            memoryHealth: null,
        };

        const { provider, model } = await getEffectiveLlmSelection(this.db, dbScope);
        report.model = { provider, model, configured: !!(provider && model) };
        report.connectivity = await this._checkConnectivity();
        report.capabilities = await this._scanCapabilitiesDetailed(dbScope);
        report.memoryHealth = await this._checkMemoryHealth(dbScope);
        return report;
    }

    async _scanCapabilities(options = {}) {
        const dbScope = this._resolveDbScope(options);
        const scopedPaths = this._resolveScopedPaths(dbScope);
        const lines = [];

        try {
            const agents = await this.db.getAgents(null, dbScope);
            const proAgents = agents.filter(a => a.type === 'pro');
            const subAgents = agents.filter(a => a.type === 'sub');
            lines.push(`- **Agents:** ${proAgents.length} pro (${proAgents.map(a => a.name).join(', ')}), ${subAgents.length} sub`);

            if (fs.existsSync(scopedPaths.connectorsDir)) {
                const connectorFiles = fs.readdirSync(scopedPaths.connectorsDir)
                    .filter(f => f.endsWith('.js') && !f.startsWith('_'));
                lines.push(`- **Connectors:** ${connectorFiles.length} available (${connectorFiles.map(f => f.replace('.js', '')).join(', ')})`);
            }

            const workflows = await this.db.getWorkflows(dbScope);
            lines.push(`- **Workflows:** ${workflows.length} saved`);

            const rules = await this.db.getActivePromptRules(dbScope);
            const allRules = await this.db.getPromptRules(dbScope);
            lines.push(`- **Rules:** ${rules.length} active / ${allRules.length} total`);

            const stats = this.agentMemory.getStats(dbScope);
            lines.push(`- **Memory:** daily=${stats.daily || 0}, global=${stats.global || 0}, tasks=${stats.tasks || 0}, images=${stats.images || 0}`);

            try {
                const schedules = this.db.all(
                    'SELECT COUNT(*) as count FROM workflow_schedules WHERE enabled = 1 AND COALESCE(user_id, ?) = ?',
                    ['localuser', dbScope.userId]
                );
                if (schedules[0]) {
                    lines.push(`- **Scheduled workflows:** ${schedules[0].count}`);
                }
            } catch (e) {
            }
        } catch (err) {
            lines.push(`- **Error scanning capabilities:** ${err.message}`);
        }

        return lines.join('\n');
    }

    async _scanCapabilitiesDetailed(options = {}) {
        const dbScope = this._resolveDbScope(options);
        const scopedPaths = this._resolveScopedPaths(dbScope);
        const result = {
            agents: { pro: [], sub: [] },
            connectors: [],
            workflows: 0,
            rules: { active: 0, total: 0 },
            memory: {},
        };

        try {
            const agents = await this.db.getAgents(null, dbScope);
            result.agents.pro = agents.filter(a => a.type === 'pro').map(a => ({ name: a.name, icon: a.icon, status: a.status }));
            result.agents.sub = agents.filter(a => a.type === 'sub').map(a => ({ name: a.name, icon: a.icon }));

            if (fs.existsSync(scopedPaths.connectorsDir)) {
                result.connectors = fs.readdirSync(scopedPaths.connectorsDir)
                    .filter(f => f.endsWith('.js') && !f.startsWith('_'))
                    .map(f => f.replace('.js', ''));
            }

            result.workflows = (await this.db.getWorkflows(dbScope)).length;
            const allRules = await this.db.getPromptRules(dbScope);
            const activeRules = await this.db.getActivePromptRules(dbScope);
            result.rules = { active: activeRules.length, total: allRules.length };
            result.memory = this.agentMemory.getStats(dbScope);
        } catch (e) {
            result.error = e.message;
        }

        return result;
    }

    async _getRecentMemory(options = {}) {
        const dbScope = this._resolveDbScope(options);
        try {
            const dailyResult = await this.agentMemory.read('daily', null, dbScope);
            if (dailyResult.content) {
                return dailyResult.content.substring(0, 600);
            }

            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            const yStr = yesterday.toISOString().split('T')[0];
            const yResult = await this.agentMemory.read('daily', `${yStr}.md`, dbScope);
            if (yResult.content) {
                return `(Yesterday) ${yResult.content.substring(0, 400)}`;
            }

            return 'No recent memory entries found.';
        } catch (e) {
            return 'Unable to read memory.';
        }
    }

    async _getUserProfile(options = {}) {
        const scopedPaths = this._resolveScopedPaths(options);
        try {
            if (fs.existsSync(scopedPaths.userProfilePath)) {
                const content = fs.readFileSync(scopedPaths.userProfilePath, 'utf-8').trim();
                return content || 'No user profile data yet.';
            }
        } catch (e) { }
        return 'No user profile data yet.';
    }

    async _checkConnectivity() {
        const result = { internet: false, providers: {} };

        try {
            const response = await externalWebFetch('http://www.google.com', { method: 'HEAD' }, {
                label: 'Internet connectivity check',
                timeoutMs: 5000
            });
            result.internet = response.status < 400;
        } catch (e) {
            result.internet = false;
        }

        try {
            const ollamaHost = process.env.OLLAMA_HOST || 'localhost:11434';
            const response = await localProbeFetch(`http://${ollamaHost}/api/tags`, {}, {
                label: 'Ollama startup probe',
                timeoutMs: 3000
            });
            result.providers.ollama = response.status === 200;
        } catch (e) {
            result.providers.ollama = false;
        }

        return result;
    }

    async _checkMemoryHealth(options = {}) {
        const dbScope = this._resolveDbScope(options);
        const scopedPaths = this._resolveScopedPaths(dbScope);
        const health = { ok: true, issues: [] };

        try {
            const stats = this.agentMemory.getStats(dbScope);
            if (!fs.existsSync(scopedPaths.memoryBasePath)) {
                health.ok = false;
                health.issues.push('Memory directory missing');
            }
            if (!fs.existsSync(scopedPaths.userProfilePath)) {
                health.issues.push('User profile file missing (will be created on first observation)');
            }
            health.stats = stats;
        } catch (e) {
            health.ok = false;
            health.issues.push(e.message);
        }

        return health;
    }

    _loadTemplate() {
        try {
            if (fs.existsSync(this.templatePath)) {
                return fs.readFileSync(this.templatePath, 'utf-8');
            }
        } catch (e) { }

        return `You are starting a new session after {hours_inactive} hours of inactivity.

Discovered capabilities:
{capabilities_summary}

Recent memory:
{recent_memory}

User profile:
{user_profile}

Review your state and greet the user with awareness of what's available.`;
    }
}

module.exports = SessionInitManager;
