// @ts-nocheck
const ResourceMonitor = require('./resource-monitor');
const { resolveWorkflowScope } = require('./workflow-ownership');

/**
 * BackgroundWorkflowScheduler — Runs user-scheduled workflows on a fixed 15-minute tick.
 */
class BackgroundWorkflowScheduler {
    constructor(workflowManager, db, eventBus) {
        this.workflowManager = workflowManager;
        this.db = db;
        this.eventBus = eventBus;

        this.running = false;
        this._tickTimer = null;
        this._tableEnsured = false;
        this._userActivity = new Map();

        this.TICK_INTERVAL = 15 * 60 * 1000;
        this.RESOURCE_THRESHOLD = 20;
        this._resourceMonitor = new ResourceMonitor(this.RESOURCE_THRESHOLD);

        if (this.eventBus) {
            this.eventBus.on('chat:user-active', (payload = {}) => {
                const userId = String(payload?.userId || '').trim();
                if (userId) this._userActivity.set(userId, true);
            });
            this.eventBus.on('chat:user-idle', (payload = {}) => {
                const userId = String(payload?.userId || '').trim();
                if (userId) this._userActivity.set(userId, false);
            });
        }

        this._ensureTable();
    }

    async start() {
        if (this.running) return;
        this._ensureTable();
        this.running = true;
        console.log('[WorkflowScheduler] Started (15-min tick)');
        if (this.eventBus) {
            this.eventBus.publish('daemon:started', { daemon: 'workflow-scheduler' });
        }
        this._scheduleTick(60 * 1000);
    }

    stop() {
        if (!this.running) {
            return;
        }

        this.running = false;
        if (this._tickTimer) {
            clearTimeout(this._tickTimer);
            this._tickTimer = null;
        }

        console.log('[WorkflowScheduler] Stopped');
        if (this.eventBus) {
            this.eventBus.publish('daemon:stopped', { daemon: 'workflow-scheduler' });
        }
    }

    getStatus(options = {}) {
        this._ensureTable();
        const scope = resolveWorkflowScope(options);
        const schedules = this._getDueSchedules(scope);
        const allSchedules = this._getAllSchedules(scope);
        return {
            running: this.running,
            tickInterval: this.TICK_INTERVAL / 60000,
            scheduledWorkflows: allSchedules.length,
            dueNow: schedules.length,
            userId: scope.userId,
        };
    }

    _scheduleTick(delay) {
        if (!this.running) return;
        if (this._tickTimer) clearTimeout(this._tickTimer);

        this._tickTimer = setTimeout(async () => {
            await this._onTick();
        }, delay);
        if (typeof this._tickTimer.unref === 'function') {
            this._tickTimer.unref();
        }
    }

    async _onTick() {
        if (!this.running) return;

        try {
            const resources = await this._checkResources();
            if (!resources.available) {
                console.log(`[WorkflowScheduler] Resources busy (${resources.combined}%), skipping tick`);
                if (this.eventBus) {
                    this.eventBus.publish('workflow:scheduled-skipped', {
                        reason: 'resources',
                        load: resources.combined,
                    });
                }
                this._scheduleTick(this.TICK_INTERVAL);
                return;
            }

            const dueSchedules = this._getDueSchedules();
            if (dueSchedules.length === 0) {
                this._scheduleTick(this.TICK_INTERVAL);
                return;
            }

            console.log(`[WorkflowScheduler] ${dueSchedules.length} workflow(s) due`);
            for (const schedule of dueSchedules) {
                if (this._isUserActive(schedule.user_id)) {
                    continue;
                }
                await this._executeScheduledWorkflow(schedule);
            }

        } catch (err) {
            console.error('[WorkflowScheduler] Tick error:', err.message);
        }

        this._scheduleTick(this.TICK_INTERVAL);
    }

    _isUserActive(userId) {
        const normalizedUserId = String(userId || '').trim();
        return normalizedUserId ? this._userActivity.get(normalizedUserId) === true : false;
    }

    async _executeScheduledWorkflow(schedule) {
        console.log(`[WorkflowScheduler] Running workflow #${schedule.workflow_id} (schedule #${schedule.id}) for ${schedule.user_id}`);

        try {
            const result = await this.workflowManager.executeWorkflow(schedule.workflow_id, {}, { userId: schedule.user_id });
            const nextRun = new Date(Date.now() + schedule.interval_minutes * 60 * 1000).toISOString();
            this.db.run(
                'UPDATE workflow_schedules SET last_run = ?, next_run = ? WHERE id = ? AND COALESCE(user_id, ?) = ?',
                [new Date().toISOString(), nextRun, schedule.id, 'localuser', schedule.user_id]
            );

            console.log(`[WorkflowScheduler] Workflow #${schedule.workflow_id} completed`);
            if (this.eventBus) {
                this.eventBus.publish('workflow:scheduled-complete', {
                    scheduleId: schedule.id,
                    workflowId: schedule.workflow_id,
                    workflowName: schedule.workflow_name,
                    userId: schedule.user_id,
                    result: result ? JSON.stringify(result).substring(0, 300) : 'No output',
                });
            }

        } catch (err) {
            console.error(`[WorkflowScheduler] Workflow #${schedule.workflow_id} failed:`, err.message);
            const nextRun = new Date(Date.now() + schedule.interval_minutes * 60 * 1000).toISOString();
            this.db.run(
                'UPDATE workflow_schedules SET last_run = ?, next_run = ? WHERE id = ? AND COALESCE(user_id, ?) = ?',
                [new Date().toISOString(), nextRun, schedule.id, 'localuser', schedule.user_id]
            );

            if (this.eventBus) {
                this.eventBus.publish('workflow:scheduled-failed', {
                    scheduleId: schedule.id,
                    workflowId: schedule.workflow_id,
                    workflowName: schedule.workflow_name,
                    userId: schedule.user_id,
                    error: err.message,
                });
            }
        }
    }

