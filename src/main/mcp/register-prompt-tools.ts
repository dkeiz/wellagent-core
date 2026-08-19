// @ts-nocheck
const fs = require('fs');
const path = require('path');
const { tokenizePath } = require('../path-tokens');
const { buildRuntimePaths } = require('../runtime-paths');
const { DEFAULT_PROMPT_USER_ID, resolvePromptScope } = require('../prompt-ownership');

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

async function assertPromptPathAllowed(server, filePath, promptRoot) {
  await server.assertExecutionPathAllowed?.(filePath, {
    extraRoots: [promptRoot].filter(Boolean)
  });
}

function getPromptScopeOptions(server) {
  const currentExecutionContext = typeof server.getCurrentExecutionContext === 'function'
    ? server.getCurrentExecutionContext()
    : null;
  const requestContext = currentExecutionContext?.requestContext || null;
  const scope = resolvePromptScope({ requestContext });
  return {
    requestContext: scope.requestContext,
    userId: scope.userId,
    concurrent: scope.concurrent
  };
}

function isOwnerPromptScope(scopeOptions = {}) {
  return resolvePromptScope(scopeOptions).userId === DEFAULT_PROMPT_USER_ID;
}

function findRuleFilenames(rulesPath, safeName) {
  if (!fs.existsSync(rulesPath)) {
    return [];
  }
  return fs.readdirSync(rulesPath)
    .filter(fileName => fileName.endsWith('.md') && fileName.includes(safeName));
}

const MATH_CONSTANTS = new Map([
  ['e', Math.E],
  ['math.e', Math.E],
  ['pi', Math.PI],
  ['math.pi', Math.PI]
]);

const MATH_FUNCTIONS = new Map([
  ['abs', { fn: Math.abs, min: 1, max: 1 }],
  ['acos', { fn: Math.acos, min: 1, max: 1 }],
  ['asin', { fn: Math.asin, min: 1, max: 1 }],
  ['atan', { fn: Math.atan, min: 1, max: 1 }],
  ['atan2', { fn: Math.atan2, min: 2, max: 2 }],
  ['ceil', { fn: Math.ceil, min: 1, max: 1 }],
  ['cos', { fn: Math.cos, min: 1, max: 1 }],
  ['exp', { fn: Math.exp, min: 1, max: 1 }],
  ['floor', { fn: Math.floor, min: 1, max: 1 }],
  ['log', { fn: Math.log, min: 1, max: 1 }],
  ['log10', { fn: Math.log10, min: 1, max: 1 }],
  ['max', { fn: Math.max, min: 1, max: Infinity }],
  ['min', { fn: Math.min, min: 1, max: Infinity }],
  ['pow', { fn: Math.pow, min: 2, max: 2 }],
  ['round', { fn: Math.round, min: 1, max: 1 }],
  ['sin', { fn: Math.sin, min: 1, max: 1 }],
  ['sqrt', { fn: Math.sqrt, min: 1, max: 1 }],
  ['tan', { fn: Math.tan, min: 1, max: 1 }],
  ['trunc', { fn: Math.trunc, min: 1, max: 1 }]
]);

function normalizeMathName(name) {
  return String(name || '').trim().toLowerCase();
}

function tokenizeMathExpression(expression) {
  const input = String(expression || '');
  if (!input.trim()) throw new Error('Invalid math expression');
  if (input.length > 500) throw new Error('Math expression is too long');

  const tokens = [];
  let index = 0;
  while (index < input.length) {
    const rest = input.slice(index);
    if (/^\s/.test(rest)) {
      index += 1;
      continue;
    }

    const numberMatch = rest.match(/^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i);
    if (numberMatch) {
      tokens.push({ type: 'number', value: Number(numberMatch[0]) });
      index += numberMatch[0].length;
      continue;
    }

    const identifierMatch = rest.match(/^[A-Za-z_][A-Za-z0-9_.]*/);
    if (identifierMatch) {
      tokens.push({ type: 'identifier', value: identifierMatch[0] });
      index += identifierMatch[0].length;
      continue;
    }

    const char = input[index];
    if ('+-*/%^(),'.includes(char)) {
      tokens.push({ type: char, value: char });
      index += 1;
      continue;
    }

    throw new Error('Invalid math expression');
  }
  return tokens;
}

