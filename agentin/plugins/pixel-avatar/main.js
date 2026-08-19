const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const emotionProtocol = require('./emotionProtocol');

/**
 * Pixel Avatar Plugin
 *
 * Registers a sidebar widget that renders the restored pixelanimation avatar.
 * Emotion detection comes from TextReactor; rendering and sprite behavior come
 * from avatar.js plus PNG files in avatars/<character>/<emotion>.png.
 */

const EMOTIONS = [
    'neutral',
    'happy',
    'sad',
    'surprised',
    'thinking',
    'angry',
    'excited',
    'sleepy',
    'staring'
];
const DEFAULT_EMOTION_CONFIG = {
    avatarPreset: 'generated-cat',
    avatarSource: 'generated',
    generatedCharacter: 'cat',
    imageCharacter: 'cat',
    emotionPreset: 'balanced',
    emotionMode: 'hybrid',
    fallbackEmotion: 'neutral',
    autoEmotionThreshold: '2',
    reactionDurationMs: '1800',
    exposeExternalSkill: false
};

function normalizeEmotionConfig(config = {}) {
    const avatarPreset = resolveAvatarPreset(config);
    const emotionPreset = resolveEmotionPreset(config);
    return {
        avatarPreset: avatarPreset.value,
        avatarSource: avatarPreset.avatarSource,
        generatedCharacter: avatarPreset.generatedCharacter,
        imageCharacter: avatarPreset.imageCharacter,
        emotionPreset: emotionPreset.value,
        emotionMode: emotionPreset.emotionMode,
        fallbackEmotion: emotionProtocol.normalizeEmotion(
            emotionPreset.fallbackEmotion || config.fallbackEmotion,
            DEFAULT_EMOTION_CONFIG.fallbackEmotion
        ),
        autoEmotionThreshold: String(emotionPreset.autoEmotionThreshold || config.autoEmotionThreshold || DEFAULT_EMOTION_CONFIG.autoEmotionThreshold),
        reactionDurationMs: String(emotionPreset.reactionDurationMs || config.reactionDurationMs || DEFAULT_EMOTION_CONFIG.reactionDurationMs),
        exposeExternalSkill: isEnabled(config.exposeExternalSkill)
    };
}

function resolveAvatarPreset(config = {}) {
    const preset = String(config.avatarPreset || '').trim().toLowerCase();
    const presets = {
        'generated-cat': {
            value: 'generated-cat',
            avatarSource: 'generated',
            generatedCharacter: 'cat',
            imageCharacter: 'cat'
        },
        'generated-robot': {
            value: 'generated-robot',
            avatarSource: 'generated',
            generatedCharacter: 'robot',
            imageCharacter: 'cat'
        },
        'generated-girl': {
            value: 'generated-girl',
            avatarSource: 'generated',
            generatedCharacter: 'girl',
            imageCharacter: 'cat'
        },
        'pixel-cat': {
            value: 'pixel-cat',
            avatarSource: 'image-batch',
            generatedCharacter: 'cat',
            imageCharacter: 'cat'
        },
        'pixel-default': {
            value: 'pixel-default',
            avatarSource: 'image-batch',
            generatedCharacter: 'cat',
            imageCharacter: 'default'
        }
    };
    if (presets[preset]) return presets[preset];

    const legacySource = String(config.avatarSource || DEFAULT_EMOTION_CONFIG.avatarSource).toLowerCase();
    if (legacySource === 'image-batch') {
        const folder = normalizeFolderName(config.imageCharacter, DEFAULT_EMOTION_CONFIG.imageCharacter);
        return presets[`pixel-${folder}`] || {
            value: `pixel-${folder}`,
            avatarSource: 'image-batch',
            generatedCharacter: 'cat',
            imageCharacter: folder
        };
    }

    const generatedCharacter = normalizeCharacter(
        config.generatedCharacter || config.character,
        DEFAULT_EMOTION_CONFIG.generatedCharacter
    );
    return presets[`generated-${generatedCharacter}`] || presets[DEFAULT_EMOTION_CONFIG.avatarPreset];
}

