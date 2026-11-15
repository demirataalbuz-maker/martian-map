import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[a-z0-9]+$/i.test(specifier)) {
      const parentPath = context.parentURL ? new URL(context.parentURL).pathname.replace(/^\/([A-Za-z]:)/, '$1') : ROOT;
      const candidate = path.resolve(path.dirname(parentPath), `${specifier}.ts`);
      if (fs.existsSync(candidate)) {
        return { shortCircuit: true, url: pathToFileURL(candidate).href };
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith('/src/config.ts')) {
      const filePath = new URL(url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
      const source = fs.readFileSync(filePath, 'utf8').replaceAll('import.meta.env.BASE_URL', "'/'");
      return { shortCircuit: true, format: 'module-typescript', source };
    }
    return nextLoad(url, context);
  },
});

const { DataLoadError, fetchJson, makeGridGeoOrThrow } = {};
const dataMod = await import(pathToFileURL(path.join(ROOT, 'src', 'data.ts')).href);
const workerMod = await import(pathToFileURL(path.join(ROOT, 'src', 'route-worker.ts')).href);
const gridMod = await import(pathToFileURL(path.join(ROOT, 'src', 'grid.ts')).href);

const {
  initGridFromBuffers,
  computeRouteForTest,
  computeCompareForTest,
  computeEscapeForTest,
  MAX_OPTIMIZE_STOPS,
} = workerMod;

function readJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relPath), 'utf8'));
}

function readBinTyped(relPath, ArrayCtor) {
  const buf = fs.readFileSync(path.join(ROOT, relPath));
  return new ArrayCtor(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / ArrayCtor.BYTES_PER_ELEMENT));
}

function toRouter(t, ground = null) {
  return {
    maxSlopeDeg: t.azami_egim_derece,
    speedTable: t.hiz_tablosu.map((e) => [e.egim_derece, e.hiz_m_s]),
    downhillSpeedTable: t.inis_hiz_tablosu?.map((e) => [e.egim_derece, e.hiz_m_s]),
    maxTimeS: typeof t.azami_sure_saat === 'number' && t.azami_sure_saat > 0 ? t.azami_sure_saat * 3600 : null,
    maxRadialDistM: typeof t.uzaklik_tavani_m === 'number' && t.uzaklik_tavani_m > 0 ? t.uzaklik_tavani_m : null,
    stintDistM: typeof t.sefer_mesafe_m === 'number' && t.sefer_mesafe_m > 0 ? t.sefer_mesafe_m : null,
    totalDistCapM: typeof t.toplam_menzil_m === 'number' && t.toplam_menzil_m > 0 ? t.toplam_menzil_m : null,
    energyProfile: t.enerji_profili ?? null,
    groundModel: ground
      ? {
          tiLooseThreshold: ground.tiLooseThreshold,
          tiVeryLooseThreshold: ground.tiVeryLooseThreshold,
          looseSpeedFactor: ground.looseSpeedFactor,
          veryLooseSpeedFactor: ground.veryLooseSpeedFactor,
          hardRollingResistance: ground.hardRollingResistance,
          looseRollingResistance: ground.looseRollingResistance,
          veryLooseRollingResistance: ground.veryLooseRollingResistance,
        }
      : null,
  };
}

function supercoverSegmentCells(c0, r0, c1, r1, width) {
  const out = [];
  let c = c0;
  let r = r0;
  const dc = Math.abs(c1 - c0);
  const dr = Math.abs(r1 - r0);
  const sc = c1 > c0 ? 1 : c1 < c0 ? -1 : 0;
  const sr = r1 > r0 ? 1 : r1 < r0 ? -1 : 0;
  let err = dc - dr;
  out.push(r * width + c);
  while (c !== c1 || r !== r1) {
    const e2 = 2 * err;
    const stepC = e2 > -dr;
    const stepR = e2 < dc;
    if (stepC && stepR) {
      out.push(r * width + (c + sc));
      out.push((r + sr) * width + c);
    }
    if (stepC) {
      err -= dr;
      c += sc;
    }
    if (stepR) {
      err += dc;
      r += sr;
    }
    out.push(r * width + c);
  }
  return out;
}

