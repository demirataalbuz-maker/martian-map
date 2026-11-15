// AI-assisted code: written with Antigravity (Google DeepMind), reviewed by the team.
//
// Renders 2x-downsampled RGBA PNG overlays from the v5 binary grids:
//   - public/veri/katman/inis_insanli.png
//   - public/veri/katman/tehlike.png
//   - public/veri/ince/katman/inis_robotik.png
//   - public/veri/ince/katman/tehlike.png
//   - public/veri/ince/katman/puruzluluk.png
//   - public/veri/ince/katman/yukseklik.png

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

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
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const LANDING_PALETTE = {
  0: [80, 210, 140, 195],
  1: [242, 193, 78, 195],
  2: [120, 45, 55, 150],
};

const HAZARD_PALETTE = {
  0: [70, 170, 110, 50],
  1: [240, 190, 50, 195],
  2: [205, 45, 55, 215],
};

function renderOverlay(srcBinPath, gridJsonPath, outPngPath, palette) {
  const meta = JSON.parse(readFileSync(gridJsonPath, 'utf8'));
  const w = meta.genislik;
  const h = meta.yukseklik;
  const bin = readFileSync(srcBinPath);
  if (bin.length !== w * h) {
    throw new Error(`${srcBinPath}: length ${bin.length} != ${w * h}`);
  }

  const outW = Math.ceil(w / 2);
  const outH = Math.ceil(h / 2);
  const rgba = new Uint8Array(outW * outH * 4);

  for (let oy = 0; oy < outH; oy++) {
    const sy0 = oy * 2;
    const sy1 = Math.min(h - 1, sy0 + 1);
    for (let ox = 0; ox < outW; ox++) {
      const sx0 = ox * 2;
      const sx1 = Math.min(w - 1, sx0 + 1);
      const vals = [
        bin[sy0 * w + sx0],
        bin[sy0 * w + sx1],
        bin[sy1 * w + sx0],
        bin[sy1 * w + sx1],
      ];
      let chosen = 255;
      for (const v of vals) {
        if (v !== 255 && (chosen === 255 || v > chosen)) chosen = v;
      }
      const p = (oy * outW + ox) * 4;
      const color = palette[chosen];
      if (color) {
        rgba[p] = color[0];
        rgba[p + 1] = color[1];
        rgba[p + 2] = color[2];
        rgba[p + 3] = color[3];
      }
    }
  }

  mkdirSync(dirname(outPngPath), { recursive: true });
  const png = encodePng(outW, outH, rgba);
  writeFileSync(outPngPath, png);
  console.log(`Wrote ${outPngPath} (${outW}x${outH}, ${(png.length / 1024).toFixed(1)} KB)`);
}

function lerpStops(t, stops) {
  const clamped = Math.max(0, Math.min(1, t));
  for (let i = 0; i + 1 < stops.length; i++) {
    const [t0, c0] = stops[i];
    const [t1, c1] = stops[i + 1];
    if (clamped <= t1 || i + 2 === stops.length) {
      const f = t1 > t0 ? (clamped - t0) / (t1 - t0) : 0;
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * f),
        Math.round(c0[1] + (c1[1] - c0[1]) * f),
        Math.round(c0[2] + (c1[2] - c0[2]) * f),
        Math.round(c0[3] + (c1[3] - c0[3]) * f),
      ];
    }
  }
  return stops[stops.length - 1][1];
}

const ROUGH_STOPS = [
  [0.0, [26, 152, 80, 175]],
  [0.25, [254, 224, 139, 185]],
  [0.45, [244, 109, 67, 200]],
  [1.0, [103, 0, 31, 220]],
];

const ELEV_STOPS = [
  [0.0, [30, 58, 112, 200]],
  [0.25, [45, 134, 128, 200]],
  [0.5, [120, 190, 106, 200]],
  [0.75, [230, 203, 108, 200]],
  [1.0, [217, 107, 61, 210]],
];

function renderRoughnessOverlay(srcBinPath, gridJsonPath, outPngPath, scaleM = 0.05, noData = 255, maxM = 1.2) {
  const meta = JSON.parse(readFileSync(gridJsonPath, 'utf8'));
  const w = meta.genislik;
  const h = meta.yukseklik;
  const bin = readFileSync(srcBinPath);
  if (bin.length !== w * h) throw new Error(`${srcBinPath}: length ${bin.length} != ${w * h}`);

  const outW = Math.ceil(w / 2);
  const outH = Math.ceil(h / 2);
  const rgba = new Uint8Array(outW * outH * 4);
  for (let oy = 0; oy < outH; oy++) {
    const sy0 = oy * 2;
    const sy1 = Math.min(h - 1, sy0 + 1);
    for (let ox = 0; ox < outW; ox++) {
      const sx0 = ox * 2;
      const sx1 = Math.min(w - 1, sx0 + 1);
      const vals = [bin[sy0 * w + sx0], bin[sy0 * w + sx1], bin[sy1 * w + sx0], bin[sy1 * w + sx1]];
      let chosen = -1;
      for (const v of vals) {
        if (v !== noData && v > chosen) chosen = v;
      }
      if (chosen < 0) continue;
      const c = lerpStops((chosen * scaleM) / maxM, ROUGH_STOPS);
      const p = (oy * outW + ox) * 4;
      rgba[p] = c[0];
      rgba[p + 1] = c[1];
      rgba[p + 2] = c[2];
      rgba[p + 3] = c[3];
    }
  }
  mkdirSync(dirname(outPngPath), { recursive: true });
  const png = encodePng(outW, outH, rgba);
  writeFileSync(outPngPath, png);
  console.log(`Wrote ${outPngPath} (${outW}x${outH}, ${(png.length / 1024).toFixed(1)} KB)`);
}

