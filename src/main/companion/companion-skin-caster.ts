// @ts-nocheck
const fs = require('fs');

const SELECTOR_MAP = [
  ['.app-container', '.app-shell'],
  ['.content-panel', '.main-shell'],
  ['.messages-container', '.message-list'],
  ['.input-container', '.composer-shell'],
  ['.chat-input-row', '.composer-row'],
  ['#message-input', '#composer-input'],
  ['.send-button', '#send-btn'],
  ['.stop-button', '#stop-btn'],
  ['.widget-panel', '.sidebar-right'],
  ['#right-panel', '#right-sidebar'],
  ['.chat-tab-new-session', '.session-item'],
  ['.chat-tab-new', '#new-session-btn'],
  ['.active-chat-tab', '.session-item.active'],
  ['.chat-tab.active', '.session-item.active'],
  ['.chat-tab', '.session-item'],
  ['.message.assistant', '.message-card.message-assistant'],
  ['.message.system', '.message-card.message-system'],
  ['.message.user', '.message-card.message-user'],
  ['.message', '.message-card'],
  ['.capability-group-pad.active', '.capability-chip.active'],
  ['.capability-group-pad', '.capability-chip'],
  ['.settings-group', '.sidebar-section'],
  ['.compact-btn', '.compact-btn'],
  ['.icon-btn-sm', '.icon-only'],
  ['.icon-btn', '.icon-only']
];

function castCompanionSkinCss(css) {
  let output = String(css || '');
  for (const [from, to] of SELECTOR_MAP) {
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    output = output.replace(new RegExp(`${escaped}(?![A-Za-z0-9_-])`, 'g'), to);
  }
  return [
    '/* Cast from desktop skin selectors for companion web. */',
    output
  ].join('\n');
}

function readAndCastCompanionSkin(filePath) {
  return castCompanionSkinCss(fs.readFileSync(filePath, 'utf8'));
}

module.exports = {
  castCompanionSkinCss,
  readAndCastCompanionSkin
};
