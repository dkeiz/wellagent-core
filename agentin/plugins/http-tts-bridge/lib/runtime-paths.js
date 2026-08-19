'use strict';

const fs = require('fs');
const path = require('path');

function getElectronApp() {
  try {
    const electron = require('electron');
    if (electron && typeof electron === 'object' && electron.app) {
      return electron.app;
    }
  } catch (_) {}
  return null;
}

function isPackagedPlugin(pluginDir) {
  const app = getElectronApp();
  if (app && typeof app.isPackaged === 'boolean') {
    return app.isPackaged;
  }
  const resourcesPath = String(process.resourcesPath || '').trim().toLowerCase();
  const probe = String(pluginDir || '').trim().toLowerCase();
  return Boolean(resourcesPath && probe.includes(resourcesPath));
}

function getRuntimeRoot(pluginId, pluginDir) {
  const app = getElectronApp();
  if (isPackagedPlugin(pluginDir) && app && typeof app.getPath === 'function') {
    return path.join(app.getPath('userData'), 'plugins', pluginId);
  }
  return path.join(pluginDir, 'runtime');
}

function buildRuntimePaths(pluginId, pluginDir) {
  const runtimeRoot = getRuntimeRoot(pluginId, pluginDir);
  return {
    pluginDir,
    backendDir: path.join(pluginDir, 'python_backend'),
    runtimeRoot,
    logsDir: path.join(runtimeRoot, 'logs'),
    modelsDir: path.join(runtimeRoot, 'models'),
    piperDir: path.join(runtimeRoot, 'models', 'piper'),
    voicesDir: path.join(runtimeRoot, 'voices'),
    outputDir: path.join(runtimeRoot, 'output'),
    uploadsDir: path.join(runtimeRoot, 'uploads'),
    hfCacheDir: path.join(runtimeRoot, '.hf_cache')
  };
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function ensureRuntimePaths(paths) {
  [
    paths.runtimeRoot,
    paths.logsDir,
    paths.modelsDir,
    paths.piperDir,
    paths.voicesDir,
    paths.outputDir,
    paths.uploadsDir,
    paths.hfCacheDir
  ].forEach(ensureDir);
}

module.exports = {
  buildRuntimePaths,
  ensureRuntimePaths,
  getElectronApp
};
