// @ts-nocheck
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { decryptSecret, encryptSecret } = require('./secure-secret-store');
const { resolveDbPath } = require('./database-paths');
const { runDatabaseMigrations } = require('./database-migrations');
const chatOwnership = require('./chat-ownership-store');
const requestContextHelpers = require('./request-context');
const { mapPromptRuleRow, resolvePromptScope } = require('./prompt-ownership');
const { mapWorkflowRow, resolveWorkflowScope } = require('./workflow-ownership');
const { mapAgentRow, mapSubagentRunOwnership, resolveAgentScope } = require('./agent-ownership');
const { isBuiltInUserId, normalizeUserId, requireUserScope } = require('./user-scope');
const { migrateRemoteGatewaySecret, migrateSecretSettingsToCredentials } = require('./settings-security');
const TENANT_SCOPED_SETTING_PATTERNS = Object.freeze([
    /^open_chat_tabs$/,
    /^active_chat_tab$/,
    /^current_session_id$/,
    /^private_close_no_confirm$/,
    /^context_window$/,
    /^system_prompt$/,
    /^ui\./,
    /^theme(?:\.|$)/,
    /^skin\./,
    /^appearance\./,
    /^chat\./,
    /^todo\./,
    /^baseinit\./,
    /^setupSuperagent\./,
    /^companion\.(enabled|host|port|devices|tls\.|androidBrowserHttps|allowedOrigins)/,
    /^remoteGateway\.(enabled|url)$/,
    /^llm\.(provider|model|transport|thinkingMode|showThinking|thinkingVisibility|concurrency\.enabled|discoveredModels)$/,
    /^llm\.[^.]+\.(url|baseUrl|model|useOAuth|profile|runtime|context|thinking|enabled|transport|apiPath|oauthCreds)$/,
    /^audio\.desktop\./,
    /^tts\./,
    /^stt\./,
    /^workflow\./,
    /^session\./,
    /^memory\./,
    /^task(?:\.|-|$)/,
    /^daemon\./,
    /^plugin-ui\./,
    /^plugin\.[^.]+\..+/,
    /^connector\.[^.]+\..+/,
    /^a2a\./,
    /^rag\./
]);

class DatabaseWrapper {
    dbPath: string;
    db: any;

