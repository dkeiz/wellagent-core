// @ts-nocheck
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TASK_QUEUE_BEGIN = '<!-- TASK_QUEUE:BEGIN -->';
const TASK_QUEUE_END = '<!-- TASK_QUEUE:END -->';
const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled']);
const ACTIVE_STATUSES = new Set(['pending', 'awaiting_user', 'approved', 'running', 'deferred']);
const VALID_STATUSES = new Set([...ACTIVE_STATUSES, ...TERMINAL_STATUSES]);
const VALID_LISTENERS = new Set(['chat', 'daemon']);
const VALID_PRIORITIES = new Set(['low', 'normal', 'high']);
const PRIORITY_ORDER = new Map([['high', 0], ['normal', 1], ['low', 2]]);

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(String(status || '').trim().toLowerCase());
}

function toIsoString(value = null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

class TaskQueueService {
  constructor(options = {}) {
    this.db = options.db || null;
    this.tasksFilePath = options.tasksFilePath;
    this.agentinRoot = options.agentinRoot || path.dirname(path.dirname(this.tasksFilePath || ''));
    this.getActiveUserId = typeof options.getActiveUserId === 'function' ? options.getActiveUserId : null;
    this.onQueueUpdated = typeof options.onQueueUpdated === 'function' ? options.onQueueUpdated : null;
    this._writeChain = Promise.resolve();
    this._malformedFingerprints = new Set();
  }

  _resolveTasksFilePath(options = {}) {
    if (options.tasksFilePath) return path.resolve(String(options.tasksFilePath));
    const rawUserId = options.userId || options.user_id || options.requestContext?.userId || this.getActiveUserId?.() || 'localuser';
    const userId = String(rawUserId || 'localuser').trim().toLowerCase();
    if (!userId || userId === 'localuser' || userId === 'owner') return this.tasksFilePath;
    const folder = userId.replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'localuser';
    return path.join(this.agentinRoot, 'users', folder, 'tasks', 'tasks.md');
  }

  async initialize() {
    if (!this.tasksFilePath) {
      throw new Error('TaskQueueService requires tasksFilePath');
    }
    await fs.promises.mkdir(path.dirname(this.tasksFilePath), { recursive: true });
    await this._ensureQueueFile();

    if (this.db?.run) {
      this.db.run(`
        CREATE TABLE IF NOT EXISTS task_queue_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id TEXT,
          event_type TEXT NOT NULL,
          actor TEXT,
          payload_json TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      this.db.run(`
        CREATE INDEX IF NOT EXISTS idx_task_queue_events_task
        ON task_queue_events (task_id, created_at)
      `);
    }
  }

  async listTasks(options = {}) {
    const snapshot = await this._readSnapshot(options);
    const nowIso = new Date().toISOString();
    const filterListener = options.listener ? String(options.listener).toLowerCase() : null;
    const includeTerminal = options.includeTerminal === true;
    const actionable = options.actionable === true;
    const statuses = Array.isArray(options.statuses) && options.statuses.length
      ? new Set(options.statuses.map(status => String(status).toLowerCase()))
      : null;

    const tasks = snapshot.tasks
      .filter(task => {
        if (filterListener && task.listener !== filterListener) return false;
        if (!includeTerminal && isTerminalStatus(task.status)) return false;
        if (statuses && !statuses.has(task.status)) return false;
        if (actionable) {
          if (!ACTIVE_STATUSES.has(task.status)) return false;
          if (task.run_after && task.run_after > nowIso) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const pa = PRIORITY_ORDER.get(a.priority) ?? 1;
        const pb = PRIORITY_ORDER.get(b.priority) ?? 1;
        if (pa !== pb) return pa - pb;
        return String(a.at || '').localeCompare(String(b.at || ''));
      });

    return {
      success: true,
      tasks,
      file: snapshot.filePath
    };
  }

  async getTask(taskId, options = {}) {
    const id = String(taskId || '').trim();
    if (!id) return null;
    const snapshot = await this._readSnapshot(options);
    return snapshot.tasks.find(task => task.id === id) || null;
  }

  async createOrReuseTask(taskInput = {}, options = {}) {
    return this._withWriteLock(async () => {
      const snapshot = await this._readSnapshot(options);
      const actor = String(options.actor || taskInput.by || 'system');
      const nowIso = new Date().toISOString();
      const normalized = this._normalizeTaskInput(taskInput, nowIso);
      const dedupeKey = normalized.dedupe || null;

      let existing = null;
      if (dedupeKey) {
        existing = snapshot.tasks.find(task => task.dedupe === dedupeKey && !isTerminalStatus(task.status)) || null;
      }
      if (!existing && normalized.id) {
        existing = snapshot.tasks.find(task => task.id === normalized.id) || null;
      }

      let eventType = 'created';
      let nextTask;
      if (existing) {
        eventType = 'updated';
        nextTask = {
          ...existing,
          ...normalized,
          id: existing.id,
          status: isTerminalStatus(existing.status) ? normalized.status : existing.status,
          at: existing.at || normalized.at || nowIso,
          updated_at: nowIso
        };
      } else {
        const taskId = normalized.id || this._newTaskId();
        nextTask = {
          ...normalized,
          id: taskId,
          at: normalized.at || nowIso,
          updated_at: nowIso
        };
      }

      this._upsertTask(snapshot.tasks, nextTask);
      await this._writeSnapshot(snapshot.tasks, snapshot.filePath);
      this._logEvent(nextTask.id, eventType, actor, { task: nextTask });
      this._notifyUpdate('task-upsert', nextTask.id);
      return { success: true, task: nextTask, reused: Boolean(existing) };
    });
  }

  async claimNextTask(options = {}) {
    return this._withWriteLock(async () => {
      const listener = String(options.listener || '').trim().toLowerCase();
      if (!VALID_LISTENERS.has(listener)) {
        return null;
      }

      const actor = String(options.actor || listener || 'system');
      const owner = String(options.owner || listener || 'system');
      const runId = String(options.runId || this._newRunId(listener));
      const nowIso = new Date().toISOString();
      const statuses = new Set(
        (options.statuses || ['pending', 'approved', 'deferred'])
          .map(status => String(status || '').toLowerCase())
      );

      const eligible = snapshotTasks => snapshotTasks
        .filter(task => task.listener === listener)
        .filter(task => statuses.has(task.status))
        .filter(task => !task.run_after || task.run_after <= nowIso)
        .sort((a, b) => {
          const pa = PRIORITY_ORDER.get(a.priority) ?? 1;
          const pb = PRIORITY_ORDER.get(b.priority) ?? 1;
          if (pa !== pb) return pa - pb;
          return String(a.at || '').localeCompare(String(b.at || ''));
        });

      const snapshot = await this._readSnapshot(options);
      const next = eligible(snapshot.tasks)[0];
      if (!next) return null;

      const claimed = {
        ...next,
        status: 'running',
        owner,
        run_id: runId,
        updated_at: nowIso
      };
      this._upsertTask(snapshot.tasks, claimed);
      await this._writeSnapshot(snapshot.tasks, snapshot.filePath);
      this._logEvent(claimed.id, 'claimed', actor, { owner, run_id: runId });
      this._notifyUpdate('task-claimed', claimed.id);
      Object.defineProperty(claimed, '_queueFilePath', {
        value: snapshot.filePath,
        enumerable: false
      });
      return claimed;
    });
  }

  async claimTaskById(taskId, options = {}) {
    return this._withWriteLock(async () => {
      const id = String(taskId || '').trim();
      if (!id) return { success: false, error: 'Missing task id' };

      const snapshot = await this._readSnapshot(options);
      const index = snapshot.tasks.findIndex(task => task.id === id);
      if (index < 0) return { success: false, error: `Task ${id} not found` };

      const task = snapshot.tasks[index];
      if (isTerminalStatus(task.status)) {
        return { success: false, error: `Task ${id} is already terminal (${task.status})` };
      }

      if (
        task.run_after
        && task.run_after > new Date().toISOString()
        && options.allowFuture !== true
      ) {
        return { success: false, error: `Task ${id} is deferred until ${task.run_after}` };
      }

      const claimed = {
        ...task,
        status: 'running',
        owner: String(options.owner || 'system'),
        run_id: String(options.runId || this._newRunId('task')),
        updated_at: new Date().toISOString()
      };
      snapshot.tasks[index] = claimed;
      await this._writeSnapshot(snapshot.tasks, snapshot.filePath);
      this._logEvent(claimed.id, 'claimed', options.actor || 'system', {
        owner: claimed.owner,
        run_id: claimed.run_id
      });
      this._notifyUpdate('task-claimed', claimed.id);
      Object.defineProperty(claimed, '_queueFilePath', {
        value: snapshot.filePath,
        enumerable: false
      });
      return { success: true, task: claimed };
    });
  }

  async approveTask(taskId, options = {}) {
    return this._updateTask(taskId, { status: 'approved' }, options.actor || 'chat', 'approved', options);
  }

  async cancelTask(taskId, options = {}) {
    return this._updateTask(taskId, { status: 'cancelled' }, options.actor || 'chat', 'cancelled', options);
  }

  async completeTask(taskId, options = {}) {
    const patch = {
      status: 'done',
      completed_at: new Date().toISOString()
    };
    if (options.summary) patch.summary = String(options.summary);
    return this._updateTask(taskId, patch, options.actor || 'system', 'completed', options);
  }

  async failTask(taskId, error, options = {}) {
    return this._updateTask(
      taskId,
      {
        status: 'failed',
        last_error: String(error || 'Unknown error'),
        completed_at: new Date().toISOString()
      },
      options.actor || 'system',
      'failed',
      options
    );
  }

  async deferTask(taskId, minutes = 5, options = {}) {
    const delayMinutes = Math.max(1, Number(minutes) || 5);
    const runAfter = new Date(Date.now() + delayMinutes * 60 * 1000).toISOString();
    const patch = { status: 'deferred', run_after: runAfter };
    if (options.reason) patch.last_error = String(options.reason);
    return this._updateTask(taskId, patch, options.actor || 'system', 'deferred', options);
  }

  async deferDueListenerTasks(listener, minutes = 5, options = {}) {
    return this._withWriteLock(async () => {
      const snapshot = await this._readSnapshot(options);
      const nowIso = new Date().toISOString();
      const delayMinutes = Math.max(1, Number(minutes) || 5);
      const runAfter = new Date(Date.now() + delayMinutes * 60 * 1000).toISOString();
      const normalizedListener = String(listener || '').trim().toLowerCase();
      if (!VALID_LISTENERS.has(normalizedListener)) return { success: true, updated: 0 };

      const limit = Math.max(1, Number(options.limit) || 3);
      const actor = String(options.actor || 'system');
      const reason = options.reason ? String(options.reason) : '';

      const due = snapshot.tasks
        .filter(task => task.listener === normalizedListener)
        .filter(task => ['pending', 'approved', 'running'].includes(task.status))
        .filter(task => !task.run_after || task.run_after <= nowIso)
        .slice(0, limit);

      if (!due.length) return { success: true, updated: 0 };

      for (const task of due) {
        task.status = 'deferred';
        task.run_after = runAfter;
        task.updated_at = nowIso;
        if (reason) task.last_error = reason;
        this._logEvent(task.id, 'deferred', actor, { reason, run_after: runAfter });
      }

      await this._writeSnapshot(snapshot.tasks, snapshot.filePath);
      this._notifyUpdate('task-deferred', null);
      return { success: true, updated: due.length };
    });
  }

  async _updateTask(taskId, patch = {}, actor = 'system', eventType = 'updated', options = {}) {
    return this._withWriteLock(async () => {
      const id = String(taskId || '').trim();
      if (!id) return { success: false, error: 'Missing task id' };

      const snapshot = await this._readSnapshot(options);
      const index = snapshot.tasks.findIndex(task => task.id === id);
      if (index < 0) return { success: false, error: `Task ${id} not found` };

      const nowIso = new Date().toISOString();
      const current = snapshot.tasks[index];
      const next = this._normalizeTaskInput({ ...current, ...patch, id: current.id }, current.at || nowIso);
      next.updated_at = nowIso;
      snapshot.tasks[index] = next;

      await this._writeSnapshot(snapshot.tasks, snapshot.filePath);
      this._logEvent(next.id, eventType, actor, { patch, task: next });
      this._notifyUpdate(`task-${eventType}`, next.id);
      return { success: true, task: next };
    });
  }

  async _ensureQueueFile(tasksFilePath = this.tasksFilePath) {
    if (fs.existsSync(tasksFilePath)) {
      const current = await fs.promises.readFile(tasksFilePath, 'utf8');
      if (current.includes(TASK_QUEUE_BEGIN) && current.includes(TASK_QUEUE_END)) {
        return;
      }
    }
    const initial = [
      '# Global Task Queue',
      '',
      'This file is the source of truth for global distributed tasks.',
      'Edit only task lines between queue markers.',
      '',
      TASK_QUEUE_BEGIN,
      TASK_QUEUE_END,
      ''
    ].join('\n');
    await fs.promises.writeFile(tasksFilePath, initial, 'utf8');
  }

  async _readSnapshot(options = {}) {
    const tasksFilePath = this._resolveTasksFilePath(options);
    await fs.promises.mkdir(path.dirname(tasksFilePath), { recursive: true });
    await this._ensureQueueFile(tasksFilePath);
    const text = await fs.promises.readFile(tasksFilePath, 'utf8');
    const start = text.indexOf(TASK_QUEUE_BEGIN);
    const end = text.indexOf(TASK_QUEUE_END);
    if (start < 0 || end < 0 || end <= start) {
      throw new Error(`Task queue markers are missing in ${tasksFilePath}`);
    }

    const prefix = text.slice(0, start + TASK_QUEUE_BEGIN.length);
    const suffix = text.slice(end);
    const block = text.slice(start + TASK_QUEUE_BEGIN.length, end);
    const lines = block.split(/\r?\n/);
    const tasks = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line || !line.trim()) continue;
      const parsed = this._parseTaskLine(line, i + 1);
      if (parsed.task) {
        tasks.push(parsed.task);
      } else if (parsed.error) {
        this._logMalformedLine(line, parsed.error, i + 1);
      }
    }

    return { prefix, suffix, tasks, filePath: tasksFilePath };
  }

  async _writeSnapshot(tasks = [], tasksFilePath = this.tasksFilePath) {
    const current = await fs.promises.readFile(tasksFilePath, 'utf8');
    const start = current.indexOf(TASK_QUEUE_BEGIN);
    const end = current.indexOf(TASK_QUEUE_END);
    if (start < 0 || end < 0 || end <= start) {
      throw new Error(`Task queue markers are missing in ${tasksFilePath}`);
    }

    const before = current.slice(0, start + TASK_QUEUE_BEGIN.length);
    const after = current.slice(end);
    const lines = tasks
      .slice()
      .sort((a, b) => {
        const at = isTerminalStatus(a.status) ? 1 : 0;
        const bt = isTerminalStatus(b.status) ? 1 : 0;
        if (at !== bt) return at - bt;
        return String(a.at || '').localeCompare(String(b.at || ''));
      })
      .map(task => this._serializeTask(task));
    const content = `${before}\n${lines.join('\n')}\n${after}`;

    const tempPath = `${tasksFilePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.promises.writeFile(tempPath, content, 'utf8');
    await fs.promises.rename(tempPath, tasksFilePath);
  }

  _parseTaskLine(line, lineNumber) {
    const text = String(line || '').trim();
    if (!text.startsWith('- [')) {
      return { error: 'Line does not start with markdown checkbox' };
    }

    const markerEnd = text.indexOf('] ');
    if (markerEnd < 0) {
      return { error: 'Malformed checkbox marker' };
    }

    const checked = text.slice(3, markerEnd).trim().toLowerCase() === 'x';
    const body = text.slice(markerEnd + 2);
    const parts = body.split(' | ');
    const raw = {};
    for (const part of parts) {
      const idx = part.indexOf(':');
      if (idx < 1) continue;
      const key = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      raw[key] = value;
    }

    if (!raw.id) {
      return { error: 'Task line is missing id field' };
    }
    const nowIso = new Date().toISOString();
    const normalized = this._normalizeTaskInput({
      id: raw.id,
      status: checked && !raw.status ? 'done' : raw.status,
      listener: raw.listener,
      owner: raw.owner,
      run_id: raw.run_id,
      requires_user_action: raw.requires_user_action,
      priority: raw.priority,
      dedupe: raw.dedupe,
      action: raw.action,
      payload: raw.payload,
      by: raw.by,
      at: raw.at,
      run_after: raw.run_after,
      title: raw.title,
      completed_at: raw.completed_at,
      updated_at: raw.updated_at,
      summary: raw.summary,
      last_error: raw.last_error
    }, raw.at || nowIso);

    if (!VALID_STATUSES.has(normalized.status)) {
      return { error: `Invalid task status "${normalized.status}" at line ${lineNumber}` };
    }
    if (!VALID_LISTENERS.has(normalized.listener)) {
      return { error: `Invalid task listener "${normalized.listener}" at line ${lineNumber}` };
    }
    return { task: normalized };
  }

  _serializeTask(task) {
    const checkbox = isTerminalStatus(task.status) ? 'x' : ' ';
    const fields = [
      `id:${task.id}`,
      `status:${task.status}`,
      `listener:${task.listener}`,
      `owner:${task.owner || 'none'}`,
      `run_id:${task.run_id || 'none'}`,
      `requires_user_action:${task.requires_user_action ? '1' : '0'}`,
      `priority:${task.priority}`,
      `dedupe:${task.dedupe || 'none'}`,
      `action:${task.action || 'none'}`,
      `payload:${JSON.stringify(task.payload || {})}`,
      `title:${task.title || 'Untitled task'}`,
      `by:${task.by || 'system'}`,
      `at:${task.at || new Date().toISOString()}`,
      `run_after:${task.run_after || 'none'}`,
      `updated_at:${task.updated_at || new Date().toISOString()}`,
      `completed_at:${task.completed_at || 'none'}`,
      `summary:${task.summary || 'none'}`,
      `last_error:${task.last_error || 'none'}`
    ];
    return `- [${checkbox}] ${fields.join(' | ')}`;
  }

  _normalizeTaskInput(input = {}, fallbackAtIso) {
    const nowIso = new Date().toISOString();
    const payload = typeof input.payload === 'string'
      ? (safeJsonParse(input.payload) || {})
      : (input.payload && typeof input.payload === 'object' ? input.payload : {});

    const status = String(input.status || 'pending').trim().toLowerCase();
    const listener = String(input.listener || 'chat').trim().toLowerCase();
    const priority = String(input.priority || 'normal').trim().toLowerCase();
    const normalized = {
      id: String(input.id || '').trim() || null,
      status: VALID_STATUSES.has(status) ? status : 'pending',
      listener: VALID_LISTENERS.has(listener) ? listener : 'chat',
      owner: String(input.owner || 'none').trim() || 'none',
      run_id: String(input.run_id || 'none').trim() || 'none',
      requires_user_action: this._toBooleanFlag(input.requires_user_action),
      priority: VALID_PRIORITIES.has(priority) ? priority : 'normal',
      dedupe: this._nullableString(input.dedupe),
      action: this._nullableString(input.action),
      payload,
      title: String(input.title || input.task || '').trim() || 'Untitled task',
      by: String(input.by || 'system').trim() || 'system',
      at: toIsoString(input.at) || fallbackAtIso || nowIso,
      run_after: toIsoString(input.run_after),
      updated_at: toIsoString(input.updated_at) || nowIso,
      completed_at: toIsoString(input.completed_at),
      summary: this._nullableString(input.summary),
      last_error: this._nullableString(input.last_error)
    };

    if (isTerminalStatus(normalized.status) && !normalized.completed_at) {
      normalized.completed_at = nowIso;
    }
    return normalized;
  }

  _upsertTask(tasks, nextTask) {
    const index = tasks.findIndex(task => task.id === nextTask.id);
    if (index >= 0) {
      tasks[index] = nextTask;
    } else {
      tasks.push(nextTask);
    }
  }

  _toBooleanFlag(value) {
    if (typeof value === 'boolean') return value;
    const text = String(value ?? '').trim().toLowerCase();
    return text === '1' || text === 'true' || text === 'yes';
  }

  _nullableString(value) {
    const text = String(value ?? '').trim();
    if (!text || text === 'none' || text === 'null' || text === '{}') return null;
    return text;
  }

  _newTaskId() {
    return `T-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  }

  _newRunId(prefix = 'task') {
    const seed = crypto.randomBytes(3).toString('hex');
    return `${prefix}-${Date.now()}-${seed}`;
  }

  _withWriteLock(fn) {
    const next = this._writeChain.then(fn, fn);
    this._writeChain = next.catch(() => null);
    return next;
  }

  _logEvent(taskId, eventType, actor, payload = null) {
    if (!this.db?.run) return;
    try {
      this.db.run(
        `INSERT INTO task_queue_events (task_id, event_type, actor, payload_json) VALUES (?, ?, ?, ?)`,
        [
          taskId ? String(taskId) : null,
          String(eventType || 'updated'),
          String(actor || 'system'),
          payload ? JSON.stringify(payload) : null
        ]
      );
    } catch (error) {
      console.error('[TaskQueueService] Failed to log task queue event:', error.message);
    }
  }

  _logMalformedLine(line, reason, lineNumber) {
    const fingerprint = crypto
      .createHash('sha1')
      .update(`${lineNumber}:${line}:${reason}`)
      .digest('hex');
    if (this._malformedFingerprints.has(fingerprint)) {
      return;
    }
    this._malformedFingerprints.add(fingerprint);
    this._logEvent(null, 'parse_ignored', 'task-queue-parser', {
      line: String(line || ''),
      line_number: lineNumber,
      reason: String(reason || 'Malformed task line')
    });
  }

  _notifyUpdate(reason, taskId = null) {
    if (!this.onQueueUpdated) return;
    try {
      this.onQueueUpdated({
        reason: String(reason || 'task-updated'),
        taskId: taskId || null,
        at: new Date().toISOString()
      });
    } catch (error) {
      console.error('[TaskQueueService] Failed to notify queue update:', error.message);
    }
  }
}

module.exports = TaskQueueService;
