// @ts-nocheck
const DEFAULT_AGENT_ICON = '\u{1F916}';

const CORE_TABLES = [
    `CREATE TABLE IF NOT EXISTS calendar_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        start_time DATETIME NOT NULL,
        duration_minutes INTEGER DEFAULT 60,
        description TEXT,
        user_id TEXT NOT NULL DEFAULT 'localuser',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS todos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task TEXT NOT NULL,
        completed BOOLEAN DEFAULT FALSE,
        priority INTEGER DEFAULT 1,
        due_date DATETIME,
        session_id TEXT,
        user_id TEXT NOT NULL DEFAULT 'localuser',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        user_id TEXT NOT NULL DEFAULT 'localuser',
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES chat_sessions(id)
    )`,
    `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS api_keys (
        provider TEXT NOT NULL,
        user_id TEXT NOT NULL DEFAULT 'localuser',
        key TEXT NOT NULL,
        encrypted BOOLEAN DEFAULT FALSE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (provider, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS prompt_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        active BOOLEAN DEFAULT FALSE,
        type TEXT DEFAULT 'rule',
        user_id TEXT NOT NULL DEFAULT 'localuser',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS chat_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT,
        agent_id INTEGER,
        user_id TEXT NOT NULL DEFAULT 'localuser',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_message_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS custom_tools (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL,
        code TEXT NOT NULL,
        input_schema TEXT,
        active BOOLEAN DEFAULT FALSE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS scheduled_timers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timer_id TEXT NOT NULL,
        context_key TEXT NOT NULL,
        context_json TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        due_at DATETIME,
        interval_ms INTEGER NOT NULL,
        remaining_ms INTEGER,
        repeat INTEGER NOT NULL DEFAULT 0,
        message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        paused_at DATETIME,
        fired_at DATETIME,
        last_error TEXT,
        UNIQUE(timer_id, context_key)
    )`,
    `CREATE TABLE IF NOT EXISTS workflows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        trigger_pattern TEXT,
        tool_chain TEXT NOT NULL,
        embedding TEXT,
        visual_data TEXT,
        execution_count INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        failure_count INTEGER DEFAULT 0,
        last_used DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS agents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'pro',
        icon TEXT DEFAULT '${DEFAULT_AGENT_ICON}',
        system_prompt TEXT,
        description TEXT,
        status TEXT DEFAULT 'idle',
        visible_in_sidebar INTEGER NOT NULL DEFAULT 1,
        config TEXT,
        folder_path TEXT,
        user_id TEXT NOT NULL DEFAULT 'localuser',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS subagent_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        parent_session_id TEXT,
        child_session_id TEXT NOT NULL,
        subagent_id INTEGER NOT NULL,
        task TEXT NOT NULL,
        contract_type TEXT NOT NULL DEFAULT 'task_complete',
        expected_output TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        result_summary TEXT,
        result_payload TEXT,
        artifacts_json TEXT,
        runtime_policy_profile TEXT DEFAULT 'strict-subagent',
        runtime_policy_grants_json TEXT,
        user_id TEXT NOT NULL DEFAULT 'localuser',
        error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME,
        FOREIGN KEY (subagent_id) REFERENCES agents(id),
        FOREIGN KEY (parent_session_id) REFERENCES chat_sessions(id),
        FOREIGN KEY (child_session_id) REFERENCES chat_sessions(id)
    )`,
    `CREATE TABLE IF NOT EXISTS plugins (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'disabled',
        visible_in_sidebar INTEGER NOT NULL DEFAULT 1,
        error TEXT,
        installed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS knowledge_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        category TEXT DEFAULT 'general',
        status TEXT DEFAULT 'staged',
        tags TEXT,
        source TEXT,
        confidence REAL DEFAULT 0.5,
        folder_path TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        confirmed_at DATETIME
    )`,
    `CREATE TABLE IF NOT EXISTS memory_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_type TEXT NOT NULL,
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL DEFAULT 'localuser',
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_run_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        locked_at DATETIME,
        locked_by TEXT,
        payload_json TEXT,
        result_summary TEXT,
        last_error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS daemon_session_inspections (
        session_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL DEFAULT 'localuser',
        inspector TEXT NOT NULL DEFAULT 'memory-daemon',
        inspected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        job_id INTEGER,
        notes TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        role TEXT NOT NULL DEFAULT 'owner',
        username TEXT UNIQUE,
        display_name TEXT NOT NULL,
        auth_provider TEXT,
        is_default INTEGER NOT NULL DEFAULT 0,
        email TEXT,
        password_hash TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        bio TEXT,
        last_login_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS tool_states (
        tool_name TEXT PRIMARY KEY,
        active BOOLEAN DEFAULT TRUE,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS tool_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool_call_id TEXT NOT NULL UNIQUE,
        session_id TEXT,
        user_id TEXT NOT NULL DEFAULT 'localuser',
        tool_name TEXT NOT NULL,
        parameters TEXT,
        success INTEGER NOT NULL,
        result TEXT,
        error TEXT,
        source TEXT,
        agent_id INTEGER,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    )`
];

