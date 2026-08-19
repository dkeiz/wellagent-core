// @ts-nocheck
const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const A2AHttpServer = require('./a2a-http-server');
const A2ATargetExecutor = require('./a2a-target-executor');
const requestContextHelpers = require('./request-context');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8789;
const ENABLED_SETTING_KEY = 'a2a.enabled';
const PORT_SETTING_KEY = 'a2a.port';
const TERMINAL_STATES = new Set(['completed', 'failed', 'canceled']);
const OPAQUE_A2A_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJsonParse(rawValue, fallback = null) {
  if (!rawValue) return fallback;
  try {
    return JSON.parse(rawValue);
  } catch (_) {
    return fallback;
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeA2AOpaqueId(value, label, options = {}) {
  const allowNull = options.allowNull !== false;
  if (value === null || value === undefined || value === '') {
    if (allowNull) return null;
    throw new Error(`${label} is required`);
  }
  const normalized = String(value).trim();
  if (!normalized) {
    if (allowNull) return null;
    throw new Error(`${label} is required`);
  }
  if (!OPAQUE_A2A_ID_PATTERN.test(normalized)) {
    throw new Error(`Invalid ${label}`);
  }
  return normalized;
}

class A2AManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.db = options.db;
    this.aiService = options.aiService || null;
    this.dispatcher = options.dispatcher || null;
    this.externalChannelBridge = options.externalChannelBridge || null;
    this.windowManager = options.windowManager || null;
    this.container = options.container || null;
    this.requestContextService = options.requestContextService || options.container?.optional?.('requestContextService') || requestContextHelpers;
    this.userAuth = options.userAuth || options.container?.optional?.('userAuth') || null;
    this.companionAuth = options.companionAuth || null;
    this.baseDir = options.baseDir;
    this.targetsDir = options.targetsDir || path.join(this.baseDir, 'targets');
    this.tasksDir = options.tasksDir || path.join(this.baseDir, 'tasks');
    this.eventsDir = options.eventsDir || path.join(this.baseDir, 'events');
    this.host = DEFAULT_HOST;
    this.port = Number(options.defaultPort) || DEFAULT_PORT;
    this.server = null;
    this.activeRuns = new Map();
    this.taskSubscribers = new Map();
    this.targetExecutor = new A2ATargetExecutor(this);
  }

  async initialize() {
    for (const dir of [this.baseDir, this.targetsDir, this.tasksDir, this.eventsDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const savedPort = Number(await this.db.getSetting(PORT_SETTING_KEY));
    if (Number.isFinite(savedPort) && savedPort >= 1024 && savedPort <= 65535) {
      this.port = savedPort;
    }

    await this._seedBuiltinTargets();
    if (await this.isExposureEnabled()) {
      await this.start();
    }
  }

  async start() {
    if (this.server) {
      return this.getStatus();
    }

    this.server = new A2AHttpServer(this, {
      host: this.host,
      port: this.port
    });
    await this.server.start();
    await this.db.saveSetting(PORT_SETTING_KEY, String(this.port));
    this._broadcastStatus();
    return this.getStatus();
  }

  async stop() {
    if (!this.server) {
      return this.getStatus();
    }

    await this.server.stop();
    this.server = null;
    this._broadcastStatus();
    return this.getStatus();
  }

  async shutdown() {
    await this.stop();
    for (const runId of Array.from(this.activeRuns.keys())) {
      await this.cancelTask(runId);
    }
  }

  async isExposureEnabled() {
    return (await this.db.getSetting(ENABLED_SETTING_KEY)) === 'true';
  }

  getStatus() {
    const running = Boolean(this.server);
    const baseUrl = `http://${this.host}:${this.port}`;
    return {
      enabled: running,
      configuredEnabled: Boolean(this.server) || false,
      host: this.host,
      port: this.port,
      baseUrl,
      cardUrl: `${baseUrl}/.well-known/agent-card.json`,
      rpcUrl: `${baseUrl}/rpc`,
      targetsDir: this.targetsDir,
      tasksDir: this.tasksDir,
      eventsDir: this.eventsDir
    };
  }

  async getExposureStatus() {
    const configuredEnabled = await this.isExposureEnabled();
    const status = this.getStatus();
    return {
      ...status,
      enabled: configuredEnabled,
      running: Boolean(this.server)
    };
  }

  async setExposureEnabled(enabled) {
    const normalized = enabled === true;
    await this.db.saveSetting(ENABLED_SETTING_KEY, normalized ? 'true' : 'false');
    if (normalized) {
      await this.start();
    } else {
      await this.stop();
    }
    return this.getExposureStatus();
  }

  getAgentCard(baseUrl = `http://${this.host}:${this.port}`) {
    return {
      protocolVersion: '0.3.0',
      name: 'LocalAgent',
      description: 'LocalAgent desktop agent exposed through A2A on localhost.',
      version: '0.2.0',
      preferredTransport: 'JSONRPC',
      url: `${baseUrl}/rpc`,
      preferredInputModes: ['text'],
      preferredOutputModes: ['text'],
      defaultInputModes: ['text'],
      defaultOutputModes: ['text'],
      supportsAuthenticatedExtendedCard: false,
      capabilities: {
        streaming: true,
        pushNotifications: false,
        stateTransitionHistory: true
      },
      securitySchemes: [],
      skills: [
        {
          id: 'chat',
          name: 'Chat',
          description: 'General chat and reasoning through the LocalAgent runtime.',
          tags: ['chat', 'reasoning'],
          inputModes: ['text'],
          outputModes: ['text'],
          examples: ['Summarize this note.', 'Help me reason about this bug.']
        },
        {
          id: 'mcp-tools',
          name: 'MCP Tools',
          description: 'Use LocalAgent tools when the active permissions allow it.',
          tags: ['tools', 'mcp'],
          inputModes: ['text'],
          outputModes: ['text']
        },
        {
          id: 'workflow-execution',
          name: 'Workflow Execution',
          description: 'Run LocalAgent workflows and automation chains.',
          tags: ['workflow', 'automation'],
          inputModes: ['text'],
          outputModes: ['text']
        }
      ]
    };
  }

  _getCompanionAuth() {
    return this.companionAuth || this.container?.optional?.('companionAuth') || null;
  }

  _normalizeRequestContext(requestContext = null) {
    if (this.requestContextService?.normalizeRequestContext) {
      return this.requestContextService.normalizeRequestContext(requestContext || {});
    }
    return requestContext || {};
  }

  _extractLocalagentMetadata(params = {}) {
    if (!params || typeof params !== 'object') return {};
    const metadata = params.metadata && typeof params.metadata === 'object' ? params.metadata : {};
    const localagent = metadata.localagent && typeof metadata.localagent === 'object'
      ? metadata.localagent
      : (metadata.localAgent && typeof metadata.localAgent === 'object' ? metadata.localAgent : {});
    return localagent || {};
  }

  _readHeader(headers = {}, key) {
    const value = headers?.[key];
    if (Array.isArray(value)) {
      return String(value[0] || '').trim();
    }
    return String(value || '').trim();
  }

  _extractAuthToken(headers = {}) {
    const header = this._readHeader(headers, 'authorization');
    if (!header) return '';
    return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  }

  _createA2ARequestContext(user = null, options = {}) {
    const requestOptions = {
      deviceId: options.deviceId || null,
      requestId: options.requestId || null,
      sessionId: options.sessionId || null,
      user: user && typeof user === 'object' ? user : null,
      userId: typeof user === 'string'
        ? (String(user || '').trim() || null)
        : (String(user?.userId || '').trim() || null)
    };
    if (this.userAuth?.createA2ARequestContext) {
      return this.userAuth.createA2ARequestContext(user || null, requestOptions);
    }
    if (this.userAuth?.createRequestContext) {
      return this.userAuth.createRequestContext('a2a', requestOptions);
    }
    return this._normalizeRequestContext({
      source: 'a2a',
      userId: requestOptions.userId,
      sessionId: requestOptions.sessionId,
      deviceId: requestOptions.deviceId,
      requestId: requestOptions.requestId
    });
  }

  async resolveRpcRequestContext({ headers = {}, payload = {} } = {}) {
    const params = payload?.params || {};
    const metadata = this._extractLocalagentMetadata(params);
    const requestId = Object.prototype.hasOwnProperty.call(payload || {}, 'id')
      ? String(payload.id || '').trim()
      : '';
    const sessionId = String(
      metadata.sessionId
      || metadata.session_id
      || this._readHeader(headers, 'x-localagent-session-id')
      || ''
    ).trim() || null;
    const deviceId = String(
      this._readHeader(headers, 'x-localagent-device-id')
      || metadata.deviceId
      || metadata.device_id
      || ''
    ).trim() || null;

    const authToken = this._extractAuthToken(headers);
    const companionAuth = this._getCompanionAuth();
    if (authToken && companionAuth?.validateAccessToken) {
      const authResult = await companionAuth.validateAccessToken(authToken);
      if (!authResult?.valid) {
        return { ok: false, status: 401, error: authResult?.error || 'Unauthorized' };
      }
      const device = authResult.payload || {};
      const userId = String(device.userId || '').trim();
      if (!userId) {
        return { ok: false, status: 401, error: 'Authenticated A2A requests must resolve to a concrete user' };
      }
      const resolvedUser = this.userAuth?.getUser ? this.userAuth.getUser(userId) : null;
      return {
        ok: true,
        requestContext: this._createA2ARequestContext(resolvedUser || userId, {
          deviceId: String(device.deviceId || deviceId || '').trim() || null,
          requestId: requestId || null,
          sessionId
        })
      };
    }

    const explicitUserId = String(
      this._readHeader(headers, 'x-localagent-user-id')
      || metadata.userId
      || metadata.user_id
      || ''
    ).trim();
    if (!explicitUserId) {
      return { ok: false, status: 401, error: 'A2A user identity required' };
    }

    let resolvedUser = this.userAuth?.getUser ? this.userAuth.getUser(explicitUserId) : null;
    if (!resolvedUser && !this.userAuth) {
      resolvedUser = explicitUserId;
    }    if (!resolvedUser) {
      return { ok: false, status: 401, error: `Unknown A2A user: ${explicitUserId}` };
    }

    return {
      ok: true,
      requestContext: this._createA2ARequestContext(resolvedUser, {
        deviceId,
        requestId: requestId || this._readHeader(headers, 'x-localagent-request-id') || null,
        sessionId
      })
    };
  }

  _requireRequestContext(requestContext = null) {
    const context = this._normalizeRequestContext(requestContext);
    if (!context.userId) {
      throw new Error('A2A request context is required');
    }
    return context;
  }

  _resolveTaskRequestContext(task = {}) {
    return this._normalizeRequestContext(task?.requestContext || {
      source: 'a2a',
      userId: task?.userId || null
    });
  }

  _assertTaskAccess(task = null, requestContext = null) {
    if (!task || !requestContext) {
      return task;
    }
    const context = this._requireRequestContext(requestContext);
    const taskContext = this._resolveTaskRequestContext(task);
    if (!taskContext.userId || taskContext.userId !== context.userId) {
      throw new Error(`Task not found: ${task?.id || 'unknown'}`);
    }
    return task;
  }

  async handleRpc(payload = {}, options = {}) {
    const id = Object.prototype.hasOwnProperty.call(payload, 'id') ? payload.id : null;
    const method = String(payload?.method || '').trim();
    if (payload?.jsonrpc !== '2.0' || !method) {
      return this._jsonRpcError(id, -32600, 'Invalid JSON-RPC request');
    }

    try {
      let result;
      switch (method) {
        case 'message/send':
          result = await this._handleMessageSend(payload.params || {}, {
            forceStream: false,
            requestContext: options.requestContext || null
          });
          break;
        case 'tasks/get':
          result = await this._handleTasksGet(payload.params || {}, {
            requestContext: options.requestContext || null
          });
          break;
        case 'tasks/cancel':
          result = await this._handleTasksCancel(payload.params || {}, {
            requestContext: options.requestContext || null
          });
          break;
        default:
          return this._jsonRpcError(id, -32601, `Unsupported method: ${method}`);
      }
      return { jsonrpc: '2.0', id, result };
    } catch (error) {
      return this._jsonRpcError(id, -32000, error.message || String(error));
    }
  }

  async handleRpcStream(payload = {}, _req, res, options = {}) {
    const id = Object.prototype.hasOwnProperty.call(payload, 'id') ? payload.id : null;
    const method = String(payload?.method || '').trim();
    this._openSse(res);

    try {
      if (payload?.jsonrpc !== '2.0' || !method) {
        this._writeSseEvent(res, this._jsonRpcError(id, -32600, 'Invalid JSON-RPC request'));
        res.end();
        return;
      }

      if (method === 'message/stream') {
        const task = await this._handleMessageSend(payload.params || {}, {
          forceStream: true,
          requestContext: options.requestContext || null
        });
        this._writeSseEvent(res, { jsonrpc: '2.0', id, result: task });
        this._subscribeTask(task.id, res, id);
        return;
      }

      if (method === 'tasks/resubscribe') {
        const taskId = this._resolveTaskId(payload.params || {});
        if (!taskId) {
          this._writeSseEvent(res, this._jsonRpcError(id, -32602, 'task id is required'));
          res.end();
          return;
        }
        const task = await this.getRun(taskId, { requestContext: options.requestContext || null });
        if (!task) {
          this._writeSseEvent(res, this._jsonRpcError(id, -32004, `Task not found: ${taskId}`));
          res.end();
          return;
        }
        this._writeSseEvent(res, { jsonrpc: '2.0', id, result: this._serializeTask(task) });
        this._subscribeTask(taskId, res, id);
        return;
      }

      this._writeSseEvent(res, this._jsonRpcError(id, -32601, `Unsupported method: ${method}`));
      res.end();
    } catch (error) {
      this._writeSseEvent(res, this._jsonRpcError(id, -32000, error.message || String(error)));
      res.end();
    }
  }

  async listTargets() {
    return this.targetExecutor.listTargets();
  }

  async describeTarget(targetId) {
    return this.targetExecutor.describeTarget(targetId);
  }

  async probeTarget(targetId) {
    return this.targetExecutor.probeTarget(targetId);
  }

  async callTarget(targetId, payload = {}) {
    return this.targetExecutor.callTarget(targetId, payload);
  }

  async discoverA2A(rawUrl) {
    return this.targetExecutor.discoverA2A(rawUrl);
  }

  async getRun(runId, options = {}) {
    const normalizedRunId = this._normalizeTaskId(runId, { allowNull: false });
    const filePath = this._resolveTaskFilePath(normalizedRunId);
    if (!fs.existsSync(filePath)) return null;
    const task = safeJsonParse(fs.readFileSync(filePath, 'utf-8'), null);
    return this._assertTaskAccess(task, options.requestContext || null);
  }

  async cancelTask(taskId, options = {}) {
    const task = await this.getRun(taskId, options?.requestContext ? { requestContext: options.requestContext } : {});
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    if (this._isTerminalState(task.status?.state)) {
      return this._serializeTask(task);
    }

    const runner = this.activeRuns.get(taskId);
    if (runner?.timer) {
      clearTimeout(runner.timer);
    }
    if (runner?.child) {
      try {
        runner.child.kill();
      } catch (_) {}
    }
    if (runner?.kind === 'local-chat' && this.externalChannelBridge?.stopGeneration) {
      try {
        await this.externalChannelBridge.stopGeneration();
      } catch (_) {}
    }
    if (runner) {
      runner.canceled = true;
      this.activeRuns.delete(taskId);
    }

    task.status = {
      state: 'canceled',
      timestamp: new Date().toISOString()
    };
    task.metadata.updatedAt = new Date().toISOString();
    await this._saveTask(task);
    this._publishTask(task.id, this._serializeTask(task));
    return this._serializeTask(task);
  }

  async _handleMessageSend(params = {}, options = {}) {
    const requestContext = this._requireRequestContext(options.requestContext || null);
    const {
      text,
      taskId,
      contextId,
      blocking,
      mockResponse,
      delayMs,
      metadata
    } = this._extractInboundMessage(params, options);

    let task = taskId ? await this.getRun(taskId, { requestContext }) : null;
    if (task && this._isTerminalState(task.status?.state)) {
      throw new Error(`Task "${task.id}" is already in terminal state "${task.status.state}"`);
    }
    if (task && task.status?.state === 'working') {
      throw new Error(`Task "${task.id}" is already working`);
    }

    if (!task) {
      task = this._createTaskRecord({
        id: taskId || crypto.randomUUID(),
        direction: 'inbound',
        bridgeType: 'a2a',
        status: 'submitted',
        contextId: contextId || crypto.randomUUID(),
        history: [],
        artifacts: [],
        metadata: {},
        requestContext,
        userId: requestContext.userId
      });
    }

    const userMessage = this._buildTextMessage('user', text, task.id, task.contextId);
    task.history.push(userMessage);
    task.status = {
      state: 'working',
      timestamp: new Date().toISOString()
    };
    task.metadata.updatedAt = new Date().toISOString();
    task.metadata.lastRequest = { metadata: clone(metadata || {}), requestContext: clone(requestContext) };
    await this._saveTask(task);
    this._publishTask(task.id, this._serializeTask(task));

    const runner = {
      canceled: false,
      kind: 'local-chat',
      startedAt: Date.now()
    };
    this.activeRuns.set(task.id, runner);

    const runWork = async () => {
      try {
        if (delayMs > 0) {
          await sleep(delayMs);
        }
        if (runner.canceled) return;

        let response;
        if (typeof mockResponse === 'string') {
          response = {
            content: mockResponse,
            model: 'mock-a2a',
            provider: 'local-mock'
          };
        } else {
          if (!this.externalChannelBridge?.requestReply) {
            throw new Error('External channel bridge is not available');
          }
          response = await this.externalChannelBridge.requestReply({
            text,
            duplicate: false,
            sessionId: task.sessionId || null,
            requestContext,
            channelMeta: {
              channel: 'a2a',
              chatId: task.contextId,
              messageId: userMessage.messageId,
              contentType: 'text'
            }
          });
        }

        if (runner.canceled) return;
        task.sessionId = response?.sessionId || task.sessionId || null;
        const assistantText = String(response?.content || '').trim();
        const assistantMessage = this._buildTextMessage('agent', assistantText, task.id, task.contextId);
        task.history.push(assistantMessage);
        task.artifacts = [this._buildTextArtifact(assistantText, task.id, task.contextId)];
        task.status = {
          state: 'completed',
          timestamp: new Date().toISOString()
        };
        task.metadata.updatedAt = new Date().toISOString();
        task.metadata.provider = response?.provider || '';
        task.metadata.model = response?.model || '';
        await this._saveTask(task);
        this._publishTask(task.id, this._serializeTask(task));
      } catch (error) {
        if (runner.canceled) return;
        task.status = {
          state: 'failed',
          message: error.message,
          timestamp: new Date().toISOString()
        };
        task.metadata.updatedAt = new Date().toISOString();
        await this._saveTask(task);
        this._publishTask(task.id, this._serializeTask(task));
      } finally {
        this.activeRuns.delete(task.id);
      }
    };

    if (blocking) {
      await runWork();
      return this._serializeTask(await this.getRun(task.id, { requestContext }));
    }

    runner.timer = setTimeout(() => {
      runWork().catch(() => {});
    }, 0);
    return this._serializeTask(task);
  }

  async _handleTasksGet(params = {}, options = {}) {
    const taskId = this._resolveTaskId(params);
    if (!taskId) {
      throw new Error('task id is required');
    }
    const task = await this.getRun(taskId, { requestContext: options.requestContext || null });
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    return this._serializeTask(task, { historyLength: Number(params.historyLength) || 0 });
  }

  async _handleTasksCancel(params = {}, options = {}) {
    const taskId = this._resolveTaskId(params);
    if (!taskId) {
      throw new Error('task id is required');
    }
    return this.cancelTask(taskId, { requestContext: options.requestContext || null });
  }

  _resolveTaskId(params = {}) {
    return this._normalizeTaskId(params.id || params.taskId || '', { allowNull: true });
  }

  _extractInboundMessage(params = {}, options = {}) {
    const message = params.message && typeof params.message === 'object'
      ? params.message
      : {};
    const parts = Array.isArray(message.parts) ? message.parts : [];
    const textFromParts = parts
      .filter((part) => String(part?.type || 'text') === 'text')
      .map((part) => String(part?.text || ''))
      .join('\n')
      .trim();
    const text = String(params.prompt || textFromParts || '').trim();
    if (!text) {
      throw new Error('A2A message text is required');
    }

    const localMeta = params?.metadata?.localagent || params?.metadata?.localAgent || {};
    const blocking = options.forceStream === true
      ? false
      : (params?.configuration?.blocking === true);

    return {
      text,
      taskId: this._normalizeTaskId(message.taskId || params.taskId || '', { allowNull: true }),
      contextId: this._normalizeContextId(message.contextId || params.contextId || '', { allowNull: true }),
      blocking,
      mockResponse: typeof localMeta.mockResponse === 'string' ? localMeta.mockResponse : null,
      delayMs: Math.max(0, Number(localMeta.delayMs) || 0),
      metadata: params.metadata || {}
    };
  }

  _createTaskRecord(input = {}) {
    return {
      kind: 'task',
      id: this._normalizeTaskId(input.id || crypto.randomUUID(), { allowNull: false }),
      contextId: this._normalizeContextId(input.contextId || crypto.randomUUID(), { allowNull: false }),
      direction: input.direction || 'inbound',
      bridgeType: input.bridgeType || 'a2a',
      targetId: input.targetId || null,
      userId: String(input.userId || input.requestContext?.userId || '').trim() || null,
      requestContext: this._normalizeRequestContext(input.requestContext || {
        source: input.bridgeType || 'a2a',
        userId: input.userId || null
      }),
      status: {
        state: input.status || 'submitted',
        timestamp: new Date().toISOString()
      },
      history: Array.isArray(input.history) ? input.history : [],
      artifacts: Array.isArray(input.artifacts) ? input.artifacts : [],
      metadata: {
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...(input.metadata || {})
      }
    };
  }

  _clone(value) {
    return clone(value);
  }

  _buildTextMessage(role, text, taskId, contextId) {
    return {
      kind: 'message',
      role,
      messageId: crypto.randomUUID(),
      taskId,
      contextId,
      parts: [
        {
          type: 'text',
          text: String(text || '')
        }
      ],
      timestamp: new Date().toISOString()
    };
  }

  _buildTextArtifact(text, taskId, contextId) {
    return {
      artifactId: crypto.randomUUID(),
      taskId,
      contextId,
      name: 'response.txt',
      mimeType: 'text/plain',
      parts: [
        {
          type: 'text',
          text: String(text || '')
        }
      ]
    };
  }

  async _saveTask(task) {
    const normalized = clone(task);
    normalized.id = this._normalizeTaskId(normalized.id, { allowNull: false });
    normalized.contextId = this._normalizeContextId(normalized.contextId, { allowNull: false });
    normalized.metadata = {
      ...(normalized.metadata || {}),
      updatedAt: new Date().toISOString()
    };
    fs.writeFileSync(
      this._resolveTaskFilePath(normalized.id),
      JSON.stringify(normalized, null, 2),
      'utf-8'
    );
    this._appendTaskEvent(normalized.id, {
      timestamp: new Date().toISOString(),
      state: normalized.status?.state || 'unknown'
    });
    return normalized;
  }

  _appendTaskEvent(taskId, event) {
    const filePath = this._resolveTaskEventFilePath(this._normalizeTaskId(taskId, { allowNull: false }));
    fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, 'utf-8');
  }

  _normalizeTaskId(value, options = {}) {
    return normalizeA2AOpaqueId(value, 'task id', options);
  }

  _normalizeContextId(value, options = {}) {
    return normalizeA2AOpaqueId(value, 'context id', options);
  }

  _resolveTaskFilePath(taskId) {
    const normalizedTaskId = this._normalizeTaskId(taskId, { allowNull: false });
    return path.join(this.tasksDir, `${normalizedTaskId}.json`);
  }

  _resolveTaskEventFilePath(taskId) {
    const normalizedTaskId = this._normalizeTaskId(taskId, { allowNull: false });
    return path.join(this.eventsDir, `${normalizedTaskId}.jsonl`);
  }

  _serializeTask(task, options = {}) {
    const output = clone(task || {});
    const historyLength = Number(options.historyLength) || 0;
    if (historyLength > 0 && Array.isArray(output.history) && output.history.length > historyLength) {
      output.history = output.history.slice(output.history.length - historyLength);
    }
    return output;
  }

  _isTerminalState(state) {
    return TERMINAL_STATES.has(String(state || '').trim().toLowerCase());
  }

  _jsonRpcError(id, code, message) {
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message
      }
    };
  }

  _openSse(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive'
    });
  }

  _writeSseEvent(res, payload) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  _subscribeTask(taskId, res, requestId) {
    const subscriber = { res, requestId };
    const set = this.taskSubscribers.get(taskId) || new Set();
    set.add(subscriber);
    this.taskSubscribers.set(taskId, set);

    const cleanup = () => {
      const current = this.taskSubscribers.get(taskId);
      if (!current) return;
      current.delete(subscriber);
      if (current.size === 0) {
        this.taskSubscribers.delete(taskId);
      }
    };

    res.on('close', cleanup);
    res.on('error', cleanup);

    this.getRun(taskId).then((task) => {
      if (task && this._isTerminalState(task.status?.state)) {
        this._writeSseEvent(res, {
          jsonrpc: '2.0',
          id: requestId,
          result: this._serializeTask(task)
        });
        res.end();
        cleanup();
      }
    }).catch(() => {});
  }

  _publishTask(taskId, snapshot) {
    const subscribers = this.taskSubscribers.get(taskId);
    if (!subscribers || subscribers.size === 0) return;

    for (const subscriber of Array.from(subscribers)) {
      try {
        this._writeSseEvent(subscriber.res, {
          jsonrpc: '2.0',
          id: subscriber.requestId,
          result: snapshot
        });
        if (this._isTerminalState(snapshot?.status?.state)) {
          subscriber.res.end();
        }
      } catch (_) {
        try {
          subscriber.res.end();
        } catch (_) {}
      }
    }

    if (this._isTerminalState(snapshot?.status?.state)) {
      this.taskSubscribers.delete(taskId);
    }
  }

  _broadcastStatus() {
    if (!this.windowManager?.send) return;
    this.windowManager.send('a2a-status-update', this.getStatus());
  }

  async _seedBuiltinTargets() {
    const builtins = [
      {
        id: 'codex',
        label: 'Codex',
        bridgeType: 'provider',
        enabled: true,
        capabilities: { chat: true, streaming: false },
        transport: { type: 'provider' },
        execution: { provider: 'local-codex' },
        privacy: { localOnly: false },
        defaults: {}
      },
      {
        id: 'lmstudio',
        label: 'LM Studio',
        bridgeType: 'provider',
        enabled: true,
        capabilities: { chat: true, streaming: false },
        transport: { type: 'provider' },
        execution: { provider: 'lmstudio' },
        privacy: { localOnly: true },
        defaults: {}
      },
      {
        id: 'comfyui',
        label: 'ComfyUI',
        bridgeType: 'workflow-http',
        enabled: true,
        capabilities: { workflow: true, artifacts: true },
        transport: {
          baseUrl: 'http://127.0.0.1:8188',
          submitPath: '/prompt',
          historyPathTemplate: '/history/{id}',
          probePath: '/system_stats'
        },
        execution: {
          payloadField: 'prompt'
        },
        privacy: { localOnly: true },
        defaults: {
          pollIntervalMs: 250,
          timeoutMs: 15000
        }
      }
    ];

    for (const manifest of builtins) {
      const filePath = path.join(this.targetsDir, `${manifest.id}.json`);
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, JSON.stringify(manifest, null, 2), 'utf-8');
      }
    }
  }
}

module.exports = {
  A2AManager,
  DEFAULT_HOST,
  DEFAULT_PORT
};




