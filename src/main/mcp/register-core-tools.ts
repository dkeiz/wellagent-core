// @ts-nocheck
const { externalWebFetch } = require('../network-policy');
function getCurrentRequestContext(server) {
  const executionContext = typeof server.getCurrentExecutionContext === 'function'
    ? server.getCurrentExecutionContext()
    : null;
  return executionContext?.requestContext || null;
}

function getCurrentDbScope(server) {
  return {
    requestContext: getCurrentRequestContext(server)
  };
}

function registerCoreTools(server) {
  server.registerTool('current_time', {
    name: 'current_time',
    description: 'Get current server time in ISO format',
    userDescription: 'Returns the current date and time on the server',
    example: 'TOOL:current_time{}',
    exampleOutput: '"2025-10-05T15:05:30.123Z"',
    inputSchema: { type: 'object' }
  }, async () => {
    return new Date().toISOString();
  });

  server.registerTool('search_web_bing', {
    name: 'search_web_bing',
    description: 'General web search using Bing RSS. Returns titles, URLs, and text snippets for any query. Best for news, tutorials, current events, general questions, and broad research. Use this as your primary built-in search tool.',
    userDescription: 'Broad web search via Bing — works for any query type',
    example: 'TOOL:search_web_bing{"query":"latest AI news 2026"}',
    exampleOutput: '{"query":"latest AI news 2026","backend":"bing_rss","results":[{"title":"...","url":"https://...","snippet":"..."}]}',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query — any topic, question, or keywords' },
        max_results: { type: 'number', description: 'Maximum number of results to return', default: 8 },
        site: { type: 'string', description: 'Optional: restrict results to a domain (e.g. "github.com", "stackoverflow.com")' }
      },
      required: ['query']
    }
  }, async (params) => {
    const maxResults = params.max_results || 8;

    let searchQuery = params.query;
    if (params.site) {
      searchQuery += ` site:${params.site}`;
    }

    const feedUrl = `https://www.bing.com/search?q=${encodeURIComponent(searchQuery)}&format=rss`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
      const response = await externalWebFetch(feedUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LocalAgent/1.0)' }
      }, { label: 'Bing RSS search', timeoutMs: 8000 });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`Bing RSS error: HTTP ${response.status}`);
      }

      const xml = await response.text();
      const items = [];
      const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
      let match;
      while ((match = itemRegex.exec(xml)) !== null) {
        const itemXml = match[1];
        const title = (itemXml.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/i) ||
                       itemXml.match(/<title>(.*?)<\/title>/i) || [])[1] || '';
        const link = (itemXml.match(/<link>(.*?)<\/link>/i) || [])[1] || '';
        const desc = (itemXml.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/i) ||
                      itemXml.match(/<description>(.*?)<\/description>/i) || [])[1] || '';

        const snippet = desc
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&nbsp;/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

        if (link && !items.some(item => item.url === link)) {
          items.push({ title: title.trim(), url: link.trim(), snippet });
        }
      }

      return {
        query: params.query,
        backend: 'bing_rss',
        results: items.slice(0, maxResults)
      };
    } catch (error) {
      clearTimeout(timeout);
      if (error.name === 'AbortError') {
        return { query: params.query, backend: 'bing_rss', results: [], error: 'Search timed out after 8 seconds' };
      }
      throw error;
    }
  });

  server.registerTool('calendar_op', {
    name: 'calendar_op',
    description: 'Unified calendar operations. Actions: create, list.',
    userDescription: 'Manage calendar events',
    example: 'TOOL:calendar_op{"action":"list","limit":10}',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Operation: create | list' },
        title: { type: 'string', description: 'Event title for create action' },
        start_time: { type: 'string', description: 'Start time for create action' },
        duration_minutes: { type: 'number', description: 'Duration for create action', default: 60 },
        description: { type: 'string', description: 'Description for create action', default: '' },
        limit: { type: 'number', description: 'Max items for list action', default: 10 }
      },
      required: ['action']
    }
  }, async (params) => {
    const action = String(params.action || '').toLowerCase();
    if (action === 'create') {
      if (!params.title || !params.start_time) {
        return { error: 'title and start_time are required for create action' };
      }
      const event = await server.db.addCalendarEvent({
        title: params.title,
        start_time: params.start_time,
        duration_minutes: params.duration_minutes ?? 60,
        description: params.description ?? ''
      }, getCurrentDbScope(server));
      server.emit('calendar-update');
      if (server._artifactRegistry) {
        const sessionId = server.getCurrentSessionId?.() || 'default';
        server._artifactRegistry.registerVirtual(sessionId, {
          name: `📅 ${params.title}`,
          kind: 'calendar',
          source: 'calendar_op',
          data: event
        });
      }
      return event;
    }

    if (action === 'list') {
      const events = await server.db.getCalendarEvents(getCurrentDbScope(server));
      return params.limit ? events.slice(0, params.limit) : events;
    }

    return { error: `Unknown calendar action: ${params.action}` };
  });

  server.registerTool('todo_op', {
    name: 'todo_op',
    description: 'Unified todo operations. Actions: create, list, complete, visibility. Optional visible boolean controls the chat todo dropdown.',
    userDescription: 'Manage todo items',
    example: 'TOOL:todo_op{"action":"list"}',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Operation: create | list | complete | visibility' },
        task: { type: 'string', description: 'Task description for create action' },
        priority: { type: 'number', description: 'Priority for create action', default: 1 },
        due_date: { type: 'string', description: 'Due date for create action' },
        id: { type: 'number', description: 'Todo ID for complete action' },
        visible: { type: 'boolean', description: 'Show or hide active todos in the chat floating todo dropdown' }
      },
      required: ['action']
    }
  }, async (params, toolRuntime = {}) => {
    const action = String(params.action || '').toLowerCase();
    const contextSessionId = toolRuntime?.context?.sessionId;
    const sessionId = contextSessionId === undefined || contextSessionId === null
      ? (server.getCurrentSessionId?.() || null)
      : contextSessionId;
    const todoSessionId = sessionId === null || sessionId === undefined ? null : String(sessionId);
    const hasVisibleFlag = typeof params.visible === 'boolean';
    const applyVisibilityFlag = async () => {
      if (!hasVisibleFlag) return null;
      await server.db.setSetting('todo.visible', params.visible ? 'true' : 'false');
      return params.visible;
    };

    if (action === 'visibility') {
      if (!hasVisibleFlag) return { error: 'visible boolean is required for visibility action' };
      await applyVisibilityFlag();
      return { visible: params.visible };
    }

    if (action === 'create') {
      if (!params.task) return { error: 'task is required for create action' };
      await applyVisibilityFlag();
      const result = await server.db.addTodo({
        task: params.task,
        priority: params.priority ?? 1,
        due_date: params.due_date ?? null
      }, todoSessionId, getCurrentDbScope(server));
      if (server._artifactRegistry) {
        server._artifactRegistry.registerVirtual(todoSessionId || 'default', {
          name: `☑ ${params.task}`,
          kind: 'todo',
          source: 'todo_op',
          data: result
        });
      }
      return result;
    }

    if (action === 'list') {
      const visible = await applyVisibilityFlag();
      const todos = await server.db.getTodos(todoSessionId, getCurrentDbScope(server));
      const items = todos.map(todo => ({
        id: todo.id,
        task: todo.task,
        completed: todo.completed === 1 || todo.completed === true,
        priority: todo.priority,
        due_date: todo.due_date
      }));
      return hasVisibleFlag ? { visible, todos: items } : items;
    }

    if (action === 'complete') {
      if (!params.id) return { error: 'id is required for complete action' };
      await applyVisibilityFlag();
      const todos = await server.db.getTodos(todoSessionId, getCurrentDbScope(server));
      const current = todos.find(todo => Number(todo.id) === Number(params.id));
      if (!current) return { error: `Todo not found: ${params.id}` };
      return server.db.updateTodo(params.id, {
        task: current.task,
        completed: true,
        priority: current.priority,
        due_date: current.due_date
      }, todoSessionId, getCurrentDbScope(server));
    }

    return { error: `Unknown todo action: ${params.action}` };
  });

  server.registerTool('conversation_history', {
    name: 'conversation_history',
    description: 'Get conversation history',
    userDescription: 'Retrieves past conversation messages, limited to a specific number',
    example: 'TOOL:conversation_history{"limit":20}',
    exampleOutput: '[{"role":"user","content":"Hello"},{"role":"assistant","content":"Hi there!"}]',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of messages to retrieve (e.g., 10, 20, 50)',
          default: 50
        }
      }
    }
  }, async (params) => {
    return await server.db.getConversations(params.limit);
  });

  server.registerTool('display_content', {
    name: 'display_content',
    description: 'Send a structured document, markdown snippet, code block, local file, or web URL directly to the user\'s desktop Content Viewer panel. Use this to present rich formatted tables, detailed reports, parsed logs, charts, images, web pages, or code side-by-side with chat.',
    userDescription: 'Display rich content in the side Content Viewer',
    example: 'TOOL:display_content{"type":"markdown","title":"Sales Report","content":"# Report\\n* Sales are up 20%"}',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'Type of content: markdown | code | image | html | text | url | file | document',
          enum: ['markdown', 'code', 'image', 'html', 'text', 'url', 'file', 'document']
        },
        title: {
          type: 'string',
          description: 'Descriptive title for the content viewer tab'
        },
        content: {
          type: 'string',
          description: 'The actual content text (markdown, code, html, plain text, document body) to display. Optional if url or filePath is specified.'
        },
        text: {
          type: 'string',
          description: 'Alias for content when sending plain text, markdown, code, or document bodies. Optional.'
        },
        html: {
          type: 'string',
          description: 'Raw HTML to display in a sandboxed viewer frame. Optional.'
        },
        url: {
          type: 'string',
          description: 'URL or local file path to display (mainly for image/url/html types). Optional.'
        },
        filePath: {
          type: 'string',
          description: 'Local file path to display when type is file. Optional.'
        },
        language: {
          type: 'string',
          description: 'Programming language for code highlighting (e.g. javascript, python, css, html). Optional.'
        }
      },
      required: ['type', 'title']
    }
  }, async (params, toolRuntime = {}) => {
    const contextSessionId = toolRuntime?.context?.sessionId;
    const sessionId = contextSessionId === undefined || contextSessionId === null
      ? (server.getCurrentSessionId?.() || 'default')
      : contextSessionId;

    const content = params.content ?? params.text ?? '';
    const html = params.html ?? (params.type === 'html' ? content : '');
    const url = params.url || (['url', 'image'].includes(params.type) ? content : '');
    const filePath = params.filePath || (params.type === 'file' ? (params.url || content) : '');

    const result = {
      type: params.type,
      title: params.title,
      content,
      text: content,
      html,
      url,
      filePath,
      language: params.language || '',
      sourceAgentId: toolRuntime?.context?.agentId || 'agent',
      sourceSessionId: sessionId
    };

    if (server._artifactRegistry) {
      server._artifactRegistry.registerVirtual(sessionId, {
        name: params.title,
        kind: params.type,
        source: 'display_content',
        data: result
      });
    }

    return result;
  });
}

module.exports = { registerCoreTools };