const INDEXES = [
    `CREATE INDEX IF NOT EXISTS idx_memory_jobs_schedule
        ON memory_jobs (user_id, job_type, status, next_run_at, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_memory_jobs_session
        ON memory_jobs (user_id, job_type, session_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_daemon_session_inspections_time
        ON daemon_session_inspections (user_id, inspected_at)`,
    `CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_last
        ON chat_sessions (user_id, last_message_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_conversations_user_session_id
        ON conversations (user_id, session_id, id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_user_name_unique
        ON agents (user_id, name)`,
    `CREATE INDEX IF NOT EXISTS idx_agents_user_type_name
        ON agents (user_id, type, name)`,
    `CREATE INDEX IF NOT EXISTS idx_subagent_runs_user_created
        ON subagent_runs (user_id, created_at DESC, id DESC)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique
        ON users (email)
        WHERE email IS NOT NULL AND email != ''`,
    `CREATE INDEX IF NOT EXISTS idx_tool_calls_user_session_time
        ON tool_calls (user_id, session_id, timestamp DESC, id DESC)`
];

const LEGACY_COLUMNS = {
    calendar_events: [
        ['user_id', "TEXT NOT NULL DEFAULT 'localuser'"]
    ],
    todos: [
        ['session_id', 'TEXT'],
        ['user_id', "TEXT NOT NULL DEFAULT 'localuser'"]
    ],
    conversations: [
        ['session_id', 'TEXT'],
        ['user_id', "TEXT NOT NULL DEFAULT 'localuser'"],
        ['metadata', 'TEXT'],
        ['timestamp', 'DATETIME']
    ],
    workflows: [
        ['description', 'TEXT'],
        ['trigger_pattern', 'TEXT'],
        ['embedding', 'TEXT'],
        ['visual_data', 'TEXT'],
        ['execution_count', 'INTEGER DEFAULT 0'],
        ['success_count', 'INTEGER DEFAULT 0'],
        ['failure_count', 'INTEGER DEFAULT 0'],
        ['last_used', 'DATETIME'],
        ['created_at', 'DATETIME']
    ],
    chat_sessions: [
        ['agent_id', 'INTEGER'],
        ['user_id', "TEXT NOT NULL DEFAULT 'localuser'"],
        ['created_at', 'DATETIME'],
        ['last_message_at', 'DATETIME']
    ],
    daemon_session_inspections: [
        ['user_id', "TEXT NOT NULL DEFAULT 'localuser'"],
        ['inspector', "TEXT NOT NULL DEFAULT 'memory-daemon'"],
        ['inspected_at', 'DATETIME'],
        ['job_id', 'INTEGER'],
        ['notes', 'TEXT']
    ],
    api_keys: [
        ['encrypted', 'BOOLEAN DEFAULT FALSE'],
        ['created_at', 'DATETIME']
    ],
    prompt_rules: [
        ['active', 'BOOLEAN DEFAULT FALSE'],
        ['type', "TEXT DEFAULT 'rule'"],
        ['user_id', "TEXT NOT NULL DEFAULT 'localuser'"],
        ['created_at', 'DATETIME'],
        ['updated_at', 'DATETIME']
    ],
    custom_tools: [
        ['input_schema', 'TEXT'],
        ['active', 'BOOLEAN DEFAULT FALSE'],
        ['created_at', 'DATETIME']
    ],
    scheduled_timers: [
        ['timer_id', 'TEXT'],
        ['context_key', 'TEXT'],
        ['context_json', 'TEXT'],
        ['status', "TEXT NOT NULL DEFAULT 'active'"],
        ['due_at', 'DATETIME'],
        ['interval_ms', 'INTEGER NOT NULL DEFAULT 0'],
        ['remaining_ms', 'INTEGER'],
        ['repeat', 'INTEGER NOT NULL DEFAULT 0'],
        ['message', 'TEXT'],
        ['created_at', 'DATETIME'],
        ['updated_at', 'DATETIME'],
        ['paused_at', 'DATETIME'],
        ['fired_at', 'DATETIME'],
        ['last_error', 'TEXT']
    ],
    agents: [
        ['type', "TEXT NOT NULL DEFAULT 'pro'"],
        ['icon', `TEXT DEFAULT '${DEFAULT_AGENT_ICON}'`],
        ['system_prompt', 'TEXT'],
        ['description', 'TEXT'],
        ['status', "TEXT DEFAULT 'idle'"],
        ['visible_in_sidebar', 'INTEGER NOT NULL DEFAULT 1'],
        ['config', 'TEXT'],
        ['folder_path', 'TEXT'],
        ['created_at', 'DATETIME'],
        ['updated_at', 'DATETIME']
    ],
    subagent_runs: [
        ['parent_session_id', 'TEXT'],
        ['contract_type', "TEXT NOT NULL DEFAULT 'task_complete'"],
        ['expected_output', 'TEXT'],
        ['status', "TEXT NOT NULL DEFAULT 'running'"],
        ['result_summary', 'TEXT'],
        ['result_payload', 'TEXT'],
        ['artifacts_json', 'TEXT'],
        ['runtime_policy_profile', "TEXT DEFAULT 'strict-subagent'"],
        ['runtime_policy_grants_json', 'TEXT'],
        ['error', 'TEXT'],
        ['created_at', 'DATETIME'],
        ['completed_at', 'DATETIME']
    ],
    plugins: [
        ['status', "TEXT NOT NULL DEFAULT 'disabled'"],
        ['visible_in_sidebar', 'INTEGER NOT NULL DEFAULT 1'],
        ['error', 'TEXT'],
        ['installed_at', 'DATETIME'],
        ['updated_at', 'DATETIME']
    ],
    knowledge_items: [
        ['category', "TEXT DEFAULT 'general'"],
        ['status', "TEXT DEFAULT 'staged'"],
        ['tags', 'TEXT'],
        ['source', 'TEXT'],
        ['confidence', 'REAL DEFAULT 0.5'],
        ['folder_path', "TEXT NOT NULL DEFAULT ''"],
        ['created_at', 'DATETIME'],
        ['updated_at', 'DATETIME'],
        ['confirmed_at', 'DATETIME']
    ],
    memory_jobs: [
        ['user_id', "TEXT NOT NULL DEFAULT 'localuser'"],
        ['status', "TEXT NOT NULL DEFAULT 'pending'"],
        ['attempts', 'INTEGER NOT NULL DEFAULT 0'],
        ['next_run_at', 'DATETIME'],
        ['locked_at', 'DATETIME'],
        ['locked_by', 'TEXT'],
        ['payload_json', 'TEXT'],
        ['result_summary', 'TEXT'],
        ['last_error', 'TEXT'],
        ['created_at', 'DATETIME'],
        ['updated_at', 'DATETIME']
    ],
    tool_states: [
        ['active', 'BOOLEAN DEFAULT TRUE'],
        ['updated_at', 'DATETIME']
    ]
};

