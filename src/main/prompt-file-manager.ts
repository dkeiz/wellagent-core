// @ts-nocheck
const fs = require('fs');
const path = require('path');
const { buildRuntimePaths } = require('./runtime-paths');
const {
    DEFAULT_PROMPT_USER_ID,
    getScopedPromptPaths,
    resolvePromptScope
} = require('./prompt-ownership');
let app;
try { app = require('electron').app; } catch (_) { app = null; }

/**
 * PromptFileManager - Bidirectional sync between files and database for prompts/rules.
 *
 * Owner/local prompt files live under agentin/prompts/.
 * Concurrent shared-backend users resolve prompt files under agentin/prompts/users/<user>/.
 */
class PromptFileManager {
    constructor(db, basePath = null) {
        this.db = db;
        this.basePath = basePath || buildRuntimePaths().promptBasePath;
        this.systemPromptPath = path.join(this.basePath, 'system.md');
        this.rulesPath = path.join(this.basePath, 'rules');
        this.watchers = [];
        this.syncInProgress = false;
    }

    async initialize() {
        this.ensureDirectories();
        await this.syncFromFiles();
        this.startWatching();
        console.log('[PromptFileManager] Initialized at:', this.basePath);
    }

    resolvePaths(options = {}) {
        return getScopedPromptPaths(this.basePath, options);
    }

    ensureDirectories(options = {}) {
        const paths = this.resolvePaths(options);
        if (!fs.existsSync(paths.basePath)) {
            fs.mkdirSync(paths.basePath, { recursive: true });
        }
        if (!fs.existsSync(paths.rulesPath)) {
            fs.mkdirSync(paths.rulesPath, { recursive: true });
        }
        return paths;
    }

    async loadSystemPrompt(options = {}) {
        const scope = resolvePromptScope(options);
        const paths = this.resolvePaths(scope);
        if (fs.existsSync(paths.systemPromptPath)) {
            return fs.readFileSync(paths.systemPromptPath, 'utf-8');
        }

        const dbPrompt = this.db.getScopedSetting
            ? await this.db.getScopedSetting('system_prompt', scope)
            : await this.db.getSetting('system_prompt');
        const defaultPrompt = dbPrompt || 'You are a helpful AI assistant with access to various tools and functions.';
        await this.saveSystemPromptToFile(defaultPrompt, scope);
        return defaultPrompt;
    }

    async saveSystemPrompt(content, syncToDb = true, options = {}) {
        const scope = resolvePromptScope(options);
        await this.saveSystemPromptToFile(content, scope);
        if (syncToDb) {
            if (this.db.saveScopedSetting) {
                await this.db.saveScopedSetting('system_prompt', content, scope);
            } else {
                await this.db.setSetting('system_prompt', content);
            }
        }
    }

    async saveSystemPromptToFile(content, options = {}) {
        const paths = this.ensureDirectories(options);
        fs.writeFileSync(paths.systemPromptPath, content, 'utf-8');
        return paths.systemPromptPath;
    }

    parseRuleFrontmatter(content) {
        const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;
        const match = content.match(frontmatterRegex);

        if (!match) {
            return { metadata: {}, content: content.trim() };
        }

        const yamlSection = match[1];
        const ruleContent = match[2].trim();
        const metadata = {};
        yamlSection.split('\n').forEach(line => {
            const colonIndex = line.indexOf(':');
            if (colonIndex > 0) {
                const key = line.substring(0, colonIndex).trim();
                let value = line.substring(colonIndex + 1).trim();
                if (value === 'true') value = true;
                else if (value === 'false') value = false;
                else if (!isNaN(value) && value !== '') value = Number(value);
                metadata[key] = value;
            }
        });

        return { metadata, content: ruleContent };
    }

    normalizeRuleActive(value, defaultValue = true) {
        if (value === undefined || value === null || value === '') {
            return Boolean(defaultValue);
        }
        if (typeof value === 'boolean') {
            return value;
        }
        if (typeof value === 'number') {
            return value !== 0;
        }
        if (typeof value === 'string') {
            const normalized = value.trim().toLowerCase();
            if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
            if (['false', '0', 'no', 'off'].includes(normalized)) return false;
        }
        return Boolean(value);
    }

    generateRuleFile(name, content, active = true, priority = 1) {
        const normalizedActive = this.normalizeRuleActive(active, true);
        const normalizedPriority = Number.isFinite(Number(priority)) ? Number(priority) : 1;
        return `---
name: ${name}
active: ${normalizedActive ? 'true' : 'false'}
priority: ${normalizedPriority}
---
${content}`;
    }

    getSafeFilename(name, priority = 1) {
        const safeName = String(name || '').toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
        const paddedPriority = String(priority).padStart(3, '0');
        return `${paddedPriority}-${safeName}.md`;
    }

