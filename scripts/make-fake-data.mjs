// AI-assisted code: written with Claude (Anthropic), reviewed by the team.
//
// Generates SYNTHETIC placeholder data in the exact file layout agreed with the
// team, so the web app can be built before the real products arrive.
// Nothing produced here is real Mars data. Every number is a placeholder.
//
// Usage:  node scripts/make-fake-data.mjs [outDir]     (default: public)
// Output: <outDir>/veri/katmanlar.json
//         <outDir>/veri/<layer_id>.png
//         <outDir>/veri/maliyet/izgara.json
//         <outDir>/veri/maliyet/egim.bin      Float32, row by row, degrees, -9999 = no data
//         <outDir>/veri/maliyet/tehlike.bin   Uint8, 0 free, 1 caution, 2 forbidden, 255 = no data
//         <outDir>/veri/maliyet/yukseklik.bin Float32, metres, -9999 = no data  (PROPOSED extension)
//         <outDir>/veri/duraklar.json         science stops (PROPOSED extension)
//         <outDir>/mobilite_parametreleri.json
//
// No dependencies: PNG encoding uses Node's built-in zlib.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

const outDir = resolve(process.argv[2] ?? 'public');
const dataDir = join(outDir, 'veri');
const costDir = join(dataDir, 'maliyet');
mkdirSync(costDir, { recursive: true });

// ---------------------------------------------------------------- grid setup
const W = 400; // genislik (cells)
const H = 300; // yukseklik (cells)
const CELL_M = 5; // hucre_m
const NODATA_F = -9999;

// Approximate location of the Jezero delta front. Used only to place the
// synthetic rectangle somewhere plausible; update when the team fixes the site.
const CENTER_LON = 77.4;
const CENTER_LAT = 18.46;
const MARS_MEAN_RADIUS_M = 3_389_500;
const M_PER_DEG_LAT = (Math.PI * MARS_MEAN_RADIUS_M) / 180;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((CENTER_LAT * Math.PI) / 180);

const halfLon = (W * CELL_M) / 2 / M_PER_DEG_LON;
const halfLat = (H * CELL_M) / 2 / M_PER_DEG_LAT;
const r6 = (v) => Math.round(v * 1e6) / 1e6;
// Corner order: top-left (NW), top-right (NE), bottom-right (SE), bottom-left (SW).
// Row 0 of every raster is the NORTH edge.
const CORNERS = [
  [r6(CENTER_LON - halfLon), r6(CENTER_LAT + halfLat)],
  [r6(CENTER_LON + halfLon), r6(CENTER_LAT + halfLat)],
  [r6(CENTER_LON + halfLon), r6(CENTER_LAT - halfLat)],
  [r6(CENTER_LON - halfLon), r6(CENTER_LAT - halfLat)],
];

// ---------------------------------------------------------------- noise
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

function makeValueNoise(seed, size = 64) {
  const rnd = mulberry32(seed);
  const lattice = new Float32Array(size * size);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rnd();
  const at = (x, y) => lattice[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  const fade = (t) => t * t * (3 - 2 * t);
  return (x, y) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = fade(x - x0);
    const fy = fade(y - y0);
    const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * fx;
    const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * fx;
    return a + (b - a) * fy;
  };
}

function fbm(noise, x, y, octaves) {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += noise(x * freq, y * freq) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// ---------------------------------------------------------------- elevation
const terrainNoise = makeValueNoise(2026);
const scarpNoise = makeValueNoise(77);
const maskNoise = makeValueNoise(1846);

const CRATERS = [
  { cx: 290, cy: 95, r: 22, depth: 14 },
  { cx: 150, cy: 225, r: 14, depth: 9 },
  { cx: 335, cy: 230, r: 9, depth: 6 },
];

const RAMP_ROW = 150;

const elev = new Float32Array(W * H);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    // Delta top in the west, crater floor in the east, with a wavy scarp between.
    const scarpX = 170 + (fbm(scarpNoise, y / 60, 0.5, 3) - 0.5) * 120;
    // One gentle ramp through the scarp, so the two sides are connected by a single corridor.
    const ramp = Math.exp(-(((y - RAMP_ROW) / 20) ** 2));
    const halfWidth = 14 + ramp * 110;
    const plateau = 1 - smoothstep(scarpX - halfWidth, scarpX + halfWidth, x);
    let z = -2560 + plateau * 55;
    z += (fbm(terrainNoise, x / 55, y / 55, 5) - 0.5) * 34;
    z += (fbm(terrainNoise, x / 9 + 40, y / 9 + 40, 2) - 0.5) * 2.2;
    z -= x * 0.012;
    for (const c of CRATERS) {
      const d = Math.hypot(x - c.cx, y - c.cy) / c.r;
      if (d < 1.6) {
        z -= c.depth * (1 - smoothstep(0, 1, d)); // bowl
        z += c.depth * 0.25 * Math.exp(-((d - 1) ** 2) / 0.03); // rim
      }
    }
    elev[y * W + x] = z;
  }
}

