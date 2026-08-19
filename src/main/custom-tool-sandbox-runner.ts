// @ts-nocheck
const vm = require('vm');

const MAX_CODE_BYTES = 200 * 1024;
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;

function byteLength(value) {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function cloneJsonValue(value, label, maxBytes = MAX_RESULT_BYTES) {
  const json = JSON.stringify(value);
  if (json === undefined) {
    return null;
  }
  if (Buffer.byteLength(json, 'utf8') > maxBytes) {
    throw new Error(`${label} exceeds ${Math.round(maxBytes / 1024)} KiB`);
  }
  return JSON.parse(json);
}

function createSandbox(params) {
  const sandbox = Object.create(null);
  Object.defineProperties(sandbox, {
    params: { value: params, enumerable: true },
    console: {
      value: Object.freeze({
        log() {},
        info() {},
        warn() {},
        error() {}
      }),
      enumerable: true
    },
    process: { value: undefined },
    require: { value: undefined },
    module: { value: undefined },
    exports: { value: undefined },
    Buffer: { value: undefined },
    fetch: { value: undefined },
    WebSocket: { value: undefined },
    setTimeout: { value: undefined },
    setInterval: { value: undefined },
    setImmediate: { value: undefined }
  });
  return vm.createContext(sandbox, {
    codeGeneration: {
      strings: false,
      wasm: false
    }
  });
}

function send(message) {
  if (typeof process.send === 'function') {
    process.send(message);
  }
}

async function run(message) {
  const code = String(message?.code || '');
  const timeoutMs = Math.max(50, Math.min(Number(message?.timeoutMs) || 5000, 60_000));
  if (byteLength(code) > MAX_CODE_BYTES) {
    throw new Error(`Custom tool code exceeds ${Math.round(MAX_CODE_BYTES / 1024)} KiB`);
  }

  const params = cloneJsonValue(message?.params || {}, 'Custom tool input', MAX_INPUT_BYTES);
  const context = createSandbox(params);
  const source = `"use strict";\n(async (params) => {\n${code}\n})(params);`;
  const script = new vm.Script(source, {
    filename: `custom-tool:${String(message?.toolName || 'unknown')}`
  });

  const runTimeoutMs = Math.max(10, Math.min(timeoutMs, 5000));
  const result = script.runInContext(context, { timeout: runTimeoutMs });
  const awaited = await Promise.resolve(result);
  return cloneJsonValue(awaited, 'Custom tool result');
}

process.on('message', (message) => {
  let timeout = null;
  const timeoutMs = Math.max(50, Math.min(Number(message?.timeoutMs) || 5000, 60_000));

  timeout = setTimeout(() => {
    send({
      ok: false,
      error: `Custom tool sandbox timed out after ${timeoutMs}ms`
    });
    process.exit(1);
  }, timeoutMs);

  run(message)
    .then((result) => {
      clearTimeout(timeout);
      send({ ok: true, result });
      process.exit(0);
    })
    .catch((error) => {
      clearTimeout(timeout);
      send({
        ok: false,
        error: error?.message || String(error)
      });
      process.exit(1);
    });
});
