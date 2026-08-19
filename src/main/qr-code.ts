// @ts-nocheck
"use strict";

const ECC_MEDIUM = "M";
const QUIET_ZONE_MODULES = 4;
const MODE_BYTE = 0x4;

const BYTE_CAPACITIES = {
  M: [0, 14, 26, 42, 62, 84, 106, 122, 152, 180, 213]
};

const TOTAL_CODEWORDS = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
const ALIGNMENT_POSITIONS = [
  null,
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50]
];

const BLOCK_LAYOUTS = {
  M: [
    null,
    { ecCodewordsPerBlock: 10, groups: [[1, 16]] },
    { ecCodewordsPerBlock: 16, groups: [[1, 28]] },
    { ecCodewordsPerBlock: 26, groups: [[1, 44]] },
    { ecCodewordsPerBlock: 18, groups: [[2, 32]] },
    { ecCodewordsPerBlock: 24, groups: [[2, 43]] },
    { ecCodewordsPerBlock: 16, groups: [[4, 27]] },
    { ecCodewordsPerBlock: 18, groups: [[4, 31]] },
    { ecCodewordsPerBlock: 22, groups: [[2, 38], [2, 39]] },
    { ecCodewordsPerBlock: 22, groups: [[3, 36], [2, 37]] },
    { ecCodewordsPerBlock: 26, groups: [[4, 43], [1, 44]] }
  ]
};

const GF_EXP = new Array(512).fill(0);
const GF_LOG = new Array(256).fill(0);

for (let i = 0, value = 1; i < 255; i += 1) {
  GF_EXP[i] = value;
  GF_LOG[value] = i;
  value <<= 1;
  if (value & 0x100) value ^= 0x11d;
}
for (let i = 255; i < GF_EXP.length; i += 1) {
  GF_EXP[i] = GF_EXP[i - 255];
}

function gfMultiply(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function buildGeneratorPolynomial(degree) {
  let polynomial = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(polynomial.length + 1).fill(0);
    for (let j = 0; j < polynomial.length; j += 1) {
      next[j] ^= gfMultiply(polynomial[j], GF_EXP[i]);
      next[j + 1] ^= polynomial[j];
    }
    polynomial = next;
  }
  return polynomial;
}

function computeErrorCorrection(data, degree) {
  const generator = buildGeneratorPolynomial(degree);
  const remainder = new Array(degree).fill(0);

  for (const value of data) {
    const factor = value ^ remainder[0];
    remainder.shift();
    remainder.push(0);
    for (let i = 0; i < degree; i += 1) {
      remainder[i] ^= gfMultiply(generator[i + 1], factor);
    }
  }

  return remainder;
}

function toUtf8Bytes(text) {
  return Array.from(Buffer.from(String(text || ""), "utf8"));
}

function appendBits(target, value, bitCount) {
  for (let i = bitCount - 1; i >= 0; i -= 1) {
    target.push((value >>> i) & 1);
  }
}

function bitsToCodewords(bits) {
  const output = [];
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j += 1) {
      value = (value << 1) | (bits[i + j] || 0);
    }
    output.push(value);
  }
  return output;
}

function getCharCountBitLength(version) {
  return version <= 9 ? 8 : 16;
}

function chooseVersion(textBytes, eccLevel) {
  const capacities = BYTE_CAPACITIES[eccLevel];
  if (!capacities) {
    throw new Error(`Unsupported QR error correction level: ${eccLevel}`);
  }
  for (let version = 1; version < capacities.length; version += 1) {
    if (textBytes.length <= capacities[version]) {
      return version;
    }
  }
  throw new Error("QR payload is too long for the built-in generator");
}

