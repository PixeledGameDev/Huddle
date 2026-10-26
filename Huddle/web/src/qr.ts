/**
 * A small QR code encoder (byte mode, error correction level M, versions 1–10, so up to 213 bytes), used to show the
 * authenticator-app setup code without loading an image from anywhere or adding a library.
 * Returns the code as a grid of dark (true) and light (false) modules, without the quiet border.
 */

// For level M: error-correction bytes per block, and the blocks as [how many, data bytes in each].
const M_TABLE: Record<number, { ec: number; blocks: [number, number][] }> = {
  1: { ec: 10, blocks: [[1, 16]] },
  2: { ec: 16, blocks: [[1, 28]] },
  3: { ec: 26, blocks: [[1, 44]] },
  4: { ec: 18, blocks: [[2, 32]] },
  5: { ec: 24, blocks: [[2, 43]] },
  6: { ec: 16, blocks: [[4, 27]] },
  7: { ec: 18, blocks: [[4, 31]] },
  8: { ec: 22, blocks: [[2, 38], [2, 39]] },
  9: { ec: 22, blocks: [[3, 36], [2, 37]] },
  10: { ec: 26, blocks: [[4, 43], [1, 44]] },
};
const ALIGNMENT: Record<number, number[]> = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };

// ---- Reed–Solomon error correction over GF(256)
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const gfMul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function rsGenerator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data: number[], degree: number): number[] {
  const gen = rsGenerator(degree);
  const rem = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem.shift()!;
    rem.push(0);
    for (let i = 0; i < degree; i++) rem[i] ^= gfMul(gen[i + 1], factor);
  }
  return rem;
}

// ---- building the codewords
function buildCodewords(bytes: Uint8Array, version: number): number[] {
  const { ec, blocks } = M_TABLE[version];
  const capacity = blocks.reduce((s, [n, len]) => s + n * len, 0);
  const bits: number[] = [];
  const push = (value: number, count: number) => {
    for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capacity * 8 - bits.length)); // terminator
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  for (let pad = 0xec; data.length < capacity; pad ^= 0xec ^ 0x11) data.push(pad);

  const dataBlocks: number[][] = [];
  let at = 0;
  for (const [n, len] of blocks) for (let i = 0; i < n; i++) dataBlocks.push(data.slice(at, (at += len)));
  const ecBlocks = dataBlocks.map((b) => rsRemainder(b, ec));
  const out: number[] = [];
  const longest = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < longest; i++) for (const b of dataBlocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ec; i++) for (const b of ecBlocks) out.push(b[i]);
  return out;
}

// ---- drawing the grid
const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function penalty(m: boolean[][]): number {
  const n = m.length;
  let score = 0;
  const lines = (get: (a: number, b: number) => boolean) => {
    for (let a = 0; a < n; a++) {
      let run = 1;
      for (let b = 1; b < n; b++) {
        if (get(a, b) === get(a, b - 1)) run++;
        else {
          if (run >= 5) score += 3 + run - 5;
          run = 1;
        }
      }
      if (run >= 5) score += 3 + run - 5;
      // finder-like 1:1:3:1:1 patterns with a light border
      for (let b = 0; b + 10 < n; b++) {
        const seq = (s: number[]) => s.every((v, i) => get(a, b + i) === !!v);
        if (seq([1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0]) || seq([0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1])) score += 40;
      }
    }
  };
  lines((r, c) => m[r][c]);
  lines((c, r) => m[r][c]);
  for (let y = 0; y + 1 < n; y++)
    for (let x = 0; x + 1 < n; x++) if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3;
  const dark = m.flat().filter(Boolean).length;
  score += Math.floor(Math.abs(dark * 20 - n * n * 10) / (n * n)) * 10;
  return score;
}

export function qrModules(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  const version = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].find((v) => {
    const capacity = M_TABLE[v].blocks.reduce((s, [n, len]) => s + n * len, 0);
    return 4 + (v <= 9 ? 8 : 16) + bytes.length * 8 <= capacity * 8;
  });
  if (!version) throw new Error("Text is too long for this QR encoder.");
  const size = 17 + 4 * version;
  const codewords = buildCodewords(bytes, version);

  const mods: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
  const fixed: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
  const put = (x: number, y: number, dark: boolean) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    mods[y][x] = dark;
    fixed[y][x] = true;
  };

  for (let i = 0; i < size; i++) {
    put(6, i, i % 2 === 0);
    put(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]])
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) put(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 2 && Math.max(Math.abs(dx), Math.abs(dy)) !== 4);
  const pos = ALIGNMENT[version];
  for (const cy of pos)
    for (const cx of pos) {
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) continue; // those spots are finders
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) put(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }

  const writeFormat = (mask: number) => {
    const data = mask; // level M is 00
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) put(8, i, bit(i));
    put(8, 7, bit(6));
    put(8, 8, bit(7));
    put(7, 8, bit(8));
    for (let i = 9; i < 15; i++) put(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) put(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) put(8, size - 15 + i, bit(i));
    put(8, size - 8, true);
  };
  writeFormat(0); // reserves the format areas; rewritten once the mask is chosen
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      put(a, b, dark);
      put(b, a, dark);
    }
  }

  // data bits, in the zigzag order the standard requires
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++)
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (!fixed[y][x] && bitIndex < codewords.length * 8) {
          mods[y][x] = ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) === 1;
          bitIndex++;
        }
      }
  }

  // try all eight masks and keep the one that scores best
  let best: { grid: boolean[][]; mask: number; score: number } | null = null;
  for (let mask = 0; mask < 8; mask++) {
    const grid = mods.map((row, y) => row.map((v, x) => (fixed[y][x] ? v : v !== MASKS[mask](x, y))));
    const score = penalty(grid);
    if (!best || score < best.score) best = { grid, mask, score };
  }
  const final = best!;
  mods.splice(0, size, ...final.grid);
  writeFormat(final.mask);
  return mods;
}
