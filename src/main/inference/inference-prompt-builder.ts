// @ts-nocheck
const { buildPathTokenMap } = require('../path-tokens');

class InferencePromptBuilder {
  constructor({ aiService, db, mcpServer, getAgentManager, getPromptFileManager = null }) {
    this.aiService = aiService;
    this.db = db;
    this.mcpServer = mcpServer;
    this.getAgentManager = getAgentManager;
    this.getPromptFileManager = getPromptFileManager;
  }

  async buildSystemPrompt({ includeTools, includeRules, includeEnv, skipMemoryOnStart = false, sessionId, agentId, requestContext = null, completionTools = [], nativeWorkspaceRoot = null }) {
    let prompt;
    const agentManager = this.getAgentManager?.() || null;
    const promptFileManager = this.getPromptFileManager?.() || null;

    if (agentId && agentManager) {
      const agent = await agentManager.getAgent(agentId, { requestContext });
      if (agent) {
        prompt = agentManager.getAgentSystemPrompt(agent);
        const memory = agentManager.getAgentMemory(agent);
        if (memory) {
          prompt = `<agent_memory>\n${memory}\n</agent_memory>\n\n${prompt}`;
        }
      } else if (promptFileManager?.loadSystemPrompt) {
        prompt = await promptFileManager.loadSystemPrompt({ requestContext });
      } else {
        prompt = this.aiService.systemPrompt;
      }
    } else if (promptFileManager?.loadSystemPrompt) {
      prompt = await promptFileManager.loadSystemPrompt({ requestContext });
    } else {
      prompt = this.aiService.systemPrompt;
    }

    if (includeEnv) {
      prompt += `\n\n<environment>
File-tool Workspace: {workspace}
Native Runtime Working Directory: ${nativeWorkspaceRoot || '{workspace}'}
Memory Directory: {memory}
Session Workspace: {workspace}
Agent Home: ${agentId ? '{agent_home}' : '{agentin}'}
When using file tools (list_directory, read_file, etc.), use these paths. Your memory files are in the agentin/memory/ directory.
</environment>

<workspace_guidance>
For commands with potentially large output (builds, installs, logs, directory trees):
- Use output_to_file=true in run_command to save output to a workspace file (auto-triggers at 1000+ chars)
- run_command timeout is in seconds. Use timeout=60 for one minute, or timeout_ms only when you explicitly need milliseconds.
- Then use read_file or search_workspace to inspect specific parts
- This keeps your context window lean and avoids token waste
- Terminal access has modes: off, workspace, system. Workspace mode allows command cwd only inside the execution workspace/session workspace/agentin. If the user asks you to search or work elsewhere on disk, call run_command with that outside cwd; the app will ask the user for system terminal permission when needed.
Your session workspace is personal to the current chat session.
Create temporary scripts, logs, job lists, and other generated task artifacts in the current session workspace by default.${agentId ? ' Use {agent_tasks} or {agent_outputs} for persistent agent-owned files.' : ''} Do not place generated artifacts in the application or project root unless the user explicitly requests that location.
</workspace_guidance>

${skipMemoryOnStart ? '' : `<memory_on_start>
IMPORTANT: At the start of every new conversation, you MUST read your core memory files using the read_file tool BEFORE answering the user. This is how you remember who you are and who the user is.

Read these files (use read_file tool):
1. {agentin}/agent.md — your identity and technical reference
2. {agentin}/userabout/memoryaboutuser.md — what you know about the user
3. {memory}/global/preferences.md — permanent preferences
4. {memory}/daily — call list_directory first and wait for its result. Then read the newest existing YYYY-MM-DD.md file returned by that tool. Never guess a filename and never send placeholders such as <date> or <today's date> to a file tool.
5. {agentin}/workflows/workflow.md — workflow system reference

Do this silently as part of your first response. You must still answer the user's question in the same turn — chain the file reads then respond naturally.
</memory_on_start>`}

<knowledge_guidance>
You have a personal knowledge store at {knowledge}.
Use explore_knowledge to see what's available, then read_file to access specific items.
Knowledge includes: user preferences, usage patterns, plugin guides, contacts, and more.
Explore on-demand when the user's request suggests prior context would help.
Each knowledge file is max 200 lines. Use existing file tools to read and search within.
</knowledge_guidance>`;
    }

    if (includeEnv) {
      const tokens = await buildPathTokenMap({
        agentManager,
        sessionWorkspace: agentManager?.sessionWorkspace || null,
        sessionId,
        agentId
      });
      const tokenLines = Object.keys(tokens).map((token) => `- ${token}`).join('\n');
      prompt += `\n\n<path_tokens>
Use these portable path tokens in file tool calls instead of hard-coded absolute paths:
${tokenLines}
Tokens are resolved by the backend. Keep paths tokenized and forward-slashed in tool calls and outputs.
</path_tokens>`;
    }

    if (includeRules) {
      const activeRules = await this.db.getActivePromptRules({ requestContext });
      if (activeRules && activeRules.length > 0) {
        prompt += `\n\nActive Rules:\n${activeRules.map((rule) => rule.content).join('\n')}`;
      }
    }

    if (includeTools && this.mcpServer) {
      prompt += await this.buildToolContext({ completionToolNames: completionTools, sessionId, agentId, requestContext });
    }

    return prompt;
  }

