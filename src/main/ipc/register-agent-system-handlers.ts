// @ts-nocheck
const fs = require('fs');
const path = require('path');
const { tokenizePath } = require('../path-tokens');
const { isPrivateSessionId } = require('../private-session-store');
const {
  buildCompanionUrl,
  buildNativeCompanionUrl,
  describeCompanionReachability,
  resolveEasyConnectHost
} = require('../companion-network-utils');
const { configureCompanionServer, attachCompanionRelays } = require('../companion/companion-backend-dispatch');
const CompanionAuth = require('../companion-auth');
const CompanionPermissions = require('../companion-permissions');
const CompanionApiServer = require('../companion/companion-api-server');
const { RemoteGatewayManager } = require('../companion/remote-gateway-manager');

function assertInside(baseDir, targetPath) {
  const base = path.resolve(baseDir);
  const target = path.resolve(targetPath);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error('Requested path is outside the agent folder');
  }
  return target;
}

function listFilesRecursive(baseDir, relativeDir = '', depth = 0, maxDepth = 4) {
  const dirPath = assertInside(baseDir, path.join(baseDir, relativeDir));
  if (!fs.existsSync(dirPath) || depth > maxDepth) return [];

  return fs.readdirSync(dirPath, { withFileTypes: true })
    .filter(entry => !entry.name.startsWith('.'))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .map(entry => {
      const relativePath = path.join(relativeDir, entry.name).replace(/\\/g, '/');
      const fullPath = path.join(baseDir, relativePath);
      const stat = fs.statSync(fullPath);
      const item = {
        name: entry.name,
        relativePath,
        type: entry.isDirectory() ? 'directory' : 'file',
        size: entry.isDirectory() ? 0 : stat.size,
        modifiedAt: stat.mtime.toISOString()
      };
      if (entry.isDirectory()) {
        item.children = listFilesRecursive(baseDir, relativePath, depth + 1, maxDepth);
      }
      return item;
    });
}

async function getAgentUiInfo(agentManager, agentId, options = {}) {
  const agent = await agentManager.getAgent(agentId, options);
  if (!agent) return null;
  const folderPath = await agentManager.resolveAgentFolder(agentId, options);
  const slug = agentManager._getSafeFolderName(agent.name);
  return { ...agent, slug, folderPath };
}

async function toPortableAgentPath(agentManager, agentId, absolutePath, options = {}) {
  return tokenizePath(absolutePath, {
    agentManager,
    sessionWorkspace: agentManager?.sessionWorkspace || null,
    context: { agentId, requestContext: options.requestContext || null }
  });
}

