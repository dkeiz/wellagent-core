// @ts-nocheck
const { EventEmitter } = require('events');
const { registerConnectorTools } = require('./mcp/register-connector-tools');
const { registerAgentTools } = require('./mcp/register-agent-tools');
const { registerCoreTools } = require('./mcp/register-core-tools');
const { registerFileTools } = require('./mcp/register-file-tools');
const { ArtifactExecutionJournal } = require('./artifact-execution-journal');
const { registerMediaTools } = require('./mcp/register-media-tools');
const { registerPromptTools } = require('./mcp/register-prompt-tools');
const { registerTerminalTools } = require('./mcp/register-terminal-tools');
const { registerTimerTools } = require('./mcp/register-timer-tools');
const { registerWebSystemTools } = require('./mcp/register-web-system-tools');
const { registerWorkflowTools } = require('./mcp/register-workflow-tools');
const { registerResearchTools } = require('./mcp/register-research-tools');
const { registerA2ATools } = require('./mcp/register-a2a-tools');
const { parseToolCall } = require('./mcp/tool-call-parser');
const {
  normalizeCustomToolSandboxPolicy,
  runCustomToolInSandbox
} = require('./custom-tool-sandbox');
const {
  assessPrivateTool,
  getPrivateSessionId
} = require('./private-execution-policy');

const BUILT_IN_TOOL_REGISTRARS = [
  registerCoreTools,
  registerAgentTools,
  registerPromptTools,
  registerConnectorTools,
  registerWorkflowTools,
  registerResearchTools,
  registerA2ATools,
  registerTimerTools,
  registerFileTools,
  registerWebSystemTools,
  registerMediaTools,
  registerTerminalTools
];

class MCPServer extends EventEmitter {
  constructor(db, capabilityManager = null) {
    super();
    this.db = db;
    this.capabilityManager = capabilityManager;
    this.aiService = null;
    this.tools = new Map();
    this.toolStates = new Map();
    this.proxyServers = new Map();
    this._executionContextStack = [];
    this._currentAgentContext = null;
    this.runtimePolicy = null;
    this.toolPermissionService = null;
    this.initializeBuiltInTools();
  }

  setAIService(aiService) {
    this.aiService = aiService;
  }

  setAgentLoop(agentLoop) {
    this._agentLoop = agentLoop;
  }

  setCurrentSessionId(sessionId) {
    this._currentSessionId = sessionId;
  }

  getCurrentSessionId() {
    const activeContext = this._executionContextStack[this._executionContextStack.length - 1];
    if (activeContext && activeContext.sessionId !== undefined) {
      return activeContext.sessionId;
    }
    return this._currentSessionId;
  }

  getCurrentExecutionContext() {
    return this._executionContextStack[this._executionContextStack.length - 1] || null;
  }

  setCurrentAgentContext(context = null) {
    this._currentAgentContext = context && typeof context === 'object' ? { ...context } : null;
  }

  getCurrentAgentContext() {
    const activeContext = this.getCurrentExecutionContext();
    if (!activeContext && !this._currentAgentContext) {
      return null;
    }
    return {
      ...(this._currentAgentContext || {}),
      ...(activeContext || {})
    };
  }

  setConnectorRuntime(connectorRuntime) {
    this._connectorRuntime = connectorRuntime;
  }

  setA2AManager(a2aManager) {
    this._a2aManager = a2aManager || null;
  }

  setTimerManager(timerManager) {
    this._timerManager = timerManager || null;
  }

  setPromptFileManager(promptFileManager) {
    this._promptFileManager = promptFileManager;
  }

  setSessionWorkspace(sessionWorkspace) {
    this._sessionWorkspace = sessionWorkspace;
  }

  setArtifactRegistry(artifactRegistry) {
    this._artifactRegistry = artifactRegistry || null;
    this._artifactExecutionJournal = new ArtifactExecutionJournal(this._artifactRegistry);
  }

  setExecutionDirectory(executionDirectory) {
    this._executionDirectory = executionDirectory || null;
  }

  setRuntimePolicy(runtimePolicy) {
    this.runtimePolicy = runtimePolicy || null;
  }

  async getExecutionRoot(scope = null) {
    const context = scope || this.getCurrentAgentContext() || this.getCurrentExecutionContext() || {};
    return this._executionDirectory?.getRoot
      ? this._executionDirectory.getRoot(context)
      : process.cwd();
  }

