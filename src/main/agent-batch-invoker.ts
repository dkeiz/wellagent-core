// @ts-nocheck
function parseConfig(config) {
    if (!config) return {};
    if (typeof config === 'object') return config;
    try {
        return JSON.parse(config);
    } catch {
        return {};
    }
}

async function resolveSubagent(manager, task, options = {}) {
    const id = task.subagent_id ?? task.subAgentId ?? task.agent_id ?? task.id ?? null;
    if (id !== null && id !== undefined && id !== '') {
        const agent = await manager.getAgent(id, options);
        if (!agent || agent.type !== 'sub') {
            throw new Error(`Sub-agent ${id} not found`);
        }
        return agent;
    }

    const name = String(task.name || task.agent_name || task.subagent_name || '').trim().toLowerCase();
    if (!name) {
        throw new Error('Batch task requires subagent_id, agent_id, id, or name');
    }

    const agents = await manager.getAgents('sub', options);
    const match = agents.find(agent => String(agent.name || '').toLowerCase() === name);
    if (!match) {
        throw new Error(`Sub-agent "${task.name || task.agent_name || task.subagent_name}" not found`);
    }
    return match;
}

async function resolveDefaultProvider(manager, options = {}) {
    if (!manager.db || typeof manager.db.getSetting !== 'function') {
        return 'default';
    }
    if (typeof manager.db.getScopedSetting === 'function') {
        const scoped = await manager.db.getScopedSetting('llm.provider', options);
        if (scoped) return scoped;
    }
    return options.requestContext || options.userId ? 'default' : (await manager.db.getSetting('llm.provider') || 'default');
}

function resolveTaskProvider(agent, task, defaultProvider) {
    const config = parseConfig(agent.config);
    return String(
        task.provider
        || task.options?.provider
        || config.provider
        || config.llm_provider
        || defaultProvider
        || 'default'
    ).trim() || 'default';
}

function normalizeInvokeOptions(task, provider) {
    const opts = task.options && typeof task.options === 'object' ? task.options : {};
    const concurrencyModeRaw = task.concurrency_mode || task.concurrencyMode || opts.concurrency_mode || opts.concurrencyMode || 'queued';
    const concurrencyMode = String(concurrencyModeRaw).trim().toLowerCase() === 'parallel' ? 'parallel' : 'queued';
    return {
        contractType: task.contractType || task.contract_type || opts.contractType || opts.contract_type,
        expectedOutput: task.expectedOutput || task.expected_output || opts.expectedOutput || opts.expected_output,
        subagentMode: task.subagentMode || task.subagent_mode || opts.subagentMode || opts.subagent_mode,
        permissionsContract: task.permissionsContract || task.permissions_contract || opts.permissionsContract || opts.permissions_contract || null,
        runtimePolicyProfile: task.runtimePolicyProfile || task.runtime_policy_profile || opts.runtimePolicyProfile || opts.runtime_policy_profile || 'strict-subagent',
        runtimePolicyGrants: task.runtimePolicyGrants || task.runtime_policy_grants || opts.runtimePolicyGrants || opts.runtime_policy_grants || {},
        provider,
        concurrencyMode,
        concurrency_mode: concurrencyMode,
        queueProvider: `provider:${provider}`
    };
}

async function invokeOne(manager, parentSessionId, task, index, defaultProvider, options = {}) {
    const agent = await resolveSubagent(manager, task, options);
    const prompt = String(task.task || task.prompt || '').trim();
    if (!prompt) {
        throw new Error(`Batch task ${index + 1} requires task or prompt`);
    }

    const provider = resolveTaskProvider(agent, task, defaultProvider);
    const result = await manager.invokeSubAgent(
        parentSessionId,
        agent.id,
        prompt,
        { ...normalizeInvokeOptions(task, provider), requestContext: options.requestContext || null }
    );

    return {
        ...result,
        provider,
        taskIndex: index,
        task_index: index
    };
}

async function invokeMultipleSubAgents(manager, parentSessionId, tasks, options = {}) {
    if (!Array.isArray(tasks) || tasks.length === 0) {
        return { accepted: false, success: false, error: 'tasks must be a non-empty array' };
    }

    const defaultProvider = options.defaultProvider || await resolveDefaultProvider(manager, options);
    const settled = await Promise.allSettled(
        tasks.map((task, index) => invokeOne(manager, parentSessionId, task, index, defaultProvider, options))
    );
    const results = settled.map((entry, index) => {
        if (entry.status === 'fulfilled') return entry.value;
        return {
            success: false,
            accepted: false,
            error: entry.reason?.message || String(entry.reason),
            taskIndex: index,
            task_index: index
        };
    });

    if (options.wait === true && typeof manager.waitForSubagentRun === 'function') {
        const timeoutMs = Number(options.timeoutMs || options.timeout_ms || 30000);
        await Promise.all(results.map(async (result) => {
            if (!result.run_id) return;
            result.run = await manager.waitForSubagentRun(result.run_id, timeoutMs, options);
        }));
    }

    return {
        accepted: true,
        success: true,
        total: tasks.length,
        providers: Array.from(new Set(results.map(result => result.provider).filter(Boolean))),
        results: results.sort((a, b) => (a.taskIndex || 0) - (b.taskIndex || 0))
    };
}

module.exports = { invokeMultipleSubAgents };


