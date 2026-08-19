// @ts-nocheck
const fs = require('fs');
const path = require('path');

function hasProjectMarkers(candidate) {
  return fs.existsSync(path.join(candidate, 'package.json'))
    && fs.existsSync(path.join(candidate, 'agentin'));
}

function resolveProjectRoot(startDir = __dirname) {
  const cwd = process.cwd();
  if (cwd && hasProjectMarkers(cwd)) {
    return cwd;
  }

  let current = path.resolve(startDir);
  while (true) {
    if (hasProjectMarkers(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return path.resolve(startDir, '..', '..');
}

function resolveProjectPath(startDir, ...parts) {
  return path.join(resolveProjectRoot(startDir), ...parts);
}

module.exports = {
  resolveProjectPath,
  resolveProjectRoot
};