function quoteIdentifier(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
}

function tableExists(db, tableName) {
    return Boolean(db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
    ).get(tableName));
}

function getColumns(db, tableName) {
    if (!tableExists(db, tableName)) {
        return new Set();
    }
    return new Set(
        db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`)
            .all()
            .map(row => row.name)
    );
}

function getTableSql(db, tableName) {
    if (!tableExists(db, tableName)) {
        return '';
    }
    const row = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?"
    ).get(tableName);
    return String(row?.sql || '');
}


function addColumnIfMissing(db, tableName, columnName, definition) {
    const columns = getColumns(db, tableName);
    if (columns.has(columnName)) {
        return false;
    }
    db.exec(`ALTER TABLE ${quoteIdentifier(tableName)} ADD COLUMN ${quoteIdentifier(columnName)} ${definition}`);
    return true;
}

function ensureLegacyColumns(db) {
    for (const [tableName, columns] of Object.entries(LEGACY_COLUMNS)) {
        if (!tableExists(db, tableName)) {
            continue;
        }
        for (const [columnName, definition] of columns) {
            addColumnIfMissing(db, tableName, columnName, definition);
        }
    }
}

function ensureToolCallAuditSchema(db) {
    const targetSql = `CREATE TABLE tool_calls__audit_migration (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool_call_id TEXT NOT NULL UNIQUE,
        session_id TEXT,
        user_id TEXT NOT NULL DEFAULT 'localuser',
        tool_name TEXT NOT NULL,
        parameters TEXT,
        success INTEGER NOT NULL,
        result TEXT,
        error TEXT,
        source TEXT,
        agent_id INTEGER,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    )`;
    if (!tableExists(db, 'tool_calls')) {
        db.exec(targetSql.replace('tool_calls__audit_migration', 'tool_calls'));
    } else {
        const columns = getColumns(db, 'tool_calls');
        const tableSql = getTableSql(db, 'tool_calls');
        const complete = ['tool_call_id', 'session_id', 'user_id', 'tool_name', 'parameters', 'success',
            'result', 'error', 'source', 'agent_id', 'timestamp'].every(name => columns.has(name));
        const nullableSession = !/session_id\s+(?:INTEGER|TEXT)\s+NOT\s+NULL/i.test(tableSql);
        if (!complete || !nullableSession) {
            const value = (name, fallback = 'NULL') => columns.has(name) ? quoteIdentifier(name) : fallback;
            const legacyId = value('id', 'rowid');
            const legacySession = value('session_id');
            db.exec('DROP TABLE IF EXISTS tool_calls__audit_migration');
            db.exec(targetSql);
            db.exec(`INSERT INTO tool_calls__audit_migration (
                id, tool_call_id, session_id, user_id, tool_name, parameters, success,
                result, error, source, agent_id, timestamp
            ) SELECT
                ${legacyId},
                ${columns.has('tool_call_id') ? `COALESCE(NULLIF(tool_call_id, ''), 'legacy-' || ${legacyId})` : `'legacy-' || ${legacyId}`},
                CASE WHEN ${legacySession} IS NOT NULL AND EXISTS (
                    SELECT 1 FROM chat_sessions s WHERE CAST(s.id AS TEXT) = CAST(${legacySession} AS TEXT)
                ) THEN CAST(${legacySession} AS TEXT) ELSE NULL END,
                ${columns.has('user_id') ? "COALESCE(NULLIF(user_id, ''), 'localuser')" : "'localuser'"},
                ${value('tool_name', "'unknown'")}, ${value('parameters')}, COALESCE(${value('success', '0')}, 0),
                ${value('result')}, ${value('error')}, ${value('source')}, ${value('agent_id')},
                COALESCE(${value('timestamp', 'CURRENT_TIMESTAMP')}, CURRENT_TIMESTAMP)
            FROM tool_calls`);
            db.exec('DROP TABLE tool_calls');
            db.exec('ALTER TABLE tool_calls__audit_migration RENAME TO tool_calls');
        }
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_calls_user_session_time
        ON tool_calls (user_id, session_id, timestamp DESC, id DESC)`);
}

