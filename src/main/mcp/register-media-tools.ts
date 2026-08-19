// @ts-nocheck
const path = require('path');
const { pathToFileURL } = require('url');
const { resolvePathTokens, tokenizePath } = require('../path-tokens');
const { ScreenshotCaptureService } = require('../screenshot-capture-service');

const IMAGE_MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp'
};

function getPathTokenOptions(server) {
  const baseContext = server.getCurrentAgentContext?.()
    || server.getCurrentExecutionContext?.()
    || {};
  const sessionId = baseContext.sessionId ?? server.getCurrentSessionId?.() ?? null;
  const context = sessionId ? { ...baseContext, sessionId } : baseContext;
  return {
    agentManager: server._agentManager || null,
    sessionWorkspace: server._sessionWorkspace || null,
    executionDirectory: server._executionDirectory || null,
    sessionId,
    context
  };
}

async function resolveToolPath(server, rawPath) {
  const resolvedPath = await resolvePathTokens(rawPath, getPathTokenOptions(server));
  if (/\{[a-z_]+\}/i.test(resolvedPath)) {
    throw new Error(`Unresolved path token in path: ${rawPath}`);
  }
  return resolvedPath;
}

async function toPortablePath(server, absolutePath) {
  return tokenizePath(absolutePath, getPathTokenOptions(server));
}

async function getAllowedWorkspaceRoot(server) {
  if (!server._sessionWorkspace?.getWorkspacePath) {
    return null;
  }
  const sessionId = server.getCurrentSessionId?.() || 'default';
  return server._sessionWorkspace.getWorkspacePath(sessionId);
}

function getAllowedAgentinRoot(server) {
  if (server._agentManager?.basePath) {
    return path.dirname(server._agentManager.basePath);
  }
  if (server._sessionWorkspace?.basePath) {
    return path.dirname(server._sessionWorkspace.basePath);
  }
  return null;
}

async function assertMediaPathAllowed(server, filePath) {
  await server.assertExecutionPathAllowed?.(filePath, {
    extraRoots: [
      await getAllowedWorkspaceRoot(server),
      getAllowedAgentinRoot(server)
    ].filter(Boolean)
  });
}

async function readImageMetadata(server, filePath, requestedPath) {
  const fs = require('fs').promises;
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error(`Image path is not a file: ${requestedPath}`);

  const extension = path.extname(filePath).toLowerCase();
  const mimeType = IMAGE_MIME_TYPES[extension];
  if (!mimeType) throw new Error(`Unsupported image format: ${extension || 'unknown'}`);

  let width = null;
  let height = null;
  try {
    const { nativeImage } = require('electron');
    const image = nativeImage?.createFromPath?.(filePath);
    if (image && !image.isEmpty()) {
      const size = image.getSize();
      width = size.width;
      height = size.height;
    }
  } catch (_) {
    // Metadata remains useful outside Electron where nativeImage is unavailable.
  }

  return {
    path: await toPortablePath(server, filePath),
    mimeType,
    format: extension.slice(1),
    width,
    height,
    size: stat.size,
    modified: stat.mtime
  };
}

