// @ts-nocheck
const fs = require('fs');
const path = require('path');
const { buildRuntimePaths } = require('./runtime-paths');
const { DEFAULT_USER_ID, normalizeUserId } = require('./user-scope');
const { sanitizeScopedUserFolder } = require('./runtime-paths');

class SessionWorkspace {
    constructor(input = null) {
        const options = input && typeof input === 'object' ? input : { basePath: input };
        const runtimePaths = buildRuntimePaths(options);
        this.basePath = path.resolve(options.basePath || runtimePaths.sessionWorkspaceBase);
        this.agentinRoot = path.resolve(options.agentinRoot || runtimePaths.agentinRoot);
        this.db = options.db || null;
        this.getActiveUserId = typeof options.getActiveUserId === 'function' ? options.getActiveUserId : null;
        this._ensureBase(this.basePath);
    }

    _ensureBase(basePath) {
        if (!fs.existsSync(basePath)) fs.mkdirSync(basePath, { recursive: true });
    }

    _normalizeSessionId(sessionId) {
        const normalized = String(sessionId ?? '').trim();
        if (!normalized || normalized === '.' || normalized === '..' || path.isAbsolute(normalized)
            || normalized.includes('/') || normalized.includes('\\')
            || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized)) {
            throw new Error('Invalid session workspace id');
        }
        return normalized;
    }

    _resolveUserId(sessionId, options = {}) {
        const explicit = options.userId || options.user_id || options.requestContext?.userId;
        if (explicit) return normalizeUserId(explicit, DEFAULT_USER_ID);
        if (this.db?.get) {
            const row = this.db.get('SELECT user_id FROM chat_sessions WHERE CAST(id AS TEXT) = CAST(? AS TEXT)', [String(sessionId)]);
            if (row?.user_id) return normalizeUserId(row.user_id, DEFAULT_USER_ID);
        }
        return normalizeUserId(this.getActiveUserId?.(), DEFAULT_USER_ID);
    }

    _resolveBasePath(sessionId, options = {}) {
        const userId = this._resolveUserId(sessionId, options);
        return userId === DEFAULT_USER_ID
            ? this.basePath
            : path.join(this.agentinRoot, 'users', sanitizeScopedUserFolder(userId), 'workspaces');
    }

    _resolveWorkspacePath(sessionId, options = {}) {
        const safeSessionId = this._normalizeSessionId(sessionId);
        const basePath = path.resolve(this._resolveBasePath(safeSessionId, options));
        const resolved = path.resolve(basePath, safeSessionId);
        if (resolved !== basePath && !resolved.startsWith(basePath + path.sep)) {
            throw new Error('Session workspace path escaped base directory');
        }
        return resolved;
    }

    getWorkspacePath(sessionId, options = {}) {
        const dir = this._resolveWorkspacePath(sessionId, options);
        this._ensureBase(dir);
        return dir;
    }

    writeOutput(sessionId, label, content, options = {}) {
        const dir = this.getWorkspacePath(sessionId, options);
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const safeName = (label || 'output').replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 60);
        const fileName = `${safeName}_${timestamp}.log`;
        const filePath = path.join(dir, fileName);
        fs.writeFileSync(filePath, content, 'utf-8');
        return { filePath, fileName, size: Buffer.byteLength(content, 'utf-8') };
    }

    listFiles(sessionId, options = {}) {
        const dir = this._resolveWorkspacePath(sessionId, options);
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir).filter((name) => !name.startsWith('.')).map((name) => {
            const filePath = path.join(dir, name);
            const stat = fs.statSync(filePath);
            return stat.isFile() ? { name, path: filePath, size: stat.size, created: stat.birthtime } : null;
        }).filter(Boolean);
    }

    searchFiles(sessionId, query, options = {}) {
        const results = [];
        const lowerQuery = String(query || '').toLowerCase();
        for (const file of this.listFiles(sessionId, options)) {
            try {
                const matches = fs.readFileSync(file.path, 'utf-8').split('\n')
                    .map((line, index) => ({ line: index + 1, content: line.trim().substring(0, 200) }))
                    .filter((entry) => entry.content.toLowerCase().includes(lowerQuery));
                if (matches.length) results.push({ file: file.name, path: file.path, matchCount: matches.length, matches: matches.slice(0, 20) });
            } catch (_error) {}
        }
        return results;
    }

    cleanup(sessionId, options = {}) {
        const dir = this._resolveWorkspacePath(sessionId, options);
        if (!fs.existsSync(dir)) return false;
        fs.rmSync(dir, { recursive: true, force: true });
        return true;
    }

    cleanupStale(maxAgeDays = 30) {
        const roots = [this.basePath];
        const usersRoot = path.join(this.agentinRoot, 'users');
        if (fs.existsSync(usersRoot)) {
            for (const entry of fs.readdirSync(usersRoot, { withFileTypes: true })) {
                if (entry.isDirectory()) roots.push(path.join(usersRoot, entry.name, 'workspaces'));
            }
        }
        const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
        let cleaned = 0;
        for (const root of roots) {
            if (!fs.existsSync(root)) continue;
            for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
                if (!entry.isDirectory()) continue;
                const dirPath = path.join(root, entry.name);
                try {
                    if (fs.statSync(dirPath).mtime.getTime() < cutoff) {
                        fs.rmSync(dirPath, { recursive: true, force: true });
                        cleaned += 1;
                    }
                } catch (_error) {}
            }
        }
        return cleaned;
    }
}

module.exports = SessionWorkspace;