function parseAgentConfig(raw) {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function parseCompanionDevices(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function fallbackTlsStatus() {
  return {
    enabled: false,
    supported: false,
    ready: false,
    securePort: null,
    setupRequired: false,
    caFingerprint: '',
    warning: '',
    error: ''
  };
}

function buildAndroidBrowserHttpsPayload(network, tlsStatus, port, secureNetwork, bootstrapNetwork, companionServer) {
  const effectiveWarning = tlsStatus.warning
    || tlsStatus.error
    || ((tlsStatus.enabled && !companionServer?.secureServer) ? companionServer?.lastTlsError || '' : '');
  if (!tlsStatus.enabled) {
    return {
      enabled: false,
      supported: tlsStatus.supported,
      ready: false,
      running: false,
      securePort: tlsStatus.securePort,
      setupRequired: false,
      caFingerprint: '',
      preferredBootstrapUrl: '',
      preferredSecureUrl: '',
      caDownloadUrl: '',
      warning: effectiveWarning
    };
  }

  const preferredHost = bootstrapNetwork?.preferredHost || network.preferredHost || '';
  return {
    enabled: true,
    supported: tlsStatus.supported,
    ready: tlsStatus.ready,
    running: Boolean(companionServer?.secureServer),
    securePort: tlsStatus.securePort,
    setupRequired: tlsStatus.setupRequired === true,
    caFingerprint: tlsStatus.caFingerprint || '',
    serverFingerprint: tlsStatus.serverFingerprint || '',
    certificateHosts: tlsStatus.certificateHosts || [],
    missingHosts: tlsStatus.missingHosts || [],
    preferredBootstrapUrl: bootstrapNetwork?.preferredBrowserUrl || '',
    preferredSecureUrl: secureNetwork?.preferredBrowserUrl || '',
    caDownloadUrl: preferredHost
      ? buildCompanionUrl(preferredHost, port, { pathname: '/companion/bootstrap/ca.crt' })
      : '',
    warning: effectiveWarning
  };
}

async function getCompanionStatusPayload(db, companionServer, companionTlsManager, options = {}) {
  const readSetting = async (key, fallback = '') => {
    if (db?.getScopedSetting && options && typeof options === 'object' && (options.requestContext || options.userId)) {
      const value = await db.getScopedSetting(key, options);
      return value == null || value === '' ? fallback : value;
    }
    const value = await db.getSetting(key);
    return value == null || value === '' ? fallback : value;
  };

  const enabled = (await readSetting('companion.enabled')) === 'true';
  const host = await readSetting('companion.host', '0.0.0.0');
  const port = Number(await readSetting('companion.port', '8790')) || 8790;
  const storedDevices = parseCompanionDevices(await readSetting('companion.devices', ''));
  const network = describeCompanionReachability(host, port);
  let tlsStatus = fallbackTlsStatus();

  if (companionTlsManager?.getStatus) {
    try {
      tlsStatus = await companionTlsManager.getStatus({ bindHost: host, httpPort: port });
    } catch (error) {
      tlsStatus = { ...fallbackTlsStatus(), error: error.message, warning: error.message };
    }
  }

  const bootstrapNetwork = tlsStatus.enabled
    ? describeCompanionReachability(host, port, { pathname: '/companion/bootstrap' })
    : null;
  const secureNetwork = tlsStatus.enabled && tlsStatus.securePort
    ? describeCompanionReachability(host, tlsStatus.securePort, {
      scheme: 'https',
      pathname: '/companion/web'
    })
    : null;
  const androidBrowserHttps = buildAndroidBrowserHttpsPayload(
    network,
    tlsStatus,
    port,
    secureNetwork,
    bootstrapNetwork,
    companionServer
  );
  const warning = [network.warning, androidBrowserHttps.warning].filter(Boolean).join(' ');
  const running = enabled && Boolean(companionServer?.server);

  return {
    enabled,
    running,
    host,
    port,
    pairedDevices: enabled ? storedDevices.length : 0,
    connectedDevices: running ? (companionServer?._wsClients?.size || 0) + (companionServer?._remoteWsClients?.size || 0) : 0,
    preferredBrowserUrl: androidBrowserHttps.enabled
      ? androidBrowserHttps.preferredBootstrapUrl
      : network.preferredBrowserUrl,
    nativeAppUrl: network.preferredHost
      ? buildNativeCompanionUrl(
        network.preferredHost,
        androidBrowserHttps.running && androidBrowserHttps.securePort ? androidBrowserHttps.securePort : port,
        { useTls: androidBrowserHttps.running === true }
      )
      : '',
    browserUrls: androidBrowserHttps.enabled
      ? (bootstrapNetwork?.browserUrls || network.browserUrls)
      : network.browserUrls,
    reachableHosts: network.reachableHosts,
    preferredHost: network.preferredHost,
    accessMode: network.accessMode,
    warning,
    androidBrowserHttps
  };
}
function registerAgentSystemHandlers(ipcMain, runtime, helpers) {
  const {
    mcpServer,
    windowManager,
    aiService,
    portListenerManager,
    agentMemory,
    agentLoop,
    agentBundleLoader,
    connectorRuntime,
    a2aManager,
    agentManager,
    pluginManager,
    eventBus,
    chainController,
    memoryDaemon,
    workflowScheduler,
    sessionInitManager,
    localShardProcessManager,
    shardRegistry,
    shardSupervisor,
    db,
    testClientMode,
    toolPermissionService
  } = runtime;
  const { syncDaemonEnabledSetting } = helpers;

  function buildScopeOptions(event) {
    return { requestContext: event?.requestContext || null };
  }

  const shardHostState = {
    activeRuns: 0,
    deployments: new Map(),
    importedBundles: new Map()
  };

  async function readScopedSetting(key, scopeOptions = {}, fallback = null) {
    if (db?.getScopedSetting && scopeOptions && (scopeOptions.requestContext || scopeOptions.userId)) {
      const value = await db.getScopedSetting(key, scopeOptions);
      return value == null || value === '' ? fallback : value;
    }
    const value = await db.getSetting(key);
    return value == null || value === '' ? fallback : value;
  }

  async function writeScopedSetting(key, value, scopeOptions = {}) {
    if (db?.saveScopedSetting && scopeOptions && (scopeOptions.requestContext || scopeOptions.userId)) {
      return db.saveScopedSetting(key, value, scopeOptions);
    }
    return db.saveSetting(key, value);
  }

  ipcMain.handle('port-listener:register', async (event, config, options = {}) => {
    if (!portListenerManager) return { error: 'PortListenerManager not initialized' };
    try {
      const result = await portListenerManager.register(config);
      windowManager.send('port-listener-update', portListenerManager.getListeners());
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('port-listener:unregister', async (event, port, options = {}) => {
    if (!portListenerManager) return { error: 'PortListenerManager not initialized' };
    try {
      const result = await portListenerManager.unregister(port);
      windowManager.send('port-listener-update', portListenerManager.getListeners());
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('port-listener:list', async () => {
    if (!portListenerManager) return [];
    return portListenerManager.getListeners();
  });

  ipcMain.handle('agent-memory:append', async (event, type, content, filename, options = {}) => {
    if (!agentMemory) return { error: 'AgentMemory not initialized' };
    try {
      return await agentMemory.append(type, content, filename);
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('agent-memory:read', async (event, type, filename) => {
    if (!agentMemory) return { error: 'AgentMemory not initialized' };
    try {
      return await agentMemory.read(type, filename);
    } catch (error) {
      return { exists: false, error: error.message };
    }
  });

  ipcMain.handle('agent-memory:list', async (event, type) => {
    if (!agentMemory) return [];
    try {
      return await agentMemory.list(type);
    } catch (error) {
      return [];
    }
  });

  ipcMain.handle('agent-memory:stats', async () => {
    if (!agentMemory) return {};
    return agentMemory.getStats();
  });

  ipcMain.handle('agent-memory:save-image', async (event, imageBuffer, name, options = {}) => {
    if (!agentMemory) return { error: 'AgentMemory not initialized' };
    try {
      return await agentMemory.saveImage(Buffer.from(imageBuffer), name);
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  mcpServer.on('calendar-update', () => {
    windowManager.send('calendar-update');
  });

  mcpServer.on('todo-update', () => {
    windowManager.send('todo-update');
  });

  mcpServer.on('tool-executed', (eventData) => {
    windowManager.send('tool-update', eventData);
  });

  mcpServer.on('execution-context-updated', (context) => {
    windowManager.send('execution-context-updated', context);
  });

  ipcMain.handle('agent-loop:memory-start', async (event, sessionId) => {
    if (!agentLoop) return null;
    if (isPrivateSessionId(sessionId)) return null;
    return agentLoop.loadMemoryContext(sessionId, buildScopeOptions(event));
  });

  ipcMain.handle('agent-loop:get-state', async (event, sessionId) => {
    if (!agentLoop) return { autoMemory: false };
    const session = agentLoop.getSession(sessionId);
    return { autoMemory: session.autoMemory, idleSeconds: session.idleSeconds };
  });

  ipcMain.handle('connectors:list', async (event) => {
    if (!connectorRuntime) return [];
    return connectorRuntime.listConnectors(buildScopeOptions(event));
  });

  ipcMain.handle('connectors:start', async (event, name, options = {}) => {
    if (!connectorRuntime) return { error: 'Connector runtime not initialized' };
    return connectorRuntime.startConnector(name, buildScopeOptions(event));
  });

  ipcMain.handle('connectors:stop', async (event, name, options = {}) => {
    if (!connectorRuntime) return { error: 'Connector runtime not initialized' };
    return connectorRuntime.stopConnector(name, buildScopeOptions(event));
  });

  ipcMain.handle('connectors:logs', async (event, name, limit) => {
    if (!connectorRuntime) return [];
    return connectorRuntime.getLogs(name, limit, buildScopeOptions(event));
  });

  ipcMain.handle('connectors:delete', async (event, name, options = {}) => {
    if (!connectorRuntime) return { error: 'Connector runtime not initialized' };
    try { await connectorRuntime.stopConnector(name, buildScopeOptions(event)); } catch (e) {}
    const filePath = path.join(connectorRuntime.connectorsDir, `${name}.js`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return { success: true, name };
  });

  ipcMain.handle('a2a:get-status', async () => {
    if (!a2aManager) return { error: 'A2AManager not initialized' };
    return a2aManager.getExposureStatus();
  });

  ipcMain.handle('a2a:set-exposure', async (event, enabled, options = {}) => {
    if (!a2aManager) return { error: 'A2AManager not initialized' };
    return a2aManager.setExposureEnabled(enabled === true);
  });

  ipcMain.handle('a2a:list-targets', async () => {
    if (!a2aManager) return [];
    return a2aManager.listTargets();
  });

  ipcMain.handle('a2a:describe-target', async (event, targetId) => {
    if (!a2aManager) return { error: 'A2AManager not initialized' };
    try {
      return await a2aManager.describeTarget(targetId);
    } catch (error) {
      return { error: error.message };
    }
  });

  ipcMain.handle('get-agents', async (event, type = null) => {
    if (!agentManager) return [];
    return agentManager.getAgents(type, buildScopeOptions(event));
  });

  ipcMain.handle('get-agent', async (event, id) => {
    if (!agentManager) return null;
    return agentManager.getAgent(id, buildScopeOptions(event));
  });

  ipcMain.handle('create-agent', async (event, data, options = {}) => {
    if (!agentManager) throw new Error('AgentManager not initialized');
    const result = await agentManager.createAgent(data, buildScopeOptions(event));
    windowManager.send('agent-update');
    return result;
  });

  ipcMain.handle('agents:create-sharded', async (event, input = {}) => {
    if (!localShardProcessManager) throw new Error('Local shard manager not initialized');
    const result = await localShardProcessManager.createShardedAgent(input, buildScopeOptions(event));
    windowManager.send('agent-update');
    return result;
  });

  ipcMain.handle('agents:list-shards', async (event) => {
    if (!localShardProcessManager) return [];
    return localShardProcessManager.listRuntimes(buildScopeOptions(event));
  });

  ipcMain.handle('agents:get-shard-status', async (event, agentId) => {
    if (!localShardProcessManager) throw new Error('Local shard manager not initialized');
    return localShardProcessManager.getStatus(agentId, buildScopeOptions(event));
  });

  ipcMain.handle('agents:start-shard', async (event, agentId, input = {}) => {
    if (!localShardProcessManager) throw new Error('Local shard manager not initialized');
    return localShardProcessManager.startForAgent(agentId, { ...buildScopeOptions(event), ...input });
  });

  ipcMain.handle('agents:stop-shard', async (event, agentId) => {
    if (!localShardProcessManager) throw new Error('Local shard manager not initialized');
    return localShardProcessManager.stopForAgent(agentId, buildScopeOptions(event));
  });

  ipcMain.handle('agents:reattach-shard', async (event, agentId) => {
    if (!localShardProcessManager) throw new Error('Local shard manager not initialized');
    return localShardProcessManager.reattachForAgent(agentId, buildScopeOptions(event));
  });

  ipcMain.handle('agents:restart-shard', async (event, agentId, input = {}) => {
    if (!localShardProcessManager) throw new Error('Local shard manager not initialized');
    return localShardProcessManager.restartForAgent(agentId, { ...buildScopeOptions(event), ...input });
  });

  ipcMain.handle('agents:get-shard-logs', async (event, agentId, limit = 200) => {
    if (!localShardProcessManager) return [];
    return localShardProcessManager.collectLogs(agentId, { ...buildScopeOptions(event), limit });
  });

  ipcMain.handle('agents:get-shard-runtime-proof', async (event, agentId) => {
    if (!localShardProcessManager) throw new Error('Local shard manager not initialized');
    return localShardProcessManager.getRuntimeProof(agentId, buildScopeOptions(event));
  });

  ipcMain.handle('agents:capture-shard-window', async (event, agentId, outputPath) => {
    if (!localShardProcessManager) throw new Error('Local shard manager not initialized');
    return localShardProcessManager.captureRuntimeWindow(agentId, outputPath, buildScopeOptions(event));
  });

  ipcMain.handle('shards:register-host', async (event, record = {}) => {
    if (!shardSupervisor?.registerShard) throw new Error('Shard supervisor not initialized');
    return shardSupervisor.registerShard(record);
  });

  ipcMain.handle('shards:heartbeat', async (event, shardId, healthPatch = {}) => {
    if (!shardSupervisor?.heartbeatShard) throw new Error('Shard supervisor not initialized');
    return shardSupervisor.heartbeatShard(shardId, healthPatch);
  });

  ipcMain.handle('shards:update-deployment', async (event, deployment = {}) => {
    if (!shardRegistry?.updateDeployment) throw new Error('Shard registry not initialized');
    return shardRegistry.updateDeployment(deployment.deploymentId, deployment.patch || {});
  });

  ipcMain.handle('shards:append-log', async (event, payload = {}) => ({ success: true, ignored: true, payload }));

  ipcMain.handle('shards:deregister-host', async (event, shardId) => {
    if (!shardSupervisor?.deregisterShard) throw new Error('Shard supervisor not initialized');
    return shardSupervisor.deregisterShard(shardId);
  });

  ipcMain.handle('shard-host:deploy-bundle', async (event, payload = {}) => {
    if (!agentBundleLoader?.loadBundle) throw new Error('Agent bundle loader not initialized');
    const bundlePath = String(payload.bundlePath || '').trim();
    if (!bundlePath) throw new Error('bundlePath is required');
    const manifest = agentBundleLoader.loadBundle(bundlePath);
    const scopeOptions = buildScopeOptions(event);
    const existingAgentId = shardHostState.importedBundles.get(manifest.id) || null;
    const requestedAgentId = Number(payload.agentId);
    const residentAgent = Number.isFinite(requestedAgentId) && requestedAgentId > 0
      ? await agentManager.getAgent(requestedAgentId, scopeOptions)
      : null;
    const agentConfig = {
      plugins: Array.isArray(manifest.plugins) ? manifest.plugins : [],
      pluginConfig: manifest.pluginConfig || {},
      runtimeHints: manifest.runtimeHints || {},
      toolPolicy: manifest.toolPolicy || {}
    };
    let importedAgentId = existingAgentId || residentAgent?.id || null;
    if (importedAgentId) {
      await agentManager.updateAgent(importedAgentId, {
        config: agentConfig,
        description: manifest.description || '',
        name: manifest.name,
        system_prompt: manifest.systemPrompt,
        visible_in_sidebar: 0
      }, scopeOptions);
    } else {
      const imported = await agentBundleLoader.importBundle(bundlePath, scopeOptions);
      if (!imported?.success || !imported.agentId) {
        throw new Error(imported?.error || 'Bundle import failed');
      }
      importedAgentId = imported.agentId;
      await agentManager.updateAgent(importedAgentId, { visible_in_sidebar: 0 }, scopeOptions);
    }
    shardHostState.importedBundles.set(manifest.id, importedAgentId);
    shardHostState.deployments.set(manifest.id, {
      agentId: importedAgentId,
      bundleId: manifest.id,
      bundlePath,
      deployedAt: new Date().toISOString(),
      deploymentId: String(payload.deploymentId || '').trim() || null
    });
    return {
      success: true,
      agentId: importedAgentId,
      bundleId: manifest.id
    };
  });

  ipcMain.handle('shard-host:run-agent-turn', async (event, payload = {}) => {
    if (!chainController) throw new Error('Chain controller not initialized');
    const bundleId = String(payload.bundleId || '').trim();
    const deployment = bundleId ? shardHostState.deployments.get(bundleId) : null;
    if (!deployment?.agentId) {
      throw new Error(`Bundle is not deployed: ${bundleId || 'unknown'}`);
    }
    shardHostState.activeRuns += 1;
    try {
      const echoPrefix = String(process.env.LOCALAGENT_EXTERNAL_SHARD_ECHO_PREFIX || '').trim();
      if (echoPrefix) {
        const message = String(payload.message || '').trim();
        console.log(`[ShardHostTestEcho] ${bundleId} :: ${message}`);
        return {
          content: `${echoPrefix}${message}`,
          model: 'mock-shard-echo',
          provider: 'local-shard-echo'
        };
      }
      return await chainController.executeWithChaining(
        String(payload.message || ''),
        Array.isArray(payload.history) ? payload.history : [],
        {
          ...(payload.options || {}),
          agentId: deployment.agentId,
          requestContext: event?.requestContext || payload.options?.requestContext || null,
          sessionId: payload.sessionId || payload.options?.sessionId || null,
          skipShardDelegation: true
        }
      );
    } finally {
      shardHostState.activeRuns = Math.max(0, shardHostState.activeRuns - 1);
    }
  });

  ipcMain.handle('shard-host:get-health', async () => ({
    activeRuns: shardHostState.activeRuns,
    deployedBundles: shardHostState.deployments.size,
    heartbeatIntervalMs: 10000,
    status: 'online'
  }));

  ipcMain.handle('shard-host:collect-logs', async () => []);

  ipcMain.handle('shard-host:shutdown', async () => {
    setTimeout(() => process.exit(0), 50);
    return { success: true, shuttingDown: true };
  });

  ipcMain.handle('update-agent', async (event, id, data, options = {}) => {
    if (!agentManager) throw new Error('AgentManager not initialized');
    const result = await agentManager.updateAgent(id, data, buildScopeOptions(event));
    windowManager.send('agent-update');
    return result;
  });

  ipcMain.handle('set-agent-sidebar-visible', async (event, id, visible, options = {}) => {
    if (!agentManager) throw new Error('AgentManager not initialized');
    const result = await agentManager.setAgentSidebarVisible(id, visible === true, buildScopeOptions(event));
    windowManager.send('agent-update');
    return { success: true, ...result };
  });

  ipcMain.handle('delete-agent', async (event, id, options = {}) => {
    if (!agentManager) throw new Error('AgentManager not initialized');
    const result = await agentManager.deleteAgent(id, buildScopeOptions(event));
    if (toolPermissionService?.deleteAgentProfile) {
      await toolPermissionService.deleteAgentProfile(id);
    }
    windowManager.send('agent-update');
    return result;
  });

  ipcMain.handle('activate-agent', async (event, id, options = {}) => {
    if (!agentManager) throw new Error('AgentManager not initialized');
    const result = await agentManager.activateAgent(id, buildScopeOptions(event));
    windowManager.send('agent-update');
    return result;
  });

  ipcMain.handle('deactivate-agent', async (event, id, options = {}) => {
    if (!agentManager) throw new Error('AgentManager not initialized');
    await agentManager.deactivateAgent(id, buildScopeOptions(event));
    windowManager.send('agent-update');
    return { success: true };
  });

  ipcMain.handle('compact-agent', async (event, id, options = {}) => {
    if (!agentManager) throw new Error('AgentManager not initialized');
    await agentManager.compactAgent(id, buildScopeOptions(event));
    return { success: true };
  });

  ipcMain.handle('list-agent-files', async (event, agentId) => {
    if (!agentManager) throw new Error('AgentManager not initialized');
    const scopeOptions = buildScopeOptions(event);
    const folderPath = await agentManager.resolveAgentFolder(agentId, scopeOptions);
    if (!folderPath) return { success: false, error: 'Agent folder not found', files: [] };
    return {
      success: true,
      root: await toPortableAgentPath(agentManager, agentId, folderPath, scopeOptions),
      files: listFilesRecursive(folderPath)
    };
  });

  ipcMain.handle('read-agent-file', async (event, agentId, relativePath) => {
    if (!agentManager) throw new Error('AgentManager not initialized');
    const scopeOptions = buildScopeOptions(event);
    const folderPath = await agentManager.resolveAgentFolder(agentId, scopeOptions);
    if (!folderPath) return { success: false, error: 'Agent folder not found' };
    try {
      const filePath = assertInside(folderPath, path.join(folderPath, String(relativePath || '')));
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return { success: false, error: 'Requested path is not a file' };
      const content = fs.readFileSync(filePath, 'utf-8');
      return {
        success: true,
        relativePath: String(relativePath || ''),
        path: await toPortableAgentPath(agentManager, agentId, filePath, scopeOptions),
        content,
        size: content.length
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('get-agent-chat-ui', async (event, agentId, uiContext = {}) => {
    if (!agentManager || !pluginManager?.getAgentChatUI) return null;
    const agentInfo = await getAgentUiInfo(agentManager, agentId, buildScopeOptions(event));
    if (!agentInfo) return null;
    return pluginManager.getAgentChatUI(agentInfo, uiContext);
  });

  ipcMain.handle('run-agent-chat-ui-action', async (event, agentId, action, payload = {}, uiContext = {}) => {
    if (!agentManager || !pluginManager?.runAgentChatUIAction) {
      return { success: false, error: 'Agent chat UI actions are unavailable' };
    }
    const agentInfo = await getAgentUiInfo(agentManager, agentId, buildScopeOptions(event));
    if (!agentInfo) return { success: false, error: 'Agent not found' };
    try {
      return await pluginManager.runAgentChatUIAction(agentInfo, action, payload, uiContext);
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('agent-chat-ui-event', async (event, agentId, eventName, payload = {}, uiContext = {}) => {
    if (!agentManager || !pluginManager?.handleAgentChatUIEvent) {
      return { success: false, error: 'Agent chat UI events are unavailable' };
    }
    const agentInfo = await getAgentUiInfo(agentManager, agentId, buildScopeOptions(event));
    if (!agentInfo) return { success: false, error: 'Agent not found' };
    try {
      return await pluginManager.handleAgentChatUIEvent(agentInfo, eventName, payload, uiContext);
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('subagents:list-runs', async (event, filters = {}) => {
    if (!agentManager || typeof agentManager.listSubagentRuns !== 'function') {
      return [];
    }

    try {
      return await agentManager.listSubagentRuns({
        ...buildScopeOptions(event),
        limit: Math.max(1, Number(filters?.limit) || 50),
        status: filters?.status || null,
        parentSessionId: filters?.parentSessionId ?? null,
        subagentId: filters?.subagentId ?? null
      });
    } catch (error) {
      console.error('[IPC] Failed to list subagent runs:', error.message);
      return [];
    }
  });

  ipcMain.handle('subagents:stop-run', async (event, runId, options = {}) => {
    if (!agentManager || typeof agentManager.cancelSubagentRun !== 'function') {
      return { success: false, error: 'Subagent cancellation is unavailable' };
    }

    try {
      const cancelled = await agentManager.cancelSubagentRun(runId, 'Stopped from UI', buildScopeOptions(event));
      // Resolve the provider the subagent was actually using so we abort the correct adapter.
      const runProvider = cancelled?.run?.provider || cancelled?.run?.queue_provider || null;
      const stopped = aiService?.stopGeneration ? aiService.stopGeneration(runProvider) : false;
      if (chainController?.stopChain) {
        chainController.stopChain(runId);
      }
      console.log(`[IPC] subagents:stop-run ${runId} — cancelled=${cancelled?.success}, stopped=${stopped}, provider=${runProvider || 'default'}`);
      return { ...cancelled, stopped };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('subagents:clear-runs', async (event, filters = {}) => {
    if (!agentManager || typeof agentManager.clearSubagentRuns !== 'function') {
      return { success: false, removed: 0, kept: 0, failed: 0, error: 'Subagent cleanup is unavailable' };
    }

    try {
      return await agentManager.clearSubagentRuns({
        ...buildScopeOptions(event),
        parentSessionId: filters?.parentSessionId ?? null,
        subagentId: filters?.subagentId ?? null,
        status: filters?.status ?? null,
        onlyFinished: filters?.onlyFinished !== false,
        includeRunning: filters?.includeRunning === true,
        matchText: filters?.matchText ? String(filters.matchText) : '',
        runIds: Array.isArray(filters?.runIds) ? filters.runIds : null
      });
    } catch (error) {
      return { success: false, removed: 0, kept: 0, failed: 1, error: error.message };
    }
  });

  ipcMain.handle('subagents:close-run', async (event, runId, options = {}) => {
    if (!agentManager || typeof agentManager.closeSubagentRun !== 'function') {
      return { success: false, removed: 0, error: 'Subagent close is unavailable' };
    }

    try {
      return await agentManager.closeSubagentRun(runId, buildScopeOptions(event));
    } catch (error) {
      return { success: false, removed: 0, error: error.message };
    }
  });

  ipcMain.handle('subagents:get-run', async (event, runId) => {
    if (!agentManager || typeof agentManager.getSubagentRun !== 'function') {
      return null;
    }
    try {
      return await agentManager.getSubagentRun(runId, buildScopeOptions(event));
    } catch (error) {
      console.error('[IPC] Failed to fetch subagent run:', error.message);
      return null;
    }
  });
  ipcMain.handle('daemon:memory-start', async (event, options = {}) => {
    if (testClientMode) return { error: 'Disabled in --testclient mode' };
    if (!memoryDaemon) return { error: 'Memory daemon not initialized' };
    await memoryDaemon.start();
    await syncDaemonEnabledSetting(buildScopeOptions(event));
    return { success: true };
  });

  ipcMain.handle('daemon:memory-stop', async (event, options = {}) => {
    if (!memoryDaemon) return { error: 'Memory daemon not initialized' };
    memoryDaemon.stop();
    await syncDaemonEnabledSetting(buildScopeOptions(event));
    return { success: true };
  });

  ipcMain.handle('daemon:memory-status', async () => {
    if (!memoryDaemon) return { running: false };
    return memoryDaemon.getStatus();
  });

  ipcMain.handle('daemon:memory-run-now', async (event, options = {}) => {
    if (testClientMode) return { error: 'Disabled in --testclient mode' };
    if (!memoryDaemon) return { error: 'Memory daemon not initialized' };
    return memoryDaemon.runNow();
  });

  ipcMain.handle('daemon:workflow-start', async (event, options = {}) => {
    if (testClientMode) return { error: 'Disabled in --testclient mode' };
    if (!workflowScheduler) return { error: 'Workflow scheduler not initialized' };
    await workflowScheduler.start();
    await syncDaemonEnabledSetting(buildScopeOptions(event));
    return { success: true };
  });

  ipcMain.handle('daemon:workflow-stop', async (event, options = {}) => {
    if (!workflowScheduler) return { error: 'Workflow scheduler not initialized' };
    workflowScheduler.stop();
    await syncDaemonEnabledSetting(buildScopeOptions(event));
    return { success: true };
  });

  ipcMain.handle('daemon:workflow-status', async () => {
    if (!workflowScheduler) return { running: false };
    return workflowScheduler.getStatus();
  });

  ipcMain.handle('daemon:add-schedule', async (event, workflowId, intervalMinutes, name, options = {}) => {
    if (testClientMode) return { error: 'Disabled in --testclient mode' };
    if (!workflowScheduler) return { error: 'Workflow scheduler not initialized' };
    return workflowScheduler.addSchedule(workflowId, intervalMinutes, name);
  });

  ipcMain.handle('daemon:remove-schedule', async (event, scheduleId, options = {}) => {
    if (!workflowScheduler) return { error: 'Workflow scheduler not initialized' };
    return workflowScheduler.removeSchedule(scheduleId);
  });

  ipcMain.handle('daemon:toggle-schedule', async (event, scheduleId, enabled, options = {}) => {
    if (!workflowScheduler) return { error: 'Workflow scheduler not initialized' };
    return workflowScheduler.toggleSchedule(scheduleId, enabled);
  });

  ipcMain.handle('daemon:get-schedules', async () => {
    if (!workflowScheduler) return [];
    return workflowScheduler._getAllSchedules();
  });

  ipcMain.handle('session-init:detect', async (event) => {
    if (!sessionInitManager) return { isColdStart: false };
    const daemonRunning = memoryDaemon ? memoryDaemon.running : false;
    return sessionInitManager.detectStartType(daemonRunning, buildScopeOptions(event));
  });

  ipcMain.handle('session-init:cold-start-prompt', async (event, hoursInactive) => {
    if (!sessionInitManager) return null;
    return sessionInitManager.buildColdStartPrompt(hoursInactive, buildScopeOptions(event));
  });

  ipcMain.handle('baseinit:check', async (event) => {
    if (sessionInitManager?.getBaseInitState) {
      const state = await sessionInitManager.getBaseInitState(buildScopeOptions(event));
      return { completed: state.completed === true, timestamp: state.timestamp || '' };
    }
    const completed = sessionInitManager?.getScopedSetting
      ? await sessionInitManager.getScopedSetting('baseinit.completed', buildScopeOptions(event))
      : await readScopedSetting('baseinit.completed', buildScopeOptions(event));
    return { completed: completed === 'true' };
  });

  ipcMain.handle('baseinit:run', async (event, options = {}) => {
    if (!sessionInitManager) return { error: 'SessionInitManager not initialized' };

    try {
      const scopeOptions = buildScopeOptions(event);
      const report = await sessionInitManager.buildBaseInitReport(scopeOptions);
      if (memoryDaemon && !memoryDaemon.running) {
        await memoryDaemon.start();
      }
      if (workflowScheduler && !workflowScheduler.running) {
        await workflowScheduler.start();
      }
      if (sessionInitManager?.markBaseInitComplete) {
        await sessionInitManager.markBaseInitComplete(scopeOptions);
      } else if (sessionInitManager?.saveScopedSetting) {
        await sessionInitManager.saveScopedSetting('baseinit.completed', 'true', scopeOptions);
        await sessionInitManager.saveScopedSetting('baseinit.timestamp', new Date().toISOString(), scopeOptions);
        await sessionInitManager.saveScopedSetting('baseinit.daemonEnabled', 'true', scopeOptions);
      } else {
        await writeScopedSetting('baseinit.completed', 'true', scopeOptions);
        await writeScopedSetting('baseinit.timestamp', new Date().toISOString(), scopeOptions);
        await writeScopedSetting('baseinit.daemonEnabled', 'true', scopeOptions);
      }

      if (eventBus) {
        eventBus.publish('init:baseinit-complete', { report });
      }
      return { success: true, report };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('eventbus:get-log', async (event, category, limit) => {
    if (!eventBus) return [];
    return eventBus.getLog(category, limit);
  });

  // ── Companion Management ───────────────────────────────────────────────

  // Desktop owns companion lifecycle because the renderer settings UI talks to
  // Electron IPC. The HTTP companion server itself stays a transport object and
  // does not construct app services.
  function getCompanionTlsManager() {
    return runtime.companionTlsManager || runtime.container?.optional?.('companionTlsManager') || null;
  }

  function getCompanionServer() {
    return runtime.container?.optional?.('companionServer');
  }

  function getRemoteGatewayManager() {
    let manager = runtime.container?.optional?.('remoteGatewayManager');
    if (!manager) {
      manager = new RemoteGatewayManager({
        db,
        getCompanionServer
      });
      runtime.container?.register?.('remoteGatewayManager', manager);
    }
    const server = getCompanionServer();
    if (server?.setRemoteGatewayManager) server.setRemoteGatewayManager(manager);
    return manager;
  }

  function getCompanionAuth() {
    // CompanionAuth may be used by desktop IPC and HTTP dispatch at different
    // times, so persisted settings are the shared state, not object identity.
    const existing = runtime.container?.optional?.('companionAuth');
    if (existing) return existing;
    const auth = new CompanionAuth(db, { userRegistry: runtime.container?.optional?.('userRegistry') || null });
    runtime.container?.replace?.('companionAuth', auth);
    return auth;
  }

  async function getRemoteGatewaySecret(scopeOptions = {}) {
    return await db.getCredential?.('remoteGateway.secret', scopeOptions)
      || await db.getCredential?.('setting.remoteGateway.secret', scopeOptions)
      || await readScopedSetting('remoteGateway.secret', scopeOptions, '')
      || '';
  }

  async function saveRemoteGatewaySecret(secret, scopeOptions = {}) {
    const value = String(secret || '').trim();
    if (db.setCredential) {
      await db.setCredential('remoteGateway.secret', value, scopeOptions);
      await db.deleteSetting?.('remoteGateway.secret').catch(() => {});
      await db.deleteCredential?.('setting.remoteGateway.secret', scopeOptions).catch(() => {});
      return;
    }
  }

function buildPairingPayload(pairing, status) {
  if (!pairing) return null;
  const androidHttps = status?.androidBrowserHttps || {};
  const hasLiveSecureCompanion = androidHttps.running === true && Boolean(androidHttps.securePort);
  const useBootstrap = androidHttps.enabled === true;
    // HTTPS pairing intentionally starts on the HTTP bootstrap page so phones
    // can install the local CA before opening the secure companion UI.
    const network = describeCompanionReachability(
      status?.host || pairing.host || '0.0.0.0',
      useBootstrap ? status.port : (status?.port || pairing.port || 8790),
      {
        scheme: 'http',
        pathname: useBootstrap ? '/companion/bootstrap' : '/companion/web',
        pairingCode: pairing.code
      }
    );
    const secureNetwork = androidHttps.enabled && androidHttps.securePort
      ? describeCompanionReachability(status?.host || pairing.host || '0.0.0.0', androidHttps.securePort, {
        scheme: 'https',
        pathname: '/companion/web',
        pairingCode: pairing.code
      })
      : null;
    return {
      success: true,
      ...pairing,
      preferredBrowserUrl: network.preferredBrowserUrl,
      nativeAppUrl: buildNativeCompanionUrl(
        network.preferredHost || status?.preferredHost || pairing.host || '127.0.0.1',
        hasLiveSecureCompanion ? (androidHttps.securePort || status?.port || pairing.port || 8790) : (status?.port || pairing.port || 8790),
        {
          useTls: hasLiveSecureCompanion,
          pairingCode: pairing.code
        }
      ),
      browserUrls: network.browserUrls,
      bootstrapUrl: network.preferredBrowserUrl,
      secureUrl: secureNetwork?.preferredBrowserUrl || '',
      warning: status?.warning || ''
    };
  }

  async function startCompanionServer(options = {}, scopeOptions = {}) {
    // Enablement is transactional from the user's point of view: bind first,
    // then persist enabled=true. A failed bind leaves the setting disabled.
    const savedHost = await readScopedSetting('companion.host', scopeOptions, '0.0.0.0');
    const savedPort = Number(await readScopedSetting('companion.port', scopeOptions, '8790')) || 8790;
    const host = resolveEasyConnectHost(options.host || savedHost || '0.0.0.0');
    const port = Number(options.port || savedPort) || 8790;
    const existing = getCompanionServer();
    if (existing?.server) await existing.stop();

    const companionServer = new CompanionApiServer({
      host,
      port,
      tlsManager: getCompanionTlsManager()
    });
    companionServer.setRemoteGatewayManager(getRemoteGatewayManager());
    configureCompanionServer({
      companionServer,
      container: runtime.container,
      db,
      companionAuth: getCompanionAuth()
    });
    attachCompanionRelays({
      companionServer,
      eventBus,
      windowManager,
      getCompanionServer
    });
    try {
      await companionServer.start();
      runtime.container.replace('companionServer', companionServer);
      await writeScopedSetting('companion.host', host, scopeOptions);
      await writeScopedSetting('companion.port', String(port), scopeOptions);
      await writeScopedSetting('companion.enabled', 'true', scopeOptions);
      return { success: true, ...(await getCompanionStatusPayload(db, companionServer, getCompanionTlsManager(), scopeOptions)) };
    } catch (error) {
      runtime.container.replace('companionServer', null);
      await writeScopedSetting('companion.enabled', 'false', scopeOptions);
      return { success: false, error: error.message, ...(await getCompanionStatusPayload(db, null, getCompanionTlsManager(), scopeOptions)) };
    }
  }

  ipcMain.handle('companion:status', async (event) => {
    const companionServer = getCompanionServer();
    return getCompanionStatusPayload(db, companionServer, getCompanionTlsManager(), buildScopeOptions(event));
  });

  ipcMain.handle('companion:enable', async (event, options = {}) => {
    return startCompanionServer(options || {}, buildScopeOptions(event));
  });

  ipcMain.handle('companion:disable', async (event) => {
    const scopeOptions = buildScopeOptions(event);
    await writeScopedSetting('companion.enabled', 'false', scopeOptions);
    const companionServer = getCompanionServer();
    if (companionServer) {
      await companionServer.stop();
    }
    return {
      success: true,
      ...(await getCompanionStatusPayload(db, companionServer, getCompanionTlsManager(), scopeOptions))
    };
  });

  ipcMain.handle('companion:set-android-browser-https', async (event, enabled) => {
    const scopeOptions = buildScopeOptions(event);
    const tlsManager = getCompanionTlsManager();
    if (!tlsManager?.setEnabled) return { success: false, error: 'Companion TLS manager is unavailable' };
    await tlsManager.setEnabled(enabled === true);
    if (getCompanionServer()?.server) {
      await startCompanionServer({
        host: await readScopedSetting('companion.host', scopeOptions, '0.0.0.0'),
        port: Number(await readScopedSetting('companion.port', scopeOptions, '8790')) || 8790
      }, scopeOptions);
    }
    return { success: true, ...(await getCompanionStatusPayload(db, getCompanionServer(), tlsManager, scopeOptions)) };
  });

  ipcMain.handle('companion:setup-android-browser-https', async (event) => {
    const scopeOptions = buildScopeOptions(event);
    const tlsManager = getCompanionTlsManager();
    if (!tlsManager?.ensureSetup) return { success: false, error: 'Companion TLS manager is unavailable' };
    const host = await readScopedSetting('companion.host', scopeOptions, '0.0.0.0');
    const port = Number(await readScopedSetting('companion.port', scopeOptions, '8790')) || 8790;
    await tlsManager.setEnabled(true);
    await tlsManager.ensureSetup(host, port, { force: false });
    const restart = await startCompanionServer({ host, port }, scopeOptions);
    if (!restart?.success || restart?.androidBrowserHttps?.running !== true) {
      throw new Error(restart?.error || restart?.androidBrowserHttps?.warning || 'Companion HTTPS listener failed to start');
    }
    return { success: true, ...(await getCompanionStatusPayload(db, getCompanionServer(), tlsManager, scopeOptions)) };
  });

  ipcMain.handle('companion:generate-pairing', async (event) => {
    const status = await getCompanionStatusPayload(db, getCompanionServer(), getCompanionTlsManager(), buildScopeOptions(event));
    if (!status.running) return { success: false, error: 'Companion server is not running' };
    const auth = getCompanionAuth();
    const scopeOptions = buildScopeOptions(event);
    const pairing = auth.generatePairing(status.preferredHost || status.host || '0.0.0.0', status.port || 8790, { userId: scopeOptions.requestContext?.userId || null });
    return buildPairingPayload(pairing, status);
  });

  ipcMain.handle('companion:get-pairing', async (event) => {
    const auth = getCompanionAuth();
    const scopeOptions = buildScopeOptions(event);
    const pairing = await auth.getActivePairingAsync({ userId: scopeOptions.requestContext?.userId || null });
    if (!pairing) return null;
    const status = await getCompanionStatusPayload(db, getCompanionServer(), getCompanionTlsManager(), buildScopeOptions(event));
    return buildPairingPayload(pairing, status);
  });

  ipcMain.handle('companion:render-qr', async (event, payload) => {
    const { renderQrPayload } = require('../qr-code');
    return {
      success: true,
      ...renderQrPayload(payload)
    };
  });

  ipcMain.handle('companion:cancel-pairing', async (event) => {
    const scopeOptions = buildScopeOptions(event);
    getCompanionAuth().cancelPairing({ userId: scopeOptions.requestContext?.userId || null });
    return { success: true };
  });

  ipcMain.handle('companion:list-devices', async (event) => {
    const server = getCompanionServer();
    const scopeOptions = buildScopeOptions(event);
    return (await getCompanionAuth().listDevices({ userId: scopeOptions.requestContext?.userId || null })).map(device => ({
      ...device,
      connected: Boolean(server?._wsClients?.has(device.deviceId))
    }));
  });

  ipcMain.handle('companion:remove-device', async (event, deviceId) => {
    const normalizedDeviceId = String(deviceId || '').trim();
    if (!normalizedDeviceId) return { success: false, error: 'deviceId is required' };
    getCompanionServer()?.disconnectDevice?.(normalizedDeviceId, 'device-removed');
    const scopeOptions = buildScopeOptions(event);
    return getCompanionAuth().removeDevice(normalizedDeviceId, { userId: scopeOptions.requestContext?.userId || null });
  });

  ipcMain.handle('companion:update-device-permissions', async (event, deviceId, permissions = {}) => {
    const scopeOptions = buildScopeOptions(event);
    const result = await getCompanionAuth().updateDevicePermissions(String(deviceId || '').trim(), permissions || {}, { userId: scopeOptions.requestContext?.userId || null });
    if (result?.success) {
      getCompanionServer()?._wsBroadcast?.({ type: 'permissions-update', payload: { deviceId } });
    }
    return result;
  });

  ipcMain.handle('companion:notify-state-changed', async (event, scope, payload = {}) => {
    const type = scope === 'ui' ? 'settings-change' : String(scope || 'settings-change');
    getCompanionServer()?._wsBroadcast?.({ type, payload: payload || {} });
    return { success: true };
  });

  ipcMain.handle('companion:get-permission-presets', async () => {
    const perms = new CompanionPermissions();
    return perms.listPresets().map((preset) => ({
      ...preset,
      scope: perms.getDefaultScope(preset.id)
    }));
  });

  ipcMain.handle('remote-gateway:status', async (event) => {
    const scopeOptions = buildScopeOptions(event);
    const manager = getRemoteGatewayManager();
    const enabled = (await readScopedSetting('remoteGateway.enabled', scopeOptions, 'false')) === 'true';
    const status = manager.getStatus();
    return {
      ...status,
      state: enabled ? status.state : 'disconnected',
      connected: enabled ? status.connected : false,
      enabled,
      savedUrl: await readScopedSetting('remoteGateway.url', scopeOptions, '') || ''
    };
  });

  ipcMain.handle('remote-gateway:connect', async (event, options = {}) => {
    const scopeOptions = buildScopeOptions(event);
    const manager = getRemoteGatewayManager();
    const url = String(options.url || await readScopedSetting('remoteGateway.url', scopeOptions, '') || '').trim();
    const secret = String(options.secret || await getRemoteGatewaySecret(scopeOptions)).trim();
    return manager.connect(url, secret, scopeOptions);
  });

  ipcMain.handle('remote-gateway:disconnect', async (event) => {
    return getRemoteGatewayManager().disconnectAndPersist(buildScopeOptions(event));
  });

  ipcMain.handle('remote-gateway:generate-secret', async (event) => {
    const scopeOptions = buildScopeOptions(event);
    const secret = getRemoteGatewayManager().generateSecret();
    await saveRemoteGatewaySecret(secret, scopeOptions);
    return { success: true, secret };
  });

  ipcMain.handle('remote-gateway:deploy', async (event, sshConfig = {}) => {
    return getRemoteGatewayManager().uploadGateway(sshConfig || {});
  });

  ipcMain.handle('remote-gateway:setup', async (event, options = {}) => {
    return getRemoteGatewayManager().setupGateway({ ...(options || {}), scopeOptions: buildScopeOptions(event) });
  });
}

module.exports = { registerAgentSystemHandlers };




