const results = [];
async function test(name, fn) {
  await fn();
  results.push(name);
  console.log(`PASS: ${name}`);
}

const mainMobRaw = readJson('public/mobilite_parametreleri.json');
const cagRaw = readJson('public/veri/mobilite_cagatay_2026-11-15.json');
const mobility = dataMod.parseMobilityParams(mainMobRaw, cagRaw);
const walkingTrav = mobility.traversers.find((t) => t.id === 'yuruyen_insan');
const crewedTrav = mobility.traversers.find((t) => t.id === 'roverli_insan');
const roverTrav = mobility.traversers.find((t) => t.id === 'rover');
assert(walkingTrav && crewedTrav && roverTrav, 'All 3 traversers loaded');

// ------------------------------------------------------------ Item 5
await test('Item 5: fetchJson HTML fallback throws DataLoadError & parseMobilityParams ignores lander', async () => {
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response('<!doctype html><html><body>SPA fallback</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    let caught = null;
    try {
      await dataMod.fetchJson('/veri/missing_test.json');
    } catch (err) {
      caught = err;
    }
    assert(caught instanceof dataMod.DataLoadError, 'Expected DataLoadError');
    assert.equal(caught.url, '/veri/missing_test.json');
    assert.match(caught.reason, /HTML/i);
  } finally {
    globalThis.fetch = origFetch;
  }
  assert.equal(mobility.traversers.length, 3);
  assert(mobility.ground && mobility.ground.guvenler.gevsek_hiz_carpani === 'VARSAYIM');
  assert(Array.isArray(crewedTrav.inis_hiz_tablosu) && crewedTrav.inis_hiz_tablosu.length > 0);
});

// ------------------------------------------------------------ Item 1
await test('Item 1: Energy reserve breach triggers NO-GO (broken: energy), energyCell & unsafeMask', () => {
  const w = 60;
  const h = 40;
  const n = w * h;
  const cellM = 500;
  const hazard = new Uint8Array(n);
  const slopeU8 = new Uint8Array(n);
  // Flat loose-sand test bed (TI=150 -> c_rr=0.12) keeps speed/time/radial/walk-back safe while exhausting >3000 Wh usable energy on a ~20 km box loop.
  const thermalU16 = new Uint16Array(n).fill(150);
  initGridFromBuffers({ width: w, height: h, cellM, slopeU8, hazard, thermalU16 });

  const tr = toRouter(crewedTrav, mobility.ground);
  const wb = { traverser: toRouter(walkingTrav, mobility.ground), limitS: (crewedTrav.yasam_destek_saat ?? 6.4) * 3600 };

  // Short trip (~6 km RT, ~1300 Wh < 3000 Wh) -> must NOT exceed energy
  const shortRes = computeRouteForTest({
    mode: 'manual',
    waypoints: [20 * w + 10, 20 * w + 16],
    roundTrip: true,
    minSeparationM: 0,
    allowNoData: false,
    assumedTerrainData: false,
    hasThermalInertiaData: true,
    hasRockData: true,
    traverser: tr,
    walkBack: wb,
  });
  assert.equal(shortRes.ok, true);
  assert.equal(shortRes.energyExceeded, false);
  assert.notEqual(shortRes.decision, 'NO-GO');

  // Box loop within <= 7.1 km max radial (< 10 km), < 4 h time (< 8 h), walk-back < 6.4 h, but > 3000 Wh usable energy!
  const loopRes = computeRouteForTest({
    mode: 'manual',
    waypoints: [20 * w + 10, 12 * w + 10, 12 * w + 18, 20 * w + 18, 20 * w + 10],
    roundTrip: false,
    minSeparationM: 0,
    allowNoData: false,
    assumedTerrainData: false,
    hasThermalInertiaData: true,
    hasRockData: true,
    traverser: tr,
    walkBack: wb,
  });
  assert.equal(loopRes.ok, true);
  assert.equal(loopRes.energyExceeded, true, `Expected energyExceeded=true, used=${loopRes.energyUsed_wh} usable=${loopRes.energyUsable_wh}`);
  assert.equal(loopRes.decision, 'NO-GO');
  assert.deepEqual(loopRes.brokenConditions, ['energy'], `Expected ONLY ['energy'] broken, got ${loopRes.brokenConditions}`);
  assert.notEqual(loopRes.energyCell, null);
  assert.notEqual(loopRes.energyDist_m, null);
  assert(loopRes.energyRemaining_wh < loopRes.energyReserve_wh);
  assert(loopRes.unsafeMask !== null && loopRes.unsafeMask[0] === 0 && loopRes.unsafeMask[loopRes.unsafeMask.length - 1] === 1);
  console.log(`  pure energy NO-GO route: used=${Math.round(loopRes.energyUsed_wh)} Wh / usable=${Math.round(loopRes.energyUsable_wh)} Wh -> ${loopRes.decision} (${loopRes.brokenConditions.join(',')})`);
});

