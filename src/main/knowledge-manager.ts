// @ts-nocheck
const fs = require('fs');
const path = require('path');
const { buildRuntimePaths } = require('./runtime-paths');

/**
 * KnowledgeManager — Manages the agentin/knowledge/ file tree.
 * 
 * Knowledge is stored as files on disk (max 200 lines each).
 * The LLM discovers what's available via explore_knowledge tool,
 * then reads actual content using existing file tools (read_file, etc).
 * 
 * Knowledge items live in:
 *   agentin/knowledge/library/   — confirmed, active knowledge
 *   agentin/knowledge/staging/   — daemon-generated candidates
 */
class KnowledgeManager {
    constructor(db, options = {}) {
        this.db = db;
        this.baseDir = options.baseDir || buildRuntimePaths(options).knowledgeBaseDir;
        this.libraryDir = path.join(this.baseDir, 'library');
        this.stagingDir = path.join(this.baseDir, 'staging');
        this.MAX_LINES = 200;
    }

    async initialize() {
        // Ensure directory structure
        for (const dir of [this.baseDir, this.libraryDir, this.stagingDir]) {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        }

        // Rebuild index from disk
        await this._rebuildIndex();
        console.log(`[KnowledgeManager] Initialized. Base: ${this.baseDir}`);
    }

    // ==================== Core Operations ====================

