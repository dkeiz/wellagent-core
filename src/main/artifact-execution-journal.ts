// @ts-nocheck
const fs = require('fs');
const path = require('path');

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'memory', 'config']);
const IGNORED_FILES = new Set(['book-writer-state.json', '_project.json']);

function normalizeRoots(agentInfo = {}) {
  const home = String(agentInfo?.folderPath || '').trim();
  if (!home) return [];
  return ['tasks', 'outputs'].map(name => path.resolve(home, name));
}

function shouldExpose(filePath) {
  const name = path.basename(filePath);
  if (IGNORED_FILES.has(name)) return false;
  if (name.startsWith('.') || name.startsWith('_') || name.endsWith('.tmp')) return false;
  if (/(?:^|-)state\.json$/i.test(name)) return false;
  return true;
}

function snapshotRoots(roots = []) {
  const snapshot = new Map();
  const pending = roots.slice();
  let visited = 0;
  while (pending.length && visited < 5000) {
    const current = pending.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      if (visited >= 5000) break;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) pending.push(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      visited += 1;
      try {
        const stat = fs.statSync(entryPath);
        snapshot.set(path.resolve(entryPath), { size: stat.size, mtimeMs: stat.mtimeMs });
      } catch (_) {}
    }
  }
  return snapshot;
}

function diffSnapshots(before, after) {
  const changes = [];
  for (const [filePath, next] of after) {
    if (!shouldExpose(filePath)) continue;
    const previous = before.get(filePath);
    if (!previous) {
      changes.push({ path: filePath, action: 'created' });
    } else if (previous.size !== next.size || previous.mtimeMs !== next.mtimeMs) {
      changes.push({ path: filePath, action: 'edited' });
    }
  }
  return changes;
}

function mergeArtifactResult(result, artifacts) {
  if (!artifacts.length || !result || typeof result !== 'object' || Array.isArray(result)) return result;
  const declared = Array.isArray(result.artifacts) ? result.artifacts : [];
  const byPath = new Map();
  for (const artifact of [...declared, ...artifacts]) {
    const key = artifact?.path ? path.resolve(String(artifact.path)) : JSON.stringify(artifact);
    byPath.set(key, artifact);
  }
  const merged = Array.from(byPath.values());
  return {
    ...result,
    artifacts: merged,
    artifactNotice: `${merged.length} agent-owned artifact${merged.length === 1 ? '' : 's'} created or updated and shown in the Artifacts list.`
  };
}

class ArtifactExecutionJournal {
  constructor(artifactRegistry = null) {
    this.artifactRegistry = artifactRegistry;
  }

  async run({ agentInfo, sessionId, source = 'plugin' } = {}, handler) {
    const roots = normalizeRoots(agentInfo);
    if (!sessionId || !this.artifactRegistry?.registerFile) {
      return handler();
    }
    const registryBefore = new Map(
      (this.artifactRegistry.snapshotSession?.(String(sessionId)) || []).map(artifact => [artifact.key, artifact])
    );
    const before = snapshotRoots(roots);
    const startedAt = Date.now();
    let result;
    let handlerError = null;
    try {
      result = await handler();
    } catch (error) {
      handlerError = error;
    }
    const after = snapshotRoots(roots);
    diffSnapshots(before, after).forEach(change => {
      const artifactKey = `file:${path.resolve(change.path)}`;
      const current = this.artifactRegistry.getArtifact?.(String(sessionId), artifactKey) || null;
      const registeredDuringExecution = current && Date.parse(current.timestamp || '') >= startedAt;
      if (!registeredDuringExecution) this.artifactRegistry.registerFile(String(sessionId), {
          name: path.basename(change.path),
          path: change.path,
          source,
          action: change.action
        });
    });
    const artifacts = (this.artifactRegistry.snapshotSession?.(String(sessionId)) || [])
      .filter(artifact => {
        const previous = registryBefore.get(artifact.key);
        return !previous
          || previous.timestamp !== artifact.timestamp
          || previous.action !== artifact.action
          || previous.source !== artifact.source;
      })
      .map(artifact => ({
        key: artifact.key,
        name: artifact.name,
        path: artifact.path,
        kind: artifact.kind || null,
        category: artifact.category || null,
        source: artifact.source || source,
        action: artifact.action || 'created'
      }));
    if (handlerError) throw handlerError;
    return mergeArtifactResult(result, artifacts);
  }
}

module.exports = {
  ArtifactExecutionJournal,
  diffSnapshots,
  mergeArtifactResult,
  normalizeRoots,
  snapshotRoots
};
