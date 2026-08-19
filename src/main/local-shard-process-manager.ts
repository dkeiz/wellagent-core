// @ts-nocheck
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { resolveAgentScope } = require('./agent-ownership');
const { getHealth, invokeControl, shutdown } = require('./shard-control-client');

function normalizeOptionalString(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function parseAgentConfig(raw) {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return raw;
  }
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function sanitizeName(value, fallback = 'shard') {
  return String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '') || fallback;
}

function createRandomId(prefix = 'shard') {
  const token = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replace(/-/g, '')
    : crypto.randomBytes(16).toString('hex');
  return `${prefix}-${token.slice(0, 12)}`;
}

function toLaunchMode(value) {
  return String(value || '').trim().toLowerCase() === 'desktop' ? 'desktop' : 'headless';
}

function buildShardExecution(config = {}, overrides = {}) {
  const current = config.execution && typeof config.execution === 'object' ? config.execution : {};
  const currentShard = current.shard && typeof current.shard === 'object' ? current.shard : {};
  return {
    ...current,
    mode: 'sharded',
    shard: {
      ...currentShard,
      scopeMode: 'shared-runtime',
      dedicated: true,
      autoStart: overrides.autoStart !== undefined ? overrides.autoStart === true : currentShard.autoStart !== false,
      launchMode: overrides.launchMode || currentShard.launchMode || 'headless',
      bundleId: overrides.bundleId || currentShard.bundleId || null,
      shardId: overrides.shardId || currentShard.shardId || null,
      deploymentPath: overrides.deploymentPath || currentShard.deploymentPath || null,
      sourceAgentId: overrides.sourceAgentId || currentShard.sourceAgentId || null,
      originSessionId: overrides.originSessionId || currentShard.originSessionId || null
    }
  };
}