// ---------------------------------------------------------------- slope + hillshade
const slope = new Float32Array(W * H);
const shade = new Float32Array(W * H);
const ex = (x, y) => elev[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))];
const sunAz = (315 * Math.PI) / 180;
const sunAlt = (40 * Math.PI) / 180;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const dzdx = (ex(x + 1, y) - ex(x - 1, y)) / (2 * CELL_M); // east positive
    const dzdy = (ex(x, y - 1) - ex(x, y + 1)) / (2 * CELL_M); // north positive (row 0 = north)
    const g = Math.hypot(dzdx, dzdy);
    slope[y * W + x] = (Math.atan(g) * 180) / Math.PI;
    const sl = Math.atan(g * 2.5); // exaggerated for readability
    const aspect = Math.atan2(-dzdx, -dzdy);
    const s = Math.sin(sunAlt) * Math.cos(sl) + Math.cos(sunAlt) * Math.sin(sl) * Math.cos(sunAz - aspect);
    shade[y * W + x] = Math.min(1, Math.max(0, s));
  }
}

// ---------------------------------------------------------------- hazard + no-data
// A blob in the north-east has no slope/hazard coverage, to exercise the
// "no data" code paths (it is NOT the same thing as "forbidden").
const hazard = new Uint8Array(W * H);
const rockNoise = makeValueNoise(4242);
let nodataCount = 0;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const blob = fbm(maskNoise, x / 45, y / 45, 3) + smoothstep(250, 400, x) * 0.3 - smoothstep(60, 220, y) * 0.5;
    if (blob > 0.74) {
      hazard[i] = 255;
      slope[i] = NODATA_F;
      nodataCount++;
      continue;
    }
    const s = slope[i];
    const rocks = fbm(rockNoise, x / 14, y / 14, 3);
    if (s > 25 || rocks > 0.78) hazard[i] = 2;
    else if (s > 15 || rocks > 0.7) hazard[i] = 1;
    else hazard[i] = 0;
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
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function render(pixel) {
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const [r, g, b, a] = pixel(i);
    rgba.set([r, g, b, a], i * 4);
  }
  return encodePng(W, H, rgba);
}

// ---------------------------------------------------------------- layer images
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
const hex = ([r, g, b]) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');

writeFileSync(
  join(dataDir, 'terrain_shade.png'),
  render((i) => {
    const s = 0.25 + 0.75 * shade[i];
    return [Math.round(205 * s), Math.round(150 * s), Math.round(112 * s), 255];
  }),
);
writeFileSync(
  join(dataDir, 'slope.png'),
  render((i) => {
    if (slope[i] === NODATA_F) return [0, 0, 0, 0];
    const band = SLOPE_RAMP.find((b) => slope[i] <= b.upTo);
    return [...band.color, 215];
  }),
);
writeFileSync(
  join(dataDir, 'hazard.png'),
  render((i) => {
    if (hazard[i] === 255) return [0, 0, 0, 0];
    const st = HAZARD_STYLE[hazard[i]];
    return [...st.color, st.alpha];
  }),
);

// ---------------------------------------------------------------- JSON + binaries
const SYNTH = 'SYNTHETIC placeholder generated by scripts/make-fake-data.mjs — not real Mars data.';

const layers = {
  sahte: true,
  not_en: SYNTH,
  katmanlar: [
    {
      id: 'terrain_shade',
      ad_en: 'Shaded relief (synthetic)',
      tur: 'altlik',
      dosya: 'terrain_shade.png',
      koseler: CORNERS,
      kaynak: 'Synthetic terrain (placeholder for an orbital DTM hillshade)',
      cozunurluk_m: CELL_M,
      guven_notu_en: 'Placeholder only. Do not use for any real planning.',
      lejant: [],
    },
    {
      id: 'slope',
      ad_en: 'Slope (synthetic)',
      tur: 'egim',
      dosya: 'slope.png',
      koseler: CORNERS,
      kaynak: 'Derived from the synthetic terrain (placeholder for a DTM-derived slope map)',
      cozunurluk_m: CELL_M,
      guven_notu_en: 'Placeholder only. Transparent area = no data.',
      lejant: SLOPE_RAMP.map((b) => ({ renk: hex(b.color), etiket_en: b.label })),
    },
    {
      id: 'hazard',
      ad_en: 'Hazard classes (synthetic)',
      tur: 'tehlike',
      dosya: 'hazard.png',
      koseler: CORNERS,
      kaynak: 'Thresholded synthetic slope + random rock fields (placeholder)',
      cozunurluk_m: CELL_M,
      guven_notu_en: 'Placeholder only. Transparent area = no data, which is NOT the same as forbidden.',
      lejant: Object.values(HAZARD_STYLE).map((s) => ({ renk: hex(s.color), etiket_en: s.label })),
    },
  ],
};
writeFileSync(join(dataDir, 'katmanlar.json'), JSON.stringify(layers, null, 2));