// ------------------------------------------------------------ Item 2
await test('Item 2: Optional TSP stop optimization preserves click order by default, reorders <=7, caps >=8', () => {
  const w = 100;
  const h = 20;
  const n = w * h;
  initGridFromBuffers({ width: w, height: h, cellM: 100, slopeU8: new Uint8Array(n), hazard: new Uint8Array(n) });
  const tr = toRouter(walkingTrav, null);

  const stops = [10 * w + 80, 10 * w + 20, 10 * w + 45]; // out of order from start (10, 10)
  const start = 10 * w + 10;

  const offRes = computeRouteForTest({
    mode: 'manual',
    waypoints: [start, ...stops],
    roundTrip: false,
    optimizeStops: false,
    minSeparationM: 0,
    allowNoData: false,
    assumedTerrainData: false,
    hasThermalInertiaData: true,
    hasRockData: true,
    traverser: tr,
    walkBack: null,
  });
  assert.equal(offRes.ok, true);
  assert.equal(offRes.stopOrderChanged, false);
  assert.deepEqual(offRes.stopOrder, [0, 1, 2]);

  const onRes = computeRouteForTest({
    mode: 'manual',
    waypoints: [start, ...stops],
    roundTrip: false,
    optimizeStops: true,
    minSeparationM: 0,
    allowNoData: false,
    assumedTerrainData: false,
    hasThermalInertiaData: true,
    hasRockData: true,
    traverser: tr,
    walkBack: null,
  });
  assert.equal(onRes.ok, true);
  assert.equal(onRes.stopOrderChanged, true);
  assert.deepEqual(onRes.stopOrder, [1, 2, 0]);
  assert(onRes.unoptimizedTime_s !== null && onRes.time_s < onRes.unoptimizedTime_s);

  const eightStops = [80, 20, 70, 30, 60, 40, 55, 25].map((c) => 10 * w + c);
  const capRes = computeRouteForTest({
    mode: 'manual',
    waypoints: [start, ...eightStops],
    roundTrip: false,
    optimizeStops: true,
    minSeparationM: 0,
    allowNoData: false,
    assumedTerrainData: false,
    hasThermalInertiaData: true,
    hasRockData: true,
    traverser: tr,
    walkBack: null,
  });
  assert.equal(capRes.ok, true);
  assert.equal(capRes.stopOrderCap, MAX_OPTIMIZE_STOPS);
  assert.equal(capRes.stopOrderCapped, true);
  assert.equal(capRes.stopOrderChanged, false);
  assert.deepEqual(capRes.stopOrder, [0, 1, 2, 3, 4, 5, 6, 7]);
  console.log(`  TSP 3 stops: off=${Math.round(offRes.time_s)}s, on=${Math.round(onRes.time_s)}s (order=${onRes.stopOrder.join(',')}), 8 stops capped=${capRes.stopOrderCapped}`);
});