async function allocatePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitFor(predicate, options = {}) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 30000);
  const intervalMs = Math.max(200, Number(options.intervalMs) || 500);
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const result = await predicate();
      if (result) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (lastError) {
    throw lastError;
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

function buildBaseUrl(port) {
  return `http://127.0.0.1:${port}`;
}

function appendLogBuffer(buffer, entry, limit = 400) {
  buffer.push({ at: new Date().toISOString(), ...entry });
  if (buffer.length > limit) {
    buffer.splice(0, buffer.length - limit);
  }
}

function createLocalShardProcessManager(runtime = {}) {
  const agentManager = runtime.agentManager;
  const agentBundleLoader = runtime.agentBundleLoader;
  const shardSupervisor = runtime.shardSupervisor;
  const shardRegistry = runtime.shardRegistry;
  const db = runtime.db;
  const runtimePaths = runtime.runtimePaths;
  const logger = runtime.logger || console;

  if (!agentManager?.getAgent || !agentManager?.createAgent || !agentManager?.updateAgent) {
    throw new Error('LocalShardProcessManager requires agentManager');
  }
  if (!agentBundleLoader?.exportBundle || !agentBundleLoader?.saveBundle || !agentBundleLoader?.loadBundle) {
    throw new Error('LocalShardProcessManager requires agentBundleLoader');
  }
  if (!shardSupervisor?.registerShard || !shardSupervisor?.deployBundle || !shardSupervisor?.heartbeatShard) {
    throw new Error('LocalShardProcessManager requires shardSupervisor');
  }
  if (!runtimePaths?.userDataPath) {
    throw new Error('LocalShardProcessManager requires runtimePaths.userDataPath');
  }

  const runtimes = new Map();

  function resolveScope(options = {}) {
    return resolveAgentScope(options);
  }

  function getShardRoot(agent, scope) {
    const userFolder = sanitizeName(scope.userId || agent?.user_id || 'localuser', 'localuser');
    return path.join(runtimePaths.userDataPath, 'shards', userFolder, `agent-${agent.id}`);
  }

  function getExecution(agent) {
    const config = parseAgentConfig(agent?.config);
    const execution = config.execution && typeof config.execution === 'object' ? config.execution : null;
    return { config, execution };
  }

  async function ensureShardedAgent(agentId, options = {}) {
    const scope = resolveScope(options);
    const agent = await agentManager.getAgent(agentId, scope);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    const { config, execution } = getExecution(agent);
    if (execution?.mode !== 'sharded' || !execution?.shard?.dedicated) {
      throw new Error(`Agent is not configured for sharded execution: ${agentId}`);
    }
    return { agent, config, execution, scope };
  }

  async function exportBundleForAgent(agent, scope, shardRoot) {
    const bundleDir = path.join(shardRoot, 'bundle');
    fs.mkdirSync(bundleDir, { recursive: true });
    const bundlePath = path.join(bundleDir, 'agent-bundle.json');
    const manifest = await agentBundleLoader.exportBundle({
      agentId: agent.id,
      includePluginConfig: true,
      includeRuntimeHints: true,
      outputPath: bundlePath,
      userId: scope.userId,
      requestContext: scope.requestContext || null
    });
    return { bundleDir, bundlePath, manifest };
  }

  async function persistExecutionConfig(agent, config, patch, scope) {
    const nextConfig = {
      ...config,
      execution: buildShardExecution(config, patch)
    };
    await agentManager.updateAgent(agent.id, { config: nextConfig }, scope);
    const updated = await agentManager.getAgent(agent.id, scope);
    return { updated, config: nextConfig };
  }

  async function createRuntimeDescriptor(agent, scope, shardId, sessionId = null) {
    const shardRoot = getShardRoot(agent, scope);
    const userDataPath = path.join(shardRoot, 'chromium');
    fs.mkdirSync(userDataPath, { recursive: true });
    const descriptor = {
      shardId,
      shardRoot,
      userDataPath,
      agentinRoot: runtimePaths.agentinRoot,
      dbPath: db.dbPath,
      userId: scope.userId,
      agentId: agent.id,
      sessionId
    };
    fs.writeFileSync(path.join(shardRoot, 'runtime.json'), JSON.stringify(descriptor, null, 2), 'utf8');
    return descriptor;
  }
  function getMainEntryPath() {
    return require.main?.filename || path.join(process.cwd(), 'build', 'app', 'src', 'main', 'main.js');
  }

  function attachProcessLogging(state, stream, level) {
    if (!stream?.on) return;
    let pending = '';
    stream.on('data', (chunk) => {
      pending += Buffer.from(chunk).toString('utf8');
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        appendLogBuffer(state.logs, { level, message: line });
      }
    });
    stream.on('end', () => {
      if (pending.trim()) {
        appendLogBuffer(state.logs, { level, message: pending.trim() });
      }
    });
  }

  async function registerRuntime(state, health = null) {
    const now = new Date().toISOString();
    await shardSupervisor.registerShard({
      shardId: state.shardId,
      label: state.agent.name,
      host: '127.0.0.1',
      port: state.controlPort,
      baseUrl: state.baseUrl,
      authToken: state.authToken,
      capabilities: {
        filesystem: true,
        network: true,
        terminal: true,
        knowledge: true,
        tags: ['local-spawned', state.launchMode]
      },
      health: {
        status: health?.status || 'online',
        activeRuns: Number(health?.activeRuns || 0),
        deployedBundles: Number(health?.deployedBundles || 0),
        error: health?.error || null,
        heartbeatIntervalMs: Number(health?.heartbeatIntervalMs || 10000),
        lastHeartbeatAt: now,
        load: health?.load ?? null,
        observedLatencyMs: health?.observedLatencyMs ?? null
      },
      runtime: {
        mode: state.launchMode,
        userId: state.scope.userId,
        version: process.version
      },
      metadata: {
        agentId: state.agent.id,
        bundleId: state.bundleId,
        dedicated: true,
        scopeMode: 'shared-runtime',
        userId: state.scope.userId,
        userDataPath: state.snapshot.userDataPath
      }
    });
  }

  async function refreshHealth(state) {
    const health = await invokeControl(state.baseUrl, state.authToken, 'shard-host:get-health', [], {
      requestContext: state.scope.requestContext || null,
      timeoutMs: 5000
    });
    await shardSupervisor.heartbeatShard(state.shardId, {
      ...health,
      status: health?.status || 'online',
      lastHeartbeatAt: new Date().toISOString()
    });
    state.lastHeartbeat = new Date().toISOString();
    state.lastHealth = health || null;
    return health;
  }

  function startHeartbeatLoop(state) {
    if (state.heartbeatTimer) {
      clearInterval(state.heartbeatTimer);
    }
    state.heartbeatTimer = setInterval(() => {
      refreshHealth(state).catch((error) => {
        appendLogBuffer(state.logs, { level: 'error', message: `[heartbeat] ${error.message}` });
      });
    }, 10000);
    if (typeof state.heartbeatTimer.unref === 'function') {
      state.heartbeatTimer.unref();
    }
  }

  async function deployBundleToRuntime(state, requestContext = null) {
    const manifest = agentBundleLoader.loadBundle(state.bundlePath);
    const result = await shardSupervisor.deployBundle({
      manifest,
      shardId: state.shardId,
      requestContext,
      sendDeployment: async ({ deployment, manifest: nextManifest }) => {
        return invokeControl(state.baseUrl, state.authToken, 'shard-host:deploy-bundle', [{
          bundleId: nextManifest.id,
          bundlePath: state.bundlePath,
          deploymentId: deployment.deploymentId,
          agentId: state.agent.id,
          shardId: state.shardId
        }], {
          requestContext,
          timeoutMs: 30000
        });
      }
    });
    state.bundleId = manifest.id;
    state.deployment = result.deployment;
    state.deployedAt = new Date().toISOString();
    return result;
  }

  async function stopState(state, options = {}) {
    if (!state) return;
    state.stopping = true;
    if (state.heartbeatTimer) {
      clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = null;
    }
    try {
      if (options.force !== true) {
        await shutdown(state.baseUrl, state.authToken, {
          requestContext: state.scope.requestContext || null,
          timeoutMs: 3000
        });
      }
    } catch (_error) {}

    if (state.child && !state.child.killed) {
      try {
        state.child.kill();
      } catch (_error) {}
    }
    try {
      await shardSupervisor.deregisterShard(state.shardId);
    } catch (_error) {}
    runtimes.delete(String(state.agent.id));
  }

  async function startForAgent(agentId, options = {}) {
    const { agent, config, execution, scope } = await ensureShardedAgent(agentId, options);
    const existing = runtimes.get(String(agent.id));
    if (existing?.child && !existing.child.killed) {
      return getStatus(agent.id, scope);
    }

    const launchMode = toLaunchMode(options.launchMode || execution?.shard?.launchMode || 'headless');
    const shardId = normalizeOptionalString(execution?.shard?.shardId) || `agent-${agent.id}`;
    const activation = await agentManager.activateAgent(agent.id, scope);
    const sessionId = normalizeOptionalString(activation?.sessionId);
    const snapshot = await createRuntimeDescriptor(agent, scope, shardId, sessionId);
    const bundleExport = await exportBundleForAgent(agent, scope, snapshot.shardRoot);
    const controlPort = await allocatePort('127.0.0.1');
    const authToken = createRandomId('control');
    const baseUrl = buildBaseUrl(controlPort);
    const state = {
      agent,
      authToken,
      baseUrl,
      bundleId: bundleExport.manifest.id,
      bundlePath: bundleExport.bundlePath,
      child: null,
      controlPort,
      deployment: null,
      deployedAt: null,
      heartbeatTimer: null,
      lastHealth: null,
      lastHeartbeat: null,
      launchMode,
      logs: [],
      scope,
      sessionId,
      shardId,
      snapshot,
      startedAt: new Date().toISOString(),
      stopping: false
    };

    runtimes.set(String(agent.id), state);
    const childArgs = [
      getMainEntryPath(),
      '--control-api',
      '--enable-shard-host',
      `--external-port=${controlPort}`,
      `--control-auth-token=${authToken}`,
      `--shard-id=${shardId}`,
      `--shard-label=${agent.name}`,
      `--shard-agent-id=${agent.id}`,
      `--shard-session-id=${sessionId || ''}`,
      `--agentin-root=${snapshot.agentinRoot}`,
      `--db-path=${snapshot.dbPath}`,
      `--user=${scope.userId}`,
      '--user-data-dir',
      snapshot.userDataPath
    ];
    if (launchMode === 'headless') {
      childArgs.push('--windowless');
    } else {
      childArgs.push('--shard-ui=compact');
    }

    const child = spawn(process.execPath, childArgs, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LOCALAGENT_SHARD_HOST: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: launchMode !== 'desktop'
    });
    state.child = child;
    attachProcessLogging(state, child.stdout, 'info');
    attachProcessLogging(state, child.stderr, 'error');
    child.once('exit', (code, signal) => {
      appendLogBuffer(state.logs, { level: 'info', message: `process exited code=${code ?? 'null'} signal=${signal ?? 'null'}` });
      if (state.heartbeatTimer) {
        clearInterval(state.heartbeatTimer);
        state.heartbeatTimer = null;
      }
      if (!state.stopping) {
        shardSupervisor.heartbeatShard(state.shardId, {
          status: 'offline',
          error: `Process exited (${code ?? 'null'}${signal ? `/${signal}` : ''})`,
          lastHeartbeatAt: new Date().toISOString()
        }).catch(() => {});
      }
    });

    try {
      await waitFor(async () => {
        const health = await getHealth(baseUrl, authToken, { timeoutMs: 2500 });
        return health && health.ok ? health : null;
      }, { timeoutMs: 45000, intervalMs: 700 });
      await registerRuntime(state);
      await deployBundleToRuntime(state, scope.requestContext || null);
      await refreshHealth(state);
      await persistExecutionConfig(agent, config, {
        autoStart: execution?.shard?.autoStart !== false,
        bundleId: state.bundleId || execution?.shard?.bundleId || null,
        deploymentPath: state.bundlePath || execution?.shard?.deploymentPath || null,
        launchMode,
        shardId,
        sourceAgentId: execution?.shard?.sourceAgentId || null
      }, scope);
      startHeartbeatLoop(state);
    } catch (error) {
      await stopState(state, { force: true });
      throw error;
    }

    return getStatus(agent.id, scope);
  }

  async function stopForAgent(agentId, options = {}) {
    const { agent, scope } = await ensureShardedAgent(agentId, options);
    const state = runtimes.get(String(agent.id));
    if (!state) {
      try {
        await shardSupervisor.deregisterShard(`agent-${agent.id}`);
      } catch (_error) {}
      return { success: true, running: false, shardId: `agent-${agent.id}` };
    }
    await stopState(state);
    return { success: true, running: false, shardId: state.shardId };
  }

  async function restartForAgent(agentId, options = {}) {
    await stopForAgent(agentId, options);
    return startForAgent(agentId, options);
  }

  async function getStatus(agentId, options = {}) {
    const { agent, execution, scope } = await ensureShardedAgent(agentId, options);
    const state = runtimes.get(String(agent.id)) || null;
    const registryRecord = shardRegistry?.getShard
      ? await shardRegistry.getShard(normalizeOptionalString(execution?.shard?.shardId) || `agent-${agent.id}`)
      : null;
    return {
      agentId: agent.id,
      authConfigured: Boolean(state?.authToken),
      baseUrl: state?.baseUrl || registryRecord?.baseUrl || null,
      bundleId: state?.bundleId || execution?.shard?.bundleId || null,
      deployment: state?.deployment || null,
      lastHeartbeat: state?.lastHeartbeat || registryRecord?.health?.lastHeartbeatAt || null,
      launchMode: state?.launchMode || execution?.shard?.launchMode || 'headless',
      logsAvailable: (state?.logs?.length || 0) > 0,
      userId: state?.scope?.userId || registryRecord?.runtime?.userId || scope.userId,
      running: Boolean(state?.child && !state.child.killed),
      shardId: state?.shardId || execution?.shard?.shardId || `agent-${agent.id}`,
      shardRecord: registryRecord || null,
      unhealthy: registryRecord?.health?.status === 'offline' || registryRecord?.health?.status === 'degraded'
    };
  }

  async function listRuntimes(options = {}) {
    const scope = resolveScope(options);
    const agents = await agentManager.getAgents(null, scope);
    const shardedAgents = agents.filter((agent) => parseAgentConfig(agent.config)?.execution?.mode === 'sharded');
    const results = [];
    for (const agent of shardedAgents) {
      results.push(await getStatus(agent.id, scope));
    }
    return results;
  }

  async function createShardedAgent(input = {}, options = {}) {
    const scope = resolveScope(options);
    const sourceAgentId = Number(input.sourceAgentId || input.agentId);
    const sourceSessionId = normalizeOptionalString(input.sessionId);
    let source;
    if (Number.isFinite(sourceAgentId)) {
      source = await agentManager.getAgent(sourceAgentId, scope);
      if (!source) {
        throw new Error(`Source agent not found: ${sourceAgentId}`);
      }
    } else {
      if (!sourceSessionId) {
        throw new Error('sourceAgentId or sessionId is required');
      }
      const systemPrompt = db.getScopedSetting
        ? await db.getScopedSetting('system_prompt', scope)
        : await db.getSetting('system_prompt');
      source = {
        id: null,
        name: normalizeOptionalString(input.sourceName) || 'Chat',
        type: 'pro',
        icon: '💬',
        description: 'Dedicated runtime created from a chat tab.',
        system_prompt: systemPrompt || 'You are a helpful AI assistant.',
        config: {}
      };
    }

    const sourceConfig = parseAgentConfig(source.config);
    const launchMode = toLaunchMode(input.launchMode || 'headless');
    const shardedName = normalizeOptionalString(input.name) || `${source.name} Shard`;
    const autoStart = input.autoStart !== false;
    const created = await agentManager.createAgent({
      name: shardedName,
      type: source.type || 'pro',
      icon: source.icon || '🤖',
      description: normalizeOptionalString(input.description) || source.description || '',
      system_prompt: source.system_prompt || '',
      config: {
        ...sourceConfig,
        execution: buildShardExecution(sourceConfig, {
          autoStart,
          launchMode,
          sourceAgentId: source.id,
          originSessionId: normalizeOptionalString(input.originSessionId),
          shardId: `agent-pending-${Date.now()}`
        })
      }
    }, scope);

    const shardRoot = getShardRoot(created, scope);
    const bundleExport = await exportBundleForAgent(created, scope, shardRoot);
    const persisted = await persistExecutionConfig(created, parseAgentConfig(created.config), {
      autoStart,
      bundleId: bundleExport.manifest.id,
      deploymentPath: bundleExport.bundlePath,
      launchMode,
      shardId: `agent-${created.id}`,
      sourceAgentId: source.id,
      originSessionId: normalizeOptionalString(input.originSessionId)
    }, scope);

    if (autoStart && input.deferStart !== true) {
      await startForAgent(created.id, scope);
    }

    return {
      agent: persisted.updated,
      sourceAgentId: source.id,
      success: true
    };
  }

  async function ensureRunning(agentId, options = {}) {
    const status = await getStatus(agentId, options);
    if (status.running) {
      return status;
    }
    return startForAgent(agentId, options);
  }

  async function reattachForAgent(agentId, options = {}) {
    const { agent, execution, scope } = await ensureShardedAgent(agentId, options);
    const state = runtimes.get(String(agent.id)) || null;
    if (!state?.baseUrl || !state?.authToken || !state?.sessionId) {
      throw new Error(`Shard runtime unavailable for agent ${agent.id}`);
    }
    const messages = await invokeControl(state.baseUrl, state.authToken, 'load-chat-session', [state.sessionId], {
      requestContext: scope.requestContext || null,
      timeoutMs: 30000
    });
    await stopForAgent(agent.id, scope);
    return {
      success: true,
      agentId: agent.id,
      sessionId: state.sessionId,
      originSessionId: normalizeOptionalString(execution?.shard?.originSessionId),
      messages: Array.isArray(messages) ? messages : []
    };
  }
  async function runAgentTurn(input = {}, options = {}) {
    const agentId = Number(input.agentId || options.agentId);
    if (!Number.isFinite(agentId)) {
      throw new Error('agentId is required');
    }
    const status = await ensureRunning(agentId, options);
    const state = runtimes.get(String(agentId));
    if (!state?.baseUrl) {
      throw new Error(`Shard runtime unavailable for agent ${agentId}`);
    }
    const configuredTimeoutMs = Math.max(
      15000,
      Number(input.timeoutMs) || Number(process.env.LOCALAGENT_SHARD_TURN_TIMEOUT_MS) || 120000
    );
    return invokeControl(state.baseUrl, state.authToken, 'shard-host:run-agent-turn', [{
      agentId,
      bundleId: state.bundleId,
      history: Array.isArray(input.history) ? input.history : [],
      message: String(input.message || ''),
      options: {
        ...(input.options || {}),
        agentId,
        requestContext: options.requestContext || input.options?.requestContext || null,
        sessionId: input.sessionId || input.options?.sessionId || null
      },
      sessionId: input.sessionId || null,
      shardId: status.shardId
    }], {
      requestContext: options.requestContext || null,
      timeoutMs: configuredTimeoutMs
    });
  }

  async function collectLogs(agentId, options = {}) {
    const { agent } = await ensureShardedAgent(agentId, options);
    const state = runtimes.get(String(agent.id));
    if (!state) {
      return [];
    }
    const limit = Math.max(1, Number(options.limit) || 200);
    return state.logs.slice(-limit);
  }

  async function getRuntimeProof(agentId, options = {}) {
    const { agent, scope } = await ensureShardedAgent(agentId, options);
    const status = await getStatus(agent.id, scope);
    const state = runtimes.get(String(agent.id)) || null;
    if (!state?.baseUrl || !state?.authToken) {
      return {
        success: true,
        agentId: agent.id,
        shardId: status.shardId,
        launchMode: status.launchMode,
        running: status.running,
        childPid: Number(state?.child?.pid || 0) || null,
        baseUrl: state?.baseUrl || status.baseUrl || null,
        controlPort: Number(state?.controlPort || 0) || null,
        health: null,
        childWindowCount: null,
        childWindows: [],
        rendererInspection: null,
        runtimeUiContext: null
      };
    }

    const requestContext = scope.requestContext || null;
    const health = await getHealth(state.baseUrl, state.authToken, {
      requestContext,
      timeoutMs: 5000
    }).catch((error) => ({ ok: false, error: error.message || String(error) }));

    let childWindows = [];
    let runtimeUiContext = null;
    let rendererInspection = null;
    try {
      const result = await invokeControl(state.baseUrl, state.authToken, 'app:list-windows', [], {
        requestContext,
        timeoutMs: 5000
      });
      childWindows = Array.isArray(result?.windows) ? result.windows : [];
      const runtimeContextResult = await invokeControl(state.baseUrl, state.authToken, 'app:get-runtime-context', [], {
        requestContext,
        timeoutMs: 5000
      }).catch(() => null);
      runtimeUiContext = runtimeContextResult?.runtime || null;
      const inspectionResult = await invokeControl(state.baseUrl, state.authToken, 'app:inspect-renderer', [], {
        requestContext,
        timeoutMs: 5000
      }).catch(() => null);
      rendererInspection = inspectionResult?.success ? inspectionResult : null;
    } catch (error) {
      appendLogBuffer(state.logs, { level: 'error', message: '[runtime-proof] ' + (error.message || String(error)) });
    }

    return {
      success: true,
      agentId: agent.id,
      shardId: status.shardId,
      launchMode: status.launchMode,
      running: status.running,
      childPid: Number(state.child?.pid || 0) || null,
      baseUrl: state.baseUrl,
      controlPort: state.controlPort,
      health,
      childWindowCount: Number(health?.windowCount || childWindows.length || 0),
      childWindows,
      rendererInspection,
      runtimeUiContext
    };
  }

  async function captureRuntimeWindow(agentId, outputPath, options = {}) {
    const { agent, scope } = await ensureShardedAgent(agentId, options);
    const state = runtimes.get(String(agent.id)) || null;
    if (!state?.baseUrl || !state?.authToken) {
      throw new Error('Shard runtime unavailable for agent ' + agent.id);
    }
    return invokeControl(state.baseUrl, state.authToken, 'app:capture-main-window', [{
      path: outputPath
    }], {
      requestContext: scope.requestContext || null,
      timeoutMs: 30000
    });
  }

  return {
    captureRuntimeWindow,
    collectLogs,
    createShardedAgent,
    getRuntimeProof,
    getStatus,
    listRuntimes,
    restartForAgent,
    reattachForAgent,
    runAgentTurn,
    startForAgent,
    stopForAgent
  };
}

module.exports = {
  createLocalShardProcessManager
};

export {};








