// AI-assisted code: written with Claude (Anthropic) and Antigravity (Google DeepMind), reviewed by the team.
//
// Generates SYNTHETIC placeholder data in the exact file layout agreed with the
// team, scaled to the full 86.1 x 107.5 km study box (76.667–78.198° E,
// 17.586–19.400° N) at 20 m / cell (4300 x 5375 = 23,112,500 cells), so the web
// app and Web Worker memory/latency can be stress-tested before real products arrive.
// Nothing produced here is real Mars data. Every number is a placeholder.
//
// Usage:  node scripts/make-fake-data.mjs [outDir]     (default: public)
// Output: <outDir>/veri/katmanlar.json                 (coexisting XYZ tile pyramid + 4-corner images)
//         <outDir>/veri/karolar/terrain_shade/{z}/{x}/{y}.png
//         <outDir>/veri/<layer_id>.png
//         <outDir>/veri/maliyet/izgara.json
//         <outDir>/veri/maliyet/egim.bin               Uint8, ceiling-quantized (~23.1 MB)
//         <outDir>/veri/maliyet/tehlike.bin            Uint8, 0/1/2/255 (~23.1 MB)
//         <outDir>/veri/maliyet/inis.bin               Uint8, 0/1/2/255 (~23.1 MB)
//         <outDir>/veri/maliyet/yukseklik.bin          Int16 little-endian (~46.2 MB)
//         <outDir>/veri/duraklar.json                  science stops
//         <outDir>/mobilite_parametreleri.json
//
// No dependencies: PNG encoding uses Node's built-in zlib.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

const tStart = performance.now();
const outDir = resolve(process.argv[2] ?? 'public');
const dataDir = join(outDir, 'veri');
const costDir = join(dataDir, 'maliyet');
mkdirSync(costDir, { recursive: true });
rmSync(join(dataDir, 'terrain_shade.png'), { force: true });

// ---------------------------------------------------------------- grid setup
// Updated study box: 76.667–78.198° E, 17.586–19.400° N (~86.1 x 107.5 km) @ 20 m
const W = 4300; // genislik (cells)
const H = 5375; // yukseklik (cells) -> 23,112,500 cells
const CELLS = W * H;
const CELL_M = 20; // hucre_m

const BOUND_WEST = 76.667;
const BOUND_EAST = 78.198;
const BOUND_SOUTH = 17.586;
const BOUND_NORTH = 19.4;
const SINIR = [BOUND_WEST, BOUND_SOUTH, BOUND_EAST, BOUND_NORTH];

// Corner order: top-left (NW), top-right (NE), bottom-right (SE), bottom-left (SW).
// Row 0 of every raster is the NORTH edge.
const CORNERS = [
  [BOUND_WEST, BOUND_NORTH],
  [BOUND_EAST, BOUND_NORTH],
  [BOUND_EAST, BOUND_SOUTH],
  [BOUND_WEST, BOUND_SOUTH],
];

const r6 = (v) => Math.round(v * 1e6) / 1e6;

// ---------------------------------------------------------------- fast bitwise lattice noise
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeFastNoise256(seed) {
  const rnd = mulberry32(seed);
  const lattice = new Float32Array(256 * 256);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rnd();
  return (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const tx = x - xi;
    const ty = y - yi;
    const fx = tx * tx * (3 - 2 * tx);
    const fy = ty * ty * (3 - 2 * ty);
    const x0 = xi & 255;
    const x1 = (xi + 1) & 255;
    const r0 = (yi & 255) << 8;
    const r1 = ((yi + 1) & 255) << 8;
    const a = lattice[r0 | x0] + (lattice[r0 | x1] - lattice[r0 | x0]) * fx;
    const b = lattice[r1 | x0] + (lattice[r1 | x1] - lattice[r1 | x0]) * fx;
    return a + (b - a) * fy;
  };
}

const smoothstep = (a, b, x) => {
  const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a);
  return t * t * (3 - 2 * t);
};

// ---------------------------------------------------------------- elevation (~ -2850 m to +420 m)
const regionalNoise = makeFastNoise256(2026);
const detailNoise = makeFastNoise256(9911);
const scarpNoise = makeFastNoise256(77);
const maskNoise = makeFastNoise256(1846);
const rockNoise = makeFastNoise256(4242);