function buildDataCodewords(textBytes, version, eccLevel) {
  const layout = BLOCK_LAYOUTS[eccLevel]?.[version];
  if (!layout) throw new Error(`Missing QR block layout for version ${version}`);

  const dataCodewordCount = layout.groups.reduce((sum, [count, size]) => sum + (count * size), 0);
  const bits = [];
  appendBits(bits, MODE_BYTE, 4);
  appendBits(bits, textBytes.length, getCharCountBitLength(version));
  for (const value of textBytes) appendBits(bits, value, 8);

  const maxBitLength = dataCodewordCount * 8;
  appendBits(bits, 0, Math.min(4, maxBitLength - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);

  let padIndex = 0;
  const padBytes = [0xec, 0x11];
  while ((bits.length / 8) < dataCodewordCount) {
    appendBits(bits, padBytes[padIndex % 2], 8);
    padIndex += 1;
  }

  return bitsToCodewords(bits);
}

function interleaveCodewords(dataCodewords, version, eccLevel) {
  const layout = BLOCK_LAYOUTS[eccLevel]?.[version];
  if (!layout) throw new Error(`Missing QR block layout for version ${version}`);

  const blocks = [];
  let offset = 0;
  for (const [count, dataSize] of layout.groups) {
    for (let i = 0; i < count; i += 1) {
      const data = dataCodewords.slice(offset, offset + dataSize);
      offset += dataSize;
      blocks.push({
        data,
        ecc: computeErrorCorrection(data, layout.ecCodewordsPerBlock)
      });
    }
  }

  const output = [];
  const maxDataLength = Math.max(...blocks.map(block => block.data.length));
  for (let i = 0; i < maxDataLength; i += 1) {
    for (const block of blocks) {
      if (i < block.data.length) output.push(block.data[i]);
    }
  }
  for (let i = 0; i < layout.ecCodewordsPerBlock; i += 1) {
    for (const block of blocks) {
      output.push(block.ecc[i]);
    }
  }

  return output;
}

function codewordsToBits(codewords) {
  const bits = [];
  for (const value of codewords) appendBits(bits, value, 8);
  return bits;
}

function createMatrix(size, fill = false) {
  return Array.from({ length: size }, () => new Array(size).fill(fill));
}

function cloneMatrix(matrix) {
  return matrix.map(row => row.slice());
}

function makeQrBase(version) {
  const size = (version * 4) + 17;
  return {
    version,
    size,
    modules: createMatrix(size, false),
    functionModules: createMatrix(size, false)
  };
}

function setFunctionModule(qr, x, y, value) {
  if (x < 0 || y < 0 || x >= qr.size || y >= qr.size) return;
  qr.modules[y][x] = Boolean(value);
  qr.functionModules[y][x] = true;
}

function drawFinder(qr, centerX, centerY) {
  for (let dy = -4; dy <= 4; dy += 1) {
    for (let dx = -4; dx <= 4; dx += 1) {
      const x = centerX + dx;
      const y = centerY + dy;
      const distance = Math.max(Math.abs(dx), Math.abs(dy));
      setFunctionModule(qr, x, y, distance !== 2 && distance !== 4);
    }
  }
}

function drawAlignment(qr, centerX, centerY) {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      const distance = Math.max(Math.abs(dx), Math.abs(dy));
      setFunctionModule(qr, centerX + dx, centerY + dy, distance !== 1);
    }
  }
}

function drawTiming(qr) {
  for (let i = 8; i < qr.size - 8; i += 1) {
    setFunctionModule(qr, i, 6, i % 2 === 0);
    setFunctionModule(qr, 6, i, i % 2 === 0);
  }
}

function reserveFormatAreas(qr) {
  for (let i = 0; i < 9; i += 1) {
    if (i !== 6) {
      qr.functionModules[8][i] = true;
      qr.functionModules[i][8] = true;
    }
  }
  for (let i = 0; i < 8; i += 1) {
    qr.functionModules[qr.size - 1 - i][8] = true;
    qr.functionModules[8][qr.size - 1 - i] = true;
  }
  qr.modules[8][qr.size - 8] = true;
  qr.functionModules[8][qr.size - 8] = true;
}

function drawVersionInfo(qr) {
  if (qr.version < 7) return;
  let data = qr.version << 12;
  let remainder = data;
  for (let i = 0; i < 6; i += 1) {
    if (((remainder >>> (17 - i)) & 1) !== 0) {
      remainder ^= 0x1f25 << (5 - i);
    }
  }
  const bits = (qr.version << 12) | remainder;

  for (let i = 0; i < 18; i += 1) {
    const bit = ((bits >>> i) & 1) !== 0;
    const a = qr.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    setFunctionModule(qr, a, b, bit);
    setFunctionModule(qr, b, a, bit);
  }
}

