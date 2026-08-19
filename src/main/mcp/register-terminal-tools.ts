// @ts-nocheck
const path = require('path');
const { resolvePathTokens, tokenizePath } = require('../path-tokens');

function getPathTokenOptions(server) {
  const baseContext = server.getCurrentAgentContext?.()
    || server.getCurrentExecutionContext?.()
    || {};
  const sessionId = baseContext.sessionId ?? server.getCurrentSessionId?.() ?? null;
  const context = sessionId ? { ...baseContext, sessionId } : baseContext;
  return {
    agentManager: server._agentManager || null,
    sessionWorkspace: server._sessionWorkspace || null,
    executionDirectory: server._executionDirectory || null,
    sessionId,
    context
  };
}

async function resolveToolPath(server, rawPath, fallback) {
  if (!rawPath) {
    return fallback;
  }
  return resolvePathTokens(rawPath, getPathTokenOptions(server));
}

async function toPortablePath(server, absolutePath) {
  return tokenizePath(absolutePath, getPathTokenOptions(server));
}

async function getAllowedWorkspaceRoot(server) {
  if (!server._sessionWorkspace?.getWorkspacePath) {
    return null;
  }
  const sessionId = server.getCurrentSessionId?.() || 'default';
  return server._sessionWorkspace.getWorkspacePath(sessionId);
}

function getAllowedAgentinRoot(server) {
  if (server._agentManager?.basePath) {
    return path.dirname(server._agentManager.basePath);
  }
  if (server._sessionWorkspace?.basePath) {
    return path.dirname(server._sessionWorkspace.basePath);
  }
  return null;
}

async function tokenizeWorkspaceFileList(server, files = []) {
  return Promise.all(files.map(async file => ({
    ...file,
    path: await toPortablePath(server, file.path)
  })));
}

async function tokenizeWorkspaceSearchResults(server, results = []) {
  return Promise.all(results.map(async result => ({
    ...result,
    path: await toPortablePath(server, result.path)
  })));
}

async function getExecutionContextPayload(server) {
  const scope = server.getCurrentAgentContext?.() || server.getCurrentExecutionContext?.() || {};
  const context = server._executionDirectory?.getContext
    ? await server._executionDirectory.getContext(scope)
    : {
        rootPath: await server.getExecutionRoot(),
        configuredRoot: null,
        defaultRoot: await server.getExecutionRoot(),
        source: 'default',
        allowOutsideRoot: true
      };

  return {
    rootPath: await toPortablePath(server, context.rootPath),
    configuredRoot: context.configuredRoot ? await toPortablePath(server, context.configuredRoot) : null,
    defaultRoot: context.defaultRoot ? await toPortablePath(server, context.defaultRoot) : null,
    source: context.source || 'default',
    allowOutsideRoot: context.allowOutsideRoot === true
  };
}

async function getTerminalMode(server, execution = {}) {
  if (execution.allowOutsideExecutionRoot === true) {
    return 'system';
  }
  const context = execution.context || server.getCurrentAgentContext?.() || {};
  if (server.toolPermissionService?.getTerminalMode) {
    return server.toolPermissionService.getTerminalMode(context || {});
  }
  if (server.capabilityManager?.getTerminalMode) {
    return server.capabilityManager.getTerminalMode();
  }
  if (server._executionDirectory?.isOutsideAllowed && await server._executionDirectory.isOutsideAllowed()) {
    return 'system';
  }
  return 'workspace';
}

async function buildTerminalScopeRequest(server, params, resolvedCwd, currentMode, execution = {}) {
  const context = execution.context || server.getCurrentAgentContext?.() || {};
  return {
    needsPermission: true,
    permissionType: 'terminal_scope',
    requiredMode: 'system',
    currentMode,
    toolName: 'run_command',
    params,
    command: params.command,
    cwd: await toPortablePath(server, resolvedCwd),
    toolDefinition: server.tools?.get?.('run_command')?.definition || null,
    reason: 'terminal_scope_required',
    sessionId: context?.sessionId ?? server.getCurrentSessionId?.() ?? null,
    agentId: context?.agentId ?? null
  };
}

function resolveCommandTimeoutMs(params = {}) {
  const rawMs = params.timeout_ms;
  if (rawMs !== undefined) {
    const timeoutMs = Number(rawMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error('run_command timeout_ms must be a positive number');
    }
    return Math.ceil(timeoutMs);
  }

  const rawSeconds = params.timeout === undefined ? 30 : Number(params.timeout);
  if (!Number.isFinite(rawSeconds) || rawSeconds <= 0) {
    throw new Error('run_command timeout must be a positive number of seconds');
  }
  return Math.ceil(rawSeconds * 1000);
}

