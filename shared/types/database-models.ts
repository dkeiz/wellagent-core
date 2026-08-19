// --- Database row types ---

export interface ConversationRow {
  id: number;
  session_id: string;
  title?: string | null;
  created_at?: string;
  updated_at?: string;
  metadata?: string | Record<string, any> | null;
  is_private?: number;
  user_id?: string;
}

export interface MessageRow {
  id: number;
  session_id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp?: string;
  tool_name?: string | null;
  tool_call_id?: string | null;
  tool_calls?: string | null;
  thinking?: string | null;
  run_id?: string | null;
  generation_model?: string | null;
  token_count?: number | null;
  user_id?: string;
}

export interface TodoRow {
  id: number;
  task: string;
  completed?: number;
  priority?: number;
  due_date?: string | null;
  session_id?: string | null;
  created_at?: string;
  user_id?: string;
}

export interface CalendarEventRow {
  id: number;
  title: string;
  start_time: string;
  duration_minutes?: number;
  description?: string;
  user_id?: string;
}

export interface SettingRow {
  key: string;
  value: string;
}

export interface CredentialRow {
  key: string;
  value_encrypted: string;
  created_at?: string;
  updated_at?: string;
}

export interface AgentRow {
  id: number;
  name: string;
  type: 'pro' | 'sub' | 'superagent' | string;
  system_prompt?: string;
  model_override?: string | null;
  provider_override?: string | null;
  active?: number;
  directory?: string | null;
  plugins_json?: string | null;
  created_at?: string;
  updated_at?: string;
  user_id?: string;
  owner_id?: string;
}

export interface SubagentRunRow {
  id: number;
  parent_session_id: string;
  parent_message_id?: number | null;
  agent_id?: number | null;
  agent_name?: string;
  child_session_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | string;
  result_payload?: string | null;
  artifacts_json?: string | null;
  started_at?: string;
  completed_at?: string | null;
  runtime_policy_profile?: string;
  runtime_policy_grants_json?: string | null;
  user_id?: string;
  owner_id?: string;
  attempts?: number;
}

export interface PromptRuleRow {
  id: number;
  name: string;
  content: string;
  type: 'system' | 'user' | 'agent' | string;
  active?: number;
  priority?: number;
  created_at?: string;
  user_id?: string;
  owner_id?: string;
}

export interface WorkflowRow {
  id: number;
  name: string;
  description?: string;
  trigger_type?: string;
  trigger_config?: string | null;
  steps_json?: string;
  active?: number;
  created_at?: string;
  updated_at?: string;
  user_id?: string;
  owner_id?: string;
}

export interface MemoryJobRow {
  id: number;
  job_type: string;
  session_id?: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed' | string;
  priority?: number;
  payload_json?: string | null;
  result_json?: string | null;
  last_error?: string | null;
  attempts?: number;
  next_run_at?: string | null;
  locked_at?: string | null;
  locked_by?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface UserRow {
  user_id: string;
  role: 'owner' | 'member' | 'guest';
  username?: string | null;
  display_name?: string | null;
  auth_provider?: string | null;
  email?: string | null;
  status?: 'pending' | 'active' | 'suspended';
  bio?: string | null;
  is_default?: number;
  created_at?: string;
  updated_at?: string;
}

export interface DaemonSessionInspectionRow {
  session_id: string;
  inspector: string;
  inspected_at: string;
  job_id?: number | null;
  notes?: string;
}

// --- Database result types ---

export interface DbRunResult {
  id: number | bigint;
  changes: number;
}

// --- Database wrapper interface ---

export interface DatabaseWrapperInterface {
  dbPath: string;
  init(): Promise<void>;
  close(): void;
  run(sql: string, params?: any[]): DbRunResult;
  get(sql: string, params?: any[]): any;
  all(sql: string, params?: any[]): any[];

  // Settings
  getSetting(key: string): Promise<string | null>;
  saveSetting(key: string, value: string): Promise<void>;

  // Credentials
  getCredential(key: string): Promise<string | null>;
  setCredential(key: string, value: string): Promise<void>;
  deleteCredential(key: string): Promise<void>;
  setAPIKey(provider: string, key: string): Promise<void>;
  getAPIKey(provider: string): Promise<string | null>;

  // Conversations
  getConversations(options?: any): Promise<ConversationRow[]>;
  getConversation(sessionId: string, options?: any): ConversationRow | null;
  createConversation(sessionId: string, title?: string, options?: any): Promise<ConversationRow>;
  deleteConversation(sessionId: string, options?: any): Promise<void>;
  renameConversation(sessionId: string, title: string, options?: any): Promise<void>;

  // Messages
  getMessages(sessionId: string, options?: any): MessageRow[];
  addMessage(sessionId: string, role: string, content: string, options?: any): Promise<MessageRow>;
  deleteMessage(id: number, options?: any): Promise<void>;

  // Todos
  getTodos(sessionId?: string | null, options?: any): Promise<TodoRow[]>;
  addTodo(todo: Partial<TodoRow>, sessionId?: string | null, options?: any): Promise<TodoRow>;
  updateTodo(id: number, todo: Partial<TodoRow>, sessionId?: string | null, options?: any): Promise<TodoRow>;
  deleteTodo(id: number, sessionId?: string | null, options?: any): Promise<any>;

  // Calendar
  getCalendarEvents(options?: any): Promise<CalendarEventRow[]>;
  addCalendarEvent(event: Partial<CalendarEventRow>, options?: any): Promise<CalendarEventRow>;
  updateCalendarEvent(id: number, event: Partial<CalendarEventRow>, options?: any): Promise<CalendarEventRow>;
  deleteCalendarEvent(id: number, options?: any): Promise<any>;

  // Agents
  getAgents(options?: any): Promise<AgentRow[]>;
  getAgent(id: number, options?: any): AgentRow | null;
  addAgent(agent: Partial<AgentRow>, options?: any): Promise<AgentRow>;
  updateAgent(id: number, agent: Partial<AgentRow>, options?: any): Promise<void>;
  deleteAgent(id: number, options?: any): Promise<void>;

  // Prompt Rules
  getPromptRules(options?: any): Promise<PromptRuleRow[]>;
  addPromptRule(rule: Partial<PromptRuleRow>, options?: any): Promise<PromptRuleRow>;
  getPromptRuleByName(name: string, options?: any): PromptRuleRow | null;

  // Workflows
  getWorkflows(options?: any): Promise<WorkflowRow[]>;
  getWorkflow(id: number, options?: any): WorkflowRow | null;

  // Subagent runs
  getSubagentRun(runId: number): SubagentRunRow | null;
  getSubagentRunsForSession(sessionId: string, options?: any): SubagentRunRow[];

  // Memory jobs
  getMemoryJob(jobId: number): MemoryJobRow | null;
  getPendingMemoryJobs(options?: any): MemoryJobRow[];
}
