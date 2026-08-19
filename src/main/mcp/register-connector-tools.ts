// @ts-nocheck
const fs = require('fs');
const path = require('path');
const { tokenizePath } = require('../path-tokens');
const { normalizeConnectorName } = require('../connector-name-policy');
const { buildRuntimePaths } = require('../runtime-paths');

function getPathTokenOptions(server) {
  const context = server.getCurrentAgentContext?.()
    || server.getCurrentExecutionContext?.()
    || {};
  return {
    agentManager: server._agentManager || null,
    sessionWorkspace: server._sessionWorkspace || null,
    context
  };
}

async function toPortablePath(server, absolutePath) {
  return tokenizePath(absolutePath, getPathTokenOptions(server));
}

async function assertConnectorPathAllowed(server, filePath, connectorsDir) {
  await server.assertExecutionPathAllowed?.(filePath, {
    extraRoots: [connectorsDir].filter(Boolean)
  });
}

function getConnectorScopeOptions(server) {
  const currentExecutionContext = typeof server.getCurrentExecutionContext === 'function'
    ? server.getCurrentExecutionContext()
    : null;
  return { requestContext: currentExecutionContext?.requestContext || null };
}

function registerConnectorTools(server) {
  function getConnectorFilePath(name) {
    const safeName = normalizeConnectorName(name);
    const connectorsDir = server._connectorRuntime?.connectorsDir
      || buildRuntimePaths().connectorsDir;
    if (!fs.existsSync(connectorsDir)) {
      fs.mkdirSync(connectorsDir, { recursive: true });
    }
    return {
      connectorsDir,
      filePath: path.join(connectorsDir, `${safeName}.js`),
      name: safeName
    };
  }

  server.registerTool('connector_op', {
    name: 'connector_op',
    description: 'Unified connector operations. Actions: create, start, stop, list, config_get, config_set.',
    userDescription: 'Run connector operations',
    example: 'TOOL:connector_op{"action":"list"}',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Operation: create | start | stop | list | config_get | config_set'
        },
        name: { type: 'string', description: 'Connector name (required for all actions except list)' },
        code: { type: 'string', description: 'Connector source code for create action' },
        key: { type: 'string', description: 'Config key for config_set action' },
        value: { type: 'string', description: 'Config value for config_set action' }
      },
      required: ['action']
    }
  }, async (params) => {
    const action = String(params.action || '').toLowerCase();
    const runtime = server._connectorRuntime;
    if (!runtime) return { error: 'Connector runtime not initialized' };

    if (action === 'list') {
      return runtime.listConnectors(getConnectorScopeOptions(server));
    }

    if (!params.name) {
      return { error: 'name is required for this connector action' };
    }
    const connectorName = normalizeConnectorName(params.name);

    if (action === 'create') {
      if (!params.code) return { error: 'code is required for create action' };
      const { connectorsDir, filePath, name } = getConnectorFilePath(connectorName);
      await assertConnectorPathAllowed(server, filePath, connectorsDir);
      fs.writeFileSync(filePath, params.code, 'utf-8');
      return { success: true, path: await toPortablePath(server, filePath), name };
    }

    if (action === 'start') {
      return runtime.startConnector(connectorName, getConnectorScopeOptions(server));
    }

    if (action === 'stop') {
      return runtime.stopConnector(connectorName, getConnectorScopeOptions(server));
    }

    if (action === 'config_get') {
      return runtime.getConfig(connectorName, getConnectorScopeOptions(server));
    }

    if (action === 'config_set') {
      if (!params.key) return { error: 'key is required for config_set action' };
      return runtime.setConfig(connectorName, params.key, params.value, getConnectorScopeOptions(server));
    }

    return { error: `Unknown connector action: ${params.action}` };
  });
}

module.exports = { registerConnectorTools };

