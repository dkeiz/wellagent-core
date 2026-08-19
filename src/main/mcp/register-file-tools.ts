// @ts-nocheck
const fs = require('fs').promises;
const path = require('path');
const zlib = require('zlib');
const { resolvePathTokens, tokenizePath } = require('../path-tokens');

const MAX_TEXT_FILE_BYTES = 1024 * 1024;
const MAX_MEDIA_METADATA_CHARS = 10000;
const MEDIA_EXTENSIONS = {
  image: new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.avif', '.heic', '.svgz']),
  audio: new Set(['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.wma', '.opus']),
  video: new Set(['.mp4', '.mkv', '.mov', '.avi', '.webm', '.m4v', '.wmv', '.mpeg', '.mpg'])
};

function mediaTypeForPath(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return Object.entries(MEDIA_EXTENSIONS).find(([, extensions]) => extensions.has(extension))?.[0] || null;
}

function looksBinary(buffer) {
  if (!buffer?.length) return false;
  let suspicious = 0;
  for (const byte of buffer) {
    if (byte === 0) return true;
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return suspicious / buffer.length > 0.1;
}

function parsePngTextChunk(type, chunk) {
  const nullIndex = chunk.indexOf(0);
  if (nullIndex <= 0) return null;
  const key = chunk.toString('latin1', 0, nullIndex);
  if (type === 'tEXt') {
    return { key, value: chunk.toString('utf8', nullIndex + 1) };
  }
  if (type === 'zTXt') {
    try {
      return {
        key,
        value: zlib.inflateSync(chunk.subarray(nullIndex + 2), { maxOutputLength: MAX_MEDIA_METADATA_CHARS }).toString('utf8')
      };
    } catch (_) {
      return { key, value: '[compressed textual metadata exceeds the safe preview limit]' };
    }
  }
  if (type !== 'iTXt') return null;
  let offset = nullIndex + 1;
  const compressed = chunk[offset] === 1;
  offset += 2;
  const languageEnd = chunk.indexOf(0, offset);
  if (languageEnd < 0) return null;
  offset = languageEnd + 1;
  const translatedEnd = chunk.indexOf(0, offset);
  if (translatedEnd < 0) return null;
  offset = translatedEnd + 1;
  if (!compressed) return { key, value: chunk.toString('utf8', offset) };
  try {
    return {
      key,
      value: zlib.inflateSync(chunk.subarray(offset), { maxOutputLength: MAX_MEDIA_METADATA_CHARS }).toString('utf8')
    };
  } catch (_) {
    return { key, value: '[compressed textual metadata exceeds the safe preview limit]' };
  }
}

async function readPngTextMetadata(filePath, maxChars = MAX_MEDIA_METADATA_CHARS) {
  const handle = await fs.open(filePath, 'r');
  const entries = [];
  let remaining = maxChars;
  try {
    const signature = Buffer.alloc(8);
    if ((await handle.read(signature, 0, 8, 0)).bytesRead !== 8
      || signature.toString('hex') !== '89504e470d0a1a0a') return entries;
    const size = (await handle.stat()).size;
    let offset = 8;
    while (offset + 12 <= size && remaining > 0) {
      const header = Buffer.alloc(8);
      if ((await handle.read(header, 0, 8, offset)).bytesRead !== 8) break;
      const length = header.readUInt32BE(0);
      const type = header.toString('ascii', 4, 8);
      if (length > size - offset - 12) break;
      if (['tEXt', 'zTXt', 'iTXt'].includes(type) && length <= 1024 * 1024) {
        const chunk = Buffer.alloc(length);
        await handle.read(chunk, 0, length, offset + 8);
        const parsed = parsePngTextChunk(type, chunk);
        if (parsed) {
          const value = parsed.value.slice(0, remaining);
          entries.push({ key: parsed.key, value, truncated: value.length < parsed.value.length });
          remaining -= value.length;
        }
      }
      offset += 12 + length;
      if (type === 'IEND') break;
    }
    return entries;
  } finally {
    await handle.close();
  }
}

async function mediaReadResponse(server, filePath, requestedPath, stat, mediaType) {
  const embeddedText = path.extname(filePath).toLowerCase() === '.png'
    ? await readPngTextMetadata(filePath)
    : [];
  return {
    path: await toPortablePath(server, filePath),
    requestedPath,
    media: true,
    mediaType,
    size: stat.size,
    binaryContentRead: false,
    message: 'Media file detected. read_file does not decode image, audio, or video bytes as text. No binary content was added to the conversation. Use the media inspection tool for visual or audio content, or a metadata-specific tool. Embedded textual metadata is returned below, capped at 10,000 characters.',
    embeddedText,
    metadataLimit: MAX_MEDIA_METADATA_CHARS
  };
}

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
  const filePath = await resolvePathTokens(rawPath, getPathTokenOptions(server));
  if (/\{[a-z_]+\}/i.test(filePath)) {
    throw new Error(`Unresolved path token in path: ${rawPath}`);
  }
  return filePath;
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

async function assertFilePathAllowed(server, filePath) {
  await server.assertExecutionPathAllowed?.(filePath, {
    extraRoots: [
      await getAllowedWorkspaceRoot(server),
      getAllowedAgentinRoot(server)
    ].filter(Boolean)
  });
}

function countOccurrences(content, search) {
  if (!search) return 0;
  let count = 0;
  let offset = 0;
  while (offset < content.length) {
    const index = content.indexOf(search, offset);
    if (index === -1) break;
    count++;
    offset = index + search.length;
  }
  return count;
}

function registerFileTools(server) {
  server.registerTool('read_file', {
    name: 'read_file',
    description: 'Read contents of a text file. Do not use for media or large binary data; use partial parsing or dedicated tools to inspect metadata/content instead.',
    userDescription: 'Reads and returns the contents of a text file. Do not use for images, audio, video, archives, or large files; use partial parsing or dedicated media tools to fetch metadata or inspect content instead.',
    example: 'TOOL:read_file{"path":"{agent_tasks}/plan.md"}',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Full path or path token to the file to read' }
      },
      required: ['path']
    }
  }, async (params) => {
    const filePath = await resolveToolPath(server, params.path);
    await assertFilePathAllowed(server, filePath);
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error('read_file requires a file path');
    const mediaType = mediaTypeForPath(filePath);
    if (mediaType) return mediaReadResponse(server, filePath, params.path, stat, mediaType);
    if (stat.size > MAX_TEXT_FILE_BYTES) {
      return {
        path: await toPortablePath(server, filePath),
        requestedPath: params.path,
        size: stat.size,
        contentRead: false,
        error: `Text file is larger than the ${MAX_TEXT_FILE_BYTES}-byte read_file limit. Use ripgrep/search_workspace or another bounded inspection tool.`
      };
    }
    const probe = Buffer.alloc(Math.min(stat.size, 8192));
    if (probe.length) {
      const handle = await fs.open(filePath, 'r');
      try { await handle.read(probe, 0, probe.length, 0); } finally { await handle.close(); }
      if (looksBinary(probe)) {
        return {
          path: await toPortablePath(server, filePath),
          requestedPath: params.path,
          size: stat.size,
          binaryContentRead: false,
          error: 'Binary file detected. No binary content was added to the conversation. Use a format-specific metadata or inspection tool.'
        };
      }
    }
    const content = await fs.readFile(filePath, 'utf-8');
    return { path: await toPortablePath(server, filePath), requestedPath: params.path, content, size: content.length };
  });

  server.registerTool('write_file', {
    name: 'write_file',
    description: 'Write content to a file',
    userDescription: 'Writes text content to a file (creates or overwrites)',
    example: 'TOOL:write_file{"path":"{agent_tasks}/plan.md","content":"Hello World"}',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Full path or path token to the file to write' },
        content: { type: 'string', description: 'Content to write to the file' },
        append: { type: 'boolean', description: 'Append to file instead of overwrite', default: false }
      },
      required: ['path', 'content']
    }
  }, async (params) => {
    const filePath = await resolveToolPath(server, params.path);
    await assertFilePathAllowed(server, filePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    if (params.append) {
      await fs.appendFile(filePath, params.content, 'utf-8');
    } else {
      await fs.writeFile(filePath, params.content, 'utf-8');
    }
    if (server._artifactRegistry) {
      const sessionId = server.getCurrentSessionId?.() || 'default';
      server._artifactRegistry.registerFile(sessionId, {
        name: path.basename(filePath),
        path: filePath,
        source: params.append ? 'write_file:append' : 'write_file',
        action: params.append ? 'edited' : 'created'
      });
    }
    return { path: await toPortablePath(server, filePath), requestedPath: params.path, written: params.content.length, append: params.append || false };
  });


  server.registerTool('edit_file', {
    name: 'edit_file',
    description: 'Edit an existing text file by applying exact search-and-replace operations',
    userDescription: 'Surgically edits a text file using exact substring replacements',
    example: 'TOOL:edit_file{"path":"{agent_tasks}/plan.md","edits":[{"search":"Status: pending","replace":"Status: done"}]}',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Full path or path token to the file to edit' },
        edits: {
          type: 'array',
          description: 'Sequential exact replacements. Each edit has search and replace strings.'
        }
      },
      required: ['path', 'edits']
    }
  }, async (params) => {
    if (!Array.isArray(params.edits)) {
      throw new Error('edit_file requires edits to be an array');
    }

    const filePath = await resolveToolPath(server, params.path);
    await assertFilePathAllowed(server, filePath);
    let content = await fs.readFile(filePath, 'utf-8');
    const applied = [];
    const skipped = [];

    for (let index = 0; index < params.edits.length; index++) {
      const edit = params.edits[index] || {};
      const search = String(edit.search ?? '');
      const replace = String(edit.replace ?? '');
      if (!search) {
        skipped.push({ index, reason: 'empty_search' });
        continue;
      }

      const matchCount = countOccurrences(content, search);
      if (matchCount === 0) {
        skipped.push({ index, search, reason: 'not_found' });
        continue;
      }
      if (matchCount > 1) {
        throw new Error(
          `edit_file search is not unique at edit index ${index} (found ${matchCount} matches). ` +
          'Provide a longer unique search string with surrounding context.'
        );
      }

      content = content.replace(search, replace);
      applied.push({ index, search, replacements: 1, matchCount });
    }

    await fs.writeFile(filePath, content, 'utf-8');
    if (server._artifactRegistry && applied.length > 0) {
      const sessionId = server.getCurrentSessionId?.() || 'default';
      server._artifactRegistry.registerFile(sessionId, {
        name: path.basename(filePath),
        path: filePath,
        source: 'edit_file',
        action: 'edited'
      });
    }
    return {
      path: await toPortablePath(server, filePath),
      requestedPath: params.path,
      editsApplied: applied.length,
      editsSkipped: skipped.length,
      applied,
      skipped,
      newSize: content.length
    };
  });


  server.registerTool('list_directory', {
    name: 'list_directory',
    description: 'List contents of a directory',
    userDescription: 'Lists all files and folders in a directory',
    example: 'TOOL:list_directory{"path":"{agent_home}"}',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Full path or path token to the directory to list' }
      },
      required: ['path']
    }
  }, async (params) => {
    const dirPath = await resolveToolPath(server, params.path);
    await assertFilePathAllowed(server, dirPath);
    const items = await fs.readdir(dirPath, { withFileTypes: true });
    return Promise.all(items.map(async (item) => ({
      name: item.name,
      type: item.isDirectory() ? 'directory' : 'file',
      path: await toPortablePath(server, path.join(dirPath, item.name))
    })));
  });

  server.registerTool('file_exists', {
    name: 'file_exists',
    description: 'Check if a file or directory exists',
    userDescription: 'Checks whether a file or directory exists at the given path',
    example: 'TOOL:file_exists{"path":"C:/Users/data.txt"}',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Full path or path token to check' }
      },
      required: ['path']
    }
  }, async (params) => {
    const filePath = await resolveToolPath(server, params.path);
    await assertFilePathAllowed(server, filePath);
    try {
      const stat = await fs.stat(filePath);
      return {
        path: await toPortablePath(server, filePath),
        requestedPath: params.path,
        exists: true,
        isFile: stat.isFile(),
        isDirectory: stat.isDirectory(),
        size: stat.size
      };
    } catch {
      return { path: await toPortablePath(server, filePath), requestedPath: params.path, exists: false };
    }
  });

  server.registerTool('delete_file', {
    name: 'delete_file',
    description: 'Delete a file',
    userDescription: 'Deletes a file at the given path',
    example: 'TOOL:delete_file{"path":"C:/Users/temp.txt"}',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Full path or path token to the file to delete' }
      },
      required: ['path']
    }
  }, async (params) => {
    const filePath = await resolveToolPath(server, params.path);
    await assertFilePathAllowed(server, filePath);
    await fs.unlink(filePath);
    if (server._artifactRegistry) {
      const sessionId = server.getCurrentSessionId?.() || 'default';
      server._artifactRegistry.registerFile(sessionId, {
        name: path.basename(filePath),
        path: filePath,
        source: 'delete_file',
        action: 'deleted'
      });
    }
    return { deleted: true, path: await toPortablePath(server, filePath), requestedPath: params.path };
  });
}

module.exports = { registerFileTools };