writeFileSync(
  join(costDir, 'izgara.json'),
  JSON.stringify({ sahte: true, genislik: W, yukseklik: H, hucre_m: CELL_M, koseler: CORNERS }, null, 2),
);
writeFileSync(join(costDir, 'egim.bin'), Buffer.from(slope.buffer));
writeFileSync(join(costDir, 'tehlike.bin'), Buffer.from(hazard.buffer));
const elevOut = Float32Array.from(elev, (z, i) => (hazard[i] === 255 ? NODATA_F : z));
writeFileSync(join(costDir, 'yukseklik.bin'), Buffer.from(elevOut.buffer));

// Science stops (PROPOSED file, not yet in the team contract). No photos: the
// generator does not fabricate surface imagery.
const cellLonLat = (col, row) => {
  const u = (col + 0.5) / W;
  const v = (row + 0.5) / H;
  return [r6(CORNERS[0][0] + u * (CORNERS[1][0] - CORNERS[0][0])), r6(CORNERS[0][1] + v * (CORNERS[3][1] - CORNERS[0][1]))];
};
const stops = {
  sahte: true,
  not_en: SYNTH,
  duraklar: [
    { id: 'stop_a', ad_en: 'Layered outcrop (synthetic)', konum: cellLonLat(70, 60), aciklama_en: 'Placeholder stop on the upper surface. Real description and photo to be supplied.' },
    { id: 'stop_b', ad_en: 'Ramp head (synthetic)', konum: cellLonLat(120, 150), aciklama_en: 'Placeholder stop at the top of the only gentle way down the scarp.' },
    { id: 'stop_c', ad_en: 'Boulder field (synthetic)', konum: cellLonLat(262, 172), aciklama_en: 'Placeholder stop on the lower plain.' },
    { id: 'stop_d', ad_en: 'Unmapped corner (synthetic)', konum: cellLonLat(362, 28), aciklama_en: 'Placeholder stop inside the area with no slope or hazard data, to exercise the no-data warning.' },
  ],
};
writeFileSync(join(dataDir, 'duraklar.json'), JSON.stringify(stops, null, 2));

// Mobility parameters: every number below is an invented placeholder so the UI
// has something to read. The real file (with a source for each number) comes
// from the mechanical engineer.
const PLACEHOLDER = 'PLACEHOLDER — invented for UI development, not sourced';
const traverser = (id, ad_en, azami_egim_derece, speeds, azami_engel_m, azami_sure_saat, enerji_katsayisi) => ({
  id,
  ad_en,
  azami_egim_derece,
  hiz_tablosu: speeds.map(([egim_derece, hiz_m_s]) => ({ egim_derece, hiz_m_s })),
  azami_engel_m,
  azami_sure_saat,
  enerji_katsayisi,
  kaynaklar: {
    azami_egim_derece: PLACEHOLDER,
    hiz_tablosu: PLACEHOLDER,
    azami_engel_m: PLACEHOLDER,
    azami_sure_saat: PLACEHOLDER,
    enerji_katsayisi: PLACEHOLDER,
  },
});
const mobility = {
  sahte: true,
  not_en: SYNTH,
  gezginler: [
    traverser('suited_astronaut', 'Suited astronaut', 20, [[0, 1.0], [5, 0.9], [10, 0.7], [15, 0.5], [20, 0.3]], 0.3, 6, 1.0),
    traverser('loaded_astronaut', 'Astronaut carrying load', 15, [[0, 0.8], [5, 0.7], [10, 0.5], [15, 0.3]], 0.2, 5, 1.4),
    traverser('rover', 'Rover', 25, [[0, 2.5], [5, 2.2], [10, 1.6], [15, 1.0], [20, 0.6], [25, 0.3]], 0.4, 8, 0.6),
  ],
};
writeFileSync(join(outDir, 'mobilite_parametreleri.json'), JSON.stringify(mobility, null, 2));

const pct = ((100 * nodataCount) / (W * H)).toFixed(1);
console.log(`Synthetic data written to ${outDir}`);
console.log(`  grid ${W} x ${H} cells @ ${CELL_M} m = ${W * CELL_M} m x ${H * CELL_M} m, no-data ${pct}%`);