function ensurePermissionSchema(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_permission_profiles (
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
    )`);
    const profileColumns = [
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
    for (const [columnName, definition] of profileColumns) {
        addColumnIfMissing(db, 'agent_permission_profiles', columnName, definition);
    }

    db.exec(`CREATE TABLE IF NOT EXISTS agent_tool_states (
        agent_id INTEGER NOT NULL,
        tool_name TEXT NOT NULL,
        active INTEGER NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (agent_id, tool_name)
    )`);
}

function ensureUserSchema(db) {
    db.exec(
        `CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        role TEXT NOT NULL DEFAULT 'owner',
        username TEXT UNIQUE,
        display_name TEXT NOT NULL,
        auth_provider TEXT,
        is_default INTEGER NOT NULL DEFAULT 0,
        email TEXT,
        password_hash TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        bio TEXT,
        last_login_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
    );
    const userColumns = [
        ['role', "TEXT NOT NULL DEFAULT 'owner'"],
        ['username', 'TEXT'],
        ['display_name', "TEXT NOT NULL DEFAULT 'Owner'"],
        ['auth_provider', 'TEXT'],
        ['is_default', 'INTEGER NOT NULL DEFAULT 0'],
        ['email', 'TEXT'],
        ['password_hash', 'TEXT'],
        ['status', "TEXT NOT NULL DEFAULT 'active'"],
        ['bio', 'TEXT'],
        ['last_login_at', 'DATETIME'],
        ['created_at', 'DATETIME'],
        ['updated_at', 'DATETIME']
    ];
    for (const [columnName, definition] of userColumns) {
        addColumnIfMissing(db, 'users', columnName, definition);
    }
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users (email) WHERE email IS NOT NULL AND email != ''");
}

function ensurePromptRuleOwnership(db) {
    if (!tableExists(db, 'prompt_rules')) return;
    addColumnIfMissing(db, 'prompt_rules', 'user_id', "TEXT NOT NULL DEFAULT 'localuser'");
    db.exec("UPDATE prompt_rules SET user_id = 'localuser' WHERE user_id IS NULL OR TRIM(user_id) = ''");
    db.exec('CREATE INDEX IF NOT EXISTS idx_prompt_rules_user_created ON prompt_rules (user_id, created_at DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_prompt_rules_user_name ON prompt_rules (user_id, name)');
}