function drawFunctionPatterns(qr) {
  drawFinder(qr, 3, 3);
  drawFinder(qr, qr.size - 4, 3);
  drawFinder(qr, 3, qr.size - 4);
  drawTiming(qr);

  const positions = ALIGNMENT_POSITIONS[qr.version] || [];
  for (const x of positions) {
    for (const y of positions) {
      const overlapsFinder = (
        (x <= 8 && y <= 8)
        || (x >= qr.size - 8 && y <= 8)
        || (x <= 8 && y >= qr.size - 8)
      );
      if (!overlapsFinder) drawAlignment(qr, x, y);
    }
  }

  setFunctionModule(qr, 8, qr.size - 8, true);
  reserveFormatAreas(qr);
  drawVersionInfo(qr);
}

function drawData(qr, bits) {
  let bitIndex = 0;
  let upward = true;

  for (let right = qr.size - 1; right >= 1; right -= 2) {
    if (right === 6) right -= 1;
    for (let i = 0; i < qr.size; i += 1) {
      const y = upward ? (qr.size - 1 - i) : i;
      for (let columnOffset = 0; columnOffset < 2; columnOffset += 1) {
        const x = right - columnOffset;
        if (qr.functionModules[y][x]) continue;
        qr.modules[y][x] = bitIndex < bits.length ? bits[bitIndex] === 1 : false;
        bitIndex += 1;
      }
    }
    upward = !upward;
  }
}

function maskBit(mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return ((((x * y) % 2) + ((x * y) % 3)) % 2) === 0;
    case 7: return ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0;
    default: throw new Error(`Unsupported QR mask ${mask}`);
  }
}

function applyMask(modules, functionModules, mask) {
  for (let y = 0; y < modules.length; y += 1) {
    for (let x = 0; x < modules.length; x += 1) {
      if (!functionModules[y][x] && maskBit(mask, x, y)) {
        modules[y][x] = !modules[y][x];
      }
    }
  }
}

function getFormatBits(mask) {
  const data = mask;
  let remainder = data << 10;
  for (let i = 4; i >= 0; i -= 1) {
    if (((remainder >>> (i + 10)) & 1) !== 0) {
      remainder ^= 0x537 << i;
    }
  }
  return ((data << 10) | remainder) ^ 0x5412;
}

function drawFormatBits(modules, mask) {
  const size = modules.length;
  const bits = getFormatBits(mask);
  const rowPositions = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]
  ];
  const mirrorPositions = [
    [size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8], [size - 5, 8], [size - 6, 8], [size - 7, 8], [8, size - 8],
    [8, size - 7], [8, size - 6], [8, size - 5], [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1]
  ];

  for (let i = 0; i < 15; i += 1) {
    const bit = ((bits >>> i) & 1) !== 0;
    const [x1, y1] = rowPositions[i];
    const [x2, y2] = mirrorPositions[i];
    modules[y1][x1] = bit;
    modules[y2][x2] = bit;
  }
}

function getPenaltyScore(modules) {
  const size = modules.length;
  let penalty = 0;

  const applyRunPenalty = (getter) => {
    for (let major = 0; major < size; major += 1) {
      let runColor = getter(major, 0);
      let runLength = 1;
      for (let minor = 1; minor < size; minor += 1) {
        const color = getter(major, minor);
        if (color === runColor) {
          runLength += 1;
        } else {
          if (runLength >= 5) penalty += 3 + (runLength - 5);
          runColor = color;
          runLength = 1;
        }
      }
      if (runLength >= 5) penalty += 3 + (runLength - 5);
    }
  };

  applyRunPenalty((row, col) => modules[row][col]);
  applyRunPenalty((col, row) => modules[row][col]);

  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const color = modules[y][x];
      if (
        color === modules[y][x + 1]
        && color === modules[y + 1][x]
        && color === modules[y + 1][x + 1]
      ) {
        penalty += 3;
      }
    }
  }

  const patternA = "10111010000";
  const patternB = "00001011101";
  const checkPatternPenalty = (getter) => {
    for (let major = 0; major < size; major += 1) {
      let line = "";
      for (let minor = 0; minor < size; minor += 1) {
        line += getter(major, minor) ? "1" : "0";
      }
      for (let i = 0; i <= line.length - 11; i += 1) {
        const window = line.slice(i, i + 11);
        if (window === patternA || window === patternB) penalty += 40;
      }
    }
  };

  checkPatternPenalty((row, col) => modules[row][col]);
  checkPatternPenalty((col, row) => modules[row][col]);

  let darkCount = 0;
  for (const row of modules) {
    for (const module of row) {
      if (module) darkCount += 1;
    }
  }
  const totalCount = size * size;
  penalty += Math.floor(Math.abs((darkCount * 20) - (totalCount * 10)) / totalCount) * 10;

  return penalty;
}

