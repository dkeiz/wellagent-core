// @ts-nocheck
const fs = require('fs');
const path = require('path');
const ResourceMonitor = require('./resource-monitor');
const { buildRuntimePaths, buildScopedMutableRuntimePaths } = require('./runtime-paths');
const { normalizeUserId } = require('./user-scope');

/**
 * BackgroundMemoryDaemon — Persistent background agent for memory housekeeping.
 *
 * Runs on an escalating tick schedule:
 *   Tick 1: immediately after cold start
 *   Tick 2: +15 minutes
 *   Tick 3: +1 hour
 *   Tick 4: +4 hours
 *   Tick 5: +16 hours
 *   Tick 6+: every 24 hours
 *
 * Resource gate: only runs when GPU + VRAM + CPU load < 20%.
 *
 * Tasks (LLM-driven selection):
 *   - Summarize unsummarized closed sessions
 *   - Update user persona profile
 *   - Consolidate daily memories
 *   - Memory health check (hash integrity)
 *   - Clean stale temp files
 */
class BackgroundMemoryDaemon {
    constructor(dispatcher, agentMemory, db, eventBus, options = {}) {
        this.dispatcher = dispatcher;
        this.agentMemory = agentMemory;
        this.db = db;
        this.eventBus = eventBus;

        this.running = false;
        this._tickTimer = null;
        this._tickIndex = 0;
        this._retryTimer = null;
        this._tickInProgress = false;

        // Escalating intervals in milliseconds
        this.TICK_INTERVALS = [
            0,              // Tick 0: immediate (on start)
            15 * 60 * 1000, // Tick 1: +15 min
            60 * 60 * 1000, // Tick 2: +1 hour
            4 * 60 * 60 * 1000,  // Tick 3: +4 hours
            16 * 60 * 60 * 1000, // Tick 4: +16 hours
            24 * 60 * 60 * 1000, // Tick 5+: every 24 hours
        ];

        // Resource thresholds
        this.RESOURCE_THRESHOLD = 20; // percentage
        this.RETRY_DELAY = 5 * 60 * 1000; // 5 min retry if resources busy
        this._resourceMonitor = options.resourceMonitor || new ResourceMonitor(this.RESOURCE_THRESHOLD);

        // Paths
        const runtimePaths = options.runtimePaths || buildRuntimePaths(options);
        this.basePath = options.basePath || runtimePaths.backgroundDaemonBasePath;
        this.statePath = options.statePath || path.join(this.basePath, 'config', 'state.json');
        this.systemPromptPath = options.systemPromptPath || path.join(this.basePath, 'system.md');
        this.userProfilePath = options.userProfilePath || runtimePaths.userProfilePath;
        this.taskQueueService = options.taskQueueService || null;
        this.knowledgeManager = options.knowledgeManager || null;
        this.userRegistry = options.userRegistry || null;
        this.runtimePathOptions = { ...options, agentinRoot: runtimePaths.agentinRoot };

        if (this.eventBus) {
            this.eventBus.on('chat:user-active', (payload = {}) => {
                const userId = normalizeUserId(payload?.userId || 'localuser', 'localuser');
                const state = this._userActivity.get(userId) || { active: false, lastActivity: 0 };
                state.active = true;
                state.lastActivity = Date.now();
                this._userActivity.set(userId, state);
            });
            this.eventBus.on('chat:user-idle', (payload = {}) => {
                const userId = normalizeUserId(payload?.userId || 'localuser', 'localuser');
                const state = this._userActivity.get(userId) || { active: false, lastActivity: 0 };
                state.active = false;
                state.lastActivity = Date.now();
                this._userActivity.set(userId, state);
            });
        }

        this._userActivity = new Map();
        this.MAX_QUEUED_JOBS_PER_TICK = 5;
        this.MAX_JOB_ATTEMPTS = 5;
        this.JOB_RETRY_DELAY_SECONDS = 5 * 60;
    }

