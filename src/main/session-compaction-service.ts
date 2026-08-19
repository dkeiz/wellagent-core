// @ts-nocheck
const { getEffectiveLlmSelection } = require('./llm-state');

const LOCAL_COMPACTION_PROMPT = `Create a compact continuation checkpoint for this conversation.
Preserve established facts, user requirements, decisions, unresolved work, current implementation state,
important file or artifact references, and tests or verification already performed.
Remove repetition, greetings, obsolete exploration, and verbose tool output.
Write a concise structured summary that another model can use to continue naturally.
Do not address the user and do not claim that you changed files or completed new work.`;

function normalizeScope(options = {}) {
  const requestContext = options?.requestContext || null;
  const userId = String(options?.userId || requestContext?.userId || '').trim();
  return { requestContext, ...(userId ? { userId } : {}) };
}

function normalizeUsage(result = {}) {
  const usage = result?.usage || null;
  if (!usage || typeof usage !== 'object') return null;
  const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
  const totalTokens = Number(usage.total_tokens || inputTokens + outputTokens);
  if (![inputTokens, outputTokens, totalTokens].some(value => Number.isFinite(value) && value > 0)) return null;
  return {
    input_tokens: inputTokens,
    prompt_tokens: inputTokens,
    output_tokens: outputTokens,
    completion_tokens: outputTokens,
    total_tokens: totalTokens,
    cached_tokens: Number(usage.cached_tokens || 0)
  };
}

function buildRecoveryCapsule(history = []) {
  const messages = Array.isArray(history) ? history : [];
  const selected = messages.length <= 12
    ? messages
    : [...messages.slice(0, 2), ...messages.slice(-10)];
  const transcript = selected.map(message => {
    const role = String(message?.role || 'user').toUpperCase();
    const content = String(message?.content || '').trim().slice(0, 1200);
    return content ? `${role}: ${content}` : '';
  }).filter(Boolean).join('\n\n');
  return [
    'Portable recovery capsule from a provider-native compaction.',
    messages.length > selected.length
      ? `${messages.length - selected.length} older messages are represented only by the provider-native compacted thread.`
      : '',
    transcript
  ].filter(Boolean).join('\n\n').slice(0, 12000);
}

class SessionCompactionService {
  constructor(options = {}) {
    this.db = options.db;
    this.dispatcher = options.dispatcher;
    this.aiService = options.aiService;
    this.chatContextService = options.chatContextService;
    this.windowManager = options.windowManager || null;
    this.active = new Map();
  }

  async compactSession(sessionId, options = {}) {
    const sid = String(sessionId || '').trim();
    if (!sid) throw new Error('sessionId is required');
    if (this.active.has(sid)) return this.active.get(sid);
    const operation = this._compactSession(sid, options).finally(() => this.active.delete(sid));
    this.active.set(sid, operation);
    return operation;
  }

  async _compactSession(sessionId, options = {}) {
    const generationActive = typeof this.aiService?.isGenerating === 'function'
      ? this.aiService.isGenerating()
      : this.aiService?.isGenerating;
    if (generationActive) {
      throw new Error('Wait for the active generation to finish before compacting this session.');
    }
    const scope = normalizeScope(options);
    const selection = await getEffectiveLlmSelection(this.db, scope);
    const provider = String(selection?.provider || this.aiService?.getCurrentProvider?.() || 'ollama').trim().toLowerCase();
    const model = String(selection?.model || '').trim();
    const previousCheckpoint = await this.chatContextService.getContextCheckpoint(sessionId, scope);
    const history = await this.chatContextService.buildPromptHistory(sessionId, '', { dbQueryOptions: scope });
    if (history.length < 2) {
      return { success: false, sessionId, provider, mode: 'none', error: 'Not enough conversation context to compact.' };
    }
    const cutoffMessageCount = String(previousCheckpoint?.summary || '').trim()
      ? Math.max(0, Number(previousCheckpoint.cutoffMessageCount || 0)) + Math.max(0, history.length - 1)
      : history.length;

    this.windowManager?.send?.('session-compaction-status', { sessionId, status: 'compacting', provider });
    const runtimeProvider = this.aiService?.isRuntimeProvider?.(provider)
      ? this.aiService.getRuntimeProvider(provider)
      : null;
    const capabilities = runtimeProvider?.getConversationCapabilities?.() || null;
    let nativeFallbackRequired = false;

    if (capabilities?.manualCompaction === 'native' && runtimeProvider?.compactConversation) {
      try {
        const nativeResult = await runtimeProvider.compactConversation(sessionId, { ...scope, model });
        if (nativeResult?.success) {
          const checkpoint = await this.chatContextService.saveContextCheckpoint(sessionId, {
            mode: 'native',
            provider,
            summary: nativeResult.checkpointSummary || buildRecoveryCapsule(history),
            cutoffMessageCount,
            externalSessionId: nativeResult.externalSessionId || null
          }, scope);
          if (provider === 'opencode' && runtimeProvider.resetSession) {
            await runtimeProvider.resetSession(sessionId, scope);
          }
          await this.chatContextService.clearProviderContextUsage(sessionId, scope);
          const usage = normalizeUsage(nativeResult);
          if (usage) {
            await this.chatContextService.saveProviderContextUsage(sessionId, {
              usage,
              context_length: nativeResult.contextLength || null,
              renderContext: { provider, model, requestContext: scope.requestContext || null }
            }, scope);
          }
          const result = {
            success: true,
            sessionId,
            provider,
            mode: 'native',
            checkpoint,
            usage,
            contextLength: nativeResult.contextLength || null
          };
          this.windowManager?.send?.('session-compaction-status', { ...result, status: 'completed' });
          return result;
        }
        nativeFallbackRequired = true;
      } catch (error) {
        nativeFallbackRequired = true;
        console.warn(`[Compaction] Native ${provider} compaction unavailable; using local checkpoint: ${error.message}`);
      }
    }

    const response = await this.dispatcher.dispatch(LOCAL_COMPACTION_PROMPT, history, {
      provider,
      model,
      mode: 'internal',
      includeTools: false,
      includeRules: false,
      includeEnv: false,
      skipMemoryOnStart: true,
      requestContext: scope.requestContext || null
    });
    const summary = String(response?.content || '').trim();
    if (!summary) throw new Error('The model returned an empty compaction checkpoint.');
    if (nativeFallbackRequired && runtimeProvider?.resetSession) {
      await runtimeProvider.resetSession(sessionId, scope);
    }
    const checkpoint = await this.chatContextService.saveContextCheckpoint(sessionId, {
      mode: 'local',
      provider,
      summary,
      cutoffMessageCount
    }, scope);
    await this.chatContextService.clearProviderContextUsage(sessionId, scope);
    const usageEstimate = await this.chatContextService.getUsageEstimate(sessionId, '', { dbQueryOptions: scope });
    const result = {
      success: true,
      sessionId,
      provider,
      mode: 'local',
      checkpoint,
      usage: usageEstimate
    };
    this.windowManager?.send?.('session-compaction-status', { ...result, status: 'completed' });
    return result;
  }
}

module.exports = { SessionCompactionService, LOCAL_COMPACTION_PROMPT, buildRecoveryCapsule };