const CRATERS = [
  { cx: 3050, cy: 1650, r: 340, depth: 310 },
  { cx: 1550, cy: 3850, r: 240, depth: 220 },
  { cx: 3450, cy: 4100, r: 190, depth: 175 },
  { cx: 920, cy: 1420, r: 210, depth: 190 },
  { cx: 2420, cy: 2950, r: 130, depth: 135 },
];

// Smooth sedimentary plains acting as realistic landing ellipses on both sides of the scarp.
const LANDING_FLATS = [
  { cx: 1420, cy: 2520, r: 190 },
  { cx: 1320, cy: 2920, r: 180 },
  { cx: 2480, cy: 2740, r: 210 },
  { cx: 2780, cy: 3180, r: 200 },
  { cx: 3420, cy: 880, r: 170 },
];

const RAMP_ROW = 2680;
const elev = new Float32Array(CELLS);

// Precompute 1D scarp x-position and ramp width per row
const rowScarpX = new Float32Array(H);
const rowHalfW = new Float32Array(H);
for (let y = 0; y < H; y++) {
  const n = scarpNoise(y / 520, 0.5) * 0.65 + scarpNoise(y / 180, 1.7) * 0.35;
  rowScarpX[y] = 1920 + (n - 0.5) * 760;
  const ramp = Math.exp(-(((y - RAMP_ROW) / 230) ** 2));
  rowHalfW[y] = 28 + ramp * 420; // steep ~28-cell scarp everywhere except the gentle Neretva-like valley ramp
}

for (let y = 0; y < H; y++) {
  const scarpX = rowScarpX[y];
  const halfW = rowHalfW[y];
  const rowOff = y * W;
  // Filter active craters & flats per row to avoid inner-loop distance checks across 23.1M cells
  const activeCraters = CRATERS.filter((c) => Math.abs(y - c.cy) < c.r * 1.6);
  const activeFlats = LANDING_FLATS.filter((f) => Math.abs(y - f.cy) < f.r * 1.3);

  for (let x = 0; x < W; x++) {
    const plateau = 1 - smoothstep(scarpX - halfW, scarpX + halfW, x);
    let flatFactor = 1;
    for (let fIdx = 0; fIdx < activeFlats.length; fIdx++) {
      const f = activeFlats[fIdx];
      const df = Math.hypot(x - f.cx, y - f.cy) / f.r;
      if (df < 1.3) flatFactor = Math.min(flatFactor, smoothstep(0.72, 1.3, df));
    }

    const macro =
      regionalNoise(x / 420, y / 420) * 0.6 +
      regionalNoise(x / 140 + 13.7, y / 140 + 7.3) * 0.3 +
      detailNoise(x / 36, y / 36) * 0.1;
    const micro = detailNoise(x / 7.5 + 40, y / 7.5 + 40) - 0.5;

    // Regional elevation spans ~ -2750 m (eastern basin) to +320 m (western highlands)
    let z = -2580 + plateau * 620 + (W - x) * 0.48 - y * 0.04;
    z += (macro - 0.5) * 460 * (0.15 + 0.85 * flatFactor);
    z += micro * 16.5 * flatFactor;

    for (let cIdx = 0; cIdx < activeCraters.length; cIdx++) {
      const c = activeCraters[cIdx];
      const d = Math.hypot(x - c.cx, y - c.cy) / c.r;
      if (d < 1.6) {
        z -= c.depth * (1 - smoothstep(0, 1, d));
        z += c.depth * 0.28 * Math.exp(-((d - 1) ** 2) / 0.025);
      }
    }
    elev[rowOff + x] = z;
  }
}

// ---------------------------------------------------------------- slope (Uint8 ceiling-quantized) + hazard + shade
const SLOPE_SCALE = 0.25;
const SLOPE_NODATA_U8 = 255;
const SLOPE_BASELINE_M = CELL_M;

const ELEV_BASE_M = 0;
const ELEV_SCALE_M = 0.5;
const ELEV_NODATA_I16 = -32768;

