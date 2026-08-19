function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function normalizeProjectType(value) {
    const type = String(value || 'book').trim().toLowerCase();
    return ['book', 'article', 'notes'].includes(type) ? type : 'book';
}

function projectTypeLabel(value) {
    const type = normalizeProjectType(value);
    if (type === 'article') return 'Article';
    if (type === 'notes') return 'Notes';
    return 'Book';
}

function itemPlural(value) {
    const type = normalizeProjectType(value);
    if (type === 'article') return 'sections';
    if (type === 'notes') return 'entries';
    return 'chapters';
}

function emptySummary(value) {
    const type = normalizeProjectType(value);
    if (type === 'article') {
        return 'No article structure yet. Send angle, audience, sections, and target length.';
    }
    if (type === 'notes') {
        return 'No notes structure yet. Send topics, fragments, tags, and what to expand.';
    }
    return 'No outline yet. Send premise, genre, characters, and target length.';
}

function renderProjectOptions(projects, activeProject) {
    return projects.map((project) => {
        const selected = project.slug === activeProject ? ' selected' : '';
        return `<option value="${escapeHtml(project.slug)}"${selected}>${escapeHtml(project.name)} · ${escapeHtml(projectTypeLabel(project.type))}</option>`;
    }).join('');
}

function renderTypeOptions(selectedType = 'book') {
    return ['book', 'article', 'notes'].map((type) => {
        const selected = normalizeProjectType(selectedType) === type ? ' selected' : '';
        return `<option value="${type}"${selected}>${escapeHtml(projectTypeLabel(type))}</option>`;
    }).join('');
}

function renderPanelView({ projects = [], status = {}, nextItem = null, progress = 0 }) {
    const summary = status.structure?.exists
        ? `${status.structure.totalItems} ${itemPlural(status.projectType)}${nextItem ? `, next: ${nextItem.number}. ${nextItem.title}` : ''}`
        : emptySummary(status.projectType);

    return `<section class="bw-compact bw-studio">
        <div class="bw-mainline">
            <strong>✍️ Writing Studio</strong>
            <span class="bw-title">${escapeHtml(status.title || '')}</span>
            <span class="bw-project-badge">${escapeHtml(status.project || '')}</span>
            <span class="bw-type-badge">${escapeHtml(projectTypeLabel(status.projectType))}</span>
        </div>
        <div class="bw-metrics">
            <span>${status.elements?.total || 0} elements</span>
            <span>${status.structure?.totalItems || 0} ${itemPlural(status.projectType)}</span>
            <span>${(status.drafts?.totalWords || 0).toLocaleString()} words</span>
            <span>${progress}%</span>
        </div>
        <div class="bw-summary">${escapeHtml(summary)}</div>
        <form class="bw-project-form bw-project-switch" data-agent-ui-action="switch-project">
            <select name="project">${renderProjectOptions(projects, status.project)}</select>
            <button type="submit">Switch</button>
        </form>
        <form class="bw-project-form" data-agent-ui-action="create-project">
            <input name="name" placeholder="New project">
            <select name="type">${renderTypeOptions('book')}</select>
            <button type="submit">New</button>
            <button type="button" data-agent-ui-action="generate-next"${status.structure?.exists ? '' : ' disabled'}>Draft Next</button>
            <button type="button" data-agent-ui-action="compile-project"${(status.drafts?.filesWritten || 0) > 0 ? '' : ' disabled'}>Compile</button>
        </form>
    </section>`;
}

const css = `
.bw-compact {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 10px;
    padding: 7px 10px;
    margin-bottom: 6px;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    background: var(--card-bg);
    font-size: var(--text-sm);
}
.bw-mainline {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: min(100%, 320px);
    flex: 1 1 320px;
}
.bw-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.bw-project-badge,
.bw-type-badge {
    font-size: 11px;
    padding: 1px 7px;
    border-radius: 999px;
    border: 1px solid var(--border-color);
    color: var(--text-secondary);
    background: var(--bg-secondary);
    flex: 0 0 auto;
}
.bw-metrics {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    color: var(--text-secondary);
    font-size: var(--text-xs);
}
.bw-metrics span {
    border: 1px solid var(--border-color);
    border-radius: 999px;
    padding: 1px 7px;
    background: var(--bg-secondary);
}
.bw-summary {
    flex: 1 1 100%;
    color: var(--text-secondary);
    font-size: var(--text-xs);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.bw-project-form {
    display: flex;
    gap: 5px;
    align-items: center;
    flex: 1 1 460px;
    min-width: min(100%, 360px);
}
.bw-project-switch {
    flex: 1 1 240px;
    min-width: min(100%, 220px);
}
.bw-project-form input,
.bw-project-form select {
    min-width: 130px;
    flex: 1 1 170px;
    height: 28px;
    padding: 0 8px;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--input-bg, var(--bg-primary));
    color: var(--text-primary);
}
.bw-project-switch select {
    flex: 1 1 240px;
}
.bw-project-form button {
    border: 1px solid var(--border-color);
    border-radius: 4px;
    background: var(--bg-secondary);
    color: var(--text-primary);
    height: 28px;
    cursor: pointer;
    padding: 0 8px;
    white-space: nowrap;
}
.bw-project-form button:disabled {
    cursor: not-allowed;
    opacity: 0.5;
    color: var(--text-secondary);
}
@media (max-width: 760px) {
    .bw-project-form,
    .bw-mainline {
        flex-basis: 100%;
    }
    .bw-summary {
        white-space: normal;
    }
}
`;

module.exports = {
    css,
    renderPanelView
};
