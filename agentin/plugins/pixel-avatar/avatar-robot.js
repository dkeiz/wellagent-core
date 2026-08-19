// Procedural robot renderer for PixelAvatar.

PixelAvatar.prototype.drawProceduralRobot = function() {
    const ctx = this.ctx;
    const w = 256;
    const h = 256;
    const state = this.currentState;

    ctx.fillStyle = '#06050b';
    ctx.fillRect(0, 0, w, h);
    
    const grad = ctx.createRadialGradient(w/2, h/2, 10, w/2, h/2, 120);
    grad.addColorStop(0, 'rgba(108, 92, 231, 0.18)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    let bounce = Math.sin(this.tick * 0.08) * 2;
    if (state === 'sleepy') bounce = Math.sin(this.tick * 0.04) * 1.0;
    if (state === 'excited') bounce = Math.sin(this.tick * 0.20) * 4;

    let headOffsetX = 0;
    let headOffsetY = 0;
    if (state === 'staring') {
      headOffsetX = Math.max(-8, Math.min(8, this.mouseX / 30));
      headOffsetY = Math.max(-6, Math.min(6, this.mouseY / 30));
    }

    const centerX = w / 2 + headOffsetX;
    const centerY = h / 2 + 10 + bounce + headOffsetY;

    // 1. DYNAMIC ARMS
    ctx.fillStyle = '#3a384c';
    ctx.strokeStyle = '#2c293e';
    ctx.lineWidth = 3;
    ctx.fillRect(centerX - 64, centerY + 28, 10, 12);
    
    if (this.waveTimer > 0) {
      ctx.save();
      const armAngle = -1.2 + Math.sin(this.tick * 0.35) * 0.4;
      ctx.translate(centerX + 60, centerY + 34);
      ctx.rotate(armAngle);
      ctx.fillStyle = '#4a4760';
      ctx.fillRect(-6, -34, 12, 36);
      ctx.fillStyle = '#fd79a8';
      ctx.beginPath();
      ctx.arc(0, -36, 8, 0, Math.PI*2);
      ctx.fill();
      const clawOsc = Math.abs(Math.sin(this.tick * 0.3)) * 6;
      ctx.strokeStyle = '#4a4760';
      ctx.lineWidth = 3.5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-4, -36);
      ctx.lineTo(-8 - clawOsc, -46);
      ctx.lineTo(-2 - clawOsc, -52);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(4, -36);
      ctx.lineTo(8 + clawOsc, -46);
      ctx.lineTo(2 + clawOsc, -52);
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.fillRect(centerX + 54, centerY + 28, 10, 12);
    }

    // 2. CHEST BODY
    ctx.fillStyle = '#2c293e';
    ctx.beginPath();
    ctx.roundRect(centerX - 48, centerY + 50, 96, 40, [16, 16, 0, 0]);
    ctx.fill();

    let coreColor = '#6c5ce7';
    let coreRadius = 8 + Math.sin(this.tick * 0.1) * 2;
    if (state === 'happy') coreColor = '#2ed573';
    else if (state === 'angry') coreColor = '#ff4757';
    else if (state === 'staring') coreColor = '#ffa502';
    else if (state === 'sleepy') { coreColor = '#2bcbba'; coreRadius = 6; }
    
    ctx.fillStyle = coreColor;
    ctx.shadowBlur = 10;
    ctx.shadowColor = coreColor;
    ctx.beginPath();
    ctx.arc(centerX, centerY + 65, coreRadius, 0, Math.PI*2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // 3. ANTENNA & BULB LED
    ctx.strokeStyle = '#4e4c63';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(centerX, centerY - 45);
    ctx.lineTo(centerX, centerY - 72);
    ctx.stroke();

    let bulbColor = '#fd79a8';
    let isBulbOn = this.tick % 30 < 15;
    if (state === 'thinking') {
      bulbColor = '#a55eea';
      isBulbOn = this.tick % 10 < 5;
    } else if (state === 'angry') {
      bulbColor = '#ff4757';
      isBulbOn = this.tick % 8 < 4;
    } else if (state === 'excited') {
      bulbColor = `hsl(${this.tick * 10 % 360}, 90%, 65%)`;
      isBulbOn = true;
    } else if (state === 'staring') {
      bulbColor = '#00d2d3';
      isBulbOn = this.tick % 6 < 3;
    } else if (state === 'sleepy') {
      isBulbOn = false;
    }
    
    ctx.fillStyle = isBulbOn ? bulbColor : '#232230';
    if (isBulbOn) {
      ctx.shadowBlur = 12;
      ctx.shadowColor = bulbColor;
    }
    ctx.beginPath();
    ctx.arc(centerX, centerY - 74, 10, 0, Math.PI*2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // 4. RETRO SIDE EARS
    ctx.fillStyle = '#3a384c';
    ctx.fillRect(centerX - 64, centerY - 15, 10, 30);
    ctx.fillRect(centerX + 54, centerY - 15, 10, 30);
    ctx.fillStyle = '#22212f';
    ctx.fillRect(centerX - 62, centerY - 5, 8, 10);
    ctx.fillRect(centerX + 54, centerY - 5, 8, 10);

    // 5. METALLIC SKULL
    ctx.fillStyle = '#4a4760';
    ctx.beginPath();
    ctx.roundRect(centerX - 54, centerY - 45, 108, 90, 20);
    ctx.fill();
    ctx.strokeStyle = '#5a5775';
    ctx.lineWidth = 3;
    ctx.stroke();
    
    ctx.fillStyle = '#2c293e';
    ctx.beginPath();
    ctx.arc(centerX - 44, centerY - 35, 3, 0, Math.PI*2);
    ctx.arc(centerX + 44, centerY - 35, 3, 0, Math.PI*2);
    ctx.arc(centerX - 44, centerY + 35, 3, 0, Math.PI*2);
    ctx.arc(centerX + 44, centerY + 35, 3, 0, Math.PI*2);
    ctx.fill();

    // 6. SCREEN Visor
    ctx.fillStyle = '#110e1f';
    ctx.beginPath();
    ctx.roundRect(centerX - 44, centerY - 35, 88, 70, 12);
    ctx.fill();
    
    ctx.strokeStyle = 'rgba(108, 92, 231, 0.15)';
    ctx.lineWidth = 1;
    for(let yLine = centerY - 30; yLine < centerY + 30; yLine += 4) {
      ctx.beginPath();
      ctx.moveTo(centerX - 42, yLine);
      ctx.lineTo(centerX + 42, yLine);
      ctx.stroke();
    }
    
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.beginPath();
    ctx.moveTo(centerX - 42, centerY - 33);
    ctx.lineTo(centerX + 15, centerY - 33);
    ctx.lineTo(centerX - 15, centerY + 33);
    ctx.lineTo(centerX - 42, centerY + 33);
    ctx.closePath();
    ctx.fill();

    // 7. GLOWING LED SYMBOLS
    let cyberColor = '#00d2d3';
    if (state === 'happy') cyberColor = '#2ed573';
    else if (state === 'sad') cyberColor = '#1e90ff';
    else if (state === 'angry') cyberColor = '#ff4757';
    else if (state === 'thinking') cyberColor = '#a55eea';
    else if (state === 'surprised') cyberColor = '#ffa502';
    else if (state === 'excited') cyberColor = '#fd79a8';
    else if (state === 'sleepy') cyberColor = '#2bcbba';
    else if (state === 'staring') cyberColor = '#00d2d3';

    ctx.fillStyle = cyberColor;
    ctx.shadowBlur = 8;
    ctx.shadowColor = cyberColor;
    
    const eyeY = centerY - 14;

    let gazeX = Math.max(-5, Math.min(5, this.mouseX / 32));
    let gazeY = Math.max(-4, Math.min(4, this.mouseY / 32));
    
    if (state === 'staring') {
      gazeX = Math.max(-10, Math.min(10, this.mouseX / 20));
      gazeY = Math.max(-8, Math.min(8, this.mouseY / 20));
    }

    if (this.isBlinking && state !== 'sleepy' && state !== 'surprised' && state !== 'staring') {
      ctx.fillRect(centerX - 28, eyeY, 14, 2);
      ctx.fillRect(centerX + 14, eyeY, 14, 2);
    } else {
      switch(state) {
        case 'happy':
          this.drawDigitalGrid(ctx, centerX - 25 + gazeX*0.3, eyeY - 2 + gazeY*0.3, 'happy');
          this.drawDigitalGrid(ctx, centerX + 11 + gazeX*0.3, eyeY - 2 + gazeY*0.3, 'happy');
          break;
          
        case 'sad':
          this.drawDigitalGrid(ctx, centerX - 25 + gazeX*0.4, eyeY - 2 + gazeY*0.4, 'sad');
          this.drawDigitalGrid(ctx, centerX + 11 + gazeX*0.4, eyeY - 2 + gazeY*0.4, 'sad');
          break;
          
        case 'angry':
          this.drawDigitalGrid(ctx, centerX - 25 + gazeX*0.4, eyeY - 2 + gazeY*0.4, 'angry');
          this.drawDigitalGrid(ctx, centerX + 11 + gazeX*0.4, eyeY - 2 + gazeY*0.4, 'angry');
          break;
          
        case 'surprised':
          ctx.strokeStyle = cyberColor;
          ctx.lineWidth = 3;
          ctx.strokeRect(centerX - 26 + gazeX*0.5, eyeY - 3 + gazeY*0.5, 12, 12);
          ctx.strokeRect(centerX + 14 + gazeX*0.5, eyeY - 3 + gazeY*0.5, 12, 12);
          ctx.fillStyle = cyberColor;
          break;
          
        case 'sleepy':
          ctx.fillRect(centerX - 26, eyeY + 2, 12, 3);
          ctx.fillRect(centerX + 14, eyeY + 2, 12, 3);
          break;

        case 'thinking':
          ctx.fillRect(centerX - 24 + gazeX*0.4, eyeY + gazeY*0.4, 8, 6);
          this.drawDigitalGrid(ctx, centerX + 12 + gazeX*0.4, eyeY - 2 + gazeY*0.4, 'thinking');
          break;

        case 'excited':
          this.drawDigitalGrid(ctx, centerX - 25 + gazeX*0.3, eyeY - 2 + gazeY*0.3, 'excited');
          this.drawDigitalGrid(ctx, centerX + 11 + gazeX*0.3, eyeY - 2 + gazeY*0.3, 'excited');
          break;

        case 'staring':
          ctx.strokeStyle = cyberColor;
          ctx.lineWidth = 2.5;
          ctx.strokeRect(centerX - 27 + gazeX, eyeY - 4 + gazeY, 14, 14);
          ctx.beginPath();
          ctx.moveTo(centerX - 20 + gazeX, eyeY - 4 + gazeY);
          ctx.lineTo(centerX - 20 + gazeX, eyeY + 10 + gazeY);
          ctx.moveTo(centerX - 27 + gazeX, eyeY + 3 + gazeY);
          ctx.lineTo(centerX - 13 + gazeX, eyeY + 3 + gazeY);
          ctx.stroke();
          ctx.strokeRect(centerX + 13 + gazeX, eyeY - 4 + gazeY, 14, 14);
          ctx.beginPath();
          ctx.moveTo(centerX + 20 + gazeX, eyeY - 4 + gazeY);
          ctx.lineTo(centerX + 20 + gazeX, eyeY + 10 + gazeY);
          ctx.moveTo(centerX + 13 + gazeX, eyeY + 3 + gazeY);
          ctx.lineTo(centerX + 27 + gazeX, eyeY + 3 + gazeY);
          ctx.stroke();
          ctx.fillStyle = cyberColor;
          break;
          
        default: // neutral
          ctx.fillRect(centerX - 26 + gazeX, eyeY - 2 + gazeY, 12, 8);
          ctx.fillRect(centerX + 14 + gazeX, eyeY - 2 + gazeY, 12, 8);
      }
    }

    // 8. WAVEFORM MOUTH
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = cyberColor;
    ctx.lineCap = 'round';
    
    const mouthY = centerY + 16;
    ctx.beginPath();
    
    if (this.isTalking) {
      ctx.shadowBlur = 0;
      for(let bar = -15; bar <= 15; bar += 5) {
        let barHeight = 4 + Math.abs(Math.sin(bar*0.5 + this.tick * 0.4) * 16);
        ctx.fillStyle = cyberColor;
        ctx.fillRect(centerX + bar - 1.5, mouthY - barHeight/2, 3, barHeight);
      }
      ctx.shadowBlur = 8;
    } else {
      if (state === 'happy') {
        ctx.arc(centerX, mouthY - 4, 10, 0, Math.PI);
      } else if (state === 'sad' || state === 'angry') {
        ctx.arc(centerX, mouthY + 8, 8, Math.PI, 0);
      } else if (state === 'sleepy') {
        ctx.moveTo(centerX - 15, mouthY);
        ctx.lineTo(centerX + 15, mouthY);
      } else if (state === 'surprised') {
        ctx.fillRect(centerX - 6, mouthY - 4, 12, 10);
      } else if (state === 'thinking') {
        ctx.moveTo(centerX - 16, mouthY);
        for(let xPos = -16; xPos <= 16; xPos += 2) {
          ctx.lineTo(centerX + xPos, mouthY + Math.sin(xPos * 0.4 + this.tick * 0.25) * 3);
        }
      } else if (state === 'excited') {
        ctx.shadowBlur = 0;
        for(let bar = -15; bar <= 15; bar += 5) {
          let barHeight = 4 + Math.abs(Math.sin(bar + this.tick * 0.22) * 12);
          ctx.fillStyle = cyberColor;
          ctx.fillRect(centerX + bar - 1.5, mouthY - barHeight/2, 3, barHeight);
        }
        ctx.shadowBlur = 8;
      } else if (state === 'staring') {
        ctx.moveTo(centerX - 10, mouthY - 2);
        ctx.lineTo(centerX - 5, mouthY + 2);
        ctx.lineTo(centerX + 5, mouthY + 2);
        ctx.lineTo(centerX + 10, mouthY - 2);
      } else {
        ctx.moveTo(centerX - 16, mouthY);
        ctx.lineTo(centerX - 8, mouthY);
        ctx.lineTo(centerX - 4, mouthY + Math.sin(this.tick * 0.15) * 3);
        ctx.lineTo(centerX, mouthY);
        ctx.lineTo(centerX + 4, mouthY + Math.cos(this.tick * 0.15) * 3);
        ctx.lineTo(centerX + 8, mouthY);
        ctx.lineTo(centerX + 16, mouthY);
      }
    }
    
    ctx.stroke();
    ctx.shadowBlur = 0;
};
