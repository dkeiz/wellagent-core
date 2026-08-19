let roomApi = null;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, '&#39;');
}

function renderAction(label, action, payload = {}, extraClass = '') {
  return `<button type="button" class="agents-room-btn${extraClass ? ` ${extraClass}` : ''}"
    data-agent-ui-action="${escapeAttr(action)}"
    data-agent-ui-payload='${escapeAttr(JSON.stringify(payload))}'>${escapeHtml(label)}</button>`;
}

async function loadModel(agentInfo) {
  const [room, available] = await Promise.all([
    roomApi.getRoomState(agentInfo.id),
    roomApi.listAvailableParticipants(agentInfo.id)
  ]);
  return { room, available };
}

function renderParticipantCard(participant, availableById) {
  const source = availableById.get(String(participant.agentId)) || null;
  const title = participant.name || source?.name || `Agent ${participant.agentId}`;
  const icon = source?.icon || '🤖';
  const status = participant.enabled ? 'enabled' : 'muted';
  return `<article class="agents-room-participant-card">
    <div class="agents-room-participant-head">
      <strong>${escapeHtml(icon)} ${escapeHtml(title)}</strong>
      <span class="agents-room-chip ${status}">${escapeHtml(status)}</span>
    </div>
    <div class="agents-room-participant-meta">agent #${escapeHtml(participant.agentId)} · turns ${escapeHtml(participant.turnsTaken || 0)}</div>
    <form data-agent-ui-action="update-participant" data-agent-ui-payload='${escapeAttr(JSON.stringify({ participantId: participant.id }))}'>
      <input type="hidden" name="participantId" value="${escapeAttr(participant.id)}">
      <label class="agents-room-field">
        <span>Role</span>
        <textarea name="role" rows="2" placeholder="critic, planner, builder...">${escapeHtml(participant.role || '')}</textarea>
      </label>
      <div class="agents-room-grid two">
        <label class="agents-room-field">
          <span>Provider</span>
          <input type="text" name="provider" value="${escapeAttr(participant.provider || '')}" placeholder="${escapeAttr(source?.provider || 'openrouter')}">
        </label>
        <label class="agents-room-field">
          <span>Model</span>
          <input type="text" name="model" value="${escapeAttr(participant.model || '')}" placeholder="${escapeAttr(source?.model || 'model name')}">
        </label>
      </div>
      <div class="agents-room-grid two">
        <label class="agents-room-field">
          <span>Temperature</span>
          <input type="text" name="temperature" value="${escapeAttr(participant.temperature || '')}" placeholder="0.7">
        </label>
        <label class="agents-room-field">
          <span>Thinking</span>
          <input type="text" name="thinkingMode" value="${escapeAttr(participant.thinkingMode || '')}" placeholder="auto">
        </label>
      </div>
      <label class="agents-room-toggle">
        <input type="checkbox" name="enabled" value="true" ${participant.enabled ? 'checked' : ''}>
        <span>Enabled</span>
      </label>
      <div class="agents-room-actions">
        <button type="submit" class="agents-room-btn">Save</button>
        ${renderAction('Speak', 'speak-participant', { participantId: participant.id })}
        ${renderAction('Up', 'move-participant', { participantId: participant.id, direction: 'up' }, 'secondary')}
        ${renderAction('Down', 'move-participant', { participantId: participant.id, direction: 'down' }, 'secondary')}
        ${renderAction('Remove', 'remove-participant', { participantId: participant.id }, 'danger')}
      </div>
    </form>
  </article>`;
}

function renderAddParticipant(available, room) {
  const activeIds = new Set((room.participants || []).map((entry) => String(entry.agentId)));
  const options = available
    .filter((entry) => !activeIds.has(String(entry.id)))
    .map((entry) => `<option value="${escapeAttr(entry.id)}">${escapeHtml(entry.icon || '🤖')} ${escapeHtml(entry.name)}</option>`)
    .join('');

  return `<section class="agents-room-panel">
    <div class="agents-room-section-head">
      <h4>Add Participant</h4>
      <span>${escapeHtml(room.participants?.length || 0)} configured</span>
    </div>
    <form class="agents-room-inline-form" data-agent-ui-action="add-participant">
      <select name="agentId">
        <option value="">Select agent...</option>
        ${options}
      </select>
      <input type="text" name="role" placeholder="role label">
      <button type="submit" class="agents-room-btn">Add</button>
    </form>
  </section>`;
}