function ensureChatUserOwnership(db) {
    if (tableExists(db, 'chat_sessions')) {
        addColumnIfMissing(db, 'chat_sessions', 'user_id', "TEXT NOT NULL DEFAULT 'localuser'");
        db.exec("UPDATE chat_sessions SET user_id = 'localuser' WHERE user_id IS NULL OR TRIM(user_id) = ''");
    }

    if (tableExists(db, 'conversations')) {
        addColumnIfMissing(db, 'conversations', 'user_id', "TEXT NOT NULL DEFAULT 'localuser'");
        db.exec(`
            UPDATE conversations
            SET user_id = COALESCE(
                (
                    SELECT cs.user_id
                    FROM chat_sessions cs
                    WHERE CAST(cs.id AS TEXT) = CAST(conversations.session_id AS TEXT)
                    LIMIT 1
                ), 'localuser')
            WHERE user_id IS NULL OR TRIM(user_id) = ''
        `);
    }

    db.exec('CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_last ON chat_sessions (user_id, last_message_at DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_user_session_id ON conversations (user_id, session_id, id)');
}

function ensureWorkflowUserOwnership(db) {
    if (!tableExists(db, 'workflows')) return;
    addColumnIfMissing(db, 'workflows', 'user_id', "TEXT NOT NULL DEFAULT 'localuser'");
    db.exec("UPDATE workflows SET user_id = 'localuser' WHERE user_id IS NULL OR TRIM(user_id) = ''");
    db.exec('CREATE INDEX IF NOT EXISTS idx_workflows_user_last ON workflows (user_id, success_count DESC, last_used DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_workflows_user_name ON workflows (user_id, name)');
}
function ensureCalendarAndTodoUserOwnership(db) {
    if (tableExists(db, 'calendar_events')) {
        addColumnIfMissing(db, 'calendar_events', 'user_id', "TEXT NOT NULL DEFAULT 'localuser'");
        db.exec("UPDATE calendar_events SET user_id = 'localuser' WHERE user_id IS NULL OR TRIM(user_id) = ''");
        db.exec('CREATE INDEX IF NOT EXISTS idx_calendar_events_user_start ON calendar_events (user_id, start_time)');
    }

    if (!tableExists(db, 'todos')) return;
    addColumnIfMissing(db, 'todos', 'user_id', "TEXT NOT NULL DEFAULT 'localuser'");

    if (tableExists(db, 'chat_sessions')) {
        db.exec(`
            UPDATE todos
            SET user_id = COALESCE(
                (
                    SELECT cs.user_id
                    FROM chat_sessions cs
                    WHERE CAST(cs.id AS TEXT) = todos.session_id
                    LIMIT 1
                ), 'localuser')
            WHERE user_id IS NULL OR TRIM(user_id) = ''
        `);
    }

    db.exec("UPDATE todos SET user_id = 'localuser' WHERE user_id IS NULL OR TRIM(user_id) = ''");
    db.exec('CREATE INDEX IF NOT EXISTS idx_todos_user_session_created ON todos (user_id, session_id, created_at)');
}

