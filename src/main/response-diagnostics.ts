// @ts-nocheck
const { getGenericSettingValue, saveGenericSetting } = require('./settings-security');

function compactResponseDiagnostics(response = {}, requestId = null) {
  const traceTypes = Array.isArray(response.runtimeTrace)
    ? response.runtimeTrace.map(item => String(item?.type || '')).filter(Boolean).slice(-32)
    : [];
  const diagnostics = {
    requestId: requestId || null,
    provider: response.renderContext?.provider || null,
    model: response.model || response.renderContext?.model || null,
    responseId: response.responseId || null,
    terminalState: response.terminalState || null,
    eventTypes: traceTypes,
    chainSteps: Number(response.chain?.steps || 0),
    toolCount: Array.isArray(response.chain?.tools) ? response.chain.tools.length : 0
  };
  return Object.fromEntries(Object.entries(diagnostics).filter(([, value]) => (
    value !== null && value !== '' && (!Array.isArray(value) || value.length > 0)
  )));
}

async function persistResponseError(db, sessionId, error, requestId, options = {}) {
  const sid = String(sessionId || '').trim();
  if (!sid || !db) return null;
  const key = `session.responseDiagnostics.${sid}`;
  const raw = await getGenericSettingValue(db, key, options);
  let previous = [];
  try { previous = JSON.parse(String(raw || '[]')); } catch (_) { previous = []; }
  const entry = Object.fromEntries(Object.entries({
    timestamp: new Date().toISOString(),
    requestId: requestId || null,
    code: error?.code || 'AI_RESPONSE_ERROR',
    message: String(error?.message || error || 'Unknown response error').slice(0, 1000),
    responseId: error?.responseId || null,
    details: error?.details || error?.diagnostics || null,
    eventTypes: Array.isArray(error?.partTypes) ? error.partTypes.slice(-32) : []
  }).filter(([, value]) => value !== null && (!Array.isArray(value) || value.length > 0)));
  const entries = [...(Array.isArray(previous) ? previous : []), entry].slice(-25);
  await saveGenericSetting(db, key, JSON.stringify(entries), options);
  return entry;
}

module.exports = { compactResponseDiagnostics, persistResponseError };