  async assertExecutionPathAllowed(pathValue, options = {}) {
    if (!this._executionDirectory?.assertPathAllowed) {
      return true;
    }
    const context = this.getCurrentAgentContext() || this.getCurrentExecutionContext() || {};
    return this._executionDirectory.assertPathAllowed(pathValue, { ...context, ...options });
  }

  setWorkflowManager(workflowManager) {
    this._workflowManager = workflowManager;
  }

  setAgentManager(agentManager) {
    this._agentManager = agentManager;
  }

  setKnowledgeManager(knowledgeManager) {
    this._knowledgeManager = knowledgeManager;
  }

  setToolPermissionService(toolPermissionService) {
    this.toolPermissionService = toolPermissionService || null;
  }

  setResearchRuntime(researchRuntime) {
    this._researchRuntime = researchRuntime;
  }

  initializeBuiltInTools() {
    for (const registerTools of BUILT_IN_TOOL_REGISTRARS) {
      registerTools(this);
    }
    this.loadToolGroups();
  }

  registerTool(name, definition, handler) {
    if (this.tools.has(name)) {
      throw new Error(`Tool already registered: ${name}`);
    }
    const normalizedDefinition = { ...definition };
    const scopeSlugs = this._normalizeToolAgentScope(normalizedDefinition);
    if (scopeSlugs) {
      normalizedDefinition.agentScopeSlugs = scopeSlugs;
    } else {
      delete normalizedDefinition.agentScopeSlugs;
    }
    this.tools.set(name, { definition: normalizedDefinition, handler });
  }

  getToolsByNames(toolNames = [], { includeInternal = false } = {}) {
    const output = [];
    const seen = new Set();

    for (const toolName of toolNames) {
      const key = String(toolName || '').trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const tool = this.tools.get(key);
      if (!tool?.definition) continue;
      if (tool.definition.internal === true && !includeInternal) continue;
      output.push(tool.definition);
    }

    return output;
  }

  async withExecutionContext(context, fn) {
    this._executionContextStack.push(context || {});
    try {
      return await fn();
    } finally {
      this._executionContextStack.pop();
    }
  }

  _resolveTimeoutMs(toolName, params, defaultTimeoutMs) {
    const baseTimeout = Math.max(1, Number(defaultTimeoutMs) || 5000);
    const normalizedName = String(toolName || '').trim();
    const toolDefinition = this.tools.get(normalizedName)?.definition || {};
    const declaredTimeoutMs = Number(toolDefinition.executionTimeoutMs);
    const effectiveBaseTimeout = Number.isFinite(declaredTimeoutMs) && declaredTimeoutMs > 0
      ? Math.max(baseTimeout, Math.ceil(declaredTimeoutMs))
      : baseTimeout;
    if (normalizedName === 'run_command') {
      const requestedTimeoutMs = Number(params?.timeout_ms);
      if (Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0) {
        return Math.ceil(requestedTimeoutMs);
      }
      const requestedTimeoutSeconds = Number(params?.timeout);
      if (Number.isFinite(requestedTimeoutSeconds) && requestedTimeoutSeconds > 0) {
        return Math.ceil(requestedTimeoutSeconds * 1000);
      }
      return 30000;
    }
    if (normalizedName === 'inner_browser') {
      const requestedTimeoutMs = Number(params?.timeout_ms);
      if (Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0) {
        return Math.ceil(requestedTimeoutMs);
      }
      return Math.max(effectiveBaseTimeout, 15000);
    }

    const timeoutParameter = String(toolDefinition.timeoutParameter || '').trim();
    if (timeoutParameter) {
      const requestedToolTimeout = Number(params?.[timeoutParameter]);
      if (Number.isFinite(requestedToolTimeout) && requestedToolTimeout > 0) {
        return Math.ceil(requestedToolTimeout);
      }
    }
    const requestedTimeout = Math.max(1, Number(params?.timeout_ms) || 0);
    const isAwaitedSubagent = (
      (normalizedName === 'subagent' || normalizedName === 'run_subagent')
      && params?.wait === true
      && requestedTimeout > 0
    );

    if (!isAwaitedSubagent) {
      return effectiveBaseTimeout;
    }

    // Let awaited delegated runs use the requested child timeout, plus a small
    // cushion so the outer MCP tool wrapper does not fire first.
    return Math.max(effectiveBaseTimeout, requestedTimeout + 1000);
  }

