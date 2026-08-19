// Procedural girl renderer for PixelAvatar.

PixelAvatar.prototype.drawProceduralGirl = function() {
    const ctx = this.ctx;
    const w = 256;
    const h = 256;
    const state = this.currentState;

    // Cyberpunk rose ambient chamber
    ctx.fillStyle = '#0a0815';
    ctx.fillRect(0, 0, w, h);
    
    const grad = ctx.createRadialGradient(w/2, h/2, 10, w/2, h/2, 120);
    grad.addColorStop(0, 'rgba(235, 77, 75, 0.16)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Apply breathing bounce
    let bounce = Math.sin(this.tick * 0.05) * 2;
    if (state === 'sleepy') bounce = Math.sin(this.tick * 0.035) * 1.2;
    if (state === 'excited') bounce = Math.sin(this.tick * 0.16) * 4.5;

    // Face offsets for intense staring locks
    let headOffsetX = 0;
    let headOffsetY = 0;
    if (state === 'staring') {
      headOffsetX = Math.max(-8, Math.min(8, this.mouseX / 30));
      headOffsetY = Math.max(-6, Math.min(6, this.mouseY / 30));
    }

    const centerX = w / 2 + headOffsetX;
    const centerY = h / 2 + 10 + bounce + headOffsetY;

    // 1. FLOWING BACK CYBER-HAIR SHEETS (Breeze sway)
    ctx.fillStyle = '#ff7675'; // Main luminous coral pink
    const backSway = Math.sin(this.tick * 0.04) * 7;
    
    // Left Back hair strand
    ctx.beginPath();
    ctx.moveTo(centerX - 52, centerY - 20);
    ctx.bezierCurveTo(
      centerX - 82 + backSway, centerY + 20,
      centerX - 94 + backSway * 1.5, centerY + 70,
      centerX - 60 + backSway * 1.2, centerY + 105
    );
    ctx.bezierCurveTo(
      centerX - 72 + backSway * 0.8, centerY + 68,
      centerX - 66, centerY + 24,
      centerX - 46, centerY - 10
    );
    ctx.fill();

    // Right Back hair strand
    ctx.beginPath();
    ctx.moveTo(centerX + 52, centerY - 20);
    ctx.bezierCurveTo(
      centerX + 82 - backSway, centerY + 20,
      centerX + 94 - backSway * 1.5, centerY + 70,
      centerX + 60 - backSway * 1.2, centerY + 105
    );
    ctx.bezierCurveTo(
      centerX + 72 - backSway * 0.8, centerY + 68,
      centerX + 66, centerY + 24,
      centerX + 46, centerY - 10
    );
    ctx.fill();

    // 2. NECK, JACKET COLLAR & NEON TIE BOW
    ctx.fillStyle = '#ffd1cb'; // Shaded neck flesh
    ctx.fillRect(centerX - 12, centerY + 24, 24, 25);
    
    // Shadow under chin
    ctx.fillStyle = 'rgba(235, 77, 75, 0.2)';
    ctx.beginPath();
    ctx.arc(centerX, centerY + 28, 15, 0, Math.PI);
    ctx.fill();

    // Charcoal school blazer collar
    ctx.fillStyle = '#2c2a3f';
    ctx.beginPath();
    ctx.roundRect(centerX - 44, centerY + 45, 88, 30, [12, 12, 0, 0]);
    ctx.fill();
    
    // White shirt flaps (V shape)
    ctx.fillStyle = '#f5f6fa';
    ctx.beginPath();
    ctx.moveTo(centerX - 28, centerY + 45);
    ctx.lineTo(centerX - 8, centerY + 62);
    ctx.lineTo(centerX, centerY + 45);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(centerX + 28, centerY + 45);
    ctx.lineTo(centerX + 8, centerY + 62);
    ctx.lineTo(centerX, centerY + 45);
    ctx.closePath();
    ctx.fill();

    // Red neck bow tie
    ctx.fillStyle = '#ff7675';
    ctx.beginPath();
    ctx.moveTo(centerX - 10, centerY + 58);
    ctx.lineTo(centerX + 10, centerY + 58);
    ctx.lineTo(centerX, centerY + 72);
    ctx.closePath();
    ctx.fill();

    // 3. HANDS & WAVE ACTION
    ctx.fillStyle = '#ffe4e1'; // Fair hand flesh
    
    // Static left hand
    ctx.fillRect(centerX - 30, centerY + 48, 12, 10);

    if (this.waveTimer > 0) {
      ctx.save();
      const waveAngle = Math.sin(this.tick * 0.26) * 0.5;
      ctx.translate(centerX + 48, centerY + 14);
      ctx.rotate(waveAngle);
      
      // Sleeve arm
      ctx.fillStyle = '#2c2a3f';
      ctx.fillRect(-10, -16, 20, 28);
      
      // Hand flesh
      ctx.fillStyle = '#ffe4e1';
      ctx.beginPath();
      ctx.roundRect(-8, -30, 16, 16, 5);
      ctx.fill();
      
      // Dynamic waving finger lines
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#ffe4e1';
      ctx.beginPath();
      ctx.moveTo(-5, -30); ctx.lineTo(-8 + Math.sin(this.tick*0.1)*3, -38);
      ctx.moveTo(0, -30); ctx.lineTo(0 + Math.sin(this.tick*0.15)*3, -40);
      ctx.moveTo(5, -30); ctx.lineTo(8 + Math.sin(this.tick*0.1)*3, -38);
      ctx.stroke();
      ctx.restore();
    } else {
      // Rest static right hand
      ctx.fillRect(centerX + 18, centerY + 48, 12, 10);
    }

    // 4. FACE OUTLINE (Scaled up matching Cat and Robot!)
    ctx.fillStyle = '#ffe4e1'; // Warm soft peach skin
    ctx.beginPath();
    ctx.roundRect(centerX - 54, centerY - 45, 108, 85, [30, 30, 32, 32]);
    ctx.fill();

    // 5. CHEEKS BLUSHING
    ctx.fillStyle = 'rgba(235, 77, 75, 0.4)';
    ctx.beginPath();
    ctx.arc(centerX - 36, centerY + 18, 6.5, 0, Math.PI*2);
    ctx.arc(centerX + 36, centerY + 18, 6.5, 0, Math.PI*2);
    ctx.fill();

    // 6. EXPRESSIVE ANIME EYES & MOUSE TRACKING (Scaled and shifted outwards)
    const girlEyeY = centerY - 10;
    
    // Gaze calculations
    let gazeX = Math.max(-6, Math.min(6, this.mouseX / 26));
    let gazeY = Math.max(-5, Math.min(5, this.mouseY / 28));
    
    if (state === 'staring') {
      gazeX = Math.max(-12, Math.min(12, this.mouseX / 16));
      gazeY = Math.max(-10, Math.min(10, this.mouseY / 16));
    }

    ctx.strokeStyle = '#1e0b1d';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';

    if (this.isBlinking && state !== 'sleepy' && state !== 'surprised' && state !== 'staring') {
      // Slit blink lines
      ctx.beginPath();
      ctx.moveTo(centerX - 38, girlEyeY); ctx.lineTo(centerX - 18, girlEyeY);
      ctx.moveTo(centerX + 18, girlEyeY); ctx.lineTo(centerX + 38, girlEyeY);
      ctx.stroke();
    } else {
      switch(state) {
        case 'happy':
          ctx.beginPath();
          ctx.arc(centerX - 28 + gazeX*0.3, girlEyeY + 4 + gazeY*0.3, 10, Math.PI, 0);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(centerX + 28 + gazeX*0.3, girlEyeY + 4 + gazeY*0.3, 10, Math.PI, 0);
          ctx.stroke();
          break;
          
        case 'sad':
          ctx.beginPath();
          ctx.arc(centerX - 28, girlEyeY + 2, 10, 0, Math.PI);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(centerX + 28, girlEyeY + 2, 10, 0, Math.PI);
          ctx.stroke();
          // Tears
          ctx.fillStyle = '#1e90ff';
          ctx.fillRect(centerX - 32, girlEyeY + 12 + Math.sin(this.tick * 0.1)*3, 5, 8);
          ctx.fillRect(centerX + 27, girlEyeY + 12 + Math.cos(this.tick * 0.1)*3, 5, 8);
          break;
          
        case 'angry':
          // Slanted brows
          ctx.strokeStyle = '#1e0b1d';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.moveTo(centerX - 42, girlEyeY - 12); ctx.lineTo(centerX - 16, girlEyeY - 6);
          ctx.moveTo(centerX + 42, girlEyeY - 12); ctx.lineTo(centerX + 16, girlEyeY - 6);
          ctx.stroke();
          // Angry red slit pupils
          ctx.fillStyle = '#ff4757';
          ctx.beginPath();
          ctx.arc(centerX - 28 + gazeX*0.3, girlEyeY + gazeY*0.3, 7, 0, Math.PI*2);
          ctx.arc(centerX + 28 + gazeX*0.3, girlEyeY + gazeY*0.3, 7, 0, Math.PI*2);
          ctx.fill();
          break;
          
        case 'surprised':
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.arc(centerX - 28, girlEyeY, 12, 0, Math.PI*2);
          ctx.arc(centerX + 28, girlEyeY, 12, 0, Math.PI*2);
          ctx.fill();
          ctx.stroke();
          
          ctx.fillStyle = '#1e0b1d';
          ctx.beginPath();
          ctx.arc(centerX - 28 + gazeX*0.4, girlEyeY + gazeY*0.4, 4, 0, Math.PI*2);
          ctx.arc(centerX + 28 + gazeX*0.4, girlEyeY + gazeY*0.4, 4, 0, Math.PI*2);
          ctx.fill();
          break;
          
        case 'sleepy':
          ctx.beginPath();
          ctx.moveTo(centerX - 38, girlEyeY + 2); ctx.lineTo(centerX - 18, girlEyeY + 2);
          ctx.moveTo(centerX + 18, girlEyeY + 2); ctx.lineTo(centerX + 38, girlEyeY + 2);
          ctx.stroke();
          break;

        case 'thinking':
          ctx.beginPath();
          ctx.moveTo(centerX - 38, girlEyeY + 2); ctx.lineTo(centerX - 18, girlEyeY + 2);
          ctx.stroke();
          ctx.fillStyle = '#1e0b1d';
          ctx.beginPath();
          ctx.arc(centerX + 28 + gazeX*0.5, girlEyeY - 2 + gazeY*0.5, 8, 0, Math.PI*2);
          ctx.fill();
          break;

        case 'excited':
          this.drawPixelStar(ctx, centerX - 28 + gazeX*0.3, girlEyeY + gazeY*0.3, 10);
          this.drawPixelStar(ctx, centerX + 28 + gazeX*0.3, girlEyeY + gazeY*0.3, 10);
          break;

        case 'staring':
          // Giant fully dilated staring eye locks!
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.arc(centerX - 28, girlEyeY, 15, 0, Math.PI*2);
          ctx.arc(centerX + 28, girlEyeY, 15, 0, Math.PI*2);
          ctx.fill();
          ctx.stroke();
          
          ctx.fillStyle = '#8c7ae6'; // Glowing deep purple dilated pupils
          ctx.beginPath();
          ctx.arc(centerX - 28 + gazeX, girlEyeY + gazeY, 10, 0, Math.PI*2);
          ctx.arc(centerX + 28 + gazeX, girlEyeY + gazeY, 10, 0, Math.PI*2);
          ctx.fill();
          // Shininess
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.arc(centerX - 31 + gazeX*1.2, girlEyeY - 3 + gazeY*1.2, 3.5, 0, Math.PI*2);
          ctx.arc(centerX + 25 + gazeX*1.2, girlEyeY - 3 + gazeY*1.2, 3.5, 0, Math.PI*2);
          ctx.fill();
          break;
          
        default: // neutral
          // Large anime ellipse pupils
          ctx.fillStyle = '#1e0b1d';
          ctx.beginPath();
          ctx.ellipse(centerX - 28 + gazeX, girlEyeY + gazeY, 8, 12, 0, 0, Math.PI*2);
          ctx.ellipse(centerX + 28 + gazeX, girlEyeY + gazeY, 8, 12, 0, 0, Math.PI*2);
          ctx.fill();
          // double eye shines
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.arc(centerX - 30 + gazeX*1.2, girlEyeY - 4 + gazeY*1.2, 3.5, 0, Math.PI*2);
          ctx.arc(centerX + 26 + gazeX*1.2, girlEyeY - 4 + gazeY*1.2, 3.5, 0, Math.PI*2);
          ctx.arc(centerX - 25 + gazeX*0.8, girlEyeY + 3 + gazeY*0.8, 1.8, 0, Math.PI*2);
          ctx.arc(centerX + 31 + gazeX*0.8, girlEyeY + 3 + gazeY*0.8, 1.8, 0, Math.PI*2);
          ctx.fill();
      }
    }

    // 7. FRONT CYBER-HAIR BANGS & GLOWING STAR PIN
    ctx.fillStyle = '#ff7675'; // Front strands
    ctx.beginPath();
    ctx.moveTo(centerX - 58, centerY - 48);
    ctx.lineTo(centerX - 45, centerY - 32);
    ctx.lineTo(centerX - 34, centerY - 48);
    ctx.lineTo(centerX - 12, centerY - 20);
    ctx.lineTo(centerX, centerY - 44);
    ctx.lineTo(centerX + 12, centerY - 20);
    ctx.lineTo(centerX + 34, centerY - 48);
    ctx.lineTo(centerX + 45, centerY - 32);
    ctx.lineTo(centerX + 58, centerY - 48);
    ctx.lineTo(centerX + 60, centerY - 20);
    ctx.lineTo(centerX - 60, centerY - 20);
    ctx.closePath();
    ctx.fill();
    
    // cheek frame side locks
    ctx.beginPath();
    ctx.roundRect(centerX - 60, centerY - 20, 12, 60, 5);
    ctx.roundRect(centerX + 48, centerY - 20, 12, 60, 5);
    ctx.fill();

    // Pulsing golden hairpin star
    const starScale = 1.0 + Math.sin(this.tick * 0.1) * 0.15;
    ctx.save();
    ctx.fillStyle = '#ffd32a';
    ctx.shadowBlur = 8;
    ctx.shadowColor = '#ffd32a';
    this.drawPixelStar(ctx, centerX - 40, centerY - 32, 7 * starScale);
    ctx.restore();

    // 8. NOSE & MOUTH WITH LIP-SYNC
    ctx.fillStyle = '#ff7675'; // Tiny nose
    ctx.fillRect(centerX - 1, centerY + 8, 2, 2);

    ctx.strokeStyle = '#1e0b1d';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    
    const mouthY = centerY + 24;
    
    if (this.isTalking) {
      const speechOsc = Math.sin(this.tick * 0.3) > 0;
      if (speechOsc) {
        ctx.fillStyle = '#ff7675';
        ctx.beginPath();
        ctx.ellipse(centerX, mouthY, 5, 8, 0, 0, Math.PI*2);
        ctx.fill();
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(centerX, mouthY, 5, 0, Math.PI);
        ctx.stroke();
      }
    } else {
      if (state === 'surprised' || state === 'excited') {
        ctx.fillStyle = '#ff7675';
        ctx.beginPath();
        ctx.arc(centerX, mouthY, 6, 0, Math.PI*2);
        ctx.fill();
        ctx.stroke();
      } else if (state === 'sad' || state === 'angry') {
        ctx.beginPath();
        ctx.arc(centerX, mouthY + 4, 6, Math.PI, 0);
        ctx.stroke();
      } else if (state === 'sleepy') {
        ctx.beginPath();
        ctx.arc(centerX, mouthY, 3, 0, Math.PI*2);
        ctx.stroke();
      } else {
        // Cute anime lip smile
        ctx.beginPath();
        ctx.arc(centerX, mouthY - 2, 6, 0.15 * Math.PI, 0.85 * Math.PI);
        ctx.stroke();
      }
    }
};
