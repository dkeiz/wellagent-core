// --- Event bus types ---

export type EventCategory =
  | 'memory'
  | 'workflow'
  | 'agent'
  | 'plugin'
  | 'companion'
  | 'system'
  | 'chat'
  | 'knowledge'
  | 'a2a'
  | string;

export type EventPriority = 'low' | 'normal' | 'high' | 'critical';

export interface BackendEvent {
  eventType: string;
  category: EventCategory;
  data?: any;
  timestamp?: string;
  source?: string;
  priority?: EventPriority;
  sessionId?: string;
  userId?: string;
}

export interface EventSubscription {
  id: string;
  category?: EventCategory;
  eventType?: string;
  handler: (event: BackendEvent) => void | Promise<void>;
}

export interface EventBusOptions {
  notifyPromptPath?: string;
  [key: string]: any;
}

export interface EventBusInitOptions {
  windowManager?: any;
  mainWindow?: any;
  dispatcher?: any;
  db?: any;
}
