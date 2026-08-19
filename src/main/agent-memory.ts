// @ts-nocheck
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildRuntimePaths, buildScopedMutableRuntimePaths } = require('./runtime-paths');

/**
 * AgentMemory - Manages agent's persistent memory with security rules
 *
 * Features:
 * - Append-only writing (no modifications to existing content)
 * - Auto-lock after configurable days (default 7)
 * - Hash verification for tamper detection
 */
class AgentMemory {
    constructor(basePath = null, options = {}) {
        this.defaultBasePath = path.resolve(basePath || buildRuntimePaths(options).memoryBasePath);
        this.runtimePathOptions = { ...options };
        this.lockDays = 7;
        this._hashState = new Map();
        this.ensureStructure();
    }

    _resolveBasePath(options = {}) {
        if (options?.basePath) {
            return path.resolve(String(options.basePath));
        }
        const scopedUserId = String(options?.userId || options?.user_id || options?.requestContext?.userId || options?.requestContext?.user_id || '').trim();
        if (!scopedUserId) {
            return this.defaultBasePath;
        }
        return path.resolve(buildScopedMutableRuntimePaths({
            ...this.runtimePathOptions,
            ...options,
            memoryBasePath: null
        }).memoryBasePath);
    }

    _loadHashes(hashFile) {
        try {
            if (fs.existsSync(hashFile)) {
                return JSON.parse(fs.readFileSync(hashFile, 'utf-8'));
            }
        } catch (error) {
            console.error('Failed to load memory hashes:', error);
        }
        return {};
    }

    _getState(options = {}) {
        const basePath = this._resolveBasePath(options);
        if (!this._hashState.has(basePath)) {
            const hashFile = path.join(basePath, '.hashes.json');
            this._hashState.set(basePath, {
                basePath,
                hashFile,
                hashes: this._loadHashes(hashFile)
            });
        }
        return this._hashState.get(basePath);
    }

    ensureStructure(options = {}) {
        const state = this._getState(options);
        const folders = ['daily', 'global', 'tasks', 'images'];
        folders.forEach(folder => {
            const folderPath = path.join(state.basePath, folder);
            if (!fs.existsSync(folderPath)) {
                fs.mkdirSync(folderPath, { recursive: true });
            }
        });
        return state.basePath;
    }

    saveHashes(options = {}) {
        try {
            const state = this._getState(options);
            fs.mkdirSync(path.dirname(state.hashFile), { recursive: true });
            fs.writeFileSync(state.hashFile, JSON.stringify(state.hashes, null, 2));
        } catch (error) {
            console.error('Failed to save memory hashes:', error);
        }
    }

    computeHash(content) {
        return crypto.createHash('sha256').update(content).digest('hex');
    }

    isLocked(filePath) {
        try {
            const stats = fs.statSync(filePath);
            const ageInDays = (Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60 * 24);
            return ageInDays > this.lockDays;
        } catch {
            return false;
        }
    }

    verifyIntegrity(filePath, options = {}) {
        try {
            const state = this._getState(options);
            const content = fs.readFileSync(filePath, 'utf-8');
            const currentHash = this.computeHash(content);
            const storedHash = state.hashes[filePath];

            if (!storedHash) {
                state.hashes[filePath] = currentHash;
                this.saveHashes(options);
                return { verified: true, firstCheck: true };
            }

            return { verified: currentHash === storedHash, tampered: currentHash !== storedHash };
        } catch (error) {
            return { verified: false, error: error.message };
        }
    }

    async append(type, content, filename = null, options = {}) {
        if (filename && typeof filename === 'object' && !Array.isArray(filename) && !options?.userId && !options?.requestContext) {
            options = filename;
            filename = null;
        }
        const state = this._getState(options);
        this.ensureStructure(options);
        const folder = path.join(state.basePath, type);

        let targetFile;
        if (type === 'daily') {
            const today = new Date().toISOString().split('T')[0];
            targetFile = path.join(folder, `${today}.md`);
        } else if (type === 'global') {
            targetFile = path.join(folder, filename || 'preferences.md');
        } else if (type === 'tasks') {
            targetFile = path.join(folder, filename || 'current.md');
        } else {
            throw new Error(`Unknown memory type: ${type}`);
        }

        if (this.isLocked(targetFile)) {
            throw new Error(`Memory file is locked (older than ${this.lockDays} days): ${targetFile}`);
        }

        if (fs.existsSync(targetFile)) {
            const integrity = this.verifyIntegrity(targetFile, options);
            if (integrity.tampered) {
                throw new Error(`Memory file has been tampered with: ${targetFile}`);
            }
        }

        const timestamp = new Date().toISOString();
        const entry = `\n\n---\n[${timestamp}]\n${content}`;

        fs.appendFileSync(targetFile, entry);

        const newContent = fs.readFileSync(targetFile, 'utf-8');
        state.hashes[targetFile] = this.computeHash(newContent);
        this.saveHashes(options);

        return { success: true, file: targetFile };
    }

    async read(type, filename = null, options = {}) {
        if (filename && typeof filename === 'object' && !Array.isArray(filename) && !options?.userId && !options?.requestContext) {
            options = filename;
            filename = null;
        }
        const state = this._getState(options);
        this.ensureStructure(options);
        const folder = path.join(state.basePath, type);

        let targetFile;
        if (type === 'daily' && !filename) {
            const today = new Date().toISOString().split('T')[0];
            targetFile = path.join(folder, `${today}.md`);
        } else if (type === 'global' && !filename) {
            targetFile = path.join(folder, 'preferences.md');
        } else {
            targetFile = path.join(folder, filename);
        }

        if (!fs.existsSync(targetFile)) {
            return { content: null, exists: false };
        }

        const content = fs.readFileSync(targetFile, 'utf-8');
        const integrity = this.verifyIntegrity(targetFile, options);

        return {
            content,
            exists: true,
            locked: this.isLocked(targetFile),
            integrity: integrity.verified
        };
    }

    async list(type, options = {}) {
        const state = this._getState(options);
        this.ensureStructure(options);
        const folder = path.join(state.basePath, type);

        if (!fs.existsSync(folder)) {
            return [];
        }

        return fs.readdirSync(folder)
            .filter(f => !f.startsWith('.'))
            .map(f => ({
                filename: f,
                path: path.join(folder, f),
                locked: this.isLocked(path.join(folder, f))
            }));
    }

    async saveImage(imageBuffer, name = null, options = {}) {
        if (name && typeof name === 'object' && !Array.isArray(name) && !options?.userId && !options?.requestContext) {
            options = name;
            name = null;
        }
        const state = this._getState(options);
        this.ensureStructure(options);
        const imagesFolder = path.join(state.basePath, 'images');
        const timestamp = Date.now();
        const filename = name || `capture_${timestamp}.png`;
        const targetFile = path.join(imagesFolder, filename);

        fs.writeFileSync(targetFile, imageBuffer);

        return { success: true, file: targetFile, filename };
    }

    getStats(options = {}) {
        const state = this._getState(options);
        this.ensureStructure(options);
        const stats = {
            daily: 0,
            global: 0,
            tasks: 0,
            images: 0,
            lockedFiles: 0
        };

        ['daily', 'global', 'tasks', 'images'].forEach(type => {
            const folder = path.join(state.basePath, type);
            if (fs.existsSync(folder)) {
                const files = fs.readdirSync(folder).filter(f => !f.startsWith('.'));
                stats[type] = files.length;
                files.forEach(f => {
                    if (this.isLocked(path.join(folder, f))) {
                        stats.lockedFiles++;
                    }
                });
            }
        });

        return stats;
    }
}

module.exports = AgentMemory;