class MathExpressionParser {
  constructor(tokens) {
    this.tokens = tokens;
    this.index = 0;
  }

  peek() {
    return this.tokens[this.index] || null;
  }

  consume(type) {
    const token = this.peek();
    if (!token || token.type !== type) return null;
    this.index += 1;
    return token;
  }

  expect(type) {
    const token = this.consume(type);
    if (!token) throw new Error('Invalid math expression');
    return token;
  }

  parse() {
    const result = this.parseAdditive();
    if (this.peek()) throw new Error('Invalid math expression');
    if (!Number.isFinite(result)) throw new Error('Math result is not finite');
    return result;
  }

  parseAdditive() {
    let value = this.parseMultiplicative();
    while (this.peek()?.type === '+' || this.peek()?.type === '-') {
      const op = this.peek().type;
      this.index += 1;
      const right = this.parseMultiplicative();
      value = op === '+' ? value + right : value - right;
    }
    return value;
  }

  parseMultiplicative() {
    let value = this.parsePower();
    while (['*', '/', '%'].includes(this.peek()?.type)) {
      const op = this.peek().type;
      this.index += 1;
      const right = this.parsePower();
      if (op === '*') value *= right;
      if (op === '/') value /= right;
      if (op === '%') value %= right;
    }
    return value;
  }

  parsePower() {
    const value = this.parseUnary();
    if (!this.consume('^')) return value;
    return Math.pow(value, this.parsePower());
  }

  parseUnary() {
    if (this.consume('+')) return this.parseUnary();
    if (this.consume('-')) return -this.parseUnary();
    return this.parsePrimary();
  }

  parsePrimary() {
    const numberToken = this.consume('number');
    if (numberToken) return numberToken.value;

    const identifierToken = this.consume('identifier');
    if (identifierToken) {
      return this.resolveIdentifier(identifierToken.value);
    }

    if (this.consume('(')) {
      const value = this.parseAdditive();
      this.expect(')');
      return value;
    }

    throw new Error('Invalid math expression');
  }

  parseArguments() {
    const args = [];
    if (this.consume(')')) return args;
    do {
      args.push(this.parseAdditive());
    } while (this.consume(','));
    this.expect(')');
    return args;
  }

  resolveIdentifier(rawName) {
    const name = normalizeMathName(rawName);
    if (this.consume('(')) {
      const shortName = name.startsWith('math.') ? name.slice(5) : name;
      const entry = MATH_FUNCTIONS.get(shortName);
      if (!entry) throw new Error('Invalid math expression');
      const args = this.parseArguments();
      if (args.length < entry.min || args.length > entry.max) {
        throw new Error('Invalid math expression');
      }
      const result = entry.fn(...args);
      if (!Number.isFinite(result)) throw new Error('Math result is not finite');
      return result;
    }

    if (MATH_CONSTANTS.has(name)) return MATH_CONSTANTS.get(name);
    throw new Error('Invalid math expression');
  }
}

function evaluateMathExpression(expression) {
  return new MathExpressionParser(tokenizeMathExpression(expression)).parse();
}

