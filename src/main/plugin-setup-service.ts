// @ts-nocheck
const fs = require('fs');
const path = require('path');
const { buildRuntimePaths } = require('./runtime-paths');

function normalizePluginName(rawName = '') {
  return String(rawName || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function isSearxngAlias(name) {
  const normalized = normalizePluginName(name);
  return normalized === 'searxng' || normalized === 'searx' || normalized === 'search';
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function writeIfMissing(filePath, content) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content, 'utf-8');
  }
}

function writeManagedFile(filePath, content, markers = []) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content, 'utf-8');
    return;
  }

  const current = fs.readFileSync(filePath, 'utf-8');
  const isManaged = markers.some((marker) => current.includes(marker));
  if (isManaged) {
    fs.writeFileSync(filePath, content, 'utf-8');
  }
}

function getBundledSearxngPath(fileName) {
  return path.join(buildRuntimePaths().bundledAgentinRoot, 'plugins', 'searxng-search', fileName);
}

function searxngManifest() {
  const manifestPath = getBundledSearxngPath('plugin.json');
  if (fs.existsSync(manifestPath)) {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  }

  return {
    id: 'searxng-search',
    name: 'SearXNG Search',
    version: '1.0.0',
    description: 'SearXNG search plugin with optional local personal proxy server, discovery, and search',
    main: 'main.js',
    configSchema: {
      baseUrl: { type: 'string', description: 'SearXNG base URL (e.g. https://searx.be)' },
      enableLocalServer: { type: 'boolean', description: 'Enable local Node personal proxy server for this plugin' },
      localServerHost: { type: 'string', description: 'Host for local proxy server (usually 127.0.0.1)' },
      localServerPort: { type: 'number', description: 'Port for local proxy server (0 for auto)' },
      discoveryUrls: { type: 'string', description: 'Comma-separated SearXNG base URLs for discovery probes' },
      timeoutMs: { type: 'number', description: 'HTTP timeout in milliseconds' },
      retryCount: { type: 'number', description: 'Retry count for transient HTTP failures' },
      defaultLanguage: { type: 'string', description: 'Default language code' },
      defaultSafeSearch: { type: 'number', description: 'Safe-search level (0/1/2)' },
      defaultMaxResults: { type: 'number', description: 'Default max results' }
    }
  };
}

function searxngMainTemplate() {
  const mainPath = getBundledSearxngPath('main.js');
  if (fs.existsSync(mainPath)) {
    return fs.readFileSync(mainPath, 'utf-8');
  }

  return `'use strict';
// scaffold-managed:searxng-search
module.exports = {
  async onEnable(context) {
    context.log('SearXNG plugin placeholder enabled');
  }
};`;
}

function ensureSearxngPlugin(pluginsDir) {
  const pluginDir = path.join(pluginsDir, 'searxng-search');
  ensureDir(pluginDir);

  const manifestPath = path.join(pluginDir, 'plugin.json');
  const mainPath = path.join(pluginDir, 'main.js');
  const readmePath = path.join(pluginDir, 'README.md');

  writeIfMissing(manifestPath, JSON.stringify(searxngManifest(), null, 2));
  writeManagedFile(mainPath, searxngMainTemplate(), [
    'scaffold-managed:searxng-search',
    'LocalAgent-SearXNG-Plugin/1.0'
  ]);
  writeIfMissing(
    readmePath,
    '# SearXNG Search Plugin\n\nToggle on in the Plugins panel or run `/plugin searxng`.\n'
  );

  return {
    pluginId: 'searxng-search',
    pluginDir
  };
}

async function quickSetupPlugin({ pluginName, pluginManager, pluginsDir, scopeOptions = {} }) {
  if (!isSearxngAlias(pluginName)) {
    throw new Error(`Quick setup is not available for plugin "${pluginName}" yet`);
  }

  ensureSearxngPlugin(pluginsDir);
  await pluginManager.scanPlugins();
  await pluginManager.enablePlugin('searxng-search', scopeOptions);

  return { pluginId: 'searxng-search', enabled: true };
}

module.exports = {
  normalizePluginName,
  isSearxngAlias,
  quickSetupPlugin,
  ensureSearxngPlugin
};