// ------------------------------------------------------------ Item 3
await test('Item 3: Directed uphill/downhill search & removal of symmetry shortcuts', () => {
  const w = 60;
  const h = 10;
  const n = w * h;
  const cellM = 100;
  const hazard = new Uint8Array(n);
  const landing = new Uint8Array(n).fill(2);
  const slopeU8 = new Uint8Array(n);
  const elevF32 = new Float32Array(n);
  const tan10 = Math.tan((10 * Math.PI) / 180);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      slopeU8[r * w + c] = 10;
      elevF32[r * w + c] = c * cellM * tan10;
    }
  }
  landing[5 * w + 5] = 0; // suitable landing base at west bottom

  initGridFromBuffers({ width: w, height: h, cellM, slopeU8, hazard, landing, elevF32 });

  const asymTrav = {
    maxSlopeDeg: 15,
    speedTable: [[0, 2.0], [10, 0.5], [15, 0]],
    downhillSpeedTable: [[0, 2.0], [10, 1.5], [15, 0]],
    maxTimeS: 9000,
  };

  const a = 5 * w + 5;
  const b = 5 * w + 35; // 3000 m east (uphill a->b, downhill b->a)

  const upOnly = computeRouteForTest({
    mode: 'manual',
    waypoints: [a, b],
    roundTrip: false,
    minSeparationM: 0,
    allowNoData: false,
    assumedTerrainData: false,
    hasThermalInertiaData: true,
    hasRockData: true,
    traverser: asymTrav,
    walkBack: null,
  });
  const downOnly = computeRouteForTest({
    mode: 'manual',
    waypoints: [b, a],
    roundTrip: false,
    minSeparationM: 0,
    allowNoData: false,
    assumedTerrainData: false,
    hasThermalInertiaData: true,
    hasRockData: true,
    traverser: asymTrav,
    walkBack: null,
  });
  assert.equal(upOnly.ok, true);
  assert.equal(downOnly.ok, true);
  // 3000 / 0.5 = 6000 s uphill; 3000 / 1.5 = 2000 s downhill
  assert(Math.abs(upOnly.time_s - 6000) < 50, `Expected ~6000 s uphill, got ${upOnly.time_s}`);
  assert(Math.abs(downOnly.time_s - 2000) < 50, `Expected ~2000 s downhill, got ${downOnly.time_s}`);

  // 1-leg round trip must compute return independently (not reverse outbound leg duration!)
  const rtRes = computeRouteForTest({
    mode: 'manual',
    waypoints: [a, b],
    roundTrip: true,
    minSeparationM: 0,
    allowNoData: false,
    assumedTerrainData: false,
    hasThermalInertiaData: true,
    hasRockData: true,
    traverser: asymTrav,
    walkBack: null,
  });
  assert.equal(rtRes.ok, true);
  assert.equal(rtRes.legs.length, 2);
  assert(Math.abs(rtRes.legs[0].time_s - 6000) < 50);
  assert(Math.abs(rtRes.legs[1].time_s - 2000) < 50);

  // Auto-landing reachability check: outbound 6000 s > 9000 * 0.5 (4500 s), but round trip 6000+2000 = 8000 <= 9000 s!
  const autoRes = computeRouteForTest({
    mode: 'auto-landing',
    waypoints: [b],
    roundTrip: true,
    minSeparationM: 0,
    allowNoData: false,
    assumedTerrainData: false,
    hasThermalInertiaData: true,
    hasRockData: true,
    traverser: asymTrav,
    walkBack: null,
  });
  assert.equal(autoRes.ok, true, 'Auto-landing must succeed when asymmetric outbound (6000s) + downhill return (2000s) <= 9000s');
  assert.equal(autoRes.activeLandingCell, a);

  // Walk-back direction check: walker placed uphill at b returning downhill to a should use walker downhill speed (1.5 vs 0.5)!
  const wbAsym = computeRouteForTest({
    mode: 'manual',
    waypoints: [b, a],
    roundTrip: false,
    minSeparationM: 0,
    allowNoData: false,
    assumedTerrainData: false,
    hasThermalInertiaData: true,
    hasRockData: true,
    traverser: { ...asymTrav, speedTable: [[0, 2.0], [10, 2.0], [15, 0]], downhillSpeedTable: [[0, 2.0], [10, 2.0], [15, 0]] },
    walkBack: { traverser: asymTrav, limitS: 8000 },
  });
  // Near start b, returning back to b is ~0s; at cell a, return walk a->b is UPHILL (6000s + travel 1500s = 7500s <= 8000s)!
  assert.equal(wbAsym.ok, true);
  assert(wbAsym.maxWalkBackTotal_s !== null && wbAsym.maxWalkBackTotal_s > 7000 && !wbAsym.walkBackExceeded);
  console.log(`  Directed times: up=${Math.round(upOnly.time_s)}s, down=${Math.round(downOnly.time_s)}s, autoLanding=ok, walkBack=${Math.round(wbAsym.maxWalkBackTotal_s)}s`);
});

