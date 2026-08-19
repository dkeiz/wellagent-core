// @ts-nocheck
/**
 * ArtifactRegistry — Tracks all artifacts produced during a chat session.
 *
 * Merges two sources:
 *  1. Files physically in the SessionWorkspace folder (legacy behaviour)
 *  2. Explicitly registered artifacts from tool executions (file paths
 *     outside workspace, virtual/DB-backed items like todos or timers)
 *
 * Registered metadata is cached in memory and can be persisted through the
 * application settings store. Workspace files are still rediscovered from
 * disk so older sessions continue to work without a migration.
 */

const fs = require('fs');
const path = require('path');

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.py', '.java', '.cs', '.go', '.rs', '.cpp', '.c',
  '.h', '.hpp', '.rb', '.php', '.sh', '.ps1', '.bat', '.sql', '.xml', '.html', '.css', '.scss',
  '.less', '.csv', '.log'
]);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v']);
const STORAGE_PREFIX = 'session.artifacts.v1.';
const MAX_PERSISTED_ARTIFACTS = 250;
const MAX_PERSISTED_BYTES = 1024 * 1024;
const MAX_VIRTUAL_DATA_BYTES = 256 * 1024;

function kindFromExt(fileName) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  return 'binary';
}

function categoryFromKind(kind) {
  if (kind === 'image' || kind === 'audio' || kind === 'video') return 'media';
  if (kind === 'text') return 'code';
  return 'data';
}

class ArtifactRegistry {
  /**
   * @param {Object} sessionWorkspace — SessionWorkspace instance (for legacy file scan)
   * @param {Object} [options]
   * @param {Function} [options.onUpdate] — called with (sessionId) when artifacts change
   */
  constructor(sessionWorkspace, options = {}) {
    this._sessionWorkspace = sessionWorkspace || null;
    this._onUpdate = typeof options.onUpdate === 'function' ? options.onUpdate : null;
    this._storage = options.storage || null;

    // Map<sessionId, Map<artifactKey, artifact>>
    this._registry = new Map();
    this._hidden = new Map();
    this._loadedSessions = new Set();
  }

  // ── Private helpers ──────────────────────────────────────────────

  _ensureSession(sessionId) {
    const sid = String(sessionId || '').trim();
    if (!sid) return null;
    this._loadSession(sid);
    if (!this._registry.has(sid)) {
      this._registry.set(sid, new Map());
    }
    if (!this._hidden.has(sid)) this._hidden.set(sid, new Set());
    return sid;
  }

  _storageKey(sessionId) {
    return `${STORAGE_PREFIX}${encodeURIComponent(String(sessionId || ''))}`;
  }

  _loadSession(sessionId) {
    if (this._loadedSessions.has(sessionId)) return;
    this._loadedSessions.add(sessionId);
    this._registry.set(sessionId, new Map());
    this._hidden.set(sessionId, new Set());
    if (!this._storage?.loadSessionState && !this._storage?.getSettingSync) return;
    try {
      const raw = this._storage.loadSessionState
        ? this._storage.loadSessionState(sessionId)
        : this._storage.getSettingSync(this._storageKey(sessionId));
      if (!raw) return;
      const saved = JSON.parse(String(raw));
      const session = this._registry.get(sessionId);
      for (const value of (Array.isArray(saved?.artifacts) ? saved.artifacts : []).slice(0, MAX_PERSISTED_ARTIFACTS)) {
        if (!value || typeof value !== 'object') continue;
        const artifact = {
          name: String(value.name || ''),
          path: value.path ? path.resolve(String(value.path)) : null,
          kind: String(value.kind || 'virtual'),
          category: String(value.category || 'data'),
          source: String(value.source || 'unknown'),
          action: String(value.action || 'created'),
          virtual: value.virtual === true,
          accepted: value.accepted === true,
          data: value.data ?? null,
          dataUnavailable: value.dataUnavailable === true,
          timestamp: String(value.timestamp || new Date().toISOString())
        };
        if (!artifact.name) continue;
        session.set(this._buildKey(artifact), artifact);
      }
      const hidden = this._hidden.get(sessionId);
      for (const key of (Array.isArray(saved?.hidden) ? saved.hidden : []).slice(0, MAX_PERSISTED_ARTIFACTS)) {
        if (typeof key === 'string' && key) hidden.add(key);
      }
    } catch (_) { /* Ignore corrupt legacy state and rebuild from disk. */ }
  }

