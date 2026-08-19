// Procedural cat renderer for PixelAvatar.

PixelAvatar.prototype.drawProceduralCat = function() {
    const ctx = this.ctx;
    const w = 256;
    const h = 256;
    const state = this.currentState;
    
    ctx.fillStyle = '#0b0918';
    ctx.fillRect(0, 0, w, h);
    
    const grad = ctx.createRadialGradient(w/2, h/2, 10, w/2, h/2, 120);
    grad.addColorStop(0, 'rgba(253, 121, 168, 0.18)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Apply breathing bounce animation
    let bounce = Math.sin(this.tick * 0.05) * 2.5;
    if (state === 'sleepy') bounce = Math.sin(this.tick * 0.03) * 1.5;
    if (state === 'excited') bounce = Math.sin(this.tick * 0.16) * 5;

    let headOffsetX = 0;
    let headOffsetY = 0;
    if (state === 'staring') {
      headOffsetX = Math.max(-8, Math.min(8, this.mouseX / 30));
      headOffsetY = Math.max(-6, Math.min(6, this.mouseY / 30));
    }

    const centerX = w / 2 + headOffsetX;
    const centerY = h / 2 + 10 + bounce + headOffsetY;

    // 1. SWAYING CAT TAIL
    ctx.save();
    ctx.lineWidth = 14;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#e28f9c'; // tail shadow
    ctx.beginPath();
    ctx.moveTo(centerX + 35, centerY + 30);
    
    let tailSpeed = 0.05;
    if (state === 'excited') tailSpeed = 0.15;
    if (state === 'angry') tailSpeed = 0.18;
    
    const tailSwing = Math.sin(this.tick * tailSpeed) * (state === 'angry' ? 26 : 18);
    const tailHeight = state === 'angry' ? 18 : state === 'excited' ? 42 : 16;
    ctx.bezierCurveTo(
      centerX + 50 + tailSwing * 0.5, centerY + 10,
      centerX + 62 + tailSwing, centerY - tailHeight,
      centerX + 52 + tailSwing * 1.1, centerY - tailHeight - 12
    );
    ctx.stroke();
    ctx.lineWidth = 8;
    ctx.strokeStyle = '#ff9fbc'; // cat primary pink
    ctx.stroke();
    ctx.restore();

    // 2. BELL COLLAR
    ctx.fillStyle = '#ff4757'; // Red collar strap
    ctx.beginPath();
    ctx.roundRect(centerX - 35, centerY + 35, 70, 8, 4);
    ctx.fill();
    // Shiny gold bell
    ctx.fillStyle = '#ffd32a';
    ctx.strokeStyle = '#ffa502';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(centerX, centerY + 39, 7, 0, Math.PI*2);
    ctx.fill();
    ctx.stroke();
    // Bell eyelet dot
    ctx.fillStyle = '#222';
    ctx.beginPath();
    ctx.arc(centerX, centerY + 41, 1.5, 0, Math.PI*2);
    ctx.fill();

    // 3. PAWS & WAVE ACTION HAND
    ctx.fillStyle = '#ffb3c6'; // paw pink
    ctx.fillRect(centerX - 42, h / 2 + 65 + bounce * 0.5, 22, 14);

    if (this.waveTimer > 0) {
      ctx.save();
      const waveAngle = Math.sin(this.tick * 0.25) * 0.6;
      ctx.translate(centerX + 40, centerY + 20);
      ctx.rotate(waveAngle);
      ctx.fillStyle = '#ff9fbc';
      ctx.beginPath();
      ctx.roundRect(-10, -32, 22, 34, 10);
      ctx.fill();
      ctx.fillStyle = '#ffb3c6';
      ctx.beginPath();
      ctx.arc(1, -24, 5, 0, Math.PI*2);
      ctx.arc(-4, -16, 2.5, 0, Math.PI*2);
      ctx.arc(1, -12, 2.5, 0, Math.PI*2);
      ctx.arc(6, -16, 2.5, 0, Math.PI*2);
      ctx.fill();
      ctx.restore();
    } else {
      ctx.fillRect(centerX + 20, h / 2 + 65 + bounce * 0.5, 22, 14);
    }

    // 4. POINTY EARS WITH FLUFFY HAIRS
    ctx.fillStyle = '#ff7096';
    // Left ear
    ctx.beginPath();
    let lEarOffset = this.earTwitchLeft ? -3 : 0;
    if (state === 'angry') lEarOffset = -8;
    ctx.moveTo(centerX - 50, centerY - 20);
    ctx.lineTo(centerX - 46 + lEarOffset, centerY - 66);
    ctx.lineTo(centerX - 15, centerY - 38);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#ffb3c6';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(centerX - 46 + lEarOffset, centerY - 66);
    ctx.lineTo(centerX - 49 + lEarOffset, centerY - 72);
    ctx.moveTo(centerX - 46 + lEarOffset, centerY - 66);
    ctx.lineTo(centerX - 43 + lEarOffset, centerY - 71);
    ctx.stroke();

    // Right ear
    ctx.fillStyle = '#ff7096';
    ctx.beginPath();
    let rEarOffset = this.earTwitchRight ? 3 : 0;
    if (state === 'angry') rEarOffset = 8;
    ctx.moveTo(centerX + 15, centerY - 38);
    ctx.lineTo(centerX + 46 + rEarOffset, centerY - 66);
    ctx.lineTo(centerX + 50, centerY - 20);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(centerX + 46 + rEarOffset, centerY - 66);
    ctx.lineTo(centerX + 43 + rEarOffset, centerY - 72);
    ctx.moveTo(centerX + 46 + rEarOffset, centerY - 66);
    ctx.lineTo(centerX + 49 + rEarOffset, centerY - 71);
    ctx.stroke();

    // Inner ears pink
    ctx.fillStyle = '#ffccd5';
    // Left inner
    ctx.beginPath();
    ctx.moveTo(centerX - 42, centerY - 24);
    ctx.lineTo(centerX - 40 + lEarOffset * 0.8, centerY - 58);
    ctx.lineTo(centerX - 22, centerY - 35);
    ctx.closePath();
    ctx.fill();
    // Right inner
    ctx.beginPath();
    ctx.moveTo(centerX + 22, centerY - 35);
    ctx.lineTo(centerX + 40 + rEarOffset * 0.8, centerY - 58);
    ctx.lineTo(centerX + 42, centerY - 24);
    ctx.closePath();
    ctx.fill();

    // 5. MAIN HEAD ROUNDED SHAPE
    ctx.fillStyle = '#ff9fbc';
    ctx.beginPath();
    ctx.roundRect(centerX - 55, centerY - 45, 110, 85, 30);
    ctx.fill();
    
    // Chin shading lines
    ctx.fillStyle = 'rgba(226, 143, 156, 0.3)';
    ctx.beginPath();
    ctx.roundRect(centerX - 40, centerY + 30, 80, 10, 8);
    ctx.fill();

    // 6. CHEEKS
    ctx.fillStyle = '#ff7096';
    ctx.beginPath();
    ctx.arc(centerX - 36, centerY + 12, 10, 0, Math.PI*2);
    ctx.arc(centerX + 36, centerY + 12, 10, 0, Math.PI*2);
    ctx.fill();

    // 7. EYES & CURSOR MOUSE-TRACKING GAZE
    const eyeY = centerY - 10;
    
    let gazeX = Math.max(-5, Math.min(5, this.mouseX / 32));
    let gazeY = Math.max(-4, Math.min(4, this.mouseY / 32));
    
    if (state === 'staring') {
      gazeX = Math.max(-10, Math.min(10, this.mouseX / 20));
      gazeY = Math.max(-8, Math.min(8, this.mouseY / 20));
    }

    if (this.isBlinking && state !== 'sleepy' && state !== 'surprised' && state !== 'staring') {
      ctx.fillStyle = '#1e0b1d';
      ctx.fillRect(centerX - 35, eyeY, 14, 3);
      ctx.fillRect(centerX + 21, eyeY, 14, 3);
    } else {
      switch(state) {
        case 'happy':
          ctx.strokeStyle = '#1e0b1d';
          ctx.lineWidth = 4.5;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.arc(centerX - 28 + gazeX*0.3, eyeY + 4 + gazeY*0.3, 8, Math.PI, 0);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(centerX + 28 + gazeX*0.3, eyeY + 4 + gazeY*0.3, 8, Math.PI, 0);
          ctx.stroke();
          break;
          
        case 'sad':
          ctx.strokeStyle = '#1e0b1d';
          ctx.lineWidth = 4.5;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(centerX - 34 + gazeX*0.4, eyeY - 2 + gazeY*0.4);
          ctx.lineTo(centerX - 22 + gazeX*0.4, eyeY + 6 + gazeY*0.4);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(centerX + 34 + gazeX*0.4, eyeY - 2 + gazeY*0.4);
          ctx.lineTo(centerX + 22 + gazeX*0.4, eyeY + 6 + gazeY*0.4);
          ctx.stroke();
          
          ctx.fillStyle = '#1e90ff';
          ctx.fillRect(centerX - 26, eyeY + 10 + Math.sin(this.tick * 0.15)*3, 5, 8);
          ctx.fillRect(centerX + 21, eyeY + 10 + Math.cos(this.tick * 0.15)*3, 5, 8);
          break;
          
        case 'angry':
          ctx.strokeStyle = '#1e0b1d';
          ctx.lineWidth = 4.5;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(centerX - 34 + gazeX*0.4, eyeY - 4 + gazeY*0.4);
          ctx.lineTo(centerX - 24 + gazeX*0.4, eyeY + 2 + gazeY*0.4);
          ctx.lineTo(centerX - 34 + gazeX*0.4, eyeY + 8 + gazeY*0.4);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(centerX + 34 + gazeX*0.4, eyeY - 4 + gazeY*0.4);
          ctx.lineTo(centerX + 24 + gazeX*0.4, eyeY + 2 + gazeY*0.4);
          ctx.lineTo(centerX + 34 + gazeX*0.4, eyeY + 8 + gazeY*0.4);
          ctx.stroke();
          break;

        case 'surprised':
          ctx.fillStyle = '#1e0b1d';
          ctx.beginPath();
          ctx.arc(centerX - 28 + gazeX*0.6, eyeY + 2 + gazeY*0.6, 9, 0, Math.PI*2);
          ctx.arc(centerX + 28 + gazeX*0.6, eyeY + 2 + gazeY*0.6, 9, 0, Math.PI*2);
          ctx.fill();
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.arc(centerX - 26 + gazeX*0.9, eyeY + gazeY*0.9, 3, 0, Math.PI*2);
          ctx.arc(centerX + 30 + gazeX*0.9, eyeY + gazeY*0.9, 3, 0, Math.PI*2);
          ctx.fill();
          break;

        case 'sleepy':
          ctx.fillStyle = '#1e0b1d';
          ctx.fillRect(centerX - 34, eyeY + 2, 12, 3);
          ctx.fillRect(centerX + 22, eyeY + 2, 12, 3);
          break;
          
        case 'thinking':
          ctx.fillStyle = '#1e0b1d';
          ctx.fillRect(centerX - 34, eyeY + 2, 12, 3); // Left squint
          ctx.beginPath();
          ctx.arc(centerX + 28 + gazeX*0.5, eyeY - 2 + gazeY*0.5, 6, 0, Math.PI*2);
          ctx.fill();
          break;
          
        case 'excited':
          this.drawPixelStar(ctx, centerX - 28 + gazeX*0.3, eyeY + 2 + gazeY*0.3, 8);
          this.drawPixelStar(ctx, centerX + 28 + gazeX*0.3, eyeY + 2 + gazeY*0.3, 8);
          break;

        case 'staring':
          ctx.fillStyle = '#1e0b1d';
          ctx.beginPath();
          ctx.arc(centerX - 28 + gazeX, eyeY + gazeY, 13, 0, Math.PI*2);
          ctx.arc(centerX + 28 + gazeX, eyeY + gazeY, 13, 0, Math.PI*2);
          ctx.fill();
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.arc(centerX - 28 + gazeX * 1.2, eyeY + gazeY * 1.2, 3, 0, Math.PI*2);
          ctx.arc(centerX + 28 + gazeX * 1.2, eyeY + gazeY * 1.2, 3, 0, Math.PI*2);
          ctx.fill();
          break;
          
        default: // neutral
          ctx.fillStyle = '#1e0b1d';
          ctx.beginPath();
          ctx.arc(centerX - 28 + gazeX, eyeY + 2 + gazeY, 6.5, 0, Math.PI*2);
          ctx.arc(centerX + 28 + gazeX, eyeY + 2 + gazeY, 6.5, 0, Math.PI*2);
          ctx.fill();
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.arc(centerX - 30 + gazeX * 1.2, eyeY + gazeY * 1.2, 2.2, 0, Math.PI*2);
          ctx.arc(centerX + 26 + gazeX * 1.2, eyeY + gazeY * 1.2, 2.2, 0, Math.PI*2);
          ctx.fill();
      }
    }

    // 8. CUTE NOSE & DYNAMIC LIP-SYNC TALKING MOUTH
    ctx.fillStyle = '#ff7096';
    ctx.beginPath();
    ctx.moveTo(centerX - 4, centerY + 2);
    ctx.lineTo(centerX + 4, centerY + 2);
    ctx.lineTo(centerX, centerY + 6);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = '#1e0b1d';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    
    if (this.isTalking) {
      const speechOsc = Math.sin(this.tick * 0.3) > 0;
      if (speechOsc) {
        ctx.fillStyle = '#ff7096';
        ctx.beginPath();
        ctx.arc(centerX, centerY + 12, 6, 0, Math.PI*2);
        ctx.fill();
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(centerX - 5, centerY + 8, 5, 0, Math.PI);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(centerX + 5, centerY + 8, 5, 0, Math.PI);
        ctx.stroke();
      }
    } else {
      if (state === 'surprised' || state === 'excited') {
        ctx.fillStyle = '#ff7096';
        ctx.beginPath();
        const mouthRadius = state === 'excited' ? 8 : 5;
        ctx.arc(centerX, centerY + 12, mouthRadius, 0, Math.PI*2);
        ctx.fill();
        ctx.stroke();
      } else if (state === 'sad' || state === 'angry') {
        ctx.beginPath();
        ctx.arc(centerX, centerY + 16, 6, Math.PI, 0);
        ctx.stroke();
      } else if (state === 'sleepy') {
        ctx.beginPath();
        ctx.arc(centerX, centerY + 12, 3, 0, Math.PI*2);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(centerX - 5, centerY + 8, 5, 0, Math.PI);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(centerX + 5, centerY + 8, 5, 0, Math.PI);
        ctx.stroke();
      }
    }

    // 9. WHISKERS
    ctx.strokeStyle = 'rgba(30, 11, 29, 0.25)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(centerX - 48, centerY + 6);
    ctx.lineTo(centerX - 72, centerY + 4);
    ctx.moveTo(centerX - 48, centerY + 14);
    ctx.lineTo(centerX - 70, centerY + 18);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(centerX + 48, centerY + 6);
    ctx.lineTo(centerX + 72, centerY + 4);
    ctx.moveTo(centerX + 48, centerY + 14);
    ctx.lineTo(centerX + 70, centerY + 18);
    ctx.stroke();
};
