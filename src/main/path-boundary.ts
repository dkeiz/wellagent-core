// @ts-nocheck
const fs = require('fs');
const path = require('path');

function realpathNative(filePath) {
  return fs.realpathSync.native
    ? fs.realpathSync.native(filePath)
    : fs.realpathSync(filePath);
}

function normalizePathForCompare(value) {
  const normalized = path.resolve(String(value || '')).replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function resolveBoundaryPath(rawPath) {
  let cursor = path.resolve(String(rawPath || ''));
  const missing = [];

  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }

  const base = fs.existsSync(cursor) ? realpathNative(cursor) : cursor;
  return path.join(base, ...missing);
}

function isPathInside(parentDir, candidatePath) {
  const parent = normalizePathForCompare(parentDir);
  const candidate = normalizePathForCompare(candidatePath);
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

module.exports = {
  isPathInside,
  normalizePathForCompare,
  resolveBoundaryPath
};
