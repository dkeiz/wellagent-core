const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');

const RUNTIME_TIMEOUT_MS = 120000;
const SAMPLE_DATASET_ID = 'ds-tech-support-menu-20';
const SAMPLE_MODE_ID = 'mode-tech-support-rag-answer';

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function toNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

class RagRuntimeClient {
    constructor(options) {
        this.scriptPath = options.scriptPath;
        this.dataDir = options.dataDir;
        this.getConfig = options.getConfig;
        this.registerManagedProcess = options.registerManagedProcess;
        this.log = options.log || (() => {});
        this.proc = null;
        this.unregisterManagedProcess = null;
        this.pending = new Map();
        this.nextId = 1;
    }

    async start() {
        if (this.proc) return;
        fs.mkdirSync(this.dataDir, { recursive: true });
        this.proc = fork(this.scriptPath, [], {
            cwd: path.dirname(this.scriptPath),
            stdio: ['ignore', 'pipe', 'pipe', 'ipc']
        });
        if (typeof this.registerManagedProcess === 'function') {
            this.unregisterManagedProcess = this.registerManagedProcess(this.proc, {
                name: 'agent-rag-studio-runtime'
            });
        }

        this.proc.stdout?.on('data', (chunk) => this.log(`[runtime] ${String(chunk).trim()}`));
        this.proc.stderr?.on('data', (chunk) => this.log(`[runtime:err] ${String(chunk).trim()}`));
        this.proc.on('message', (message) => this._handleMessage(message));
        this.proc.on('exit', (code, signal) => {
            const unregister = this.unregisterManagedProcess;
            this.unregisterManagedProcess = null;
            if (typeof unregister === 'function') {
                try {
                    unregister();
                } catch (_) {}
            }
            const error = new Error(`RAG runtime exited (code=${code}, signal=${signal || 'none'})`);
            this._rejectAll(error);
            this.proc = null;
        });
        this.proc.on('error', (error) => {
            this._rejectAll(error);
        });

        await this.call('init', {
            dataDir: this.dataDir,
            config: this._buildConfig()
        });
    }

    _buildConfig() {
        const config = this.getConfig ? this.getConfig() : {};
        return {
            ollamaUrl: config.ollamaUrl || 'http://127.0.0.1:11434',
            embeddingModel: config.embeddingModel || 'nomic-embed-text',
            chunkSize: toNumber(config.chunkSize, 900),
            chunkOverlap: toNumber(config.chunkOverlap, 120)
        };
    }

    _handleMessage(message) {
        const id = message?.id;
        if (!id || !this.pending.has(id)) return;
        const pending = this.pending.get(id);
        this.pending.delete(id);
        clearTimeout(pending.timer);

        if (message.ok) {
            pending.resolve(message.result);
            return;
        }
        pending.reject(new Error(message.error || 'RAG runtime call failed'));
    }

    _rejectAll(error) {
        for (const [, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
    }

    async call(action, payload = {}, timeoutMs = RUNTIME_TIMEOUT_MS) {
        if (!this.proc) {
            throw new Error('RAG runtime is not started');
        }

        const id = `rag-${Date.now()}-${this.nextId++}`;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`RAG runtime action "${action}" timed out`));
            }, timeoutMs);

            this.pending.set(id, { resolve, reject, timer });
            this.proc.send({ id, action, payload });
        });
    }

    async stop() {
        const unregister = this.unregisterManagedProcess;
        this.unregisterManagedProcess = null;
        if (typeof unregister === 'function') {
            try {
                unregister();
            } catch (_) {}
        }
        if (!this.proc) return;
        try {
            await this.call('shutdown', {}, 3000);
        } catch (error) {
            this.log(`Runtime shutdown warning: ${error.message}`);
        }
        this.proc.kill();
        this.proc = null;
        this._rejectAll(new Error('RAG runtime stopped'));
    }
}

function renderModes(modes, activeModeId) {
    if (!Array.isArray(modes) || modes.length === 0) {
        return '<div class="rag-empty">No modes yet.</div>';
    }
    return modes.map((mode) => {
        const isActive = String(mode.id) === String(activeModeId);
        return `<div class="rag-item">
            <div class="rag-item-main">
                <strong>${escapeHtml(mode.name)}</strong>
                <span>${escapeHtml((mode.guidance || '').slice(0, 140))}</span>
            </div>
            <span class="rag-badge">${isActive ? 'Active' : 'Idle'}</span>
        </div>`;
    }).join('');
}

function renderDatasets(datasets) {
    if (!Array.isArray(datasets) || datasets.length === 0) {
        return '<div class="rag-empty">No datasets indexed yet.</div>';
    }
    return datasets.map((dataset) => `<div class="rag-item">
        <div class="rag-item-main">
            <strong>${escapeHtml(dataset.title || dataset.id)}</strong>
            <span>${escapeHtml(`${dataset.chunk_count || 0} chunks • ${dataset.source_count || 0} sources`)}</span>
        </div>
        <span class="rag-badge">Ready</span>
    </div>`).join('');
}

