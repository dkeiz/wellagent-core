// @ts-nocheck
const { getEffectiveLlmSelection } = require('./llm-state');
const { getModelRuntimeConfig } = require('./llm-config');

const ROOM_PLUGIN_STATE_PREFIX = 'plugin.agent-agents-room.state.agent-';
const DEFAULT_CONTEXT_MESSAGES = 12;
const DEFAULT_MAX_TURNS = 6;

function parseJsonObject(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return String(value).trim().toLowerCase() === 'true';
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createParticipantId() {
  return `room-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildRoomStateKey(hostAgentId) {
  return `${ROOM_PLUGIN_STATE_PREFIX}${Number(hostAgentId) || 0}`;
}

function parseAgentConfig(agent) {
  return parseJsonObject(agent?.config, {});
}

function normalizeParticipant(input = {}) {
  return {
    id: normalizeText(input.id) || createParticipantId(),
    agentId: Number(input.agentId || input.agent_id || 0) || null,
    name: normalizeText(input.name),
    role: normalizeText(input.role),
    enabled: toBool(input.enabled, true),
    provider: normalizeText(input.provider),
    model: normalizeText(input.model),
    temperature: normalizeText(input.temperature),
    thinkingMode: normalizeText(input.thinkingMode || input.thinking_mode),
    contextBudget: normalizePositiveInt(input.contextBudget || input.context_budget, 0),
    turnsTaken: normalizePositiveInt(input.turnsTaken || input.turns_taken, 0),
    lastSpokeAt: normalizeText(input.lastSpokeAt || input.last_spoke_at)
  };
}

function normalizeRoomState(raw = {}) {
  const participants = Array.isArray(raw.participants)
    ? raw.participants.map(normalizeParticipant).filter((entry) => entry.agentId)
    : [];

  return {
    goal: normalizeText(raw.goal),
    instructions: normalizeText(raw.instructions),
    loopMode: normalizeText(raw.loopMode || raw.loop_mode || 'manual') || 'manual',
    toolMode: normalizeText(raw.toolMode || raw.tool_mode || 'shared') || 'shared',
    contextMode: normalizeText(raw.contextMode || raw.context_mode || 'recent') || 'recent',
    contextMessages: normalizePositiveInt(raw.contextMessages || raw.context_messages, DEFAULT_CONTEXT_MESSAGES),
    maxTurnsPerRun: normalizePositiveInt(raw.maxTurnsPerRun || raw.max_turns_per_run, DEFAULT_MAX_TURNS),
    participants,
    runState: {
      status: normalizeText(raw.runState?.status || raw.status || 'idle') || 'idle',
      nextParticipantId: normalizeText(raw.runState?.nextParticipantId || raw.runState?.next_participant_id),
      lastParticipantId: normalizeText(raw.runState?.lastParticipantId || raw.runState?.last_participant_id),
      loopCount: normalizePositiveInt(raw.runState?.loopCount || raw.runState?.loop_count, 0),
      turnCount: normalizePositiveInt(raw.runState?.turnCount || raw.runState?.turn_count, 0),
      updatedAt: normalizeText(raw.runState?.updatedAt || raw.runState?.updated_at)
    }
  };
}

class AgentsRoomService {
  constructor(container, options = {}) {
    this.container = container;
    this.db = options.db || container.get('db');
    this.agentManager = options.agentManager || container.get('agentManager');
    this.dispatcher = options.dispatcher || container.get('dispatcher');
    this.chainController = options.chainController || container.optional('chainController');
    this.windowManager = options.windowManager || container.optional('windowManager');
  }

  _scope(options = {}) {
    return options && typeof options === 'object' ? options : {};
  }

  async _readScopedSetting(key, options = {}) {
    const scope = this._scope(options);
    if (this.db?.getScopedSetting && (scope.requestContext || scope.userId)) {
      return this.db.getScopedSetting(key, scope);
    }
    return this.db.getSetting(key);
  }

  async _writeScopedSetting(key, value, options = {}) {
    const scope = this._scope(options);
    if (this.db?.saveScopedSetting && (scope.requestContext || scope.userId)) {
      return this.db.saveScopedSetting(key, value, scope);
    }
    return this.db.saveSetting(key, value);
  }

  async getRoomState(hostAgentId, options = {}) {
    const raw = await this._readScopedSetting(buildRoomStateKey(hostAgentId), this._scope(options));
    return normalizeRoomState(parseJsonObject(raw, {}));
  }

  async saveRoomState(hostAgentId, patch = {}, options = {}) {
    const current = await this.getRoomState(hostAgentId, options);
    const next = normalizeRoomState({
      ...current,
      ...patch,
      runState: {
        ...(current.runState || {}),
        ...(patch.runState || {})
      },
      updatedAt: new Date().toISOString()
    });
    await this._writeScopedSetting(
      buildRoomStateKey(hostAgentId),
      JSON.stringify(next),
      this._scope(options)
    );
    return next;
  }

  async listAvailableParticipants(hostAgentId, options = {}) {
    const agents = await this.agentManager.getAgents(null, this._scope(options));
    return agents
      .filter((agent) => Number(agent.id) !== Number(hostAgentId))
      .filter((agent) => !['daemon'].includes(String(agent.type || '').toLowerCase()))
      .map((agent) => {
        const config = parseAgentConfig(agent);
        return {
          id: agent.id,
          name: agent.name || `Agent ${agent.id}`,
          type: agent.type || 'pro',
          icon: agent.icon || '🤖',
          provider: normalizeText(config.provider || config.llm_provider || config.model_provider || agent.provider_override),
          model: normalizeText(config.model || config.llm_model || config.model_name || agent.model_override)
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async addParticipant(hostAgentId, input = {}, options = {}) {
    const agentId = Number(input.agentId || input.agent_id || 0);
    if (!Number.isFinite(agentId) || agentId <= 0) {
      throw new Error('participant agentId is required');
    }
    const agent = await this.agentManager.getAgent(agentId, this._scope(options));
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const state = await this.getRoomState(hostAgentId, options);
    if (state.participants.some((entry) => Number(entry.agentId) === agentId)) {
      return state;
    }

    const config = parseAgentConfig(agent);
    state.participants.push(normalizeParticipant({
      agentId,
      name: agent.name,
      role: input.role || '',
      enabled: true,
      provider: input.provider || config.provider || config.llm_provider || '',
      model: input.model || config.model || config.llm_model || ''
    }));

    return this.saveRoomState(hostAgentId, state, options);
  }

  async updateParticipant(hostAgentId, participantId, patch = {}, options = {}) {
    const state = await this.getRoomState(hostAgentId, options);
    const target = state.participants.find((entry) => String(entry.id) === String(participantId));
    if (!target) {
      throw new Error(`Participant not found: ${participantId}`);
    }
    Object.assign(target, normalizeParticipant({ ...target, ...patch, id: target.id, agentId: target.agentId }));
    return this.saveRoomState(hostAgentId, state, options);
  }

  async removeParticipant(hostAgentId, participantId, options = {}) {
    const state = await this.getRoomState(hostAgentId, options);
    state.participants = state.participants.filter((entry) => String(entry.id) !== String(participantId));
    if (String(state.runState.nextParticipantId) === String(participantId)) {
      state.runState.nextParticipantId = '';
    }
    return this.saveRoomState(hostAgentId, state, options);
  }

  async moveParticipant(hostAgentId, participantId, direction = 'down', options = {}) {
    const state = await this.getRoomState(hostAgentId, options);
    const index = state.participants.findIndex((entry) => String(entry.id) === String(participantId));
    if (index < 0) {
      throw new Error(`Participant not found: ${participantId}`);
    }
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= state.participants.length) {
      return state;
    }
    const [item] = state.participants.splice(index, 1);
    state.participants.splice(targetIndex, 0, item);
    return this.saveRoomState(hostAgentId, state, options);
  }

  async setRoomFields(hostAgentId, patch = {}, options = {}) {
    return this.saveRoomState(hostAgentId, patch, options);
  }

  _formatSpeakerLabel(message = {}) {
    if (message.role === 'user') {
      return String(message.metadata?.sourceLabel || 'User');
    }
    if (message.role === 'assistant') {
      return String(message.metadata?.agentRoomParticipantName || message.metadata?.assistantLabel || 'Assistant');
    }
    if (message.role === 'system') {
      return 'System';
    }
    return String(message.role || 'Message');
  }

  _buildContextBlock(messages = [], state = {}) {
    const mode = String(state.contextMode || 'recent').toLowerCase();
    const maxMessages = normalizePositiveInt(state.contextMessages, DEFAULT_CONTEXT_MESSAGES);
    const selected = mode === 'full' ? messages : messages.slice(Math.max(0, messages.length - maxMessages));

    return selected.map((message) => {
      const label = this._formatSpeakerLabel(message);
      const content = String(message.content || '').trim();
      return `${label}: ${content}`;
    }).join('\n\n');
  }

  _buildParticipantPrompt(participant, state, contextBlock) {
    const sections = [];
    if (state.goal) {
      sections.push(`Room goal:\n${state.goal}`);
    }
    if (state.instructions) {
      sections.push(`Room instructions:\n${state.instructions}`);
    }
    if (participant.role) {
      sections.push(`Your room role:\n${participant.role}`);
    }
    if (contextBlock) {
      sections.push(`Current room conversation:\n${contextBlock}`);
    }
    sections.push([
      `Reply as ${participant.name || `Agent ${participant.agentId}`}.`,
      'Continue the shared room conversation from your own perspective.',
      'Address what was already said instead of restarting the topic.'
    ].join('\n'));
    return sections.join('\n\n');
  }

  async _resolveEffectiveSelection(participant, agent, options = {}) {
    const config = parseAgentConfig(agent);
    const fallback = await getEffectiveLlmSelection(this.db, this._scope(options));
    const provider = normalizeText(
      participant.provider
      || config.provider
      || config.llm_provider
      || agent.provider_override
      || fallback.provider
    );
    const model = normalizeText(
      participant.model
      || config.model
      || config.llm_model
      || config.model_name
      || agent.model_override
      || fallback.model
    );
    const runtimeResult = provider && model
      ? await getModelRuntimeConfig(this.db, provider, model, this._scope(options))
      : { spec: null, runtime: null };
    return {
      provider,
      model,
      runtimeConfig: runtimeResult.runtime || null,
      modelSpec: runtimeResult.spec || null
    };
  }

  async _buildSystemPrompt(hostAgentId, participant, state, sessionId, options = {}) {
    const participantAgent = await this.agentManager.getAgent(participant.agentId, this._scope(options));
    if (!participantAgent) {
      throw new Error(`Participant agent not found: ${participant.agentId}`);
    }

    const basePrompt = await this.dispatcher._buildSystemPrompt({
      includeTools: false,
      includeRules: true,
      includeEnv: true,
      skipMemoryOnStart: true,
      sessionId,
      agentId: participant.agentId,
      requestContext: this._scope(options).requestContext || null
    });

    const toolAgentId = String(state.toolMode || 'shared').toLowerCase() === 'shared'
      ? hostAgentId
      : participant.agentId;

    const toolContext = await this.dispatcher._buildToolContext({
      sessionId,
      agentId: toolAgentId,
      requestContext: this._scope(options).requestContext || null
    });

    return [
      basePrompt,
      '<agents_room>',
      `Host agent id: ${hostAgentId}`,
      `Participant label: ${participant.name || `Agent ${participant.agentId}`}`,
      `Participant role: ${participant.role || 'general contributor'}`,
      'You are inside Agents Room. Respond only as the active participant.',
      'Do not speak for the host room or for other participants.',
      '</agents_room>',
      toolContext
    ].join('\n\n');
  }

  async runParticipantTurn(hostAgentId, participantId, input = {}, options = {}) {
    const scope = this._scope({ ...options, requestContext: input.requestContext || options.requestContext || null });
    const sessionId = String(input.sessionId || '').trim();
    if (!sessionId) {
      throw new Error('sessionId is required');
    }

    const state = await this.getRoomState(hostAgentId, scope);
    const participant = state.participants.find((entry) => String(entry.id) === String(participantId));
    if (!participant) {
      throw new Error(`Participant not found: ${participantId}`);
    }
    if (participant.enabled !== true) {
      throw new Error(`Participant is disabled: ${participant.name || participant.agentId}`);
    }

    const agent = await this.agentManager.getAgent(participant.agentId, scope);
    if (!agent) {
      throw new Error(`Agent not found: ${participant.agentId}`);
    }

    const messages = await this.db.getConversations(200, sessionId, scope);
    const contextBlock = this._buildContextBlock(messages, state);
    const prompt = this._buildParticipantPrompt(participant, state, contextBlock);
    const systemPrompt = await this._buildSystemPrompt(hostAgentId, participant, state, sessionId, scope);
    const selection = await this._resolveEffectiveSelection(participant, agent, scope);
    const executionAgentId = String(state.toolMode || 'shared').toLowerCase() === 'shared'
      ? Number(hostAgentId)
      : Number(participant.agentId);

    const response = this.chainController?.executeWithChaining
      ? await this.chainController.executeWithChaining(prompt, [], {
          mode: 'chat',
          sessionId,
          agentId: executionAgentId,
          systemPrompt,
          provider: selection.provider || undefined,
          model: selection.model || undefined,
          modelSpec: selection.modelSpec || undefined,
          runtimeConfig: selection.runtimeConfig || undefined,
          temperature: participant.temperature ? Number(participant.temperature) : undefined,
          thinkingMode: participant.thinkingMode || undefined,
          requestContext: scope.requestContext || null
        })
      : await this.dispatcher.dispatch(prompt, [], {
          mode: 'chat',
          sessionId,
          agentId: executionAgentId,
          systemPrompt,
          provider: selection.provider || undefined,
          model: selection.model || undefined,
          modelSpec: selection.modelSpec || undefined,
          runtimeConfig: selection.runtimeConfig || undefined,
          temperature: participant.temperature ? Number(participant.temperature) : undefined,
          thinkingMode: participant.thinkingMode || undefined,
          requestContext: scope.requestContext || null
        });

    const content = String(response?.content || '').trim();
    if (!content) {
      throw new Error(`Participant returned empty content: ${participant.name || participant.agentId}`);
    }

    await this.db.addConversation({
      role: 'assistant',
      content,
      metadata: {
        agentRoomParticipantId: participant.id,
        agentRoomParticipantName: participant.name || agent.name || `Agent ${participant.agentId}`,
        agentRoomHostId: Number(hostAgentId),
        agentRoom: true,
        provider: response?.provider || selection.provider || '',
        model: response?.model || selection.model || ''
      }
    }, sessionId, scope);

    participant.turnsTaken = Number(participant.turnsTaken || 0) + 1;
    participant.lastSpokeAt = new Date().toISOString();
    state.runState.status = 'idle';
    state.runState.lastParticipantId = participant.id;
    state.runState.turnCount = Number(state.runState.turnCount || 0) + 1;
    state.runState.updatedAt = new Date().toISOString();
    await this.saveRoomState(hostAgentId, state, scope);
    this.windowManager?.send?.('conversation-update', { sessionId });

    return {
      success: true,
      participantId: participant.id,
      participantName: participant.name || agent.name || `Agent ${participant.agentId}`,
      content,
      provider: response?.provider || selection.provider || '',
      model: response?.model || selection.model || ''
    };
  }

  async runLoop(hostAgentId, input = {}, options = {}) {
    const scope = this._scope({ ...options, requestContext: input.requestContext || options.requestContext || null });
    const state = await this.getRoomState(hostAgentId, scope);
    const turns = normalizePositiveInt(input.turns, state.maxTurnsPerRun || 1);
    const enabled = state.participants.filter((entry) => entry.enabled === true);
    if (enabled.length === 0) {
      throw new Error('No enabled room participants');
    }

    let startIndex = 0;
    if (state.runState.lastParticipantId) {
      const lastIndex = enabled.findIndex((entry) => String(entry.id) === String(state.runState.lastParticipantId));
      if (lastIndex >= 0) {
        startIndex = (lastIndex + 1) % enabled.length;
      }
    }

    const results = [];
    for (let index = 0; index < turns; index += 1) {
      const participant = enabled[(startIndex + index) % enabled.length];
      const result = await this.runParticipantTurn(hostAgentId, participant.id, input, scope);
      results.push(result);
    }

    const latestState = await this.getRoomState(hostAgentId, scope);
    await this.saveRoomState(hostAgentId, {
      runState: {
        ...latestState.runState,
        loopCount: Number(latestState.runState?.loopCount || 0) + 1,
        updatedAt: new Date().toISOString()
      }
    }, scope);

    return {
      success: true,
      turns: results.length,
      results
    };
  }
}

module.exports = { AgentsRoomService };

