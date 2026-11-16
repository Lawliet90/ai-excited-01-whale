// Dreams Beyond Reality — a giant whale swimming among the clouds above a
// small glowing village. Deterministic: seeded PRNG only, no Math.random,
// no Date, no network. Writes /output/entry.png (1024x1024, RGB PNG).
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

const W = 1024;
const H = 1024;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20261117);

// ---------- CRC32 + PNG chunks ----------
const crcTable: number[] = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function encodePng(rgb: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 3)] = 0; // filter none
    raw.set(rgb.subarray(y * W * 3, (y + 1) * W * 3), y * (1 + W * 3) + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// ---------- pixel buffer ----------
const px = new Float32Array(W * H * 3);
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function blend(x: number, y: number, r: number, g: number, b: number, a: number): void {
  if (x < 0 || x >= W || y < 0 || y >= H || a <= 0) return;
  const i = (y * W + x) * 3;
  px[i] += (r - px[i]) * a;
  px[i + 1] += (g - px[i + 1]) * a;
  px[i + 2] += (b - px[i + 2]) * a;
}
function smoothstep(a: number, b: number, v: number): number {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ---------- value noise ----------
interface NoiseGrid {
  grid: number[];
  gw: number;
  gh: number;
}
function makeNoise(cell: number, seed: number): NoiseGrid {
  const r = mulberry32(seed);
  const gw = Math.ceil(W / cell) + 2;
  const gh = Math.ceil(H / cell) + 2;
  const grid: number[] = new Array(gw * gh);
  for (let i = 0; i < gw * gh; i++) grid[i] = r();
  return { grid, gw, gh };
}
function noiseAt(g: NoiseGrid, cell: number, x: number, y: number): number {
  const gx = x / cell;
  const gy = y / cell;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const i00 = g.grid[y0 * g.gw + x0];
  const i10 = g.grid[y0 * g.gw + x0 + 1];
  const i01 = g.grid[(y0 + 1) * g.gw + x0];
  const i11 = g.grid[(y0 + 1) * g.gw + x0 + 1];
  const a = i00 + (i10 - i00) * sx;
  const b = i01 + (i11 - i01) * sx;
  return a + (b - a) * sy;
}
function fbm(g1: NoiseGrid, c1: number, g2: NoiseGrid, c2: number, x: number, y: number): number {
  return noiseAt(g1, c1, x, y) * 0.65 + noiseAt(g2, c2, x, y) * 0.35;
}

// ---------- 1. sky ----------
const skyStops: Array<[number, number, number, number]> = [
  [0.0, 18, 16, 52],
  [0.3, 26, 42, 92],
  [0.55, 20, 86, 108],
  [0.74, 74, 96, 116],
  [0.86, 214, 138, 74],
  [1.0, 44, 30, 62],
];
for (let y = 0; y < H; y++) {
  const t = y / (H - 1);
  let s = 0;
  while (s < skyStops.length - 2 && t > skyStops[s + 1][0]) s++;
  const a = skyStops[s];
  const b = skyStops[s + 1];
  const f = clamp01((t - a[0]) / (b[0] - a[0]));
  const r = lerp(a[1], b[1], f);
  const g = lerp(a[2], b[2], f);
  const bl = lerp(a[3], b[3], f);
  // warm horizon glow, centered slightly right of middle
  const gy = Math.exp(-Math.pow((t - 0.86) / 0.09, 2));
  for (let x = 0; x < W; x++) {
    const gx = Math.exp(-Math.pow((x / W - 0.56) / 0.34, 2));
    const warm = gy * gx * 0.5;
    const i = (y * W + x) * 3;
    px[i] = r + (232 - r) * warm;
    px[i + 1] = g + (158 - g) * warm;
    px[i + 2] = bl + (92 - bl) * warm;
  }
}

// ---------- 2. stars ----------
for (let s = 0; s < 240; s++) {
  const x = Math.floor(rand() * W);
  const y = Math.floor(rand() * H * 0.42);
  const br = 120 + rand() * 135;
  const a = 0.35 + rand() * 0.6;
  const big = rand() < 0.12;
  blend(x, y, br, br, Math.min(255, br + 20), a);
  if (big) {
    blend(x + 1, y, br, br, br, a * 0.6);
    blend(x, y + 1, br, br, br, a * 0.6);
  }
}

// ---------- 3. moon ----------
const moonX = 208;
const moonY = 168;
const moonR = 46;
for (let y = moonY - 150; y < moonY + 150; y++) {
  for (let x = moonX - 150; x < moonX + 150; x++) {
    if (x < 0 || x >= W || y < 0 || y >= H) continue;
    const d = Math.hypot(x - moonX, y - moonY);
    if (d < moonR) {
      const shade = 0.92 + 0.08 * Math.sin(x * 0.3) * Math.cos(y * 0.27);
      blend(x, y, 246 * shade, 234 * shade, 208 * shade, 0.95);
    } else if (d < 150) {
      const a = Math.pow(1 - d / 150, 2) * 0.28;
      blend(x, y, 240, 226, 196, a);
    }
  }
}

// ---------- 4. background clouds ----------
const nA1 = makeNoise(190, 101);
const nA2 = makeNoise(95, 202);
const nB1 = makeNoise(120, 303);
const nB2 = makeNoise(60, 404);
function cloudPass(g1: NoiseGrid, c1: number, g2: NoiseGrid, c2: number, lo: number, hi: number, maxA: number, yTop: number, yBot: number): void {
  for (let y = yTop; y < yBot; y++) {
    const env = smoothstep(yTop, yTop + 90, y) * (1 - smoothstep(yBot - 90, yBot, y));
    const warmBand = Math.exp(-Math.pow((y / H - 0.8) / 0.16, 2));
    for (let x = 0; x < W; x++) {
      const n = fbm(g1, c1, g2, c2, x, y);
      const d = smoothstep(lo, hi, n) * env * maxA;
      if (d <= 0.01) continue;
      const cr = lerp(196, 244, warmBand);
      const cg = lerp(206, 196, warmBand);
      const cb = lerp(228, 150, warmBand);
      const bright = 0.85 + n * 0.3;
      blend(x, y, cr * bright, cg * bright, cb * bright, d);
    }
  }
}
cloudPass(nA1, 190, nA2, 95, 0.54, 0.78, 0.85, 300, 900);
cloudPass(nB1, 120, nB2, 60, 0.56, 0.8, 0.4, 180, 760);

// ---------- 5. the whale ----------
// local coords: u along body axis, v across. Head points up-right.
const whaleCx = 520;
const whaleCy = 430;
const whaleAng = -0.32; // radians, head up-right
const whaleA = 330; // half length
const whaleW = 92; // max half width
const cosA = Math.cos(whaleAng);
const sinA = Math.sin(whaleAng);
function whaleHalfWidth(u: number): number {
  const t = u / whaleA; // -1 tail .. +1 head
  const base = Math.pow(Math.max(0, 1 - t * t), 0.55);
  const taper = t < -0.55 ? lerp(1, 0.55, (-t - 0.55) / 0.45) : 1;
  const head = t > 0.55 ? lerp(1, 0.82, (t - 0.55) / 0.45) : 1;
  return whaleW * base * taper * head;
}
function ellipseSdf(x: number, y: number, cx: number, cy: number, rx: number, ry: number, ang: number): number {
  const dx = x - cx;
  const dy = y - cy;
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const lx = (dx * c + dy * s) / rx;
  const ly = (-dx * s + dy * c) / ry;
  return Math.hypot(lx, ly) - 1; // <0 inside
}
// tail fluke lobes (world coords, computed from local tail point)
const tailWx = whaleCx + (-whaleA) * cosA;
const tailWy = whaleCy + (-whaleA) * sinA;
const fluke1: [number, number, number, number, number] = [tailWx - 52, tailWy - 62, 74, 26, -0.7];
const fluke2: [number, number, number, number, number] = [tailWx - 52, tailWy + 62, 74, 26, 0.7];
for (let y = 120; y < 760; y++) {
  for (let x = 120; x < 940; x++) {
    const dx = x - whaleCx;
    const dy = y - whaleCy;
    const u = dx * cosA + dy * sinA;
    const v = -dx * sinA + dy * cosA;
    let sdf = 1e9;
    if (u > -whaleA && u < whaleA) {
      const hw = whaleHalfWidth(u);
      sdf = Math.min(sdf, Math.abs(v) / hw - 1);
    }
    sdf = Math.min(sdf, ellipseSdf(x, y, fluke1[0], fluke1[1], fluke1[2], fluke1[3], fluke1[4]));
    sdf = Math.min(sdf, ellipseSdf(x, y, fluke2[0], fluke2[1], fluke2[2], fluke2[3], fluke2[4]));
    // pectoral fin below mid-body
    const finX = whaleCx + 30 * cosA - 78 * -sinA;
    const finY = whaleCy + 30 * sinA - 78 * cosA;
    sdf = Math.min(sdf, ellipseSdf(x, y, finX, finY, 66, 20, whaleAng + 0.5));
    if (sdf > 0.02) continue;
    const a = sdf < -0.02 ? 1 : smoothstep(0.02, -0.02, sdf);
    // body shading: dark slate top -> pale belly
    const vv = u > -whaleA && u < whaleA ? v / Math.max(1, whaleHalfWidth(u)) : 0;
    const shade = clamp01(0.5 - vv * 0.5);
    const r = lerp(112, 38, shade);
    const g = lerp(158, 62, shade);
    const b = lerp(176, 96, shade);
    blend(x, y, r, g, b, a);
  }
}
// eye
const eyeU = whaleA * 0.62;
const eyeV = -whaleW * 0.42;
const eyeX = Math.round(whaleCx + eyeU * cosA - eyeV * sinA);
const eyeY = Math.round(whaleCy + eyeU * sinA + eyeV * cosA);
for (let y = eyeY - 9; y <= eyeY + 9; y++) {
  for (let x = eyeX - 9; x <= eyeX + 9; x++) {
    const d = Math.hypot(x - eyeX, y - eyeY);
    if (d < 7) blend(x, y, 12, 16, 26, 0.95);
    else if (d < 9) blend(x, y, 12, 16, 26, 0.4);
  }
}
blend(eyeX - 2, eyeY - 2, 255, 255, 255, 0.9);
blend(eyeX - 2, eyeY - 3, 255, 255, 255, 0.6);
// spout mist above the head
const spoutX = Math.round(whaleCx + whaleA * 0.78 * cosA - (-whaleW * 0.55) * sinA);
const spoutY = Math.round(whaleCy + whaleA * 0.78 * sinA + (-whaleW * 0.55) * cosA);
const puffs: Array<[number, number, number, number]> = [
  [spoutX, spoutY - 26, 26, 0.5],
  [spoutX - 18, spoutY - 52, 34, 0.42],
  [spoutX + 16, spoutY - 56, 30, 0.38],
  [spoutX, spoutY - 84, 40, 0.3],
];
for (const [cx, cy, rr, aa] of puffs) {
  for (let y = cy - rr; y < cy + rr; y++) {
    for (let x = cx - rr; x < cx + rr; x++) {
      const d = Math.hypot(x - cx, y - cy) / rr;
      if (d >= 1) continue;
      blend(x, y, 226, 236, 244, (1 - d * d) * aa);
    }
  }
}
// bioluminescent spots along the body
const spotRand = mulberry32(777);
for (let s = 0; s < 46; s++) {
  const u = -whaleA * 0.8 + spotRand() * whaleA * 1.6;
  const hw = whaleHalfWidth(u);
  const v = (spotRand() * 2 - 1) * hw * 0.8;
  const x = Math.round(whaleCx + u * cosA - v * sinA);
  const y = Math.round(whaleCy + u * sinA + v * cosA);
  const rr = 2 + spotRand() * 2.5;
  const aa = 0.45 + spotRand() * 0.4;
  for (let yy = Math.floor(y - rr); yy <= Math.ceil(y + rr); yy++) {
    for (let xx = Math.floor(x - rr); xx <= Math.ceil(x + rr); xx++) {
      const d = Math.hypot(xx - x, yy - y) / rr;
      if (d >= 1) continue;
      blend(xx, yy, 126, 232, 216, (1 - d) * aa);
    }
  }
}

// a small distant whale far up-right, half-hidden in mist, for depth
const dCx = 856;
const dCy = 218;
const dAng = -0.24;
const dCos = Math.cos(dAng);
const dSin = Math.sin(dAng);
const dA = 118;
const dW = 34;
for (let y = dCy - 70; y < dCy + 70; y++) {
  for (let x = dCx - 150; x < dCx + 150; x++) {
    if (x < 0 || x >= W || y < 0 || y >= H) continue;
    const dx = x - dCx;
    const dy = y - dCy;
    const u = dx * dCos + dy * dSin;
    const v = -dx * dSin + dy * dCos;
    if (u < -dA || u > dA) continue;
    const t = u / dA;
    const hw = dW * Math.pow(Math.max(0, 1 - t * t), 0.55);
    if (Math.abs(v) > hw) continue;
    const edge = smoothstep(hw, hw * 0.86, Math.abs(v));
    blend(x, y, 74, 96, 132, edge * 0.55);
  }
}

// ---------- 6. foreground clouds overlapping the whale ----------
const nC1 = makeNoise(150, 505);
const nC2 = makeNoise(75, 606);
cloudPass(nC1, 150, nC2, 75, 0.58, 0.8, 0.5, 480, 860);

// ---------- 7. the glowing village ----------
const villageCx = 690;
const villageCy = 806;
const hill = (x: number): number => villageCy + Math.sin((x - villageCx) / 260) * 14;
// ambient warm glow over the village
for (let y = villageCy - 170; y < villageCy + 130; y++) {
  for (let x = villageCx - 260; x < villageCx + 260; x++) {
    if (x < 0 || x >= W || y < 0 || y >= H) continue;
    const d = Math.hypot((x - villageCx) / 260, (y - villageCy) / 150);
    if (d >= 1) continue;
    blend(x, y, 255, 176, 92, (1 - d * d) * 0.16);
  }
}
const houseRand = mulberry32(4242);
interface Win {
  x: number;
  y: number;
}
const windows: Win[] = [];
let hx = villageCx - 210;
while (hx < villageCx + 210) {
  const hw = 26 + houseRand() * 20;
  const hh = 22 + houseRand() * 16;
  const base = hill(hx + hw / 2);
  const roofH = 12 + houseRand() * 8;
  // walls
  for (let y = Math.floor(base - hh); y < base; y++) {
    for (let x = Math.floor(hx); x < hx + hw; x++) {
      blend(x, y, 16, 12, 30, 1);
    }
  }
  // roof
  for (let y = Math.floor(base - hh - roofH); y < base - hh; y++) {
    const t = (y - (base - hh - roofH)) / roofH; // 0 top .. 1 eave
    const half = (hw / 2 + 3) * t;
    const cxm = hx + hw / 2;
    for (let x = Math.floor(cxm - half); x < cxm + half; x++) {
      blend(x, y, 12, 9, 24, 1);
    }
  }
  // windows
  const nWin = 1 + Math.floor(houseRand() * 2);
  for (let wI = 0; wI < nWin; wI++) {
    const wx = Math.floor(hx + 5 + houseRand() * (hw - 12));
    const wy = Math.floor(base - hh + 5 + houseRand() * (hh - 12));
    for (let y = wy; y < wy + 7; y++) {
      for (let x = wx; x < wx + 5; x++) {
        blend(x, y, 255, 205, 110, 1);
      }
    }
    windows.push({ x: wx + 2, y: wy + 3 });
  }
  hx += hw + 6 + houseRand() * 14;
}
// window glow halos
for (const w of windows) {
  for (let y = w.y - 24; y <= w.y + 24; y++) {
    for (let x = w.x - 24; x <= w.x + 24; x++) {
      const d = Math.hypot(x - w.x, y - w.y) / 24;
      if (d >= 1) continue;
      blend(x, y, 255, 190, 110, (1 - d * d) * 0.3);
    }
  }
}
// a few lantern dots along the village lane
for (let l = 0; l < 7; l++) {
  const lx = Math.round(villageCx - 180 + l * 58 + (l % 2) * 8);
  const ly = Math.round(hill(lx) + 4);
  blend(lx, ly, 255, 214, 130, 1);
  blend(lx + 1, ly, 255, 214, 130, 0.7);
  blend(lx, ly + 1, 255, 214, 130, 0.7);
}

// ---------- 8. bottom cloud frame ----------
const nD1 = makeNoise(170, 707);
const nD2 = makeNoise(85, 808);
cloudPass(nD1, 170, nD2, 85, 0.52, 0.76, 0.8, 900, 1024);

// ---------- quantize + write ----------
const rgb = new Uint8Array(W * H * 3);
for (let i = 0; i < px.length; i++) {
  const v = Math.round(px[i]);
  rgb[i] = v < 0 ? 0 : v > 255 ? 255 : v;
}
const png = encodePng(rgb);
const outDir = "/output";
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, "entry.png");
fs.writeFileSync(outPath, png);
console.log("wrote " + outPath + " " + png.length + " bytes");
