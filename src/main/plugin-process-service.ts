// @ts-nocheck
const ACTIVE_PLUGIN_PROCESS_SERVICES = new Set();
let HOOKS_INSTALLED = false;
let EXIT_IN_PROGRESS = false;

class PluginProcessService {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.plugins = options.plugins || null;
    ACTIVE_PLUGIN_PROCESS_SERVICES.add(this);
    this.installEmergencyHooks();
  }

  register(plugin, proc, metadata = {}) {
    if (!plugin || !proc || typeof proc.kill !== 'function') {
      return () => {};
    }

    const entry = { proc, metadata };
    plugin.managedProcesses = plugin.managedProcesses || new Set();
    plugin.managedProcesses.add(entry);

    const cleanup = () => {
      plugin.managedProcesses.delete(entry);
    };

    if (typeof proc.once === 'function') {
      proc.once('exit', cleanup);
    }

    return cleanup;
  }

  terminatePlugin(plugin, reason = '') {
    const tracked = Array.from(plugin?.managedProcesses || []);
    plugin?.managedProcesses?.clear();
    for (const entry of tracked) {
      this.terminate(entry.proc, reason, entry.metadata);
    }
  }

  terminate(proc, reason = '', metadata = {}) {
    if (!proc || typeof proc.kill !== 'function') return;
    const label = metadata?.name ? `${metadata.name}` : 'managed-process';
    try {
      proc.kill('SIGTERM');
    } catch (_) {}
    try {
      proc.kill('SIGKILL');
    } catch (_) {}
    if (reason) {
      this.logger.log?.(`[PluginProcessService] Forced stop ${label} (${reason})`);
    }
  }

  terminateAll(reason = 'emergency-exit') {
    const plugins = this.plugins instanceof Map ? this.plugins.values() : [];
    for (const plugin of plugins) {
      this.terminatePlugin(plugin, reason);
    }
  }

  installEmergencyHooks() {
    if (HOOKS_INSTALLED) return;
    HOOKS_INSTALLED = true;

    const runEmergencyStop = (reason) => {
      if (EXIT_IN_PROGRESS) return;
      EXIT_IN_PROGRESS = true;
      for (const service of ACTIVE_PLUGIN_PROCESS_SERVICES) {
        try {
          service.terminateAll(reason);
        } catch (error) {
          service.logger.error?.('[PluginProcessService] Emergency cleanup failed:', error.message);
        }
      }
    };

    process.on('exit', () => {
      runEmergencyStop('process-exit');
    });

    for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
      process.on(signal, () => {
        runEmergencyStop(`signal:${signal}`);
        process.exit(0);
      });
    }
  }
}

module.exports = PluginProcessService;
