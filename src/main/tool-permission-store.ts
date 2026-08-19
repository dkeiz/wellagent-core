// @ts-nocheck
class ToolPermissionStore {
    constructor(db) {
        this.db = db;
    }

    _ensureProfileColumns() {
        const columns = [
            ['main_enabled', 'INTEGER NOT NULL DEFAULT 1'],
            ['preset_id', "TEXT NOT NULL DEFAULT ''"],
            ['files_mode', "TEXT NOT NULL DEFAULT 'read'"],
            ['unsafe_enabled', 'INTEGER NOT NULL DEFAULT 0'],
            ['web_enabled', 'INTEGER NOT NULL DEFAULT 1'],
            ['terminal_enabled', 'INTEGER NOT NULL DEFAULT 1'],
            ['terminal_mode', "TEXT NOT NULL DEFAULT 'workspace'"],
            ['ports_enabled', 'INTEGER NOT NULL DEFAULT 1'],
            ['visual_enabled', 'INTEGER NOT NULL DEFAULT 0'],
            ['created_at', 'DATETIME'],
            ['updated_at', 'DATETIME']
        ];

        for (const [name, definition] of columns) {
            try {
                this.db.run(`
                    ALTER TABLE agent_permission_profiles
                    ADD COLUMN ${name} ${definition}
                `);
            } catch (_) {}
        }
    }

    async initialize() {
        this.db.run(`
            CREATE TABLE IF NOT EXISTS agent_permission_profiles (
                agent_id INTEGER PRIMARY KEY,
                main_enabled INTEGER NOT NULL DEFAULT 1,
                preset_id TEXT NOT NULL DEFAULT '',
                files_mode TEXT NOT NULL DEFAULT 'read',
                unsafe_enabled INTEGER NOT NULL DEFAULT 0,
                web_enabled INTEGER NOT NULL DEFAULT 1,
                terminal_enabled INTEGER NOT NULL DEFAULT 1,
                terminal_mode TEXT NOT NULL DEFAULT 'workspace',
                ports_enabled INTEGER NOT NULL DEFAULT 1,
                visual_enabled INTEGER NOT NULL DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);
        this._ensureProfileColumns();

        this.db.run(`
            CREATE TABLE IF NOT EXISTS agent_tool_states (
                agent_id INTEGER NOT NULL,
                tool_name TEXT NOT NULL,
                active INTEGER NOT NULL,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (agent_id, tool_name)
            )
        `);
    }

    getAgentProfile(agentId) {
        return this.db.get(
            `SELECT * FROM agent_permission_profiles WHERE agent_id = ?`,
            [agentId]
        );
    }

    setAgentProfile(agentId, profile) {
        const terminalMode = String(profile.terminal_mode || (profile.terminal_enabled === false ? 'off' : 'workspace'));
        const terminalEnabled = profile.terminal_enabled !== undefined
            ? Boolean(profile.terminal_enabled)
            : terminalMode !== 'off';
        this.db.run(
            `INSERT OR REPLACE INTO agent_permission_profiles (
                agent_id,
                main_enabled,
                preset_id,
                files_mode,
                unsafe_enabled,
                web_enabled,
                terminal_enabled,
                terminal_mode,
                ports_enabled,
                visual_enabled,
                created_at,
                updated_at
            ) VALUES (
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM agent_permission_profiles WHERE agent_id = ?), CURRENT_TIMESTAMP), CURRENT_TIMESTAMP
            )`,
            [
                Number(agentId),
                profile.main_enabled ? 1 : 0,
                String(profile.preset_id || ''),
                String(profile.files_mode || 'read'),
                profile.unsafe_enabled ? 1 : 0,
                profile.web_enabled ? 1 : 0,
                terminalEnabled ? 1 : 0,
                terminalMode,
                profile.ports_enabled ? 1 : 0,
                profile.visual_enabled ? 1 : 0,
                Number(agentId)
            ]
        );
    }

    listProfileAgentIds() {
        return this.db.all(
            `SELECT agent_id FROM agent_permission_profiles ORDER BY agent_id ASC`
        ).map(row => Number(row.agent_id));
    }

    deleteAgentProfile(agentId) {
        this.db.run(`DELETE FROM agent_permission_profiles WHERE agent_id = ?`, [agentId]);
        this.db.run(`DELETE FROM agent_tool_states WHERE agent_id = ?`, [agentId]);
    }

    getAgentToolStates(agentId) {
        const rows = this.db.all(
            `SELECT tool_name, active FROM agent_tool_states WHERE agent_id = ?`,
            [agentId]
        );
        const map = {};
        rows.forEach(row => {
            map[String(row.tool_name)] = row.active === 1;
        });
        return map;
    }

    setAgentToolState(agentId, toolName, active) {
        this.db.run(
            `INSERT OR REPLACE INTO agent_tool_states (agent_id, tool_name, active, updated_at)
             VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
            [Number(agentId), String(toolName), active ? 1 : 0]
        );
    }

    setManyAgentToolStates(agentId, toolStates = {}) {
        Object.entries(toolStates).forEach(([toolName, active]) => {
            this.setAgentToolState(agentId, toolName, Boolean(active));
        });
    }

    clearAgentToolStates(agentId) {
        this.db.run(`DELETE FROM agent_tool_states WHERE agent_id = ?`, [Number(agentId)]);
    }
}

module.exports = ToolPermissionStore;