const slopeU8 = new Uint8Array(CELLS);
const hazard = new Uint8Array(CELLS);
const shadeU8 = new Uint8Array(CELLS); // 0..255 hillshade brightness
const pointLanding = new Uint8Array(CELLS);
const elevI16 = new Int16Array(CELLS);

const invTwoCell = 1 / (2 * CELL_M);
const radToDeg = 180 / Math.PI;
const sunAz = (315 * Math.PI) / 180;
const cosSunAz = Math.cos(sunAz);
const sinSunAz = Math.sin(sunAz);
const sinSunAlt = Math.sin((40 * Math.PI) / 180);
const cosSunAlt = Math.cos((40 * Math.PI) / 180);

let nodataCount = 0;

for (let y = 0; y < H; y++) {
  const yPrev = y > 0 ? y - 1 : 0;
  const yNext = y + 1 < H ? y + 1 : H - 1;
  const rowOff = y * W;
  const prevOff = yPrev * W;
  const nextOff = yNext * W;
  const activeFlats = LANDING_FLATS.filter((f) => Math.abs(y - f.cy) <= f.r * 0.9);
  const yMaskBias = smoothstep(350, 1450, y) * 0.52;

  for (let x = 0; x < W; x++) {
    const i = rowOff + x;
    const xPrev = x > 0 ? x - 1 : 0;
    const xNext = x + 1 < W ? x + 1 : W - 1;

    const dzdx = (elev[rowOff + xNext] - elev[rowOff + xPrev]) * invTwoCell;
    const dzdy = (elev[prevOff + x] - elev[nextOff + x]) * invTwoCell; // north positive
    const g = Math.hypot(dzdx, dzdy);
    const deg = Math.atan(g) * radToDeg;

    // Hillshade
    const eg = g * 2.5;
    const invNorm = 1 / Math.sqrt(1 + eg * eg);
    const cosSl = invNorm;
    // sin(sl) * cos(sunAz - aspect) where aspect = atan2(-dzdx, -dzdy)
    const dotAspect = eg > 1e-9 ? ((-dzdy * cosSunAz - dzdx * sinSunAz) / g) * (eg * invNorm) : 0;
    const s = Math.min(1, Math.max(0, sinSunAlt * cosSl + cosSunAlt * dotAspect));
    shadeU8[i] = Math.round(s * 255);

    // No-data swath in the NE corner
    const blob = maskNoise(x / 380, y / 380) * 0.7 + maskNoise(x / 130, y / 130) * 0.3 + smoothstep(3100, 4300, x) * 0.34 - yMaskBias;
    if (blob > 0.78) {
      hazard[i] = 255;
      slopeU8[i] = SLOPE_NODATA_U8;
      pointLanding[i] = 255;
      elevI16[i] = ELEV_NODATA_I16;
      nodataCount++;
      continue;
    }

    const qByte = Math.min(254, Math.max(0, Math.ceil(deg / SLOPE_SCALE)));
    slopeU8[i] = qByte;
    elevI16[i] = Math.max(-32767, Math.min(32767, Math.round((elev[i] - ELEV_BASE_M) / ELEV_SCALE_M)));

    let inFlat = false;
    for (let fIdx = 0; fIdx < activeFlats.length; fIdx++) {
      const f = activeFlats[fIdx];
      const dx = x - f.cx;
      const dy = y - f.cy;
      if (dx * dx + dy * dy <= (f.r * 0.9) ** 2) {
        inFlat = true;
        break;
      }
    }
    const rocks = inFlat ? 0.15 : rockNoise(x / 22, y / 22) * 0.7 + detailNoise(x / 9, y / 9) * 0.3;
    const h = deg > 25 || rocks > 0.8 ? 2 : deg > 15 || rocks > 0.71 ? 1 : 0;
    hazard[i] = h;

    if (h === 0 && deg <= 4.2 && rocks < 0.36) pointLanding[i] = 0;
    else if (h <= 1 && deg <= 8.5 && rocks < 0.62) pointLanding[i] = 1;
    else pointLanding[i] = 2;
  }
}