function renderPanel(summary, note = '') {
    const responseMode = summary?.responseMode || 'agent';
    const modeLabel = responseMode === 'rag_only' ? 'RAG-only answers' : 'Agent mode';
    return `<section class="rag-studio-panel">
        <div class="rag-header">
            <strong>RAG Answers</strong>
            <button type="button" data-agent-ui-action="refresh">Refresh</button>
        </div>
        <div class="rag-meta">
            <div><span>Datasets</span><strong>${summary?.datasetCount || 0}</strong></div>
            <div><span>Modes</span><strong>${summary?.modeCount || 0}</strong></div>
            <div><span>Active Mode</span><strong>${escapeHtml(summary?.activeModeName || 'None')}</strong></div>
            <div><span>Answer Mode</span><strong>${escapeHtml(modeLabel)}</strong></div>
        </div>
        <div class="rag-actions">
            <button type="button" data-agent-ui-action="load-tech-support-sample">Load Sample 20 Answers</button>
            <button type="button" data-agent-ui-action="create-rag-answer-mode">Create RAG Answer Mode</button>
            <button type="button" data-agent-ui-action="enable-rag-only">Enable RAG-Only</button>
            <button type="button" data-agent-ui-action="disable-rag-only">Disable RAG-Only</button>
            <button type="button" data-agent-ui-action="run-rag-answer-smoke">Run Smoke Check</button>
        </div>
        <div class="rag-note">${escapeHtml(note || summary?.lastMessage || '')}</div>
        <div class="rag-sections">
            <section>
                <h4>Configured Modes</h4>
                ${renderModes(summary?.modes || [], summary?.activeModeId)}
            </section>
            <section>
                <h4>Indexed Datasets</h4>
                ${renderDatasets(summary?.datasets || [])}
            </section>
        </div>
    </section>`;
}

const css = `
.rag-studio-panel {
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 10px;
    margin-bottom: 8px;
    background: var(--card-bg);
}
.rag-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
}
.rag-header button,
.rag-actions button {
    border: 1px solid var(--border-color);
    background: transparent;
    color: var(--text-primary);
    border-radius: 4px;
    padding: 4px 8px;
    cursor: pointer;
}
.rag-meta {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px;
    margin-bottom: 8px;
}
.rag-meta div {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    padding: 6px;
}
.rag-meta span,
.rag-note,
.rag-item-main span,
.rag-empty {
    font-size: var(--text-xs);
    color: var(--text-secondary);
}
.rag-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 8px;
}
.rag-note {
    min-height: 18px;
    margin-bottom: 8px;
}
.rag-sections {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
}
.rag-sections section h4 {
    margin: 0 0 6px;
}
.rag-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    padding: 6px;
    margin-bottom: 6px;
}
.rag-badge {
    border: 1px solid var(--border-color);
    border-radius: 999px;
    padding: 2px 8px;
    font-size: var(--text-xs);
    color: var(--text-secondary);
}
.rag-item-main {
    min-width: 0;
    display: flex;
    flex-direction: column;
}
.rag-item-main strong,
.rag-item-main span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
`;

