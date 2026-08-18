export type RequestContextSource =
  | 'electron'
  | 'companion'
  | 'a2a'
  | 'www-gate'
  | 'headless'
  | 'external-test'
  | 'unknown';

export interface RequestContext {
  source: RequestContextSource;
  userId?: string;
  sessionId?: string;
  deviceId?: string;
  requestId?: string;
}