function renderElevOverlay(srcBinPath, gridJsonPath, outPngPath) {
  const meta = JSON.parse(readFileSync(gridJsonPath, 'utf8'));
  const w = meta.genislik;
  const h = meta.yukseklik;
  const buf = readFileSync(srcBinPath);
  const view = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
  if (view.length !== w * h) throw new Error(`${srcBinPath}: count ${view.length} != ${w * h}`);

  const baseM = meta.yukseklik_taban_m ?? -2000;
  const scaleM = meta.yukseklik_olcek_m ?? 0.1;
  const noData = meta.yukseklik_veri_yok ?? -32768;

  let minRaw = Infinity;
  let maxRaw = -Infinity;
  for (let i = 0; i < view.length; i++) {
    const v = view[i];
    if (v !== noData) {
      if (v < minRaw) minRaw = v;
      if (v > maxRaw) maxRaw = v;
    }
  }
  const spanRaw = Math.max(1, maxRaw - minRaw);
  const outW = Math.ceil(w / 2);
  const outH = Math.ceil(h / 2);
  const rgba = new Uint8Array(outW * outH * 4);

  for (let oy = 0; oy < outH; oy++) {
    const sy0 = oy * 2;
    const sy1 = Math.min(h - 1, sy0 + 1);
    for (let ox = 0; ox < outW; ox++) {
      const sx0 = ox * 2;
      const sx1 = Math.min(w - 1, sx0 + 1);
      const rawVals = [view[sy0 * w + sx0], view[sy0 * w + sx1], view[sy1 * w + sx0], view[sy1 * w + sx1]];
      let sum = 0;
      let cnt = 0;
      for (const v of rawVals) {
        if (v !== noData) {
          sum += v;
          cnt++;
        }
      }
      if (cnt === 0) continue;
      const avg = sum / cnt;
      const c = lerpStops((avg - minRaw) / spanRaw, ELEV_STOPS);
      const p = (oy * outW + ox) * 4;
      rgba[p] = c[0];
      rgba[p + 1] = c[1];
      rgba[p + 2] = c[2];
      rgba[p + 3] = c[3];
    }
  }
  mkdirSync(dirname(outPngPath), { recursive: true });
  const png = encodePng(outW, outH, rgba);
  writeFileSync(outPngPath, png);
  const minM = (baseM + minRaw * scaleM).toFixed(0);
  const maxM = (baseM + maxRaw * scaleM).toFixed(0);
  console.log(`Wrote ${outPngPath} (${outW}x${outH}, ${minM}m..${maxM}m, ${(png.length / 1024).toFixed(1)} KB)`);
}

const veriDir = resolve(process.argv[2] ?? 'public/veri');
renderOverlay(
  join(veriDir, 'maliyet/inis_insanli.bin'),
  join(veriDir, 'maliyet/izgara.json'),
  join(veriDir, 'katman/inis_insanli.png'),
  LANDING_PALETTE,
);
renderOverlay(
  join(veriDir, 'maliyet/tehlike.bin'),
  join(veriDir, 'maliyet/izgara.json'),
  join(veriDir, 'katman/tehlike.png'),
  HAZARD_PALETTE,
);
renderOverlay(
  join(veriDir, 'ince/maliyet/inis_robotik.bin'),
  join(veriDir, 'ince/maliyet/izgara.json'),
  join(veriDir, 'ince/katman/inis_robotik.png'),
  LANDING_PALETTE,
);
renderOverlay(
  join(veriDir, 'ince/maliyet/tehlike.bin'),
  join(veriDir, 'ince/maliyet/izgara.json'),
  join(veriDir, 'ince/katman/tehlike.png'),
  HAZARD_PALETTE,
);
renderRoughnessOverlay(
  join(veriDir, 'ince/maliyet/puruzluluk.bin'),
  join(veriDir, 'ince/maliyet/izgara.json'),
  join(veriDir, 'ince/katman/puruzluluk.png'),
);
renderElevOverlay(
  join(veriDir, 'ince/maliyet/yukseklik.bin'),
  join(veriDir, 'ince/maliyet/izgara.json'),
  join(veriDir, 'ince/katman/yukseklik.png'),
);