// ---------------------------------------------------------------- landing suitability (inis.bin)
// Safe landing circle footprint check (250 m diameter -> radius 7 cells @ 20 m).
const SAFE_DIAMETER_M = 250;
const safeRadiusCells = Math.ceil(SAFE_DIAMETER_M / 2 / CELL_M);
const circleOffsets = [];
for (let dy = -safeRadiusCells; dy <= safeRadiusCells; dy++) {
  for (let dx = -safeRadiusCells; dx <= safeRadiusCells; dx++) {
    const d2 = dx * dx + dy * dy;
    if (d2 <= safeRadiusCells * safeRadiusCells) circleOffsets.push({ dx, dy, d2 });
  }
}
// Check outer boundary ring first so unsuitable circles abort in 1-3 lookups
circleOffsets.sort((a, b) => b.d2 - a.d2);
const relOffsets = Int32Array.from(circleOffsets, (o) => o.dy * W + o.dx);

const landing = new Uint8Array(CELLS);
let suitCount = 0;
let margCount = 0;

for (let y = 0; y < H; y++) {
  const rowOff = y * W;
  const yInside = y >= safeRadiusCells && y < H - safeRadiusCells;
  for (let x = 0; x < W; x++) {
    const i = rowOff + x;
    const p0 = pointLanding[i];
    if (p0 === 255) {
      landing[i] = 255;
      continue;
    }
    if (!yInside || x < safeRadiusCells || x >= W - safeRadiusCells || p0 === 2) {
      landing[i] = 2;
      continue;
    }
    let worst = p0;
    for (let k = 0; k < relOffsets.length; k++) {
      const p = pointLanding[i + relOffsets[k]];
      if (p >= 2) {
        worst = 2;
        break;
      }
      if (p === 1) worst = 1;
    }
    landing[i] = worst;
    if (worst === 0) suitCount++;
    else if (worst === 1) margCount++;
  }
}

// ---------------------------------------------------------------- PNG encoder
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  const stride = width * 4 + 1;
  const raw = Buffer.allocUnsafe(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * stride + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 3 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- XYZ tile pyramid + 4-corner overlays
const TILE_MIN_Z = 8;
const TILE_MAX_Z = 11;
const TILE_SIZE = 256;
const lonToTileX = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const latToTileY = (lat, z) => {
  const rad = (lat * Math.PI) / 180;
  const wy = (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
  return Math.floor(wy * 2 ** z);
};

const tileRoot = join(dataDir, 'karolar', 'terrain_shade');
rmSync(tileRoot, { recursive: true, force: true });
let tileCount = 0;
for (let z = TILE_MIN_Z; z <= TILE_MAX_Z; z++) {
  const n = 2 ** z;
  const txMin = lonToTileX(BOUND_WEST, z);
  const txMax = lonToTileX(BOUND_EAST, z);
  const tyMin = latToTileY(BOUND_NORTH, z);
  const tyMax = latToTileY(BOUND_SOUTH, z);
  for (let tx = txMin; tx <= txMax; tx++) {
    const colDir = join(tileRoot, String(z), String(tx));
    mkdirSync(colDir, { recursive: true });
    for (let ty = tyMin; ty <= tyMax; ty++) {
      const rgba = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
      for (let py = 0; py < TILE_SIZE; py++) {
        const wy = (ty + (py + 0.5) / TILE_SIZE) / n;
        const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * wy))) * 180) / Math.PI;
        if (lat < BOUND_SOUTH || lat > BOUND_NORTH) continue;
        const gy = Math.min(H - 1, Math.max(0, Math.floor(((BOUND_NORTH - lat) / (BOUND_NORTH - BOUND_SOUTH)) * H)));
        const rowOff = gy * W;
        for (let px = 0; px < TILE_SIZE; px++) {
          const lon = ((tx + (px + 0.5) / TILE_SIZE) / n) * 360 - 180;
          if (lon < BOUND_WEST || lon > BOUND_EAST) continue;
          const gx = Math.min(W - 1, Math.max(0, Math.floor(((lon - BOUND_WEST) / (BOUND_EAST - BOUND_WEST)) * W)));
          const s = 0.25 + 0.75 * (shadeU8[rowOff + gx] / 255);
          const off = (py * TILE_SIZE + px) * 4;
          rgba[off] = Math.round(205 * s);
          rgba[off + 1] = Math.round(150 * s);
          rgba[off + 2] = Math.round(112 * s);
          rgba[off + 3] = 255;
        }
      }
      writeFileSync(join(colDir, `${ty}.png`), encodePng(TILE_SIZE, TILE_SIZE, rgba));
      tileCount++;
    }
  }
}

