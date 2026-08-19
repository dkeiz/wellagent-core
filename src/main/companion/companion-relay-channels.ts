// @ts-nocheck
const COMPANION_RELAY_CHANNELS = new Set([
  'conversation-update',
  'background-event',
  'background-notification',
  'tool-preview-update',
  'chat-turn-event',
  'capability-update',
  'agent-update',
  'settings-change',
  'workflow-update',
  'task-queue-update',
  'calendar-update',
  'todo-update',
  'tool-update',
  'execution-context-updated',
  'plugins:state-changed',
  'a2a-status-update',
  'tool-permission-request'
]);

module.exports = {
  COMPANION_RELAY_CHANNELS
};