    // ==================== Lifecycle ====================
    setKnowledgeManager(knowledgeManager) {
        this.knowledgeManager = knowledgeManager || null;
    }

    _resolveScopedPaths(options = {}) {
        return buildScopedMutableRuntimePaths({
            ...this.runtimePathOptions,
            ...options,
            memoryBasePath: null,
            userProfilePath: null,
            knowledgeBaseDir: null,
            researchBasePath: null
        });
    }

    _listDaemonUserIds() {
        const users = this.userRegistry?.listUsers ? this.userRegistry.listUsers() : [{ userId: 'localuser' }];
        const seen = new Set();
        const ids = [];
        for (const user of users) {
            const userId = normalizeUserId(user?.userId || 'localuser', 'localuser');
            if (seen.has(userId)) continue;
            seen.add(userId);
            ids.push(userId);
        }
        if (!seen.has('localuser')) {
            ids.unshift('localuser');
        }
        return ids;
    }

    _getActiveUserIds() {
        return Array.from(this._userActivity.entries())
            .filter(([, value]) => value?.active)
            .map(([userId]) => userId);
    }

    _isUserActive(userId = 'localuser') {
        return Boolean(this._userActivity.get(normalizeUserId(userId, 'localuser'))?.active);
    }

    /**
     * Start the daemon. Ensures folder structure, loads state, begins ticking.
     */
    async start() {
        if (this.running) {
            console.log('[MemoryDaemon] Already running');
            return;
        }

        this._ensureFolderStructure();
        this._loadState();
        if (this.db?.resetStaleRunningMemoryJobs) {
            await this.db.resetStaleRunningMemoryJobs({
                maxAgeMinutes: 30,
                jobType: 'summarize_session'
            });
        }

        this.running = true;
        this._tickIndex = 0;

        console.log('[MemoryDaemon] Started');
        if (this.eventBus) {
            this.eventBus.publish('daemon:started', { daemon: 'memory' });
        }

        // First tick: immediate
        this._scheduleTick(0);
    }

    /**
     * Stop the daemon gracefully.
     */
    stop() {
        if (!this.running) {
            return;
        }

        this.running = false;
        if (this._tickTimer) {
            clearTimeout(this._tickTimer);
            this._tickTimer = null;
        }
        if (this._retryTimer) {
            clearTimeout(this._retryTimer);
            this._retryTimer = null;
        }

        this._saveState();
        console.log('[MemoryDaemon] Stopped');
        if (this.eventBus) {
            this.eventBus.publish('daemon:stopped', { daemon: 'memory' });
        }
    }

    /**
     * Get current daemon status.
     */
    getStatus() {
        const state = this._loadState();
        return {
            running: this.running,
            tickIndex: this._tickIndex,
            nextTickIn: this._getNextTickDelay(),
            lastTick: state.lastTickTime,
            tasksCompleted: state.tasksCompleted || 0,
            lastTask: state.lastTaskName,
        };
    }

    // ==================== Tick Scheduler ====================

    _scheduleTick(delayMs) {
        if (!this.running) return;

        if (this._tickTimer) clearTimeout(this._tickTimer);

        this._tickTimer = setTimeout(async () => {
            await this._onTick();
        }, delayMs);
        if (typeof this._tickTimer.unref === 'function') {
            this._tickTimer.unref();
        }
    }

    _getNextTickDelay() {
        const idx = Math.min(this._tickIndex, this.TICK_INTERVALS.length - 1);
        return this.TICK_INTERVALS[idx];
    }