const SLOPE_RAMP = [
  { upTo: 5, color: [46, 160, 110], label: '0–5°' },
  { upTo: 10, color: [160, 200, 80], label: '5–10°' },
  { upTo: 15, color: [240, 200, 60], label: '10–15°' },
  { upTo: 25, color: [235, 130, 40], label: '15–25°' },
  { upTo: Infinity, color: [200, 50, 50], label: '> 25°' },
];
const HAZARD_STYLE = {
  0: { color: [70, 170, 110], alpha: 70, label: 'Free' },
  1: { color: [240, 190, 50], alpha: 170, label: 'Caution' },
  2: { color: [205, 45, 55], alpha: 210, label: 'Forbidden' },
};
const LANDING_STYLE = {
  0: { color: [80, 210, 140], alpha: 185, label: 'Suitable (0)' },
  1: { color: [242, 193, 78], alpha: 165, label: 'Marginal (1)' },
  2: { color: [120, 45, 55], alpha: 95, label: 'Unsuitable (2)' },
};
const hex = ([r, g, b]) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');

// Overview 4-corner overlays (1/4 scale = 1075 x 1344 px so repo stays compact while exercising mixed tile + image layers)
const OVW_STEP = 4;
const OVW_W = Math.floor(W / OVW_STEP);
const OVW_H = Math.floor(H / OVW_STEP);
function renderOverview(pixelAtCell) {
  const rgba = new Uint8Array(OVW_W * OVW_H * 4);
  for (let oy = 0; oy < OVW_H; oy++) {
    const gy = oy * OVW_STEP;
    const rowOff = gy * W;
    for (let ox = 0; ox < OVW_W; ox++) {
      const i = rowOff + ox * OVW_STEP;
      const [r, g, b, a] = pixelAtCell(i);
      const off = (oy * OVW_W + ox) * 4;
      rgba[off] = r;
      rgba[off + 1] = g;
      rgba[off + 2] = b;
      rgba[off + 3] = a;
    }
  }
  return encodePng(OVW_W, OVW_H, rgba);
}

writeFileSync(
  join(dataDir, 'slope.png'),
  renderOverview((i) => {
    const b = slopeU8[i];
    if (b === SLOPE_NODATA_U8) return [0, 0, 0, 0];
    const deg = b * SLOPE_SCALE;
    const band = SLOPE_RAMP.find((entry) => deg <= entry.upTo);
    return [...band.color, 215];
  }),
);
writeFileSync(
  join(dataDir, 'hazard.png'),
  renderOverview((i) => {
    const h = hazard[i];
    if (h === 255) return [0, 0, 0, 0];
    const st = HAZARD_STYLE[h];
    return [...st.color, st.alpha];
  }),
);
writeFileSync(
  join(dataDir, 'landing.png'),
  renderOverview((i) => {
    const l = landing[i];
    if (l === 255) return [0, 0, 0, 0];
    const st = LANDING_STYLE[l];
    return [...st.color, st.alpha];
  }),
);

// ---------------------------------------------------------------- JSON + binaries
const SYNTH = 'SYNTHETIC placeholder generated by scripts/make-fake-data.mjs — not real Mars data.';