    async loadRulesFromFiles(options = {}) {
        const rules = [];
        const paths = this.resolvePaths(options);
        if (!fs.existsSync(paths.rulesPath)) {
            return rules;
        }

        const files = fs.readdirSync(paths.rulesPath).filter(f => f.endsWith('.md'));
        for (const file of files) {
            const filePath = path.join(paths.rulesPath, file);
            const fileContent = fs.readFileSync(filePath, 'utf-8');
            const { metadata, content } = this.parseRuleFrontmatter(fileContent);
            rules.push({
                filename: file,
                name: metadata.name || file.replace('.md', ''),
                content,
                active: this.normalizeRuleActive(metadata.active, true),
                priority: metadata.priority || 1,
                type: metadata.type || 'rule'
            });
        }

        return rules.sort((a, b) => a.priority - b.priority);
    }

    async saveRuleToFile(name, content, active = true, priority = 1, existingFilename = null, options = {}) {
        const paths = this.ensureDirectories(options);
        const filename = existingFilename || this.getSafeFilename(name, priority);
        const filePath = path.join(paths.rulesPath, filename);
        const fileContent = this.generateRuleFile(name, content, active, priority);
        fs.writeFileSync(filePath, fileContent, 'utf-8');
        return filename;
    }

    deleteRuleFile(filename, options = {}) {
        const paths = this.resolvePaths(options);
        const filePath = path.join(paths.rulesPath, filename);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            return true;
        }
        return false;
    }

    async syncFromFiles(options = {}) {
        if (this.syncInProgress) return;
        this.syncInProgress = true;

        try {
            const scope = resolvePromptScope(options);
            const systemPrompt = await this.loadSystemPrompt(scope);
            if (this.db.saveScopedSetting) {
                await this.db.saveScopedSetting('system_prompt', systemPrompt, scope);
            } else {
                await this.db.setSetting('system_prompt', systemPrompt);
            }

            const fileRules = await this.loadRulesFromFiles(scope);
            const dbRules = await this.db.getPromptRules(scope);
            const dbRuleMap = new Map(dbRules.map(rule => [rule.name, rule]));

            for (const fileRule of fileRules) {
                const existingRule = dbRuleMap.get(fileRule.name);
                if (existingRule) {
                    await this.db.updatePromptRule(existingRule.id, {
                        name: fileRule.name,
                        content: fileRule.content,
                        active: fileRule.active
                    }, scope);
                    dbRuleMap.delete(fileRule.name);
                } else {
                    await this.db.addPromptRule({
                        name: fileRule.name,
                        content: fileRule.content,
                        type: fileRule.type,
                        active: fileRule.active,
                        user_id: scope.userId
                    }, scope);
                }
            }

            console.log('[PromptFileManager] Synced from files:', fileRules.length, 'rules');
        } finally {
            this.syncInProgress = false;
        }
    }

    async syncToFiles(options = {}) {
        if (this.syncInProgress) return;
        this.syncInProgress = true;

        try {
            const scope = resolvePromptScope(options);
            const paths = this.ensureDirectories(scope);
            const dbPrompt = this.db.getScopedSetting
                ? await this.db.getScopedSetting('system_prompt', scope)
                : await this.db.getSetting('system_prompt');
            if (dbPrompt) {
                await this.saveSystemPromptToFile(dbPrompt, scope);
            }

            const dbRules = await this.db.getPromptRules(scope);
            if (fs.existsSync(paths.rulesPath)) {
                const existingFiles = fs.readdirSync(paths.rulesPath).filter(f => f.endsWith('.md'));
                for (const file of existingFiles) {
                    fs.unlinkSync(path.join(paths.rulesPath, file));
                }
            }

            for (let i = 0; i < dbRules.length; i++) {
                const rule = dbRules[i];
                await this.saveRuleToFile(
                    rule.name,
                    rule.content,
                    rule.active,
                    i + 1,
                    null,
                    scope
                );
            }

            console.log('[PromptFileManager] Synced to files:', dbRules.length, 'rules');
        } finally {
            this.syncInProgress = false;
        }
    }

    startWatching() {
        let debounceTimer = null;
        const debounceSync = () => {
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => this.syncFromFiles(), 500);
        };

        if (fs.existsSync(this.systemPromptPath)) {
            const systemWatcher = fs.watch(this.systemPromptPath, debounceSync);
            this.watchers.push(systemWatcher);
        }
        if (fs.existsSync(this.rulesPath)) {
            const rulesWatcher = fs.watch(this.rulesPath, debounceSync);
            this.watchers.push(rulesWatcher);
        }
    }

    stopWatching() {
        this.watchers.forEach(w => w.close());
        this.watchers = [];
    }

    getPaths(options = {}) {
        const paths = this.resolvePaths(options);
        return {
            base: paths.basePath,
            systemPrompt: paths.systemPromptPath,
            rules: paths.rulesPath,
            userId: paths.userId
        };
    }
}

module.exports = PromptFileManager;
