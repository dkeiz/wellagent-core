// @ts-nocheck
const http = require('http');

function safeJsonParse(raw) {
  try {
    return JSON.parse(String(raw || '{}'));
  } catch (_) {
    return null;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function readHeader(headers, name) {
  if (!headers || typeof headers !== 'object') {
    return null;
  }
  const normalizedName = String(name || '').trim().toLowerCase();
  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (String(headerName || '').trim().toLowerCase() !== normalizedName) {
      continue;
    }
    return Array.isArray(headerValue) ? String(headerValue[0] || '').trim() || null : String(headerValue || '').trim() || null;
  }
  return null;
}

function hasRequiredAuthToken(req, requiredAuthToken) {
  const expected = String(requiredAuthToken || '').trim();
  if (!expected) {
    return true;
  }
  const headerToken = readHeader(req?.headers, 'x-localagent-control-token');
  return headerToken === expected;
}

async function resolveControlRequestContext(resolveRequestContext, options = {}) {
  if (typeof resolveRequestContext !== 'function') {
    return { ok: true, requestContext: null };
  }
  try {
    const resolved = await resolveRequestContext(options);
    if (!resolved || typeof resolved !== 'object') {
      return { ok: true, requestContext: null };
    }
    return resolved;
  } catch (error) {
    return {
      ok: false,
      status: 500,
      error: error?.message || String(error)
    };
  }
}

function createExternalTestControl({
  invokeIpc,
  invokeIpcWithEvent = null,
  shutdownRuntime,
  resolveRequestContext = null,
  getWindowCount,
  getDiagnostics,
  requiredAuthToken = null,
  port = 8788,
  host = '127.0.0.1'
}) {
  let activePort = port;

  function buildBasePayload() {
    return {
      ok: true,
      mode: 'external-test',
      host,
      port: activePort,
      pid: process.pid,
      uptimeSec: Number(process.uptime().toFixed(3)),
      versions: { ...process.versions },
      memoryUsage: process.memoryUsage(),
      windowCount: typeof getWindowCount === 'function' ? getWindowCount() : null
    };
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${host}:${activePort}`);

      if (req.method === 'GET' && url.pathname === '/health') {
        if (!hasRequiredAuthToken(req, requiredAuthToken)) {
          sendJson(res, 401, { success: false, error: 'Unauthorized' });
          return;
        }
        sendJson(res, 200, buildBasePayload());
        return;
      }

      if (req.method === 'GET' && url.pathname === '/diagnostics') {
        if (!hasRequiredAuthToken(req, requiredAuthToken)) {
          sendJson(res, 401, { success: false, error: 'Unauthorized' });
          return;
        }
        const payload = buildBasePayload();
        const extra = typeof getDiagnostics === 'function'
          ? await getDiagnostics()
          : {};
        sendJson(res, 200, {
          ...payload,
          ...(extra && typeof extra === 'object' ? extra : {})
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/invoke') {
        if (!hasRequiredAuthToken(req, requiredAuthToken)) {
          sendJson(res, 401, { success: false, error: 'Unauthorized' });
          return;
        }
        const body = await readBody(req);
        const payload = safeJsonParse(body);
        if (!payload || typeof payload !== 'object') {
          sendJson(res, 400, { success: false, error: 'Invalid JSON payload' });
          return;
        }

        const channel = String(payload.channel || '').trim();
        const args = Array.isArray(payload.args) ? payload.args : [];
        if (!channel) {
          sendJson(res, 400, { success: false, error: 'channel is required' });
          return;
        }

        const resolved = await resolveControlRequestContext(resolveRequestContext, {
          req,
          url,
          payload,
          routePath: url.pathname,
          method: req.method
        });
        if (resolved?.ok === false) {
          sendJson(res, Number(resolved.status) || 401, { success: false, error: resolved.error || 'Unauthorized' });
          return;
        }

        try {
          const event = {
            headers: req.headers || {},
            method: req.method,
            requestContext: resolved?.requestContext || null,
            routePath: url.pathname,
            url: url.toString()
          };
          const result = typeof invokeIpcWithEvent === 'function'
            ? await invokeIpcWithEvent(event, channel, ...args)
            : await invokeIpc(channel, ...args);
          sendJson(res, 200, { success: true, result });
        } catch (error) {
          sendJson(res, 500, { success: false, error: error.message || String(error) });
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/shutdown') {
        if (!hasRequiredAuthToken(req, requiredAuthToken)) {
          sendJson(res, 401, { success: false, error: 'Unauthorized' });
          return;
        }
        const body = await readBody(req);
        const payload = body ? safeJsonParse(body) : {};
        if (body && (!payload || typeof payload !== 'object')) {
          sendJson(res, 400, { success: false, error: 'Invalid JSON payload' });
          return;
        }

        const resolved = await resolveControlRequestContext(resolveRequestContext, {
          req,
          url,
          payload: payload || {},
          routePath: url.pathname,
          method: req.method
        });
        if (resolved?.ok === false) {
          sendJson(res, Number(resolved.status) || 401, { success: false, error: resolved.error || 'Unauthorized' });
          return;
        }

        sendJson(res, 200, { success: true, shuttingDown: true });
        setTimeout(() => {
          shutdownRuntime().catch(() => {});
        }, 10);
        return;
      }

      sendJson(res, 404, { success: false, error: 'Not found' });
    } catch (error) {
      sendJson(res, 500, { success: false, error: error.message || String(error) });
    }
  });

  return {
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const address = server.address();
          if (address && typeof address === 'object' && typeof address.port === 'number') {
            activePort = address.port;
          }
          resolve();
        });
      });
      console.log(`[ExternalTest] Control API listening at http://${host}:${activePort}`);
    },
    async stop() {
      await new Promise((resolve) => {
        try {
          server.close(() => resolve());
        } catch (_) {
          resolve();
        }
      });
    },
    getAddress() {
      return { host, port: activePort };
    }
  };
}

module.exports = {
  createExternalTestControl
};