function resolveEmotionPreset(config = {}) {
    const preset = String(config.emotionPreset || '').trim().toLowerCase();
    const presets = {
        balanced: {
            value: 'balanced',
            emotionMode: 'hybrid',
            fallbackEmotion: 'neutral',
            autoEmotionThreshold: '2',
            reactionDurationMs: '1800'
        },
        expressive: {
            value: 'expressive',
            emotionMode: 'hybrid',
            fallbackEmotion: 'neutral',
            autoEmotionThreshold: '1',
            reactionDurationMs: '2500'
        },
        markers: {
            value: 'markers',
            emotionMode: 'explicit',
            fallbackEmotion: 'neutral',
            autoEmotionThreshold: '2',
            reactionDurationMs: '1800'
        },
        neutral: {
            value: 'neutral',
            emotionMode: 'neutral',
            fallbackEmotion: 'neutral',
            autoEmotionThreshold: '2',
            reactionDurationMs: '1000'
        }
    };
    if (presets[preset]) return presets[preset];
    return {
        value: 'custom',
        emotionMode: String(config.emotionMode || DEFAULT_EMOTION_CONFIG.emotionMode).toLowerCase(),
        fallbackEmotion: config.fallbackEmotion || DEFAULT_EMOTION_CONFIG.fallbackEmotion,
        autoEmotionThreshold: config.autoEmotionThreshold || DEFAULT_EMOTION_CONFIG.autoEmotionThreshold,
        reactionDurationMs: config.reactionDurationMs || DEFAULT_EMOTION_CONFIG.reactionDurationMs
    };
}

function normalizeCharacter(value, fallback = 'cat') {
    const character = String(value || '').trim().toLowerCase();
    return ['cat', 'robot', 'girl'].includes(character) ? character : fallback;
}

function normalizeFolderName(value, fallback = 'cat') {
    const folder = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    return folder || fallback;
}

function isEnabled(value) {
    if (value === true) return true;
    return ['true', '1', 'yes', 'on', 'enabled'].includes(String(value || '').trim().toLowerCase());
}

function getSkillsDir(pluginDir) {
    return path.resolve(pluginDir, '..', '..', 'skills');
}

function writeAvatarSkill(pluginDir, config = {}) {
    const skillsDir = getSkillsDir(pluginDir);
    const skillPath = path.join(skillsDir, 'avatar.md');
    const emotionConfig = normalizeEmotionConfig(config);
    const content = emotionProtocol.generateAvatarSkill({
        emotions: emotionProtocol.getAvailableEmotions(),
        ...emotionConfig
    });

    fs.mkdirSync(skillsDir, { recursive: true });
    if (fs.existsSync(skillPath)) {
        const existing = fs.readFileSync(skillPath, 'utf-8');
        if (existing === content) {
            return { path: skillPath, updated: false };
        }
    }
    fs.writeFileSync(skillPath, content, 'utf-8');
    return { path: skillPath, updated: true };
}

function removeGeneratedAvatarSkill(pluginDir) {
    const skillPath = path.join(getSkillsDir(pluginDir), 'avatar.md');
    if (!fs.existsSync(skillPath)) {
        return { path: skillPath, removed: false };
    }
    const existing = fs.readFileSync(skillPath, 'utf-8');
    if (!existing.includes('Updated: generated by the Pixel Avatar plugin.')) {
        return { path: skillPath, removed: false, preserved: true };
    }
    fs.unlinkSync(skillPath);
    return { path: skillPath, removed: true };
}

function syncAvatarSkill(pluginDir, config = {}) {
    const emotionConfig = normalizeEmotionConfig(config);
    if (!emotionConfig.exposeExternalSkill) {
        return { ...removeGeneratedAvatarSkill(pluginDir), exposed: false };
    }
    return { ...writeAvatarSkill(pluginDir, emotionConfig), exposed: true };
}