    addSchedule(workflowId, intervalMinutes, workflowName = '', options = {}) {
        this._ensureTable();
        const scope = resolveWorkflowScope(options);
        const nextRun = new Date(Date.now() + intervalMinutes * 60 * 1000).toISOString();
        const result = this.db.run(
            `INSERT INTO workflow_schedules (workflow_id, workflow_name, interval_minutes, next_run, user_id)
             VALUES (?, ?, ?, ?, ?)`,
            [workflowId, workflowName, intervalMinutes, nextRun, scope.userId]
        );
        return { id: result.id, workflowId, intervalMinutes, nextRun, user_id: scope.userId };
    }

    removeSchedule(scheduleId, options = {}) {
        this._ensureTable();
        const scope = resolveWorkflowScope(options);
        this.db.run('DELETE FROM workflow_schedules WHERE id = ? AND COALESCE(user_id, ?) = ?', [scheduleId, 'localuser', scope.userId]);
        return { success: true };
    }

    toggleSchedule(scheduleId, enabled, options = {}) {
        this._ensureTable();
        const scope = resolveWorkflowScope(options);
        this.db.run('UPDATE workflow_schedules SET enabled = ? WHERE id = ? AND COALESCE(user_id, ?) = ?', [enabled ? 1 : 0, scheduleId, 'localuser', scope.userId]);
        return { success: true };
    }

    _getAllSchedules(options = {}) {
        try {
            this._ensureTable();
            const hasScope = options && (options.userId || options.requestContext);
            if (!hasScope) {
                return this.db.all('SELECT * FROM workflow_schedules ORDER BY next_run');
            }
            const scope = resolveWorkflowScope(options);
            return this.db.all('SELECT * FROM workflow_schedules WHERE COALESCE(user_id, ?) = ? ORDER BY next_run', ['localuser', scope.userId]);
        } catch (e) {
            return [];
        }
    }

    _getDueSchedules(options = null) {
        try {
            this._ensureTable();
            const now = new Date().toISOString();
            if (options && (options.userId || options.requestContext)) {
                const scope = resolveWorkflowScope(options);
                return this.db.all(
                    `SELECT ws.*, w.name as workflow_name
                     FROM workflow_schedules ws
                     LEFT JOIN workflows w ON ws.workflow_id = w.id AND COALESCE(w.user_id, ?) = COALESCE(ws.user_id, ?)
                     WHERE ws.enabled = 1 AND ws.next_run <= ? AND COALESCE(ws.user_id, ?) = ?
                     ORDER BY ws.next_run`,
                    ['localuser', 'localuser', now, 'localuser', scope.userId]
                );
            }
            return this.db.all(
                `SELECT ws.*, w.name as workflow_name
                 FROM workflow_schedules ws
                 LEFT JOIN workflows w ON ws.workflow_id = w.id AND COALESCE(w.user_id, ?) = COALESCE(ws.user_id, ?)
                 WHERE ws.enabled = 1 AND ws.next_run <= ?
                 ORDER BY ws.next_run`,
                ['localuser', 'localuser', now]
            );
        } catch (e) {
            return [];
        }
    }

    _ensureTable() {
        if (this._tableEnsured) return;

        try {
            this.db.db.exec(`CREATE TABLE IF NOT EXISTS workflow_schedules (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                workflow_id INTEGER NOT NULL,
                workflow_name TEXT DEFAULT '',
                interval_minutes INTEGER NOT NULL DEFAULT 60,
                last_run TEXT,
                next_run TEXT,
                enabled INTEGER DEFAULT 1,
                user_id TEXT NOT NULL DEFAULT 'localuser',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (workflow_id) REFERENCES workflows(id)
            )`);
            try {
                this.db.db.exec("ALTER TABLE workflow_schedules ADD COLUMN user_id TEXT NOT NULL DEFAULT 'localuser'");
            } catch (_) {}
            this.db.db.exec("UPDATE workflow_schedules SET user_id = 'localuser' WHERE user_id IS NULL OR TRIM(user_id) = '' OR user_id = 'owner'");
            this.db.db.exec('CREATE INDEX IF NOT EXISTS idx_workflow_schedules_user_due ON workflow_schedules (user_id, enabled, next_run)');
            this._tableEnsured = true;
        } catch (e) {
        }
    }

    async _checkResources() {
        return await this._resourceMonitor.check();
    }
}

module.exports = BackgroundWorkflowScheduler;
