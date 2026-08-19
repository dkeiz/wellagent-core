// @ts-nocheck
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { stripToolPatterns } = require('./ipc/shared-utils');
const { isPrivateSessionId } = require('./private-session-store');
const { buildRuntimePaths, buildScopedMutableRuntimePaths } = require('./runtime-paths');
const { normalizeUserId } = require('./user-scope');

/**
 * AgentLoop - Manages autonomous agent behaviors
 *
 * Three triggers:
 * 1. Session Start  — load memory context into session
 * 2. Idle (AutoMemory) — after idle_seconds of silence, create memory entry
 * 3. Chat Close     — summarize session on close/switch
 *
 * AutoMemory is OFF by default per session. User enables via automemory tool.
 */
class AgentLoop extends EventEmitter {
    constructor(dispatcher, agentMemory, db, sessionWorkspace = null, options = {}) {
        super();
        this.dispatcher = dispatcher;
        this.agentMemory = agentMemory;
        this.db = db;
        this.sessionWorkspace = sessionWorkspace;
        this.sessions = new Map();

        const runtimePaths = options.runtimePaths || buildRuntimePaths(options);
        this.runtimePathOptions = { ...options, agentinRoot: runtimePaths.agentinRoot };
        const basePath = options.templateBasePath || runtimePaths.promptTemplatesDir;
        this.templates = {
            start: path.join(basePath, 'memory-start.md'),
            idle: path.join(basePath, 'memory-idle.md'),
            close: path.join(basePath, 'memory-close.md')
        };
        this.userProfilePath = options.userProfilePath || runtimePaths.userProfilePath;
        this.taskQueueService = options.taskQueueService || null;
    }

    async _resolveSessionScope(sessionId, options = {}) {
        const explicitUserId = String(options?.userId || options?.user_id || options?.requestContext?.userId || options?.requestContext?.user_id || '').trim();
        if (explicitUserId) {
            return { ...options, userId: normalizeUserId(explicitUserId, 'localuser') };
        }
        const existing = this.sessions.get(sessionId);
        if (existing?.userId) {
            return { ...options, userId: normalizeUserId(existing.userId, 'localuser') };
        }
        const sid = String(sessionId || '').trim();
        if (sid && this.db?.get) {
            const row = this.db.get('SELECT user_id FROM chat_sessions WHERE CAST(id AS TEXT) = CAST(? AS TEXT)', [sid]);
            if (row?.user_id || row?.userId) {
                const userId = normalizeUserId(row.user_id || row.userId, 'localuser');
                const session = this.getSession(sessionId, { userId });
                session.userId = userId;
                return { ...options, userId };
            }
        }
        return { ...options, userId: 'localuser' };
    }

    _resolveScopedPaths(options = {}) {
        return buildScopedMutableRuntimePaths({
            ...this.runtimePathOptions,
            ...options,
            memoryBasePath: null,
            userProfilePath: null
        });
    }

    getSession(sessionId, options = {}) {
        if (!this.sessions.has(sessionId)) {
            this.sessions.set(sessionId, {
                autoMemory: false,
                idleSeconds: 60,
                idleTimer: null,
                memorySaved: false,
                memoryLoaded: false,
                lastActivity: Date.now(),
                messageCount: 0,
                userId: String(options?.userId || '').trim() || null
            });
        }
        const session = this.sessions.get(sessionId);
        if (options?.userId) {
            session.userId = normalizeUserId(options.userId, 'localuser');
        }
        return session;
    }

    recordActivity(sessionId, options = {}) {
        const session = this.getSession(sessionId, options);
        session.lastActivity = Date.now();
        session.messageCount++;

        if (session.autoMemory) {
            this._resetIdleTimer(sessionId);
        }
    }

    removeSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session && session.idleTimer) {
            clearTimeout(session.idleTimer);
        }
        this.sessions.delete(sessionId);
    }

    setAutoMemory(sessionId, enabled, idleSeconds = 60, options = {}) {
        const session = this.getSession(sessionId, options);
        session.autoMemory = enabled;
        session.idleSeconds = idleSeconds;

        if (enabled) {
            this._resetIdleTimer(sessionId);
            console.log(`[AgentLoop] AutoMemory enabled for session ${sessionId} (idle: ${idleSeconds}s)`);
        } else {
            if (session.idleTimer) {
                clearTimeout(session.idleTimer);
                session.idleTimer = null;
            }
            console.log(`[AgentLoop] AutoMemory disabled for session ${sessionId}`);
        }

        this.emit('automemory-changed', { sessionId, enabled, idleSeconds });
        return { enabled, idleSeconds };
    }

    async loadMemoryContext(sessionId, options = {}) {
        const scope = await this._resolveSessionScope(sessionId, options);
        const session = this.getSession(sessionId, scope);
        if (session.memoryLoaded) {
            return null;
        }

        try {
            const dailyResult = await this.agentMemory.read('daily', null, scope);
            const dailyContent = dailyResult.content || 'No entries yet today.';

            const globalResult = await this.agentMemory.read('global', 'preferences.md', scope);
            const globalContent = globalResult.content || 'No preferences saved.';

            const scopedPaths = this._resolveScopedPaths(scope);
            let userAbout = 'No user info stored.';
            try {
                if (fs.existsSync(scopedPaths.userProfilePath)) {
                    userAbout = fs.readFileSync(scopedPaths.userProfilePath, 'utf-8').trim() || userAbout;
                }
            } catch (e) { }

            const template = this._loadTemplate('start');
            const context = template
                .replace('{daily_memory}', dailyContent)
                .replace('{global_preferences}', globalContent)
                .replace('{user_about}', userAbout);

            session.memoryLoaded = true;
            console.log(`[AgentLoop] Memory context loaded for session ${sessionId}`);

            this.emit('memory-loaded', { sessionId, userId: scope.userId });
            return context;
        } catch (error) {
            console.error('[AgentLoop] Failed to load memory context:', error.message);
            return null;
        }
    }

    _resetIdleTimer(sessionId) {
        const session = this.getSession(sessionId);

        if (session.idleTimer) {
            clearTimeout(session.idleTimer);
        }

        session.idleTimer = setTimeout(async () => {
            await this._onIdle(sessionId);
        }, session.idleSeconds * 1000);
        if (typeof session.idleTimer.unref === 'function') {
            session.idleTimer.unref();
        }
    }

    async _onIdle(sessionId) {
        const session = this.getSession(sessionId);
        if (!session.autoMemory || session.messageCount < 6 || session.memorySaved) {
            return;
        }

        console.log(`[AgentLoop] Idle trigger fired for session ${sessionId}`);

        try {
            const scope = await this._resolveSessionScope(sessionId, { userId: session.userId || null });
            const conversations = await this.db.getConversations(20, sessionId, scope);
            if (!conversations || conversations.length < 6) return;

            const conversationText = conversations
                .map(c => `${c.role}: ${c.content}`)
                .join('\n')
                .substring(0, 3000);

            const template = this._loadTemplate('idle');
            const prompt = `${template}\n\nConversation:\n${conversationText}`;
            const response = await this.dispatcher.dispatch(prompt, [], { mode: 'internal', requestContext: scope.requestContext || null });

            if (response && response.content) {
                const cleanContent = this._stripToolCalls(response.content);
                await this.agentMemory.append('daily', `[AutoMemory - Session ${sessionId}]\n${cleanContent}`, null, scope);
                session.memorySaved = true;

                console.log(`[AgentLoop] Idle memory saved for session ${sessionId}`);
                this.emit('memory-saved', { sessionId, type: 'idle', userId: scope.userId });
            }
        } catch (error) {
            console.error('[AgentLoop] Idle memory failed:', error.message);
        }
    }

    async _enqueueCloseSummaryJob(sessionId, options = {}) {
        if (isPrivateSessionId(sessionId)) {
            return;
        }
        const scope = await this._resolveSessionScope(sessionId, options);
        if (this.taskQueueService && typeof this.taskQueueService.createOrReuseTask === 'function') {
            try {
                await this.taskQueueService.createOrReuseTask({
                    listener: 'daemon',
                    status: 'pending',
                    requires_user_action: false,
                    priority: 'normal',
                    dedupe: `daemon:summarize_session:${scope.userId}:${sessionId}`,
                    action: 'daemon.enqueue_memory_job',
                    payload: {
                        jobType: 'summarize_session',
                        sessionId,
                        userId: scope.userId,
                        source: 'session_close',
                        enqueued_at: new Date().toISOString()
                    },
                    title: `Summarize closed session ${sessionId}`,
                    by: 'agent-loop'
                }, { actor: 'agent-loop' });
                return;
            } catch (error) {
                console.error(`[AgentLoop] Failed to enqueue global task for session ${sessionId}:`, error.message);
            }
        }

        if (!this.db || typeof this.db.enqueueMemoryJob !== 'function') {
            return;
        }
        try {
            await this.db.enqueueMemoryJob({
                jobType: 'summarize_session',
                sessionId,
                payload: {
                    user_id: scope.userId,
                    source: 'session_close',
                    enqueued_at: new Date().toISOString()
                }
            }, scope);
        } catch (error) {
            console.error(`[AgentLoop] Failed to enqueue summary job for session ${sessionId}:`, error.message);
        }
    }

    async onSessionClose(sessionId, options = {}) {
        if (isPrivateSessionId(sessionId)) {
            this.removeSession(sessionId);
            return;
        }
        const session = this.sessions.get(sessionId);
        if (!session || session.memorySaved || session.messageCount < 4) {
            this.removeSession(sessionId);
            return;
        }

        console.log(`[AgentLoop] Chat close trigger fired for session ${sessionId} (queueing summary job)`);
        await this._enqueueCloseSummaryJob(sessionId, { ...options, userId: session.userId || options?.userId || null });

        this.removeSession(sessionId);
    }

    async onAppQuit() {
        console.log('[AgentLoop] App quit — skipping close summaries for fast shutdown');
        const sessionIds = Array.from(this.sessions.keys());
        for (const sessionId of sessionIds) {
            const session = this.sessions.get(sessionId);
            if (session && !session.memorySaved && session.messageCount >= 4) {
                await this._enqueueCloseSummaryJob(sessionId, { userId: session.userId || null });
            }
            this.removeSession(sessionId);
        }
    }

    _loadTemplate(name) {
        const templatePath = this.templates[name];
        try {
            if (fs.existsSync(templatePath)) {
                return fs.readFileSync(templatePath, 'utf-8');
            }
        } catch (e) { }

        const fallbacks = {
            start: 'Review your memory for context.',
            idle: 'Summarize this conversation for your daily memory. Be concise (3-5 bullet points).',
            close: 'Summarize this conversation for your daily memory. Be concise (3-5 bullet points).'
        };
        return fallbacks[name] || '';
    }

    _stripToolCalls(text) {
        return stripToolPatterns(text);
    }
}

module.exports = AgentLoop;