    async createItem({ title, content, category = 'general', tags = [], source = 'unknown', confidence = 0.5, slug = null }) {
        const itemSlug = slug || this._slugify(title);
        const status = confidence >= 0.8 ? 'active' : 'staged';
        const targetDir = status === 'active' ? this.libraryDir : this.stagingDir;
        const folderPath = path.join(targetDir, itemSlug);

        if (fs.existsSync(folderPath)) {
            throw new Error(`Knowledge item "${itemSlug}" already exists`);
        }

        fs.mkdirSync(folderPath, { recursive: true });

        // Write meta.json
        const meta = {
            slug: itemSlug,
            title,
            category,
            tags: Array.isArray(tags) ? tags : [tags],
            source,
            confidence,
            status,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        fs.writeFileSync(path.join(folderPath, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');

        // Write content, auto-splitting if needed
        await this._writeContent(folderPath, content);

        // DB record
        this.db.run(
            `INSERT OR REPLACE INTO knowledge_items (slug, title, category, status, tags, source, confidence, folder_path, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
            [itemSlug, title, category, status, JSON.stringify(meta.tags), source, confidence, folderPath]
        );

        return { slug: itemSlug, status, folderPath };
    }

    async updateItemContent(slug, content) {
        const item = this._getItem(slug);
        if (!item) throw new Error(`Knowledge item "${slug}" not found`);

        // Clear existing content files
        const files = fs.readdirSync(item.folder_path).filter(f => f !== 'meta.json');
        for (const f of files) {
            fs.unlinkSync(path.join(item.folder_path, f));
        }

        // Write new content
        await this._writeContent(item.folder_path, content);

        // Update meta
        const metaPath = path.join(item.folder_path, 'meta.json');
        if (fs.existsSync(metaPath)) {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
            meta.updatedAt = new Date().toISOString();
            fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
        }

        this.db.run('UPDATE knowledge_items SET updated_at = CURRENT_TIMESTAMP WHERE slug = ?', [slug]);
    }

    async listItems({ category = null, status = null } = {}) {
        let sql = 'SELECT * FROM knowledge_items WHERE 1=1';
        const params = [];

        if (category) {
            sql += ' AND category = ?';
            params.push(category);
        }
        if (status) {
            sql += ' AND status = ?';
            params.push(status);
        }

        sql += ' ORDER BY updated_at DESC';
        return this.db.all(sql, params);
    }

    async updateItem(slug, updates) {
        const item = this._getItem(slug);
        if (!item) throw new Error(`Knowledge item "${slug}" not found`);

        const fields = [];
        const params = [];

        for (const [key, value] of Object.entries(updates)) {
            if (['title', 'category', 'status', 'tags', 'source', 'confidence'].includes(key)) {
                fields.push(`${key} = ?`);
                params.push(key === 'tags' ? JSON.stringify(value) : value);
            }
        }

        if (fields.length > 0) {
            fields.push('updated_at = CURRENT_TIMESTAMP');
            params.push(slug);
            this.db.run(`UPDATE knowledge_items SET ${fields.join(', ')} WHERE slug = ?`, params);
        }

        // If promoting to active, move folder from staging to library
        if (updates.status === 'active' && item.status === 'staged') {
            await this._moveItem(slug, this.stagingDir, this.libraryDir);
        }
    }

    async markStale(slug) {
        await this.updateItem(slug, { status: 'stale' });
    }

    // ==================== Knowledge Tree (The Tool) ====================

    async getKnowledgeTree() {
        const tree = {
            library: [],
            staging: [],
            stats: { totalItems: 0, totalFiles: 0, totalLines: 0 }
        };

        for (const [section, dir] of [['library', this.libraryDir], ['staging', this.stagingDir]]) {
            if (!fs.existsSync(dir)) continue;

            const items = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory());

            for (const item of items) {
                const itemPath = path.join(dir, item.name);
                const metaPath = path.join(itemPath, 'meta.json');
                let meta = { slug: item.name, title: item.name, category: 'general' };

                if (fs.existsSync(metaPath)) {
                    try {
                        meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
                    } catch (e) { /* use defaults */ }
                }

                // List content files
                const contentFiles = fs.readdirSync(itemPath)
                    .filter(f => f !== 'meta.json')
                    .map(f => {
                        const filePath = path.join(itemPath, f);
                        const content = fs.readFileSync(filePath, 'utf-8');
                        const lineCount = content.split('\n').length;
                        tree.stats.totalLines += lineCount;
                        tree.stats.totalFiles++;
                        return {
                            name: f,
                            path: filePath,
                            lines: lineCount
                        };
                    });

                tree[section].push({
                    slug: meta.slug || item.name,
                    title: meta.title || item.name,
                    category: meta.category || 'general',
                    tags: meta.tags || [],
                    confidence: meta.confidence,
                    source: meta.source,
                    updatedAt: meta.updatedAt,
                    files: contentFiles,
                    fileCount: contentFiles.length,
                    totalLines: contentFiles.reduce((sum, f) => sum + f.lines, 0)
                });

                tree.stats.totalItems++;
            }
        }

        return tree;
    }

    // ==================== Observation Intake ====================

    async ingestObservation({ category, content, source, confidence = 0.5 }) {
        const slug = `obs-${category}-${Date.now()}`;
        return await this.createItem({
            title: `Observation: ${category}`,
            content,
            category,
            tags: ['auto-observed', category],
            source: source || 'daemon',
            confidence,
            slug
        });
    }

    // ==================== Promotion ====================

    async promoteStaged(slug) {
        const item = this._getItem(slug);
        if (!item) throw new Error(`Knowledge item "${slug}" not found`);
        if (item.status !== 'staged') throw new Error(`Item "${slug}" is not staged (status: ${item.status})`);

        await this._moveItem(slug, this.stagingDir, this.libraryDir);
        this.db.run(
            'UPDATE knowledge_items SET status = ?, confirmed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE slug = ?',
            ['active', slug]
        );
    }

    async rejectStaged(slug) {
        const item = this._getItem(slug);
        if (!item) throw new Error(`Knowledge item "${slug}" not found`);
        if (item.status !== 'staged') {
            throw new Error(`Item "${slug}" is not staged (status: ${item.status})`);
        }

        // Remove from disk
        const folderPath = path.resolve(item.folder_path || path.join(this.stagingDir, slug));
        if (!this._isWithinDir(folderPath, this.stagingDir)) {
            throw new Error(`Refusing to reject staged item outside staging directory: ${folderPath}`);
        }
        if (fs.existsSync(folderPath)) {
            fs.rmSync(folderPath, { recursive: true, force: true });
        }

        // Remove from DB
        this.db.run('DELETE FROM knowledge_items WHERE slug = ?', [slug]);
    }

    // ==================== Stats ====================

    getStats() {
        const total = this.db.get('SELECT COUNT(*) as count FROM knowledge_items') || { count: 0 };
        const active = this.db.get("SELECT COUNT(*) as count FROM knowledge_items WHERE status = 'active'") || { count: 0 };
        const staged = this.db.get("SELECT COUNT(*) as count FROM knowledge_items WHERE status = 'staged'") || { count: 0 };
        return {
            total: total.count,
            active: active.count,
            staged: staged.count
        };
    }

    // ==================== Internal Helpers ====================

    _getItem(slug) {
        return this.db.get('SELECT * FROM knowledge_items WHERE slug = ?', [slug]);
    }

    _slugify(text) {
        return text.toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .substring(0, 60);
    }

    _isWithinDir(targetPath, parentDir) {
        const relative = path.relative(path.resolve(parentDir), path.resolve(targetPath));
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    }

    async _writeContent(folderPath, content) {
        const lines = content.split('\n');

        if (lines.length <= this.MAX_LINES) {
            // Single file
            fs.writeFileSync(path.join(folderPath, 'content.md'), content, 'utf-8');
        } else {
            // Auto-split into parts
            let partNum = 1;
            for (let i = 0; i < lines.length; i += this.MAX_LINES) {
                const chunk = lines.slice(i, i + this.MAX_LINES).join('\n');
                const filename = `content-${String(partNum).padStart(2, '0')}.md`;
                fs.writeFileSync(path.join(folderPath, filename), chunk, 'utf-8');
                partNum++;
            }
        }
    }

    async _moveItem(slug, fromDir, toDir) {
        const srcPath = path.join(fromDir, slug);
        const dstPath = path.join(toDir, slug);

        if (!fs.existsSync(srcPath)) return;
        if (fs.existsSync(dstPath)) {
            fs.rmSync(dstPath, { recursive: true, force: true });
        }

        fs.renameSync(srcPath, dstPath);

        // Update DB folder_path
        this.db.run('UPDATE knowledge_items SET folder_path = ? WHERE slug = ?', [dstPath, slug]);
    }

    async _rebuildIndex() {
        // Scan disk and ensure DB is in sync
        for (const [status, dir] of [['active', this.libraryDir], ['staged', this.stagingDir]]) {
            if (!fs.existsSync(dir)) continue;

            const items = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory());

            for (const item of items) {
                const existing = this.db.get('SELECT slug FROM knowledge_items WHERE slug = ?', [item.name]);
                if (existing) continue;

                // Found on disk but not in DB — register it
                const metaPath = path.join(dir, item.name, 'meta.json');
                let meta = { slug: item.name, title: item.name, category: 'general', tags: [], source: 'disk', confidence: 0.5 };

                if (fs.existsSync(metaPath)) {
                    try {
                        meta = { ...meta, ...JSON.parse(fs.readFileSync(metaPath, 'utf-8')) };
                    } catch (e) { /* use defaults */ }
                }

                this.db.run(
                    `INSERT OR IGNORE INTO knowledge_items (slug, title, category, status, tags, source, confidence, folder_path)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [meta.slug, meta.title, meta.category, status, JSON.stringify(meta.tags || []),
                     meta.source || 'disk', meta.confidence || 0.5, path.join(dir, item.name)]
                );
            }
        }
    }
}

module.exports = KnowledgeManager;