async function renderPanel(agentInfo, note = '') {
  const { room, available } = await loadModel(agentInfo);
  const availableById = new Map(available.map((entry) => [String(entry.id), entry]));
  const participantsHtml = room.participants.length
    ? room.participants.map((participant) => renderParticipantCard(participant, availableById)).join('')
    : '<div class="agents-room-empty">Add participants to start the room.</div>';

  return `<section class="agents-room-shell" data-agents-room-root>
    <div class="agents-room-top">
      <div>
        <div class="agents-room-kicker">Multi-Agent Host</div>
        <h3>Agents Room</h3>
      </div>
      <div class="agents-room-actions">
        ${renderAction('Refresh', 'refresh', {}, 'secondary')}
      </div>
    </div>
    <div class="agents-room-note"${note ? '' : ' hidden'}>${escapeHtml(note)}</div>
    <div class="agents-room-layout">
      <div class="agents-room-left">
        <section class="agents-room-panel">
          <div class="agents-room-section-head">
            <h4>Room Settings</h4>
            <span>${escapeHtml(room.runState?.status || 'idle')}</span>
          </div>
          <form data-agent-ui-action="save-room">
            <label class="agents-room-field">
              <span>Goal</span>
              <textarea name="goal" rows="2" placeholder="What should this room work on?">${escapeHtml(room.goal || '')}</textarea>
            </label>
            <label class="agents-room-field">
              <span>Instructions</span>
              <textarea name="instructions" rows="3" placeholder="Extra room guidance">${escapeHtml(room.instructions || '')}</textarea>
            </label>
            <div class="agents-room-grid three">
              <label class="agents-room-field">
                <span>Loop Mode</span>
                <select name="loopMode">
                  <option value="manual"${room.loopMode === 'manual' ? ' selected' : ''}>manual</option>
                  <option value="auto"${room.loopMode === 'auto' ? ' selected' : ''}>auto</option>
                </select>
              </label>
              <label class="agents-room-field">
                <span>Tools</span>
                <select name="toolMode">
                  <option value="shared"${room.toolMode === 'shared' ? ' selected' : ''}>shared</option>
                  <option value="participant"${room.toolMode === 'participant' ? ' selected' : ''}>participant</option>
                </select>
              </label>
              <label class="agents-room-field">
                <span>Context</span>
                <select name="contextMode">
                  <option value="recent"${room.contextMode === 'recent' ? ' selected' : ''}>recent</option>
                  <option value="full"${room.contextMode === 'full' ? ' selected' : ''}>full</option>
                </select>
              </label>
            </div>
            <div class="agents-room-grid two">
              <label class="agents-room-field">
                <span>Context Messages</span>
                <input type="number" min="4" max="80" name="contextMessages" value="${escapeAttr(room.contextMessages || 12)}">
              </label>
              <label class="agents-room-field">
                <span>Max Turns / Run</span>
                <input type="number" min="1" max="20" name="maxTurnsPerRun" value="${escapeAttr(room.maxTurnsPerRun || 6)}">
              </label>
            </div>
            <div class="agents-room-actions">
              <button type="submit" class="agents-room-btn">Save Room</button>
              ${renderAction('Run 1 Turn', 'run-loop', { turns: 1 }, 'secondary')}
              ${renderAction('Run 3 Turns', 'run-loop', { turns: 3 }, 'secondary')}
            </div>
          </form>
        </section>
        ${renderAddParticipant(available, room)}
        <section class="agents-room-panel">
          <div class="agents-room-section-head">
            <h4>Participants</h4>
            <span>${escapeHtml(room.participants.filter((entry) => entry.enabled).length)} enabled</span>
          </div>
          <div class="agents-room-participant-list">${participantsHtml}</div>
        </section>
      </div>
      <div class="agents-room-right">
        <section class="agents-room-panel agents-room-chat-panel">
          <div class="agents-room-section-head">
            <h4>Shared Room Conversation</h4>
            <span>participant turns write into this session</span>
          </div>
          <div class="agents-room-chat-host" data-agent-ui-chat-host></div>
        </section>
      </div>
    </div>
  </section>`;
}

