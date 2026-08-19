// Shared procedural drawing helpers for PixelAvatar.

PixelAvatar.prototype.drawPixelStar = function(ctx, cx, cy, size) {
    ctx.save();
    ctx.fillStyle = '#1e0b1d';
    ctx.beginPath();
    ctx.moveTo(cx, cy - size);
    ctx.lineTo(cx + size/3, cy - size/3);
    ctx.lineTo(cx + size, cy);
    ctx.lineTo(cx + size/3, cy + size/3);
    ctx.lineTo(cx, cy + size);
    ctx.lineTo(cx - size/3, cy + size/3);
    ctx.lineTo(cx - size, cy);
    ctx.lineTo(cx - size/3, cy - size/3);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
};

PixelAvatar.prototype.drawDigitalGrid = function(ctx, x, y, type) {
    ctx.save();
    const scale = 2.0;
    const grid = {
      happy: [
        [0, 1, 1, 1, 1, 0],
        [1, 0, 0, 0, 0, 1],
        [1, 0, 0, 0, 0, 1],
        [0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0],
      ],
      sad: [
        [1, 0, 0, 0, 0, 1],
        [0, 1, 0, 0, 1, 0],
        [0, 0, 1, 1, 0, 0],
        [0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0],
      ],
      angry: [
        [1, 0, 0, 0, 0, 1],
        [0, 1, 0, 0, 1, 0],
        [0, 0, 1, 1, 0, 0],
        [0, 1, 1, 1, 1, 0],
        [1, 0, 0, 0, 0, 1],
        [1, 0, 0, 0, 0, 1],
      ],
      thinking: [
        [0, 1, 1, 1, 1, 0],
        [0, 0, 0, 0, 1, 0],
        [0, 0, 1, 1, 1, 0],
        [0, 0, 1, 0, 0, 0],
        [0, 0, 0, 0, 0, 0],
        [0, 0, 1, 0, 0, 0],
      ],
      excited: [
        [0, 0, 1, 1, 0, 0],
        [0, 0, 1, 1, 0, 0],
        [1, 1, 1, 1, 1, 1],
        [1, 1, 1, 1, 1, 1],
        [0, 0, 1, 1, 0, 0],
        [0, 0, 1, 1, 0, 0],
      ]
    };
    
    const matrix = grid[type];
    if (matrix) {
      for(let r = 0; r < 6; r++) {
        for(let c = 0; c < 6; c++) {
          if (matrix[r][c] === 1) {
            ctx.fillRect(x + c * scale, y + r * scale, scale, scale);
          }
        }
      }
    }
    ctx.restore();
};