async function ensureDefaultConfig(context) {
    if (!context?.setConfig) return;
    const defaults = {
        avatarPreset: DEFAULT_EMOTION_CONFIG.avatarPreset,
        avatarSource: DEFAULT_EMOTION_CONFIG.avatarSource,
        generatedCharacter: DEFAULT_EMOTION_CONFIG.generatedCharacter,
        imageCharacter: DEFAULT_EMOTION_CONFIG.imageCharacter,
        canvasSize: '160',
        emotionPreset: DEFAULT_EMOTION_CONFIG.emotionPreset,
        emotionMode: DEFAULT_EMOTION_CONFIG.emotionMode,
        fallbackEmotion: DEFAULT_EMOTION_CONFIG.fallbackEmotion,
        autoEmotionThreshold: DEFAULT_EMOTION_CONFIG.autoEmotionThreshold,
        reactionDurationMs: DEFAULT_EMOTION_CONFIG.reactionDurationMs,
        exposeExternalSkill: 'false'
    };

    for (const [key, value] of Object.entries(defaults)) {
        const current = context.getConfig(key);
        if (current == null || String(current).trim() === '') {
            await context.setConfig(key, value);
        }
    }
}

function readSpriteSources(pluginDir, character) {
    const spriteDir = path.join(pluginDir, 'avatars', character);
    const sources = {};

    for (const emotion of EMOTIONS) {
        const filePath = path.join(spriteDir, `${emotion}.png`);
        if (fs.existsSync(filePath)) {
            sources[emotion] = pathToFileURL(filePath).href;
        }
    }

    return sources;
}