function registerMediaTools(server) {
  server.registerTool('image', {
    name: 'image',
    description: 'Work with a local image. Actions: metadata reads image properties; display shows it in LocalAgent Content Viewer; inspect sends its pixels to the active vision model; open_external opens it with the operating system.',
    userDescription: 'Inspect image metadata, display an image in LocalAgent, send it to a vision model, or open it externally',
    example: 'TOOL:image{"action":"inspect","path":"{workspace}/photo.png"}',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['metadata', 'display', 'inspect', 'open_external'],
          description: 'metadata | display in LocalAgent | inspect with the active vision model | open_external with the OS'
        },
        path: { type: 'string', description: 'Full path or path token to the image file' }
      },
      required: ['action', 'path']
    }
  }, async (params) => {
    const filePath = await resolveToolPath(server, params.path);
    await assertMediaPathAllowed(server, filePath);
    const metadata = await readImageMetadata(server, filePath, params.path);

    if (params.action === 'metadata') return { success: true, action: params.action, metadata };

    if (params.action === 'display') {
      return {
        success: true,
        action: params.action,
        metadata,
        viewerContent: {
          type: 'image',
          title: path.basename(filePath),
          url: pathToFileURL(filePath).href,
          filePath,
          imageDisplayMode: 'fit',
          mediaKind: 'image'
        }
      };
    }

    if (params.action === 'inspect') {
      return {
        success: true,
        action: params.action,
        metadata,
        inspection: { attached: true },
        llmAttachments: [{ type: 'image', path: filePath, mimeType: metadata.mimeType }]
      };
    }

    const { shell } = require('electron');
    const result = await shell.openPath(filePath);
    return result
      ? { success: false, action: params.action, error: result, metadata }
      : { success: true, action: params.action, opened: metadata.path, metadata };
  });

  server.registerTool('open_media', {
    name: 'open_media',
    description: 'Open a non-image media or document file with the default OS application. Use the image tool for image files.',
    userDescription: 'Opens video, audio, or document files using the default system application; images use the shared image tool',
    example: 'TOOL:open_media{"path":"C:/Users/Music/song.mp3"}',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Full path to the media file to open' }
      },
      required: ['path']
    }
  }, async (params) => {
    const { shell } = require('electron');
    const fs = require('fs');
    const filePath = await resolveToolPath(server, params.path);
    await assertMediaPathAllowed(server, filePath);

    if (!fs.existsSync(filePath)) {
      return { success: false, error: `File not found: ${params.path}` };
    }

    const ext = path.extname(filePath).toLowerCase();
    if (IMAGE_MIME_TYPES[ext]) {
      throw new Error('Use image with action open_external for image files');
    }

    const result = await shell.openPath(filePath);
    if (result) {
      return { success: false, error: result };
    }

    const mediaType = {
      '.mp3': 'audio', '.wav': 'audio', '.ogg': 'audio', '.flac': 'audio', '.m4a': 'audio',
      '.mp4': 'video', '.avi': 'video', '.mkv': 'video', '.mov': 'video', '.webm': 'video',
      '.pdf': 'document', '.doc': 'document', '.docx': 'document', '.txt': 'document'
    }[ext] || 'file';

    return { success: true, opened: await toPortablePath(server, filePath), type: mediaType };
  });

  server.registerTool('play_audio', {
    name: 'play_audio',
    description: 'Play an audio file with the default music player',
    userDescription: 'Opens and plays an audio file (MP3, WAV, etc.) using the system music player',
    example: 'TOOL:play_audio{"path":"C:/Users/Music/song.mp3"}',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Full path to the audio file' }
      },
      required: ['path']
    }
  }, async (params) => {
    const { shell } = require('electron');
    const fs = require('fs');
    const filePath = await resolveToolPath(server, params.path);
    await assertMediaPathAllowed(server, filePath);

    if (!fs.existsSync(filePath)) {
      return { success: false, error: `Audio file not found: ${params.path}` };
    }

    const result = await shell.openPath(filePath);
    return result
      ? { success: false, error: result }
      : { success: true, playing: await toPortablePath(server, filePath) };
  });

  server.registerTool('screenshot', {
    name: 'screenshot',
    description: 'List screenshot sources or capture LocalAgent, a monitor, or an application window',
    userDescription: 'Safely captures LocalAgent itself, or captures external screens and applications with Visual permission',
    example: 'TOOL:screenshot{"action":"capture","target":"self"}',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['capture', 'list_sources'], default: 'capture' },
        target: { type: 'string', enum: ['self', 'screen', 'application'], default: 'self' },
        sourceId: { type: 'string', description: 'Source ID returned by list_sources' },
        displayId: { type: 'string', description: 'Display ID for a screen capture' },
        savePath: { type: 'string', description: 'Optional PNG path; defaults to the session workspace' },
        maxWidth: { type: 'integer', minimum: 1, maximum: 16384 },
        maxHeight: { type: 'integer', minimum: 1, maximum: 16384 }
      }
    }
  }, async (params, execution = {}) => {
    const action = String(params.action || 'capture').toLowerCase();
    const target = String(params.target || 'self').toLowerCase();
    const external = target === 'screen' || target === 'application';
    if (!['capture', 'list_sources'].includes(action)) throw new Error('action must be capture or list_sources');
    if (!['self', 'screen', 'application'].includes(target)) throw new Error('target must be self, screen, or application');
    if (action === 'capture' && target === 'application' && !params.sourceId) {
      throw new Error('sourceId is required when capturing an application');
    }

    if (external && execution.allowExternalCapture !== true) {
      const context = execution.context || server.getCurrentAgentContext?.() || {};
      let visualAllowed = server._capabilityManager?.isGroupEnabled?.('visual') === true;
      if (server.toolPermissionService?.resolveContext) {
        const permissions = await server.toolPermissionService.resolveContext(context);
        visualAllowed = permissions?.groups?.visual === true;
      }
      if (!visualAllowed) {
        return {
          needsPermission: true,
          permissionType: 'screenshot_external',
          reason: 'visual_capture_disabled',
          toolName: 'screenshot',
          params: { ...params, action, target },
          action,
          target,
          sourceId: params.sourceId || null,
          displayId: params.displayId || null,
          savePath: params.savePath || null
        };
      }
    }

    const captureService = server._screenshotCaptureService || new ScreenshotCaptureService({
      windowManager: server._windowManager || null
    });
    if (action === 'list_sources') {
      const sources = await captureService.listSources(target);
      return { success: true, action, target, sources, count: sources.length };
    }

    const sessionId = execution.context?.sessionId || server.getCurrentSessionId?.() || 'default';
    const generatedName = `screenshot-${target}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    const rawSavePath = params.savePath || (server._sessionWorkspace?.getWorkspacePath
      ? path.join(server._sessionWorkspace.getWorkspacePath(sessionId), generatedName)
      : path.join(await server.getExecutionRoot(), generatedName));
    const savePath = await resolveToolPath(server, rawSavePath);
    await assertMediaPathAllowed(server, savePath);
    const captured = await captureService.capture({
      target,
      sourceId: params.sourceId,
      displayId: params.displayId,
      maxWidth: params.maxWidth,
      maxHeight: params.maxHeight
    });
    const written = await captureService.writePng(captured.image, savePath);
    let artifact = null;
    if (server._artifactRegistry) {
      artifact = server._artifactRegistry.registerFile(sessionId, {
        name: path.basename(savePath),
        path: savePath,
        kind: 'image',
        source: 'screenshot',
        category: 'media'
      });
    }
    return {
      success: true,
      action,
      target,
      source: captured.source,
      width: captured.width,
      height: captured.height,
      size: written.size,
      savedTo: await toPortablePath(server, savePath),
      artifact
    };
  });
}

module.exports = { registerMediaTools };
