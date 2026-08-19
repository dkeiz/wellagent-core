(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    root.LocalAgentTtsTextUtils = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    function splitThinking(rawText) {
        const source = String(rawText || '');
        const thinkMatches = [...source.matchAll(/<think>([\s\S]*?)<\/think>/gi)];
        return {
            thinking: thinkMatches.map(match => match[1]).join('\n\n').trim(),
            answer: source.replace(/<think>[\s\S]*?<\/think>/gi, ' ').trim()
        };
    }

    function replaceLinks(text) {
        return String(text || '')
            .replace(/\[([^\]]+)\]\((https?:\/\/|www\.)[^)]+\)/gi, 'link')
            .replace(/https?:\/\/\S+/gi, 'link')
            .replace(/\bwww\.\S+/gi, 'link');
    }

    function stripEmotionDirectives(text) {
        return String(text || '')
            .replace(/<!--\s*(?:emotion|mood)\s*(?::|=)\s*["']?[a-z][a-z0-9_-]*["']?\s*-->/gi, '')
            .trim();
    }

    function isMostlySymbols(text) {
        const compact = String(text || '').replace(/\s+/g, '');
        if (!compact) return true;
        const lettersDigits = (compact.match(/[A-Za-z0-9\u0400-\u04FF]/g) || []).length;
        if (lettersDigits === 0) return true;
        const symbolCount = compact.length - lettersDigits;
        return compact.length >= 12 && (symbolCount / compact.length) > 0.55;
    }

    function cleanLines(text) {
        const lines = String(text || '').split(/\r?\n/);
        const result = [];
        let inFence = false;

        for (let line of lines) {
            const trimmed = line.trim();
            if (/^(```|~~~)/.test(trimmed)) {
                inFence = !inFence;
                continue;
            }
            if (inFence || !trimmed) continue;

            line = replaceLinks(trimmed)
                .replace(/`([^`]+)`/g, '$1')
                .replace(/^\s{0,3}(#{1,6}|\-|\*|\+|\d+\.)\s+/g, '')
                .replace(/\|/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();

            if (!line) continue;
            if (line.length > 80 && isMostlySymbols(line)) continue;
            if (isMostlySymbols(line) && line.length >= 6) continue;
            if (/^[\[\]\{\}:,"'`~<>\\/_=+#-]+$/.test(line)) continue;
            if ((/^[\[{]/.test(line) && /[\]}]$/.test(line)) || /"\s*:/.test(line)) continue;
            if (/^tool\b/i.test(line) && line.length > 40) continue;

            result.push(line);
        }

        return result;
    }

    function normalizeSpeakText(text) {
        return cleanLines(text)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function extractSpeakableText(rawText, mode) {
        const normalizedMode = String(mode || 'answer').trim().toLowerCase();
        const sections = splitThinking(stripEmotionDirectives(rawText));
        const parts = [];

        if (normalizedMode === 'thinking + answer' || normalizedMode === 'thinking+answer') {
            const thinking = normalizeSpeakText(sections.thinking);
            if (thinking) parts.push(thinking);
        }

        const answer = normalizeSpeakText(sections.answer);
        if (answer) parts.push(answer);
        return parts.join(' ').trim();
    }

    return {
        cleanLines,
        extractSpeakableText,
        isMostlySymbols,
        normalizeSpeakText,
        replaceLinks,
        splitThinking,
        stripEmotionDirectives
    };
});