module.exports = {
    async onEnable(context) {
        const sampleDatasetPath = path.join(context.pluginDir, 'data', 'tech-support-menu-20.json');
        const runtime = new RagRuntimeClient({
            scriptPath: path.join(context.pluginDir, 'rag-runtime-process.js'),
            dataDir: path.join(context.pluginDir, 'data'),
            getConfig: () => context.getConfig(),
            registerManagedProcess: (proc, metadata) => context.registerManagedProcess(proc, metadata),
            log: (message) => context.log(message)
        });

        await runtime.start();
        context.log('RAG runtime started');

        context.registerHandler('status', {
            description: 'Inspect current RAG runtime status, datasets, and modes',
            inputSchema: { type: 'object', properties: {} }
        }, async () => runtime.call('status'));

        context.registerHandler('dataset', {
            description: 'Manage RAG datasets. Actions: ingest | list | inspect | delete',
            inputSchema: {
                type: 'object',
                properties: {
                    action: { type: 'string', description: 'ingest | list | inspect | delete' },
                    dataset_id: { type: 'string', description: 'Dataset id for inspect/delete' },
                    title: { type: 'string', description: 'Dataset title for ingest' },
                    text: { type: 'string', description: 'Inline dataset text for ingest' },
                    entries: { type: 'array', description: 'Structured entries [{issue, instruction}] for deterministic support menus' },
                    file_paths: { type: 'array', description: 'Absolute file paths for ingest' },
                    directory_paths: { type: 'array', description: 'Absolute directory paths for ingest' },
                    urls: { type: 'array', description: 'Optional text URLs for ingest' }
                },
                required: ['action']
            }
        }, async (params) => runtime.call('dataset_op', params));

        context.registerHandler('mode', {
            description: 'Manage RAG modes. Actions: create | list | update | activate | delete | add_rule | remove_rule',
            inputSchema: {
                type: 'object',
                properties: {
                    action: { type: 'string', description: 'Mode action' },
                    mode_id: { type: 'string', description: 'Mode id for update/activate/delete/rules' },
                    name: { type: 'string', description: 'Mode name for create/update' },
                    guidance: { type: 'string', description: 'Mode behavior instructions' },
                    top_k: { type: 'number', description: 'Retrieval top K value' },
                    min_score: { type: 'number', description: 'Minimum cosine similarity threshold' },
                    dataset_ids: { type: 'array', description: 'Dataset ids used by this mode' },
                    pattern: { type: 'string', description: 'Hard-rule match pattern' },
                    answer: { type: 'string', description: 'Hard-rule answer text' },
                    match_type: { type: 'string', description: 'contains | exact | regex' },
                    rule_id: { type: 'string', description: 'Rule id for remove_rule' }
                },
                required: ['action']
            }
        }, async (params) => runtime.call('mode_op', params));

        context.registerHandler('query', {
            description: 'Run RAG query against active mode or selected mode',
            inputSchema: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'User question for retrieval' },
                    mode_id: { type: 'string', description: 'Optional mode id override' },
                    top_k: { type: 'number', description: 'Optional top K override' }
                },
                required: ['query']
            }
        }, async (params) => runtime.call('query', params));

        context.registerHandler('answer_mode', {
            description: 'Get or set response mode. Modes: agent | rag_only',
            inputSchema: {
                type: 'object',
                properties: {
                    action: { type: 'string', description: 'get | set' },
                    mode: { type: 'string', description: 'agent | rag_only for set action' }
                }
            }
        }, async (params) => runtime.call('answer_mode', params || {}));

        context.registerHandler('rag_answer', {
            description: 'Return one deterministic instruction from RAG data. Supports in-query controls: -rag and -norag.',
            inputSchema: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'User support question. Prefix -rag or -norag to toggle mode.' },
                    mode_id: { type: 'string', description: 'Optional retrieval mode override' }
                },
                required: ['query']
            }
        }, async (params) => runtime.call('answer', params));

        context.registerChatUI({
            title: 'RAG Studio',
            async renderPanel() {
                const summary = await runtime.call('summary');
                return renderPanel(summary);
            },
            css,
            actions: {
                async refresh({ render, pluginId }) {
                    return { success: true, pluginId, html: await render(), css };
                },
                async 'load-tech-support-sample'({ render, pluginId }) {
                    const raw = fs.readFileSync(sampleDatasetPath, 'utf-8');
                    const parsed = JSON.parse(raw);
                    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
                    await runtime.call('dataset_op', {
                        action: 'ingest',
                        dataset_id: SAMPLE_DATASET_ID,
                        title: 'Tech Support Answers Menu (20)',
                        entries
                    });
                    const summary = await runtime.call('summary');
                    return { success: true, pluginId, html: renderPanel(summary, 'Loaded sample 20-answer dataset.'), css };
                },
                async 'create-rag-answer-mode'({ render, pluginId }) {
                    await runtime.call('mode_op', {
                        action: 'create',
                        mode_id: SAMPLE_MODE_ID,
                        name: 'Tech Support RAG Answer',
                        guidance: 'Return one best instruction from the support answer menu and keep output concise.',
                        top_k: 1,
                        min_score: 0.15,
                        dataset_ids: [SAMPLE_DATASET_ID]
                    });
                    await runtime.call('mode_op', {
                        action: 'activate',
                        mode_id: SAMPLE_MODE_ID
                    });
                    const summary = await runtime.call('summary');
                    return { success: true, pluginId, html: renderPanel(summary, 'RAG answer mode created and activated.'), css };
                },
                async 'enable-rag-only'({ render, pluginId }) {
                    await runtime.call('answer_mode', {
                        action: 'set',
                        mode: 'rag_only'
                    });
                    const summary = await runtime.call('summary');
                    return { success: true, pluginId, html: renderPanel(summary, 'RAG-only answers enabled.'), css };
                },
                async 'disable-rag-only'({ render, pluginId }) {
                    await runtime.call('answer_mode', {
                        action: 'set',
                        mode: 'agent'
                    });
                    const summary = await runtime.call('summary');
                    return { success: true, pluginId, html: renderPanel(summary, 'RAG-only answers disabled (agent mode).'), css };
                },
                async 'run-rag-answer-smoke'({ pluginId }) {
                    const result = await runtime.call('answer', {
                        query: 'I forgot my password and cannot sign in'
                    });
                    const summary = await runtime.call('summary');
                    return {
                        success: true,
                        pluginId,
                        html: renderPanel(summary, result.answer || 'No answer generated.'),
                        css
                    };
                }
            }
        });

        this._runtime = runtime;
    },

    async onDisable() {
        if (this._runtime) {
            await this._runtime.stop();
            this._runtime = null;
        }
        console.log('[agent-rag-studio] Disabled');
    }
};