  async _persistToolCall(eventData, activeContext, suppressTrace) {
    if (suppressTrace || !this.db?.addToolCall) return null;
    try {
      return await this.db.addToolCall(eventData, {
        requestContext: activeContext?.requestContext || null,
        userId: activeContext?.userId || activeContext?.requestContext?.userId || undefined
      });
    } catch (error) {
      console.error(`[MCP] Failed to persist tool call ${eventData?.toolName || 'unknown'}:`, error.message);
      return null;
    }
  }

  async executeTool(toolName, params = {}, toolCallId = null, options = {}) {
    const bypassPermissions = options && options.bypassPermissions === true;
    const executionContext = options && options.context ? options.context : null;
    const activeContext = executionContext || this.getCurrentAgentContext() || null;
    const tool = this.tools.get(toolName);
    if (!tool) {
      if (!getPrivateSessionId(this, activeContext)) {
        this.emit('tool-executed', { toolName, success: false, error: 'Tool not found' });
      }
      throw new Error(`Tool not found: ${toolName}`);
    }

    const allowedForAgent = await this._isToolAllowedByAgentScope(
      tool.definition,
      activeContext
    );
    if (!allowedForAgent) {
      const scopedError = `Tool "${toolName}" is not allowed for the active agent scope`;
      if (!getPrivateSessionId(this, activeContext)) {
        this.emit('tool-executed', { toolName, success: false, error: scopedError });
      }
      throw new Error(scopedError);
    }

    const isInternalTool = tool.definition?.internal === true;
    const privateAssessment = await assessPrivateTool(this, toolName, tool, params, activeContext);
    const suppressTrace = privateAssessment.privateMode && options.tracePrivate !== true;

    if (this.runtimePolicy?.assert && !isInternalTool) {
      this.runtimePolicy.assert({
        principal: activeContext?.principal || null,
        profile: activeContext?.runtimePolicyProfile || activeContext?.policyProfile || null,
        action: 'tool.execute',
        resource: toolName,
        context: activeContext || {},
        metadata: {
          toolName,
          definition: tool.definition
        }
      });
    }

    if (!bypassPermissions && !isInternalTool) {
      if (this.toolPermissionService) {
        const allowedByProfile = await this.toolPermissionService.isToolAllowed({
          toolName,
          context: activeContext || {}
        });
        if (!allowedByProfile) {
          return {
            needsPermission: true,
            toolName,
            params,
            toolDefinition: tool.definition,
            reason: 'profile_disabled',
            sessionId: activeContext?.sessionId ?? this.getCurrentSessionId(),
            agentId: activeContext?.agentId ?? null
          };
        }
      } else {
        if (this.capabilityManager && !this.capabilityManager.isToolActive(toolName)) {
          const permissionRequest = {
            needsPermission: true,
            toolName,
            params,
            toolDefinition: tool.definition,
            reason: 'capability_group_disabled',
            sessionId: activeContext?.sessionId ?? this.getCurrentSessionId(),
            agentId: activeContext?.agentId ?? null
          };
          console.log(`[MCP] Tool ${toolName} blocked by CapabilityManager`);
          return permissionRequest;
        }

        const isActive = await this.getToolActiveState(toolName);
        if (!isActive) {
          const permissionRequest = {
            needsPermission: true,
            toolName,
            params,
            toolDefinition: tool.definition,
            reason: 'tool_disabled',
            sessionId: activeContext?.sessionId ?? this.getCurrentSessionId(),
            agentId: activeContext?.agentId ?? null
          };
          console.log(`[MCP] Tool ${toolName} disabled (DB state), requesting permission`);
          return permissionRequest;
        }
      }
    }

    try {
      if (tool.definition.inputSchema?.properties) {
        for (const [key, prop] of Object.entries(tool.definition.inputSchema.properties)) {
          if (params[key] === undefined && prop.default !== undefined) {
            params[key] = prop.default;
          }
        }
      }

      if (tool.definition.inputSchema) {
        this.validateInput(params, tool.definition.inputSchema);
      }

      const configuredTimeoutMs = parseInt(await this.db.getSetting('tool_timeout_ms') || '5000', 10);
      const timeoutMs = this._resolveTimeoutMs(toolName, params, configuredTimeoutMs);
      let artifactAgentInfo = null;
      let artifactAgentId = activeContext?.agentId || null;
      if (!artifactAgentId && activeContext?.sessionId && this.db?.getChatSessionById) {
        const session = await this.db.getChatSessionById(activeContext.sessionId, {
          requestContext: activeContext.requestContext || null
        }).catch(() => null);
        artifactAgentId = session?.agent_id || null;
      }
      if (artifactAgentId && this._agentManager?.getAgent && this._agentManager?.resolveAgentFolder) {
        const scopeOptions = { requestContext: activeContext.requestContext || null };
        const agent = await this._agentManager.getAgent(artifactAgentId, scopeOptions);
        const folderPath = agent
          ? await this._agentManager.resolveAgentFolder(artifactAgentId, scopeOptions)
          : null;
        if (agent && folderPath) artifactAgentInfo = { ...agent, folderPath };
      }
      const invokeHandler = () => Promise.resolve().then(() => tool.handler(params, {
        timeoutMs,
        toolName,
        context: activeContext,
        allowExternalCapture: options.allowExternalCapture === true
          || options.allowExternalCaptureOnce === true,
        allowOutsideExecutionRoot: options.allowOutsideExecutionRoot === true
          || options.allowOutsideExecutionRootOnce === true
      }));
      const invokeWithArtifacts = () => this._artifactExecutionJournal?.run
        ? this._artifactExecutionJournal.run({
            agentInfo: artifactAgentInfo,
            sessionId: activeContext?.sessionId ?? this.getCurrentSessionId(),
            source: toolName
          }, invokeHandler)
        : invokeHandler();
      const runToolHandler = () => this.executeWithTimeout(invokeWithArtifacts(), timeoutMs, toolName);
      const result = executionContext
        ? await this.withExecutionContext(
          executionContext,
          runToolHandler
        )
        : await runToolHandler();

      if (result && result.needsPermission) {
        return {
          ...result,
          toolName: result.toolName || toolName,
          params: result.params || params,
          toolDefinition: result.toolDefinition || tool.definition,
          sessionId: result.sessionId ?? activeContext?.sessionId ?? this.getCurrentSessionId(),
          agentId: result.agentId ?? activeContext?.agentId ?? null
        };
      }

      if (toolName.startsWith('calendar_')) this.emit('calendar-update');
      else if (toolName.startsWith('todo_')) this.emit('todo-update');

      const enrichedResult = {
        toolCallId: toolCallId || `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        toolName,
        timestamp: new Date().toISOString(),
        success: true,
        sessionId: activeContext?.sessionId !== undefined ? activeContext.sessionId : this.getCurrentSessionId(),
        source: activeContext?.source || null,
        agentId: activeContext?.agentId ?? null,
        params,
        result
      };

      await this._persistToolCall(enrichedResult, activeContext, suppressTrace);
      if (!suppressTrace) {
        this.emit('tool-executed', enrichedResult);
      }
      return enrichedResult;
    } catch (error) {
      const errorResult = {
        toolCallId: toolCallId || `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        toolName,
        timestamp: new Date().toISOString(),
        success: false,
        sessionId: activeContext?.sessionId !== undefined ? activeContext.sessionId : this.getCurrentSessionId(),
        source: activeContext?.source || null,
        agentId: activeContext?.agentId ?? null,
        params,
        error: error.message
      };
      await this._persistToolCall(errorResult, activeContext, suppressTrace);
      if (!suppressTrace) {
        this.emit('tool-executed', errorResult);
      }
      throw error;
    }
  }

