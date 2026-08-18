// --- IPC channel types ---

// Known IPC channel name constants
export const IPC_CHANNELS = {
  // Chat
  CHAT_SEND: 'chat:send',
  CHAT_GET_MESSAGES: 'chat:getMessages',
  CHAT_LIST_SESSIONS: 'chat:listSessions',
  CHAT_CREATE_SESSION: 'chat:createSession',
  CHAT_DELETE_SESSION: 'chat:deleteSession',
  CHAT_RENAME_SESSION: 'chat:renameSession',
  CHAT_STOP_GENERATION: 'chat:stopGeneration',

  // LLM / Provider
  LLM_GET_STATUS: 'llm:getStatus',
  LLM_SET_PROVIDER: 'llm:setProvider',
  LLM_SET_MODEL: 'llm:setModel',
  LLM_LIST_MODELS: 'llm:listModels',
  LLM_GET_SETTINGS: 'llm:getSettings',
  LLM_SAVE_SETTINGS: 'llm:saveSettings',

  // Tools / Capabilities
  TOOLS_LIST: 'tools:list',
  TOOLS_GET_GROUPS: 'tools:getGroups',
  TOOLS_TOGGLE_GROUP: 'tools:toggleGroup',
  TOOLS_GET_PERMISSIONS: 'tools:getPermissions',

  // Agents
  AGENT_LIST: 'agent:list',
  AGENT_CREATE: 'agent:create',
  AGENT_UPDATE: 'agent:update',
  AGENT_DELETE: 'agent:delete',
  AGENT_ACTIVATE: 'agent:activate',
  AGENT_DELEGATE: 'agent:delegate',

  // Workflows
  WORKFLOW_LIST: 'workflow:list',
  WORKFLOW_CREATE: 'workflow:create',
  WORKFLOW_UPDATE: 'workflow:update',
  WORKFLOW_DELETE: 'workflow:delete',
  WORKFLOW_RUN: 'workflow:run',

  // Plugins / Knowledge
  PLUGIN_LIST: 'plugin:list',
  PLUGIN_ENABLE: 'plugin:enable',
  PLUGIN_DISABLE: 'plugin:disable',
  PLUGIN_GET_CONFIG: 'plugin:getConfig',
  PLUGIN_SET_CONFIG: 'plugin:setConfig',
  KNOWLEDGE_LIST: 'knowledge:list',
  KNOWLEDGE_INGEST: 'knowledge:ingest',

  // App Control
  APP_GET_SETTINGS: 'app:getSettings',
  APP_SAVE_SETTINGS: 'app:saveSettings',
  APP_GET_SKIN: 'app:getSkin',
  APP_SET_SKIN: 'app:setSkin',
  APP_LIST_SKINS: 'app:listSkins',

  // Companion
  COMPANION_STATUS: 'companion:status',
  COMPANION_ENABLE: 'companion:enable',
  COMPANION_DISABLE: 'companion:disable',
  COMPANION_GENERATE_PAIRING: 'companion:generate-pairing',
  COMPANION_RENDER_QR: 'companion:render-qr',
  COMPANION_LIST_DEVICES: 'companion:listDevices',

  // TTS / STT
  TTS_SYNTHESIZE: 'tts:synthesize',
  TTS_GET_STATUS: 'tts:getStatus',
  STT_TRANSCRIBE: 'stt:transcribe',

  // Profile management
  PROFILE_LIST: 'profile:list',
  PROFILE_SWITCH: 'profile:switch',
  PROFILE_CREATE: 'profile:create',
  PROFILE_GET_ACTIVE: 'profile:getActive',

  // Todos / Calendar
  TODO_LIST: 'todo:list',
  TODO_ADD: 'todo:add',
  TODO_UPDATE: 'todo:update',
  TODO_DELETE: 'todo:delete',
  CALENDAR_LIST: 'calendar:list',
  CALENDAR_ADD: 'calendar:add',
  CALENDAR_UPDATE: 'calendar:update',
  CALENDAR_DELETE: 'calendar:delete',
} as const;

export type IpcChannelName = typeof IPC_CHANNELS[keyof typeof IPC_CHANNELS] | string;

export interface IpcHandlerRegistration {
  channel: IpcChannelName;
  handler: (event: any, ...args: any[]) => any;
}

export interface IpcInvokeResult<T = any> {
  success: boolean;
  result?: T;
  error?: string;
}