const layers = {
  sahte: true,
  alan_en: 'Jezero & Nili Fossae region (synthetic 86 × 108 km)',
  not_en: SYNTH,
  katmanlar: [
    {
      id: 'terrain_shade',
      ad_en: 'Shaded relief (synthetic XYZ tiles)',
      tur: 'altlik',
      karolar: 'karolar/terrain_shade/{z}/{x}/{y}.png',
      sema: 'xyz',
      min_zoom: TILE_MIN_Z,
      max_zoom: TILE_MAX_Z,
      sinir: SINIR,
      kaynak: 'Synthetic regional terrain rendered as Web Mercator XYZ tiles (placeholder for CTX/HiRISE pyramid)',
      cozunurluk_m: CELL_M,
      guven_notu_en: 'Placeholder only. Do not use for any real planning.',
      lejant: [],
    },
    {
      id: 'landing',
      ad_en: 'Landing suitability (synthetic)',
      tur: 'inis',
      dosya: 'landing.png',
      koseler: CORNERS,
      kaynak: 'Synthetic footprint check on slope + hazard (placeholder for inis.bin)',
      cozunurluk_m: CELL_M * OVW_STEP,
      guven_notu_en: 'Placeholder only. Class 0 centres guarantee a clear 250 m landing circle.',
      lejant: Object.values(LANDING_STYLE).map((s) => ({ renk: hex(s.color), etiket_en: s.label })),
    },
    {
      id: 'slope',
      ad_en: 'Slope (synthetic)',
      tur: 'egim',
      dosya: 'slope.png',
      koseler: CORNERS,
      kaynak: 'Derived from the synthetic terrain (placeholder for a CTX DTM-derived slope map)',
      cozunurluk_m: CELL_M * OVW_STEP,
      guven_notu_en: 'Placeholder only. Transparent area = no data.',
      lejant: SLOPE_RAMP.map((b) => ({ renk: hex(b.color), etiket_en: b.label })),
    },
    {
      id: 'hazard',
      ad_en: 'Hazard classes (synthetic)',
      tur: 'tehlike',
      dosya: 'hazard.png',
      koseler: CORNERS,
      kaynak: 'Thresholded synthetic slope + rock fields (placeholder)',
      cozunurluk_m: CELL_M * OVW_STEP,
      guven_notu_en: 'Placeholder only. Transparent area = no data, which is NOT the same as forbidden.',
      lejant: Object.values(HAZARD_STYLE).map((s) => ({ renk: hex(s.color), etiket_en: s.label })),
    },
  ],
};
writeFileSync(join(dataDir, 'katmanlar.json'), JSON.stringify(layers, null, 2));

writeFileSync(
  join(costDir, 'izgara.json'),
  JSON.stringify(
    {
      sahte: true,
      alan_en: 'Jezero & Nili Fossae region (synthetic 86 × 108 km)',
      genislik: W,
      yukseklik: H,
      hucre_m: CELL_M,
      koseler: CORNERS,
      egim_tipi: 'uint8',
      egim_olcek: SLOPE_SCALE,
      egim_veri_yok: SLOPE_NODATA_U8,
      egim_taban_uzunlugu_m: SLOPE_BASELINE_M,
      yukseklik_tipi: 'int16',
      yukseklik_taban_m: ELEV_BASE_M,
      yukseklik_olcek_m: ELEV_SCALE_M,
      yukseklik_veri_yok: ELEV_NODATA_I16,
    },
    null,
    2,
  ),
);
writeFileSync(join(costDir, 'egim.bin'), Buffer.from(slopeU8.buffer));
writeFileSync(join(costDir, 'tehlike.bin'), Buffer.from(hazard.buffer));
writeFileSync(join(costDir, 'inis.bin'), Buffer.from(landing.buffer));

// Write little-endian Int16 yukseklik.bin directly on LE host (with DataView fallback if ever BE)
const isLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
if (isLE) {
  writeFileSync(join(costDir, 'yukseklik.bin'), Buffer.from(elevI16.buffer));
} else {
  const elevLeBuf = Buffer.allocUnsafe(CELLS * 2);
  for (let i = 0; i < CELLS; i++) elevLeBuf.writeInt16LE(elevI16[i], i * 2);
  writeFileSync(join(costDir, 'yukseklik.bin'), elevLeBuf);
}