  async buildToolContext({ completionToolNames = [], sessionId = null, agentId = null, requestContext = null } = {}) {
    const agentManager = this.getAgentManager?.() || null;
    const scopeContext = { sessionId, agentId, requestContext };
    const resolvedPermissions = this.mcpServer.toolPermissionService
      ? await this.mcpServer.toolPermissionService.resolveContext(scopeContext)
      : null;
    const activeTools = this.mcpServer.getActiveToolsForContext
      ? await this.mcpServer.getActiveToolsForContext(scopeContext)
      : (this.mcpServer.getActiveTools ? this.mcpServer.getActiveTools() : []);
    const visibleTools = activeTools.length > 0
      ? activeTools
      : (this.mcpServer.getToolsForContext
        ? await this.mcpServer.getToolsForContext(scopeContext)
        : this.mcpServer.getTools());
    const completionTools = this.mcpServer.getToolsByNames
      ? this.mcpServer.getToolsByNames(completionToolNames, { includeInternal: true })
      : [];
    const tools = [...visibleTools];

    for (const tool of completionTools) {
      if (!tools.some((existing) => existing.name === tool.name)) {
        tools.push(tool);
      }
    }

    let ctx = '\n\n<mcp_tools>\nAvailable Tools (from active groups):\n\n';

    for (const tool of tools) {
      const isActive = resolvedPermissions
        ? resolvedPermissions.toolStates?.[tool.name] === true
        : this.mcpServer.toolStates.get(tool.name) !== false;
      const status = isActive ? '✅ Available' : '⚠️ Disabled (permission required)';

      ctx += `## ${tool.name} [${status}]\n`;
      ctx += `Description: ${tool.description}\n`;

      if (tool.inputSchema?.properties) {
        const required = tool.inputSchema.required || [];
        ctx += 'Parameters:\n';
        Object.entries(tool.inputSchema.properties).forEach(([key, prop]) => {
          const isRequired = required.includes(key);
          const defaultVal = prop.default !== undefined ? ` (default: ${JSON.stringify(prop.default)})` : '';
          const requiredMark = isRequired ? ' [REQUIRED]' : '';
          ctx += `  - ${key} (${prop.type})${requiredMark}${defaultVal}: ${prop.description || 'No description'}\n`;
        });
      }

      if (tool.example) {
        ctx += `Example: ${tool.example}\n`;
      }

      if (tool.name === 'subagent') {
        const subagents = agentManager ? await agentManager.getAgents('sub', { requestContext }) : [];
        if (subagents.length > 0) {
          ctx += 'Live Sub-agents:\n';
          subagents.forEach((agent) => {
            ctx += `  - id=${agent.id}, name="${agent.name}", status=${agent.status || 'idle'}\n`;
          });
        } else {
          ctx += 'Live Sub-agents: none configured right now\n';
        }
        ctx += 'Use action="list" if you need the current ids. Prefer id over name for action="run".\n';
      }

      ctx += '\n';
    }

    ctx += '\n## How to Use Tools\n';
    ctx += 'Format: TOOL:tool_name{"param":"value"}\n';
    ctx += 'Tool calls are parsed by backend syntax, not intent.\n';
    ctx += 'If you intend to call a tool, emit a valid TOOL line exactly. Do not describe the call in prose.\n';
    ctx += 'When calling tools, prefer outputting only TOOL lines (one per line), no markdown fences.\n';
    ctx += 'Use the APPROPRIATE tool for each request. Match the tool to the user\'s actual question.\n';
    ctx += 'If a tool times out or fails, tell the user the tool didn\'t respond - do NOT call a different tool instead.\n';
    ctx += 'Always use the exact JSON format shown in examples.\n';
    ctx += '\n## Important Rules\n';
    ctx += '- Only call tools directly relevant to what the user asked\n';
    ctx += '- If the user asks for weather, use weather/web tools, NOT time tools\n';
    ctx += '- If a tool fails, explain the failure to the user instead of trying other tools\n';
    ctx += '- Don\'t repeat the same tool call from earlier in the conversation\n';
    ctx += '\n## Message Format\n';
    ctx += '- Messages wrapped in <tool_results> tags are AUTO-GENERATED by the backend, NOT sent by the user. Do not treat them as user input.\n';
    ctx += '- The actual user question is in <original_user_question> tags when tool results are present. Focus your answer on THAT question.\n';
    ctx += '</mcp_tools>';
    return ctx;
  }
}

module.exports = { InferencePromptBuilder };
