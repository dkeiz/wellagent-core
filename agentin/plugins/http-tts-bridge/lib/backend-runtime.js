'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const { getPluginConfig, splitCommand } = require('./config');
const { buildRuntimePaths, ensureRuntimePaths } = require('./runtime-paths');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function appendLog(runtime, streamName, chunk) {
  const text = String(chunk || '');
  if (!text) return;
  const lines = text.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    runtime.logs.push({
      at: new Date().toISOString(),
      stream: streamName,
      line
    });
  }
  if (runtime.logs.length > 120) {
    runtime.logs.splice(0, runtime.logs.length - 120);
  }
}

function createProcessState() {
  return {
    process: null,
    unregisterManagedProcess: null,
    pid: null,
    ready: false,
    baseUrl: '',
    port: null,
    host: '127.0.0.1',
    startedAt: null,
    lastError: '',
    startPromise: null,
    logs: [],
    stdoutStream: null,
    stderrStream: null
  };
}

async function findFreePort(preferred, host) {
  const startPort = Number(preferred) || 58001;
  for (let port = startPort; port < startPort + 40; port += 1) {
    const available = await new Promise(resolve => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(port, host, () => {
        server.close(() => resolve(true));
      });
    });
    if (available) return port;
  }
  throw new Error(`Could not find a free port near ${startPort}`);
}

async function fetchJson(baseUrl, requestPath, options = {}) {
  const controller = new AbortController();
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 15000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL(requestPath, baseUrl).toString(), {
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body,
      signal: controller.signal
    });
    const contentType = String(response.headers.get('content-type') || '');
    const payload = contentType.includes('application/json')
      ? await response.json()
      : await response.text();
    if (!response.ok) {
      const message = typeof payload === 'string'
        ? payload
        : payload?.detail || payload?.message || `HTTP ${response.status}`;
      throw new Error(message);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForHealth(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const health = await fetchJson(baseUrl, '/api/health', { timeoutMs: 2000 });
      if (health && String(health.status || '').trim()) {
        return health;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(350);
  }
  throw lastError || new Error('Embedded backend did not become healthy in time');
}

function closeLogStreams(runtime) {
  for (const key of ['stdoutStream', 'stderrStream']) {
    const stream = runtime[key];
    runtime[key] = null;
    if (!stream) continue;
    try {
      stream.end();
    } catch (_) {}
  }
}

async function stopBackend(runtime) {
  const proc = runtime.process;
  const unregisterManagedProcess = runtime.unregisterManagedProcess;
  runtime.unregisterManagedProcess = null;
  if (typeof unregisterManagedProcess === 'function') {
    try {
      unregisterManagedProcess();
    } catch (_) {}
  }
  runtime.ready = false;
  runtime.process = null;
  runtime.pid = null;
  runtime.baseUrl = '';
  runtime.port = null;

  if (!proc) {
    closeLogStreams(runtime);
    return { ok: true, stopped: true, localOnly: true };
  }

  await new Promise(resolve => {
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      resolve();
    };
    const timeout = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch (_) {}
      done();
    }, 1500);

    proc.once('exit', () => {
      clearTimeout(timeout);
      done();
    });

    try {
      proc.kill('SIGTERM');
    } catch (_) {
      clearTimeout(timeout);
      done();
    }
  });

  closeLogStreams(runtime);
  return { ok: true, stopped: true };
}