    async _onTick() {
        if (!this.running) return;
        if (this._tickInProgress) {
            console.log('[MemoryDaemon] Tick already in progress, skipping scheduled overlap');
            this._retryTimer = setTimeout(() => this._onTick(), this.RETRY_DELAY);
            if (typeof this._retryTimer.unref === 'function') {
                this._retryTimer.unref();
            }
            return;
        }

        this._tickInProgress = true;

        try {
            console.log(`[MemoryDaemon] Tick ${this._tickIndex}`);
            if (this.eventBus) {
                this.eventBus.publish('daemon:tick', { tickIndex: this._tickIndex });
            }

            // Check resource gate
            const resources = await this._checkResources();
            if (!resources.available) {
                console.log(`[MemoryDaemon] Resources busy (CPU: ${resources.cpu}%, GPU: ${resources.gpu}%), retrying in 5 min`);
                await this._deferDueGlobalDaemonTasks('Resources busy');
                this._retryTimer = setTimeout(() => this._onTick(), this.RETRY_DELAY);
                if (typeof this._retryTimer.unref === 'function') {
                    this._retryTimer.unref();
                }
                return;
            }
            await this._executeTick();
        } catch (err) {
            console.error('[MemoryDaemon] Tick failed:', err.message);
            if (this.eventBus) {
                this.eventBus.publish('daemon:error', { daemon: 'memory', error: err.message });
            }
        } finally {
            this._tickInProgress = false;
        }

        // Schedule next tick
        this._tickIndex++;
        const nextDelay = this._getNextTickDelay();
        console.log(`[MemoryDaemon] Next tick in ${Math.round(nextDelay / 60000)} minutes`);
        this._scheduleTick(nextDelay);
    }

    async runNow() {
        if (!this.running) {
            return { success: false, error: 'Memory daemon is not running' };
        }
        if (this._tickInProgress) {
            return { success: false, error: 'Memory daemon tick already in progress' };
        }

        this._tickInProgress = true;
        try {
            console.log(`[MemoryDaemon] Manual tick requested at tick index ${this._tickIndex}`);
            if (this.eventBus) {
                this.eventBus.publish('daemon:tick', { tickIndex: this._tickIndex, manual: true });
            }

            const resources = await this._checkResources();
            if (!resources.available) {
                return {
                    success: false,
                    error: `Resources busy (CPU: ${resources.cpu}%, GPU: ${resources.gpu}%)`
                };
            }
            await this._executeTick();
            return { success: true, executed: true, tickIndex: this._tickIndex };
        } catch (err) {
            console.error('[MemoryDaemon] Manual tick failed:', err.message);
            if (this.eventBus) {
                this.eventBus.publish('daemon:error', { daemon: 'memory', error: err.message });
            }
            return { success: false, error: err.message };
        } finally {
            this._tickInProgress = false;
        }
    }

    // ==================== Task Execution ====================

