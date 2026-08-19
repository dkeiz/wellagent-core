// @ts-nocheck
const fs = require('fs');
const path = require('path');
const { isPathInside, resolveBoundaryPath } = require('./path-boundary');

class PluginModuleLoader {
  load(plugin) {
    const mainPath = this.resolveMainPath(plugin);
    if (!fs.existsSync(mainPath)) {
      throw new Error(`Plugin entry point not found: ${mainPath}`);
    }
    this.clearRequireCache(plugin.dir);
    return require(mainPath);
  }

  resolveMainPath(plugin) {
    const pluginDir = path.resolve(plugin?.dir || '');
    const main = String(plugin?.manifest?.main || '').trim();
    if (!main) {
      throw new Error('Plugin manifest main entry is required');
    }
    const realPluginDir = resolveBoundaryPath(pluginDir);
    const declaredMainPath = path.resolve(pluginDir, main);
    const mainPath = resolveBoundaryPath(declaredMainPath);
    if (!isPathInside(realPluginDir, mainPath)) {
      throw new Error(`Plugin entry point must stay inside plugin directory: ${main}`);
    }
    return mainPath;
  }

  clearRequireCache(pluginDir) {
    const isWin = process.platform === 'win32';
    const roots = Array.from(new Set([
      path.resolve(pluginDir),
      resolveBoundaryPath(pluginDir)
    ]));
    const normalizedRoots = roots.map(root => ({
      exact: process.platform === 'win32' ? root.toLowerCase() : root,
      prefix: process.platform === 'win32'
        ? `${root}${path.sep}`.toLowerCase()
        : `${root}${path.sep}`
    }));

    for (const cachedPath of Object.keys(require.cache)) {
      const resolvedPath = path.resolve(cachedPath);
      const probe = isWin ? resolvedPath.toLowerCase() : resolvedPath;
      if (normalizedRoots.some(root => probe === root.exact || probe.startsWith(root.prefix))) {
        delete require.cache[cachedPath];
      }
    }
  }
}

module.exports = {
  PluginModuleLoader,
  isPathInside
};