function listImageBatchCharacters(pluginDir) {
    const avatarsDir = path.join(pluginDir, 'avatars');
    if (!fs.existsSync(avatarsDir)) return [];
    return fs.readdirSync(avatarsDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort();
}

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function renderSetupButtonGroup({ key, label, value, options }) {
    const normalizedValue = String(value);
    return `<div class="pxav-setup-field">
        <span>${escapeHtml(label)}</span>
        <input type="hidden" data-key="${escapeHtml(key)}" data-type="string" value="${escapeHtml(normalizedValue)}">
        <div class="pxav-button-group" role="group" aria-label="${escapeHtml(label)}">
            ${options.map(option => {
                const optionValue = String(option.value);
                const active = optionValue === normalizedValue ? ' is-active' : '';
                const pressed = optionValue === normalizedValue ? 'true' : 'false';
                return `<button type="button" class="pxav-choice${active}" data-config-key="${escapeHtml(key)}" data-config-value="${escapeHtml(optionValue)}" aria-pressed="${pressed}">${escapeHtml(option.label)}</button>`;
            }).join('')}
        </div>
    </div>`;
}

function renderSetupUI(context) {
    const config = normalizeEmotionConfig({
        avatarPreset: context.getConfig('avatarPreset') || DEFAULT_EMOTION_CONFIG.avatarPreset,
        avatarSource: context.getConfig('avatarSource') || DEFAULT_EMOTION_CONFIG.avatarSource,
        generatedCharacter: context.getConfig('generatedCharacter')
            || context.getConfig('character')
            || DEFAULT_EMOTION_CONFIG.generatedCharacter,
        imageCharacter: context.getConfig('imageCharacter') || DEFAULT_EMOTION_CONFIG.imageCharacter,
        emotionPreset: context.getConfig('emotionPreset') || DEFAULT_EMOTION_CONFIG.emotionPreset,
        emotionMode: context.getConfig('emotionMode') || DEFAULT_EMOTION_CONFIG.emotionMode,
        fallbackEmotion: context.getConfig('fallbackEmotion') || DEFAULT_EMOTION_CONFIG.fallbackEmotion,
        autoEmotionThreshold: context.getConfig('autoEmotionThreshold') || DEFAULT_EMOTION_CONFIG.autoEmotionThreshold,
        reactionDurationMs: context.getConfig('reactionDurationMs') || DEFAULT_EMOTION_CONFIG.reactionDurationMs,
        exposeExternalSkill: context.getConfig('exposeExternalSkill') || DEFAULT_EMOTION_CONFIG.exposeExternalSkill
    });
    const canvasSize = String(context.getConfig('canvasSize') || '160');

    const avatarOptions = [
        { value: 'generated-cat', label: 'Canvas cat' },
        { value: 'generated-robot', label: 'Canvas robot' },
        { value: 'generated-girl', label: 'Canvas girl' },
        { value: 'pixel-cat', label: 'Pixel cat' },
        { value: 'pixel-default', label: 'Pixel default' }
    ];
    const sizeOptions = [
        { value: '128', label: 'Small 128px' },
        { value: '160', label: 'Normal 160px' },
        { value: '200', label: 'Large 200px' },
        { value: '240', label: 'XL 240px' }
    ];
    const emotionOptions = [
        { value: 'balanced', label: 'Balanced' },
        { value: 'expressive', label: 'Expressive' },
        { value: 'markers', label: 'Manual markers' },
        { value: 'neutral', label: 'Quiet neutral' }
    ];
    const skillChecked = config.exposeExternalSkill ? ' checked' : '';

    return {
        html: `<section class="pxav-setup">
            <div class="pxav-setup-grid">
                ${renderSetupButtonGroup({ key: 'avatarPreset', label: 'Avatar', value: config.avatarPreset, options: avatarOptions })}
                ${renderSetupButtonGroup({ key: 'canvasSize', label: 'Avatar Size', value: canvasSize, options: sizeOptions })}
                ${renderSetupButtonGroup({ key: 'emotionPreset', label: 'Emotion Mode', value: config.emotionPreset, options: emotionOptions })}
                <label class="pxav-setup-toggle">
                    <span class="pxav-setup-toggle-text">
                        <strong>Expose avatar.md Skill</strong>
                        <small>Create agentin/skills/avatar.md so the LLM can see the avatar emotion protocol.</small>
                    </span>
                    <input type="checkbox" data-key="exposeExternalSkill" data-type="boolean"${skillChecked}>
                    <span class="pxav-switch" aria-hidden="true"></span>
                </label>
            </div>
        </section>`,
        css: `.pxav-setup {
    display: grid;
    gap: 10px;
}
.pxav-setup-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
    gap: 10px;
    align-items: start;
}
.pxav-setup-field {
    display: grid;
    gap: 6px;
}
.pxav-setup-field span,
.pxav-setup-toggle strong {
    font-size: 0.78rem;
    color: var(--text-secondary);
}
.pxav-button-group {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
}
.pxav-choice {
    border: 1px solid var(--border-color);
    border-radius: 6px;
    background: var(--input-bg);
    color: var(--text-primary);
    padding: 6px 9px;
    cursor: pointer;
    font-size: 0.78rem;
    line-height: 1.2;
}
.pxav-choice:hover {
    border-color: var(--primary-color);
}
.pxav-choice.is-active {
    border-color: var(--primary-color);
    background: var(--primary-color);
    color: #fff;
}
.pxav-setup-toggle {
    min-height: 62px;
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 8px 10px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 46px;
    gap: 12px;
    align-items: center;
    background: var(--bg-secondary);
}
.pxav-setup-toggle-text {
    display: grid;
    gap: 3px;
    min-width: 0;
}
.pxav-setup-toggle small {
    font-size: 0.73rem;
    line-height: 1.35;
    color: var(--text-secondary);
}
.pxav-setup-toggle input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
}
.pxav-switch {
    width: 42px;
    height: 22px;
    border: 1px solid var(--border-color);
    border-radius: 999px;
    background: var(--input-bg);
    position: relative;
    cursor: pointer;
}
.pxav-switch::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--text-secondary);
    transition: transform 0.15s, background 0.15s;
}
.pxav-setup-toggle input:checked + .pxav-switch {
    border-color: var(--primary-color);
    background: var(--primary-color);
}
.pxav-setup-toggle input:checked + .pxav-switch::after {
    transform: translateX(20px);
    background: #fff;
}`
    };
}

function buildAvatarHTML(pluginDir, config = {}) {
    const canvasSize = Number(config.canvasSize) || 160;
    const canvasId = 'pixel-avatar-canvas-pixel-avatar-widget';
    const protocolJs = fs.readFileSync(path.join(pluginDir, 'emotionProtocol.js'), 'utf-8');
    const avatarJs = fs.readFileSync(path.join(pluginDir, 'avatar.js'), 'utf-8');
    const avatarCommonJs = fs.readFileSync(path.join(pluginDir, 'avatar-common.js'), 'utf-8');
    const avatarCatJs = fs.readFileSync(path.join(pluginDir, 'avatar-cat.js'), 'utf-8');
    const avatarRobotJs = fs.readFileSync(path.join(pluginDir, 'avatar-robot.js'), 'utf-8');
    const avatarGirlJs = fs.readFileSync(path.join(pluginDir, 'avatar-girl.js'), 'utf-8');
    const reactorJs = fs.readFileSync(path.join(pluginDir, 'textReactor.js'), 'utf-8');
    const emotionConfig = normalizeEmotionConfig(config);
    const availableImageCharacters = listImageBatchCharacters(pluginDir);
    const imageCharacter = availableImageCharacters.includes(emotionConfig.imageCharacter)
        ? emotionConfig.imageCharacter
        : (availableImageCharacters.includes('cat') ? 'cat' : 'default');
    const imageSprites = readSpriteSources(pluginDir, imageCharacter);
    const defaultSprites = readSpriteSources(pluginDir, 'default');
    const useImageBatch = emotionConfig.avatarSource === 'image-batch'
        || (emotionConfig.avatarSource === 'auto' && Object.keys(imageSprites).length > 0);
    const spriteSources = {
        default: defaultSprites,
        selected: imageSprites
    };
    const previewSrc = spriteSources.selected.neutral
        || spriteSources.default.neutral
        || Object.values(spriteSources.selected)[0]
        || Object.values(spriteSources.default)[0]
        || '';

    return `
<div class="pxav-container" data-avatar-preview-src="${escapeHtml(previewSrc)}">
    <canvas id="${canvasId}" width="${canvasSize}" height="${canvasSize}"></canvas>
</div>
<script>
(function() {
    ${protocolJs}

    ${avatarJs}

    ${avatarCommonJs}

    ${avatarCatJs}

    ${avatarRobotJs}

    ${avatarGirlJs}

    PixelAvatar.prototype.initLoop = function() {
        const loop = () => {
            if (this.destroyed) return;
            this.tick++;
            this.updateIdleTimers();
            this.updateParticles();
            this.render();
            this.__pxavFrame = requestAnimationFrame(loop);
        };
        this.__pxavFrame = requestAnimationFrame(loop);
    };
    PixelAvatar.prototype.destroy = function() {
        this.destroyed = true;
        if (this.__pxavFrame) cancelAnimationFrame(this.__pxavFrame);
    };

    function updateStateDisplay(emotion) {
    }
    function updateDecayProgress() {}

    ${reactorJs}

    const spriteSources = ${JSON.stringify(spriteSources)};
    const emotionConfig = ${JSON.stringify(emotionConfig)};
    const generatedCharacter = ${JSON.stringify(emotionConfig.generatedCharacter)};
    const useImageBatch = ${JSON.stringify(useImageBatch)};

    function makeBackgroundTransparent(img, callback) {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);

        const w = canvas.width;
        const h = canvas.height;
        const imgData = ctx.getImageData(0, 0, w, h);
        const data = imgData.data;
        const sampledColors = [];
        const edgeWidth = Math.min(w, 25);

        for (let x = 0; x < edgeWidth; x++) {
            const idx = x * 4;
            const r = data[idx];
            const g = data[idx + 1];
            const b = data[idx + 2];
            const a = data[idx + 3];
            if (a !== 0 && !sampledColors.some(c => Math.abs(c.r - r) < 15 && Math.abs(c.g - g) < 15 && Math.abs(c.b - b) < 15)) {
                sampledColors.push({ r, g, b });
            }
        }

        function matchesBg(x, y) {
            const idx = (y * w + x) * 4;
            const r = data[idx];
            const g = data[idx + 1];
            const b = data[idx + 2];
            const a = data[idx + 3];
            if (a === 0) return false;

            for (const c of sampledColors) {
                const dist = Math.sqrt((r - c.r) ** 2 + (g - c.g) ** 2 + (b - c.b) ** 2);
                if (dist < 35) return true;
            }
            if (r > 220 && g > 220 && b > 220) return true;
            return r > 150 && g > 150 && b > 150
                && Math.abs(r - g) < 18
                && Math.abs(g - b) < 18
                && Math.abs(r - b) < 18;
        }

        const queue = [];
        const visited = new Uint8Array(w * h);
        for (let x = 0; x < w; x++) {
            if (matchesBg(x, 0)) { queue.push(x, 0); visited[x] = 1; }
            if (matchesBg(x, h - 1)) { queue.push(x, h - 1); visited[(h - 1) * w + x] = 1; }
        }
        for (let y = 0; y < h; y++) {
            if (matchesBg(0, y)) { queue.push(0, y); visited[y * w] = 1; }
            if (matchesBg(w - 1, y)) { queue.push(w - 1, y); visited[y * w + (w - 1)] = 1; }
        }

        let qHead = 0;
        while (qHead < queue.length) {
            const x = queue[qHead++];
            const y = queue[qHead++];
            data[(y * w + x) * 4 + 3] = 0;

            const neighbors = [x + 1, y, x - 1, y, x, y + 1, x, y - 1];
            for (let i = 0; i < neighbors.length; i += 2) {
                const nx = neighbors[i];
                const ny = neighbors[i + 1];
                if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
                const nidx = ny * w + nx;
                if (visited[nidx] === 0 && matchesBg(nx, ny)) {
                    visited[nidx] = 1;
                    queue.push(nx, ny);
                }
            }
        }

        ctx.putImageData(imgData, 0, 0);
        const processedImg = new Image();
        processedImg.onload = () => callback(processedImg);
        processedImg.src = canvas.toDataURL('image/png');
    }

    function createTransparentSpriteMap(sources) {
        const map = {};
        Object.entries(sources || {}).forEach(([emotion, source]) => {
            const img = new Image();
            img.onload = () => {
                try {
                    makeBackgroundTransparent(img, (processedImg) => {
                        map[emotion] = processedImg;
                    });
                } catch (error) {
                    console.warn('[PixelAvatar] Sprite transparency cleanup failed; using procedural fallback:', error);
                }
            };
            img.src = source;
        });
        return map;
    }

    const canvas = document.getElementById('${canvasId}');
    if (!canvas) return;

    const avatar = new PixelAvatar('${canvasId}');
    if (useImageBatch) {
        const selectedSprites = Object.keys(spriteSources.selected || {}).length > 0
            ? spriteSources.selected
            : spriteSources.default;
        avatar.loadSprites(createTransparentSpriteMap(spriteSources.default));
        avatar.loadCustomSprites('cat', createTransparentSpriteMap(selectedSprites));
        avatar.setCharacter('cat');
    } else {
        avatar.setCharacter(generatedCharacter);
    }

    const reactor = new TextReactor(avatar, emotionConfig);
    let lastReactionKey = '';

    const widgetEl = canvas.closest('.plugin-sidebar-widget-item');
    if (widgetEl) {
        widgetEl.addEventListener('sidebar-widget-event', (e) => {
            const detail = e.detail || {};
            if (detail.event === 'chat-message' && detail.text) {
                reactor.reactToText(detail.text);
            }
            if (detail.event === 'agent-update') {
                avatar.setState('thinking');
                updateStateDisplay('thinking');
            }
            if (detail.event === 'set-emotion' && detail.emotion) {
                avatar.setState(detail.emotion);
                updateStateDisplay(detail.emotion);
            }
        });
    }

    if (window.electronAPI?.onConversationUpdate) {
        window.electronAPI.onConversationUpdate((event, data) => {
            reactToConversationUpdate(data || {}).catch(error => {
                console.warn('[PixelAvatar] Conversation reaction failed:', error);
            });
        });
    }

    async function reactToConversationUpdate(data) {
        let messages = Array.isArray(data.messages) ? data.messages : null;
        const sessionId = data.sessionId || data.id || window.mainPanel?.activeTabId || null;

        if ((!messages || messages.length === 0) && sessionId && window.electronAPI?.loadChatSession) {
            const loaded = await window.electronAPI.loadChatSession(sessionId);
            messages = Array.isArray(loaded) ? loaded : loaded?.messages;
        }

        if (!Array.isArray(messages) || messages.length === 0) return;

        const lastMsg = [...messages].reverse().find(message => {
            return message?.role === 'assistant' && String(message.content || '').trim();
        });
        if (!lastMsg) return;

        const content = String(lastMsg.content || '').trim();
        const key = [sessionId || 'current', lastMsg.role || 'assistant', content.slice(0, 180)].join(':');
        if (key === lastReactionKey) return;
        lastReactionKey = key;

        reactor.reactToText(content.slice(0, 1000));
    }

    canvas.addEventListener('mousemove', (e) => {
        const rect = canvas.getBoundingClientRect();
        avatar.targetMouseX = e.clientX - rect.left;
        avatar.targetMouseY = e.clientY - rect.top;
    });

    const cleanup = () => {
        reactor.stopActiveReaction();
        avatar.destroy();
    };
    if (widgetEl) widgetEl.addEventListener('sidebar-widget-unmount', cleanup, { once: true });

    console.log('[PixelAvatar] Sprite avatar initialized in sidebar');
})();
</script>`;
}

const css = `
.pxav-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 6px;
}
.pxav-container canvas {
    border-radius: 8px;
    background: #1a1a2e;
    image-rendering: pixelated;
    width: 100%;
    max-width: 200px;
    aspect-ratio: 1;
}
`;

module.exports = {
    async onEnable(context) {
        await ensureDefaultConfig(context);
        const config = {
            avatarPreset: context.getConfig('avatarPreset') || DEFAULT_EMOTION_CONFIG.avatarPreset,
            avatarSource: context.getConfig('avatarSource') || DEFAULT_EMOTION_CONFIG.avatarSource,
            generatedCharacter: context.getConfig('generatedCharacter')
                || context.getConfig('character')
                || DEFAULT_EMOTION_CONFIG.generatedCharacter,
            imageCharacter: context.getConfig('imageCharacter') || DEFAULT_EMOTION_CONFIG.imageCharacter,
            canvasSize: context.getConfig('canvasSize') || '160',
            emotionPreset: context.getConfig('emotionPreset') || DEFAULT_EMOTION_CONFIG.emotionPreset,
            emotionMode: context.getConfig('emotionMode') || DEFAULT_EMOTION_CONFIG.emotionMode,
            fallbackEmotion: context.getConfig('fallbackEmotion') || DEFAULT_EMOTION_CONFIG.fallbackEmotion,
            autoEmotionThreshold: context.getConfig('autoEmotionThreshold') || DEFAULT_EMOTION_CONFIG.autoEmotionThreshold,
            reactionDurationMs: context.getConfig('reactionDurationMs') || DEFAULT_EMOTION_CONFIG.reactionDurationMs,
            exposeExternalSkill: context.getConfig('exposeExternalSkill') || DEFAULT_EMOTION_CONFIG.exposeExternalSkill
        };
        const skill = syncAvatarSkill(context.pluginDir, config);

        const html = buildAvatarHTML(context.pluginDir, config);

        context.registerSidebarWidget({
            id: 'pixel-avatar-widget',
            title: 'Pixel Avatar',
            chrome: false,
            html,
            css,
            position: 'before-calendar'
        });

        context.log(`Pixel Avatar registered as sidebar widget; avatar skill file ${skill.exposed ? 'created' : 'skipped'}`);
    },

    onDisable(context) {
        context.log('Pixel Avatar disabled');
    },

    onConfigChanged(key, value, context) {
        const config = {
            ...(context.config || {}),
            [key]: value
        };
        syncAvatarSkill(context.pluginDir, config);

        if (context.registerSidebarWidget) {
            context.registerSidebarWidget({
                id: 'pixel-avatar-widget',
                title: 'Pixel Avatar',
                chrome: false,
                html: buildAvatarHTML(context.pluginDir, config),
                css,
                position: 'before-calendar'
            });
        }
        context.log(`Config changed: ${key} = ${value}`);
    },

    _private: {
        normalizeEmotionConfig,
        syncAvatarSkill,
        ensureDefaultConfig
    },

    renderSetupUI
};
