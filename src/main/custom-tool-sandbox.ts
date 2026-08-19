// @ts-nocheck
const path = require('path');
const { fork } = require('child_process');

const RUNNER_PATH = path.join(__dirname, 'custom-tool-sandbox-runner.js');
const CUSTOM_TOOL_CAPABILITIES = Object.freeze(['filesystem', 'network', 'subprocess']);
const CUSTOM_TOOL_MAX_OLD_SPACE_MB = 64;
const CUSTOM_TOOL_SANDBOX_ENV_KEYS = Object.freeze(['SystemRoot', 'WINDIR', 'TEMP', 'TMP']);

function buildCustomToolSandboxEnv() {
  const env = {};
  for (const key of CUSTOM_TOOL_SANDBOX_ENV_KEYS) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.LOCALAGENT_CUSTOM_TOOL_SANDBOX = '1';
  return env;
}

function normalizeCustomToolSandboxPolicy(tool = {}) {
  const rawCapabilities = Array.isArray(tool.capabilities)
    ? tool.capabilities
    : (Array.isArray(tool.sandboxCapabilities) ? tool.sandboxCapabilities : []);
  const requested = rawCapabilities
    .map(value => String(value || '').trim().toLowerCase())
    .filter(Boolean);
  const unsupported = requested.filter(value => !CUSTOM_TOOL_CAPABILITIES.includes(value));
  if (unsupported.length > 0) {
    throw new Error(`Unsupported custom tool capability: ${unsupported[0]}`);
  }
  if (requested.length > 0) {
    throw new Error('Custom tool filesystem, network, and subprocess capabilities are not available yet');
  }
  return Object.fromEntries(CUSTOM_TOOL_CAPABILITIES.map(capability => [capability, false]));
}

function runCustomToolInSandbox({ toolName, code, params, timeoutMs }) {
  const effectiveTimeoutMs = Math.max(50, Math.min(Number(timeoutMs) || 5000, 60_000));

  return new Promise((resolve, reject) => {
    const child = fork(RUNNER_PATH, [], {
      execArgv: [`--max-old-space-size=${CUSTOM_TOOL_MAX_OLD_SPACE_MB}`],
      env: buildCustomToolSandboxEnv(),
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true
    });
    let settled = false;

    const finish = (error, result, killChild = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.removeAllListeners('message');
      child.removeAllListeners('error');
      child.removeAllListeners('exit');
      if (killChild && !child.killed) {
        child.kill();
      }
      if (error) {
        reject(error);
        return;
      }
      resolve(result);
    };

    const timeout = setTimeout(() => {
      finish(
        new Error(`Custom tool "${toolName}" timed out after ${effectiveTimeoutMs}ms`),
        null,
        true
      );
    }, effectiveTimeoutMs + 100);

    child.on('message', (message) => {
      if (message?.ok === true) {
        finish(null, message.result);
        return;
      }
      finish(new Error(message?.error || `Custom tool "${toolName}" failed in sandbox`));
    });

    child.on('error', (error) => {
      finish(new Error(`Custom tool "${toolName}" sandbox failed: ${error.message}`));
    });

    child.on('exit', (code, signal) => {
      if (settled) return;
      finish(new Error(
        `Custom tool "${toolName}" sandbox exited before returning a result (${signal || code})`
      ));
    });

    child.send({
      toolName,
      code,
      params,
      timeoutMs: effectiveTimeoutMs
    }, (error) => {
      if (error) {
        finish(new Error(`Custom tool "${toolName}" sandbox send failed: ${error.message}`), null, true);
      }
    });
  });
}

module.exports = {
  CUSTOM_TOOL_CAPABILITIES,
  CUSTOM_TOOL_MAX_OLD_SPACE_MB,
  CUSTOM_TOOL_SANDBOX_ENV_KEYS,
  buildCustomToolSandboxEnv,
  normalizeCustomToolSandboxPolicy,
  runCustomToolInSandbox
};
