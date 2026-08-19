class TextReactor {
  constructor(avatar, options = {}) {
    this.avatar = avatar;
    this.options = options || {};
    this.emotionMap = {
      'neutral': { duration: this.durationFor('neutral', 800) },
      'happy': { duration: this.durationFor('happy', 1800) },
      'sad': { duration: this.durationFor('sad', 2500) },
      'surprised': { duration: this.durationFor('surprised', 1500) },
      'thinking': { duration: this.durationFor('thinking', 2000) },
      'angry': { duration: this.durationFor('angry', 2200) },
      'excited': { duration: this.durationFor('excited', 1800) },
      'sleepy': { duration: this.durationFor('sleepy', 3000) },
      'staring': { duration: this.durationFor('staring', 2500) }
    };
    this.animationTimeout = null;
    this.decayInterval = null;
  }

  durationFor(emotion, fallback) {
    const specific = Number(this.options[`${emotion}DurationMs`]);
    if (Number.isFinite(specific) && specific > 0) return specific;
    const configured = Number(this.options.reactionDurationMs);
    if (Number.isFinite(configured) && configured > 0 && emotion !== 'neutral') return configured;
    return fallback;
  }

  stopActiveReaction() {
    if (this.animationTimeout) {
      clearTimeout(this.animationTimeout);
      this.animationTimeout = null;
    }
    if (this.decayInterval) {
      clearInterval(this.decayInterval);
      this.decayInterval = null;
    }
  }

  reactToText(text) {
    if (!text.trim()) return;

    const emotion = this.detectEmotion(text);
    const animation = this.emotionMap[emotion];

    // Clear any active timers before starting new one
    this.stopActiveReaction();

    // Set avatar states
    this.avatar.setState(emotion);
    updateStateDisplay(emotion);

    // Progressive visual progress bar decay handling
    const duration = animation.duration;
    const startTime = Date.now();
    
    updateDecayProgress(emotion, 100);

    if (emotion !== 'neutral') {
      this.decayInterval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        const pct = Math.max(0, 100 - (elapsed / duration) * 100);
        updateDecayProgress(emotion, pct);
        if (pct <= 0) {
          clearInterval(this.decayInterval);
        }
      }, 30);
    }

    // Timer fallback returning to neutral
    this.animationTimeout = setTimeout(() => {
      this.avatar.setState('neutral');
      updateStateDisplay('neutral');
      if (emotion !== 'neutral') {
        updateDecayProgress(emotion, 0);
      }
    }, duration);
  }

  detectEmotion(text) {
    if (typeof window !== 'undefined' && window.PixelEmotionProtocol?.resolveEmotion) {
      return window.PixelEmotionProtocol.resolveEmotion(text, this.options).emotion;
    }

    const lower = text.toLowerCase().trim();

    // 1. Intense Staring
    if (/stare|look|eyes|gaze|watch|track|intense|focused|locked|focus|👀|👁️|target|lock-on/.test(lower)) {
      return 'staring';
    }

    // 2. Excited
    if (/excited|hype|lets go|let's go|party|hurrah|yippee|🎉|🤩|dance|hooray|win|yes!/.test(lower)) {
      return 'excited';
    }

    // 3. Sleepy
    if (/sleepy|tired|yawn|sleep|bed|night|lazy|😴|💤|exhausted|boring|bored|sigh|fatigue/.test(lower)) {
      return 'sleepy';
    }

    // 4. Angry
    if (/angry|mad|furious|annoyed|grr|stop|😠|😡|hate|stupid|idiot|rage|kill|destroy|frustrated|shut up|nonsense/.test(lower)) {
      return 'angry';
    }

    // 5. Happy
    if (/happy|great|awesome|love|excellent|wow|yay|😊|😄|😁|perfect|good|nice|smile|glad|cool|fun/.test(lower)) {
      return 'happy';
    }

    // 6. Sad
    if (/sad|sorry|bad|terrible|😢|😭|cry|hurt|lonely|unhappy|disappointed|grief|pain|regret/.test(lower)) {
      return 'sad';
    }

    // 7. Surprised
    if (/what|really|\?|surprised|shock|😲|😮|omg|impossible|incredible|unbelievable|whoa|gasp/.test(lower)) {
      return 'surprised';
    }

    // 8. Thinking
    if (/hmm|think|maybe|perhaps|wonder|considering|study|math|why|how|analyze|curious|puzzled|question/.test(lower)) {
      return 'thinking';
    }

    return 'neutral';
  }
}