function ensureAgentAndSubagentUserOwnership(db) {
    if (tableExists(db, 'agents')) {
        const agentColumns = getColumns(db, 'agents');
        const agentSql = getTableSql(db, 'agents');
        const needsRebuild = !agentColumns.has('user_id') || /name\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(agentSql);
        if (needsRebuild) {
            db.exec('PRAGMA foreign_keys = OFF');
            db.exec('DROP TABLE IF EXISTS agents__owned_migration');
            db.exec(`CREATE TABLE agents__owned_migration (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                type TEXT NOT NULL DEFAULT 'pro',
                icon TEXT DEFAULT '${DEFAULT_AGENT_ICON}',
                system_prompt TEXT,
                description TEXT,
                status TEXT DEFAULT 'idle',
                visible_in_sidebar INTEGER NOT NULL DEFAULT 1,
                config TEXT,
                folder_path TEXT,
                user_id TEXT NOT NULL DEFAULT 'localuser',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            const userSelect = agentColumns.has('user_id') ? "COALESCE(user_id, 'localuser')" : "'localuser'";
            db.exec(`INSERT INTO agents__owned_migration (
                id,
                name,
                type,
                icon,
                system_prompt,
                description,
                status,
                visible_in_sidebar,
                config,
                folder_path,
                user_id,
                created_at,
                updated_at
            )
            SELECT
                id,
                name,
                COALESCE(type, 'pro'),
                COALESCE(icon, '${DEFAULT_AGENT_ICON}'),
                COALESCE(system_prompt, ''),
                COALESCE(description, ''),
                COALESCE(status, 'idle'),
                COALESCE(visible_in_sidebar, 1),
                config,
                COALESCE(folder_path, ''),
                ${userSelect},
                created_at,
                updated_at
            FROM agents`);
            db.exec('DROP TABLE agents');
            db.exec('ALTER TABLE agents__owned_migration RENAME TO agents');
            db.exec('PRAGMA foreign_keys = ON');
        } else {
            addColumnIfMissing(db, 'agents', 'user_id', "TEXT NOT NULL DEFAULT 'localuser'");
        }
        db.exec("UPDATE agents SET user_id = 'localuser' WHERE user_id IS NULL OR TRIM(user_id) = ''");
        db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_user_name_unique ON agents (user_id, name)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_agents_user_type_name ON agents (user_id, type, name)');
    }

    if (!tableExists(db, 'subagent_runs')) return;
    addColumnIfMissing(db, 'subagent_runs', 'user_id', "TEXT NOT NULL DEFAULT 'localuser'");
    db.exec(`
        UPDATE subagent_runs
        SET user_id = COALESCE(
            (
                SELECT a.user_id
                FROM agents a
                WHERE a.id = subagent_runs.subagent_id
                LIMIT 1
            ),
            (
                SELECT cs.user_id
                FROM chat_sessions cs
                WHERE CAST(cs.id AS TEXT) = CAST(subagent_runs.parent_session_id AS TEXT)
                LIMIT 1
            ), 'localuser')
        WHERE user_id IS NULL OR TRIM(user_id) = ''
    `);
    db.exec("UPDATE subagent_runs SET user_id = 'localuser' WHERE user_id IS NULL OR TRIM(user_id) = ''");
    db.exec('CREATE INDEX IF NOT EXISTS idx_subagent_runs_user_created ON subagent_runs (user_id, created_at DESC, id DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_subagent_runs_user_parent ON subagent_runs (user_id, parent_session_id, created_at DESC)');
}

function ensureApiKeyUserOwnership(db) {
    if (!tableExists(db, 'api_keys')) return;
    const columns = getColumns(db, 'api_keys');
    const sql = getTableSql(db, 'api_keys');
    const hasCompositeKey = /PRIMARY KEY\s*\(\s*provider\s*,\s*user_id\s*\)/i.test(sql);
    const needsRebuild = !columns.has('user_id') || /provider\s+TEXT\s+PRIMARY\s+KEY/i.test(sql) || !hasCompositeKey;
    if (needsRebuild) {
        db.exec('PRAGMA foreign_keys = OFF');
        db.exec('DROP TABLE IF EXISTS api_keys__owned_migration');
        db.exec(`CREATE TABLE api_keys__owned_migration (
            provider TEXT NOT NULL,
            user_id TEXT NOT NULL DEFAULT 'localuser',
            key TEXT NOT NULL,
            encrypted BOOLEAN DEFAULT FALSE,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (provider, user_id)
        )`);
        const userSelect = columns.has('user_id') ? "COALESCE(user_id, 'localuser')" : "'localuser'";
        db.exec(`INSERT INTO api_keys__owned_migration (provider, user_id, key, encrypted, created_at)
            SELECT provider, ${userSelect}, key, COALESCE(encrypted, 0), created_at
            FROM api_keys`);
        db.exec('DROP TABLE api_keys');
        db.exec('ALTER TABLE api_keys__owned_migration RENAME TO api_keys');
        db.exec('PRAGMA foreign_keys = ON');
    } else {
        addColumnIfMissing(db, 'api_keys', 'user_id', "TEXT NOT NULL DEFAULT 'localuser'");
    }
    db.exec("UPDATE api_keys SET user_id = 'localuser' WHERE user_id IS NULL OR TRIM(user_id) = ''");
    db.exec('CREATE INDEX IF NOT EXISTS idx_api_keys_user_provider ON api_keys (user_id, provider)');
}

function ensureMemoryJobOwnership(db) {
    if (tableExists(db, 'memory_jobs')) {
        addColumnIfMissing(db, 'memory_jobs', 'user_id', "TEXT NOT NULL DEFAULT 'localuser'");
        if (tableExists(db, 'chat_sessions')) {
            db.exec(`
                UPDATE memory_jobs
                SET user_id = COALESCE((
                    SELECT COALESCE(cs.user_id, 'localuser')
                    FROM chat_sessions cs
                    WHERE CAST(cs.id AS TEXT) = CAST(memory_jobs.session_id AS TEXT)
                    LIMIT 1
                ), 'localuser')
                WHERE user_id IS NULL OR TRIM(user_id) = ''
            `);
        }
        db.exec("UPDATE memory_jobs SET user_id = 'localuser' WHERE user_id IS NULL OR TRIM(user_id) = ''");
        db.exec('CREATE INDEX IF NOT EXISTS idx_memory_jobs_schedule ON memory_jobs (user_id, job_type, status, next_run_at, created_at)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_memory_jobs_session ON memory_jobs (user_id, job_type, session_id, status)');
    }

    if (tableExists(db, 'daemon_session_inspections')) {
        addColumnIfMissing(db, 'daemon_session_inspections', 'user_id', "TEXT NOT NULL DEFAULT 'localuser'");
        if (tableExists(db, 'chat_sessions')) {
            db.exec(`
                UPDATE daemon_session_inspections
                SET user_id = COALESCE((
                    SELECT COALESCE(cs.user_id, 'localuser')
                    FROM chat_sessions cs
                    WHERE CAST(cs.id AS TEXT) = CAST(daemon_session_inspections.session_id AS TEXT)
                    LIMIT 1
                ), 'localuser')
                WHERE user_id IS NULL OR TRIM(user_id) = ''
            `);
        }
        db.exec("UPDATE daemon_session_inspections SET user_id = 'localuser' WHERE user_id IS NULL OR TRIM(user_id) = ''");
        db.exec('CREATE INDEX IF NOT EXISTS idx_daemon_session_inspections_time ON daemon_session_inspections (user_id, inspected_at)');
    }
}

function ensureTodoSessionScope(db) {
    if (!tableExists(db, 'todos')) return;
    addColumnIfMissing(db, 'todos', 'session_id', 'TEXT');

    if (tableExists(db, 'chat_sessions')) {
        db.exec(`
            UPDATE todos
            SET session_id = (
                SELECT CAST(cs.id AS TEXT)
                FROM chat_sessions cs
                WHERE todos.created_at IS NOT NULL
                  AND cs.created_at IS NOT NULL
                  AND datetime(todos.created_at) >= datetime(cs.created_at, '-2 seconds')
                  AND datetime(todos.created_at) <= datetime(COALESCE(cs.last_message_at, cs.created_at), '+5 minutes')
                ORDER BY datetime(COALESCE(cs.last_message_at, cs.created_at)) ASC,
                         datetime(cs.created_at) DESC
                LIMIT 1
            )
            WHERE (session_id IS NULL OR session_id = '')
              AND EXISTS (
                SELECT 1
                FROM chat_sessions cs
                WHERE todos.created_at IS NOT NULL
                  AND cs.created_at IS NOT NULL
                  AND datetime(todos.created_at) >= datetime(cs.created_at, '-2 seconds')
                  AND datetime(todos.created_at) <= datetime(COALESCE(cs.last_message_at, cs.created_at), '+5 minutes')
              )
        `);
    }

    db.exec('CREATE INDEX IF NOT EXISTS idx_todos_session_created ON todos (session_id, created_at)');
}

function ensureAgentSidebarVisibility(db) {
    if (!tableExists(db, 'agents')) return;
    addColumnIfMissing(db, 'agents', 'visible_in_sidebar', 'INTEGER NOT NULL DEFAULT 1');
}

function rewriteBuiltInUserIdentity(db) {
    const ownedTables = [
        'calendar_events',
        'todos',
        'conversations',
        'api_keys',
        'prompt_rules',
        'chat_sessions',
        'agents',
        'subagent_runs',
        'workflows',
        'memory_jobs',
        'daemon_session_inspections'
    ];
    for (const tableName of ownedTables) {
        if (!tableExists(db, tableName) || !getColumns(db, tableName).has('user_id')) {
            continue;
        }
        db.exec(`UPDATE ${quoteIdentifier(tableName)} SET user_id = 'localuser' WHERE user_id = 'owner'`);
    }

    if (tableExists(db, 'users')) {
        db.exec("UPDATE users SET user_id = 'localuser', username = 'localuser', display_name = 'Local User', updated_at = CURRENT_TIMESTAMP WHERE user_id = 'owner'");

    }

    if (tableExists(db, 'settings')) {
        db.exec("UPDATE settings SET key = REPLACE(key, '.owner', '.localuser') WHERE key LIKE '%.owner'");
    }
}

const MIGRATIONS = [
    {
        id: '0001_core_schema',
        description: 'Create current core tables and indexes',
        up(db) {
            for (const query of CORE_TABLES) {
                db.exec(query);
            }
        }
    },
    {
        id: '0002_legacy_core_columns',
        description: 'Patch legacy tables with columns added after first release',
        up(db) {
            ensureLegacyColumns(db);
            for (const query of INDEXES) {
                db.exec(query);
            }
        }
    },
    {
        id: '0003_permission_schema',
        description: 'Create and patch per-agent tool permission tables',
        up(db) {
            ensurePermissionSchema(db);
        }
    },
    {
        id: '0004_scheduled_timers',
        description: 'Create persistent backend timer table',
        up(db) {
            db.exec(CORE_TABLES.find(query => query.includes('scheduled_timers')));
        }
    },
    {
        id: '0005_todo_session_scope',
        description: 'Scope todo rows to chat sessions',
        up(db) {
            ensureTodoSessionScope(db);
        }
    },
    {
        id: '0006_agent_sidebar_visibility',
        description: 'Allow agents to be hidden from sidebar lists',
        up(db) {
            ensureAgentSidebarVisibility(db);
        }
    },
    {
        id: '0007_user_registry',
        description: 'Create and patch shared-backend user registry schema',
        up(db) {
            ensureUserSchema(db);
        }
    },
    {
        id: '0008_chat_user_ownership',
        description: 'Scope chat sessions and conversations to shared-backend users',
        up(db) {
            ensureChatUserOwnership(db);
        }
    },
    {
        id: '0009_user_web_auth',
        description: 'Extend shared users with web auth fields and email identity',
        up(db) {
            ensureUserSchema(db);
        }
    },
    {
        id: '0010_workflow_user_ownership',
        description: 'Scope workflow definitions to shared-backend users',
        up(db) {
            ensureWorkflowUserOwnership(db);
        }
    },
    {
        id: '0011_prompt_rule_user_ownership',
        description: 'Scope prompt rules to shared-backend users',
        up(db) {
            ensurePromptRuleOwnership(db);
        }
    },
    {
        id: '0012_calendar_todo_user_ownership',
        description: 'Scope calendar events and todos to shared-backend users',
        up(db) {
            ensureCalendarAndTodoUserOwnership(db);
        }
    },
    {
        id: '0013_agent_user_ownership',
        description: 'Scope agents and legacy subagent runs to shared-backend users',
        up(db) {
            ensureAgentAndSubagentUserOwnership(db);
        }
    },
    {
        id: '0014_api_key_user_ownership',
        description: 'Scope provider secrets and credentials to shared-backend users',
        up(db) {
            ensureApiKeyUserOwnership(db);
        }
    },
    {
        id: '0015_localuser_builtin_identity',
        description: 'Rewrite legacy built-in owner identity to localuser',
        up(db) {
            rewriteBuiltInUserIdentity(db);
        }
    },
    {
        id: '0016_memory_job_user_ownership',
        description: 'Scope queued memory jobs and daemon inspections to shared-backend users',
        up(db) {
            ensureMemoryJobOwnership(db);
        }
    },
    {
        id: '0017_tool_call_audit',
        description: 'Create durable user-scoped tool execution audit records',
        up(db) {
            ensureToolCallAuditSchema(db);
        }
    },
    {
        id: '0018_remove_profile_identity',
        description: 'Remove the redundant profile identity from shared users',
        up(db) {
            if (getColumns(db, 'users').has('profile_id')) {
                db.exec('ALTER TABLE users DROP COLUMN profile_id');
            }
        }
    }
];

function ensureMigrationTable(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
        migration_id TEXT PRIMARY KEY,
        description TEXT,
        applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
}

function runDatabaseMigrations(db) {
    ensureMigrationTable(db);
    const applied = new Set(
        db.prepare('SELECT migration_id FROM schema_migrations')
            .all()
            .map(row => row.migration_id)
    );
    const result = { applied: [], skipped: [] };

    for (const migration of MIGRATIONS) {
        if (applied.has(migration.id)) {
            result.skipped.push(migration.id);
            continue;
        }
        const run = db.transaction(() => {
            migration.up(db);
            db.prepare(
                'INSERT OR REPLACE INTO schema_migrations (migration_id, description) VALUES (?, ?)'
            ).run(migration.id, migration.description);
        });
        run();
        result.applied.push(migration.id);
    }

    return result;
}

module.exports = {
    MIGRATIONS,
    addColumnIfMissing,
    ensureLegacyColumns,
    ensurePermissionSchema,
    ensureAgentSidebarVisibility,
    ensureAgentAndSubagentUserOwnership,
    ensureMemoryJobOwnership,
    ensureApiKeyUserOwnership,
    ensureCalendarAndTodoUserOwnership,
    ensureChatUserOwnership,
    ensurePromptRuleOwnership,
    ensureToolCallAuditSchema,
    ensureTodoSessionScope,
    ensureWorkflowUserOwnership,
    runDatabaseMigrations
};

