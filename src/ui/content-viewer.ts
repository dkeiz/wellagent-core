// ---------------------------------------------------------------------------
// lib/ui/content-viewer.ts — Content type detection and rendering pipeline
// ---------------------------------------------------------------------------

/**
 * Detectable content types for rich rendering.
 */
export type ContentKind =
  | 'text' | 'markdown' | 'code' | 'json'
  | 'html' | 'csv' | 'image' | 'video'
  | 'audio' | 'pdf' | 'svg' | 'mermaid'
  | 'chart' | 'diff' | 'binary' | 'unknown';

/** Detection result. */
export interface ContentDetection {
  kind: ContentKind;
  language?: string;
  mimeType?: string;
  confidence: number;
}

/** Known file extensions → content kinds. */
const EXT_MAP: Record<string, { kind: ContentKind; language?: string; mimeType?: string }> = {
  '.md': { kind: 'markdown', language: 'markdown', mimeType: 'text/markdown' },
  '.txt': { kind: 'text', mimeType: 'text/plain' },
  '.json': { kind: 'json', language: 'json', mimeType: 'application/json' },
  '.html': { kind: 'html', language: 'html', mimeType: 'text/html' },
  '.htm': { kind: 'html', language: 'html', mimeType: 'text/html' },
  '.css': { kind: 'code', language: 'css', mimeType: 'text/css' },
  '.js': { kind: 'code', language: 'javascript', mimeType: 'text/javascript' },
  '.ts': { kind: 'code', language: 'typescript', mimeType: 'text/typescript' },
  '.py': { kind: 'code', language: 'python', mimeType: 'text/x-python' },
  '.rs': { kind: 'code', language: 'rust', mimeType: 'text/x-rust' },
  '.go': { kind: 'code', language: 'go', mimeType: 'text/x-go' },
  '.java': { kind: 'code', language: 'java', mimeType: 'text/x-java' },
  '.cpp': { kind: 'code', language: 'cpp', mimeType: 'text/x-c++' },
  '.c': { kind: 'code', language: 'c', mimeType: 'text/x-c' },
  '.sh': { kind: 'code', language: 'bash', mimeType: 'text/x-shellscript' },
  '.yaml': { kind: 'code', language: 'yaml', mimeType: 'text/yaml' },
  '.yml': { kind: 'code', language: 'yaml', mimeType: 'text/yaml' },
  '.toml': { kind: 'code', language: 'toml', mimeType: 'text/toml' },
  '.xml': { kind: 'code', language: 'xml', mimeType: 'text/xml' },
  '.sql': { kind: 'code', language: 'sql', mimeType: 'text/x-sql' },
  '.csv': { kind: 'csv', mimeType: 'text/csv' },
  '.svg': { kind: 'svg', mimeType: 'image/svg+xml' },
  '.png': { kind: 'image', mimeType: 'image/png' },
  '.jpg': { kind: 'image', mimeType: 'image/jpeg' },
  '.jpeg': { kind: 'image', mimeType: 'image/jpeg' },
  '.gif': { kind: 'image', mimeType: 'image/gif' },
  '.webp': { kind: 'image', mimeType: 'image/webp' },
  '.mp4': { kind: 'video', mimeType: 'video/mp4' },
  '.webm': { kind: 'video', mimeType: 'video/webm' },
  '.mp3': { kind: 'audio', mimeType: 'audio/mpeg' },
  '.wav': { kind: 'audio', mimeType: 'audio/wav' },
  '.ogg': { kind: 'audio', mimeType: 'audio/ogg' },
  '.pdf': { kind: 'pdf', mimeType: 'application/pdf' },
  '.diff': { kind: 'diff', language: 'diff', mimeType: 'text/x-diff' },
  '.patch': { kind: 'diff', language: 'diff', mimeType: 'text/x-diff' },
};

/**
 * Detect content type from a filename.
 */
export function detectByFilename(filename: string): ContentDetection {
  const ext = filename.includes('.') ? '.' + filename.split('.').pop()!.toLowerCase() : '';
  const entry = EXT_MAP[ext];
  if (entry) {
    return { kind: entry.kind, language: entry.language, mimeType: entry.mimeType, confidence: 0.9 };
  }
  return { kind: 'unknown', confidence: 0.1 };
}

/**
 * Detect content type from raw text content.
 */
export function detectByContent(content: string): ContentDetection {
  const text = String(content || '').trim();

  if (!text) return { kind: 'text', confidence: 0.5 };

  // JSON
  if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
    try { JSON.parse(text); return { kind: 'json', language: 'json', confidence: 0.95 }; } catch { /* not json */ }
  }

  // HTML
  if (/^<!DOCTYPE\s+html/i.test(text) || /^<html/i.test(text)) {
    return { kind: 'html', language: 'html', confidence: 0.9 };
  }

  // SVG
  if (text.includes('<svg') && text.includes('</svg>')) {
    return { kind: 'svg', mimeType: 'image/svg+xml', confidence: 0.9 };
  }

  // Mermaid
  if (/^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|journey)/m.test(text)) {
    return { kind: 'mermaid', confidence: 0.8 };
  }

  // Diff
  if (/^(---|\+\+\+|@@|diff --git)/m.test(text)) {
    return { kind: 'diff', language: 'diff', confidence: 0.85 };
  }

  // CSV
  const lines = text.split('\n').slice(0, 5);
  if (lines.length >= 2) {
    const commaCount = lines.map(l => (l.match(/,/g) || []).length);
    if (commaCount[0] > 1 && commaCount.every(c => c === commaCount[0])) {
      return { kind: 'csv', confidence: 0.7 };
    }
  }

  // Markdown (has headers, lists, links)
  if (/^#{1,6}\s/m.test(text) || /^\s*[-*]\s/m.test(text)) {
    return { kind: 'markdown', language: 'markdown', confidence: 0.6 };
  }

  return { kind: 'text', confidence: 0.5 };
}

/**
 * Detect content type from both filename and content, with filename taking precedence.
 */
export function detectContent(filename: string | null, content: string): ContentDetection {
  if (filename) {
    const byFile = detectByFilename(filename);
    if (byFile.confidence >= 0.8) return byFile;
  }
  return detectByContent(content);
}
