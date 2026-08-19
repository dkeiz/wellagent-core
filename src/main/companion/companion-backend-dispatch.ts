// @ts-nocheck
const fs = require('fs');
const path = require('path');
const CompanionAuth = require('../companion-auth');
const CompanionPermissions = require('../companion-permissions');
const { createTtsHttpEntrypoint } = require('../tts-http-entrypoint');
const requestContextHelpers = require('../request-context');
const { getArtifactContentType } = require('./companion-http-utils');
const { createCompanionAudioMock } = require('./companion-audio-mock');
const { createCompanionBackendEntrypoints } = require('./companion-backend-entrypoints');
const { COMPANION_RELAY_CHANNELS } = require('./companion-relay-channels');
const { RateLimiter } = require('./companion-server-core');
const { getCompanionUiState } = require('./companion-ui-state');

const MOBILE_PLATFORMS = new Set(['mobile', 'android', 'ios', 'iphone', 'ipad']);
const FORBIDDEN_TRANSPORT_KEYS = new Set(['channel', 'args', 'ipc', 'ipcChannel', 'handler', 'handlerName', 'methodName']);
const FORBIDDEN_VOICE_ROUTING_KEYS = new Set([
  'backend',
  'backendUrl',
  'serverUrl',
  'pluginId',
  'provider',
  'voice',
  'audioUrl',
  'audioPath',
  'streamPath'
]);
const voiceQueueByDevice = new Map();

function traceVoiceGeneration(event, details = {}) {
  if (process.env.LOCALAGENT_TTS_TRACE !== '1') return;
  const payload = { event, ...details };
  try {
    console.log(`[VoiceGeneration] ${JSON.stringify(payload)}`);
  } catch (_) {
    console.log(`[VoiceGeneration] ${event}`);
  }
}

function json(status, body) {
  return { status, body };
}

function ok(result) {
  return json(200, { success: true, result });
}

function okOrFailure(result, status = 400) {
  if (result?.success === false) {
    return json(status, { success: false, error: result.error || 'Companion request failed', result });
  }
  return ok(result);
}

function parseArtifactPath(urlPath) {
  const rawParts = String(urlPath || '').replace('/companion/artifact/', '').split('/');
  const sessionId = decodeURIComponent(rawParts.shift() || '').trim();
  const fileName = decodeURIComponent(rawParts.join('/') || '').trim();
  return { sessionId, fileName };
}

function normalizeDevicePermissions(device) {
  return device?.permissions || {
    preset: 'standard',
    mediaUpload: true,
    settingsWrite: true,
    agentManagement: false,
    daemonControl: true
  };
}

function getClientSource(device) {
  const platform = String(device?.platform || 'companion').trim().toLowerCase();
  const clientSource = MOBILE_PLATFORMS.has(platform) ? 'mobile' : 'web';
  return {
    clientSource,
    sourceLabel: clientSource === 'mobile' ? 'Mobile Client' : 'Web Client',
    platform: clientSource,
    deviceId: String(device?.deviceId || '').trim() || null,
    deviceName: String(device?.deviceName || '').trim() || null
  };
}