  _persistSession(sessionId) {
    if (!this._storage) return;
    const artifacts = Array.from(this._registry.get(sessionId)?.values() || [])
      .sort((a, b) => Date.parse(b.timestamp || '') - Date.parse(a.timestamp || ''))
      .slice(0, MAX_PERSISTED_ARTIFACTS)
      .map(artifact => {
        const copy = { ...artifact };
        if (copy.data != null) {
          try {
            if (Buffer.byteLength(JSON.stringify(copy.data), 'utf8') > MAX_VIRTUAL_DATA_BYTES) {
              copy.data = null;
              copy.dataUnavailable = true;
            }
          } catch (_) {
            copy.data = null;
            copy.dataUnavailable = true;
          }
        }
        return copy;
      });
    const payload = { version: 1, artifacts, hidden: Array.from(this._hidden.get(sessionId) || []).slice(-MAX_PERSISTED_ARTIFACTS) };
    let serialized = JSON.stringify(payload);
    while (Buffer.byteLength(serialized, 'utf8') > MAX_PERSISTED_BYTES && payload.artifacts.length > 1) {
      payload.artifacts.pop();
      serialized = JSON.stringify(payload);
    }
    if (typeof this._storage.saveSessionState === 'function') {
      try { this._storage.saveSessionState(sessionId, serialized); } catch (_) {}
      return;
    }
    const save = this._storage.saveSetting || this._storage.setSetting;
    if (typeof save !== 'function') return;
    try {
      Promise.resolve(save.call(this._storage, this._storageKey(sessionId), serialized)).catch(() => {});
    } catch (_) { /* Persistence failure must not break tool execution. */ }
  }

  _buildKey(artifact) {
    // For file artifacts use the path; for virtual use kind:name
    if (artifact.path) {
      return `file:${path.resolve(artifact.path)}`;
    }
    return `virtual:${artifact.kind || 'unknown'}:${artifact.name || ''}`;
  }

  _notifyUpdate(sessionId) {
    if (this._onUpdate) {
      try { this._onUpdate(sessionId); } catch (_) { /* ignore */ }
    }
  }

