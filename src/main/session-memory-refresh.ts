// @ts-nocheck
class SessionMemoryRefresh {
  constructor(chatContextService) {
    this.chatContextService = chatContextService;
    this.seenEpochs = new Map();
  }

  async prepare(sessionId, options = {}) {
    const sid = String(sessionId || '').trim();
    const userId = String(options.userId || options.requestContext?.userId || 'localuser').trim();
    const key = `${userId}:${sid || 'default'}`;
    const checkpoint = sid && this.chatContextService?.getContextCheckpoint
      ? await this.chatContextService.getContextCheckpoint(sid, options.dbQueryOptions || options)
      : null;
    const epoch = checkpoint
      ? `${checkpoint.createdAt || ''}:${checkpoint.cutoffMessageCount || 0}:${checkpoint.mode || ''}`
      : 'initial';
    return { key, epoch, required: this.seenEpochs.get(key) !== epoch };
  }

  mark(token) {
    if (token?.key) this.seenEpochs.set(token.key, token.epoch);
  }
}

module.exports = { SessionMemoryRefresh };