  async executeWithTimeout(promise, timeoutMs, toolName) {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`Tool '${toolName}' timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([promise, timeoutPromise]);
      clearTimeout(timeoutId);
      return result;
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }

  async getToolActiveState(toolName) {
    try {
      if (this.toolStates.has(toolName)) {
        return this.toolStates.get(toolName);
      }

      const key = `tool.${toolName}.active`;
      const value = await this.db.getSetting(key);
      const isActive = value !== 'false';
      this.toolStates.set(toolName, isActive);
      return isActive;
    } catch (error) {
      console.error('Error getting tool state:', error);
      return true;
    }
  }

  async setToolActiveState(toolName, active) {
    try {
      const key = `tool.${toolName}.active`;
      const value = active ? 'true' : 'false';
      await this.db.setSetting(key, value);
      this.toolStates.set(toolName, active);
      console.log(`Tool ${toolName} ${active ? 'enabled' : 'disabled'}`);
      return { toolName, active };
    } catch (error) {
      console.error('Error setting tool state:', error);
      throw error;
    }
  }

  parseToolCall(text) {
    return parseToolCall(this, text);
  }

  async executeToolCalls(text) {
    const calls = this.parseToolCall(text);
    const results = [];

    for (const call of calls) {
      try {
        const result = await this.executeTool(call.toolName, call.params);
        results.push({ tool: call.toolName, success: true, result });
      } catch (error) {
        results.push({ tool: call.toolName, success: false, error: error.message });
      }
    }

    return results;
  }

  validateInput(params, schema) {
    if (schema.required) {
      for (const requiredField of schema.required) {
        if (params[requiredField] === undefined) {
          throw new Error(`Missing required field: ${requiredField}`);
        }
      }
    }

    for (const [field, value] of Object.entries(params)) {
      const fieldSchema = schema.properties[field];
      if (!fieldSchema) {
        throw new Error(`Unknown field: ${field}`);
      }

      const actualType = Array.isArray(value)
        ? 'array'
        : value === null
          ? 'null'
          : typeof value;

      if (fieldSchema.type && actualType !== fieldSchema.type) {
        throw new Error(`Field ${field} must be of type ${fieldSchema.type}`);
      }

      if (fieldSchema.format === 'date-time' && isNaN(Date.parse(value))) {
        throw new Error(`Field ${field} must be a valid date-time string`);
      }
    }
  }

  getTools() {
    const tools = [];
    for (const [, tool] of this.tools) {
      if (tool.definition?.internal === true) continue;
      tools.push(tool.definition);
    }
    return tools;
  }

  async getToolsForContext(context = null, { includeInternal = false } = {}) {
    const tools = [];
    for (const [, tool] of this.tools) {
      const def = tool?.definition;
      if (!def) continue;
      if (def.internal === true && !includeInternal) continue;
      if (!await this._isToolAllowedByAgentScope(def, context)) continue;
      if (this.toolPermissionService && !includeInternal) {
        const allowed = await this.toolPermissionService.isToolAllowed({
          toolName: def.name,
          context: context || {}
        });
        if (!allowed) continue;
      }
      tools.push(def);
    }
    return tools;
  }

  async getActiveToolsForContext(context = null) {
    if (this.toolPermissionService) {
      const activeNames = await this.toolPermissionService.getContextActiveToolNames(context || {});
      const output = [];
      for (const toolName of activeNames) {
        const def = this.tools.get(toolName)?.definition;
        if (!def || def.internal === true) continue;
        if (!await this._isToolAllowedByAgentScope(def, context)) continue;
        output.push(def);
      }
      return output;
    }

    const activeTools = this.getActiveTools();
    const filtered = [];
    for (const tool of activeTools) {
      if (!await this._isToolAllowedByAgentScope(tool, context)) continue;
      filtered.push(tool);
    }
    return filtered;
  }

  getToolsDocumentation() {
    const docs = [];
    for (const [, tool] of this.tools) {
      const def = tool.definition;
      if (def?.internal === true) continue;
      const doc = {
        name: def.name,
        description: def.userDescription || def.description,
        technicalDescription: def.description,
        parameters: [],
        example: def.example || '',
        exampleOutput: def.exampleOutput || '',
        category: this.categorizeToolName(def.name)
      };

      if (def.inputSchema?.properties) {
        const required = def.inputSchema.required || [];
        Object.entries(def.inputSchema.properties).forEach(([key, prop]) => {
          doc.parameters.push({
            name: key,
            type: prop.type,
            description: prop.description || 'No description',
            required: required.includes(key),
            default: prop.default
          });
        });
      }

      docs.push(doc);
    }
    return docs;
  }

  categorizeToolName(name) {
    if (this.toolGroups) {
      for (const [, group] of this.toolGroups) {
        if (group.tools.includes(name)) {
          return group.name;
        }
      }
    }

    if (name.includes('calendar')) return 'Calendar';
    if (name.includes('todo')) return 'Todo';
    if (name.includes('weather') || name.includes('time')) return 'System';
    if (name.includes('conversation') || name.includes('search')) return 'Search';
    if (name.includes('calculate')) return 'Math';
    if (name.includes('rule')) return 'Rules';
    if (name.includes('stats') || name.includes('provider') || name.includes('prompt')) return 'System';
    return 'Other';
  }

  loadToolGroups() {
    if (this.capabilityManager) {
      try {
        this.toolGroups = new Map();
        this.activeGroups = new Set();
        const groups = this.capabilityManager.getGroupsConfig();
        for (const group of groups) {
          this.toolGroups.set(group.id, {
            name: group.name,
            description: group.description,
            icon: group.icon,
            tools: group.allTools || group.tools || []
          });
          if (group.enabled) this.activeGroups.add(group.id);
        }
        console.log(`[MCP] Loaded ${this.toolGroups.size} tool groups from CapabilityManager`);
        return;
      } catch (error) {
        console.error('[MCP] Failed to load groups from CapabilityManager, falling back:', error.message);
      }
    }

    try {
      const path = require('path');
      const fs = require('fs');
      const groupsPath = path.join(__dirname, 'tool-groups.json');
      const data = fs.readFileSync(groupsPath, 'utf-8');
      const config = JSON.parse(data);

      this.toolGroups = new Map();
      this.activeGroups = new Set();

      for (const [groupId, groupConfig] of Object.entries(config.groups)) {
        this.toolGroups.set(groupId, groupConfig);
        if (groupConfig.defaultActive) {
          this.activeGroups.add(groupId);
        }
      }
      console.warn('[MCP] WARNING: Using deprecated tool-groups.json. CapabilityManager not available.');
    } catch (error) {
      console.error('[MCP] Failed to load tool groups:', error.message);
      this.toolGroups = new Map();
      this.activeGroups = new Set();
    }
  }

  async activateGroup(groupId) {
    if (!this.toolGroups.has(groupId)) {
      throw new Error(`Unknown group: ${groupId}`);
    }

    this.activeGroups.add(groupId);
    const group = this.toolGroups.get(groupId);
    for (const toolName of group.tools) {
      await this.setToolActiveState(toolName, true);
    }

    console.log(`[MCP] Activated group: ${groupId} (${group.tools.length} tools)`);
    return { activated: groupId, tools: group.tools };
  }

  async deactivateGroup(groupId) {
    if (!this.toolGroups.has(groupId)) {
      throw new Error(`Unknown group: ${groupId}`);
    }

    this.activeGroups.delete(groupId);
    const group = this.toolGroups.get(groupId);
    for (const toolName of group.tools) {
      await this.setToolActiveState(toolName, false);
    }

    console.log(`Deactivated group: ${groupId}`);
    return { deactivated: groupId, tools: group.tools };
  }

  getActiveTools() {
    if (this.capabilityManager) {
      const activeToolNames = this.capabilityManager.getActiveTools();
      return activeToolNames
        .map(name => this.tools.get(name)?.definition)
        .filter(def => Boolean(def) && def.internal !== true);
    }

    const activeTools = [];
    for (const groupId of this.activeGroups) {
      const group = this.toolGroups.get(groupId);
      if (group) {
        for (const toolName of group.tools) {
          const tool = this.tools.get(toolName);
          if (tool && tool.definition?.internal !== true) {
            activeTools.push(tool.definition);
          }
        }
      }
    }
    return activeTools;
  }

  getToolGroups() {
    if (this.capabilityManager) {
      return this.capabilityManager.getGroupsConfig().map(group => ({
        id: group.id,
        name: group.name,
        description: group.description,
        icon: group.icon,
        tools: group.allTools || group.tools || [],
        active: group.enabled,
        toolCount: (group.allTools || group.tools || []).length,
        mode: group.mode,
        modes: group.modes
      }));
    }

    const groups = [];
    for (const [groupId, group] of this.toolGroups) {
      groups.push({
        id: groupId,
        name: group.name,
        description: group.description,
        icon: group.icon,
        tools: group.tools,
        active: this.activeGroups.has(groupId),
        toolCount: group.tools.length
      });
    }
    return groups;
  }

  async addProxyServer(name, config) {
    this.proxyServers.set(name, config);
    return { success: true, name };
  }

  async removeProxyServer(name) {
    this.proxyServers.delete(name);
    return { success: true, name };
  }

  getProxyServers() {
    return Array.from(this.proxyServers.entries()).map(([name, config]) => ({
      name,
      config
    }));
  }

  async stop() {
    this.proxyServers.clear();
    this.removeAllListeners();
  }

  registerCustomTool(tool) {
    const code = String(tool.code || '');
    const sandboxPolicy = normalizeCustomToolSandboxPolicy(tool);
    this.registerTool(tool.name, {
      name: tool.name,
      description: tool.description,
      userDescription: tool.description,
      inputSchema: tool.input_schema || { type: 'object' },
      isCustom: true,
      sandboxPolicy
    }, async (params, execution = {}) => runCustomToolInSandbox({
      toolName: tool.name,
      code,
      params,
      timeoutMs: execution.timeoutMs
    }));

    if (this.capabilityManager) {
      this.capabilityManager.registerCustomTool(tool.name, false);
    }
    console.log(`[MCP] Custom tool registered: ${tool.name}`);
  }

  async loadCustomTools() {
    try {
      const tools = await this.db.getCustomTools();
      for (const tool of tools) {
        try {
          this.registerCustomTool({
            name: tool.name,
            description: tool.description,
            code: tool.code,
            input_schema: JSON.parse(tool.input_schema || '{}')
          });
        } catch (error) {
          console.error(`[MCP] Failed to load custom tool ${tool.name}:`, error);
        }
      }
      console.log(`[MCP] Loaded ${tools.length} custom tools`);
    } catch (error) {
      console.error('[MCP] Failed to load custom tools:', error);
    }
  }

  _normalizeToolAgentScope(definition = {}) {
    const directScope = Array.isArray(definition.agentScope)
      ? definition.agentScope
      : (typeof definition.agentScope === 'string' ? [definition.agentScope] : []);
    const manifestScope = [
      definition.agentSlug,
      ...(Array.isArray(definition.agentSlugs) ? definition.agentSlugs : [])
    ];
    const merged = [...directScope, ...manifestScope]
      .map(value => String(value || '').trim().toLowerCase())
      .filter(Boolean);
    if (merged.length === 0 || merged.includes('*')) {
      return null;
    }
    return Array.from(new Set(merged));
  }

  _slugifyAgentName(name) {
    return String(name || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  async _resolveAgentScopeContext(context = null) {
    const executionContext = context && typeof context === 'object' ? context : {};
    let agentId = executionContext.agentId ?? null;
    const sessionId = executionContext.sessionId ?? this.getCurrentSessionId();

    if (!agentId && sessionId !== null && sessionId !== undefined && this.db?.get) {
      const row = this.db.get('SELECT agent_id FROM chat_sessions WHERE id = ?', [sessionId]);
      if (row?.agent_id) {
        agentId = row.agent_id;
      }
    }

    if (!agentId) {
      return { agentId: null, agentSlug: null };
    }

    let agent = null;
    if (this._agentManager && typeof this._agentManager.getAgent === 'function') {
      agent = await this._agentManager.getAgent(agentId, { requestContext: executionContext.requestContext || null });
    } else if (this.db?.getAgent) {
      agent = await this.db.getAgent(agentId, { requestContext: executionContext.requestContext || null });
    }

    if (!agent) {
      return { agentId, agentSlug: null };
    }

    const agentSlug = this._agentManager && typeof this._agentManager._getSafeFolderName === 'function'
      ? this._agentManager._getSafeFolderName(agent.name)
      : this._slugifyAgentName(agent.name);

    return { agentId, agentSlug };
  }

  async _isToolAllowedByAgentScope(definition = {}, context = null) {
    const requiredScopes = Array.isArray(definition.agentScopeSlugs)
      ? definition.agentScopeSlugs
      : null;
    if (!requiredScopes || requiredScopes.length === 0) {
      return true;
    }

    const { agentSlug } = await this._resolveAgentScopeContext(context);
    if (!agentSlug) {
      return false;
    }
    return requiredScopes.includes(String(agentSlug).trim().toLowerCase());
  }
}

module.exports = MCPServer;
