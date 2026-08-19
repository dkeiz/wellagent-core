// @ts-nocheck
const path = require('path');
const { buildRuntimePaths } = require('./runtime-paths');

function inferAgentinRoot(agentManager = null, sessionWorkspace = null) {
    if (agentManager?.basePath) {
        return path.dirname(agentManager.basePath);
    }
    if (sessionWorkspace?.basePath) {
        return path.dirname(sessionWorkspace.basePath);
    }
    return buildRuntimePaths().agentinRoot;
}

async function resolveAgentHome(agentManager, context = {}) {
    if (context.agentFolderPath) {
        return context.agentFolderPath;
    }
    const agentId = context.agentId ?? context.agent_id ?? null;
    if (!agentId || !agentManager) {
        return null;
    }
    if (typeof agentManager.resolveAgentFolder === 'function') {
        return agentManager.resolveAgentFolder(agentId, context);
    }
    const agent = typeof agentManager.getAgent === 'function'
        ? await agentManager.getAgent(agentId, context)
        : null;
    return agent && typeof agentManager._getAgentFolderPath === 'function'
        ? agentManager._getAgentFolderPath(agent)
        : null;
}

async function buildPathTokenMap({ agentManager = null, sessionWorkspace = null, executionDirectory = null, context = {}, sessionId = null, agentId = null } = {}) {
    const agentinRoot = inferAgentinRoot(agentManager, sessionWorkspace);
    const sid = sessionId ?? context.sessionId ?? context.session_id ?? 'default';
    const effectiveContext = {
        ...context,
        agentId: agentId ?? context.agentId ?? context.agent_id ?? null
    };
    const agentHome = await resolveAgentHome(agentManager, effectiveContext);
    const workspace = sessionWorkspace?.getWorkspacePath
        ? sessionWorkspace.getWorkspacePath(sid)
        : path.join(agentinRoot, 'workspaces', String(sid));
    const executionRoot = context.executionRoot
        || context.execution_root
        || (executionDirectory?.getRoot ? await executionDirectory.getRoot(effectiveContext) : null);

    const tokens = {
        '{agentin}': agentinRoot,
        '{workspace}': workspace,
        '{knowledge}': path.join(agentinRoot, 'knowledge'),
        '{memory}': path.join(agentinRoot, 'memory')
    };

    if (executionRoot) {
        tokens['{execution}'] = executionRoot;
        tokens['{project}'] = executionRoot;
    }

    if (agentHome) {
        tokens['{agent_home}'] = agentHome;
        tokens['{agent_tasks}'] = path.join(agentHome, 'tasks');
        tokens['{agent_outputs}'] = path.join(agentHome, 'outputs');
    }

    return tokens;
}

async function resolvePathTokens(rawPath, options = {}) {
    const input = String(rawPath || '');
    const tokens = await buildPathTokenMap(options);
    const resolved = input.replace(/\{[a-z_]+\}/gi, token => tokens[token] || token);
    return path.normalize(resolved);
}

function normalizeForTokenMatch(rawValue) {
    if (rawValue === null || rawValue === undefined) {
        return '';
    }
    const normalized = path.normalize(String(rawValue));
    return normalized.replace(/\\/g, '/');
}

function isTokenMatch(pathValue, tokenRoot) {
    if (!tokenRoot) return false;
    const left = process.platform === 'win32' ? pathValue.toLowerCase() : pathValue;
    const right = process.platform === 'win32' ? tokenRoot.toLowerCase() : tokenRoot;
    if (left === right) return true;
    return left.startsWith(`${right}/`);
}

async function tokenizePath(rawPath, options = {}) {
    const normalizedPath = normalizeForTokenMatch(rawPath);
    if (!normalizedPath) {
        return normalizedPath;
    }

    const tokens = await buildPathTokenMap(options);
    const tokenEntries = Object.entries(tokens)
        .map(([token, absolutePath]) => ({ token, absolutePath: normalizeForTokenMatch(absolutePath) }))
        .filter(entry => entry.absolutePath)
        .sort((a, b) => b.absolutePath.length - a.absolutePath.length);

    for (const entry of tokenEntries) {
        if (!isTokenMatch(normalizedPath, entry.absolutePath)) {
            continue;
        }

        const suffix = normalizedPath.slice(entry.absolutePath.length).replace(/^\/+/, '');
        return suffix ? `${entry.token}/${suffix}` : entry.token;
    }

    return normalizedPath;
}

module.exports = {
    buildPathTokenMap,
    resolvePathTokens,
    tokenizePath
};

