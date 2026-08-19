const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const cachedWorkflows = new Map();
const knownOutputClasses = new Set(['SaveImage', 'PreviewImage', 'ttN imageOutput']);
const knownConnectionTypes = new Set([
    'MODEL', 'CLIP', 'VAE', 'CONDITIONING', 'LATENT', 'IMAGE', 'MASK',
    'CONTROL_NET', 'CLIP_VISION', 'CLIP_VISION_OUTPUT', 'STYLE_MODEL',
    'GLIGEN', 'UPSCALE_MODEL', 'AUDIO', 'WEBCAM'
]);

function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function looksLikeApiGraph(value) {
    if (!isObject(value)) return false;
    const nodes = Object.values(value);
    return nodes.length > 0 && nodes.every(node => isObject(node) && typeof node.class_type === 'string' && isObject(node.inputs));
}

function selectApiGraph(value) {
    if (looksLikeApiGraph(value)) return clone(value);
    if (looksLikeApiGraph(value?.prompt)) return clone(value.prompt);
    if (looksLikeApiGraph(value?.workflow)) return clone(value.workflow);
    if (Array.isArray(value?.nodes)) throw new Error('Editor/UI workflow JSON is not executable. Use an API graph or PNG metadata.prompt.');
    throw new Error('No ComfyUI API-format workflow graph was found');
}

function workflowHash(workflow) {
    return crypto.createHash('sha256').update(JSON.stringify(workflow)).digest('hex');
}

function safeName(value, fallback = 'workflow') {
    return String(value || fallback).trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || fallback;
}

