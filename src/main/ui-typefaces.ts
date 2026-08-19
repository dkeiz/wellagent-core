// @ts-nocheck
const fs = require('fs');
const path = require('path');

const DEFAULT_TYPEFACES = Object.freeze([
  {
    id: 'current',
    label: 'Current UI',
    family: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
  },
  {
    id: 'terminal',
    label: 'Terminal',
    family: '"Consolas", "Monaco", "Courier New", monospace'
  }
]);

function cleanFontFamily(value) {
  return String(value || '')
    .replace(/[;\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTypefaceEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const id = String(entry.id || '').trim();
  const family = cleanFontFamily(entry.family);
  if (!id || !family) return null;
  return {
    id,
    label: String(entry.label || id).trim() || id,
    family
  };
}

function expandKeyedTypefaces(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  return Object.entries(payload)
    .filter(([key]) => !['version', 'typefaces'].includes(key))
    .map(([id, value]) => {
      if (typeof value === 'string') return { id, label: id, family: value };
      if (value && typeof value === 'object') return { id, ...value };
      return null;
    });
}

function normalizeTypefaceList(payload) {
  const rawEntries = Array.isArray(payload)
    ? payload
    : [
        ...(Array.isArray(payload?.typefaces) ? payload.typefaces : []),
        ...expandKeyedTypefaces(payload)
      ];
  const seen = new Set();
  const output = [];
  for (const raw of rawEntries) {
    const entry = normalizeTypefaceEntry(raw);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    output.push(entry);
  }
  return output.length ? output : DEFAULT_TYPEFACES.map(entry => ({ ...entry }));
}

function resolveTypefaceListPath(runtimePaths = {}) {
  return runtimePaths.typefacesFile || path.join(runtimePaths.agentinRoot || process.cwd(), 'ui', 'typefaces.json');
}

function readTypefaceList(runtimePaths = {}) {
  const typefacePath = resolveTypefaceListPath(runtimePaths);
  try {
    const payload = JSON.parse(fs.readFileSync(typefacePath, 'utf8'));
    return {
      success: true,
      source: 'file',
      typefacePath,
      typefaces: normalizeTypefaceList(payload)
    };
  } catch (error) {
    return {
      success: true,
      source: 'fallback',
      typefacePath,
      error: error.message,
      typefaces: DEFAULT_TYPEFACES.map(entry => ({ ...entry }))
    };
  }
}

module.exports = {
  DEFAULT_TYPEFACES,
  normalizeTypefaceList,
  readTypefaceList,
  resolveTypefaceListPath
};
