const fs = require('fs');
const path = require('path');
const { css, renderPanelView } = require('./writing-studio-ui');

const PROJECT_TYPES = new Set(['book', 'article', 'notes']);
const DONE_STATUSES = new Set(['draft', 'complete', 'final']);
const projectState = new Map();

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function slug(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60) || `item-${Date.now()}`;
}

function readJson(filePath, fallback = null) {
    try {
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        }
    } catch (_) {}
    return fallback;
}

function writeJson(filePath, data) {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function listJsonFiles(dirPath) {
    if (!fs.existsSync(dirPath)) return [];
    return fs.readdirSync(dirPath)
        .filter((fileName) => fileName.endsWith('.json'))
        .map((fileName) => {
            const data = readJson(path.join(dirPath, fileName));
            return data ? { ...data, _file: fileName } : null;
        })
        .filter(Boolean);
}

function normalizeProjectType(value) {
    const type = String(value || 'book').trim().toLowerCase();
    return PROJECT_TYPES.has(type) ? type : 'book';
}

function projectTypeLabel(value) {
    const type = normalizeProjectType(value);
    if (type === 'article') return 'Article';
    if (type === 'notes') return 'Notes';
    return 'Book';
}

function itemSingular(type) {
    const kind = normalizeProjectType(type);
    if (kind === 'article') return 'section';
    if (kind === 'notes') return 'entry';
    return 'chapter';
}

function itemPlural(type) {
    const kind = normalizeProjectType(type);
    if (kind === 'article') return 'sections';
    if (kind === 'notes') return 'entries';
    return 'chapters';
}

function emptySummary(type) {
    const kind = normalizeProjectType(type);
    if (kind === 'article') {
        return 'No article structure yet. Send angle, audience, sections, and target length.';
    }
    if (kind === 'notes') {
        return 'No notes structure yet. Send topics, fragments, tags, and what to expand.';
    }
    return 'No outline yet. Send premise, genre, characters, and target length.';
}

function draftPrefix(type) {
    const kind = normalizeProjectType(type);
    if (kind === 'article') return 'section';
    if (kind === 'notes') return 'entry';
    return 'chapter';
}

function compileSuffix(type) {
    const kind = normalizeProjectType(type);
    if (kind === 'article') return 'article';
    if (kind === 'notes') return 'notes';
    return 'manuscript';
}

function capitalize(text) {
    const value = String(text || '');
    return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function getStateFile(agentInfo) {
    return agentInfo?.folderPath ? path.join(agentInfo.folderPath, 'tasks', 'book-writer-state.json') : '';
}

function getState(agentInfo) {
    const key = String(agentInfo?.id || agentInfo?.slug || 'default');
    if (!projectState.has(key)) {
        const stateFile = getStateFile(agentInfo);
        const saved = stateFile ? readJson(stateFile, null) : null;
        projectState.set(key, { activeProject: saved?.activeProject || 'default' });
    }
    return projectState.get(key);
}

function persistState(agentInfo) {
    const stateFile = getStateFile(agentInfo);
    if (!stateFile) return;
    writeJson(stateFile, getState(agentInfo));
}

function getProjectsRoot(home) {
    return path.join(home, 'tasks', 'elements');
}

function getProjectMetaFile(home, projectSlug) {
    return path.join(getProjectsRoot(home), projectSlug, '_project.json');
}

function readProjectMeta(home, projectSlug) {
    const saved = readJson(getProjectMetaFile(home, projectSlug), null);
    return {
        name: saved?.name || projectSlug,
        slug: saved?.slug || projectSlug,
        type: normalizeProjectType(saved?.type),
        description: String(saved?.description || ''),
        voice: String(saved?.voice || ''),
        audience: String(saved?.audience || ''),
        createdAt: saved?.createdAt || new Date().toISOString(),
        updatedAt: saved?.updatedAt || saved?.createdAt || new Date().toISOString()
    };
}

function ensureProjectMeta(home, projectSlug, patch = {}) {
    const current = readProjectMeta(home, projectSlug);
    const meta = {
        ...current,
        ...patch,
        slug: projectSlug,
        type: normalizeProjectType(patch.type || patch.projectType || current.type),
        updatedAt: new Date().toISOString()
    };
    writeJson(getProjectMetaFile(home, projectSlug), meta);
    return meta;
}

function ensureDefaultProject(agentInfo) {
    const home = agentInfo?.folderPath || '';
    const projectsRoot = getProjectsRoot(home);
    ensureDir(projectsRoot);
    if (!fs.existsSync(path.join(projectsRoot, 'default'))) {
        ensureDir(path.join(projectsRoot, 'default'));
        ensureDir(path.join(home, 'outputs', 'default', 'drafts'));
        ensureProjectMeta(home, 'default', { name: 'default', type: 'book' });
    } else if (!fs.existsSync(getProjectMetaFile(home, 'default'))) {
        ensureProjectMeta(home, 'default', { name: 'default', type: 'book' });
    }
}

function resolveProjectPaths(agentInfo) {
    const state = getState(agentInfo);
    const home = agentInfo?.folderPath || '';
    const project = state.activeProject || 'default';
    const projectMeta = readProjectMeta(home, project);
    const projectType = normalizeProjectType(projectMeta.type);
    const elementsDir = path.join(home, 'tasks', 'elements', project);
    const outlinesDir = path.join(home, 'tasks', 'outlines');
    const outputsDir = path.join(home, 'outputs', project);
    const draftsDir = path.join(outputsDir, 'drafts');
    return { home, project, projectMeta, projectType, elementsDir, outlinesDir, outputsDir, draftsDir };
}

function listProjects(agentInfo) {
    ensureDefaultProject(agentInfo);
    const home = agentInfo?.folderPath || '';
    const state = getState(agentInfo);
    const projectsRoot = getProjectsRoot(home);
    const projects = [];
    if (fs.existsSync(projectsRoot)) {
        for (const entry of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const meta = readProjectMeta(home, entry.name);
            const elementCount = listJsonFiles(path.join(projectsRoot, entry.name))
                .filter((item) => !item._file?.startsWith('_'))
                .length;
            projects.push({ ...meta, elementCount, active: entry.name === state.activeProject });
        }
    }
    projects.sort((a, b) => String(a.name || a.slug).localeCompare(String(b.name || b.slug)));
    return projects;
}

function getStructureFile(paths) {
    return path.join(paths.outlinesDir, `${paths.project}.json`);
}

function normalizeItem(projectType, raw = {}, fallbackNumber = 1) {
    const number = Number(raw.number || raw.index || raw.position || fallbackNumber) || fallbackNumber;
    const item = {
        number,
        title: String(raw.title || `${capitalize(itemSingular(projectType))} ${number}`).trim() || `${capitalize(itemSingular(projectType))} ${number}`,
        summary: String(raw.summary || '').trim(),
        status: String(raw.status || 'planned').trim() || 'planned',
        notes: String(raw.notes || '').trim(),
        tags: Array.isArray(raw.tags) ? raw.tags : (Array.isArray(raw.keywords) ? raw.keywords : [])
    };
    if (normalizeProjectType(projectType) === 'book') {
        item.characters = Array.isArray(raw.characters) ? raw.characters : [];
        item.locations = Array.isArray(raw.locations) ? raw.locations : [];
        item.plotPoints = Array.isArray(raw.plotPoints) ? raw.plotPoints : (Array.isArray(raw.plot_points) ? raw.plot_points : []);
    }
    if (normalizeProjectType(projectType) === 'article') {
        item.angle = String(raw.angle || '').trim();
        item.sources = Array.isArray(raw.sources) ? raw.sources : [];
    }
    if (normalizeProjectType(projectType) === 'notes') {
        item.focus = String(raw.focus || '').trim();
    }
    return item;
}

function materializeStructure(paths, input = {}) {
    const items = Array.isArray(input.items)
        ? input.items.map((item, index) => normalizeItem(paths.projectType, item, index + 1))
        : [];
    const structure = {
        title: String(input.title || paths.projectMeta.name || paths.project).trim() || paths.project,
        project: paths.project,
        projectType: paths.projectType,
        items,
        createdAt: input.createdAt || new Date().toISOString(),
        updatedAt: input.updatedAt || new Date().toISOString()
    };
    if (paths.projectType === 'book') structure.chapters = items;
    if (paths.projectType === 'article') structure.sections = items;
    if (paths.projectType === 'notes') structure.entries = items;
    return structure;
}

function readStructure(paths) {
    const saved = readJson(getStructureFile(paths), null);
    if (!saved) return null;
    const items = Array.isArray(saved.items)
        ? saved.items
        : Array.isArray(saved.chapters)
            ? saved.chapters
            : Array.isArray(saved.sections)
                ? saved.sections
                : Array.isArray(saved.entries)
                    ? saved.entries
                    : [];
    return materializeStructure(paths, {
        title: saved.title,
        items,
        createdAt: saved.createdAt,
        updatedAt: saved.updatedAt
    });
}

function writeStructure(paths, structure) {
    const next = materializeStructure(paths, {
        title: structure.title,
        items: structure.items,
        createdAt: structure.createdAt,
        updatedAt: structure.updatedAt || new Date().toISOString()
    });
    writeJson(getStructureFile(paths), next);
    return next;
}

function listRequestedItems(params = {}) {
    if (Array.isArray(params.items)) return params.items;
    if (Array.isArray(params.chapters)) return params.chapters;
    if (Array.isArray(params.sections)) return params.sections;
    if (Array.isArray(params.entries)) return params.entries;
    return [];
}

function handleProject(params, agentInfo) {
    const action = String(params.action || 'list').toLowerCase();
    const state = getState(agentInfo);
    const home = agentInfo?.folderPath || '';
    const projectsRoot = getProjectsRoot(home);
    ensureDir(projectsRoot);
    ensureDefaultProject(agentInfo);

    if (action === 'create') {
        const name = String(params.name || '').trim();
        if (!name) return { error: 'Project name is required' };
        const projectSlug = slug(name);
        const projectType = normalizeProjectType(params.type || params.projectType || params.mode);
        ensureDir(path.join(projectsRoot, projectSlug));
        ensureDir(path.join(home, 'outputs', projectSlug, 'drafts'));
        const meta = ensureProjectMeta(home, projectSlug, {
            name,
            type: projectType,
            description: params.description || '',
            voice: params.voice || '',
            audience: params.audience || '',
            createdAt: new Date().toISOString()
        });
        state.activeProject = projectSlug;
        persistState(agentInfo);
        return { success: true, project: meta, message: `Created and switched to ${projectTypeLabel(projectType).toLowerCase()} project "${name}"` };
    }

    if (action === 'switch') {
        const target = slug(params.name || params.project || '');
        if (!target) return { error: 'Project name is required' };
        if (!fs.existsSync(path.join(projectsRoot, target))) {
            return { error: `Project "${target}" not found` };
        }
        state.activeProject = target;
        persistState(agentInfo);
        return { success: true, activeProject: target, project: readProjectMeta(home, target) };
    }

    if (action === 'list') {
        const projects = listProjects(agentInfo);
        return {
            success: true,
            projects,
            activeProject: state.activeProject,
            activeMeta: readProjectMeta(home, state.activeProject || 'default')
        };
    }

    return { error: `Unknown action: ${action}. Use: create, switch, list` };
}

function handleElement(params, agentInfo) {
    const action = String(params.action || 'list').toLowerCase();
    const paths = resolveProjectPaths(agentInfo);
    ensureDir(paths.elementsDir);

    if (action === 'create') {
        const type = String(params.type || 'note').toLowerCase();
        const name = String(params.name || '').trim();
        const content = String(params.content || '').trim();
        if (!name) return { error: 'Element name is required' };
        const elementSlug = slug(name);
        const element = {
            id: elementSlug,
            type,
            name,
            content,
            tags: Array.isArray(params.tags) ? params.tags : [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        writeJson(path.join(paths.elementsDir, `${elementSlug}.json`), element);
        return { success: true, element, message: `Created ${type} "${name}"` };
    }

    if (action === 'update') {
        const id = slug(params.id || params.name || '');
        const filePath = path.join(paths.elementsDir, `${id}.json`);
        const existing = readJson(filePath);
        if (!existing) return { error: `Element "${id}" not found` };
        if (params.name) existing.name = params.name;
        if (params.content) existing.content = params.content;
        if (params.type) existing.type = params.type;
        if (params.tags) existing.tags = params.tags;
        existing.updatedAt = new Date().toISOString();
        writeJson(filePath, existing);
        return { success: true, element: existing };
    }

    if (action === 'get') {
        const id = slug(params.id || params.name || '');
        const element = readJson(path.join(paths.elementsDir, `${id}.json`));
        if (!element) return { error: `Element "${id}" not found` };
        return { success: true, element };
    }

    if (action === 'delete') {
        const id = slug(params.id || params.name || '');
        const filePath = path.join(paths.elementsDir, `${id}.json`);
        if (!fs.existsSync(filePath)) return { error: `Element "${id}" not found` };
        fs.unlinkSync(filePath);
        return { success: true, message: `Deleted element "${id}"` };
    }

    if (action === 'list') {
        const typeFilter = params.type ? String(params.type).toLowerCase() : null;
        let elements = listJsonFiles(paths.elementsDir).filter((item) => !item._file?.startsWith('_'));
        if (typeFilter) {
            elements = elements.filter((item) => item.type === typeFilter);
        }
        return {
            success: true,
            project: paths.project,
            projectType: paths.projectType,
            count: elements.length,
            elements: elements.map((item) => ({ id: item.id, type: item.type, name: item.name, tags: item.tags || [] }))
        };
    }

    return { error: `Unknown action: ${action}. Use: create, update, get, delete, list` };
}

function handleOutline(params, agentInfo) {
    const action = String(params.action || 'get').toLowerCase();
    const paths = resolveProjectPaths(agentInfo);
    ensureDir(paths.outlinesDir);

    if (action === 'create' || action === 'set') {
        const structure = materializeStructure(paths, {
            title: String(params.title || paths.projectMeta.name || paths.project),
            items: listRequestedItems(params),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        });
        writeStructure(paths, structure);
        return {
            success: true,
            outline: structure,
            projectType: paths.projectType,
            message: `${capitalize(projectTypeLabel(paths.projectType))} structure created with ${structure.items.length} ${itemPlural(paths.projectType)}`
        };
    }

    if (action === 'add_chapter') {
        const structure = readStructure(paths);
        if (!structure) return { error: 'No structure exists. Create one first with action:"create"' };
        const item = normalizeItem(paths.projectType, params, structure.items.length + 1);
        structure.items.push(item);
        structure.updatedAt = new Date().toISOString();
        writeStructure(paths, structure);
        return { success: true, item, totalItems: structure.items.length };
    }

    if (action === 'update_chapter') {
        const structure = readStructure(paths);
        if (!structure) return { error: 'No structure exists' };
        const number = Number(params.number || params.chapter_number);
        const item = structure.items.find((entry) => entry.number === number);
        if (!item) return { error: `${capitalize(itemSingular(paths.projectType))} ${number} not found` };
        Object.assign(item, normalizeItem(paths.projectType, { ...item, ...params, number: item.number }, item.number));
        structure.updatedAt = new Date().toISOString();
        writeStructure(paths, structure);
        return { success: true, item };
    }

    if (action === 'reorder') {
        const structure = readStructure(paths);
        if (!structure) return { error: 'No structure exists' };
        const order = params.order;
        if (!Array.isArray(order)) return { error: 'order must be an array of item numbers' };
        const byNumber = new Map(structure.items.map((item) => [item.number, item]));
        const reordered = [];
        for (const num of order) {
            const item = byNumber.get(num);
            if (item) reordered.push(item);
        }
        for (const item of structure.items) {
            if (!reordered.includes(item)) reordered.push(item);
        }
        reordered.forEach((item, index) => {
            item.number = index + 1;
        });
        structure.items = reordered;
        structure.updatedAt = new Date().toISOString();
        writeStructure(paths, structure);
        return { success: true, items: structure.items.map((item) => ({ number: item.number, title: item.title })) };
    }

    if (action === 'get') {
        const structure = readStructure(paths);
        if (!structure) return { error: 'No structure exists for this project. Create one with action:"create"' };
        return { success: true, outline: structure, projectType: paths.projectType };
    }

    return { error: `Unknown action: ${action}. Use: create, set, add_chapter, update_chapter, reorder, get` };
}

function pickElementsByType(elements, allowedTypes = []) {
    const typeSet = new Set(allowedTypes.map((value) => String(value).toLowerCase()));
    return elements.filter((element) => typeSet.has(String(element.type || '').toLowerCase()));
}

function pickElementsByName(elements, allowedTypes = [], names = []) {
    const values = names.map((value) => String(value).toLowerCase());
    return pickElementsByType(elements, allowedTypes)
        .filter((element) => values.includes(String(element.name || element.id || '').toLowerCase()));
}

function buildGenerationContext(paths, structure, item, params) {
    const elements = listJsonFiles(paths.elementsDir).filter((entry) => !entry._file?.startsWith('_'));
    const base = {
        projectType: paths.projectType,
        projectTitle: structure.title,
        item,
        previousItem: item.number > 1 ? structure.items.find((entry) => entry.number === item.number - 1) || null : null,
        nextItem: structure.items.find((entry) => entry.number === item.number + 1) || null,
        userInstructions: String(params.instructions || '').trim(),
        elements: elements.map((entry) => ({ type: entry.type, name: entry.name, details: entry.content }))
    };

    if (paths.projectType === 'book') {
        return {
            ...base,
            characters: pickElementsByName(elements, ['character'], item.characters || []).map((entry) => ({ name: entry.name, details: entry.content })),
            locations: pickElementsByName(elements, ['location'], item.locations || []).map((entry) => ({ name: entry.name, details: entry.content })),
            themes: pickElementsByType(elements, ['theme', 'worldbuilding']).map((entry) => ({ name: entry.name, details: entry.content }))
        };
    }

    if (paths.projectType === 'article') {
        return {
            ...base,
            angles: pickElementsByType(elements, ['angle', 'theme']).map((entry) => ({ name: entry.name, details: entry.content })),
            notes: pickElementsByType(elements, ['note', 'inspiration']).map((entry) => ({ name: entry.name, details: entry.content })),
            sources: pickElementsByType(elements, ['source', 'reference', 'link']).map((entry) => ({ name: entry.name, details: entry.content }))
        };
    }

    return {
        ...base,
        notes: pickElementsByType(elements, ['note', 'inspiration', 'reference', 'worldbuilding']).map((entry) => ({ name: entry.name, details: entry.content }))
    };
}

function buildDraftScaffold(paths, item) {
    const label = capitalize(itemSingular(paths.projectType));
    if (paths.projectType === 'article') {
        return [
            `## ${item.title}`,
            '',
            `<!-- ${label} ${item.number} scaffold generated ${new Date().toISOString()} -->`,
            '',
            `Summary: ${item.summary || 'Add section summary.'}`,
            '',
            'Draft:',
            '',
            ''
        ].join('\n');
    }
    if (paths.projectType === 'notes') {
        return [
            `## ${item.title}`,
            '',
            `<!-- ${label} ${item.number} scaffold generated ${new Date().toISOString()} -->`,
            '',
            `Focus: ${item.focus || item.summary || 'Expand the note.'}`,
            '',
            'Notes:',
            '',
            ''
        ].join('\n');
    }
    return [
        `# ${item.title}`,
        '',
        `<!-- ${label} ${item.number} scaffold generated ${new Date().toISOString()} -->`,
        '',
        `Summary: ${item.summary || 'Add chapter summary.'}`,
        '',
        '## Draft',
        '',
        ''
    ].join('\n');
}

function buildDraftInstruction(paths, structure, item, outputPath) {
    const label = itemSingular(paths.projectType);
    if (paths.projectType === 'article') {
        return `Write ${label} ${item.number}: "${item.title}" for the article "${structure.title}". Save the publishable section text to: ${outputPath}. After writing, update the ${label} status to "draft" using the outline tool.`;
    }
    if (paths.projectType === 'notes') {
        return `Expand ${label} ${item.number}: "${item.title}" into clean structured notes. Save the note text to: ${outputPath}. After writing, update the ${label} status to "draft" using the outline tool.`;
    }
    return `Write ${label} ${item.number}: "${item.title}" using the provided context. Save the full chapter text to: ${outputPath}. After writing, update the ${label} status to "draft" using the outline tool.`;
}

function handleGenerate(params, agentInfo) {
    const paths = resolveProjectPaths(agentInfo);
    const structure = readStructure(paths);
    if (!structure) return { error: 'No structure exists. Create a structure first.' };

    const requestedNumber = Number(params.chapter_number || params.number);
    const item = Number.isFinite(requestedNumber)
        ? structure.items.find((entry) => entry.number === requestedNumber)
        : structure.items.find((entry) => !DONE_STATUSES.has(String(entry.status || 'planned'))) || structure.items[0];
    if (!item) {
        return {
            error: Number.isFinite(requestedNumber)
                ? `${capitalize(itemSingular(paths.projectType))} ${requestedNumber} not found`
                : 'No structure items found'
        };
    }

    const context = buildGenerationContext(paths, structure, item, params);
    ensureDir(paths.draftsDir);
    const outputPath = path.join(paths.draftsDir, `${draftPrefix(paths.projectType)}-${String(item.number).padStart(2, '0')}.md`);
    if (!fs.existsSync(outputPath)) {
        fs.writeFileSync(outputPath, buildDraftScaffold(paths, item), 'utf-8');
    }

    item.status = 'in_progress';
    structure.updatedAt = new Date().toISOString();
    writeStructure(paths, structure);

    return {
        success: true,
        projectType: paths.projectType,
        message: `${capitalize(itemSingular(paths.projectType))} ${item.number} scaffold is ready. Continue the draft in the output file below.`,
        outputPath,
        context,
        instruction: buildDraftInstruction(paths, structure, item, outputPath)
    };
}

function compileBookDraft(structure, draftFiles, draftsDir) {
    let content = `# ${structure.title}\n\n`;
    content += `*Compiled on ${new Date().toLocaleDateString()}*\n\n`;
    content += `---\n\n## Table of Contents\n\n`;
    const titles = [];
    for (const file of draftFiles) {
        const draftContent = fs.readFileSync(path.join(draftsDir, file), 'utf-8');
        const match = draftContent.match(/^#\s+(.+)/m);
        const title = match ? match[1] : file.replace(/\.md$/, '');
        titles.push(title);
        content += `- ${title}\n`;
    }
    content += `\n---\n\n`;
    for (const file of draftFiles) {
        content += fs.readFileSync(path.join(draftsDir, file), 'utf-8');
        content += `\n\n---\n\n`;
    }
    return { content, titles };
}

function compileArticleDraft(structure, draftFiles, draftsDir) {
    let content = `# ${structure.title}\n\n`;
    content += `*Article draft compiled on ${new Date().toLocaleDateString()}*\n\n`;
    for (const file of draftFiles) {
        content += fs.readFileSync(path.join(draftsDir, file), 'utf-8').trim();
        content += `\n\n`;
    }
    return { content, titles: draftFiles.map((file) => file.replace(/\.md$/, '')) };
}

function compileNotesBundle(structure, draftFiles, draftsDir) {
    let content = `# ${structure.title}\n\n`;
    content += `*Notes bundle compiled on ${new Date().toLocaleDateString()}*\n\n## Index\n\n`;
    const titles = [];
    for (const file of draftFiles) {
        const draftContent = fs.readFileSync(path.join(draftsDir, file), 'utf-8');
        const match = draftContent.match(/^##\s+(.+)/m);
        const title = match ? match[1] : file.replace(/\.md$/, '');
        titles.push(title);
        content += `- ${title}\n`;
    }
    content += `\n---\n\n`;
    for (const file of draftFiles) {
        content += fs.readFileSync(path.join(draftsDir, file), 'utf-8').trim();
        content += `\n\n`;
    }
    return { content, titles };
}

function handleCompile(params, agentInfo) {
    const paths = resolveProjectPaths(agentInfo);
    const structure = readStructure(paths) || materializeStructure(paths, {
        title: paths.projectMeta.name || paths.project,
        items: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    });

    ensureDir(paths.draftsDir);
    const draftFiles = fs.existsSync(paths.draftsDir)
        ? fs.readdirSync(paths.draftsDir).filter((file) => file.endsWith('.md')).sort()
        : [];
    if (draftFiles.length === 0) {
        return { error: 'No drafts found to compile. Generate draft files first.' };
    }

    const compiled = paths.projectType === 'article'
        ? compileArticleDraft(structure, draftFiles, paths.draftsDir)
        : paths.projectType === 'notes'
            ? compileNotesBundle(structure, draftFiles, paths.draftsDir)
            : compileBookDraft(structure, draftFiles, paths.draftsDir);

    const outputPath = path.join(paths.outputsDir, `${slug(structure.title)}-${compileSuffix(paths.projectType)}.md`);
    fs.writeFileSync(outputPath, compiled.content, 'utf-8');

    return {
        success: true,
        projectType: paths.projectType,
        message: `Compiled ${draftFiles.length} draft file(s) into ${compileSuffix(paths.projectType)}`,
        outputPath,
        items: compiled.titles,
        wordCount: compiled.content.split(/\s+/).filter(Boolean).length
    };
}

function handleStatus(params, agentInfo) {
    const paths = resolveProjectPaths(agentInfo);
    const structure = readStructure(paths);
    const elements = listJsonFiles(paths.elementsDir).filter((item) => !item._file?.startsWith('_'));
    const byType = {};
    for (const element of elements) {
        const type = element.type || 'other';
        byType[type] = (byType[type] || 0) + 1;
    }

    const draftFiles = fs.existsSync(paths.draftsDir)
        ? fs.readdirSync(paths.draftsDir).filter((file) => file.endsWith('.md'))
        : [];
    let totalWords = 0;
    for (const file of draftFiles) {
        const content = fs.readFileSync(path.join(paths.draftsDir, file), 'utf-8');
        totalWords += content.split(/\s+/).filter(Boolean).length;
    }

    const items = structure?.items || [];
    const planned = items.filter((item) => item.status === 'planned').length;
    const inProgress = items.filter((item) => item.status === 'in_progress').length;
    const drafted = items.filter((item) => item.status === 'draft').length;
    const complete = items.filter((item) => item.status === 'complete' || item.status === 'final').length;

    return {
        success: true,
        project: paths.project,
        projectType: paths.projectType,
        projectMeta: paths.projectMeta,
        title: structure?.title || paths.projectMeta.name || paths.project,
        elements: { total: elements.length, byType },
        structure: {
            exists: Boolean(structure),
            totalItems: items.length,
            planned,
            inProgress,
            drafted,
            complete
        },
        outline: {
            exists: Boolean(structure),
            totalChapters: items.length,
            planned,
            inProgress,
            drafted,
            complete
        },
        drafts: {
            filesWritten: draftFiles.length,
            totalWords
        },
        manuscript: {
            chaptersWritten: draftFiles.length,
            totalWords
        }
    };
}

function renderPanel(agentInfo) {
    const projectsResult = handleProject({ action: 'list' }, agentInfo);
    const status = handleStatus({}, agentInfo);
    const paths = resolveProjectPaths(agentInfo);
    const structure = readStructure(paths);
    const nextItem = (structure?.items || []).find((item) => !DONE_STATUSES.has(String(item.status || 'planned'))) || (structure?.items || [])[0] || null;
    const progress = status.structure.totalItems > 0
        ? Math.round(((status.structure.drafted + status.structure.complete) / status.structure.totalItems) * 100)
        : 0;

    return renderPanelView({
        projects: projectsResult.projects || [],
        status,
        nextItem,
        progress
    });
}

module.exports = {
    onEnable(context) {
        context.registerHandler('project', {
            description: 'Manage writing projects. Actions: create (name, type), switch (name), list.',
            inputSchema: {
                type: 'object',
                properties: {
                    action: { type: 'string', description: 'create | switch | list', enum: ['create', 'switch', 'list'] },
                    name: { type: 'string', description: 'Project name (for create/switch)' },
                    type: { type: 'string', description: 'Project type: book, article, notes', enum: ['book', 'article', 'notes'] },
                    description: { type: 'string', description: 'Optional short project brief' },
                    voice: { type: 'string', description: 'Optional voice/style note' },
                    audience: { type: 'string', description: 'Optional audience note' }
                },
                required: ['action']
            }
        }, (params) => handleProject(params, params._agentInfo || {}));

        context.registerHandler('element', {
            description: 'CRUD writing elements: characters, locations, plot_points, themes, worldbuilding, notes, inspirations, sources, angles, references. Actions: create, update, get, delete, list.',
            inputSchema: {
                type: 'object',
                properties: {
                    action: { type: 'string', description: 'create | update | get | delete | list', enum: ['create', 'update', 'get', 'delete', 'list'] },
                    type: { type: 'string', description: 'Element type' },
                    name: { type: 'string', description: 'Element name' },
                    id: { type: 'string', description: 'Element ID (for update/get/delete)' },
                    content: { type: 'string', description: 'Element content / description' },
                    tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' }
                },
                required: ['action']
            }
        }, (params) => handleElement(params, params._agentInfo || {}));

        context.registerHandler('outline', {
            description: 'Manage the current project structure. Books use chapters, articles use sections, notes use entries. Actions: create/set, add_chapter, update_chapter, reorder, get.',
            inputSchema: {
                type: 'object',
                properties: {
                    action: { type: 'string', description: 'create | set | add_chapter | update_chapter | reorder | get', enum: ['create', 'set', 'add_chapter', 'update_chapter', 'reorder', 'get'] },
                    title: { type: 'string', description: 'Project title or item title' },
                    items: { type: 'array', description: 'Generic structure items' },
                    chapters: { type: 'array', description: 'Book chapter items (legacy)' },
                    sections: { type: 'array', description: 'Article sections' },
                    entries: { type: 'array', description: 'Notes entries' },
                    number: { type: 'number', description: 'Item number (for update_chapter)' },
                    chapter_number: { type: 'number', description: 'Item number alias' },
                    summary: { type: 'string', description: 'Item summary' },
                    characters: { type: 'array', items: { type: 'string' }, description: 'Book characters for this item' },
                    locations: { type: 'array', items: { type: 'string' }, description: 'Book locations for this item' },
                    plotPoints: { type: 'array', items: { type: 'string' }, description: 'Book plot points to resolve' },
                    plot_points: { type: 'array', items: { type: 'string' }, description: 'Book plot points alias' },
                    status: { type: 'string', description: 'planned, in_progress, draft, complete, final' },
                    notes: { type: 'string', description: 'Additional notes' },
                    angle: { type: 'string', description: 'Article angle' },
                    sources: { type: 'array', items: { type: 'string' }, description: 'Article source names' },
                    focus: { type: 'string', description: 'Notes focus' },
                    order: { type: 'array', items: { type: 'number' }, description: 'New item order' }
                },
                required: ['action']
            }
        }, (params) => handleOutline(params, params._agentInfo || {}));

        context.registerHandler('generate', {
            description: 'Prepare context for generating the next draft item from the current structure. Returns writing instructions and an output path.',
            inputSchema: {
                type: 'object',
                properties: {
                    chapter_number: { type: 'number', description: 'Item number to draft' },
                    number: { type: 'number', description: 'Item number alias' },
                    instructions: { type: 'string', description: 'Additional writing instructions for this draft item' }
                },
                required: []
            }
        }, (params) => handleGenerate(params, params._agentInfo || {}));

        context.registerHandler('compile', {
            description: 'Compile current draft files into a manuscript, article draft, or notes bundle depending on project type.',
            inputSchema: {
                type: 'object',
                properties: {},
                required: []
            }
        }, (params) => handleCompile(params, params._agentInfo || {}));

        context.registerHandler('status', {
            description: 'Show current writing project status: element counts, structure progress, and total draft word count.',
            inputSchema: {
                type: 'object',
                properties: {},
                required: []
            }
        }, (params) => handleStatus(params, params._agentInfo || {}));

        context.registerChatUI({
            title: 'Writing Studio',
            renderPanel,
            css,
            actions: {
                refresh({ agentInfo }) {
                    return { success: true, html: renderPanel(agentInfo), css };
                },
                'create-project'({ agentInfo, payload }) {
                    const name = String(payload?.name || '').trim();
                    if (name) {
                        handleProject({ action: 'create', name, type: payload?.type || 'book' }, agentInfo);
                    }
                    return { success: true, html: renderPanel(agentInfo), css };
                },
                'switch-project'({ agentInfo, payload }) {
                    const project = String(payload?.project || '').trim();
                    if (project) {
                        handleProject({ action: 'switch', project }, agentInfo);
                    }
                    return { success: true, html: renderPanel(agentInfo), css };
                },
                'generate-next'({ agentInfo }) {
                    handleGenerate({}, agentInfo);
                    return { success: true, html: renderPanel(agentInfo), css };
                },
                'compile-project'({ agentInfo }) {
                    handleCompile({}, agentInfo);
                    return { success: true, html: renderPanel(agentInfo), css };
                },
                'compile-book'({ agentInfo }) {
                    handleCompile({}, agentInfo);
                    return { success: true, html: renderPanel(agentInfo), css };
                }
            },
            onTabActivated(agentInfo, payload, pluginContext) {
                pluginContext.log(`Writing Studio active for ${agentInfo.name}`);
            }
        });

        context.log('Writing Studio registered');
    },

    onDisable(context) {
        projectState.clear();
        context.log('Writing Studio disabled');
    }
};