function registerPromptTools(server) {
  function getPromptFileManager() {
    return server._promptFileManager || null;
  }

  function getPromptPaths(scopeOptions = {}) {
    const promptFileManager = getPromptFileManager();
    if (promptFileManager) {
      promptFileManager.ensureDirectories?.(scopeOptions);
      const scopedPaths = promptFileManager.getPaths
        ? promptFileManager.getPaths(scopeOptions)
        : null;
      return {
        promptRoot: scopedPaths?.base || promptFileManager.basePath || path.dirname(promptFileManager.systemPromptPath),
        promptPath: scopedPaths?.systemPrompt || promptFileManager.systemPromptPath,
        rulesPath: scopedPaths?.rules || promptFileManager.rulesPath,
        userId: scopedPaths?.userId || resolvePromptScope(scopeOptions).userId,
        getSafeFilename(name, priority = 1) {
          return promptFileManager.getSafeFilename
            ? promptFileManager.getSafeFilename(name, priority)
            : `${String(priority).padStart(3, '0')}-${String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}.md`;
        }
      };
    }

    const runtimePaths = buildRuntimePaths();
    const promptPath = path.join(runtimePaths.promptBasePath, 'system.md');
    const rulesPath = path.join(runtimePaths.promptBasePath, 'rules');
    if (!fs.existsSync(rulesPath)) {
      fs.mkdirSync(rulesPath, { recursive: true });
    }

    return {
      promptRoot: path.dirname(promptPath),
      promptPath,
      rulesPath,
      userId: resolvePromptScope(scopeOptions).userId,
      getSafeFilename(name, priority = 1) {
        const safeName = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        return `${String(priority).padStart(3, '0')}-${safeName}.md`;
      }
    };
  }

  server.registerTool('get_system_prompt', {
    name: 'get_system_prompt',
    description: 'Get the current system prompt',
    userDescription: 'Returns the current system prompt configuration used by the AI',
    example: 'TOOL:get_system_prompt{}',
    exampleOutput: '"You are a helpful AI assistant..."',
    inputSchema: { type: 'object' }
  }, async () => {
    const scopeOptions = getPromptScopeOptions(server);
    const promptFileManager = getPromptFileManager();
    if (promptFileManager?.loadSystemPrompt) {
      return promptFileManager.loadSystemPrompt(scopeOptions);
    }

    const { promptPath } = getPromptPaths(scopeOptions);
    if (fs.existsSync(promptPath)) {
      return fs.readFileSync(promptPath, 'utf-8');
    }
    const scopedPrompt = server.db?.getScopedSetting
      ? await server.db.getScopedSetting('system_prompt', scopeOptions)
      : await server.db.getSetting('system_prompt');
    return scopedPrompt || 'You are a helpful AI assistant with access to various tools and functions.';
  });

  server.registerTool('modify_system_prompt', {
    name: 'modify_system_prompt',
    description: 'Modify the system prompt. Agent can update its own behavior instructions.',
    userDescription: 'Allows the agent to update its own system prompt, changing its core behavior. Changes are saved to agentin/prompts/system.md',
    example: 'TOOL:modify_system_prompt{"content":"You are a helpful coding assistant..."}',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The new system prompt content' },
        append: { type: 'boolean', description: 'If true, append to existing prompt instead of replacing', default: false }
      },
      required: ['content']
    }
  }, async (params) => {
    const promptFileManager = getPromptFileManager();
    const scopeOptions = getPromptScopeOptions(server);

    const { promptPath, promptRoot } = getPromptPaths(scopeOptions);
    await assertPromptPathAllowed(server, promptPath, promptRoot);

    let newContent = params.content;
    if (params.append) {
      let existing = (server.db?.getScopedSetting ? await server.db.getScopedSetting('system_prompt', scopeOptions) : await server.db.getSetting('system_prompt')) || 'You are a helpful AI assistant with access to various tools and functions.';
      if (promptFileManager?.loadSystemPrompt) {
        existing = await promptFileManager.loadSystemPrompt(scopeOptions);
      } else if (fs.existsSync(promptPath)) {
        existing = fs.readFileSync(promptPath, 'utf-8');
      }
      newContent = existing + '\n\n' + params.content;
    }

    if (promptFileManager?.saveSystemPrompt) {
      await promptFileManager.saveSystemPrompt(newContent, true, scopeOptions);
    } else {
      fs.mkdirSync(path.dirname(promptPath), { recursive: true });
      fs.writeFileSync(promptPath, newContent, 'utf-8');
    }
    if (!promptFileManager) {
      if (server.db?.saveScopedSetting) {
        await server.db.saveScopedSetting('system_prompt', newContent, scopeOptions);
      } else {
        await server.db.setSetting('system_prompt', newContent);
      }
    }
    await server.aiService.setSystemPrompt(newContent, scopeOptions);

    return { success: true, message: 'System prompt updated', path: await toPortablePath(server, promptPath) };
  });

  server.registerTool('manage_rule', {
    name: 'manage_rule',
    description: 'Create, update, or delete a behavioral rule. Rules modify agent behavior dynamically.',
    userDescription: 'Manage prompt rules that affect agent behavior. Creates files in agentin/prompts/rules/',
    example: 'TOOL:manage_rule{"action":"create","name":"Code Style","content":"Always use TypeScript...","active":true}',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'delete', 'toggle'], description: 'Action to perform on the rule' },
        name: { type: 'string', description: 'Name of the rule' },
        content: { type: 'string', description: 'Rule content (for create/update)' },
        active: { type: 'boolean', description: 'Whether the rule is active', default: true },
        priority: { type: 'number', description: 'Priority order (lower = higher priority)', default: 1 }
      },
      required: ['action', 'name']
    }
  }, async (params) => {
    const promptFileManager = getPromptFileManager();
    const scopeOptions = getPromptScopeOptions(server);
    const { rulesPath, promptRoot, getSafeFilename } = getPromptPaths(scopeOptions);

    const safeName = String(params.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const priority = params.priority || 1;
    const matchingFiles = findRuleFilenames(rulesPath, safeName);
    const existingFilename = matchingFiles[0] || null;
    const filename = existingFilename || getSafeFilename(params.name, priority);
    const filePath = path.join(rulesPath, filename);
    const existingRule = server.db.getPromptRuleByName
      ? await server.db.getPromptRuleByName(params.name, scopeOptions)
      : await server.db.get('SELECT id FROM prompt_rules WHERE name = ?', [params.name]);

    switch (params.action) {
      case 'create':
      case 'update': {
        const content = params.content !== undefined ? params.content : (existingRule?.content || '');
        const active = params.active !== undefined ? params.active !== false : Boolean(existingRule?.active);
        await assertPromptPathAllowed(server, filePath, promptRoot);
        if (promptFileManager?.saveRuleToFile) {
          await promptFileManager.saveRuleToFile(params.name, content, active, priority, existingFilename, scopeOptions);
        } else {
          fs.mkdirSync(rulesPath, { recursive: true });
          const fileContent = `---
name: ${params.name}
active: ${active}
priority: ${priority}
---
${content}`;
          fs.writeFileSync(filePath, fileContent, 'utf-8');
        }

        if (existingRule?.id) {
          await server.db.updatePromptRule(existingRule.id, { name: params.name, content, active }, scopeOptions);
        } else {
          await server.db.addPromptRule({ name: params.name, content, type: 'rule', active }, scopeOptions);
        }
        return { success: true, action: params.action, path: await toPortablePath(server, filePath) };
      }

      case 'delete': {
        await assertPromptPathAllowed(server, rulesPath, promptRoot);
        for (const fileName of matchingFiles) {
          const targetPath = path.join(rulesPath, fileName);
          await assertPromptPathAllowed(server, targetPath, promptRoot);
          if (promptFileManager?.deleteRuleFile) {
            promptFileManager.deleteRuleFile(fileName, scopeOptions);
          } else if (fs.existsSync(targetPath)) {
            fs.unlinkSync(targetPath);
          }
        }

        if (existingRule?.id) {
          await server.db.deletePromptRule(existingRule.id, scopeOptions);
        }
        return { success: true, action: 'delete', deleted: matchingFiles };
      }

      case 'toggle': {
        const active = params.active === true;
        if (existingRule?.id) {
          await server.db.togglePromptRule(existingRule.id, active, scopeOptions);
        }

        await assertPromptPathAllowed(server, filePath, promptRoot);
        if (promptFileManager?.saveRuleToFile && existingRule) {
          await promptFileManager.saveRuleToFile(
            params.name,
            existingRule.content || '',
            active,
            priority,
            existingFilename,
            scopeOptions
          );
        } else if (fs.existsSync(filePath)) {
          let content = fs.readFileSync(filePath, 'utf-8');
          content = content.replace(/active:\s*(true|false)/, `active: ${active}`);
          fs.writeFileSync(filePath, content, 'utf-8');
        }

        return { success: true, action: 'toggle', active };
      }

      default:
        return { error: 'Invalid action' };
    }
  });

  server.registerTool('list_rules', {
    name: 'list_rules',
    description: 'List all behavioral rules and their status',
    userDescription: 'Shows all prompt rules that can affect agent behavior',
    example: 'TOOL:list_rules{}',
    inputSchema: { type: 'object' }
  }, async () => {
    const rules = await server.db.getPromptRules(getPromptScopeOptions(server));
    return rules.map(rule => ({
      name: rule.name,
      active: rule.active === 1 || rule.active === true,
      preview: rule.content?.substring(0, 100) + (rule.content?.length > 100 ? '...' : '')
    }));
  });

  server.registerTool('get_current_provider', {
    name: 'get_current_provider',
    description: 'Get the current AI provider',
    userDescription: 'Returns which AI provider is currently active (e.g., Ollama, LM Studio, OpenRouter)',
    example: 'TOOL:get_current_provider{}',
    exampleOutput: '"ollama"',
    inputSchema: { type: 'object' }
  }, async () => {
    return server.aiService.getCurrentProvider();
  });

  server.registerTool('search_conversations', {
    name: 'search_conversations',
    description: 'Search through conversation history',
    userDescription: 'Searches past conversations for messages containing specific keywords or phrases',
    example: 'TOOL:search_conversations{"query":"weather","limit":5}',
    exampleOutput: '[{"role":"user","content":"What\'s the weather?","timestamp":"2025-10-05T10:00:00Z"}]',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term or phrase to find in conversation history (e.g., "weather", "meeting", "todo")' },
        limit: { type: 'number', description: 'Maximum number of results to return', default: 10 }
      },
      required: ['query']
    }
  }, async (params) => {
    const conversations = await server.db.getConversations(100);
    return conversations.filter(conversation =>
      conversation.content.toLowerCase().includes(params.query.toLowerCase())
    ).slice(0, params.limit);
  });

  server.registerTool('calculate', {
    name: 'calculate',
    description: 'Perform mathematical calculations',
    userDescription: 'Evaluates mathematical expressions and returns the result',
    example: 'TOOL:calculate{"expression":"(123 + 456) * 2"}',
    exampleOutput: '{"expression":"(123 + 456) * 2","result":1158}',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'Mathematical expression to evaluate (e.g., "2+2", "(10*5)/2", "Math.sqrt(16)")' }
      },
      required: ['expression']
    }
  }, async (params) => {
    try {
      const result = evaluateMathExpression(params.expression);
      return { expression: params.expression, result };
    } catch {
      throw new Error('Invalid math expression');
    }
  });

  server.registerTool('list_active_rules', {
    name: 'list_active_rules',
    description: 'List currently active prompt rules',
    userDescription: 'Returns all currently active prompt rules that modify AI behavior',
    example: 'TOOL:list_active_rules{}',
    exampleOutput: '[{"id":1,"name":"Be Concise","content":"Keep responses brief","active":true}]',
    inputSchema: { type: 'object' }
  }, async () => {
    return await server.db.getActivePromptRules(getPromptScopeOptions(server));
  });

  server.registerTool('toggle_rule', {
    name: 'toggle_rule',
    description: 'Toggle a prompt rule on or off',
    userDescription: 'Activates or deactivates a specific prompt rule by its ID',
    example: 'TOOL:toggle_rule{"rule_id":1,"active":true}',
    exampleOutput: '{"id":1,"name":"Be Concise","active":true}',
    inputSchema: {
      type: 'object',
      properties: {
        rule_id: { type: 'number', description: 'The ID number of the rule to toggle' },
        active: { type: 'boolean', description: 'Set to true to activate, false to deactivate' }
      },
      required: ['rule_id', 'active']
    }
  }, async (params) => {
    const scopeOptions = getPromptScopeOptions(server);
    const rules = await server.db.getPromptRules(scopeOptions);
    const rule = rules.find(entry => Number(entry.id) === Number(params.rule_id));
    if (!rule) {
      return { id: params.rule_id, active: Boolean(params.active), user_id: scopeOptions.userId };
    }

    await server.db.togglePromptRule(params.rule_id, params.active, scopeOptions);

    const promptFileManager = getPromptFileManager();
    const { rulesPath, promptRoot, getSafeFilename } = getPromptPaths(scopeOptions);
    const safeName = String(rule.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const matchingFiles = findRuleFilenames(rulesPath, safeName);
    const existingFilename = matchingFiles[0] || getSafeFilename(rule.name, 1);
    const filePath = path.join(rulesPath, existingFilename);

    await assertPromptPathAllowed(server, filePath, promptRoot);
    if (promptFileManager?.saveRuleToFile) {
      await promptFileManager.saveRuleToFile(rule.name, rule.content || '', params.active === true, 1, existingFilename, scopeOptions);
    } else if (fs.existsSync(filePath)) {
      let content = fs.readFileSync(filePath, 'utf-8');
      content = content.replace(/active:\s*(true|false)/, `active: ${params.active === true}`);
      fs.writeFileSync(filePath, content, 'utf-8');
    }

    return {
      id: rule.id,
      name: rule.name,
      active: params.active === true,
      user_id: rule.user_id || scopeOptions.userId
    };
  });

  server.registerTool('get_stats', {
    name: 'get_stats',
    description: 'Get usage statistics',
    userDescription: 'Returns statistics about conversations, todos, calendar events, and rules',
    example: 'TOOL:get_stats{}',
    exampleOutput: '{"conversations":45,"todos":12,"events":8,"rules":3}',
    inputSchema: { type: 'object' }
  }, async () => {
    const scopeOptions = getPromptScopeOptions(server);
    const conversationCount = (await server.db.getConversations(10000)).length;
    const todoCount = (await server.db.getTodos(null, scopeOptions)).length;
    const eventCount = (await server.db.getCalendarEvents(scopeOptions)).length;
    const ruleCount = (await server.db.getPromptRules(scopeOptions)).length;
    return { conversations: conversationCount, todos: todoCount, events: eventCount, rules: ruleCount };
  });

  server.registerTool('create_tool', {
    name: 'create_tool',
    description: 'Create a new custom MCP tool',
    userDescription: 'Create a new custom MCP tool',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        code: { type: 'string' },
        capabilities: {
          type: 'array',
          description: 'Reserved custom-tool capability declarations. Filesystem, network, and subprocess access default to none.'
        },
        input_schema: { type: 'object' }
      },
      required: ['name', 'description', 'code']
    }
  }, async (params) => {
    await server.db.addCustomTool(params);
    server.registerCustomTool(params);
    return { created: true, name: params.name };
  });

  server.registerTool('end_answer', {
    name: 'end_answer',
    description: 'IMPORTANT: Use this tool ONLY when you have completed ALL necessary tool calls and are ready to give your final response to the user. Pass your complete, formatted answer in the "answer" parameter. Do NOT use this tool if you still need to call other tools.',
    userDescription: 'Signals completion of tool usage and provides the final answer',
    example: 'TOOL:end_answer{"answer":"Based on the weather data, today will be sunny with a high of 72°F. You should wear light clothing."}',
    inputSchema: {
      type: 'object',
      properties: {
        answer: {
          type: 'string',
          description: 'Your complete final answer to the user. This should be a well-formatted response that addresses their original question using the information gathered from tools.'
        }
      },
      required: ['answer']
    }
  }, async (params) => {
    return { complete: true, answer: params.answer };
  });

  server.registerTool('automemory', {
    name: 'automemory',
    description: 'Toggle automatic memory creation during idle periods. Off by default — user must enable. When enabled, after idle_seconds of no user input the agent will automatically summarize the conversation to daily memory.',
    userDescription: 'Enable/disable automatic memory saving during idle chat periods',
    example: 'TOOL:automemory{"enabled":true,"idle_seconds":60}',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'true to enable auto-memory, false to disable' },
        idle_seconds: { type: 'number', description: 'Seconds of idle before triggering memory save', default: 60 }
      },
      required: ['enabled']
    }
  }, async (params) => {
    if (server._agentLoop) {
      const sessionId = server.getCurrentSessionId() || 'default';
      return server._agentLoop.setAutoMemory(sessionId, params.enabled, params.idle_seconds || 60, { requestContext: server.getCurrentExecutionContext?.()?.requestContext || null });
    }
    return { error: 'Agent loop not initialized' };
  });
}

module.exports = { registerPromptTools, evaluateMathExpression };