// ------------------------------------------------------------ Item 4
await test('Item 4: THEMIS Thermal Inertia ground model scales speed & rolling resistance', () => {
  const w = 40;
  const h = 10;
  const n = w * h;
  const start = 5 * w + 5;
  const goal = 5 * w + 35; // 3000 m at 100 m/cell
  const tr = toRouter(crewedTrav, mobility.ground);

  const runTier = (tiVal) => {
    initGridFromBuffers({
      width: w,
      height: h,
      cellM: 100,
      slopeU8: new Uint8Array(n),
      hazard: new Uint8Array(n),
      thermalU16: new Uint16Array(n).fill(tiVal),
    });
    return computeRouteForTest({
      mode: 'manual',
      waypoints: [start, goal],
      roundTrip: false,
      minSeparationM: 0,
      allowNoData: false,
      assumedTerrainData: false,
      hasThermalInertiaData: true,
      hasRockData: true,
      traverser: tr,
      walkBack: null,
    });
  };

  const firm = runTier(420);
  const loose = runTier(260);
  const sand = runTier(150);
  assert(firm.ok && loose.ok && sand.ok);
  assert.equal(firm.hasThermalInertiaGrid, true);
  assert.equal(firm.looseGroundM, 0);
  assert(Math.abs(loose.looseGroundM - 3000) < 1);
  assert(Math.abs(sand.looseGroundM - 3000) < 1);
  assert(Math.abs(firm.time_s / loose.time_s - 0.85) < 0.01, `Expected ~0.85 speed ratio, got ${firm.time_s / loose.time_s}`);
  assert(Math.abs(firm.time_s / sand.time_s - 0.70) < 0.01, `Expected ~0.70 speed ratio, got ${firm.time_s / sand.time_s}`);
  assert(loose.energyDrive_wh > firm.energyDrive_wh * 1.5, 'c_rr=0.08 vs 0.05 should increase drive Wh by 1.6x');
  assert(sand.energyDrive_wh > firm.energyDrive_wh * 2.2, 'c_rr=0.12 vs 0.05 should increase drive Wh by 2.4x');
  console.log(`  TI tiers time: firm=${Math.round(firm.time_s)}s, loose=${Math.round(loose.time_s)}s, sand=${Math.round(sand.time_s)}s; driveWh=${firm.energyDrive_wh.toFixed(1)}/${loose.energyDrive_wh.toFixed(1)}/${sand.energyDrive_wh.toFixed(1)}`);
});

