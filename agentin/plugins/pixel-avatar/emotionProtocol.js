(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.PixelEmotionProtocol = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const EMOTIONS = Object.freeze([
    'neutral',
    'happy',
    'sad',
    'surprised',
    'thinking',
    'angry',
    'excited',
    'sleepy',
    'staring'
  ]);

  const EMOTION_SET = new Set(EMOTIONS);
  const DIRECTIVE_RE = /<!--\s*(?:emotion|mood)\s*(?::|=)\s*["']?([a-z][a-z0-9_-]*)["']?\s*-->/gi;

  const WEIGHTS = Object.freeze({
    thinking: [
      ['let me check', 4], ['checking', 3], ['analyze', 3], ['analysis', 3],
      ['likely', 2], ['maybe', 2], ['perhaps', 2], ['hmm', 2],
      ['why', 1], ['how', 1], ['consider', 2], ['investigate', 3]
    ],
    happy: [
      ['great', 3], ['excellent', 3], ['perfect', 3], ['good', 2],
      ['nice', 2], ['glad', 2], ['happy', 3], ['love', 3],
      ['awesome', 3], ['works', 2], ['success', 3], ['😊', 3], ['😄', 3]
    ],
    sad: [
      ['sorry', 3], ['unfortunately', 3], ['failed', 3], ['error', 2],
      ['bad', 2], ['terrible', 3], ['sad', 3], ['problem', 2],
      ['broken', 3], ['regret', 2], ['😢', 3], ['😭', 3]
    ],
    surprised: [
      ['unexpected', 3], ['really', 2], ['surprised', 3], ['whoa', 3],
      ['wow', 2], ['omg', 3], ['impossible', 3], ['unusual', 2],
      ['?', 1], ['😲', 3], ['😮', 3]
    ],
    angry: [
      ['angry', 3], ['frustrating', 3], ['annoyed', 3], ['blocked', 2],
      ['stop', 2], ['hate', 3], ['rage', 3], ['nonsense', 3],
      ['stupid', 3], ['😠', 3], ['😡', 3]
    ],
    excited: [
      ['excited', 3], ['lets go', 3], ["let's go", 3], ['hype', 3],
      ['party', 3], ['win', 2], ['yes!', 3], ['hooray', 3],
      ['🎉', 4], ['🤩', 4]
    ],
    sleepy: [
      ['sleepy', 3], ['tired', 3], ['yawn', 3], ['sleep', 3],
      ['night', 2], ['boring', 2], ['bored', 2], ['exhausted', 3],
      ['😴', 4], ['💤', 4]
    ],
    staring: [
      ['stare', 3], ['gaze', 3], ['eyes', 2], ['watch', 2],
      ['focused', 3], ['focus', 2], ['locked', 3], ['target', 2],
      ['👀', 4]
    ]
  });

  const TIE_BREAK = Object.freeze([
    'thinking',
    'surprised',
    'happy',
    'sad',
    'angry',
    'excited',
    'sleepy',
    'staring',
    'neutral'
  ]);

  function normalizeEmotion(value, fallback = null) {
    const emotion = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    return EMOTION_SET.has(emotion) ? emotion : fallback;
  }

  function getAvailableEmotions() {
    return EMOTIONS.slice();
  }

  function extractEmotionDirective(text) {
    const content = String(text || '');
    let match;
    let latest = null;
    DIRECTIVE_RE.lastIndex = 0;
    while ((match = DIRECTIVE_RE.exec(content)) !== null) {
      const emotion = normalizeEmotion(match[1]);
      if (emotion) {
        latest = {
          emotion,
          raw: match[0],
          index: match.index
        };
      }
    }
    return latest;
  }

  function stripEmotionDirectives(text) {
    return String(text || '').replace(DIRECTIVE_RE, '').replace(/\n{3,}/g, '\n\n').trim();
  }

  function scoreNeedle(lower, needle, weight) {
    if (!needle) return 0;
    if (needle.length === 1) {
      return lower.includes(needle) ? weight : 0;
    }
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
    return re.test(lower) ? weight : 0;
  }

  function detectAutoEmotion(text, options = {}) {
    const lower = String(text || '').toLowerCase();
    const threshold = Number(options.threshold || options.autoEmotionThreshold || 2);
    const scores = {};

    for (const [emotion, terms] of Object.entries(WEIGHTS)) {
      let score = 0;
      for (const [needle, weight] of terms) {
        score += scoreNeedle(lower, needle, weight);
      }
      scores[emotion] = score;
    }

    let bestEmotion = 'neutral';
    let bestScore = 0;
    for (const emotion of TIE_BREAK) {
      const score = scores[emotion] || 0;
      if (score > bestScore) {
        bestScore = score;
        bestEmotion = emotion;
      }
    }

    if (bestScore < threshold) {
      return { emotion: 'neutral', score: bestScore, scores };
    }
    return { emotion: bestEmotion, score: bestScore, scores };
  }

  function resolveEmotion(text, options = {}) {
    const mode = String(options.emotionMode || options.mode || 'hybrid').toLowerCase();
    const fallback = normalizeEmotion(options.fallbackEmotion, 'neutral') || 'neutral';
    const directive = extractEmotionDirective(text);

    if (mode === 'neutral') {
      return { emotion: fallback, source: 'fallback', directive: null, auto: null };
    }
    if (directive) {
      return { emotion: directive.emotion, source: 'directive', directive, auto: null };
    }
    if (mode === 'explicit') {
      return { emotion: fallback, source: 'fallback', directive: null, auto: null };
    }

    const auto = detectAutoEmotion(stripEmotionDirectives(text), options);
    if (mode === 'auto' || mode === 'hybrid') {
      const emotion = auto.emotion === 'neutral' ? fallback : auto.emotion;
      return {
        emotion,
        source: auto.emotion === 'neutral' ? 'fallback' : 'auto',
        directive: null,
        auto
      };
    }

    return { emotion: fallback, source: 'fallback', directive: null, auto };
  }

  function generateAvatarSkill(options = {}) {
    const emotions = options.emotions || EMOTIONS;
    const defaultMode = options.emotionMode || 'hybrid';
    const fallback = options.fallbackEmotion || 'neutral';
    const threshold = String(options.autoEmotionThreshold || '2');
    return [
      '# Avatar Emotion Protocol',
      '',
      'Updated: generated by the Pixel Avatar plugin.',
      '',
      '## Purpose',
      'Use hidden emotion markers when text tone should synchronize with visual avatar output or voice/TTS output.',
      '',
      '## Emotion Marker',
      'Place one marker before the text it describes:',
      '',
      '`<!-- emotion: thinking -->`',
      '',
      'Equivalent form:',
      '',
      '`<!-- emotion=thinking -->`',
      '',
      '## Available Emotions',
      emotions.map(emotion => `- ${emotion}`).join('\n'),
      '',
      '## Rules',
      '- Use at most one marker for a short response unless the tone clearly changes.',
      '- Prefer `thinking` for active analysis or checking work.',
      '- Prefer `neutral` for plain factual output.',
      '- Do not invent emotions outside the available list.',
      '- The marker is hidden control metadata; do not explain it to the user.',
      '',
      '## Fallback Behavior',
      `Pixel Avatar mode: ${defaultMode}.`,
      `Fallback emotion: ${fallback}.`,
      `Auto emotion threshold: ${threshold}.`,
      'If no valid marker is present, consumers may auto-detect emotion from text or fall back to neutral.',
      ''
    ].join('\n');
  }

  return {
    EMOTIONS,
    getAvailableEmotions,
    normalizeEmotion,
    extractEmotionDirective,
    stripEmotionDirectives,
    detectAutoEmotion,
    resolveEmotion,
    generateAvatarSkill
  };
});