function workflowId(name) {
    return `${safeName(name)}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function cacheKey(agentInfo, id) {
    const scope = agentInfo?.folderPath ? path.resolve(agentInfo.folderPath) : 'global';
    return scope + ':' + id;
}

function recordPath(agentInfo, id) {
    if (!agentInfo?.folderPath) return '';
    return path.join(agentInfo.folderPath, 'tasks', 'comfyui', 'workflows', `${safeName(id)}.json`);
}

function saveRecord(record, agentInfo) {
    const filePath = recordPath(agentInfo, record.id);
    if (filePath) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(record), 'utf8');
        record.storagePath = filePath;
    }
    cachedWorkflows.set(cacheKey(agentInfo, record.id), record);
    return record;
}

function loadRecord(id, agentInfo) {
    const key = String(id || '').trim();
    if (!key) throw new Error('workflow_id is required');
    const scopedKey = cacheKey(agentInfo, key);
    if (cachedWorkflows.has(scopedKey)) return cachedWorkflows.get(scopedKey);
    const filePath = recordPath(agentInfo, key);
    if (!filePath || !fs.existsSync(filePath)) throw new Error(`Workflow not found: ${key}`);
    const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!looksLikeApiGraph(record.workflow)) throw new Error(`Stored workflow is invalid: ${key}`);
    record.storagePath = filePath;
    cachedWorkflows.set(scopedKey, record);
    return record;
}

function newRecord(name, workflow, source, agentInfo, uiWorkflow = null) {
    const now = new Date().toISOString();
    return saveRecord({
        version: 1,
        id: workflowId(name),
        name: String(name || 'workflow'),
        revision: 1,
        source,
        createdAt: now,
        updatedAt: now,
        workflow: selectApiGraph(workflow),
        uiWorkflow
    }, agentInfo);
}

function summary(record) {
    return {
        workflow_id: record.id,
        name: record.name,
        revision: record.revision,
        nodes: Object.keys(record.workflow).length,
        hash: workflowHash(record.workflow),
        source: record.source,
        storage_path: record.storagePath || null
    };
}

function isConnection(value) {
    return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && Number.isInteger(Number(value[1]));
}

function connections(node) {
    return Object.entries(node?.inputs || {}).filter(([, value]) => isConnection(value)).map(([input, value]) => ({
        input,
        from_node: value[0],
        output: Number(value[1])
    }));
}

function inspect(record, params) {
    const nodeId = String(params.node_id || '').trim();
    if (nodeId) {
        if (!record.workflow[nodeId]) throw new Error(`Node not found: ${nodeId}`);
        return { ...summary(record), node_id: nodeId, node: clone(record.workflow[nodeId]), connections: connections(record.workflow[nodeId]) };
    }
    const result = {
        ...summary(record),
        node_summary: Object.entries(record.workflow).map(([id, node]) => ({
            id,
            class_type: node.class_type,
            title: node._meta?.title || '',
            input_keys: Object.keys(node.inputs || {}),
            connections: connections(node)
        }))
    };
    if (params.full === true) result.workflow = clone(record.workflow);
    return result;
}

function splitPath(value) {
    const raw = String(value || '').trim();
    if (!raw) return [];
    if (raw.startsWith('/')) return raw.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
    return raw.split('.').filter(Boolean);
}

function updatePath(update) {
    const nodeId = String(update.node_id || '').trim();
    if (nodeId && update.input != null) return [nodeId, 'inputs', String(update.input)];
    if (nodeId && update.path) return [nodeId, ...splitPath(update.path)];
    if (update.json_path || update.path) return splitPath(update.json_path || update.path);
    throw new Error('Update requires node_id + input, node_id + path, or json_path');
}

function applyUpdate(workflow, update) {
    const parts = updatePath(update);
    if (parts.length === 0) throw new Error('Cannot edit the workflow root');
    let parent = workflow;
    for (const part of parts.slice(0, -1)) {
        if ((!isObject(parent) && !Array.isArray(parent)) || !(part in parent)) throw new Error(`Update path does not exist: ${parts.join('.')}`);
        parent = parent[part];
    }
    const key = parts[parts.length - 1];
    const exists = Object.prototype.hasOwnProperty.call(parent, key);
    const oldValue = exists ? clone(parent[key]) : undefined;
    const op = String(update.op || 'replace').toLowerCase();
    if (op === 'test') {
        if (!exists || JSON.stringify(parent[key]) !== JSON.stringify(update.value)) throw new Error(`Test failed at ${parts.join('.')}`);
    } else if (op === 'remove') {
        if (!exists) throw new Error(`Cannot remove missing path: ${parts.join('.')}`);
        delete parent[key];
    } else if (op === 'add' || op === 'replace') {
        if (op === 'replace' && !exists) throw new Error(`Cannot replace missing path: ${parts.join('.')}`);
        parent[key] = clone(update.value);
    } else {
        throw new Error(`Unsupported update operation: ${op}`);
    }
    return { op, path: parts.join('.'), old_value: oldValue, value: op === 'remove' ? undefined : clone(update.value) };
}

function edit(record, params, agentInfo) {
    const updates = Array.isArray(params.updates) ? params.updates : [];
    if (updates.length === 0) throw new Error('updates must contain at least one edit');
    const workflow = clone(record.workflow);
    const identityBefore = workflowModelIdentity(workflow);
    const applied = updates.map(update => applyUpdate(workflow, update));
    if (!looksLikeApiGraph(workflow)) throw new Error('Edits produced an invalid API graph');
    const referenceSource = record.source?.type === 'image'
        || record.source?.reference_source?.type === 'image';
    if (referenceSource && params.allow_model_changes !== true
        && identityBefore !== workflowModelIdentity(workflow)) {
        throw new Error('Reference workflow model or LoRA identity changed. Prompt, pose, background, dimensions, sampler values, and seed may be edited safely. Set allow_model_changes=true only when the user explicitly requested a checkpoint or LoRA change.');
    }
    record.workflow = workflow;
    record.revision += 1;
    record.updatedAt = new Date().toISOString();
    saveRecord(record, agentInfo);
    return { ...summary(record), applied };
}

function workflowModelIdentity(workflow) {
    return JSON.stringify(Object.entries(workflow).flatMap(([nodeId, node]) => {
        const inputs = node?.inputs || {};
        const loraSlots = Object.fromEntries(Object.entries(inputs).filter(([key]) => /^lora_\d+$/i.test(key)));
        const carriesIdentity = inputs.ckpt_name !== undefined
            || inputs.lora_name !== undefined
            || Object.keys(loraSlots).length > 0
            || /(?:checkpoint|lora)/i.test(String(node?.class_type || ''));
        if (!carriesIdentity) return [];
        return [{
            nodeId,
            class_type: node.class_type,
            ckpt_name: inputs.ckpt_name,
            lora_name: inputs.lora_name,
            strength_model: inputs.strength_model,
            strength_clip: inputs.strength_clip,
            lora_slots: loraSlots,
            model: inputs.model,
            clip: inputs.clip
        }];
    }));
}

function outputIds(workflow, objectInfo) {
    return Object.entries(workflow).filter(([, node]) => objectInfo?.[node.class_type]?.output_node === true || knownOutputClasses.has(node.class_type)).map(([id]) => id);
}

function reachableIds(workflow, outputs) {
    const found = new Set();
    const visit = id => {
        if (found.has(id) || !workflow[id]) return;
        found.add(id);
        connections(workflow[id]).forEach(connection => visit(connection.from_node));
    };
    outputs.forEach(visit);
    return found;
}

function validateGraph(workflow, objectInfo = null) {
    if (!looksLikeApiGraph(workflow)) return { valid: false, errors: ['Workflow is not an API-format graph'], warnings: [], outputs: [] };
    const errors = [];
    const warnings = [];
    const outputs = outputIds(workflow, objectInfo);
    const installedLoras = new Set(
        objectInfo?.LoraLoader?.input?.required?.lora_name?.[0] || []
    );
    if (outputs.length === 0) warnings.push('No recognized output node was found');
    const reachable = outputs.length ? reachableIds(workflow, outputs) : new Set(Object.keys(workflow));
    for (const id of reachable) {
        const node = workflow[id];
        const definition = objectInfo?.[node.class_type];
        if (objectInfo && !definition) errors.push(`Node ${id}: class_type is not installed: ${node.class_type}`);
        connections(node).forEach(connection => {
            if (!workflow[connection.from_node]) errors.push(`Node ${id}.${connection.input}: missing source node ${connection.from_node}`);
        });
        Object.keys(definition?.input?.required || {}).forEach(input => {
            if (!Object.prototype.hasOwnProperty.call(node.inputs, input)) errors.push(`Node ${id} (${node.class_type}): missing required input ${input}`);
        });
        for (const [input, specification] of Object.entries({
            ...(definition?.input?.required || {}),
            ...(definition?.input?.optional || {})
        })) {
            if (!Object.prototype.hasOwnProperty.call(node.inputs, input)) continue;
            const value = node.inputs[input];
            const expected = Array.isArray(specification) ? specification[0] : null;
            if (Array.isArray(expected) && !isConnection(value) && !expected.includes(value)) {
                errors.push(`Node ${id} (${node.class_type}).${input}: value is not installed: ${JSON.stringify(value)}`);
            } else if (knownConnectionTypes.has(expected) && !isConnection(value)) {
                errors.push(`Node ${id} (${node.class_type}).${input}: expected a ${expected} connection`);
            } else if (expected === 'INT' && !Number.isInteger(Number(value))) {
                errors.push(`Node ${id} (${node.class_type}).${input}: expected an integer`);
            } else if (expected === 'FLOAT' && !Number.isFinite(Number(value))) {
                errors.push(`Node ${id} (${node.class_type}).${input}: expected a number`);
            }
        }
        if (installedLoras.size > 0) {
            const referencedLoras = [];
            if (typeof node.inputs?.lora_name === 'string') referencedLoras.push(node.inputs.lora_name);
            for (const [input, value] of Object.entries(node.inputs || {})) {
                if (/^lora_\d+$/i.test(input) && value?.on !== false && typeof value?.lora === 'string') {
                    referencedLoras.push(value.lora);
                }
            }
            for (const loraName of referencedLoras) {
                if (loraName !== 'None' && !installedLoras.has(loraName)) {
                    errors.push(`Node ${id} (${node.class_type}): LoRA is not installed: ${JSON.stringify(loraName)}`);
                }
            }
        }
    }
    return { valid: errors.length === 0, errors, warnings, outputs, reachable_nodes: Array.from(reachable) };
}

async function validate(record, params, context, deps) {
    let objectInfo = null;
    let serverError = '';
    if (params.check_server !== false) {
        try {
            objectInfo = (await deps.httpRequest(deps.getBaseUrl(context), 'GET', '/object_info', null, 30000)).data;
        } catch (error) {
            serverError = error.message;
        }
    }
    const result = validateGraph(record.workflow, objectInfo);
    if (serverError) result.warnings.push(`ComfyUI class validation unavailable: ${serverError}`);
    return { ...summary(record), ...result, server_checked: Boolean(objectInfo) };
}

function conditioningNodeIds(workflow, inputName) {
    const found = new Set();
    for (const node of Object.values(workflow)) {
        if (!/sampler/i.test(String(node?.class_type || ''))) continue;
        const connection = node?.inputs?.[inputName];
        if (isConnection(connection)) found.add(String(connection[0]));
    }
    return Array.from(found).filter(nodeId => workflow[nodeId]?.class_type === 'CLIPTextEncode');
}

async function referenceGenerate(params, agentInfo, context, deps) {
    const imagePath = params.image_path || params.source?.path;
    if (!imagePath) throw new Error('reference_generate requires image_path');
    if (typeof params.positive_prompt !== 'string' || !params.positive_prompt.trim()) {
        throw new Error('reference_generate requires positive_prompt');
    }
    const record = await cloneWorkflow({
        name: params.name || 'reference-generation',
        image_path: imagePath
    }, agentInfo, context, deps);
    const updates = [];
    const positiveNodes = conditioningNodeIds(record.workflow, 'positive');
    if (positiveNodes.length === 0) throw new Error('Reference workflow has no directly connected positive CLIPTextEncode node');
    positiveNodes.forEach(nodeId => updates.push({
        op: 'replace', node_id: nodeId, input: 'text', value: params.positive_prompt
    }));
    if (typeof params.negative_prompt === 'string') {
        const negativeNodes = conditioningNodeIds(record.workflow, 'negative');
        negativeNodes.forEach(nodeId => updates.push({
            op: 'replace', node_id: nodeId, input: 'text', value: params.negative_prompt
        }));
    }
    if (params.seed !== undefined && params.seed !== null) {
        for (const [nodeId, node] of Object.entries(record.workflow)) {
            if (/sampler/i.test(String(node?.class_type || '')) && node.inputs?.seed !== undefined) {
                updates.push({ op: 'replace', node_id: nodeId, input: 'seed', value: Number(params.seed) });
            }
        }
    }
    if (String(params.filename_prefix || '').trim()) {
        for (const [nodeId, node] of Object.entries(record.workflow)) {
            if (node.inputs?.filename_prefix !== undefined) {
                updates.push({ op: 'replace', node_id: nodeId, input: 'filename_prefix', value: String(params.filename_prefix).trim() });
            }
        }
    }
    const edited = edit(record, { updates }, agentInfo);
    const validation = await validate(record, { check_server: true }, context, deps);
    if (!validation.valid) {
        return {
            success: false,
            action: 'reference_generate',
            error: 'Reference workflow validation failed; nothing was submitted.',
            ...summary(record),
            edited,
            validation
        };
    }
    const generated = await deps.handleGenerate({ workflow: clone(record.workflow), timeout: params.timeout }, context);
    return {
        ...generated,
        action: 'reference_generate',
        workflow_id: record.id,
        revision: record.revision,
        workflow_hash: workflowHash(record.workflow),
        edited,
        validation
    };
}

async function resolveSourcePath(value, context) {
    if (context?.paths?.resolve) return context.paths.resolve(value);
    return path.resolve(String(value));
}

async function cloneWorkflow(params, agentInfo, context, deps) {
    const source = isObject(params.source) ? params.source : {};
    const sourceId = source.workflow_id || params.source_workflow_id;
    if (sourceId) {
        const base = loadRecord(sourceId, agentInfo);
        return newRecord(params.name || `${base.name}-copy`, base.workflow, {
            type: 'workflow_id', workflow_id: base.id, revision: base.revision, hash: workflowHash(base.workflow),
            reference_source: base.source?.type === 'image' ? base.source : base.source?.reference_source
        }, agentInfo, base.uiWorkflow);
    }
    const imageValue = source.type === 'image' ? source.path : params.image_path;
    if (imageValue) {
        const imagePath = await resolveSourcePath(imageValue, context);
        if (!fs.existsSync(imagePath)) throw new Error(`Source image not found: ${imagePath}`);
        const metadata = deps.extractPngMetadata(imagePath);
        if (metadata.error) throw new Error(metadata.error);
        if (!looksLikeApiGraph(metadata.prompt)) throw new Error('PNG does not contain executable metadata.prompt');
        return newRecord(params.name || path.basename(imagePath, path.extname(imagePath)), metadata.prompt, {
            type: 'image', path: imagePath, metadata_keys: Object.keys(metadata)
        }, agentInfo, metadata.workflow || null);
    }
    const jsonValue = source.type === 'json' ? source.path : params.json_path;
    if (jsonValue) {
        const jsonPath = await resolveSourcePath(jsonValue, context);
        if (!fs.existsSync(jsonPath)) throw new Error(`Source JSON not found: ${jsonPath}`);
        const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        return newRecord(params.name || path.basename(jsonPath, path.extname(jsonPath)), selectApiGraph(parsed), {
            type: 'json', path: jsonPath
        }, agentInfo, Array.isArray(parsed?.workflow?.nodes) ? parsed.workflow : null);
    }
    const raw = source.workflow || params.workflow;
    if (raw) return newRecord(params.name || 'workflow-copy', selectApiGraph(raw), { type: 'workflow' }, agentInfo);
    throw new Error('clone requires source workflow_id, image path, JSON path, or workflow object');
}

function buildWorkflow(params, agentInfo, deps) {
    if (params.workflow || params.nodes) return newRecord(params.name || 'workflow', selectApiGraph(params.workflow || params.nodes), { type: 'raw_graph' }, agentInfo);
    const template = String(params.template || 'txt2img').toLowerCase();
    if (template !== 'txt2img') throw new Error(`Unknown workflow template: ${template}`);
    return newRecord(params.name || 'workflow', deps.buildTxt2ImgWorkflow(params.template_params || {}).workflow, { type: 'template', template }, agentInfo);
}

function inputSchema() {
    return {
        type: 'object',
        properties: {
            action: { type: 'string', enum: ['reference_generate', 'build', 'clone', 'copy', 'inspect', 'edit', 'validate', 'execute'], description: 'Use reference_generate for a one-call clone, prompt edit, validation, and execution; other values expose individual workflow operations' },
            workflow_id: { type: 'string', description: 'Stored workflow identifier' },
            name: { type: 'string', description: 'Name for a built or cloned workflow' },
            workflow: { type: 'object', description: 'Any API-format node graph or object containing prompt' },
            nodes: { type: 'object', description: 'Alias for a raw API-format graph' },
            template: { type: 'string', description: 'Optional simple build template: txt2img' },
            template_params: { type: 'object', description: 'Parameters for a simple template build' },
            source: {
                type: 'object',
                description: 'Clone source: image, json, workflow_id, or workflow',
                properties: {
                    type: { type: 'string', enum: ['image', 'json', 'workflow_id', 'workflow'] },
                    path: { type: 'string' },
                    workflow_id: { type: 'string' },
                    workflow: { type: 'object' }
                }
            },
            image_path: { type: 'string', description: 'PNG containing metadata.prompt' },
            positive_prompt: { type: 'string', description: 'Complete replacement positive prompt for reference_generate' },
            negative_prompt: { type: 'string', description: 'Optional complete replacement negative prompt for reference_generate; omitted preserves the reference negative prompt' },
            seed: { type: 'integer', description: 'Optional seed applied to sampler nodes during reference_generate' },
            filename_prefix: { type: 'string', description: 'Optional output filename prefix for reference_generate; omitted preserves the reference workflow output location and prefix' },
            json_path: { type: 'string', description: 'JSON file containing an API graph or prompt' },
            source_workflow_id: { type: 'string', description: 'Existing workflow to copy' },
            updates: {
                type: 'array',
                description: 'Generic graph edits',
                items: {
                    type: 'object',
                    properties: {
                        op: { type: 'string', enum: ['add', 'replace', 'remove', 'test'] },
                        node_id: { type: 'string' },
                        input: { type: 'string' },
                        path: { type: 'string' },
                        json_path: { type: 'string' },
                        value: {}
                    }
                }
            },
            node_id: { type: 'string', description: 'Inspect one full node' },
            full: { type: 'boolean', description: 'Include the full graph during inspect' },
            check_server: { type: 'boolean', description: 'Validate classes and required inputs through ComfyUI' },
            allow_model_changes: { type: 'boolean', description: 'Allow checkpoint or LoRA changes in an image-derived reference workflow only when explicitly requested by the user' },
            timeout: { type: 'number', description: 'Execution timeout in milliseconds' }
        },
        required: ['action']
    };
}

function registerWorkflowTool(context, deps) {
    context.registerHandler('workflow', {
        description: 'Generate from a reference PNG in one call, or build, clone/copy, inspect, edit, validate, and execute arbitrary ComfyUI API workflows. reference_generate preserves metadata.prompt, changes its connected text prompt nodes, validates it live, and executes it.',
        executionTimeoutMs: 300000,
        timeoutParameter: 'timeout',
        inputSchema: inputSchema()
    }, async params => {
        const action = String(params.action || '').toLowerCase();
        const agentInfo = params?._agentInfo || null;
        if (action === 'reference_generate') {
            return referenceGenerate(params, agentInfo, context, deps);
        }
        if (action === 'build') {
            const record = buildWorkflow(params, agentInfo, deps);
            return { success: true, action, ...summary(record), validation: validateGraph(record.workflow) };
        }
        if (action === 'clone' || action === 'copy') {
            const record = await cloneWorkflow(params, agentInfo, context, deps);
            return { success: true, action, ...summary(record), validation: validateGraph(record.workflow) };
        }
        const record = loadRecord(params.workflow_id, agentInfo);
        if (action === 'inspect') return { success: true, action, ...inspect(record, params) };
        if (action === 'edit') return { success: true, action, ...edit(record, params, agentInfo) };
        if (action === 'validate') {
            const result = await validate(record, params, context, deps);
            return { success: result.valid, action, ...result };
        }
        if (action === 'execute') {
            const validation = await validate(record, { ...params, check_server: true }, context, deps);
            if (!validation.valid) return { success: false, action, error: 'Workflow validation failed', validation };
            const result = await deps.handleGenerate({ workflow: clone(record.workflow), timeout: params.timeout }, context);
            return { ...result, action, workflow_id: record.id, revision: record.revision, workflow_hash: workflowHash(record.workflow), validation };
        }
        throw new Error(`Unsupported workflow action: ${action}`);
    });
}

module.exports = { applyUpdate, inputSchema, looksLikeApiGraph, registerWorkflowTool, selectApiGraph, validateGraph, workflowHash };
