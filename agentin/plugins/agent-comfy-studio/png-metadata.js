const fs = require('fs');
const zlib = require('zlib');
const MAX_METADATA_BYTES = 16 * 1024 * 1024;

function parsePngTextChunk(type, chunk) {
    const nullIdx = chunk.indexOf(0);
    if (nullIdx <= 0) return null;
    const key = chunk.toString('latin1', 0, nullIdx);
    try {
        if (type === 'tEXt') return { key, value: chunk.toString('utf8', nullIdx + 1) };
        if (type === 'zTXt') return {
            key,
            value: zlib.inflateSync(chunk.subarray(nullIdx + 2), { maxOutputLength: MAX_METADATA_BYTES }).toString('utf8')
        };
        let pos = nullIdx + 1;
        const compressed = chunk[pos] === 1;
        pos += 2;
        const languageEnd = chunk.indexOf(0, pos);
        if (languageEnd < 0) return null;
        pos = languageEnd + 1;
        const translatedEnd = chunk.indexOf(0, pos);
        if (translatedEnd < 0) return null;
        pos = translatedEnd + 1;
        const text = chunk.subarray(pos);
        return {
            key,
            value: (compressed ? zlib.inflateSync(text, { maxOutputLength: MAX_METADATA_BYTES }) : text).toString('utf8')
        };
    } catch (_) {
        return null;
    }
}

function extractPngMetadata(filePath) {
    const metadata = {};
    const fd = fs.openSync(filePath, 'r');
    try {
        const size = fs.fstatSync(fd).size;
        const signature = Buffer.alloc(8);
        if (fs.readSync(fd, signature, 0, 8, 0) !== 8
            || signature.toString('hex') !== '89504e470d0a1a0a') {
            return { error: 'Not a valid PNG file' };
        }
        let offset = 8;
        while (offset + 12 <= size) {
            const header = Buffer.alloc(8);
            if (fs.readSync(fd, header, 0, 8, offset) !== 8) break;
            const length = header.readUInt32BE(0);
            const type = header.toString('ascii', 4, 8);
            if (length > size - offset - 12) return { error: 'PNG contains an invalid chunk length' };
            if (['tEXt', 'zTXt', 'iTXt'].includes(type) && length <= MAX_METADATA_BYTES) {
                const chunk = Buffer.alloc(length);
                fs.readSync(fd, chunk, 0, length, offset + 8);
                const parsed = parsePngTextChunk(type, chunk);
                if (parsed && ['prompt', 'workflow', 'parameters'].includes(parsed.key)) {
                    try { metadata[parsed.key] = JSON.parse(parsed.value); }
                    catch (_) { metadata[parsed.key] = parsed.value; }
                }
            }
            offset += 12 + length;
            if (type === 'IEND') break;
        }
        return metadata;
    } finally {
        fs.closeSync(fd);
    }
}

function summarizeWorkflow(metadata) {
    const graph = metadata?.prompt;
    if (!graph || typeof graph !== 'object' || Array.isArray(graph)) return null;
    const positiveIds = new Set();
    const negativeIds = new Set();
    const samplers = [];
    for (const [nodeId, node] of Object.entries(graph)) {
        if (!node || typeof node !== 'object') continue;
        if (/sampler/i.test(String(node.class_type || ''))) {
            if (Array.isArray(node.inputs?.positive)) positiveIds.add(String(node.inputs.positive[0]));
            if (Array.isArray(node.inputs?.negative)) negativeIds.add(String(node.inputs.negative[0]));
            const settings = {};
            for (const key of ['seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise']) {
                if (node.inputs?.[key] !== undefined) settings[key] = node.inputs[key];
            }
            samplers.push({ nodeId, classType: node.class_type, ...settings });
        }
    }
    const checkpoints = [];
    const prompts = [];
    const loras = [];
    const dimensions = [];
    const stages = [];
    const outputNodes = [];
    for (const [nodeId, node] of Object.entries(graph)) {
        if (!node || typeof node !== 'object') continue;
        const inputs = node.inputs || {};
        const classType = String(node.class_type || '');
        stages.push({ nodeId, classType, title: String(node._meta?.title || '') });
        if (/^(?:SaveImage|PreviewImage|ttN imageOutput)$/i.test(classType)) {
            outputNodes.push({ nodeId, classType, filenamePrefix: inputs.filename_prefix });
        }
        if (inputs.ckpt_name) checkpoints.push({ nodeId, classType, name: inputs.ckpt_name });
        if (classType === 'CLIPTextEncode' && typeof inputs.text === 'string') {
            prompts.push({
                nodeId,
                role: negativeIds.has(nodeId) ? 'negative' : (positiveIds.has(nodeId) ? 'positive' : 'unclassified'),
                text: inputs.text
            });
        }
        if (inputs.lora_name) {
            loras.push({
                nodeId,
                classType,
                name: inputs.lora_name,
                enabled: true,
                strengthModel: inputs.strength_model,
                strengthClip: inputs.strength_clip
            });
        }
        for (const [inputName, value] of Object.entries(inputs)) {
            if (!/^lora_\d+$/i.test(inputName) || !value || typeof value !== 'object') continue;
            loras.push({
                nodeId,
                input: inputName,
                classType,
                name: value.lora,
                enabled: value.on !== false && value.lora !== 'None',
                strength: value.strength
            });
        }
        if (Number.isFinite(Number(inputs.width)) && Number.isFinite(Number(inputs.height))) {
            dimensions.push({ nodeId, classType, width: Number(inputs.width), height: Number(inputs.height) });
        }
    }
    return {
        nodeCount: Object.keys(graph).length,
        checkpoints,
        prompts,
        loras,
        enabledLoras: loras.filter(lora => lora.enabled),
        samplers,
        dimensions,
        stages,
        outputNodes
    };
}

module.exports = { extractPngMetadata, parsePngTextChunk, summarizeWorkflow };