// Science stops positioned across the corridor & landing plains so EVA & rover traverses are realistic.
const cellLonLat = (col, row) => {
  const u = (col + 0.5) / W;
  const v = (row + 0.5) / H;
  return [r6(CORNERS[0][0] + u * (CORNERS[1][0] - CORNERS[0][0])), r6(CORNERS[0][1] + v * (CORNERS[3][1] - CORNERS[0][1]))];
};
const stops = {
  sahte: true,
  not_en: SYNTH,
  duraklar: [
    {
      id: 'stop_a',
      ad_en: 'Western carbonate bench (synthetic)',
      konum: cellLonLat(1710, 2560),
      aciklama_en: 'Placeholder stop on the western highland bench within EVA reach of flat landing plains.',
    },
    {
      id: 'stop_b',
      ad_en: 'Valley breach crest (synthetic)',
      konum: cellLonLat(1910, 2680),
      aciklama_en: 'Placeholder stop at the gentle valley corridor crossing the regional scarp.',
    },
    {
      id: 'stop_c',
      ad_en: 'Delta fan deposit (synthetic)',
      konum: cellLonLat(2340, 2730),
      aciklama_en: 'Placeholder stop on the lower basin floor east of the scarp.',
    },
    {
      id: 'stop_d',
      ad_en: 'Unmapped NE margin (synthetic)',
      konum: cellLonLat(3680, 620),
      aciklama_en: 'Placeholder stop inside the area with no slope or hazard data, to exercise the no-data warning.',
    },
  ],
};
writeFileSync(join(dataDir, 'duraklar.json'), JSON.stringify(stops, null, 2));

const PLACEHOLDER = 'PLACEHOLDER — invented for UI development, not sourced';
const param = (deger, kaynak = PLACEHOLDER, guven = 'VARSAYIM') => ({ deger, kaynak, guven });

const dictTraverser = (ad_en, aciklama_en, azami_egim_derece, speeds, azami_engel_m, azami_sure_saat, enerji_katsayisi) => ({
  ad_en,
  aciklama_en,
  azami_egim_derece: param(azami_egim_derece),
  hiz_tablosu: param(speeds.map(([egim_derece, hiz_m_s]) => ({ egim_derece, hiz_m_s }))),
  azami_engel_m: param(azami_engel_m),
  azami_sure_saat: param(azami_sure_saat),
  enerji_katsayisi: param(enerji_katsayisi),
});

const mobility = {
  sahte: true,
  not_en: SYNTH,
  inis_araci: {
    azami_egim_derece: param(6),
    azami_kaya_m: param(0.35),
    azami_yukseklik_m: param(-2000),
    guvenli_alan_capi_m: param(SAFE_DIAMETER_M, 'Placeholder until Çağatay supplies lander footprint diameter', 'VARSAYIM'),
  },
  yuruyen_insan: dictTraverser(
    'Walking astronaut (suited)',
    'Suited EVA on foot.',
    20,
    [[0, 1.0], [5, 0.9], [10, 0.7], [15, 0.5], [20, 0.3]],
    0.3,
    6,
    1.0,
  ),
  roverli_insan: dictTraverser(
    'Crewed rover',
    'Range bounded by walk-back survival rule if the rover fails.',
    18,
    [[0, 2.2], [5, 1.9], [10, 1.4], [15, 0.9], [18, 0.5]],
    0.35,
    4,
    0.8,
  ),
  rover: dictTraverser(
    'Uncrewed rover',
    'Robotic traverse without human life-support time cap.',
    25,
    [[0, 2.5], [5, 2.2], [10, 1.6], [15, 1.0], [20, 0.6], [25, 0.3]],
    0.4,
    12,
    0.6,
  ),
};
writeFileSync(join(outDir, 'mobilite_parametreleri.json'), JSON.stringify(mobility, null, 2));

const pct = ((100 * nodataCount) / CELLS).toFixed(1);
const elapsedS = ((performance.now() - tStart) / 1000).toFixed(2);
console.log(`Synthetic data written to ${outDir} in ${elapsedS} s`);
console.log(
  `  grid ${W} x ${H} (${CELLS.toLocaleString('en-US')} cells @ ${CELL_M} m = ${(W * CELL_M) / 1000} km x ${(H * CELL_M) / 1000} km), uint8 slope + int16 elev, ${tileCount} XYZ tiles (z${TILE_MIN_Z}..z${TILE_MAX_Z}), no-data ${pct}%, landing class-0 ${suitCount}, class-1 ${margCount}`,
);