    /**
     * Execute a tick — ask LLM what needs doing, then do it.
     */
    async _executeTick() {
        const globalProcessed = await this._drainGlobalQueueTasks(this.MAX_QUEUED_JOBS_PER_TICK);
        if (globalProcessed > 0) {
            const state = this._loadState();
            state.lastTickTime = new Date().toISOString();
            state.lastTaskName = 'global-daemon-queue';
            state.tasksCompleted = (state.tasksCompleted || 0) + globalProcessed;
            this._saveStateData(state);
            console.log(`[MemoryDaemon] Processed ${globalProcessed} global daemon queue task(s)`);
            if (this.eventBus) {
                this.eventBus.publish('daemon:task-completed', {
                    daemon: 'memory',
                    task: 'global-daemon-queue',
                    summary: `Processed ${globalProcessed} queued daemon task(s)`
                });
            }
            return;
        }

        const queueProcessed = await this._drainQueuedSummaryJobs(this.MAX_QUEUED_JOBS_PER_TICK);
        if (queueProcessed > 0) {
            const state = this._loadState();
            state.lastTickTime = new Date().toISOString();
            state.lastTaskName = 'queued-session-summaries';
            state.tasksCompleted = (state.tasksCompleted || 0) + queueProcessed;
            this._saveStateData(state);
            console.log(`[MemoryDaemon] Processed ${queueProcessed} queued summary job(s)`);
            if (this.eventBus) {
                this.eventBus.publish('daemon:task-completed', {
                    daemon: 'memory',
                    task: 'queued-session-summaries',
                    summary: `Processed ${queueProcessed} queued summary job(s)`
                });
            }
            return;
        }

        const maintenanceUserId = this._listDaemonUserIds().find((userId) => !this._isUserActive(userId)) || null;
        if (!maintenanceUserId) {
            console.log('[MemoryDaemon] No inactive user available for maintenance');
            if (this.eventBus) {
                this.eventBus.publish('daemon:idle', { tickIndex: this._tickIndex, reason: 'all-users-active' });
            }
            return;
        }

        const stateContext = await this._gatherStateContext({ userId: maintenanceUserId });
        const systemPrompt = this._loadSystemPrompt();
        const taskPrompt = `${systemPrompt}

## Current State
${stateContext}

## Instructions
Review the current state above. Decide what task (if any) needs to be done right now.

If no work is needed, respond with exactly: [no work needed]

If work is needed, perform it now using the available information. You can:
- Write memory summaries for unsummarized sessions
- Update the user persona based on recent conversations
- Consolidate verbose daily memories into concise entries
- Note any issues found during review

Critical: do not invent conversation details. Only summarize sessions when transcript excerpts are present in Current State.

After completing the task, end with a brief summary of what you did in the format:
[task: <task_name>] <summary>`;

        const response = await this.dispatcher.dispatch(taskPrompt, [], {
            mode: 'internal',
            includeTools: false,
            includeRules: false,
            preemptible: true,
            requestContext: { userId: maintenanceUserId }
        });

        if (response && response.stopped) {
            console.log('[MemoryDaemon] Tick preempted by foreground activity');
            return;
        }

        if (!response || !response.content) return;

        const content = response.content.trim();
        if (content.toLowerCase().includes('[no work needed]')) {
            console.log('[MemoryDaemon] No work needed this tick');
            if (this.eventBus) {
                this.eventBus.publish('daemon:idle', { tickIndex: this._tickIndex, userId: maintenanceUserId });
            }
            return;
        }

        const taskMatch = content.match(/\[task:\s*([^\]]+)\]/i);
        const taskName = taskMatch ? taskMatch[1].trim() : 'general-maintenance';
        await this._processTaskOutput(taskName, content, { userId: maintenanceUserId });

        const state = this._loadState();
        state.lastTickTime = new Date().toISOString();
        state.lastTaskName = `${maintenanceUserId}:${taskName}`;
        state.tasksCompleted = (state.tasksCompleted || 0) + 1;
        this._saveStateData(state);