  _isArtifactOpenable(sessionId, artifact) {
    if (!artifact || artifact.virtual === true) return false;
    if (String(artifact.action || '').toLowerCase() === 'deleted') return false;
    if (!artifact.path) return false;

    try {
      const artifactPath = path.resolve(String(artifact.path || ''));
      const registered = this._registry.get(String(sessionId || '').trim());
      const registeredArtifact = registered?.get(`file:${artifactPath}`);
      if (registeredArtifact === artifact
        || (registeredArtifact && path.resolve(String(registeredArtifact.path || '')) === artifactPath)) {
        return (!artifact.name || String(artifact.name) === path.basename(artifactPath))
          && fs.existsSync(artifactPath)
          && fs.statSync(artifactPath).isFile();
      }
      if (!this._sessionWorkspace?.getWorkspacePath) return false;
      const workspaceDir = path.resolve(this._sessionWorkspace.getWorkspacePath(sessionId));
      const relativePath = path.relative(workspaceDir, artifactPath);
      if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        return false;
      }
      if (path.dirname(relativePath) !== '.') {
        return false;
      }
      if (artifact.name && String(artifact.name) !== path.basename(artifactPath)) {
        return false;
      }
      return fs.existsSync(artifactPath) && fs.statSync(artifactPath).isFile();
    } catch (_) {
      return false;
    }
  }

  // ── Public API ───────────────────────────────────────────────────

  /**
   * Register a file-based artifact (created or edited during the session).
   *
   * @param {string} sessionId
   * @param {Object} opts
   * @param {string} opts.name      — display name (basename)
   * @param {string} opts.path      — absolute file path
   * @param {string} [opts.kind]    — text|image|audio|video|binary (auto-detected)
   * @param {string} [opts.source]  — tool name that produced this (e.g. 'write_file')
   * @param {string} [opts.category]— code|log|media|data|snapshot (auto-detected)
   * @param {string} [opts.action]  — created|edited|deleted
   */
  registerFile(sessionId, { name, path: filePath, kind, source, category, action } = {}) {
    const sid = this._ensureSession(sessionId);
    if (!sid) return null;

    const resolvedName = name || path.basename(String(filePath || ''));
    const resolvedKind = kind || kindFromExt(resolvedName);
    const resolvedCategory = category || categoryFromKind(resolvedKind);

    const artifact = {
      name: resolvedName,
      path: filePath ? path.resolve(filePath) : null,
      kind: resolvedKind,
      category: resolvedCategory,
      source: source || 'unknown',
      action: action || 'created',
      virtual: false,
      accepted: false,
      timestamp: new Date().toISOString()
    };

    const key = this._buildKey(artifact);
    const existing = this._registry.get(sid).get(key);
    if (existing) {
      // Update existing — keep accepted state, refresh timestamp and action
      existing.action = action || existing.action;
      existing.timestamp = artifact.timestamp;
      existing.source = source || existing.source;
    } else {
      this._registry.get(sid).set(key, artifact);
    }

    this._hidden.get(sid).delete(key);
    this._persistSession(sid);
    this._notifyUpdate(sid);
    return existing || artifact;
  }

  /**
   * Register a virtual (non-file) artifact, e.g. a todo, timer, or calendar event.
   *
   * @param {string} sessionId
   * @param {Object} opts
   * @param {string} opts.name      — display name
   * @param {string} opts.kind      — todo|timer|calendar|workflow
   * @param {string} [opts.source]  — tool name
   * @param {string} [opts.category]— defaults to 'data'
   * @param {Object} [opts.data]    — payload snapshot
   */
  registerVirtual(sessionId, { name, kind, source, category, data } = {}) {
    const sid = this._ensureSession(sessionId);
    if (!sid) return null;

    const artifact = {
      name: String(name || kind || 'item'),
      path: null,
      kind: kind || 'virtual',
      category: category || 'data',
      source: source || 'unknown',
      action: 'created',
      virtual: true,
      accepted: false,
      data: data || null,
      timestamp: new Date().toISOString()
    };

    const key = this._buildKey(artifact);
    const existing = this._registry.get(sid).get(key);
    if (existing) {
      existing.data = data || existing.data;
      existing.timestamp = artifact.timestamp;
    } else {
      this._registry.get(sid).set(key, artifact);
    }

    this._hidden.get(sid).delete(key);
    this._persistSession(sid);
    this._notifyUpdate(sid);
    return existing || artifact;
  }

  /**
   * Mark artifact as accepted (user wants to keep it).
   */
  acceptArtifact(sessionId, artifactKey) {
    const sid = this._ensureSession(sessionId);
    if (!sid) return false;
    const session = this._registry.get(sid);
    let artifact = session.get(artifactKey);
    if (!artifact) {
      artifact = this.listArtifacts(sid).artifacts.find(item => item.key === artifactKey) || null;
      if (artifact) {
        artifact = { ...artifact };
        session.set(artifactKey, artifact);
      }
    }
    if (!artifact) return false;
    artifact.accepted = true;
    this._persistSession(sid);
    this._notifyUpdate(sid);
    return true;
  }

  /** Accept the current generation and hide its artifacts without deleting files. */
  acceptAllArtifacts(sessionId) {
    const sid = this._ensureSession(sessionId);
    if (!sid) return 0;
    const artifacts = this.listArtifacts(sid).artifacts;
    if (!artifacts.length) return 0;
    const session = this._registry.get(sid);
    const hidden = this._hidden.get(sid);
    for (const artifact of artifacts) {
      session.delete(artifact.key);
      hidden.add(artifact.key);
    }
    this._persistSession(sid);
    this._notifyUpdate(sid);
    return artifacts.length;
  }

  getArtifact(sessionId, artifactKey) {
    const sid = this._ensureSession(sessionId);
    if (!sid) return null;
    const key = String(artifactKey || '').trim();
    const artifact = this._registry.get(sid)?.get(key) || null;
    return artifact ? { ...artifact, key } : null;
  }

  snapshotSession(sessionId) {
    const sid = this._ensureSession(sessionId);
    if (!sid) return [];
    const session = this._registry.get(sid);
    if (!session) return [];
    return Array.from(session.entries()).map(([key, artifact]) => ({ ...artifact, key }));
  }

  /**
   * Remove artifact from the list (user cleans it).
   * Does NOT delete the underlying file — just hides from UI.
   */
  cleanArtifact(sessionId, artifactKey) {
    const sid = this._ensureSession(sessionId);
    if (!sid) return false;
    const known = this.listArtifacts(sid).artifacts.some(item => item.key === artifactKey);
    if (!known) return false;
    this._registry.get(sid).delete(artifactKey);
    this._hidden.get(sid).add(artifactKey);
    this._persistSession(sid);
    this._notifyUpdate(sid);
    return true;
  }

  /**
   * List all artifacts for a session.
   * Merges registry entries with filesystem scan of workspace.
   *
   * @param {string} sessionId
   * @param {Object} [options]
   * @param {string} [options.category] - filter by category
   * @param {string} [options.search] - filter by name substring
   * @param {boolean} [options.openableOnly] - only include non-virtual, non-deleted files the UI can open
   * @returns {{ artifacts: Array, count: number }}
   */
  listArtifacts(sessionId, { category, search, openableOnly = false } = {}) {
    const sid = this._ensureSession(sessionId);
    if (!sid) return { artifacts: [], count: 0 };

    const merged = new Map();

    // 1. Scan workspace filesystem (legacy source)
    if (this._sessionWorkspace?.listFiles) {
      try {
        const files = this._sessionWorkspace.listFiles(sid);
        for (const file of files) {
          const resolvedKind = kindFromExt(file.name);
          const key = `file:${path.resolve(file.path)}`;
          merged.set(key, {
            key,
            name: file.name,
            path: file.path,
            kind: resolvedKind,
            category: resolvedKind === 'text' && file.name.endsWith('.log') ? 'log' : categoryFromKind(resolvedKind),
            source: 'workspace',
            action: 'created',
            virtual: false,
            accepted: false,
            size: file.size,
            timestamp: file.created ? new Date(file.created).toISOString() : new Date().toISOString()
          });
        }
      } catch (_) { /* workspace scan failed, skip */ }
    }

    // 2. Overlay registry entries (may override workspace entries)
    const session = this._registry.get(sid);
    if (session) {
      for (const [key, artifact] of session) {
        if (merged.has(key)) {
          // Registry entry takes precedence for metadata
          const ws = merged.get(key);
          merged.set(key, {
            ...ws,
            ...artifact,
            key,
            size: ws.size || 0
          });
        } else {
          merged.set(key, { ...artifact, key, size: 0 });
        }
      }
    }

    // 3. Convert to array, filter, sort
    const hidden = this._hidden.get(sid) || new Set();
    let artifacts = Array.from(merged.values()).filter(artifact => !hidden.has(artifact.key));

    if (category) {
      const cat = String(category).toLowerCase();
      artifacts = artifacts.filter(a => a.category === cat);
    }

    if (search) {
      const q = String(search).toLowerCase();
      artifacts = artifacts.filter(a => a.name.toLowerCase().includes(q));
    }

    if (openableOnly) {
      artifacts = artifacts.filter(a => this._isArtifactOpenable(sid, a));
    }

    artifacts.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return {
      artifacts,
      count: artifacts.length
    };
  }

  /**
   * Get artifact count for a session (fast, no merge needed if registry is primary).
   */
  getCount(sessionId) {
    return this.listArtifacts(sessionId).count;
  }

  /**
   * Clear all registry entries for a session.
   */
  clearSession(sessionId) {
    const sid = String(sessionId || '').trim();
    if (!sid) return;
    this._loadedSessions.add(sid);
    this._registry.set(sid, new Map());
    this._hidden.set(sid, new Set());
    this._persistSession(sid);
  }
}

module.exports = ArtifactRegistry;