    constructor(options = {}) {
        this.dbPath = resolveDbPath(options);
        fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
        this.db = new Database(this.dbPath);
        this.db.pragma('journal_mode = DELETE');
        this.db.pragma('foreign_keys = ON');
    }
    async init() {
        try {
            await this.createTables();
            await this.migratePlaintextAPIKeys();
            await migrateSecretSettingsToCredentials(this);
            await migrateRemoteGatewaySecret(this);
            await this.seedDefaultRules();
            console.log('Database initialized');
        } catch (error) {
            console.error('Database initialization error:', error);
            throw error;
        }
    }
    async seedDefaultRules() {
        const existing = await this.getPromptRuleByName('Enforce Tool Usage', { userId: 'localuser' });
        if (!existing) {
            await this.addPromptRule({
                name: 'Enforce Tool Usage',
                content: 'CRITICAL: You MUST use available tools for factual queries (time, date, weather, calendar, calculations). NEVER guess or use cached knowledge when a tool exists. Always call the appropriate tool first.',
                type: 'system',
                active: false
            }, { userId: 'localuser' });
        }
    }
    async createTables() {
        return runDatabaseMigrations(this.db);
    }
    async migratePlaintextAPIKeys() {
        const rows = this.all(
            "SELECT key, value FROM settings WHERE key LIKE 'llm.%.apiKey' AND value IS NOT NULL AND value != ''"
        );
        for (const row of rows) {
            const match = /^llm\.([^.]+)\.apiKey$/.exec(row.key);
            if (!match) continue;
            await this.setAPIKey(match[1], row.value);
        }
    }
    run(sql, params = []) {
        const stmt = this.db.prepare(sql);
        const info = stmt.run(...params);
        return { id: info.lastInsertRowid, changes: info.changes };
    }
    get(sql, params = []) {
        const stmt = this.db.prepare(sql);
        return stmt.get(...params);
    }
    all(sql, params = []) {
        const stmt = this.db.prepare(sql);
        return stmt.all(...params);
    }
    _mapConversationRow(row) {
        if (!row) return row;
        let metadata = row.metadata ?? null;
        if (typeof metadata === 'string' && metadata.trim()) {
            try {
                metadata = JSON.parse(metadata);
            } catch (_) {
                metadata = row.metadata;
            }
        }
        return {
            ...row,
            metadata: metadata || null
        };
    }
    _mapSubagentRun(row) {
        if (!row) return null;
        let resultPayload = null;
        let artifacts = [];
        try {
            resultPayload = row.result_payload ? JSON.parse(row.result_payload) : null;
        } catch (error) {
            resultPayload = null;
        }
        try {
            artifacts = row.artifacts_json ? JSON.parse(row.artifacts_json) : [];
        } catch (error) {
            artifacts = [];
        }
        let runtimePolicyGrants = {};
        try {
            runtimePolicyGrants = row.runtime_policy_grants_json ? JSON.parse(row.runtime_policy_grants_json) : {};
        } catch (error) {
            runtimePolicyGrants = {};
        }
        return mapSubagentRunOwnership({
            ...row,
            result_payload: resultPayload,
            artifacts,
            artifacts_json: artifacts,
            runtime_policy_profile: row.runtime_policy_profile || 'strict-subagent',
            runtime_policy_grants: runtimePolicyGrants,
            runtime_policy_grants_json: runtimePolicyGrants
        }, 'localuser');
    }
    close() {
        this.db.close();
        console.log('Database connection closed');
    }
    _resolveUserScope(options = {}) {
        return requireUserScope(options, requestContextHelpers);
    }
    async getCalendarEvents(options = {}) {
        const scope = this._resolveUserScope(options);
        return this.all(
            'SELECT * FROM calendar_events WHERE COALESCE(user_id, ?) = ? ORDER BY start_time',
            ['localuser', scope.userId]
        );
    }
    async addCalendarEvent(event, options = {}) {
        const scope = this._resolveUserScope(options);
        const { title, start_time, duration_minutes = 60, description = '' } = event;
        const result = this.run(
            'INSERT INTO calendar_events (title, start_time, duration_minutes, description, user_id) VALUES (?, ?, ?, ?, ?)',
            [title, start_time, duration_minutes, description, scope.userId]
        );
        return { ...event, id: result.id, user_id: scope.userId };
    }
    async updateCalendarEvent(id, event, options = {}) {
        const scope = this._resolveUserScope(options);
        const { title, start_time, duration_minutes, description } = event;
        this.run(
            'UPDATE calendar_events SET title = ?, start_time = ?, duration_minutes = ?, description = ? WHERE id = ? AND COALESCE(user_id, ?) = ?',
            [title, start_time, duration_minutes, description, id, 'localuser', scope.userId]
        );
        return { id, ...event, user_id: scope.userId };
    }
    async deleteCalendarEvent(id, options = {}) {
        const scope = this._resolveUserScope(options);
        this.run('DELETE FROM calendar_events WHERE id = ? AND COALESCE(user_id, ?) = ?', [id, 'localuser', scope.userId]);
        return { id, user_id: scope.userId };
    }
    async getTodos(sessionId = null, options = {}) {
        const scope = this._resolveUserScope(options);
        const sid = sessionId === null || sessionId === undefined ? '' : String(sessionId).trim();
        if (sid) {
            return this.all(
                'SELECT * FROM todos WHERE session_id = ? AND COALESCE(user_id, ?) = ? ORDER BY priority DESC, created_at',
                [sid, 'localuser', scope.userId]
            );
        }
        return this.all(
            'SELECT * FROM todos WHERE COALESCE(user_id, ?) = ? ORDER BY priority DESC, created_at',
            ['localuser', scope.userId]
        );
    }
    async addTodo(todo, sessionId = null, options = {}) {
        const scope = this._resolveUserScope(options);
        const { task, priority = 1, due_date = null } = todo;
        const sid = sessionId === null || sessionId === undefined ? String(todo.session_id || '').trim() : String(sessionId).trim();
        const result = this.run(
            'INSERT INTO todos (task, priority, due_date, session_id, user_id) VALUES (?, ?, ?, ?, ?)',
            [task, priority, due_date, sid || null, scope.userId]
        );
        return { ...todo, session_id: sid || null, user_id: scope.userId, id: result.id };
    }
    async updateTodo(id, todo, sessionId = null, options = {}) {
        const scope = this._resolveUserScope(options);
        const { task, completed, priority, due_date } = todo;
        const completedValue = completed === true ? 1 : (completed === false ? 0 : completed);
        const sid = sessionId === null || sessionId === undefined ? '' : String(sessionId).trim();
        const result = sid
            ? this.run('UPDATE todos SET task = ?, completed = ?, priority = ?, due_date = ? WHERE id = ? AND session_id = ? AND COALESCE(user_id, ?) = ?', [task, completedValue, priority, due_date, id, sid, 'localuser', scope.userId])
            : this.run('UPDATE todos SET task = ?, completed = ?, priority = ?, due_date = ? WHERE id = ? AND COALESCE(user_id, ?) = ?', [task, completedValue, priority, due_date, id, 'localuser', scope.userId]);
        return { id, ...todo, session_id: sid || todo.session_id || null, user_id: scope.userId, changes: result.changes };
    }
    async deleteTodo(id, sessionId = null, options = {}) {
        const scope = this._resolveUserScope(options);
        const sid = sessionId === null || sessionId === undefined ? '' : String(sessionId).trim();
        const result = sid
            ? this.run('DELETE FROM todos WHERE id = ? AND session_id = ? AND COALESCE(user_id, ?) = ?', [id, sid, 'localuser', scope.userId])
            : this.run('DELETE FROM todos WHERE id = ? AND COALESCE(user_id, ?) = ?', [id, 'localuser', scope.userId]);
        return { id, session_id: sid || null, user_id: scope.userId, changes: result.changes };
    }
    async getChatSessionById(sessionId, options = {}) {
        return chatOwnership.getChatSessionById(this, sessionId, options);
    }
    async getConversations(limit = 100, sessionId = null, options = {}) {
        return chatOwnership.getConversations(this, limit, sessionId, options);
    }
    async addConversation(message, sessionId = null, options = {}) {
        return chatOwnership.addConversation(this, message, sessionId, options);
    }
    async clearConversations() {
        const session = await this.getCurrentSession();
        await this.clearChatSession(session.id);
        return { cleared: true };
    }
    async clearChatSession(sessionId, options = {}) {
        return chatOwnership.clearChatSession(this, sessionId, options);
    }
    async deleteAllConversations(options = {}) {
        return chatOwnership.deleteAllConversations(this, options);
    }
    async getPromptRules(options = {}) {
        const scope = resolvePromptScope(options);
        return this.all(
            'SELECT * FROM prompt_rules WHERE COALESCE(user_id, ?) = ? ORDER BY created_at DESC',
            ['localuser', scope.userId]
        ).map(row => mapPromptRuleRow(row, scope.userId));
    }
    async getActivePromptRules(options = {}) {
        const scope = resolvePromptScope(options);
        return this.all(
            'SELECT * FROM prompt_rules WHERE active = 1 AND COALESCE(user_id, ?) = ? ORDER BY created_at',
            ['localuser', scope.userId]
        ).map(row => mapPromptRuleRow(row, scope.userId));
    }
    async getPromptRuleByName(name, options = {}) {
        const scope = resolvePromptScope(options);
        return mapPromptRuleRow(
            this.get(
                'SELECT * FROM prompt_rules WHERE name = ? AND COALESCE(user_id, ?) = ?',
                [name, 'localuser', scope.userId]
            ),
            scope.userId
        );
    }
    async addPromptRule(rule, options = {}) {
        const scope = resolvePromptScope({
            ...options,
            userId: rule?.user_id || rule?.userId || options?.userId || options?.user_id || options?.requestContext?.userId || options?.requestContext?.user_id
        });
        const { name, content, type = 'rule' } = rule;
        const active = rule?.active === true;
        const result = this.run(
            'INSERT INTO prompt_rules (name, content, type, active, user_id) VALUES (?, ?, ?, ?, ?)',
            [name, content, type, active ? 1 : 0, scope.userId]
        );
        const inserted = this.get(
            'SELECT * FROM prompt_rules WHERE id = ? AND COALESCE(user_id, ?) = ?',
            [result.id, 'localuser', scope.userId]
        );
        return mapPromptRuleRow(inserted, scope.userId);
    }
    async updatePromptRule(id, rule, options = {}) {
        const scope = resolvePromptScope(options);
        const existing = rule?.name ? await this.getPromptRuleByName(rule.name, scope) : null;
        const current = this.get(
            'SELECT * FROM prompt_rules WHERE id = ? AND COALESCE(user_id, ?) = ?',
            [id, 'localuser', scope.userId]
        );
        if (!current) {
            return null;
        }
        if (existing && Number(existing.id) !== Number(id)) {
            throw new Error(
                'Prompt rule already exists: ' + String(rule?.name || '')
            );
        }
        const nextActive = rule.active === undefined ? current.active : (rule.active ? 1 : 0);
        this.run(
            'UPDATE prompt_rules SET name = ?, content = ?, active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND COALESCE(user_id, ?) = ?',
            [rule.name, rule.content, nextActive ? 1 : 0, id, 'localuser', scope.userId]
        );
        return mapPromptRuleRow(
            this.get(
                'SELECT * FROM prompt_rules WHERE id = ? AND COALESCE(user_id, ?) = ?',
                [id, 'localuser', scope.userId]
            ),
            scope.userId
        );
    }
    async togglePromptRule(id, active, options = {}) {
        const scope = resolvePromptScope(options);
        this.run(
            'UPDATE prompt_rules SET active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND COALESCE(user_id, ?) = ?',
            [active ? 1 : 0, id, 'localuser', scope.userId]
        );
        return { id, active: Boolean(active), user_id: scope.userId };
    }
    async deletePromptRule(id, options = {}) {
        const scope = resolvePromptScope(options);
        this.run('DELETE FROM prompt_rules WHERE id = ? AND COALESCE(user_id, ?) = ?', [id, 'localuser', scope.userId]);
        return { id, user_id: scope.userId };
    }
    async createChatSession(title = null, options = {}) {
        return chatOwnership.createChatSession(this, title, options);
    }
    async getChatSessions(date = null, limit = 6, options = {}) {
        return chatOwnership.getChatSessions(this, date, limit, options);
    }
    async loadChatSession(sessionId, options = {}) {
        return chatOwnership.loadChatSession(this, sessionId, options);
    }
    async deleteChatSession(sessionId, options = {}) {
        return chatOwnership.deleteChatSession(this, sessionId, options);
    }
    async getCurrentSession(options = {}) {
        return chatOwnership.getCurrentSession(this, options);
    }
    async setCurrentSession(sessionId, options = {}) {
        return chatOwnership.setCurrentSession(this, sessionId, options);
    }
    _normalizeSettingKey(key) {
        return String(key || '').trim();
    }
    _isTenantScopedSettingKey(key) {
        const normalized = this._normalizeSettingKey(key);
        if (!normalized) return false;
        return TENANT_SCOPED_SETTING_PATTERNS.some(pattern => pattern.test(normalized));
    }
    _getTenantScopedSettingBaseKey(key) {
        const normalized = this._normalizeSettingKey(key);
        const index = normalized.lastIndexOf('.');
        if (index <= 0) return null;
        const candidate = normalized.slice(0, index);
        return this._isTenantScopedSettingKey(candidate) ? candidate : null;
    }
    _getScopedSettingStorageKey(key, options = {}) {
        const normalized = this._normalizeSettingKey(key);
        if (!this._isTenantScopedSettingKey(normalized)) {
            return normalized;
        }
        const scope = resolveAgentScope(options);
        return isBuiltInUserId(scope.userId) ? normalized : `${normalized}.${scope.userId}`;
    }
    async getScopedSetting(key, options = {}) {
        return this.getSetting(this._getScopedSettingStorageKey(key, options));
    }
    async saveScopedSetting(key, value, options = {}) {
        return this.saveSetting(this._getScopedSettingStorageKey(key, options), value);
    }
    async deleteScopedSetting(key, options = {}) {
        return this.deleteSetting(this._getScopedSettingStorageKey(key, options));
    }
    async getSetting(key) {
        try {
            const row = this.get('SELECT value FROM settings WHERE key = ?', [key]);
            return row ? row.value : null;
        } catch (error) {
            console.error(`Error getting setting '${key}':`, error);
            return null;
        }
    }
    getSettingSync(key) {
        // Some companion auth checks happen inside synchronous socket upgrade
        // paths; keep this as a small sync mirror of getSetting().
        try {
            const row = this.get('SELECT value FROM settings WHERE key = ?', [key]);
            return row ? row.value : null;
        } catch (error) {
            console.error(`Error getting setting '${key}':`, error);
            return null;
        }
    }
    async setSetting(key, value) {
        this.run(
            'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
            [key, value]
        );
        return { key, value };
    }
    async saveSetting(key, value) {
        return this.setSetting(key, value);
    }
    async deleteSetting(key) {
        this.run('DELETE FROM settings WHERE key = ?', [key]);
        return { key };
    }
    async getAllSettings(options = null) {
        const rows = this.all('SELECT key, value FROM settings');
        const hasScope = options && typeof options === 'object' && (options.requestContext || options.userId);
        if (!hasScope) {
            return rows.reduce((acc, row) => {
                acc[row.key] = row.value;
                return acc;
            }, {});
        }
        const scope = resolveAgentScope(options);
        const suffix = `.${scope.userId}`;
        const builtInScope = isBuiltInUserId(scope.userId);
        const output = {};
        for (const row of rows) {
            const normalizedKey = this._normalizeSettingKey(row.key);
            if (!builtInScope && normalizedKey.endsWith(suffix)) {
                const baseKey = normalizedKey.slice(0, -suffix.length);
                if (this._isTenantScopedSettingKey(baseKey)) {
                    output[baseKey] = row.value;
                    continue;
                }
            }
            if (this._isTenantScopedSettingKey(normalizedKey)) {
                if (builtInScope) {
                    output[normalizedKey] = row.value;
                }
                continue;
            }
            output[normalizedKey] = row.value;
        }
        return output;
    }
    getAllSettingsSync(options = null) {
        const rows = this.all('SELECT key, value FROM settings');
        const hasScope = options && typeof options === 'object' && (options.requestContext || options.userId);
        if (!hasScope) {
            return rows.reduce((acc, row) => {
                acc[row.key] = row.value;
                return acc;
            }, {});
        }
        const scope = resolveAgentScope(options);
        const suffix = `.${scope.userId}`;
        const builtInScope = isBuiltInUserId(scope.userId);
        const output = {};
        for (const row of rows) {
            const normalizedKey = this._normalizeSettingKey(row.key);
            if (!builtInScope && normalizedKey.endsWith(suffix)) {
                const baseKey = normalizedKey.slice(0, -suffix.length);
                if (this._isTenantScopedSettingKey(baseKey)) {
                    output[baseKey] = row.value;
                    continue;
                }
            }
            if (this._isTenantScopedSettingKey(normalizedKey)) {
                if (builtInScope) {
                    output[normalizedKey] = row.value;
                }
                continue;
            }
            output[normalizedKey] = row.value;
        }
        return output;
    }    async getConfig(options = {}) {
        const scope = this._resolveUserScope(options);
        const provider = await this.getScopedSetting('llm.provider', scope);
        const model = await this.getScopedSetting('llm.model', scope);
        const config: Record<string, any> = { provider, model };
        if (provider) {
            const apiKey = await this.getAPIKey(provider, scope) || await this.getScopedSetting(`llm.${provider}.apiKey`, scope);
            const url = await this.getScopedSetting(`llm.${provider}.url`, scope);
            const useOAuth = await this.getScopedSetting(`llm.${provider}.useOAuth`, scope);
            if (apiKey) config.apiKey = apiKey;
            if (url) config.url = url;
            if (useOAuth === 'true') config.useOAuth = true;
        }
        return config;
    }
    async getAPIKey(provider, options = {}) {
        const normalizedProvider = String(provider || '').trim().toLowerCase();
        if (!normalizedProvider) return null;
        const scope = this._resolveUserScope(options);
        const row = this.get('SELECT key, encrypted FROM api_keys WHERE provider = ? AND COALESCE(user_id, ?) = ?', [normalizedProvider, 'localuser', scope.userId]);
        if (!row) return null;
        try {
            return decryptSecret(row.key, Boolean(row.encrypted));
        } catch (error) {
            console.error(`Error decrypting API key for '${normalizedProvider}' user='${scope.userId}':`, (error as any).message);
            return null;
        }
    }
    async setAPIKey(provider, key, options = {}) {
        const normalizedProvider = String(provider || '').trim().toLowerCase();
        const secret = String(key || '').trim();
        const scope = this._resolveUserScope(options);
        if (!normalizedProvider) {
            throw new Error('Provider is required');
        }
        if (!secret) {
            this.run('DELETE FROM api_keys WHERE provider = ? AND COALESCE(user_id, ?) = ?', [normalizedProvider, 'localuser', scope.userId]);
            await this.saveScopedSetting(`llm.${normalizedProvider}.apiKey`, '', scope);
            return { provider: normalizedProvider, user_id: scope.userId, encrypted: false };
        }
        const encrypted = encryptSecret(secret);
        this.run(
            'INSERT OR REPLACE INTO api_keys (provider, user_id, key, encrypted) VALUES (?, ?, ?, ?)',
            [normalizedProvider, scope.userId, encrypted.value, encrypted.encrypted ? 1 : 0]
        );
        await this.saveScopedSetting(`llm.${normalizedProvider}.apiKey`, '', scope);
        return { provider: normalizedProvider, user_id: scope.userId, encrypted: encrypted.encrypted };
    }
    async getAPIKeyInfo(provider, options = {}) {
        const normalizedProvider = String(provider || '').trim().toLowerCase();
        if (!normalizedProvider) {
            return { configured: false, encrypted: false };
        }
        const scope = this._resolveUserScope(options);
        const row = this.get('SELECT encrypted FROM api_keys WHERE provider = ? AND COALESCE(user_id, ?) = ?', [normalizedProvider, 'localuser', scope.userId]);
        return {
            configured: Boolean(row),
            encrypted: Boolean(row?.encrypted)
        };
    }
    _credentialProviderName(name) {
        const normalized = String(name || '').trim().toLowerCase();
        if (!normalized) throw new Error('Credential name is required');
        return `credential:${normalized}`;
    }
    async getCredential(name, options = {}) {
        return this.getAPIKey(this._credentialProviderName(name), options);
    }
    async setCredential(name, value, options = {}) {
        const provider = this._credentialProviderName(name);
        const secret = String(value || '');
        const scope = this._resolveUserScope(options);
        if (!secret) {
            this.run('DELETE FROM api_keys WHERE provider = ? AND COALESCE(user_id, ?) = ?', [provider, 'localuser', scope.userId]);
            return { name, user_id: scope.userId, encrypted: false };
        }
        const encrypted = encryptSecret(secret);
        this.run(
            'INSERT OR REPLACE INTO api_keys (provider, user_id, key, encrypted) VALUES (?, ?, ?, ?)',
            [provider, scope.userId, encrypted.value, encrypted.encrypted ? 1 : 0]
        );
        return { name, user_id: scope.userId, encrypted: encrypted.encrypted };
    }
    async deleteCredential(name, options = {}) {
        const scope = this._resolveUserScope(options);
        this.run('DELETE FROM api_keys WHERE provider = ? AND COALESCE(user_id, ?) = ?', [this._credentialProviderName(name), 'localuser', scope.userId]);
        return { name, user_id: scope.userId };
    }
    async getCredentialInfo(name, options = {}) {
        const scope = this._resolveUserScope(options);
        const row = this.get('SELECT encrypted FROM api_keys WHERE provider = ? AND COALESCE(user_id, ?) = ?', [this._credentialProviderName(name), 'localuser', scope.userId]);
        return {
            configured: Boolean(row),
            encrypted: Boolean(row?.encrypted)
        };
    }
    async setActiveModel(provider, model) {
        await this.setSetting(`active_model_${provider}`, model);
        return { provider, model };
    }
    async addToolCall(call = {}, options = {}) {
        const scope = this._resolveUserScope(options);
        const serialize = (value, maxChars) => {
            if (value === undefined || value === null) return null;
            let text;
            try { text = JSON.stringify(value); } catch (_) { text = JSON.stringify({ unserializable: true }); }
            return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
        };
        const requestedSessionId = String(call.sessionId ?? call.session_id ?? '').trim();
        const session = requestedSessionId
            ? this.get(
                'SELECT id FROM chat_sessions WHERE CAST(id AS TEXT) = ? AND COALESCE(user_id, ?) = ?',
                [requestedSessionId, 'localuser', scope.userId]
            )
            : null;
        const toolCallId = String(call.toolCallId || call.tool_call_id || `call_${Date.now()}`).trim();
        const timestamp = String(call.timestamp || new Date().toISOString());
        const result = this.run(
            `INSERT OR REPLACE INTO tool_calls (
                tool_call_id, session_id, user_id, tool_name, parameters, success,
                result, error, source, agent_id, timestamp
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                toolCallId,
                session ? String(session.id) : null,
                scope.userId,
                String(call.toolName || call.tool_name || 'unknown'),
                serialize(call.params ?? call.parameters, 65536),
                call.success === true ? 1 : 0,
                serialize(call.result, 262144),
                call.error ? String(call.error).slice(0, 65536) : null,
                call.source ? String(call.source).slice(0, 128) : null,
                call.agentId ?? call.agent_id ?? null,
                timestamp
            ]
        );
        return { id: result.id, tool_call_id: toolCallId, session_id: session ? String(session.id) : null, user_id: scope.userId };
    }
    async getToolCalls(sessionId = null, limit = 100, options = {}) {
        const scope = this._resolveUserScope(options);
        const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 1000));
        const sid = String(sessionId ?? '').trim();
        const cursorTimestamp = String(options?.cursor?.timestamp || '').trim(); const cursorId = Number(options?.cursor?.id);
        const hasCursor = Boolean(cursorTimestamp) && Number.isFinite(cursorId) && cursorId > 0;
        const rows = sid
            ? this.all(
                `SELECT * FROM tool_calls WHERE COALESCE(user_id, ?) = ? AND CAST(session_id AS TEXT) = ?
                 ${hasCursor ? 'AND (timestamp < ? OR (timestamp = ? AND id < ?))' : ''}
                 ORDER BY timestamp DESC, id DESC LIMIT ?`,
                hasCursor ? ['localuser', scope.userId, sid, cursorTimestamp, cursorTimestamp, cursorId, safeLimit] : ['localuser', scope.userId, sid, safeLimit]
            )
            : this.all(
                `SELECT * FROM tool_calls WHERE COALESCE(user_id, ?) = ?
                 ${hasCursor ? 'AND (timestamp < ? OR (timestamp = ? AND id < ?))' : ''}
                 ORDER BY timestamp DESC, id DESC LIMIT ?`,
                hasCursor ? ['localuser', scope.userId, cursorTimestamp, cursorTimestamp, cursorId, safeLimit] : ['localuser', scope.userId, safeLimit]
            );
        return rows.map(row => {
            const parse = value => {
                if (!value) return null;
                try { return JSON.parse(value); } catch (_) { return value; }
            };
            return { ...row, success: row.success === 1, parameters: parse(row.parameters), result: parse(row.result) };
        });
    }
    async getToolStates() {
        const rows = this.all(`SELECT key, value FROM settings WHERE key LIKE 'tool.%.active'`);
        const states: Record<string, { active: boolean }> = {};
        rows.forEach(row => {
            const toolName = row.key.replace('tool.', '').replace('.active', '');
            states[toolName] = { active: row.value === 'true' };
        });
        return states;
    }
    async setToolActive(toolName, active) {
        const key = `tool.${toolName}.active`;
        const value = active ? 'true' : 'false';
        await this.setSetting(key, value);
        return { toolName, active };
    }
    async getCustomTools() {
        return this.all('SELECT * FROM custom_tools ORDER BY created_at DESC');
    }
    async getCustomTool(name) {
        return this.get('SELECT * FROM custom_tools WHERE name = ?', [name]);
    }
    async addCustomTool(tool) {
        const { name, description, code, input_schema } = tool;
        const result = this.run(
            'INSERT INTO custom_tools (name, description, code, input_schema) VALUES (?, ?, ?, ?)',
            [name, description, code, JSON.stringify(input_schema || {})]
        );
        return { id: result.id, ...tool };
    }
    async updateCustomTool(existingName, updates = {}) {
        const current = await this.getCustomTool(existingName);
        if (!current) {
            throw new Error(`Custom tool "${existingName}" not found`);
        }
        const nextName = String(updates.name ?? current.name).trim();
        const nextDescription = String(updates.description ?? current.description).trim();
        const nextCode = String(updates.code ?? current.code);
        const nextInputSchema = JSON.stringify(updates.input_schema ?? JSON.parse(current.input_schema || '{}'));
        if (!nextName) throw new Error('Tool name is required');
        if (!nextDescription) throw new Error('Tool description is required');
        if (!nextCode.trim()) throw new Error('Tool code is required');
        if (nextName !== current.name) {
            const conflict = await this.getCustomTool(nextName);
            if (conflict) throw new Error(`Tool name "${nextName}" already exists`);
        }
        this.run(
            'UPDATE custom_tools SET name = ?, description = ?, code = ?, input_schema = ? WHERE name = ?',
            [nextName, nextDescription, nextCode, nextInputSchema, existingName]
        );
        if (nextName !== existingName) {
            const oldKey = `tool.${existingName}.active`;
            const newKey = `tool.${nextName}.active`;
            const active = await this.getSetting(oldKey);
            if (active !== null && active !== undefined) {
                await this.setSetting(newKey, active);
                this.run('DELETE FROM settings WHERE key = ?', [oldKey]);
            }
        }
        return this.getCustomTool(nextName);
    }
    async deleteCustomTool(name) {
        this.run('DELETE FROM custom_tools WHERE name = ?', [name]);
        return { name };
    }
    async upsertScheduledTimer(timer) {
        const now = new Date().toISOString();
        this.run(
            `INSERT INTO scheduled_timers (
                timer_id, context_key, context_json, status, due_at, interval_ms,
                remaining_ms, repeat, message, updated_at, paused_at, fired_at, last_error
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(timer_id, context_key) DO UPDATE SET
                context_json = excluded.context_json,
                status = excluded.status,
                due_at = excluded.due_at,
                interval_ms = excluded.interval_ms,
                remaining_ms = excluded.remaining_ms,
                repeat = excluded.repeat,
                message = excluded.message,
                updated_at = excluded.updated_at,
                paused_at = excluded.paused_at,
                fired_at = excluded.fired_at,
                last_error = excluded.last_error`,
            [
                timer.timer_id,
                timer.context_key,
                JSON.stringify(timer.context || {}),
                timer.status || 'active',
                timer.due_at || null,
                Number(timer.interval_ms) || 0,
                timer.remaining_ms ?? null,
                timer.repeat ? 1 : 0,
                timer.message || '',
                now,
                timer.paused_at || null,
                timer.fired_at || null,
                timer.last_error || null
            ]
        );
        return this.getScheduledTimer(timer.timer_id, timer.context_key);
    }
    async getScheduledTimer(timerId, contextKey) {
        return this.get(
            'SELECT * FROM scheduled_timers WHERE timer_id = ? AND context_key = ?',
            [timerId, contextKey]
        );
    }
    async listScheduledTimers(contextKey = null) {
        if (contextKey) {
            return this.all(
                'SELECT * FROM scheduled_timers WHERE context_key = ? AND status IN (?, ?) ORDER BY due_at',
                [contextKey, 'active', 'paused']
            );
        }
        return this.all(
            'SELECT * FROM scheduled_timers WHERE status IN (?, ?) ORDER BY due_at',
            ['active', 'paused']
        );
    }
    async getDueScheduledTimers(nowIso) {
        return this.all(
            'SELECT * FROM scheduled_timers WHERE status = ? AND due_at IS NOT NULL AND due_at <= ? ORDER BY due_at',
            ['active', nowIso]
        );
    }
    async updateScheduledTimerState(timerId, contextKey, updates = {}) {
        const allowed = ['status', 'due_at', 'remaining_ms', 'paused_at', 'fired_at', 'last_error'];
        const entries = Object.entries(updates).filter(([key]) => allowed.includes(key));
        if (entries.length === 0) return this.getScheduledTimer(timerId, contextKey);
        const sets = entries.map(([key]) => `${key} = ?`).join(', ');
        const values = entries.map(([, value]) => value);
        this.run(
            `UPDATE scheduled_timers SET ${sets}, updated_at = ? WHERE timer_id = ? AND context_key = ?`,
            [...values, new Date().toISOString(), timerId, contextKey]
        );
        return this.getScheduledTimer(timerId, contextKey);
    }
    async getWorkflows(options = {}) {
        const scope = resolveWorkflowScope(options);
        return this.all(
            'SELECT * FROM workflows WHERE COALESCE(user_id, ?) = ? ORDER BY success_count DESC, last_used DESC',
            ['localuser', scope.userId]
        ).map(row => mapWorkflowRow(row, scope.userId));
    }
    async addWorkflow(workflow, options = {}) {
        const scope = resolveWorkflowScope({
            ...options,
            userId: workflow?.user_id || workflow?.userId || options?.userId || options?.user_id || options?.requestContext?.userId || options?.requestContext?.user_id
        });
        const { name, description, trigger_pattern, tool_chain, embedding, visual_data } = workflow;
        const result = this.run(
            'INSERT INTO workflows (name, description, trigger_pattern, tool_chain, embedding, visual_data, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [name, description, trigger_pattern, JSON.stringify(tool_chain),
                embedding ? JSON.stringify(embedding) : null,
                visual_data ? JSON.stringify(visual_data) : null,
                scope.userId]
        );
        return { id: result.id, ...workflow, user_id: scope.userId };
    }
    async updateWorkflowStats(id, success) {
        if (success) {
            this.run('UPDATE workflows SET success_count = success_count + 1, last_used = CURRENT_TIMESTAMP WHERE id = ?', [id]);
        } else {
            this.run('UPDATE workflows SET failure_count = failure_count + 1, last_used = CURRENT_TIMESTAMP WHERE id = ?', [id]);
        }
    }
    async findWorkflowByTrigger(pattern, options = {}) {
        const scope = resolveWorkflowScope(options);
        return mapWorkflowRow(
            this.get(
                'SELECT * FROM workflows WHERE trigger_pattern LIKE ? AND COALESCE(user_id, ?) = ?',
                [`%${pattern}%`, 'localuser', scope.userId]
            ),
            scope.userId
        );
    }
    async getWorkflowById(id, options = {}) {
        const scope = resolveWorkflowScope(options);
        return mapWorkflowRow(
            this.get(
                'SELECT * FROM workflows WHERE id = ? AND COALESCE(user_id, ?) = ?',
                [id, 'localuser', scope.userId]
            ),
            scope.userId
        );
    }
    async deleteWorkflow(id, options = {}) {
        const scope = resolveWorkflowScope(options);
        this.run('DELETE FROM workflows WHERE id = ? AND COALESCE(user_id, ?) = ?', [id, 'localuser', scope.userId]);
        return { id, user_id: scope.userId };
    }
    async updateWorkflowEmbedding(id, embedding, options = {}) {
        const scope = resolveWorkflowScope(options);
        this.run('UPDATE workflows SET embedding = ? WHERE id = ? AND COALESCE(user_id, ?) = ?', [JSON.stringify(embedding), id, 'localuser', scope.userId]);
        return { id, embedding, user_id: scope.userId };
    }    _mapAgentRow(row) {
        return mapAgentRow(row, 'localuser');
    }
    async getAgents(type = null, options = {}) {
        const scope = resolveAgentScope(options);
        const sql = type
            ? 'SELECT * FROM agents WHERE type = ? AND COALESCE(user_id, ?) = ? ORDER BY name'
            : 'SELECT * FROM agents WHERE COALESCE(user_id, ?) = ? ORDER BY type, name';
        const params = type ? [type, 'localuser', scope.userId] : ['localuser', scope.userId];
        return this.all(sql, params).map(row => this._mapAgentRow(row));
    }
    async getAgent(id, options = {}) {
        const scope = resolveAgentScope(options);
        return this._mapAgentRow(this.get('SELECT * FROM agents WHERE id = ? AND COALESCE(user_id, ?) = ?', [id, 'localuser', scope.userId]));
    }
    async addAgent(agent, options = {}) {
        const scope = resolveAgentScope(options);
        const { name, type = 'pro', icon = '🤖', system_prompt, description, config, folder_path } = agent;
        const result = this.run(
            'INSERT INTO agents (name, type, icon, system_prompt, description, config, folder_path, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [name, type, icon, system_prompt || '', description || '', config ? JSON.stringify(config) : null, folder_path || '', scope.userId]
        );
        return { ...agent, id: result.id, status: 'idle', visibleInSidebar: true, user_id: scope.userId };
    }
    async updateAgent(id, data, options = {}) {
        const scope = resolveAgentScope(options);
        const fields = [];
        const values = [];
        for (const [key, value] of Object.entries(data)) {
            if (['name', 'type', 'icon', 'system_prompt', 'description', 'status', 'config', 'folder_path', 'visible_in_sidebar'].includes(key)) {
                fields.push(`${key} = ?`);
                values.push(key === 'config' && typeof value === 'object' ? JSON.stringify(value) : (key === 'visible_in_sidebar' ? (value ? 1 : 0) : value));
            }
        }
        if (fields.length === 0) return { id, user_id: scope.userId };
        fields.push('updated_at = CURRENT_TIMESTAMP');
        values.push(id, 'localuser', scope.userId);
        this.run(`UPDATE agents SET ${fields.join(', ')} WHERE id = ? AND COALESCE(user_id, ?) = ?`, values);
        return { id, ...data, user_id: scope.userId };
    }
    async deleteAgent(id, options = {}) {
        const scope = resolveAgentScope(options);
        const sessions = this.all('SELECT id FROM chat_sessions WHERE agent_id = ? AND COALESCE(user_id, ?) = ?', [id, 'localuser', scope.userId]);
        for (const session of sessions) {
            this.run('DELETE FROM conversations WHERE session_id = ? AND COALESCE(user_id, ?) = ?', [session.id, 'localuser', scope.userId]);
        }
        this.run('DELETE FROM chat_sessions WHERE agent_id = ? AND COALESCE(user_id, ?) = ?', [id, 'localuser', scope.userId]);
        this.run('DELETE FROM subagent_runs WHERE subagent_id = ? AND COALESCE(user_id, ?) = ?', [id, 'localuser', scope.userId]);
        this.run('DELETE FROM agent_tool_states WHERE agent_id = ?', [id]);
        this.run('DELETE FROM agents WHERE id = ? AND COALESCE(user_id, ?) = ?', [id, 'localuser', scope.userId]);
        return { id, deletedSessions: sessions.length, user_id: scope.userId };
    }
    async getAgentSession(agentId, options = {}) {
        return chatOwnership.getAgentSession(this, agentId, options);
    }
    async createAgentSession(agentId, title = null, options = {}) {
        return chatOwnership.createAgentSession(this, agentId, title, options);
    }
    async createSubagentRun(run, options = {}) {
        const scope = resolveAgentScope(options);
        const {
            parentSessionId = null,
            childSessionId,
            subagentId,
            task,
            contractType = 'task_complete',
            expectedOutput = '',
            runtimePolicyProfile = 'strict-subagent', runtimePolicyGrants = {}
        } = run;
        const result = this.run(
            `INSERT INTO subagent_runs (
                parent_session_id,
                child_session_id,
                subagent_id,
                task,
                contract_type,
                expected_output,
                runtime_policy_profile,
                runtime_policy_grants_json,
                user_id,
                status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running')`,
            [
                parentSessionId,
                childSessionId,
                subagentId,
                task,
                contractType,
                expectedOutput,
                runtimePolicyProfile || 'strict-subagent',
                JSON.stringify(runtimePolicyGrants && typeof runtimePolicyGrants === 'object' ? runtimePolicyGrants : {}),
                scope.userId
            ]
        );
        return this.getSubagentRun(result.id, scope);
    }
    async completeSubagentRun(id, result, options = {}) {
        const {
            status = 'completed',
            summary = '',
            payload = null,
            artifacts = []
        } = result;
        const scope = resolveAgentScope(options);
        this.run(
            `UPDATE subagent_runs
             SET status = ?, result_summary = ?, result_payload = ?, artifacts_json = ?, error = NULL, completed_at = CURRENT_TIMESTAMP
             WHERE id = ? AND COALESCE(user_id, ?) = ?`,
            [
                status,
                summary,
                payload ? JSON.stringify(payload) : null,
                JSON.stringify(artifacts || []),
                id,
                'localuser',
                scope.userId
            ]
        );
        return this.getSubagentRun(id, scope);
    }
    async failSubagentRun(id, error, options = {}) {
        const scope = resolveAgentScope(options);
        this.run(
            `UPDATE subagent_runs
             SET status = 'failed', error = ?, completed_at = CURRENT_TIMESTAMP
             WHERE id = ? AND COALESCE(user_id, ?) = ?`,
            [String(error || 'Unknown error'), id, 'localuser', scope.userId]
        );
        return this.getSubagentRun(id, scope);
    }
    async getSubagentRun(id, options = {}) {
        const scope = resolveAgentScope(options);
        const row = this.get('SELECT * FROM subagent_runs WHERE id = ? AND COALESCE(user_id, ?) = ?', [id, 'localuser', scope.userId]);
        return this._mapSubagentRun(row);
    }
    async listSubagentRuns(filters = {}) {
        const scope = resolveAgentScope(filters);
        const {
            parentSessionId = null,
            subagentId = null,
            limit = 20
        } = filters;
        const clauses = [];
        const params = [];
        if (parentSessionId !== null && parentSessionId !== undefined) {
            clauses.push('parent_session_id = ?');
            params.push(parentSessionId);
        }
        if (subagentId !== null && subagentId !== undefined) {
            clauses.push('subagent_id = ?');
            params.push(subagentId);
        }
        clauses.push('COALESCE(user_id, ?) = ?');
        params.push('localuser', scope.userId);
        params.push(Math.max(1, Number(limit) || 20));
        const where = clauses.length > 0
            ? `WHERE ${clauses.join(' AND ')}`
            : '';
        const rows = this.all(
            `SELECT * FROM subagent_runs ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
            params
        );
        return rows.map(row => this._mapSubagentRun(row));
    }
    _mapMemoryJob(row) {
        if (!row) return null;
        let payload = null;
        try {
            payload = row.payload_json ? JSON.parse(row.payload_json) : null;
        } catch (error) {
            payload = null;
        }
        return {
            ...row,
            user_id: normalizeUserId(row.user_id || row.userId, 'localuser'),
            payload
        };
    }
    _resolveMemoryJobUserId(sessionId, options = {}) {
        const explicitUserId = String(options?.userId || options?.user_id || options?.requestContext?.userId || options?.requestContext?.user_id || '').trim();
        if (explicitUserId) {
            return normalizeUserId(explicitUserId, 'localuser');
        }
        const sid = String(sessionId || '').trim();
        if (!sid) {
            return 'localuser';
        }
        const row = this.get('SELECT user_id FROM chat_sessions WHERE CAST(id AS TEXT) = CAST(? AS TEXT)', [sid]);
        return normalizeUserId(row?.user_id || row?.userId, 'localuser');
    }
    async enqueueMemoryJob({ jobType, sessionId, payload = null, nextRunAt = null }, options = {}) {
        const type = String(jobType || '').trim();
        const sid = String(sessionId || '').trim();
        if (!type || !sid) {
            throw new Error('enqueueMemoryJob requires jobType and sessionId');
        }
        const jobUserId = this._resolveMemoryJobUserId(sid, options);
        const existing = this.get(
            `SELECT * FROM memory_jobs
             WHERE job_type = ? AND session_id = ? AND COALESCE(user_id, ?) = ? AND status IN ('pending', 'running')
             ORDER BY id DESC LIMIT 1`,
            [type, sid, 'localuser', jobUserId]
        );
        if (existing) {
            return this._mapMemoryJob(existing);
        }
        const dueAt = nextRunAt || new Date().toISOString();
        const result = this.run(
            `INSERT INTO memory_jobs
             (job_type, session_id, user_id, status, attempts, next_run_at, payload_json)
             VALUES (?, ?, ?, 'pending', 0, ?, ?)`,
            [type, sid, jobUserId, dueAt, payload ? JSON.stringify(payload) : null]
        );
        return this.getMemoryJob(result.id);
    }
    async getMemoryJob(jobId, options = {}) {
        const scopedUserId = String(options?.userId || options?.user_id || options?.requestContext?.userId || options?.requestContext?.user_id || '').trim();
        const row = scopedUserId
            ? this.get('SELECT * FROM memory_jobs WHERE id = ? AND COALESCE(user_id, ?) = ?', [jobId, 'localuser', normalizeUserId(scopedUserId, 'localuser')])
            : this.get('SELECT * FROM memory_jobs WHERE id = ?', [jobId]);
        return this._mapMemoryJob(row);
    }
    async claimNextMemoryJob(jobType, workerId = 'memory-daemon', options = {}) {
        const type = String(jobType || '').trim();
        if (!type) {
            throw new Error('claimNextMemoryJob requires jobType');
        }
        const excludedUsers = Array.isArray(options?.excludeUserIds)
            ? Array.from(new Set(options.excludeUserIds.map((value) => normalizeUserId(value, 'localuser'))))
            : [];
        const claim = this.db.transaction(() => {
            const clauses = [
                'job_type = ?',
                "status = 'pending'",
                "datetime(next_run_at) <= datetime('now')"
            ];
            const params = [type];
            if (excludedUsers.length > 0) {
                clauses.push(`COALESCE(user_id, ?) NOT IN (${excludedUsers.map(() => '?').join(', ')})`);
                params.push('localuser', ...excludedUsers);
            }
            const row = this.get(
                `SELECT * FROM memory_jobs
                 WHERE ${clauses.join(' AND ')}
                 ORDER BY datetime(next_run_at) ASC, id ASC
                 LIMIT 1`,
                params
            );
            if (!row) {
                return null;
            }
            this.run(
                `UPDATE memory_jobs
                 SET status = 'running',
                     locked_at = CURRENT_TIMESTAMP,
                     locked_by = ?,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [String(workerId || 'memory-daemon'), row.id]
            );
            return row.id;
        });
        const jobId = claim();
        if (!jobId) return null;
        return this.getMemoryJob(jobId);
    }
    async completeMemoryJob(jobId, { summary = '', payload = null } = {}) {
        this.run(
            `UPDATE memory_jobs
             SET status = 'done',
                 result_summary = ?,
                 payload_json = ?,
                 last_error = NULL,
                 locked_at = NULL,
                 locked_by = NULL,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [String(summary || ''), payload ? JSON.stringify(payload) : null, jobId]
        );
        return this.getMemoryJob(jobId);
    }
    async markDaemonSessionInspected(sessionId, { inspector = 'memory-daemon', jobId = null, notes = '', userId = null } = {}) {
        const sid = String(sessionId || '').trim();
        if (!sid) {
            throw new Error('markDaemonSessionInspected requires sessionId');
        }
        const inspectionUserId = this._resolveMemoryJobUserId(sid, { userId });
        this.run(
            `INSERT INTO daemon_session_inspections (session_id, user_id, inspector, inspected_at, job_id, notes)
             VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, ?)
             ON CONFLICT(session_id) DO UPDATE SET
                user_id = excluded.user_id,
                inspector = excluded.inspector,
                inspected_at = CURRENT_TIMESTAMP,
                job_id = excluded.job_id,
                notes = excluded.notes`,
            [sid, inspectionUserId, String(inspector || 'memory-daemon'), jobId, String(notes || '')]
        );
        return this.getDaemonSessionInspection(sid, { userId: inspectionUserId });
    }
    getDaemonSessionInspection(sessionId, options = {}) {
        const sid = String(sessionId || '').trim();
        const scopedUserId = String(options?.userId || options?.user_id || '').trim();
        if (scopedUserId) {
            return this.get('SELECT * FROM daemon_session_inspections WHERE session_id = ? AND COALESCE(user_id, ?) = ?', [sid, 'localuser', normalizeUserId(scopedUserId, 'localuser')]);
        }
        return this.get('SELECT * FROM daemon_session_inspections WHERE session_id = ?', [sid]);
    }
    getDaemonSessionInspectionStats(options = {}) {
        const scopedUserId = String(options?.userId || options?.user_id || '').trim();
        if (scopedUserId) {
            return this.get(
                'SELECT COUNT(*) as count, MAX(inspected_at) as lastInspectedAt FROM daemon_session_inspections WHERE COALESCE(user_id, ?) = ?',
                ['localuser', normalizeUserId(scopedUserId, 'localuser')]
            ) || { count: 0 };
        }
        return this.get('SELECT COUNT(*) as count, MAX(inspected_at) as lastInspectedAt FROM daemon_session_inspections') || { count: 0 };
    }
    async failMemoryJob(jobId, error, options = {}) {
        const maxAttempts = Math.max(1, Number(options.maxAttempts) || 5);
        const retryDelaySeconds = Math.max(1, Number(options.retryDelaySeconds) || 300);
        const row = this.get('SELECT attempts FROM memory_jobs WHERE id = ?', [jobId]);
        if (!row) {
            return null;
        }
        const attempts = Number(row.attempts || 0) + 1;
        const shouldRetry = attempts < maxAttempts;
        if (shouldRetry) {
            const retryIso = new Date(Date.now() + retryDelaySeconds * 1000).toISOString();
            this.run(
                `UPDATE memory_jobs
                 SET status = 'pending',
                     attempts = ?,
                     next_run_at = ?,
                     last_error = ?,
                     locked_at = NULL,
                     locked_by = NULL,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [attempts, retryIso, String(error || 'Unknown error'), jobId]
            );
        } else {
            this.run(
                `UPDATE memory_jobs
                 SET status = 'failed',
                     attempts = ?,
                     last_error = ?,
                     locked_at = NULL,
                     locked_by = NULL,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?`,
                [attempts, String(error || 'Unknown error'), jobId]
            );
        }
        return this.getMemoryJob(jobId);
    }
    async resetStaleRunningMemoryJobs({ maxAgeMinutes = 30, jobType = null } = {}) {
        const age = Math.max(1, Number(maxAgeMinutes) || 30);
        if (jobType) {
            this.run(
                `UPDATE memory_jobs
                 SET status = 'pending',
                     locked_at = NULL,
                     locked_by = NULL,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE status = 'running'
                   AND job_type = ?
                   AND datetime(locked_at) < datetime('now', ?)`,
                [String(jobType), `-${age} minutes`]
            );
            return;
        }
        this.run(
            `UPDATE memory_jobs
             SET status = 'pending',
                 locked_at = NULL,
                 locked_by = NULL,
                 updated_at = CURRENT_TIMESTAMP
             WHERE status = 'running'
               AND datetime(locked_at) < datetime('now', ?)`,
            [`-${age} minutes`]
        );
    }
}
export = DatabaseWrapper;