const css = `
.agents-room-shell {
  display: grid;
  gap: 10px;
  margin-bottom: 12px;
  border: 1px solid var(--border-color);
  border-radius: 14px;
  padding: 12px;
  background:
    radial-gradient(circle at top right, rgba(57, 142, 255, 0.12), transparent 28%),
    linear-gradient(180deg, rgba(13, 39, 73, 0.08), rgba(13, 39, 73, 0.02));
}
.agents-room-top,
.agents-room-actions,
.agents-room-inline-form,
.agents-room-toggle {
  display: flex;
  gap: 8px;
  align-items: center;
}
.agents-room-top,
.agents-room-section-head {
  justify-content: space-between;
}
.agents-room-kicker,
.agents-room-note,
.agents-room-section-head span,
.agents-room-field span,
.agents-room-participant-meta,
.agents-room-empty {
  color: var(--text-secondary);
  font-size: var(--text-xs);
}
.agents-room-top h3,
.agents-room-section-head h4 {
  margin: 0;
}
.agents-room-note {
  padding: 8px 10px;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: rgba(57, 142, 255, 0.08);
}
.agents-room-layout {
  display: grid;
  grid-template-columns: minmax(340px, 430px) minmax(0, 1fr);
  gap: 12px;
}
.agents-room-left,
.agents-room-right,
.agents-room-participant-list {
  display: grid;
  gap: 10px;
}
.agents-room-panel,
.agents-room-participant-card {
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 10px;
  background: var(--card-bg);
}
.agents-room-grid {
  display: grid;
  gap: 8px;
}
.agents-room-grid.two {
  grid-template-columns: 1fr 1fr;
}
.agents-room-grid.three {
  grid-template-columns: repeat(3, 1fr);
}
.agents-room-field {
  display: grid;
  gap: 4px;
}
.agents-room-field input,
.agents-room-field select,
.agents-room-field textarea,
.agents-room-inline-form input,
.agents-room-inline-form select {
  width: 100%;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--chat-bg);
  color: var(--text-primary);
  padding: 7px 8px;
}
.agents-room-inline-form {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) auto;
}
.agents-room-btn {
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 7px 10px;
  background: rgba(57, 142, 255, 0.12);
  color: var(--text-primary);
  cursor: pointer;
}
.agents-room-btn.secondary {
  background: transparent;
}
.agents-room-btn.danger {
  background: rgba(180, 66, 66, 0.12);
}
.agents-room-chip {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--border-color);
  border-radius: 999px;
  padding: 3px 8px;
  font-size: var(--text-xs);
  text-transform: capitalize;
}
.agents-room-chip.enabled {
  background: rgba(37, 160, 80, 0.12);
}
.agents-room-chip.muted {
  background: rgba(130, 130, 130, 0.12);
}
.agents-room-participant-head,
.agents-room-participant-card form {
  display: grid;
  gap: 8px;
}
.agents-room-chat-panel {
  height: 100%;
}
.agents-room-chat-host {
  display: flex;
  min-height: 520px;
  max-height: 66vh;
  overflow: hidden;
}
.agents-room-chat-host .messages-container {
  height: 100%;
  max-height: none;
  overflow-y: auto !important;
}
@media (max-width: 1080px) {
  .agents-room-layout,
  .agents-room-grid.two,
  .agents-room-grid.three,
  .agents-room-inline-form {
    grid-template-columns: 1fr;
  }
  .agents-room-chat-host {
    min-height: 320px;
  }
}
`;

module.exports = {
  onEnable(context) {
    roomApi = context.agentsRoom;
    context.registerChatUI({
      title: 'Agents Room',
      async renderPanel(agentInfo) {
        return renderPanel(agentInfo);
      },
      css,
      actions: {
        async refresh({ agentInfo }) {
          return { success: true, html: await renderPanel(agentInfo), css };
        },
        async 'save-room'({ agentInfo, payload }) {
          const patch = {
            goal: payload.goal || '',
            instructions: payload.instructions || '',
            loopMode: payload.loopMode || 'manual',
            toolMode: payload.toolMode || 'shared',
            contextMode: payload.contextMode || 'recent',
            contextMessages: payload.contextMessages || 12,
            maxTurnsPerRun: payload.maxTurnsPerRun || 6
          };
          await roomApi.setRoomFields(agentInfo.id, patch);
          return { success: true, html: await renderPanel(agentInfo, 'Room settings saved.'), css };
        },
        async 'add-participant'({ agentInfo, payload }) {
          await roomApi.addParticipant(agentInfo.id, payload);
          return { success: true, html: await renderPanel(agentInfo, 'Participant added.'), css };
        },
        async 'update-participant'({ agentInfo, payload }) {
          const enabled = payload.enabled === 'true' || payload.enabled === true || payload.enabled === 'on';
          await roomApi.updateParticipant(agentInfo.id, payload.participantId, {
            role: payload.role || '',
            provider: payload.provider || '',
            model: payload.model || '',
            temperature: payload.temperature || '',
            thinkingMode: payload.thinkingMode || '',
            enabled
          });
          return { success: true, html: await renderPanel(agentInfo, 'Participant updated.'), css };
        },
        async 'remove-participant'({ agentInfo, payload }) {
          await roomApi.removeParticipant(agentInfo.id, payload.participantId);
          return { success: true, html: await renderPanel(agentInfo, 'Participant removed.'), css };
        },
        async 'move-participant'({ agentInfo, payload }) {
          await roomApi.moveParticipant(agentInfo.id, payload.participantId, payload.direction || 'down');
          return { success: true, html: await renderPanel(agentInfo), css };
        },
        async 'speak-participant'({ agentInfo, payload, uiContext }) {
          const sessionId = String(uiContext?.sessionId || '').trim();
          if (!sessionId) {
            return { success: false, error: 'Missing room session' };
          }
          const result = await roomApi.runParticipantTurn(agentInfo.id, payload.participantId, { sessionId });
          return { success: true, html: await renderPanel(agentInfo, `${result.participantName} replied.`), css };
        },
        async 'run-loop'({ agentInfo, payload, uiContext }) {
          const sessionId = String(uiContext?.sessionId || '').trim();
          if (!sessionId) {
            return { success: false, error: 'Missing room session' };
          }
          const result = await roomApi.runLoop(agentInfo.id, {
            sessionId,
            turns: payload.turns || 1
          });
          return {
            success: true,
            html: await renderPanel(agentInfo, `Loop finished: ${result.turns} turn(s).`),
            css
          };
        }
      }
    });
  }
};
