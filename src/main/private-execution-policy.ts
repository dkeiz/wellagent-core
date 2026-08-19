// @ts-nocheck
const { isPrivateSessionId } = require('./private-session-store');

function getPrivateSessionId(server, activeContext = null) {
  const contextSessionId = activeContext?.sessionId;
  if (contextSessionId !== undefined && contextSessionId !== null) {
    return isPrivateSessionId(contextSessionId) ? String(contextSessionId) : null;
  }
  const currentSessionId = server?.getCurrentSessionId?.();
  return isPrivateSessionId(currentSessionId) ? String(currentSessionId) : null;
}

async function assessPrivateTool(server, toolName, tool, params = {}, activeContext = null) {
  const sessionId = getPrivateSessionId(server, activeContext);
  return {
    privateMode: Boolean(sessionId),
    sessionId,
    toolName,
    privateTraceSuppressed: Boolean(sessionId)
  };
}

module.exports = {
  assessPrivateTool,
  getPrivateSessionId
};
