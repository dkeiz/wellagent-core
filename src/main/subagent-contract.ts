// @ts-nocheck
const path = require('path');

function normalizeOpaqueId(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  return String(value);
}

function buildSubagentIdentifiers(source = {}) {
  const runId = source.run_id ?? source.runId ?? source.id ?? null;
  const subagentId = source.subagent_id ?? source.subagentId ?? source.agent_id ?? source.agentId ?? null;
  const parentSessionId = source.parent_session_id ?? source.parentSessionId ?? null;
  const childSessionId = source.child_session_id ?? source.childSessionId ?? null;

  return {
    run_id: normalizeOpaqueId(runId),
    subagent_id: normalizeOpaqueId(subagentId),
    parent_session_id: normalizeOpaqueId(parentSessionId),
    child_session_id: normalizeOpaqueId(childSessionId)
  };
}

function summarizePlainText(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return 'Task delivered';
  }
  const firstSentence = normalized.split(/[.!?]/)[0].trim();
  const summary = firstSentence || normalized;
  return summary.length > 180 ? `${summary.slice(0, 177)}...` : summary;
}

function hasMeaningfulValue(value) {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value === 'boolean') {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some(entry => hasMeaningfulValue(entry));
  }
  if (typeof value === 'object') {
    return Object.values(value).some(entry => hasMeaningfulValue(entry));
  }
  return false;
}

function isExplicitOutcomeText(text) {
  const normalized = String(text || '').trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return /(no result|no results|empty|not found|nothing found|unable to|could not|can't|cannot|failed|failure|unavailable|blocked|partial|uncertain|no matching|zero results)/i.test(normalized);
}

function isTrivialCompletionSummary(summary) {
  const normalized = String(summary || '').trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  return new Set([
    'done',
    'ok',
    'okay',
    'success',
    'successful',
    'completed',
    'complete',
    'finished',
    'all done',
    'task complete',
    'task completed',
    'delivered',
    'sent'
  ]).has(normalized);
}

function buildCompletionCandidate(response, preferredStatus, extractJsonObject) {
  const rawContent = String(response?.content || '').trim();
  const inferredStatus = response?.chainExhausted ? 'delivery_incomplete' : (preferredStatus || 'delivered');
  const completionResult = response?.completionResult;

  if (completionResult && typeof completionResult === 'object' && !Array.isArray(completionResult)) {
    return {
      source: 'completion_tool',
      rawContent,
      inferredStatus,
      payload: completionResult
    };
  }

  const parsedJson = extractJsonObject(rawContent);
  if (parsedJson && typeof parsedJson === 'object' && !Array.isArray(parsedJson)) {
    return {
      source: 'strict_json',
      rawContent,
      inferredStatus,
      payload: parsedJson
    };
  }

  return {
    source: rawContent ? 'plain_text' : 'missing',
    rawContent,
    inferredStatus,
    payload: null
  };
}

function normalizeCompletionPayload(payload, options = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Sub-agent completion payload must be an object');
  }

  const summary = String(payload.summary || '').trim();
  if (!summary) {
    throw new Error('Sub-agent completion payload is missing summary');
  }

  const preferredStatus = String(options.preferredStatus || '').trim();
  const status = String(payload.status || preferredStatus || 'delivered').trim() || 'delivered';
  const data = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
    ? payload.data
    : {};

  const artifacts = Array.isArray(payload.artifacts)
    ? payload.artifacts.map(artifact => {
      const normalizedPath = artifact?.path ? String(artifact.path) : '';
      const normalizedName = artifact?.name
        ? String(artifact.name)
        : (normalizedPath ? path.basename(normalizedPath) : '');

      return {
        ...artifact,
        path: normalizedPath,
        name: normalizedName
      };
    })
    : [];

  return {
    status,
    summary,
    data,
    artifacts,
    notes: payload.notes ? String(payload.notes) : ''
  };
}

function assessCompletionQuality(contract, candidate) {
  const hasStructuredData = hasMeaningfulValue(contract.data);
  const hasArtifacts = Array.isArray(contract.artifacts) && contract.artifacts.length > 0;
  const hasNotes = hasMeaningfulValue(contract.notes);

  if (candidate.source === 'missing') {
    return { ok: false, reason: 'missing_completion_contract', message: 'Sub-agent stopped without returning a completion envelope.' };
  }
  if (candidate.source === 'plain_text') {
    return { ok: false, reason: 'missing_completion_contract', message: 'Sub-agent returned plain text instead of the required completion envelope.' };
  }
  if (hasStructuredData || hasArtifacts || hasNotes) {
    return { ok: true, reason: null, message: '' };
  }
  if (isExplicitOutcomeText(contract.status) || isExplicitOutcomeText(contract.summary)) {
    return { ok: true, reason: null, message: '' };
  }
  if (!isTrivialCompletionSummary(contract.summary)) {
    return { ok: true, reason: null, message: '' };
  }
  return { ok: false, reason: 'empty_completion_envelope', message: 'Sub-agent completion envelope is too thin to be useful.' };
}

function buildSubagentReminderPrompt(preferredStatus, validation, attemptNumber) {
  const issueMessage = validation?.message || 'The parent did not receive a usable completion envelope.';
  const issueLabel = String(validation?.reason || 'invalid_completion_result').replace(/_/g, ' ');
  const preview = String(validation?.candidate?.rawContent || '').trim();
  const previewBlock = preview
    ? `Last response preview:
${preview.slice(0, 500)}
`
    : '';
  const preferredLabel = String(preferredStatus || '').trim();
  const preferredLine = preferredLabel
    ? `Preferred success status for a strong result: "${preferredLabel}".`
    : 'Preferred success status: any short outcome label that fits the result.';

  return `Backend reminder ${attemptNumber}: the parent still has no usable completion envelope.

Problem detected:
- ${issueMessage}
- issue type: ${issueLabel}

Silent stop is invalid.
If you need more work, continue the task now.
When you are done, you MUST deliver a noticed completion envelope by calling complete_subtask or returning strict JSON.

Envelope guidance:
- status: short outcome label such as "task_complete", "partial", "empty", "blocked", or "task_failed"
- summary: clear human-readable outcome
- data: structured payload when useful
- artifacts: files used or created
- notes: optional extra context

${preferredLine}
If the result is empty, unavailable, blocked, or not found, say that clearly in summary/notes/data.
Do not reply with empty text.
Do not stop without a completion tool call or strict JSON completion envelope.

${previewBlock}`.trim();
}

function buildForcedIncompleteContract(preferredStatus, validation, attempts, response) {
  const message = validation?.message || 'Sub-agent stopped without a valid completion envelope.';
  const lastPreview = String(validation?.candidate?.rawContent || response?.content || '').trim();

  return {
    status: 'delivery_incomplete',
    summary: `Sub-agent did not deliver a usable completion envelope after ${attempts} backend reminder${attempts === 1 ? '' : 's'}. ${message}`,
    data: {
      preferred_status: String(preferredStatus || '').trim() || null,
      final_issue: validation?.reason || 'missing_completion_contract',
      reminders_sent: attempts,
      last_response_preview: lastPreview.slice(0, 500)
    },
    artifacts: [],
    notes: 'Backend synthesized this envelope because silent stop and empty delivery are invalid delegated-run outcomes.'
  };
}

module.exports = {
  assessCompletionQuality,
  buildCompletionCandidate,
  buildForcedIncompleteContract,
  buildSubagentIdentifiers,
  buildSubagentReminderPrompt,
  hasMeaningfulValue,
  isExplicitOutcomeText,
  normalizeCompletionPayload,
  normalizeOpaqueId,
  summarizePlainText
};