function finalizeModules(qr) {
  let bestModules = null;
  let bestMask = 0;
  let bestPenalty = Number.POSITIVE_INFINITY;

  for (let mask = 0; mask < 8; mask += 1) {
    const modules = cloneMatrix(qr.modules);
    applyMask(modules, qr.functionModules, mask);
    drawFormatBits(modules, mask);
    const penalty = getPenaltyScore(modules);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = mask;
      bestModules = modules;
    }
  }

  return {
    modules: bestModules,
    mask: bestMask,
    penalty: bestPenalty
  };
}

function makeQrModules(text, eccLevel = ECC_MEDIUM) {
  const textBytes = toUtf8Bytes(text);
  const version = chooseVersion(textBytes, eccLevel);
  const base = makeQrBase(version);
  drawFunctionPatterns(base);
  const dataCodewords = buildDataCodewords(textBytes, version, eccLevel);
  const interleavedCodewords = interleaveCodewords(dataCodewords, version, eccLevel);
  drawData(base, codewordsToBits(interleavedCodewords));
  const finalized = finalizeModules(base);

  return {
    version,
    size: base.size,
    modules: finalized.modules,
    mask: finalized.mask
  };
}

function renderSvg(modules, options = {}) {
  const border = Number.isFinite(options.border) ? Number(options.border) : QUIET_ZONE_MODULES;
  const scale = Number.isFinite(options.scale) ? Number(options.scale) : 8;
  const size = modules.length + (border * 2);
  const dimension = size * scale;
  let path = "";

  for (let y = 0; y < modules.length; y += 1) {
    for (let x = 0; x < modules.length; x += 1) {
      if (!modules[y][x]) continue;
      const xPos = (x + border) * scale;
      const yPos = (y + border) * scale;
      path += `M${xPos},${yPos}h${scale}v${scale}h-${scale}z`;
    }
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dimension} ${dimension}" role="img" aria-label="QR code">`,
    `<rect width="${dimension}" height="${dimension}" fill="#ffffff"/>`,
    `<path d="${path}" fill="#000000"/>`,
    "</svg>"
  ].join("");
}

function renderTerminal(modules, options = {}) {
  const border = Number.isFinite(options.border) ? Number(options.border) : 2;
  const width = modules.length + (border * 2);
  const height = modules.length + (border * 2);
  const padded = createMatrix(height, false);

  for (let y = 0; y < modules.length; y += 1) {
    for (let x = 0; x < modules.length; x += 1) {
      padded[y + border][x + border] = modules[y][x];
    }
  }

  const lines = [];
  for (let y = 0; y < height; y += 2) {
    let line = "";
    for (let x = 0; x < width; x += 1) {
      const top = padded[y][x];
      const bottom = y + 1 < height ? padded[y + 1][x] : false;
      if (top && bottom) line += "█";
      else if (top) line += "▀";
      else if (bottom) line += "▄";
      else line += " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}

function renderQrPayload(text, options = {}) {
  const payload = String(text || "").trim();
  if (!payload) {
    throw new Error("QR payload is empty");
  }
  const qr = makeQrModules(payload, options.eccLevel || ECC_MEDIUM);
  return {
    payload,
    version: qr.version,
    size: qr.size,
    modules: qr.modules,
    svg: renderSvg(qr.modules, options.svg || {}),
    terminal: renderTerminal(qr.modules, options.terminal || {})
  };
}

module.exports = {
  renderQrPayload
};
