const fs = require('fs');
const path = require('path');

function captureDeclaredOutputState(workflow) {
    const targets = [];
    for (const node of Object.values(workflow || {})) {
        const outputPath = String(node?.inputs?.output_path || '').trim();
        const prefix = String(node?.inputs?.save_prefix || node?.inputs?.filename_prefix || '').trim();
        if (!outputPath || !path.isAbsolute(outputPath) || !fs.existsSync(outputPath)) continue;
        const before = new Set(fs.readdirSync(outputPath, { withFileTypes: true })
            .filter(entry => entry.isFile() && (!prefix || entry.name.startsWith(prefix)))
            .map(entry => entry.name));
        targets.push({ outputPath, prefix, before });
    }
    return targets;
}

function findDeclaredOutputFiles(targets, startedAt) {
    const found = [];
    const seen = new Set();
    for (const target of targets || []) {
        if (!fs.existsSync(target.outputPath)) continue;
        for (const entry of fs.readdirSync(target.outputPath, { withFileTypes: true })) {
            if (!entry.isFile() || (target.prefix && !entry.name.startsWith(target.prefix))) continue;
            const filePath = path.join(target.outputPath, entry.name);
            const stat = fs.statSync(filePath);
            if (target.before.has(entry.name) && stat.mtimeMs < startedAt - 1000) continue;
            if (seen.has(filePath)) continue;
            seen.add(filePath);
            found.push({ filename: entry.name, filePath, size: stat.size, modifiedAt: stat.mtime.toISOString() });
        }
    }
    return found.sort((left, right) => String(right.modifiedAt).localeCompare(String(left.modifiedAt)));
}

function extractExecutionFailure(entry) {
    const messages = Array.isArray(entry?.status?.messages) ? entry.status.messages : [];
    const executionError = [...messages].reverse().find(message => Array.isArray(message) && message[0] === 'execution_error');
    const detail = executionError?.[1] || entry?.status?.error || {};
    return {
        nodeId: detail.node_id ?? detail.nodeId ?? null,
        nodeType: detail.node_type || detail.nodeType || null,
        exceptionType: detail.exception_type || detail.exceptionType || null,
        message: String(detail.exception_message || detail.message || entry?.status?.status_str || 'Unknown ComfyUI execution error')
    };
}

module.exports = { captureDeclaredOutputState, findDeclaredOutputFiles, extractExecutionFailure };