function registerTerminalTools(server) {
  server.registerTool('execution_root', {
    name: 'execution_root',
    description: 'Get or change the current execution workspace root used by file and terminal tools.',
    userDescription: 'Reads or updates the current project workspace root',
    example: 'TOOL:execution_root{"action":"set","path":"{agent_home}"}',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['get', 'set', 'reset'],
          description: 'Use "get" to inspect the current root, "set" to change it, or "reset" to return to the default root.'
        },
        path: {
          type: 'string',
          description: 'Directory path or path token to use when action is "set". Relative paths resolve from the current execution root.'
        }
      }
    }
  }, async (params = {}) => {
    const action = String(params.action || 'get').trim().toLowerCase();

    if (action === 'get') {
      return {
        success: true,
        action,
        ...(await getExecutionContextPayload(server))
      };
    }

    if (action === 'reset') {
      if (!server._executionDirectory?.clearRoot) {
        throw new Error('Execution directory service is unavailable');
      }
      const scope = server.getCurrentAgentContext?.() || server.getCurrentExecutionContext?.() || {};
      const nextContext = await server._executionDirectory.clearRoot(scope);
      server.emit('execution-context-updated', nextContext);
      return {
        success: true,
        action,
        ...(await getExecutionContextPayload(server))
      };
    }

    if (action === 'set') {
      if (!server._executionDirectory?.setRoot) {
        throw new Error('Execution directory service is unavailable');
      }
      if (!String(params.path || '').trim()) {
        throw new Error('execution_root action "set" requires a path');
      }
      const currentRoot = await server.getExecutionRoot();
      const resolvedPath = await resolveToolPath(server, params.path, currentRoot);
      const nextRoot = path.resolve(currentRoot, resolvedPath);
      const scope = server.getCurrentAgentContext?.() || server.getCurrentExecutionContext?.() || {};
      const nextContext = await server._executionDirectory.setRoot(nextRoot, scope);
      server.emit('execution-context-updated', nextContext);
      return {
        success: true,
        action,
        ...(await getExecutionContextPayload(server))
      };
    }

    throw new Error(`Unsupported action for execution_root: ${action}`);
  });

  server.registerTool('run_command', {
    name: 'run_command',
    description: 'Execute a shell command in the terminal. Returns stdout, stderr, and exit code. Terminal permission has modes: off blocks this tool, workspace allows commands whose cwd is inside the execution workspace/session workspace/agentin, and system allows cwd outside the workspace. If a task needs to search or work outside the workspace, call run_command with the needed cwd; the backend will request user approval for system terminal access when required.',
    userDescription: 'Runs a shell command and can request system terminal access for outside-workspace cwd',
    example: 'TOOL:run_command{"command":"dir","cwd":"C:/Users","output_to_file":true}',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
        cwd: { type: 'string', description: 'Working directory for the command (optional)' },
        timeout: { type: 'number', description: 'Timeout in seconds (default: 30)' },
        timeout_ms: { type: 'number', description: 'Timeout in milliseconds. Prefer timeout in seconds for model calls.' },
        output_to_file: {
          type: 'boolean',
          description: 'Save output to a workspace file instead of returning inline. Auto-triggers when output exceeds 1000 chars. Use for commands with large output (builds, installs, logs).',
          default: false
        }
      },
      required: ['command']
    }
  }, async (params, execution = {}) => {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);

    const defaultCwd = server.getExecutionRoot
      ? await server.getExecutionRoot()
      : process.cwd();
    const resolvedCwd = await resolveToolPath(server, params.cwd, defaultCwd);
    const terminalMode = await getTerminalMode(server, execution);
    try {
      if (terminalMode !== 'system') {
        await server.assertExecutionPathAllowed?.(resolvedCwd, {
          extraRoots: [
            await getAllowedWorkspaceRoot(server),
            getAllowedAgentinRoot(server)
          ].filter(Boolean)
        });
      }
    } catch (error) {
      if (error.code === 'OUTSIDE_EXECUTION_ROOT') {
        return buildTerminalScopeRequest(server, params, resolvedCwd, terminalMode, execution);
      }
      return {
        success: false,
        command: params.command,
        cwd: await toPortablePath(server, resolvedCwd),
        output_mode: 'inline',
        stdout: '',
        stderr: error.message,
        errorCode: error.code || 'EXECUTION_PATH_DENIED',
        exitCode: 1
      };
    }
    const requestedTimeout = resolveCommandTimeoutMs(params);
    const options = {
      cwd: resolvedCwd,
      timeout: requestedTimeout,
      maxBuffer: 1024 * 1024 * 5,
      shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/bash'
    };

    const outputThreshold = 1000;

    try {
      const { stdout, stderr } = await execAsync(params.command, options);
      const fullOutput = (stdout || '') + (stderr ? '\n--- stderr ---\n' + stderr : '');

      if (server._sessionWorkspace && (params.output_to_file || fullOutput.length > outputThreshold)) {
        const sessionId = server.getCurrentSessionId() || 'default';
        const label = params.command.split(/\s+/)[0];
        const result = server._sessionWorkspace.writeOutput(sessionId, label, fullOutput);
        if (server._artifactRegistry) {
          server._artifactRegistry.registerFile(sessionId, {
            name: result.fileName,
            path: result.filePath,
            source: 'run_command',
            category: 'log'
          });
        }
        const lineCount = fullOutput.split('\n').length;
        const summary = fullOutput.substring(0, 500);
        return {
          success: true,
          command: params.command,
          cwd: await toPortablePath(server, options.cwd),
          output_mode: 'file',
          file_path: await toPortablePath(server, result.filePath),
          file_name: result.fileName,
          file_size: result.size,
          line_count: lineCount,
          summary: summary + (fullOutput.length > 500 ? '\n... (truncated, see file)' : ''),
          exitCode: 0
        };
      }

      return {
        success: true,
        command: params.command,
        cwd: await toPortablePath(server, options.cwd),
        output_mode: 'inline',
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: 0
      };
    } catch (error) {
      const fullOutput = (error.stdout || '') + (error.stderr ? '\n--- stderr ---\n' + error.stderr : error.message);

      if (server._sessionWorkspace && (params.output_to_file || fullOutput.length > outputThreshold)) {
        const sessionId = server.getCurrentSessionId() || 'default';
        const label = params.command.split(/\s+/)[0] + '_error';
        const result = server._sessionWorkspace.writeOutput(sessionId, label, fullOutput);
        if (server._artifactRegistry) {
          server._artifactRegistry.registerFile(sessionId, {
            name: result.fileName,
            path: result.filePath,
            source: 'run_command:error',
            category: 'log'
          });
        }
        return {
          success: false,
          command: params.command,
          cwd: await toPortablePath(server, options.cwd),
          output_mode: 'file',
          file_path: await toPortablePath(server, result.filePath),
          file_name: result.fileName,
          summary: fullOutput.substring(0, 500),
          exitCode: error.code || 1
        };
      }

      return {
        success: false,
        command: params.command,
        cwd: await toPortablePath(server, options.cwd),
        output_mode: 'inline',
        stdout: error.stdout?.trim() || '',
        stderr: error.stderr?.trim() || error.message,
        exitCode: error.code || 1
      };
    }
  });

  server.registerTool('list_workspace', {
    name: 'list_workspace',
    description: 'List all files in the current session workspace. Workspace files include command outputs, temp files, and other session artifacts.',
    userDescription: 'Lists files in the session temp workspace',
    example: 'TOOL:list_workspace{}',
    inputSchema: { type: 'object' }
  }, async () => {
    if (!server._sessionWorkspace) return { error: 'Session workspace not initialized' };
    const sessionId = server.getCurrentSessionId() || 'default';
    const files = server._sessionWorkspace.listFiles(sessionId);
    const tokenizedFiles = await tokenizeWorkspaceFileList(server, files);
    return { sessionId, fileCount: tokenizedFiles.length, files: tokenizedFiles };
  });

  server.registerTool('search_workspace', {
    name: 'search_workspace',
    description: 'Search file contents in the session workspace (grep-like). Useful for finding specific output in command log files without loading entire files into context.',
    userDescription: 'Search text within session workspace files',
    example: 'TOOL:search_workspace{"query":"error"}',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search for in workspace files (case-insensitive)' }
      },
      required: ['query']
    }
  }, async (params) => {
    if (!server._sessionWorkspace) return { error: 'Session workspace not initialized' };
    const sessionId = server.getCurrentSessionId() || 'default';
    const results = server._sessionWorkspace.searchFiles(sessionId, params.query);
    const tokenizedResults = await tokenizeWorkspaceSearchResults(server, results);
    return { sessionId, query: params.query, resultCount: tokenizedResults.length, results: tokenizedResults };
  });
}

module.exports = { registerTerminalTools };