async function startBackend(runtime, context) {
  if (process.env.LOCALAGENT_ELECTRON_APP_RUNTIME !== '1') {
    throw new Error('Voice backend may only be started by the Electron application runtime.');
  }

  if (runtime.ready && runtime.process) {
    return getBackendStatus(runtime);
  }
  if (runtime.startPromise) {
    return runtime.startPromise;
  }

  runtime.startPromise = (async () => {
    const config = getPluginConfig(context);
    const paths = buildRuntimePaths(context.pluginId, context.pluginDir);
    ensureRuntimePaths(paths);
    await stopBackend(runtime);

    const port = await findFreePort(config.backendPort, config.backendHost);
    const [command, ...prefixArgs] = splitCommand(config.pythonCommand);
    const args = [
      ...prefixArgs,
      'run.py',
      '--no-ui',
      '--host',
      config.backendHost,
      '--port',
      String(port)
    ];

    const env = {
      ...process.env,
      BASE_DIR: paths.runtimeRoot,
      HF_CACHE_DIR: paths.hfCacheDir,
      MODEL_NAME: config.builtinModel,
      MODEL_SOURCE_POLICY: 'offline_only',
      TTS_ENGINE: 'auto',
      ENABLE_CORS: 'true',
      DEFER_MODEL_LOAD_ON_STARTUP: 'true',
      LOCALAGENT_VOICE_BACKEND_PARENT: 'electron-app',
      MODEL_PATH_OVERRIDES_JSON: JSON.stringify(config.modelPathOverrides)
    };

    const stdoutPath = path.join(paths.logsDir, 'backend.stdout.log');
    const stderrPath = path.join(paths.logsDir, 'backend.stderr.log');
    runtime.stdoutStream = fs.createWriteStream(stdoutPath, { flags: 'a' });
    runtime.stderrStream = fs.createWriteStream(stderrPath, { flags: 'a' });

    const child = spawn(command, args, {
      cwd: paths.backendDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false
    });

    runtime.process = child;
    if (typeof context.registerManagedProcess === 'function') {
      runtime.unregisterManagedProcess = context.registerManagedProcess(child, {
        name: 'http-tts-bridge-embedded-backend'
      });
    }
    runtime.pid = child.pid || null;
    runtime.port = port;
    runtime.host = config.backendHost;
    runtime.baseUrl = `http://${config.backendHost}:${port}`;
    runtime.startedAt = new Date().toISOString();
    runtime.lastError = '';

    child.stdout.on('data', chunk => {
      runtime.stdoutStream?.write(chunk);
      appendLog(runtime, 'stdout', chunk);
    });
    child.stderr.on('data', chunk => {
      runtime.stderrStream?.write(chunk);
      appendLog(runtime, 'stderr', chunk);
    });
    child.on('error', error => {
      runtime.lastError = error.message || String(error);
      runtime.ready = false;
    });
    child.on('exit', (code, signal) => {
      const unregisterOnExit = runtime.unregisterManagedProcess;
      runtime.unregisterManagedProcess = null;
      if (typeof unregisterOnExit === 'function') {
        try {
          unregisterOnExit();
        } catch (_) {}
      }
      runtime.ready = false;
      runtime.process = null;
      runtime.pid = null;
      if (code !== 0 && signal !== 'SIGTERM') {
        runtime.lastError = `Embedded backend exited with code=${code} signal=${signal || 'none'}`;
      }
      closeLogStreams(runtime);
    });

    try {
      await waitForHealth(runtime.baseUrl, config.backendStartupTimeoutMs);
      runtime.ready = true;
      return getBackendStatus(runtime);
    } catch (error) {
      runtime.lastError = error.message || String(error);
      await stopBackend(runtime);
      throw error;
    }
  })().finally(() => {
    runtime.startPromise = null;
  });

  return runtime.startPromise;
}

async function ensureBackend(runtime, context) {
  if (runtime.ready && runtime.process && runtime.baseUrl) {
    return runtime.baseUrl;
  }
  await startBackend(runtime, context);
  return runtime.baseUrl;
}

async function requestBackendJson(runtime, context, requestPath, options = {}) {
  const baseUrl = await ensureBackend(runtime, context);
  const headers = {
    Accept: 'application/json',
    ...(options.headers || {})
  };
  const method = options.method || 'GET';
  const body = options.body == null
    ? undefined
    : (typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
  if (body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  return fetchJson(baseUrl, requestPath, {
    method,
    headers,
    body,
    timeoutMs: options.timeoutMs
  });
}

async function requestBackendHealth(runtime) {
  if (!runtime.baseUrl) {
    return null;
  }
  try {
    return await fetchJson(runtime.baseUrl, '/api/health', { timeoutMs: 2000 });
  } catch (_) {
    return null;
  }
}

async function getBackendStatus(runtime) {
  const health = await requestBackendHealth(runtime);
  return {
    ok: Boolean(runtime.process || runtime.startPromise),
    starting: Boolean(runtime.startPromise && !runtime.ready),
    running: Boolean(runtime.process),
    ready: Boolean(runtime.ready),
    healthy: Boolean(health),
    pid: runtime.pid,
    host: runtime.host,
    port: runtime.port,
    baseUrl: runtime.baseUrl,
    startedAt: runtime.startedAt,
    lastError: runtime.lastError,
    health,
    logs: runtime.logs.slice(-40)
  };
}

module.exports = {
  createProcessState,
  ensureBackend,
  getBackendStatus,
  requestBackendJson,
  startBackend,
  stopBackend
};
