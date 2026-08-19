// @ts-nocheck
const { nativeHttpRequest } = require('../net/native-http-client');
const { consumeCodexResponsesStream } = require('./codex-responses-stream');

async function requestCodexResponse(options = {}) {
  const request = options.requestImpl || nativeHttpRequest;
  const endpoint = `${String(options.baseUrl || '').replace(/\/+$/, '')}/responses`;
  const controller = new AbortController();
  const relayAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', relayAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), Math.max(1, Number(options.timeoutMs) || 45000));
  try {
    const response = await request({
      method: 'post',
      url: endpoint,
      headers: {
        Authorization: `Bearer ${options.accessToken}`,
        'ChatGPT-Account-Id': options.accountId,
        originator: 'localagent',
        session_id: options.sessionId,
        'User-Agent': 'LocalAgent/0.2.0',
        Accept: 'text/event-stream',
        'Content-Type': 'application/json'
      },
      data: options.body,
      responseType: 'stream',
      signal: controller.signal,
      timeout: options.timeoutMs
    });
    return await consumeCodexResponsesStream(response.data, options.turnEvents || null);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener?.('abort', relayAbort);
  }
}

module.exports = { requestCodexResponse };