        console.log(`[MemoryDaemon] Task completed for ${maintenanceUserId}: ${taskName}`);
        if (this.eventBus) {
            this.eventBus.publish('daemon:task-completed', {
                daemon: 'memory',
                task: taskName,
                userId: maintenanceUserId,
                summary: content.substring(0, 200),
            });
        }
    }
    async _drainQueuedSummaryJobs(maxJobs = 5) {
        if (!this.db?.claimNextMemoryJob || !this.db?.completeMemoryJob || !this.db?.failMemoryJob) {
            return 0;
        }

        const limit = Math.max(1, Number(maxJobs) || 5);
        let processed = 0;
        for (let i = 0; i < limit; i++) {
            if (!this.running) break;
            const resources = await this._checkResources();
            if (!resources.available) {
                break;
            }

            const job = await this.db.claimNextMemoryJob('summarize_session', 'memory-daemon', {
                excludeUserIds: this._getActiveUserIds()
            });
            if (!job) {
                break;
            }

            try {
                const summary = await this._runSummaryJob(job);
                await this.db.completeMemoryJob(job.id, {
                    summary: summary.substring(0, 500),
                    payload: {
                        session_id: job.session_id,
                        user_id: job.user_id,
                        summarized_at: new Date().toISOString()
                    }
                });
                if (this.db.markDaemonSessionInspected) {
                    await this.db.markDaemonSessionInspected(job.session_id, {
                        userId: job.user_id,
                        jobId: job.id,
                        notes: summary.substring(0, 500)
                    });
                }
                processed++;
            } catch (error) {
                await this.db.failMemoryJob(job.id, error.message, {
                    maxAttempts: this.MAX_JOB_ATTEMPTS,
                    retryDelaySeconds: this.JOB_RETRY_DELAY_SECONDS
                });
                console.error(`[MemoryDaemon] Summary job ${job.id} failed:`, error.message);
            }
        }

        return processed;
    }
    async _deferDueGlobalDaemonTasks(reason = 'Daemon deferred') {
        if (!this.taskQueueService || typeof this.taskQueueService.deferDueListenerTasks !== 'function') {
            return;
        }
        try {
            await this.taskQueueService.deferDueListenerTasks('daemon', Math.ceil(this.RETRY_DELAY / 60000), {
                actor: 'daemon',
                reason,
                limit: 5
            });
        } catch (error) {
            console.error('[MemoryDaemon] Failed to defer global daemon tasks:', error.message);
        }
    }

    async _drainGlobalQueueTasks(maxJobs = 5) {
        if (!this.taskQueueService || typeof this.taskQueueService.claimNextTask !== 'function') {
            return 0;
        }

        const limit = Math.max(1, Number(maxJobs) || 5);
        let processed = 0;

        for (let i = 0; i < limit; i++) {
            if (!this.running) break;

            const task = await this.taskQueueService.claimNextTask({
                listener: 'daemon',
                owner: 'daemon',
                actor: 'daemon',
                statuses: ['pending', 'approved', 'deferred']
            });
            if (!task) {
                break;
            }

            try {
                await this._executeGlobalDaemonTask(task);
                await this.taskQueueService.completeTask(task.id, {
                    actor: 'daemon',
                    summary: `Executed action ${task.action || 'none'}`,
                    tasksFilePath: task._queueFilePath
                });
                processed++;
            } catch (error) {
                await this.taskQueueService.failTask(task.id, error.message, {
                    actor: 'daemon',
                    tasksFilePath: task._queueFilePath
                });
                console.error(`[MemoryDaemon] Global queue task failed (${task.id}):`, error.message);
            }
        }

        return processed;
    }

    async _executeGlobalDaemonTask(task) {
        const action = String(task?.action || '').trim().toLowerCase();
        const payload = task?.payload && typeof task.payload === 'object' ? task.payload : {};
        if (action === 'daemon.enqueue_memory_job') {
            const sessionId = String(payload.sessionId || '').trim();
            if (!sessionId) {
                throw new Error('Missing payload.sessionId for daemon.enqueue_memory_job');
            }
            if (!this.db || typeof this.db.enqueueMemoryJob !== 'function') {
                throw new Error('Database memory job queue unavailable');
            }
            await this.db.enqueueMemoryJob({
                jobType: String(payload.jobType || 'summarize_session'),
                sessionId,
                payload: {
                    source: payload.source || 'global_task',
                    enqueued_at: new Date().toISOString(),
                    global_task_id: task.id
                }
            });
            return;
        }

        throw new Error(`Unsupported daemon task action: ${action || 'none'}`);
    }

    _buildQueuedSummaryPrompt(job, transcript) {
        return `You are processing a queued summarize_session job.

Job:
- job_id: ${job.id}
- session_id: ${job.session_id}

Task:
Summarize the transcript below into 3-5 concise bullet points capturing decisions, outcomes, blockers, and next steps.
Use only transcript facts. Do not invent details.

Transcript:
${transcript}`;
    }

    async _runSummaryJob(job) {
        const sessionId = job.session_id;
        const conversations = await this.db.getConversations(60, sessionId);
        if (!Array.isArray(conversations) || conversations.length < 4) {
            throw new Error(`Not enough conversation data for session ${sessionId}`);
        }

        const transcript = conversations
            .slice(-30)
            .map(c => `${c.role}: ${String(c.content || '').replace(/\s+/g, ' ').trim()}`)
            .join('\n')
            .substring(0, 4000);
        if (!transcript) {
            throw new Error(`Transcript is empty for session ${sessionId}`);
        }

        const prompt = this._buildQueuedSummaryPrompt(job, transcript);
        const response = await this.dispatcher.dispatch(prompt, [], {
            mode: 'internal',
            includeTools: false,
            includeRules: false,
            preemptible: true
        });

        if (response?.stopped) {
            throw new Error('Summary job preempted by foreground activity');
        }
        if (!response?.content) {
            throw new Error('Summary job returned empty content');
        }

        const cleanContent = response.content.trim();
        await this.agentMemory.append('daily', `[Queued Session Summary - ${sessionId}]\n${cleanContent}`);
        return cleanContent;
    }

    /**
     * Process the LLM's task output — save results to appropriate memory locations.
     */
    async _processTaskOutput(taskName, content, options = {}) {
        const cleanContent = content.replace(/\[task:\s*[^\]]+\]/gi, '').trim();
        if (!cleanContent) return;

        try {
            const scope = { userId: normalizeUserId(options?.userId || 'localuser', 'localuser') };
            const scopedPaths = this._resolveScopedPaths(scope);
            if (taskName.includes('summar')) {
                await this.agentMemory.append('daily', `[Daemon: Session Summary]\n${cleanContent}`, null, scope);
            } else if (taskName.includes('persona') || taskName.includes('user')) {
                const timestamp = new Date().toISOString().split('T')[0];
                const entry = `\n\n---\n[${timestamp}] Daemon Observation\n${cleanContent}\n`;
                fs.mkdirSync(path.dirname(scopedPaths.userProfilePath), { recursive: true });
                fs.appendFileSync(scopedPaths.userProfilePath, entry);
            } else if (taskName.includes('consolidat')) {
                await this.agentMemory.append('global', `[Daemon: Daily Consolidation]\n${cleanContent}`, 'daily-consolidation.md', scope);
            } else if (taskName.includes('knowledge') && this.knowledgeManager?.ingestObservation) {
                await this.knowledgeManager.ingestObservation({
                    category: 'daemon-maintenance',
                    content: cleanContent,
                    source: 'memory-daemon',
                    confidence: 0.6,
                    userId: scope.userId
                });
            } else {
                const compactPath = path.join(this.basePath, 'memory', 'compact.md');
                const timestamp = new Date().toISOString();
                const entry = `\n\n---\n[${timestamp}] ${taskName}\n${cleanContent}\n`;
                fs.appendFileSync(compactPath, entry);
            }
        } catch (err) {
            console.error(`[MemoryDaemon] Failed to save task output:`, err.message);
        }
    }
    // ==================== State Context ====================

    /**
     * Gather context about current application state for the LLM to review.
     */
    async _gatherStateContext(options = {}) {
        const lines = [];

        try {
            // Memory stats
            const scope = { userId: normalizeUserId(options?.userId || 'localuser', 'localuser') };
            const scopedPaths = this._resolveScopedPaths(scope);
            const stats = this.agentMemory.getStats(scope);
            lines.push(`**Memory Stats:** daily=${stats.daily || 0} files, global=${stats.global || 0} files, tasks=${stats.tasks || 0} files`);

            // Recent daily memory
            const dailyResult = await this.agentMemory.read('daily', null, scope);
            if (dailyResult.content) {
                const preview = dailyResult.content.substring(0, 500);
                lines.push(`**Today's Memory (preview):**\n${preview}`);
            } else {
                lines.push('**Today\'s Memory:** Empty — no entries yet today');
            }

            // User profile
            if (fs.existsSync(scopedPaths.userProfilePath)) {
                const userAbout = fs.readFileSync(scopedPaths.userProfilePath, 'utf-8').trim();
                lines.push(`**User Profile:**\n${userAbout.substring(0, 300)}`);
            }

            // Unsummarized sessions (sessions closed without memory save)
            const recentSessions = this.db.all(`
                SELECT cs.id, cs.title, cs.created_at, cs.last_message_at,
                       COUNT(c.id) as message_count
                FROM chat_sessions cs
                LEFT JOIN conversations c ON cs.id = c.session_id
                LEFT JOIN daemon_session_inspections dsi
                  ON CAST(cs.id AS TEXT) = CAST(dsi.session_id AS TEXT)
                 AND COALESCE(dsi.user_id, 'localuser') = ?
                WHERE cs.agent_id IS NULL
                  AND COALESCE(cs.user_id, 'localuser') = ?
                  AND dsi.session_id IS NULL
                  AND NOT EXISTS (
                      SELECT 1 FROM memory_jobs mj
                      WHERE mj.job_type = 'summarize_session'
                        AND CAST(mj.session_id AS TEXT) = CAST(cs.id AS TEXT)
                        AND COALESCE(mj.user_id, 'localuser') = ?
                        AND mj.status IN ('done', 'pending', 'running')
                  )
                GROUP BY cs.id
                HAVING message_count >= 4
                ORDER BY cs.last_message_at DESC
                LIMIT 10
            `, [scope.userId, scope.userId, scope.userId]);
            lines.push(`**Recent Sessions:** ${recentSessions.length} with 4+ messages`);
            if (this.db.getDaemonSessionInspectionStats) {
                const inspectionStats = this.db.getDaemonSessionInspectionStats(scope);
                lines.push(`**Daemon Session Inspections:** ${inspectionStats.count || 0} inspected; last=${inspectionStats.lastInspectedAt || 'never'}`);
            }

            const transcriptBlocks = [];
            for (const session of recentSessions.slice(0, 3)) {
                const messages = await this.db.getConversations(20, session.id, scope);
                if (!Array.isArray(messages) || messages.length === 0) {
                    continue;
                }
                const transcript = messages
                    .slice(-12)
                    .map(msg => `${msg.role}: ${String(msg.content || '').replace(/\s+/g, ' ').trim()}`)
                    .join('\n')
                    .substring(0, 1200);
                if (!transcript) {
                    continue;
                }
                transcriptBlocks.push(
                    `Session ${session.id} (${session.title || 'Untitled'}) transcript excerpt:\n${transcript}`
                );
            }
            if (transcriptBlocks.length > 0) {
                lines.push(`**Session Transcript Excerpts:**\n${transcriptBlocks.join('\n\n')}`);
            } else {
                lines.push('**Session Transcript Excerpts:** none available');
            }

            // Daemon's own state
            const state = this._loadState();
            lines.push(`**Last Tick:** ${state.lastTickTime || 'never'}`);
            lines.push(`**Last Task:** ${state.lastTaskName || 'none'}`);
            lines.push(`**Tasks Completed:** ${state.tasksCompleted || 0}`);
            lines.push(`**Current Time:** ${new Date().toISOString()}`);

        } catch (err) {
            lines.push(`**Error gathering state:** ${err.message}`);
        }

        return lines.join('\n');
    }

    // ==================== Resource Check ====================

    /**
     * Check GPU + CPU usage. Returns { available: bool, cpu, gpu }
     */
    async _checkResources() {
        return await this._resourceMonitor.check();
    }

    // ==================== Folder & State ====================

    _ensureFolderStructure() {
        const dirs = [
            this.basePath,
            path.join(this.basePath, 'memory'),
            path.join(this.basePath, 'config'),
        ];
        for (const dir of dirs) {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        }

        // Seed system.md if missing
        if (!fs.existsSync(this.systemPromptPath)) {
            fs.writeFileSync(this.systemPromptPath, this._defaultSystemPrompt(), 'utf-8');
        }

        // Seed state.json if missing (prefer state.default.json template when present)
        if (!fs.existsSync(this.statePath)) {
            const defaultStatePath = path.join(path.dirname(this.statePath), 'state.default.json');
            let seeded = false;
            try {
                if (fs.existsSync(defaultStatePath)) {
                    const raw = JSON.parse(fs.readFileSync(defaultStatePath, 'utf-8'));
                    const normalized = {
                        lastTickTime: raw?.lastTickTime ?? null,
                        lastTaskName: raw?.lastTaskName ?? null,
                        tasksCompleted: Number.isFinite(raw?.tasksCompleted) ? raw.tasksCompleted : 0,
                        createdAt: raw?.createdAt || new Date().toISOString(),
                    };
                    this._saveStateData(normalized);
                    seeded = true;
                }
            } catch (e) {
                console.warn('[MemoryDaemon] Failed to read state.default.json, falling back to generated defaults:', e.message);
            }

            if (!seeded) {
                this._saveStateData({
                    lastTickTime: null,
                    lastTaskName: null,
                    tasksCompleted: 0,
                    createdAt: new Date().toISOString(),
                });
            }
        }
    }

    _loadState() {
        try {
            if (fs.existsSync(this.statePath)) {
                return JSON.parse(fs.readFileSync(this.statePath, 'utf-8'));
            }
        } catch (e) { /* ignore */ }
        return { lastTickTime: null, lastTaskName: null, tasksCompleted: 0 };
    }

    _saveState() {
        const state = this._loadState();
        this._saveStateData(state);
    }

    _saveStateData(state) {
        try {
            fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2), 'utf-8');
        } catch (e) {
            console.error('[MemoryDaemon] Failed to save state:', e.message);
        }
    }

    _loadSystemPrompt() {
        try {
            if (fs.existsSync(this.systemPromptPath)) {
                return fs.readFileSync(this.systemPromptPath, 'utf-8');
            }
        } catch (e) { /* ignore */ }
        return this._defaultSystemPrompt();
    }

    _defaultSystemPrompt() {
        return `# Background Memory Daemon

You are the background memory daemon for the LocalAgent desktop app. You run autonomously in the background, maintaining the agent's memory and user profile.

## Your Responsibilities
1. **Summarize unsummarized sessions** — Find closed chat sessions that haven't been summarized. Create concise summaries (3-5 bullet points) capturing key decisions, discoveries, and action items.
2. **Update user persona** — Review recent conversations for new information about the user (preferences, habits, projects, goals). Add dated observations to the user profile.
3. **Consolidate daily memories** — If today's memory is getting long/verbose, consolidate into key points.
4. **Health check** — Note any anomalies (missing files, inconsistent data).
5. **Maintain skills/knowledge lightly** — Prefer updating existing skills or knowledge items over creating duplicates. Keep skills short and procedural; put large factual/reference material into knowledge instead.

## Rules
- Be concise. Summaries should be 3-5 bullet points max.
- Preserve factual accuracy — don't infer or assume.
- Date all entries.
- Do not re-inspect sessions already marked by daemon summary jobs or inspection metadata.
- When updating a skill, change only the smallest relevant section and add/update a short metadata line such as \`Updated: YYYY-MM-DD\` near the top if the file has metadata.
- When updating knowledge, rely on \`meta.json\`/item metadata for \`updatedAt\`, source, tags, confidence, and status. Do not duplicate large raw chunks in skill files.
- If new information is large, split it into focused knowledge items instead of expanding a skill.
- If nothing needs doing, say [no work needed].
- After completing a task, respond with [task: task_name] followed by the output.
- You cannot ask the user questions — they may not be present.
- Focus on the highest-priority task only (one per tick).`;
    }
}

module.exports = BackgroundMemoryDaemon;








