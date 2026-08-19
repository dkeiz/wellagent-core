// @ts-nocheck
const fs = require('fs');
const path = require('path');
const {
    isPathInside,
    normalizePathForCompare,
    resolveBoundaryPath
} = require('./path-boundary');

const EXECUTION_ROOT_SETTING = 'execution.rootPath';
const EXECUTION_ALLOW_OUTSIDE_SETTING = 'execution.allowOutsideRoot';
const EXECUTION_AGENT_ROOT_PREFIX = 'execution.rootPath.agent.';
const EXECUTION_DEFAULT_ROOT_MARKER = '@default';

function normalizeBoolean(value) {
    return String(value || '').trim().toLowerCase() === 'true';
}

class ExecutionDirectory {
    constructor(db, options = {}) {
        this.db = db;
        this.defaultRoot = resolveBoundaryPath(options.defaultRoot || process.cwd());
    }

    getDefaultRoot() {
        return this.defaultRoot;
    }

    _agentSettingKey(scope = {}) {
        const agentId = Number(scope?.agentId ?? scope?.agent_id ?? 0);
        return Number.isInteger(agentId) && agentId > 0
            ? EXECUTION_AGENT_ROOT_PREFIX + agentId
            : null;
    }

    async _getAgentRootState(scope = {}) {
        const agentKey = this._agentSettingKey(scope);
        if (!agentKey || !this.db?.getSetting) return null;
        const storedValue = await this.db.getSetting(agentKey);
        if (storedValue !== null && storedValue !== undefined) {
            const normalized = String(storedValue || '').trim();
            return {
                configuredRoot: normalized && normalized !== EXECUTION_DEFAULT_ROOT_MARKER
                    ? resolveBoundaryPath(normalized)
                    : null,
                source: 'agent'
            };
        }

        // Capture the pre-agent setting once so existing access is preserved,
        // then this agent no longer follows later global workspace changes.
        const legacyValue = String(await this.db.getSetting(EXECUTION_ROOT_SETTING) || '').trim();
        const capturedValue = legacyValue || EXECUTION_DEFAULT_ROOT_MARKER;
        if (this.db?.saveSetting) await this.db.saveSetting(agentKey, capturedValue);
        return {
            configuredRoot: legacyValue ? resolveBoundaryPath(legacyValue) : null,
            source: 'agent-migrated'
        };
    }

    async getConfiguredRoot(scope = {}) {
        const agentState = await this._getAgentRootState(scope);
        if (agentState) return agentState.configuredRoot;
        const configured = this.db?.getSetting
            ? await this.db.getSetting(EXECUTION_ROOT_SETTING)
            : null;
        const normalized = String(configured || '').trim();
        return normalized ? resolveBoundaryPath(normalized) : null;
    }

    async getRoot(scope = {}) {
        return await this.getConfiguredRoot(scope) || this.defaultRoot;
    }

    async isOutsideAllowed() {
        const value = this.db?.getSetting
            ? await this.db.getSetting(EXECUTION_ALLOW_OUTSIDE_SETTING)
            : null;
        return normalizeBoolean(value);
    }

    async getContext(scope = {}) {
        const agentState = await this._getAgentRootState(scope);
        const configuredRoot = agentState
            ? agentState.configuredRoot
            : await this.getConfiguredRoot(scope);
        return {
            rootPath: configuredRoot || this.defaultRoot,
            configuredRoot,
            defaultRoot: this.defaultRoot,
            source: agentState?.source || (configuredRoot ? 'configured' : 'default'),
            agentId: scope?.agentId ?? scope?.agent_id ?? null,
            sessionId: scope?.sessionId ?? scope?.session_id ?? null,
            allowOutsideRoot: await this.isOutsideAllowed()
        };
    }

    async setRoot(rawPath, scope = {}) {
        const resolved = path.resolve(String(rawPath || '').trim());
        if (!resolved || !fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
            throw new Error('Execution folder must be an existing directory');
        }
        const canonical = resolveBoundaryPath(resolved);
        if (!this.db?.saveSetting) {
            throw new Error('Settings storage is unavailable');
        }
        const settingKey = this._agentSettingKey(scope) || EXECUTION_ROOT_SETTING;
        await this.db.saveSetting(
            settingKey,
            normalizePathForCompare(canonical) === normalizePathForCompare(this.defaultRoot)
                ? (this._agentSettingKey(scope) ? EXECUTION_DEFAULT_ROOT_MARKER : '')
                : canonical
        );
        return this.getContext(scope);
    }

    async clearRoot(scope = {}) {
        if (!this.db?.saveSetting) {
            throw new Error('Settings storage is unavailable');
        }
        const agentKey = this._agentSettingKey(scope);
        await this.db.saveSetting(agentKey || EXECUTION_ROOT_SETTING, agentKey ? EXECUTION_DEFAULT_ROOT_MARKER : '');
        return this.getContext(scope);
    }

    async setAllowOutsideRoot(value) {
        if (!this.db?.saveSetting) {
            throw new Error('Settings storage is unavailable');
        }
        await this.db.saveSetting(EXECUTION_ALLOW_OUTSIDE_SETTING, value ? 'true' : 'false');
        return this.getContext();
    }

    async assertPathAllowed(rawPath, options = {}) {
        const candidate = resolveBoundaryPath(rawPath);
        if (await this.isOutsideAllowed()) {
            return true;
        }

        const roots = [await this.getRoot(options), ...(options.extraRoots || [])]
            .filter(Boolean)
            .map(root => resolveBoundaryPath(root));
        if (roots.some(root => isPathInside(root, candidate))) {
            return true;
        }

        const error = new Error(`Path is outside the execution folder: ${candidate}`);
        error.code = 'OUTSIDE_EXECUTION_ROOT';
        error.executionRoot = roots[0] || null;
        throw error;
    }
}

module.exports = {
    EXECUTION_ALLOW_OUTSIDE_SETTING,
    EXECUTION_DEFAULT_ROOT_MARKER,
    EXECUTION_ROOT_SETTING,
    ExecutionDirectory,
    isInsidePath: isPathInside,
    isPathInside
};
