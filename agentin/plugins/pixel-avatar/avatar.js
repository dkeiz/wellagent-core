class PixelParticle {
  constructor(x, y, emotion) {
    this.x = x;
    this.y = y;
    this.emotion = emotion;
    this.size = Math.random() * 4 + 4; // chunky pixels
    this.vx = (Math.random() - 0.5) * 3;
    this.vy = -Math.random() * 2 - 1;
    this.alpha = 1;
    this.decay = Math.random() * 0.02 + 0.015;
    this.tick = Math.random() * 100;
    
    // Custom properties based on emotion
    switch(emotion) {
      case 'happy':
        this.color = '#2ed573';
        this.shape = 'heart';
        break;
      case 'sad':
        this.color = '#1e90ff';
        this.shape = 'drop';
        break;
      case 'angry':
        this.color = '#ff4757';
        this.shape = 'spark';
        this.vy = -Math.random() * 4 - 2; // fly faster
        break;
      case 'thinking':
        this.color = '#a55eea';
        this.shape = 'bubble';
        break;
      case 'surprised':
        this.color = '#ffa502';
        this.shape = 'sparkle';
        break;
      case 'excited':
        this.color = `hsl(${Math.random() * 360}, 90%, 65%)`; // rainbow confetti
        this.shape = 'square';
        this.vy = -Math.random() * 5 - 2;
        break;
      case 'sleepy':
        this.color = '#2bcbba';
        this.shape = 'z';
        this.size = Math.random() * 6 + 6;
        break;
      case 'staring':
        this.color = '#ff7675';
        this.shape = 'lock';
        this.size = Math.random() * 3 + 3;
        break;
      default:
        this.color = 'rgba(255,255,255,0.3)';
        this.shape = 'square';
    }
  }

  update() {
    this.x += this.vx;
    this.y += this.vy;
    this.alpha -= this.decay;
    this.tick += 0.1;
    
    if (this.shape === 'z') {
      this.x += Math.sin(this.tick) * 0.5; // drift sideways
    }
  }

  draw(ctx) {
    ctx.save();
    ctx.globalAlpha = this.alpha;
    ctx.fillStyle = this.color;
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 2;
    
    const size = this.size;
    
    if (this.shape === 'heart') {
      ctx.fillRect(this.x, this.y, size, size);
      ctx.fillRect(this.x - size/2, this.y - size/2, size/2, size/2);
      ctx.fillRect(this.x + size, this.y - size/2, size/2, size/2);
    } else if (this.shape === 'drop') {
      ctx.fillRect(this.x, this.y, size * 0.7, size * 1.2);
    } else if (this.shape === 'spark') {
      ctx.fillRect(this.x, this.y - size/2, 2, size);
      ctx.fillRect(this.x - size/2, this.y, size, 2);
    } else if (this.shape === 'bubble') {
      ctx.beginPath();
      ctx.arc(this.x, this.y, size/2, 0, Math.PI*2);
      ctx.fill();
    } else if (this.shape === 'z') {
      ctx.font = `bold ${Math.floor(this.size)}px 'Fira Code', monospace`;
      ctx.fillText('Z', this.x, this.y);
    } else if (this.shape === 'lock') {
      ctx.strokeRect(this.x - size/2, this.y - size/2, size, size);
    } else {
      ctx.fillRect(this.x - size/2, this.y - size/2, size, size);
    }
    
    ctx.restore();
  }
}

class PixelAvatar {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas.getContext('2d');
    this.sprites = {}; // default file assets
    this.customSprites = {
      cat: {},
      robot: {},
      girl: {}
    };
    
    this.currentState = 'neutral';
    this.activeCharacter = 'cat'; // 'cat', 'robot', or 'girl'
    
    this.tick = 0;
    this.particles = [];
    
    // Mouse gaze coordinates
    this.mouseX = 0;
    this.mouseY = 0;
    this.targetMouseX = 0;
    this.targetMouseY = 0;
    
    // Action States
    this.isTalking = false;
    this.waveTimer = 0; // Tick countdown for hand waving
    
    // Random idle triggers
    this.isBlinking = false;
    this.blinkTimer = 0;
    this.earTwitchLeft = false;
    this.earTwitchRight = false;
    