// ------------------------------------------------------------ Item 8
await test('Item 8: Smoothing eliminates diagonal staircase inflation & never grazes forbidden cells', () => {
  const w = 60;
  const h = 60;
  const n = w * h;
  const cellM = 100;
  const hazard = new Uint8Array(n);
  const slopeU8 = new Uint8Array(n);
  initGridFromBuffers({ width: w, height: h, cellM, slopeU8, hazard });

  const openRes = computeRouteForTest({
    mode: 'manual',
    waypoints: [5 * w + 5, 35 * w + 45], // exact dx=4000, dy=3000 -> hypot=5000.0 m
    roundTrip: false,
    minSeparationM: 0,
    allowNoData: false,
    assumedTerrainData: false,
    hasThermalInertiaData: true,
    hasRockData: true,
    traverser: toRouter(walkingTrav, null),
    walkBack: null,
  });
  assert.equal(openRes.ok, true);
  assert(openRes.distance_m >= 4999 && openRes.distance_m <= 5030, `Expected ~5000 m Euclidean after smoothing, got ${openRes.distance_m}`);

  // Wall blocking the direct chord: column 25 forbidden from row 0..38
  for (let r = 0; r <= 38; r++) hazard[r * w + 25] = 2;
  initGridFromBuffers({ width: w, height: h, cellM, slopeU8, hazard });
  const wallRes = computeRouteForTest({
    mode: 'manual',
    waypoints: [5 * w + 5, 35 * w + 45],
    roundTrip: false,
    minSeparationM: 0,
    allowNoData: false,
    assumedTerrainData: false,
    hasThermalInertiaData: true,
    hasRockData: true,
    traverser: toRouter(walkingTrav, null),
    walkBack: null,
  });
  assert.equal(wallRes.ok, true);
  assert(wallRes.pathCols && wallRes.pathRows);
  for (let k = 1; k < wallRes.path.length; k++) {
    const c0 = Math.round(wallRes.pathCols[k - 1]);
    const r0 = Math.round(wallRes.pathRows[k - 1]);
    const c1 = Math.round(wallRes.pathCols[k]);
    const r1 = Math.round(wallRes.pathRows[k]);
    for (const cIdx of supercoverSegmentCells(c0, r0, c1, r1, w)) {
      assert.notEqual(hazard[cIdx], 2, `Smoothed segment grazed forbidden cell at col=${cIdx % w}, row=${Math.floor(cIdx / w)}`);
    }
  }
  console.log(`  Smoothing: open 4x3 km diagonal dist=${openRes.distance_m.toFixed(1)} m (exact 5000.0 m); wall detour segments=0 forbidden touches`);
});