function sanitizeLimit(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function getBodyText(body) {
  return String(body?.text ?? '');
}

function findForbiddenVoiceRoutingKey(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return '';
  return Object.keys(body).find(key => FORBIDDEN_VOICE_ROUTING_KEYS.has(key)) || '';
}

async function handleVoiceGeneration(ctx, body) {
  if (!ctx.permissions.isCompanionEndpointAllowed(ctx.devicePermissions, 'backend:voice:generate')) {
    return json(403, { success: false, error: 'Voice generation not permitted' });
  }
  const forbiddenRoutingKey = findForbiddenVoiceRoutingKey(body);
  if (forbiddenRoutingKey) {
    return protocolViolation(ctx, `voice request attempted routing field "${forbiddenRoutingKey}"`);
  }
  const deviceKey = String(ctx.deviceId || 'external-unknown');
  const rawText = getBodyText(body);
  traceVoiceGeneration('request.received', {
    deviceId: deviceKey,
    textLength: rawText.length
  });
  const previous = voiceQueueByDevice.get(deviceKey) || Promise.resolve();
  let releaseQueue = null;
  const gate = new Promise((resolve) => { releaseQueue = resolve; });
  const queuedPromise = previous.then(() => gate);
  voiceQueueByDevice.set(deviceKey, queuedPromise);
  await previous;
  try {
    const ttsHttpEntrypoint = ctx.container.get('ttsHttpEntrypoint');
    const audio = await ttsHttpEntrypoint.generateAudio({
      rawText,
      includeBase64: true,
      prepareText: false,
      sessionId: body?.sessionId || null,
      agentId: body?.agentId || null,
      source: 'backend-http',
      requestContext: ctx.requestContext || null
    });
    traceVoiceGeneration('request.audio', {
      deviceId: deviceKey,
      success: audio?.success === true,
      backend: audio?.backend || '',
      pluginId: audio?.pluginId || '',
      error: audio?.error || ''
    });
    if (!audio?.success && audio?.fallback === 'browser-tts') {
      return json(audio?.status || 200, {
        success: true,
        mode: 'companion-browser-tts',
        speakText: audio.speakText || rawText
      });
    }
    if (!audio?.success || !audio.audioBase64) {
      return json(audio?.status || 503, {
        success: false,
        error: audio?.error || 'Voice generation failed'
      });
    }
    return json(200, {
      success: true,
      mimeType: audio.mimeType || 'audio/wav',
      audioBase64: audio.audioBase64,
      durationMs: audio.durationMs || 0
    });
  } catch (error) {
    return json(500, { success: false, error: error.message });
  } finally {
    if (releaseQueue) releaseQueue();
    if (voiceQueueByDevice.get(deviceKey) === queuedPromise) {
      voiceQueueByDevice.delete(deviceKey);
    }
  }
}

async function protocolViolation(ctx, reason) {
  const message = `[Companion] Protocol violation: ${reason}`;
  console.error(message);
  try {
    if (ctx?.auth && ctx?.token && ctx?.server?.disconnectDevice) {
      const authResult = await ctx.auth.validateAccessToken(ctx.token);
      const deviceId = authResult?.payload?.deviceId;
      if (deviceId) ctx.server.disconnectDevice(deviceId, 'protocol-violation');
    } else if (ctx?.deviceId && ctx?.server?.disconnectDevice) {
      ctx.server.disconnectDevice(ctx.deviceId, 'protocol-violation');
    }
  } catch (_) {}
  return {
    status: 403,
    _closeConnection: true,
    body: { success: false, error: 'Companion protocol violation' }
  };
}

function findForbiddenTransportKey(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return '';
  return Object.keys(body).find(key => FORBIDDEN_TRANSPORT_KEYS.has(key)) || '';
}

function findForbiddenQueryKey(url) {
  if (!url?.searchParams) return '';
  for (const key of url.searchParams.keys()) {
    if (FORBIDDEN_TRANSPORT_KEYS.has(key)) return key;
  }
  return '';
}

function getUnauthenticatedRateLimitDescriptor(method, urlPath) {
  const key = `${String(method || '').toUpperCase()} ${urlPath}`;
  switch (key) {
    case 'POST /companion/pair':
      return { name: 'pair', message: 'Too many pairing attempts' };
    case 'POST /companion/auth':
      return { name: 'auth', message: 'Too many authentication attempts' };
    default:
      return null;
  }
}

function buildUnauthenticatedRateLimitKey(socketInfo, urlPath) {
  const remote = String(socketInfo?.remoteAddress || 'anonymous').trim() || 'anonymous';
  return `${remote}:${urlPath}`;
}


function requireBackendAction(ctx, channel) {
  if (!ctx.permissions.isChannelAllowed(ctx.devicePermissions, channel)) {
    return json(403, { success: false, error: 'Companion action is not allowed' });
  }
  return null;
}

function getCompanionRoutePolicy(method, urlPath, body = {}) {
  const key = `${String(method || '').toUpperCase()} ${urlPath}`;
  switch (key) {
    case 'POST /companion/llm/thinking':
      return { category: 'write', channel: 'llm:set-thinking-mode' };
    case 'GET /companion/agents':
      return { category: 'read', channel: 'get-agents' };
    case 'POST /companion/agents/active':
      return {
        category: 'admin',
        channel: body?.active === false ? 'deactivate-agent' : 'activate-agent'
      };
    case 'POST /companion/capabilities/main':
      return { category: 'admin', channel: 'capability:set-main' };
    case 'POST /companion/capabilities/group':
      return { category: 'admin', channel: 'capability:set-group' };
    case 'POST /companion/daemon': {
      const kind = body?.kind === 'workflow' ? 'workflow' : 'memory';
      const action = body?.running === true ? 'start' : 'stop';
      return { category: 'admin', channel: `daemon:${kind}-${action}` };
    }
    case 'GET /companion/task-queue':
      return { category: 'read', channel: 'task-queue:list' };
    case 'POST /companion/task-queue/action': {
      const action = ['approve', 'defer', 'cancel'].includes(body?.action) ? body.action : '';
      return action
        ? { category: 'action', channel: `task-queue:${action}` }
        : { category: 'action', channel: '' };
    }
    default:
      return null;
  }
}

function requireCompanionRoutePermission(ctx, method, urlPath, body = {}) {
  const policy = getCompanionRoutePolicy(method, urlPath, body);
  if (!policy?.channel) return null;
  return requireBackendAction(ctx, policy.channel);
}

function requireCompanionRuntimePolicy(ctx, method, urlPath, body = {}) {
  if (!ctx.runtimePolicy?.assert) return null;
  try {
    ctx.runtimePolicy.assert({
      principal: ctx.runtimePolicy.createCompanionPrincipal
        ? ctx.runtimePolicy.createCompanionPrincipal(ctx.device)
        : { type: 'companion', id: `companion:${ctx.deviceId || 'unknown'}`, profile: 'companion-standard' },
      action: 'companion.route',
      resource: `${String(method || '').toUpperCase()} ${urlPath}`,
      metadata: {
        method: String(method || '').toUpperCase(),
        urlPath,
        deviceId: ctx.deviceId || null,
        platform: ctx.device?.platform || '',
        bodyKeys: body && typeof body === 'object' ? Object.keys(body) : []
      }
    });
    return null;
  } catch (error) {
    return json(403, { success: false, error: error.message || 'Companion route denied by runtime policy' });
  }
}

async function getSettingsSnapshot(ctx) {
  const snapshot = await ctx.entrypoints.getSettingsSnapshot(ctx.requestContext);
  const llmConfig = {
    model: snapshot.model,
    runtimeConfig: snapshot.runtimeConfig,
    concurrencyEnabled: snapshot.concurrencyEnabled
  };
  const capState = snapshot.capabilities;
  const agents = snapshot.agents;
  const memStatus = snapshot.memoryStatus;
  const wfStatus = snapshot.workflowStatus;
  const ui = await getCompanionUiState(ctx.db, { requestContext: ctx.requestContext || null }).catch(() => ({}));

  const service = ctx.container.optional('sttService');
  let sttSnapshot = { tiers: [], activeProvider: 'embedded-whisper' };
  if (service) {
    try {
      sttSnapshot = service.getStatusSnapshot
        ? await service.getStatusSnapshot({ requestContext: ctx.requestContext || null })
        : {
            tiers: service.listProviders ? service.listProviders({ enabledOnly: false }) : [],
            activeProvider: 'embedded-whisper'
          };
    } catch (_) {}
  }

  return {
    success: true,
    snapshot: {
      llm: {
        model: llmConfig?.model || '',
        thinkingMode: llmConfig?.runtimeConfig?.reasoning?.enabled ? 'think' : 'off',
        showThinking: llmConfig?.runtimeConfig?.reasoning?.visibility !== 'hide',
        thinkingVisibility: llmConfig?.runtimeConfig?.reasoning?.visibility || 'show',
        contextWindow: llmConfig?.runtimeConfig?.contextWindow?.value || null,
        concurrencyEnabled: llmConfig?.concurrencyEnabled || false
      },
      capabilities: capState || { mainEnabled: false, groups: {}, activeToolCount: 0 },
      agents: Array.isArray(agents)
        ? agents.map(agent => ({ id: agent.id, name: agent.name, type: agent.type, active: Boolean(agent.active) }))
        : [],
      daemons: {
        memoryRunning: Boolean(memStatus?.running),
        workflowRunning: Boolean(wfStatus?.running)
      },
      companion: {
        permissions: ctx.devicePermissions,
        connectedDevices: ctx.server?._wsClients?.size || 0
      },
      stt: sttSnapshot,
      ui
    }
  };
}

async function handleStt(ctx, body, url) {
  if (!ctx.permissions.isCompanionEndpointAllowed(ctx.devicePermissions, 'companion:stt:transcribe')) {
    return json(403, { success: false, error: 'STT not permitted' });
  }
  const service = ctx.container.optional('sttService');
  if (!service?.transcribeAudio) return json(503, { success: false, error: 'STT backend is unavailable' });
  try {
    const result = await service.transcribeAudio({
      audioBase64: body?._binaryBase64 || body?.audioBase64 || '',
      mimeType: body?._binaryContentType || body?.mimeType || 'audio/webm',
      language: body?.language || url.searchParams.get('language') || '',
      prompt: body?.prompt || url.searchParams.get('prompt') || '',
      timeoutMs: 30000,
      requestContext: ctx.requestContext || null
    });
    return json(result?.success ? 200 : 400, result || { success: false, error: 'STT failed' });
  } catch (error) {
    return json(500, { success: false, error: error.message });
  }
}

async function resolveCompanionWriteSession(ctx, requestedSessionId = '') {
  const explicitSessionId = String(requestedSessionId || '').trim();
  if (explicitSessionId) {
    const switched = await ctx.entrypoints.switchChatSession(explicitSessionId, ctx.requestContext);
    if (switched?.success === false) {
      return { success: false, status: 400, error: switched.error || 'Failed to switch chat session' };
    }
    return { success: true, sessionId: String(switched?.sessionId || explicitSessionId).trim() };
  }

  const current = await ctx.entrypoints.getCurrentChatSession?.(ctx.requestContext);
  let sessionId = String(current?.id || '').trim();
  if (!sessionId) {
    const created = await ctx.entrypoints.createChatSession(ctx.requestContext);
    sessionId = String(created?.id || '').trim();
  }
  if (!sessionId) return { success: false, status: 400, error: 'Failed to resolve active chat session' };
  return { success: true, sessionId };
}

async function handleAndroidVoiceSend(ctx, body, url) {
  const denied = requireBackendAction(ctx, 'send-message');
  if (denied) return denied;
  if (!ctx.permissions.isCompanionEndpointAllowed(ctx.devicePermissions, 'companion:stt:transcribe')) {
    return json(403, { success: false, error: 'Voice input is not permitted' });
  }
  let sessionId = String(url.searchParams.get('sessionId') || body?.sessionId || '').trim();
  const service = ctx.container.optional('sttService');
  if (!service?.transcribeAudio) return json(503, { success: false, error: 'STT backend is unavailable' });

  try {
    const resolvedSession = await resolveCompanionWriteSession(ctx, sessionId);
    if (!resolvedSession.success) {
      return json(resolvedSession.status || 400, { success: false, error: resolvedSession.error || 'Failed to resolve active chat session' });
    }
    sessionId = resolvedSession.sessionId;

    const audioBase64 = body?._binaryBase64 || body?.audioBase64 || '';
    const contentType = body?._binaryContentType || body?.mimeType || 'audio/webm';

    // Save voice audio as workspace attachment
    const { ext } = mediaKindFromContentType(contentType);
    const fileName = `companion_audio_${Date.now()}${ext}`;
    const sessionWorkspace = ctx.container.optional('sessionWorkspace');
    const workspaceDir = sessionWorkspace?.getWorkspacePath?.(sessionId);
    let voiceAttachmentSaved = false;
    if (workspaceDir && audioBase64) {
      try {
        fs.writeFileSync(path.join(workspaceDir, path.basename(fileName)), Buffer.from(audioBase64, 'base64'));
        voiceAttachmentSaved = true;
      } catch (_) {}
    }

    // Transcribe audio via STT service (native Whisper default)
    const stt = await service.transcribeAudio({
      audioBase64,
      mimeType: contentType,
      language: body?.language || url.searchParams.get('language') || '',
      prompt: body?.prompt || url.searchParams.get('prompt') || '',
      timeoutMs: 30000,
      requestContext: ctx.requestContext || null
    });
    if (!stt?.success) {
      return json(400, { success: false, error: stt?.error || 'Transcription failed', stt });
    }
    const transcript = String(stt.transcript || stt.text || stt.result?.text || '').trim();
    if (!transcript) return json(400, { success: false, error: 'Transcription returned empty text' });

    // Keep the attachment marker for playback, but make the prompt text explicit.
    const transcriptMessage = `Voice input from Android app (transcribed text):\n${transcript}`;
    const messageText = voiceAttachmentSaved
      ? `[Voice message: ${fileName}]\n${transcriptMessage}`
      : transcriptMessage;
    const result = await ctx.entrypoints.sendMessage(messageText, sessionId, getClientSource(ctx.device), ctx.requestContext);
    if (result?.success === false) {
      return json(400, { success: false, error: result.error || 'Failed to send transcript', transcript, sessionId, result });
    }
    return json(200, {
      success: true,
      transcript,
      text: transcript,
      backend: stt.backend || '',
      providerId: stt.providerId || '',
      sessionId: result?.sessionId || sessionId,
      fileName: voiceAttachmentSaved ? fileName : null,
      result
    });
  } catch (error) {
    return json(500, { success: false, error: error.message || 'Voice send failed' });
  }
}

function mediaKindFromContentType(contentType) {
  if (contentType.includes('image/jpeg') || contentType.includes('image/jpg')) return { ext: '.jpg', kind: 'image' };
  if (contentType.includes('image/png')) return { ext: '.png', kind: 'image' };
  if (contentType.includes('image/webp')) return { ext: '.webp', kind: 'image' };
  if (contentType.includes('image/gif')) return { ext: '.gif', kind: 'image' };
  if (contentType.includes('audio/wav') || contentType.includes('audio/wave')) return { ext: '.wav', kind: 'audio' };
  if (contentType.includes('audio/ogg')) return { ext: '.ogg', kind: 'audio' };
  if (contentType.includes('audio/mp3') || contentType.includes('audio/mpeg')) return { ext: '.mp3', kind: 'audio' };
  if (contentType.includes('audio/m4a') || contentType.includes('audio/mp4')) return { ext: '.m4a', kind: 'audio' };
  return { ext: '.bin', kind: 'binary' };
}

async function handleMediaUpload(ctx, body, headers, url) {
  if (ctx.devicePermissions.mediaUpload === false) {
    return json(403, { success: false, error: 'Media upload not permitted' });
  }
  const raw = Buffer.from(String(body?._binaryBase64 || ''), 'base64');
  if (!raw.length) return json(400, { success: false, error: 'No media bytes received' });

  const contentType = String(body?._binaryContentType || headers?.['content-type'] || '').toLowerCase();
  const { ext, kind } = mediaKindFromContentType(contentType);
  const sessionId = String(url.searchParams.get('sessionId') || '').trim();
  const fileName = `companion_${kind}_${Date.now()}${ext}`;

  if (sessionId) {
    const sessionWorkspace = ctx.container.optional('sessionWorkspace');
    const workspaceDir = sessionWorkspace?.getWorkspacePath?.(sessionId);
    if (!workspaceDir) return json(500, { success: false, error: 'Session workspace unavailable for media upload' });
    fs.writeFileSync(path.join(workspaceDir, path.basename(fileName)), raw);

    if (url.searchParams.get('sendAsMessage') !== 'false') {
      const caption = String(url.searchParams.get('caption') || '').trim();
      const label = kind === 'image' ? 'Image attached' : (kind === 'audio' ? 'Voice message' : 'File attached');
      const messageText = caption ? `[${label}: ${fileName}]\n${caption}` : `[${label}: ${fileName}]`;
      await ctx.entrypoints.sendMessage(messageText, sessionId, getClientSource(ctx.device), ctx.requestContext);
    }
  }

  return json(200, { success: true, fileName, kind, size: raw.length, sessionId: sessionId || null });
}

async function handleRawArtifact(ctx, urlPath) {
  const { sessionId, fileName } = parseArtifactPath(urlPath);
  const result = await ctx.entrypoints.readSessionArtifact(sessionId, fileName, ctx.requestContext);
  if (!result?.path || !fs.existsSync(result.path)) {
    return json(404, { success: false, error: result?.error || 'Artifact not found' });
  }
  const buffer = fs.readFileSync(result.path);
  return {
    status: 200,
    _rawFile: buffer,
    headers: {
      'Content-Type': getArtifactContentType(result.name, result.kind),
      'Content-Length': buffer.length,
      'Cache-Control': 'no-store'
    }
  };
}

async function handleAuthenticated(ctx, method, urlPath, body, headers, url) {
  const runtimeDenied = requireCompanionRuntimePolicy(ctx, method, urlPath, body);
  if (runtimeDenied) return runtimeDenied;

  if (method === 'GET' && urlPath === '/companion/settings/full') {
    return json(200, await getSettingsSnapshot(ctx));
  }
  if (method === 'GET' && urlPath === '/companion/stt/status') {
    const service = ctx.container.optional('sttService');
    if (!service) return json(503, { success: false, error: 'STT service not available' });
    try {
      const snapshot = service.getStatusSnapshot
        ? await service.getStatusSnapshot({ requestContext: ctx.requestContext || null })
        : {
            tiers: service.listProviders ? service.listProviders({ enabledOnly: false }) : [],
            activeProvider: 'embedded-whisper'
          };
      return json(200, { success: true, ...snapshot });
    } catch (error) {
      return json(500, { success: false, error: error.message || 'Failed to get STT status' });
    }
  }
  if (method === 'POST' && urlPath === '/companion/stt/transcribe') return handleStt(ctx, body, url);
  if (method === 'POST' && urlPath === '/android/voice/send') return handleAndroidVoiceSend(ctx, body, url);
  if (method === 'GET' && urlPath === '/companion/ws-ticket') {
    return json(200, { success: true, wsTicket: ctx.auth.issueWsTicket(ctx.deviceId), expiresIn: 60 });
  }
  if (method === 'GET' && urlPath === '/companion/devices') {
    const devices = await ctx.auth.listDevices({ userId: ctx.requestContext?.userId || null });
    return json(200, {
      success: true,
      devices: devices.map(device => ({ ...device, connected: ctx.server?._wsClients?.has(device.deviceId) || false }))
    });
  }
  if (method === 'DELETE' && urlPath.startsWith('/companion/device/')) {
    const targetDeviceId = urlPath.replace('/companion/device/', '').trim();
    if (targetDeviceId !== ctx.deviceId) return json(403, { success: false, error: 'Cannot remove other devices' });
    ctx.server?.disconnectDevice?.(targetDeviceId, 'device-removed');
    return json(200, await ctx.auth.removeDevice(targetDeviceId, { userId: ctx.requestContext?.userId || null }));
  }
  if (method === 'POST' && urlPath === '/companion/media/upload') {
    return handleMediaUpload(ctx, body, headers, url);
  }
  if (method === 'POST' && urlPath === '/backend/voice/generate') return handleVoiceGeneration(ctx, body);
  if (method === 'GET' && urlPath === '/companion/artifact/ticket') {
    const denied = requireBackendAction(ctx, 'read-session-artifact');
    if (denied) return denied;
    const sessionId = String(url.searchParams.get('sessionId') || '').trim();
    const fileName = String(url.searchParams.get('fileName') || '').trim();
    if (!sessionId || !fileName) return json(400, { success: false, error: 'sessionId and fileName are required' });
    const probe = await ctx.entrypoints.readSessionArtifact(sessionId, fileName, ctx.requestContext);
    if (!probe?.success && !probe?.path) {
      return json(404, { success: false, error: probe?.error || 'Artifact not found' });
    }
    return json(200, { success: true, ...ctx.auth.issueArtifactTicket(ctx.deviceId, sessionId, fileName) });
  }
  if (method === 'GET' && urlPath.startsWith('/companion/artifact/')) return handleRawArtifact(ctx, urlPath);

  if (method === 'GET' && urlPath === '/companion/chat/generating') {
    return json(200, { success: true, generating: Boolean(ctx.container.optional('aiService')?.isGenerating) });
  }

  if (method === 'GET' && urlPath === '/companion/chat/sessions') {
    const denied = requireBackendAction(ctx, 'get-chat-sessions');
    if (denied) return denied;
    const result = await ctx.entrypoints.listChatSessions(sanitizeLimit(url.searchParams.get('limit'), 20, 100), ctx.requestContext);
    let current = null;
    try {
      current = ctx.entrypoints.getCurrentChatSession ? await ctx.entrypoints.getCurrentChatSession(ctx.requestContext) : null;
    } catch (_) {}
    return json(200, {
      success: true,
      result,
      currentSessionId: String(current?.id || '').trim(),
      currentSession: current || null
    });
  }
  if (method === 'POST' && urlPath === '/companion/chat/session') {
    const denied = requireBackendAction(ctx, 'create-chat-session');
    if (denied) return denied;
    return ok(await ctx.entrypoints.createChatSession(ctx.requestContext));
  }
  if (method === 'POST' && urlPath === '/companion/chat/switch') {
    const denied = requireBackendAction(ctx, 'switch-chat-session');
    if (denied) return denied;
    return okOrFailure(await ctx.entrypoints.switchChatSession(String(body?.sessionId || '').trim(), ctx.requestContext));
  }
  if (method === 'GET' && urlPath === '/companion/chat/messages') {
    const denied = requireBackendAction(ctx, 'get-conversations');
    if (denied) return denied;
    return ok(await ctx.entrypoints.getConversations(
      sanitizeLimit(url.searchParams.get('limit'), 80, 500),
      String(url.searchParams.get('sessionId') || '').trim(),
      ctx.requestContext
    ));
  }
  if (method === 'POST' && urlPath === '/companion/chat/send') {
    const denied = requireBackendAction(ctx, 'send-message');
    if (denied) return denied;
    return okOrFailure(await ctx.entrypoints.sendMessage(
      getBodyText(body),
      String(body?.sessionId || '').trim() || null,
      getClientSource(ctx.device),
      ctx.requestContext
    ));
  }
  if (method === 'POST' && urlPath === '/companion/chat/stop') {
    const denied = requireBackendAction(ctx, 'stop-generation');
    if (denied) return denied;
    return ok(ctx.entrypoints.stopGeneration());
  }
  if (method === 'POST' && urlPath === '/companion/chat/clear') {
    const denied = requireBackendAction(ctx, 'clear-chat-session');
    if (denied) return denied;
    return ok(await ctx.entrypoints.clearChatSession(String(body?.sessionId || '').trim(), ctx.requestContext));
  }
  if (method === 'GET' && urlPath === '/companion/artifacts') {
    const denied = requireBackendAction(ctx, 'get-session-artifacts');
    if (denied) return denied;
    return okOrFailure(await ctx.entrypoints.getSessionArtifacts(
      String(url.searchParams.get('sessionId') || '').trim() || null,
      ctx.requestContext
    ));
  }
  if (method === 'GET' && urlPath === '/companion/artifact/read') {
    const denied = requireBackendAction(ctx, 'read-session-artifact');
    if (denied) return denied;
    return okOrFailure(await ctx.entrypoints.readSessionArtifact(
      String(url.searchParams.get('sessionId') || '').trim(),
      String(url.searchParams.get('fileName') || '').trim(),
      ctx.requestContext
    ));
  }
  if (method === 'POST' && urlPath === '/companion/llm/thinking') {
    const denied = requireCompanionRoutePermission(ctx, method, urlPath, body);
    if (denied) return denied;
    return ok(await ctx.entrypoints.setThinkingMode(body?.mode === 'off' ? 'off' : 'think'));
  }
  if (method === 'GET' && urlPath === '/companion/agents') {
    const denied = requireCompanionRoutePermission(ctx, method, urlPath, body);
    if (denied) return denied;
    return ok(await ctx.entrypoints.listAgents(ctx.requestContext));
  }
  if (method === 'POST' && urlPath === '/companion/agents/active') {
    const denied = requireCompanionRoutePermission(ctx, method, urlPath, body);
    if (denied) return denied;
    return ok(await ctx.entrypoints.setAgentActive(body?.agentId, body?.active !== false, ctx.requestContext));
  }
  if (method === 'POST' && urlPath === '/companion/capabilities/main') {
    const denied = requireCompanionRoutePermission(ctx, method, urlPath, body);
    if (denied) return denied;
    return ok(await ctx.entrypoints.setCapabilityMain(body?.enabled === true));
  }
  if (method === 'POST' && urlPath === '/companion/capabilities/group') {
    const denied = requireCompanionRoutePermission(ctx, method, urlPath, body);
    if (denied) return denied;
    return ok(await ctx.entrypoints.setCapabilityGroup(String(body?.groupId || '').trim(), body?.enabled === true));
  }
  if (method === 'POST' && urlPath === '/companion/daemon') {
    const denied = requireCompanionRoutePermission(ctx, method, urlPath, body);
    if (denied) return denied;
    return ok(await ctx.entrypoints.setDaemonRunning(body?.kind === 'workflow' ? 'workflow' : 'memory', body?.running === true));
  }
  if (method === 'GET' && urlPath === '/companion/task-queue') {
    const denied = requireCompanionRoutePermission(ctx, method, urlPath, body);
    if (denied) return denied;
    return ok(await ctx.entrypoints.listTaskQueue(url.searchParams.get('actionable') !== 'false'));
  }
  if (method === 'POST' && urlPath === '/companion/task-queue/action') {
    const denied = requireCompanionRoutePermission(ctx, method, urlPath, body);
    if (denied) return denied;
    const action = ['approve', 'defer', 'cancel'].includes(body?.action) ? body.action : '';
    if (!action) return json(400, { success: false, error: 'Unsupported task action' });
    return ok(await ctx.entrypoints.updateTask(action, body?.taskId));
  }

  return json(404, { success: false, error: 'Not found' });
}

function configureCompanionServer({ companionServer, container, db, companionAuth } = {}) {
  if (!companionServer) throw new Error('companionServer is required');
  const resolvedDb = db || container?.get?.('db');
  companionServer.setUiStateDb?.(resolvedDb);
  const auth = companionAuth || container?.optional?.('companionAuth') || new CompanionAuth(resolvedDb, {
    userRegistry: container?.optional?.('userRegistry') || null
  });
  container?.replace?.('companionAuth', auth);

  const entrypoints = createCompanionBackendEntrypoints(container);
  const permissions = new CompanionPermissions();
  const requestContextService = container?.optional?.('requestContextService') || requestContextHelpers;
  const rateLimiter = new RateLimiter();
  const unauthenticatedRateLimiters = {
    pair: new RateLimiter(15 * 60 * 1000, 20),
    auth: new RateLimiter(15 * 60 * 1000, 40)
  };
  if (process.env.LOCALAGENT_COMPANION_AUDIO_MOCK === '1') {
    const mockAudio = createCompanionAudioMock();
    container?.replace?.('ttsHttpEntrypoint', mockAudio.ttsHttpEntrypoint);
  }
  if (!container?.optional?.('ttsHttpEntrypoint')) {
    container?.replace?.('ttsHttpEntrypoint', createTtsHttpEntrypoint({
      getTtsService: () => container?.optional?.('ttsService')
    }));
  }

  companionServer.setDispatch(async (method, urlPath, body, headers, token, socketInfo, url) => {
    if (urlPath === '/companion/ipc') {
      return protocolViolation({ auth, server: companionServer, token }, 'generic IPC endpoint requested');
    }
    const forbiddenQueryKey = findForbiddenQueryKey(url);
    if (forbiddenQueryKey) {
      return protocolViolation({ auth, server: companionServer, token }, `request attempted inner backend query "${forbiddenQueryKey}"`);
    }
    const forbiddenBodyKey = findForbiddenTransportKey(body);
    if (forbiddenBodyKey) {
      return protocolViolation({ auth, server: companionServer, token }, `request attempted inner backend field "${forbiddenBodyKey}"`);
    }

    const unauthenticatedLimit = getUnauthenticatedRateLimitDescriptor(method, urlPath);
    if (unauthenticatedLimit) {
      const limiter = unauthenticatedRateLimiters[unauthenticatedLimit.name];
      const key = buildUnauthenticatedRateLimitKey(socketInfo, urlPath);
      if (limiter && !limiter.check(key)) {
        return json(429, { success: false, error: unauthenticatedLimit.message });
      }
    }

    if (method === 'POST' && urlPath === '/companion/pair') return json(200, await auth.validatePairing(body || {}));
    if (method === 'POST' && urlPath === '/companion/auth') return json(200, await auth.authenticate(body || {}));
    if (method === 'GET' && urlPath === '/companion/ws') {
      const result = auth.validateWsTicket(url.searchParams.get('ticket'));
      return result?.valid
        ? { _wsAccepted: true, _deviceId: result.deviceId }
        : json(401, { success: false, error: 'Invalid WS ticket' });
    }

    let authResult = await auth.validateAccessToken(token);
    if (!authResult?.valid && method === 'GET' && urlPath.startsWith('/companion/artifact/')) {
      const artifactPath = parseArtifactPath(urlPath);
      authResult = await auth.validateArtifactTicket(
        url.searchParams.get('ticket'),
        artifactPath.sessionId,
        artifactPath.fileName
      );
    }
    if (!authResult?.valid) {
      return json(401, { success: false, error: authResult?.error || 'Unauthorized' });
    }

    const device = authResult.payload || {};
    const deviceId = device.deviceId;
    if (!rateLimiter.check(deviceId)) return json(429, { success: false, error: 'Rate limit exceeded' });
    const requestContext = requestContextService?.createCompanionRequestContext
      ? requestContextService.createCompanionRequestContext(device)
      : { source: 'companion', deviceId };

    return handleAuthenticated({
      auth,
      container,
      entrypoints,
      db: resolvedDb,
      device,
      deviceId,
      devicePermissions: normalizeDevicePermissions(device),
      permissions,
      requestContext,
      runtimePolicy: container?.optional?.('runtimePolicy') || null,
      server: companionServer,
      socketInfo,
      token
    }, method, urlPath, body || {}, headers || {}, url);
  });
}

function attachCompanionRelays({ companionServer, eventBus, windowManager, getCompanionServer } = {}) {
  const currentServer = () => getCompanionServer?.() || companionServer;
  if (eventBus?.on && !eventBus.__companionRelaysAttached) {
    for (const channel of COMPANION_RELAY_CHANNELS) {
      eventBus.on(channel, (payload) => currentServer()?._wsBroadcast?.({ type: channel, payload: payload || {} }));
    }
    eventBus.__companionRelaysAttached = true;
  }
  if (windowManager?.send && !windowManager.__companionRelayWrapped) {
    const originalSend = windowManager.send.bind(windowManager);
    windowManager.send = (channel, payload) => {
      const result = originalSend(channel, payload);
      if (COMPANION_RELAY_CHANNELS.has(channel)) {
        currentServer()?._wsBroadcast?.({ type: channel, payload: payload || {} });
      }
      return result;
    };
    windowManager.__companionRelayWrapped = true;
  }
  if (companionServer) companionServer.__relaysAttached = true;
}

module.exports = {
  attachCompanionRelays,
  configureCompanionServer,
  getCompanionRoutePolicy
};