    // Start continuous animation loop
    this.initLoop();
  }

  loadSprites(spriteMap) {
    this.sprites = spriteMap;
  }

  loadCustomSprites(character, spriteMap) {
    this.customSprites[character] = spriteMap;
  }

  setState(state) {
    this.currentState = state;
    if (state !== 'neutral') {
      this.addParticles(state, 12);
    }
  }

  setCharacter(character) {
    if (character === 'cat' || character === 'robot' || character === 'girl') {
      this.activeCharacter = character;
      this.triggerWave(); // wave greeting on switch!
      this.addParticles('excited', 15); // burst confetti
    }
  }

  triggerWave() {
    this.waveTimer = 120; // 120 ticks = 2 seconds at 60fps
  }

  addParticles(emotion, count) {
    const w = 256;
    const h = 256;
    for(let i = 0; i < count; i++) {
      const x = w / 2 + (Math.random() - 0.5) * 100;
      const y = h / 2 - 20 + (Math.random() - 0.5) * 60;
      this.particles.push(new PixelParticle(x, y, emotion));
    }
  }

  updateParticles() {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      this.particles[i].update();
      if (this.particles[i].alpha <= 0) {
        this.particles.splice(i, 1);
      }
    }
  }

  initLoop() {
    const loop = () => {
      this.tick++;
      this.updateIdleTimers();
      this.updateParticles();
      this.render();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  updateIdleTimers() {
    // Interpolate mouse tracking smoothly (lagged lerp)
    this.mouseX += (this.targetMouseX - this.mouseX) * 0.12;
    this.mouseY += (this.targetMouseY - this.mouseY) * 0.12;

    // Countdown wave timer
    if (this.waveTimer > 0) {
      this.waveTimer--;
    }

    // Eye Blinking logic
    if (this.isBlinking) {
      this.blinkTimer--;
      if (this.blinkTimer <= 0) {
        this.isBlinking = false;
      }
    } else {
      if (Math.random() < 0.008 && this.currentState !== 'staring') {
        this.isBlinking = true;
        this.blinkTimer = Math.random() * 8 + 4; // blink length
      }
    }

    // Ear twitches
    if (this.tick % 130 === 0) {
      if (Math.random() < 0.4) this.earTwitchLeft = true;
      if (Math.random() < 0.4) this.earTwitchRight = true;
    }
    
    if (this.earTwitchLeft && Math.random() < 0.25) this.earTwitchLeft = false;
    if (this.earTwitchRight && Math.random() < 0.25) this.earTwitchRight = false;
    
    // Sleepy Z particles
    if (this.currentState === 'sleepy' && this.tick % 24 === 0) {
      const w = 256;
      const h = 256;
      this.particles.push(new PixelParticle(w / 2 + 35, h / 2 - 40, 'sleepy'));
    }
    
    // Thinking bubble particles
    if (this.currentState === 'thinking' && this.tick % 32 === 0) {
      const w = 256;
      const h = 256;
      this.particles.push(new PixelParticle(w / 2 - 35, h / 2 - 50, 'thinking'));
    }

    // Target tracking sparkles when staring
    if (this.currentState === 'staring' && this.tick % 20 === 0) {
      const w = 256;
      const h = 256;
      this.particles.push(new PixelParticle(w / 2 + (Math.random()-0.5)*80, h / 2 - 10 + (Math.random()-0.5)*30, 'staring'));
    }
  }

  render() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    
    // Render custom sprite if present, falling back to neutral custom sprite to keep custom avatar visible
    let customImg = this.customSprites[this.activeCharacter][this.currentState];
    if (!customImg || !customImg.complete || customImg.naturalWidth === 0) {
      customImg = this.customSprites[this.activeCharacter]['neutral'];
    }
    
    if (customImg && customImg.complete && customImg.naturalWidth !== 0) {
      // Draw premium neon dark-indigo background with pink radial glow
      ctx.fillStyle = '#0b0918';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      
      const w = this.canvas.width;
      const h = this.canvas.height;
      const grad = ctx.createRadialGradient(w/2, h/2, 10 * (w/256), w/2, h/2, 120 * (w/256));
      grad.addColorStop(0, 'rgba(253, 121, 168, 0.18)');
      grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
      
      const bounce = Math.sin(this.tick * 0.06) * 3 * (w / 256);
      ctx.drawImage(customImg, 0, bounce, w, h);
      
      // Draw active particle systems in logical scaled context
      const baseSize = 256;
      const scale = this.canvas.width / baseSize;
      ctx.save();
      ctx.scale(scale, scale);
      this.particles.forEach(p => p.draw(ctx));
      ctx.restore();
    } else {
      const baseSize = 256;
      const scale = this.canvas.width / baseSize;
      
      ctx.save();
      ctx.scale(scale, scale);
      
      if (this.activeCharacter === 'cat') {
        this.drawProceduralCat();
      } else if (this.activeCharacter === 'robot') {
        this.drawProceduralRobot();
      } else {
        this.drawProceduralGirl();
      }

      // Draw active particle systems
      this.particles.forEach(p => p.draw(ctx));
      
      ctx.restore();
    }
  }
}