// ------------------------------------------------------------ Item 7 (Real Package v5)
await test('Item 7: Real Package v5 Sample Mission (20 m crewed & 5 m HiRISE rover) returns non-NO-GO across all 3 traversers', () => {
  const duraklar = readJson('public/veri/duraklar.json').duraklar;

  // 20 m CTX scenario
  const ctxMeta = readJson('public/veri/maliyet/izgara.json');
  const ctxGeo = gridMod.makeGridGeo(ctxMeta);
  initGridFromBuffers({
    width: ctxMeta.genislik,
    height: ctxMeta.yukseklik,
    cellM: ctxMeta.hucre_m,
    slopeU8: readBinTyped('public/veri/maliyet/egim.bin', Uint8Array),
    slopeNoData: ctxMeta.egim_veri_yok,
    slopeScale: ctxMeta.egim_olcek,
    hazard: readBinTyped('public/veri/maliyet/tehlike.bin', Uint8Array),
    landing: readBinTyped('public/veri/maliyet/inis_insanli.bin', Uint8Array),
    elevI16: readBinTyped('public/veri/maliyet/yukseklik.bin', Int16Array),
    elevBaseM: ctxMeta.yukseklik_taban_m,
    elevScaleM: ctxMeta.yukseklik_olcek_m,
    elevNoData: ctxMeta.yukseklik_veri_yok,
    thermalU16: readBinTyped('public/veri/maliyet/termal_atalet.bin', Uint16Array),
  });

  const ctxSampleCells = duraklar.slice(0, 2).map((s) => ctxGeo.lonLatToIndex(s.konum[0], s.konum[1]));
  assert(ctxSampleCells.every((c) => c !== null));
  const crewedLander = mobility.landingCraftCrewed ?? mobility.landingCraft;

  for (const t of [walkingTrav, crewedTrav]) {
    const wbWalker = t.id === 'roverli_insan' ? walkingTrav : null;
    const res = computeRouteForTest({
      mode: 'auto-landing',
      waypoints: ctxSampleCells,
      roundTrip: true,
      stopWorkS: 0,
      minSeparationM: crewedLander?.guvenli_alan_capi_m ?? 0,
      minTargetStandoffM: crewedLander?.puskurtme_guvenlik_yaricapi_m ?? 0,
      allowNoData: false,
      assumedTerrainData: false,
      hasThermalInertiaData: true,
      hasRockData: false,
      traverser: toRouter(t, mobility.ground),
      walkBack: wbWalker ? { traverser: toRouter(wbWalker, mobility.ground), limitS: (t.yasam_destek_saat ?? 6.4) * 3600 } : null,
    });
    assert.equal(res.ok, true, `${t.id} failed on Sample Mission`);
    console.log(`  20 m ${t.id} Sample: decision=${res.decision}, dist=${Math.round(res.distance_m)}m, time=${(res.time_s / 3600).toFixed(2)}h, reasons=[${res.decisionReasons.join('; ')}]`);
    assert.notEqual(res.decision, 'NO-GO', `${t.id} Sample Mission returned NO-GO: ${res.decisionReasons.join('; ')}`);
  }

  // 5 m HiRISE scenario
  const fineMeta = readJson('public/veri/ince/maliyet/izgara.json');
  const fineGeo = gridMod.makeGridGeo(fineMeta);
  initGridFromBuffers({
    width: fineMeta.genislik,
    height: fineMeta.yukseklik,
    cellM: fineMeta.hucre_m,
    slopeU8: readBinTyped('public/veri/ince/maliyet/egim.bin', Uint8Array),
    slopeNoData: fineMeta.egim_veri_yok,
    slopeScale: fineMeta.egim_olcek,
    hazard: readBinTyped('public/veri/ince/maliyet/tehlike.bin', Uint8Array),
    landing: readBinTyped('public/veri/ince/maliyet/inis_robotik.bin', Uint8Array),
    elevF32: readBinTyped('public/veri/ince/maliyet/yukseklik.bin', Float32Array),
    elevBaseM: fineMeta.yukseklik_taban_m,
    elevScaleM: fineMeta.yukseklik_olcek_m,
    elevNoData: fineMeta.yukseklik_veri_yok,
  });

  const fineSampleCells = duraklar.slice(0, 2).map((s) => fineGeo.lonLatToIndex(s.konum[0], s.konum[1]));
  assert(fineSampleCells.every((c) => c !== null));
  const roboticLander = mobility.landingCraftRobotic ?? mobility.landingCraft;
  const roverRes = computeRouteForTest({
    mode: 'auto-landing',
    waypoints: fineSampleCells,
    roundTrip: true,
    stopWorkS: 0,
    minSeparationM: roboticLander?.guvenli_alan_capi_m ?? 0,
    minTargetStandoffM: roboticLander?.puskurtme_guvenlik_yaricapi_m ?? 0,
    allowNoData: false,
    assumedTerrainData: true,
    hasThermalInertiaData: false,
    hasRockData: false,
    traverser: toRouter(roverTrav, null),
    walkBack: null,
  });
  assert.equal(roverRes.ok, true);
  console.log(`  5 m rover Sample: decision=${roverRes.decision}, dist=${Math.round(roverRes.distance_m)}m, stints=${roverRes.totalStints}, reasons=[${roverRes.decisionReasons.join('; ')}]`);
  assert.notEqual(roverRes.decision, 'NO-GO');
});

// ------------------------------------------------------------ Globe catalog & tiles
await test('Globe Catalog: Viking color default ON, license labeled, screening overlays OFF, 1365 local tiles', () => {
  const cat = readJson('public/veri/katmanlar.json');
  const kureLayers = cat.katmanlar.filter((l) => l.alan === 'kure');
  const viking = kureLayers.find((l) => l.id === 'kure_viking_renkli');
  assert(viking, 'kure_viking_renkli present');
  assert.equal(viking.varsayilan_acik, true);
  assert(viking.kaynak && viking.kaynak.includes('USGS'));
  assert(viking.lisans && viking.lisans.includes('Public Domain'));
  for (const other of kureLayers) {
    if (other.id !== 'kure_viking_renkli') {
      assert.equal(other.varsayilan_acik, false, `${other.id} should default to OFF`);
    }
  }
  const tileDir = path.join(ROOT, 'public', 'veri', 'karolar', 'kure_viking_renkli');
  let count = 0;
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (ent.isDirectory()) walk(path.join(d, ent.name));
      else if (ent.name.endsWith('.webp')) count++;
    }
  };
  walk(tileDir);
  assert.equal(count, 1365);
});

console.log(`\nALL ${results.length} CHECKS PASSED.`);
