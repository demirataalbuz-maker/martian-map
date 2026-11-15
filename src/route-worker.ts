// AI-assisted code: written with Claude (Anthropic) and Antigravity (Google DeepMind), reviewed by the team.
//
// Routing Web Worker:
//   1) Compact binary cost grids: Uint8 ceiling-quantized slope + little-endian Int16 elevation
//      (lazy-loaded on 1st route, with streaming download progress), Uint8 hazard & landing grids.
//   2) 256-entry per-traverser speed lookup tables (zero full-grid cellSpeed allocation).
//   3) Windowed 8-connected A* with border-touch re-expansion, plus windowed Reverse-Dijkstra
//      landing recommender with range clipping, round-trip return, no-data toggle, cell probing,
//      and multi-traverser comparison.

/// <reference lib="webworker" />

import type {
  BlockReason,
  BrokenCondition,
  EscapeResult,
  FromWorker,
  LandingCandidate,
  RouteFailure,
  RouteLeg,
  RouteSuccess,
  RouterEnergyProfile,
  RouterGroundModel,
  RouterTraverser,
  SafetyDecision,
  StintStop,
  ToWorker,
  TraverserComparisonRow,
  WalkBackSpec,
} from './route-types';

const isWorkerRuntime =
  typeof self !== 'undefined' &&
  typeof (self as { postMessage?: unknown }).postMessage === 'function' &&
  typeof document === 'undefined';
const ctx = isWorkerRuntime ? (self as unknown as DedicatedWorkerGlobalScope) : null;
const post = (message: FromWorker, transfer: Transferable[] = []) => {
  if (ctx) ctx.postMessage(message, transfer);
};

export const MAX_OPTIMIZE_STOPS = 7;

const ELEV_MIN_VALID = -9000;
const THERMAL_NODATA = 0;

const HAZARD_FREE = 0;
const HAZARD_CAUTION = 1;
const HAZARD_FORBIDDEN = 2;
const HAZARD_NODATA = 255;

const LANDING_SUITABLE = 0;
const LANDING_MARGINAL = 1;

const MAX_LANDING_CANDIDATES = 3;
/** Fraction of total grid cells retained for reusable search window buffers after a route completes. */
const RETAINED_WINDOW_FRACTION = 0.08;
const PARENT_NONE = 255;

const IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

let width = 0;
let height = 0;
let cellM = 0;

let slopeType: 'uint8' | 'float32' = 'uint8';
let slopeScale = 1;
let slopeNoData = 255;
let slopeU8: Uint8Array | null = null;
let slopeF32: Float32Array | null = null;

let elevationUrl = '';
let elevType: 'int16' | 'float32' = 'int16';
let elevBaseM = 0;
let elevScaleM = 1;
let elevNoData = -32768;
let elevLoaded = false;
let elevLoadPromise: Promise<void> | null = null;
let elevI16: Int16Array | null = null;
let elevF32: Float32Array | null = null;

let hazard: Uint8Array | null = null;
/** Optional landing suitability grid (inis.bin): 0 suitable, 1 marginal, 2 forbidden, 255 no data. */
let landing: Uint8Array | null = null;
/** Optional uint16 thermal inertia grid (termal_atalet.bin): J m^-2 K^-1 s^-1/2, 0 = no data. */
let thermalU16: Uint16Array | null = null;

interface CachedGridState {
  width: number;
  height: number;
  cellM: number;
  slopeType: 'uint8' | 'float32';
  slopeScale: number;
  slopeNoData: number;
  slopeU8: Uint8Array | null;
  slopeF32: Float32Array | null;
  elevationUrl: string;
  elevType: 'int16' | 'float32';
  elevBaseM: number;
  elevScaleM: number;
  elevNoData: number;
  elevLoaded: boolean;
  elevLoadPromise: Promise<void> | null;
  elevI16: Int16Array | null;
  elevF32: Float32Array | null;
  hazard: Uint8Array;
  landing: Uint8Array | null;
  thermalU16: Uint16Array | null;
  noDataCells: number;
  totalCells: number;
}

const gridCache = new Map<string, CachedGridState>();
let activeScenarioKey = '';

// 256-entry directional speed lookup tables (~4 KB total; avoids full-grid speed allocation)
let speedKey = '';
const speedFreeLut = new Float32Array(256);
const downFreeLut = new Float32Array(256);
const speedCautionLut = new Float32Array(256);
const speedNoDataHazardLut = new Float32Array(256);
let slowestSpeed = 0;
let maxSpeed = 0;
let currentMaxSlopeDeg = 0;
let currentAllowNoData = false;
let currentSpeedTable: [number, number][] = [];
let currentDownhillTable: [number, number][] = [];
let currentGroundModel: RouterGroundModel | null = null;

// Window-scoped stamp search state (~11 B per window cell: 8 B Float64 gScore + 1 B parentDir + 2 B Uint16 stamp)
let gScore = new Float64Array(0);
let parentDir = new Uint8Array(0);
let stamp = new Uint16Array(0);
let searchId = 0;

function ensureWindow(winCells: number): void {
  if (stamp.length < winCells) {
    gScore = new Float64Array(winCells);
    parentDir = new Uint8Array(winCells);
    stamp = new Uint16Array(winCells);
    searchId = 0;
  }
}

function trimWindowBuffers(): void {
  const maxRetained = Math.ceil(width * height * RETAINED_WINDOW_FRACTION);
  if (maxRetained > 0 && stamp.length > maxRetained) {
    gScore = new Float64Array(0);
    parentDir = new Uint8Array(0);
    stamp = new Uint16Array(0);
    searchId = 0;
  }
}

function nextSearchMark(): number {
  if (searchId >= 0xfff0) {
    stamp.fill(0);
    searchId = 0;
  }
  searchId += 2;
  return searchId;
}

const isSeen = (localIdx: number, openMark: number): boolean => {
  const s = stamp[localIdx];
  return s === openMark || s === openMark + 1;
};

function decodeInt16LE(buf: ArrayBuffer): Int16Array {
  if (IS_LITTLE_ENDIAN) return new Int16Array(buf);
  const view = new DataView(buf);
  const out = new Int16Array(buf.byteLength >> 1);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

function decodeUint16LE(buf: ArrayBuffer): Uint16Array {
  if (IS_LITTLE_ENDIAN) return new Uint16Array(buf);
  const view = new DataView(buf);
  const out = new Uint16Array(buf.byteLength >> 1);
  for (let i = 0; i < out.length; i++) out[i] = view.getUint16(i * 2, true);
  return out;
}

function decodeFloat32LE(buf: ArrayBuffer): Float32Array {
  if (IS_LITTLE_ENDIAN) return new Float32Array(buf);
  const view = new DataView(buf);
  const out = new Float32Array(buf.byteLength >> 2);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

function createProgressTracker(phase: 'terrain' | 'elevation', initialTotalBytes: number) {
  let loadedBytes = 0;
  let totalBytes = initialTotalBytes;
  let lastPercent = -1;
  let lastPostMs = 0;

  const emit = (force = false) => {
    if (totalBytes <= 0) return;
    const percent = Math.min(100, Math.round((loadedBytes / totalBytes) * 100));
    const now = performance.now();
    if (!force && percent - lastPercent < 1 && now - lastPostMs < 60) return;
    lastPercent = percent;
    lastPostMs = now;
    post({ type: 'load-progress', phase, loadedBytes, totalBytes, percent });
  };

  emit(true);

  return {
    addBytes(delta: number) {
      loadedBytes += delta;
      emit(false);
    },
    dropOptionalBytes(bytes: number) {
      totalBytes = Math.max(loadedBytes, totalBytes - bytes);
      emit(true);
    },
    finish() {
      loadedBytes = totalBytes;
      emit(true);
    },
  };
}

async function fetchBinaryWithProgress(
  url: string,
  expectedBytes: number,
  label: string,
  optional: boolean,
  onBytes: (delta: number) => void,
  onMissingOptional?: () => void,
): Promise<ArrayBuffer | null> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    if (optional) {
      onMissingOptional?.();
      return null;
    }
    throw err;
  }

  const ct = res.headers.get('content-type') ?? '';
  if (!res.ok || ct.includes('text/html')) {
    if (optional && (res.status === 404 || !res.ok || ct.includes('text/html'))) {
      onMissingOptional?.();
      return null;
    }
    if (!res.ok) throw new Error(`Could not load ${label} (HTTP ${res.status})`);
    throw new Error(`Could not load ${label} (received HTML instead of binary data)`);
  }

  if (res.body && typeof res.body.getReader === 'function') {
    const out = new Uint8Array(expectedBytes);
    const reader = res.body.getReader();
    let offset = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        if (offset + value.byteLength > expectedBytes) {
          await reader.cancel().catch(() => {});
          throw new Error(`${label} exceeds expected ${expectedBytes} bytes`);
        }
        out.set(value, offset);
        offset += value.byteLength;
        onBytes(value.byteLength);
      }
    }
    if (offset !== expectedBytes) {
      throw new Error(`${label} is ${offset} bytes, expected ${expectedBytes}`);
    }
    return out.buffer;
  }

  const buf = await res.arrayBuffer();
  if (buf.byteLength !== expectedBytes) {
    throw new Error(`${label} is ${buf.byteLength} bytes, expected ${expectedBytes}`);
  }
  onBytes(buf.byteLength);
  return buf;
}

function validateClassGrid(arr: Uint8Array, label: string): void {
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v !== HAZARD_FREE && v !== HAZARD_CAUTION && v !== HAZARD_FORBIDDEN && v !== HAZARD_NODATA) {
      throw new Error(`${label} contains unexpected class value ${v} at cell ${i} (expected 0, 1, 2 or 255)`);
    }
  }
}

async function init(msg: Extract<ToWorker, { type: 'init' }>): Promise<void> {
  const key = msg.scenarioKey ?? '';
  const cached = key ? gridCache.get(key) : undefined;
  if (cached) {
    activeScenarioKey = key;
    width = cached.width;
    height = cached.height;
    cellM = cached.cellM;
    slopeType = cached.slopeType;
    slopeScale = cached.slopeScale;
    slopeNoData = cached.slopeNoData;
    slopeU8 = cached.slopeU8;
    slopeF32 = cached.slopeF32;
    elevationUrl = cached.elevationUrl;
    elevType = cached.elevType;
    elevBaseM = cached.elevBaseM;
    elevScaleM = cached.elevScaleM;
    elevNoData = cached.elevNoData;
    elevLoaded = cached.elevLoaded;
    elevLoadPromise = cached.elevLoadPromise;
    elevI16 = cached.elevI16;
    elevF32 = cached.elevF32;
    hazard = cached.hazard;
    landing = cached.landing;
    thermalU16 = cached.thermalU16;

    gScore = new Float64Array(0);
    parentDir = new Uint8Array(0);
    stamp = new Uint16Array(0);
    searchId = 0;
    speedKey = '';

    post({
      type: 'ready',
      noDataCells: cached.noDataCells,
      totalCells: cached.totalCells,
      hasElevation: cached.elevI16 !== null || cached.elevF32 !== null,
      hasLanding: cached.landing !== null,
      hasThermalInertia: cached.thermalU16 !== null,
    });
    return;
  }

  activeScenarioKey = key;
  width = msg.width;
  height = msg.height;
  cellM = msg.cellM;
  slopeType = msg.slopeType;
  slopeScale = msg.slopeScale;
  slopeNoData = msg.slopeNoData;
  elevationUrl = msg.elevationUrl;
  elevType = msg.elevType;
  elevBaseM = msg.elevBaseM;
  elevScaleM = msg.elevScaleM;
  elevNoData = msg.elevNoData;
  elevLoaded = false;
  elevLoadPromise = null;
  elevI16 = null;
  elevF32 = null;
  slopeU8 = null;
  slopeF32 = null;
  hazard = null;
  landing = null;
  thermalU16 = null;

  const cells = width * height;
  const slopeBytes = slopeType === 'uint8' ? cells : cells * 4;
  const elevBytes = msg.elevationUrl ? (msg.elevType === 'int16' ? cells * 2 : cells * 4) : 0;
  const tiBytes = msg.thermalInertiaUrl ? cells * 2 : 0;
  const progress = createProgressTracker('terrain', slopeBytes + cells + cells + elevBytes + tiBytes);

  // Load slope, hazard, optional landing, optional elevation (for directed uphill/downhill & energy),
  // and optional THEMIS thermal inertia in one unified streaming progress pass.
  const [slopeBuf, hazardBuf, primaryLandingBuf, elevBuf, tiBuf] = await Promise.all([
    fetchBinaryWithProgress(msg.slopeUrl, slopeBytes, `egim.bin (${width} x ${height} ${slopeType})`, false, (d) =>
      progress.addBytes(d),
    ),
    fetchBinaryWithProgress(msg.hazardUrl, cells, `tehlike.bin (${width} x ${height} uint8)`, false, (d) => progress.addBytes(d)),
    fetchBinaryWithProgress(
      msg.landingUrl,
      cells,
      `inis.bin (${width} x ${height} uint8)`,
      true,
      (d) => progress.addBytes(d),
      () => progress.dropOptionalBytes(cells),
    ),
    msg.elevationUrl
      ? fetchBinaryWithProgress(
          msg.elevationUrl,
          elevBytes,
          `yukseklik.bin (${width} x ${height} ${msg.elevType})`,
          true,
          (d) => progress.addBytes(d),
          () => progress.dropOptionalBytes(elevBytes),
        )
      : Promise.resolve(null),
    msg.thermalInertiaUrl
      ? fetchBinaryWithProgress(
          msg.thermalInertiaUrl,
          tiBytes,
          `termal_atalet.bin (${width} x ${height} uint16)`,
          true,
          (d) => progress.addBytes(d),
          () => progress.dropOptionalBytes(tiBytes),
        )
      : Promise.resolve(null),
  ]);
  progress.finish();

  let landingBuf = primaryLandingBuf;
  if (!landingBuf && msg.fallbackLandingUrl) {
    landingBuf = await fetchBinaryWithProgress(
      msg.fallbackLandingUrl,
      cells,
      `fallback inis.bin (${width} x ${height} uint8)`,
      true,
      () => {},
    );
  }

  if (slopeType === 'uint8') {
    slopeU8 = new Uint8Array(slopeBuf!);
    slopeF32 = null;
  } else {
    slopeF32 = decodeFloat32LE(slopeBuf!);
    slopeU8 = null;
  }

  hazard = new Uint8Array(hazardBuf!);
  validateClassGrid(hazard, 'tehlike.bin');

  if (landingBuf) {
    const landingArr = new Uint8Array(landingBuf);
    validateClassGrid(landingArr, 'inis.bin');
    landing = landingArr;
  } else {
    landing = null;
  }

  if (elevBuf) {
    if (elevType === 'int16') elevI16 = decodeInt16LE(elevBuf);
    else elevF32 = decodeFloat32LE(elevBuf);
  }
  elevLoaded = true;

  thermalU16 = tiBuf ? decodeUint16LE(tiBuf) : null;

  gScore = new Float64Array(0);
  parentDir = new Uint8Array(0);
  stamp = new Uint16Array(0);
  searchId = 0;
  speedKey = '';

  let noData = 0;
  for (let i = 0; i < cells; i++) if (isNoData(i)) noData++;

  if (key) {
    gridCache.set(key, {
      width,
      height,
      cellM,
      slopeType,
      slopeScale,
      slopeNoData,
      slopeU8,
      slopeF32,
      elevationUrl,
      elevType,
      elevBaseM,
      elevScaleM,
      elevNoData,
      elevLoaded: true,
      elevLoadPromise: null,
      elevI16,
      elevF32,
      hazard,
      landing,
      thermalU16,
      noDataCells: noData,
      totalCells: cells,
    });
  }

  post({
    type: 'ready',
    noDataCells: noData,
    totalCells: cells,
    hasElevation: elevI16 !== null || elevF32 !== null,
    hasLanding: landing !== null,
    hasThermalInertia: thermalU16 !== null,
  });
}

export interface TestGridBuffers {
  width: number;
  height: number;
  cellM: number;
  slopeU8?: Uint8Array | null;
  slopeF32?: Float32Array | null;
  slopeScale?: number;
  slopeNoData?: number;
  hazard: Uint8Array;
  landing?: Uint8Array | null;
  elevI16?: Int16Array | null;
  elevF32?: Float32Array | null;
  elevBaseM?: number;
  elevScaleM?: number;
  elevNoData?: number;
  thermalU16?: Uint16Array | null;
}

/** Direct synchronous initializer for deterministic Node unit/physics tests without Web Worker HTTP fetch. */
export function initGridFromBuffers(buf: TestGridBuffers): { noDataCells: number; totalCells: number } {
  activeScenarioKey = '__test__';
  width = buf.width;
  height = buf.height;
  cellM = buf.cellM;
  slopeType = buf.slopeF32 ? 'float32' : 'uint8';
  slopeScale = buf.slopeScale ?? 1;
  slopeNoData = buf.slopeNoData ?? 255;
  slopeU8 = buf.slopeF32 ? null : (buf.slopeU8 ?? new Uint8Array(width * height));
  slopeF32 = buf.slopeF32 ?? null;
  elevationUrl = '';
  elevType = buf.elevF32 ? 'float32' : 'int16';
  elevBaseM = buf.elevBaseM ?? 0;
  elevScaleM = buf.elevScaleM ?? 1;
  elevNoData = buf.elevNoData ?? -32768;
  elevI16 = buf.elevF32 ? null : (buf.elevI16 ?? null);
  elevF32 = buf.elevF32 ?? null;
  elevLoaded = true;
  elevLoadPromise = null;
  hazard = buf.hazard;
  landing = buf.landing ?? null;
  thermalU16 = buf.thermalU16 ?? null;

  gScore = new Float64Array(0);
  parentDir = new Uint8Array(0);
  stamp = new Uint16Array(0);
  searchId = 0;
  speedKey = '';

  const totalCells = width * height;
  let noDataCells = 0;
  for (let i = 0; i < totalCells; i++) if (isNoData(i)) noDataCells++;
  return { noDataCells, totalCells };
}

function ensureElevationLoaded(): Promise<void> {
  if (elevLoaded || !elevationUrl) {
    elevLoaded = true;
    return Promise.resolve();
  }
  if (!elevLoadPromise) {
    const targetScenario = activeScenarioKey;
    const targetWidth = width;
    const targetHeight = height;
    const targetElevType = elevType;
    const targetCache = targetScenario ? gridCache.get(targetScenario) : undefined;
    const cells = targetWidth * targetHeight;
    const elevBytes = targetElevType === 'int16' ? cells * 2 : cells * 4;
    const progress = createProgressTracker('elevation', elevBytes);
    const pending = fetchBinaryWithProgress(
      elevationUrl,
      elevBytes,
      `yukseklik.bin (${targetWidth} x ${targetHeight} ${targetElevType})`,
      true,
      (d) => progress.addBytes(d),
      () => progress.dropOptionalBytes(elevBytes),
    )
      .then((elevBuf) => {
        progress.finish();
        let nextI16: Int16Array | null = null;
        let nextF32: Float32Array | null = null;
        if (elevBuf) {
          if (targetElevType === 'int16') nextI16 = decodeInt16LE(elevBuf);
          else nextF32 = decodeFloat32LE(elevBuf);
        }
        if (targetCache) {
          targetCache.elevI16 = nextI16;
          targetCache.elevF32 = nextF32;
          targetCache.elevLoaded = true;
        }
        if (activeScenarioKey === targetScenario) {
          elevI16 = nextI16;
          elevF32 = nextF32;
          elevLoaded = true;
        }
      })
      .catch((err: unknown) => {
        if (targetCache) targetCache.elevLoadPromise = null;
        if (activeScenarioKey === targetScenario) elevLoadPromise = null;
        throw err;
      });
    elevLoadPromise = pending;
    if (targetCache) targetCache.elevLoadPromise = pending;
  }
  return elevLoadPromise;
}

function isSlopeNoData(i: number): boolean {
  if (slopeU8) return slopeU8[i] === slopeNoData;
  const s = slopeF32![i];
  return s === slopeNoData || s < 0 || !Number.isFinite(s);
}

function slopeDegAt(i: number): number {
  if (slopeU8) {
    const b = slopeU8[i];
    return b === slopeNoData ? NaN : b * slopeScale;
  }
  const s = slopeF32![i];
  return s === slopeNoData || s < 0 || !Number.isFinite(s) ? NaN : s * slopeScale;
}

function elevMetresAt(i: number): number {
  if (elevI16) {
    const raw = elevI16[i];
    return raw === elevNoData ? NaN : elevBaseM + raw * elevScaleM;
  }
  if (!elevF32) return NaN;
  const raw = elevF32[i];
  if (raw === elevNoData || !Number.isFinite(raw)) return NaN;
  const z = elevBaseM + raw * elevScaleM;
  return z <= ELEV_MIN_VALID ? NaN : z;
}

function tiAt(i: number): number | null {
  if (!thermalU16) return null;
  const v = thermalU16[i];
  return v === THERMAL_NODATA ? null : v;
}

function groundTierAt(i: number): 0 | 1 | 2 {
  if (!thermalU16 || !currentGroundModel) return 0;
  const ti = thermalU16[i];
  if (ti === THERMAL_NODATA) return 0;
  if (ti < currentGroundModel.tiVeryLooseThreshold) return 2;
  if (ti < currentGroundModel.tiLooseThreshold) return 1;
  return 0;
}

function groundSpeedFactorAt(i: number): number {
  if (!thermalU16 || !currentGroundModel) return 1;
  const ti = thermalU16[i];
  if (ti === THERMAL_NODATA) return 1;
  if (ti < currentGroundModel.tiVeryLooseThreshold) return currentGroundModel.veryLooseSpeedFactor;
  if (ti < currentGroundModel.tiLooseThreshold) return currentGroundModel.looseSpeedFactor;
  return 1;
}

function groundCrrAt(i: number, ep: RouterEnergyProfile): number {
  if (!thermalU16 || !currentGroundModel) return ep.yuvarlanma_direnci;
  const ti = thermalU16[i];
  if (ti === THERMAL_NODATA) return ep.yuvarlanma_direnci;
  if (ti < currentGroundModel.tiVeryLooseThreshold) return currentGroundModel.veryLooseRollingResistance;
  if (ti < currentGroundModel.tiLooseThreshold) return currentGroundModel.looseRollingResistance;
  return ep.yuvarlanma_direnci;
}

function isNoData(i: number): boolean {
  return hazard![i] === HAZARD_NODATA || isSlopeNoData(i);
}

function speedAtSlope(table: [number, number][], deg: number): number {
  if (deg <= table[0][0]) return table[0][1];
  for (let k = 1; k < table.length; k++) {
    if (deg <= table[k][0]) {
      const [s0, v0] = table[k - 1];
      const [s1, v1] = table[k];
      return v0 + ((v1 - v0) * (deg - s0)) / (s1 - s0);
    }
  }
  return table[table.length - 1][1];
}

function prepareSpeeds(traverser: RouterTraverser, allowNoData = false): void {
  const downTable = traverser.downhillSpeedTable?.length ? traverser.downhillSpeedTable : traverser.speedTable;
  const ground = traverser.groundModel ?? null;
  const key = JSON.stringify({
    maxSlopeDeg: traverser.maxSlopeDeg,
    speedTable: traverser.speedTable,
    downTable,
    ground,
    allowNoData,
    slopeType,
    slopeScale,
    slopeNoData,
  });
  if (key === speedKey) return;
  const table = traverser.speedTable;
  const allSpeeds = [...table.map((e) => e[1]), ...downTable.map((e) => e[1])];
  slowestSpeed = Math.min(...allSpeeds);
  maxSpeed = Math.max(...allSpeeds);
  currentMaxSlopeDeg = traverser.maxSlopeDeg;
  currentAllowNoData = allowNoData;
  currentSpeedTable = table;
  currentDownhillTable = downTable;
  currentGroundModel = ground
    ? {
        ...ground,
        looseSpeedFactor: Math.min(1, Math.max(0.05, ground.looseSpeedFactor)),
        veryLooseSpeedFactor: Math.min(1, Math.max(0.05, ground.veryLooseSpeedFactor)),
      }
    : null;

  if (slopeType === 'uint8') {
    const noDataSpeed = allowNoData ? slowestSpeed : 0;
    for (let b = 0; b < 256; b++) {
      if (b === slopeNoData) {
        speedFreeLut[b] = noDataSpeed;
        downFreeLut[b] = noDataSpeed;
        speedCautionLut[b] = noDataSpeed;
        speedNoDataHazardLut[b] = noDataSpeed;
      } else {
        const deg = b * slopeScale;
        if (deg > currentMaxSlopeDeg) {
          speedFreeLut[b] = 0;
          downFreeLut[b] = 0;
          speedCautionLut[b] = 0;
          speedNoDataHazardLut[b] = 0;
        } else {
          speedFreeLut[b] = speedAtSlope(table, deg);
          downFreeLut[b] = speedAtSlope(downTable, deg);
          speedCautionLut[b] = slowestSpeed;
          speedNoDataHazardLut[b] = noDataSpeed;
        }
      }
    }
  }
  speedKey = key;
}

function cellSpeedDirected(i: number, isDownhill: boolean): number {
  const h = hazard![i];
  if (h === HAZARD_FORBIDDEN) return 0;
  let base = 0;
  if (slopeU8) {
    const b = slopeU8[i];
    if (h === HAZARD_FREE) base = isDownhill ? downFreeLut[b] : speedFreeLut[b];
    else if (h === HAZARD_CAUTION) base = speedCautionLut[b];
    else base = speedNoDataHazardLut[b];
  } else {
    const deg = slopeDegAt(i);
    const noSlope = Number.isNaN(deg);
    if (!noSlope && deg > currentMaxSlopeDeg) return 0;
    if (noSlope || h === HAZARD_NODATA) base = currentAllowNoData ? slowestSpeed : 0;
    else if (h === HAZARD_CAUTION) base = slowestSpeed;
    else base = speedAtSlope(isDownhill ? currentDownhillTable : currentSpeedTable, deg);
  }
  if (base <= 0) return 0;
  return base * groundSpeedFactorAt(i);
}

function cellSpeedAt(i: number): number {
  return cellSpeedDirected(i, false);
}

/** Directed traversal speed along edge a -> b accounting for downhill vs uphill and TI regolith factor. */
function stepSpeed(a: number, b: number): number {
  const hasElev = elevLoaded && (elevI16 !== null || elevF32 !== null);
  let isDownhill = false;
  if (hasElev && a !== b) {
    const zA = elevMetresAt(a);
    const zB = elevMetresAt(b);
    if (!Number.isNaN(zA) && !Number.isNaN(zB) && zB - zA < -1e-4) {
      isDownhill = true;
    }
  }
  const sa = cellSpeedDirected(a, isDownhill);
  if (sa <= 0) return 0;
  if (a === b) return sa;
  const sb = cellSpeedDirected(b, isDownhill);
  if (sb <= 0) return 0;
  return Math.min(sa, sb);
}

function blockReason(i: number): BlockReason | null {
  if (cellSpeedAt(i) > 0) return null;
  if (hazard![i] === HAZARD_FORBIDDEN) return 'forbidden';
  if (!currentAllowNoData && isNoData(i)) return 'no-data';
  return 'too-steep';
}

// ------------------------------------------------------------ binary heap
class MinHeap {
  private keys: number[] = [];
  private values: number[] = [];
  get size(): number {
    return this.keys.length;
  }
  push(key: number, value: number): void {
    const { keys, values } = this;
    let i = keys.length;
    keys.push(key);
    values.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= key) break;
      keys[i] = keys[parent];
      values[i] = values[parent];
      i = parent;
    }
    keys[i] = key;
    values[i] = value;
  }
  pop(): number {
    const { keys, values } = this;
    const top = values[0];
    const lastKey = keys.pop()!;
    const lastValue = values.pop()!;
    const n = keys.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let child = 2 * i + 1;
        if (child >= n) break;
        if (child + 1 < n && keys[child + 1] < keys[child]) child++;
        if (keys[child] >= lastKey) break;
        keys[i] = keys[child];
        values[i] = values[child];
        i = child;
      }
      keys[i] = lastKey;
      values[i] = lastValue;
    }
    return top;
  }
}

// 8-connected neighbourhood offsets
const NEIGHBOUR_DC = [1, -1, 0, 0, 1, 1, -1, -1] as const;
const NEIGHBOUR_DR = [0, 0, 1, -1, 1, -1, 1, -1] as const;

function isOnUnclippedBorder(col: number, row: number, c0: number, r0: number, c1: number, r1: number): boolean {
  return (
    (col === c0 && c0 > 0) ||
    (col === c1 && c1 < width - 1) ||
    (row === r0 && r0 > 0) ||
    (row === r1 && r1 < height - 1)
  );
}

function traceWindowToRoot(leafLocal: number, c0: number, r0: number, winW: number, openMark: number): number[] {
  const path: number[] = [];
  let l = leafLocal;
  for (;;) {
    const lc = l % winW;
    const lr = (l - lc) / winW;
    path.push((r0 + lr) * width + (c0 + lc));
    if (!isSeen(l, openMark)) break;
    const d = parentDir[l];
    if (d === PARENT_NONE) break;
    l = (lr - NEIGHBOUR_DR[d]) * winW + (lc - NEIGHBOUR_DC[d]);
  }
  return path;
}

function runWindowedAStar(
  start: number,
  goal: number,
  c0: number,
  r0: number,
  c1: number,
  r1: number,
): number[] | null {
  const winW = c1 - c0 + 1;
  const winH = r1 - r0 + 1;
  ensureWindow(winW * winH);

  const openMark = nextSearchMark();
  const closedMark = openMark + 1;

  const startCol = start % width;
  const startRow = (start - startCol) / width;
  const goalCol = goal % width;
  const goalRow = (goal - goalCol) / width;
  const startLocal = (startRow - r0) * winW + (startCol - c0);
  const goalLocal = (goalRow - r0) * winW + (goalCol - c0);

  const diagonal = cellM * Math.SQRT2;
  const heuristic = (col: number, row: number): number => {
    const dc = Math.abs(col - goalCol);
    const dr = Math.abs(row - goalRow);
    return (cellM * Math.abs(dc - dr) + diagonal * Math.min(dc, dr)) / maxSpeed;
  };

  const open = new MinHeap();
  stamp[startLocal] = openMark;
  gScore[startLocal] = 0;
  parentDir[startLocal] = PARENT_NONE;
  open.push(heuristic(startCol, startRow), startLocal);

  while (open.size > 0) {
    const curLocal = open.pop();
    if (stamp[curLocal] === closedMark) continue;
    if (curLocal === goalLocal) {
      return traceWindowToRoot(goalLocal, c0, r0, winW, openMark).reverse();
    }
    stamp[curLocal] = closedMark;
    const lCol = curLocal % winW;
    const lRow = (curLocal - lCol) / winW;
    const col = c0 + lCol;
    const row = r0 + lRow;
    const curGlobal = row * width + col;
    if (cellSpeedAt(curGlobal) <= 0) continue;
    const currentG = gScore[curLocal];

    for (let d = 0; d < 8; d++) {
      const dc = NEIGHBOUR_DC[d];
      const dr = NEIGHBOUR_DR[d];
      const nlCol = lCol + dc;
      const nlRow = lRow + dr;
      if (nlCol < 0 || nlRow < 0 || nlCol >= winW || nlRow >= winH) continue;
      const nextLocal = nlRow * winW + nlCol;
      if (stamp[nextLocal] === closedMark) continue;
      const nc = col + dc;
      const nr = row + dr;
      const nextGlobal = nr * width + nc;
      const isDiagonal = d >= 4;
      if (isDiagonal && (cellSpeedAt(row * width + nc) === 0 || cellSpeedAt(nr * width + col) === 0)) continue;
      // Directed edge cost curGlobal -> nextGlobal (accounts for uphill vs downhill slope table & TI)
      const spd = stepSpeed(curGlobal, nextGlobal);
      if (spd <= 0) continue;
      const stepTime = (isDiagonal ? diagonal : cellM) / spd;
      const tentative = currentG + stepTime;
      const prevG = stamp[nextLocal] === openMark ? gScore[nextLocal] : Infinity;
      if (tentative < prevG) {
        stamp[nextLocal] = openMark;
        gScore[nextLocal] = tentative;
        parentDir[nextLocal] = d;
        open.push(tentative + heuristic(nc, nr), nextLocal);
      }
    }
  }
  return null;
}

/**
 * Windowed A* from `start` to `goal`. Starts inside a compact padded corridor;
 * if no path is found or the found path touches an unclipped window boundary,
 * doubles the window margin and retries up to the full grid.
 */
function findPath(start: number, goal: number): number[] | null {
  if (start === goal) return [start];
  const sc = start % width;
  const sr = (start - sc) / width;
  const gc = goal % width;
  const gr = (goal - gc) / width;

  const minC = Math.min(sc, gc);
  const maxC = Math.max(sc, gc);
  const minR = Math.min(sr, gr);
  const maxR = Math.max(sr, gr);
  const span = Math.max(maxC - minC, maxR - minR);
  let margin = Math.min(512, Math.max(160, Math.ceil(span * 0.25)));

  for (;;) {
    const c0 = Math.max(0, minC - margin);
    const c1 = Math.min(width - 1, maxC + margin);
    const r0 = Math.max(0, minR - margin);
    const r1 = Math.min(height - 1, maxR + margin);
    const isFullGrid = c0 === 0 && c1 === width - 1 && r0 === 0 && r1 === height - 1;

    const path = runWindowedAStar(start, goal, c0, r0, c1, r1);
    if (path !== null) {
      if (isFullGrid) return path;
      let touchesBorder = false;
      for (let i = 0; i < path.length; i++) {
        const cell = path[i];
        const col = cell % width;
        const row = (cell - col) / width;
        if (isOnUnclippedBorder(col, row, c0, r0, c1, r1)) {
          touchesBorder = true;
          break;
        }
      }
      if (!touchesBorder) return path;
    } else if (isFullGrid) {
      return null;
    }
    margin *= 2;
  }
}

interface DiscoveredLanding extends LandingCandidate {
  pathToTarget: number[];
}

function farFromPicked(cell: number, picked: DiscoveredLanding[], minSepM: number): boolean {
  if (minSepM <= 0 || picked.length === 0) return true;
  const col = cell % width;
  const row = (cell - col) / width;
  for (const p of picked) {
    const pc = p.cell % width;
    const pr = (p.cell - pc) / width;
    if (Math.hypot(col - pc, row - pr) * cellM < minSepM) return false;
  }
  return true;
}

function suggestLandingSites(
  targetCell: number,
  maxTimeS: number,
  minSeparationM: number,
  minTargetStandoffM = 0,
): { candidates: DiscoveredLanding[]; marginal: boolean } | null {
  if (!landing || maxTimeS < 0) return null;
  const tCol = targetCell % width;
  const tRow = (targetCell - tCol) / width;
  const diagonal = cellM * Math.SQRT2;
  const standoffCells = minTargetStandoffM > 0 ? Math.ceil(minTargetStandoffM / cellM) : 0;

  const gridSpan = Math.max(width, height);
  const maxRangeCells = Number.isFinite(maxTimeS)
    ? Math.max(1, Math.min(gridSpan, Math.ceil((maxSpeed * maxTimeS) / cellM) + 2))
    : gridSpan;
  let radius = Math.min(
    maxRangeCells,
    Math.max(256, Math.ceil((Math.max(minSeparationM, cellM) * 4) / cellM) + standoffCells),
  );

  for (;;) {
    const c0 = Math.max(0, tCol - radius);
    const c1 = Math.min(width - 1, tCol + radius);
    const r0 = Math.max(0, tRow - radius);
    const r1 = Math.min(height - 1, tRow + radius);
    const atMaxWindow = (c0 === 0 && c1 === width - 1 && r0 === 0 && r1 === height - 1) || radius >= maxRangeCells;

    const winW = c1 - c0 + 1;
    const winH = r1 - r0 + 1;
    ensureWindow(winW * winH);

    const openMark = nextSearchMark();
    const closedMark = openMark + 1;
    const startLocal = (tRow - r0) * winW + (tCol - c0);

    const tier0: DiscoveredLanding[] = [];
    const tier1: DiscoveredLanding[] = [];
    let firstUnclippedBorderTime = Infinity;

    const open = new MinHeap();
    stamp[startLocal] = openMark;
    gScore[startLocal] = 0;
    parentDir[startLocal] = PARENT_NONE;
    open.push(0, startLocal);

    while (open.size > 0) {
      const curLocal = open.pop();
      if (stamp[curLocal] === closedMark) continue;
      const currentG = isSeen(curLocal, openMark) ? gScore[curLocal] : Infinity;
      if (currentG > maxTimeS) break;
      stamp[curLocal] = closedMark;

      const lCol = curLocal % winW;
      const lRow = (curLocal - lCol) / winW;
      const col = c0 + lCol;
      const row = r0 + lRow;
      if (firstUnclippedBorderTime === Infinity && isOnUnclippedBorder(col, row, c0, r0, c1, r1)) {
        firstUnclippedBorderTime = currentG;
      }

      const curGlobal = row * width + col;
      const lClass = landing[curGlobal];
      const outsideTargetStandoff = minTargetStandoffM <= 0 || Math.hypot(col - tCol, row - tRow) * cellM >= minTargetStandoffM;
      if (outsideTargetStandoff && lClass === LANDING_SUITABLE && farFromPicked(curGlobal, tier0, minSeparationM)) {
        const pathToTarget = traceWindowToRoot(curLocal, c0, r0, winW, openMark);
        const leg = measure(pathToTarget);
        tier0.push({ cell: curGlobal, tier: 0, distance_m: leg.distance_m, time_s: leg.time_s, pathToTarget });
        if (tier0.length >= MAX_LANDING_CANDIDATES) break;
      } else if (
        outsideTargetStandoff &&
        lClass === LANDING_MARGINAL &&
        tier0.length === 0 &&
        tier1.length < MAX_LANDING_CANDIDATES &&
        farFromPicked(curGlobal, tier1, minSeparationM)
      ) {
        const pathToTarget = traceWindowToRoot(curLocal, c0, r0, winW, openMark);
        const leg = measure(pathToTarget);
        tier1.push({ cell: curGlobal, tier: 1, distance_m: leg.distance_m, time_s: leg.time_s, pathToTarget });
      }

      if (cellSpeedAt(curGlobal) <= 0) continue;
      for (let d = 0; d < 8; d++) {
        const dc = NEIGHBOUR_DC[d];
        const dr = NEIGHBOUR_DR[d];
        const nlCol = lCol + dc;
        const nlRow = lRow + dr;
        if (nlCol < 0 || nlRow < 0 || nlCol >= winW || nlRow >= winH) continue;
        const nextLocal = nlRow * winW + nlCol;
        if (stamp[nextLocal] === closedMark) continue;
        const nc = col + dc;
        const nr = row + dr;
        const nextGlobal = nr * width + nc;
        const isDiagonal = d >= 4;
        if (isDiagonal && (cellSpeedAt(row * width + nc) === 0 || cellSpeedAt(nr * width + col) === 0)) continue;
        // Reverse-Dijkstra from targetCell: actual travel direction is candidate nextGlobal -> curGlobal.
        const spd = stepSpeed(nextGlobal, curGlobal);
        if (spd <= 0) continue;
        const stepTime = (isDiagonal ? diagonal : cellM) / spd;
        const tentative = currentG + stepTime;
        if (tentative > maxTimeS) continue;
        const prevG = stamp[nextLocal] === openMark ? gScore[nextLocal] : Infinity;
        if (tentative < prevG) {
          stamp[nextLocal] = openMark;
          gScore[nextLocal] = tentative;
          parentDir[nextLocal] = d;
          open.push(tentative, nextLocal);
        }
      }
    }

    const tier0Optimal =
      tier0.length >= MAX_LANDING_CANDIDATES && tier0[MAX_LANDING_CANDIDATES - 1].time_s <= firstUnclippedBorderTime;
    if (atMaxWindow || firstUnclippedBorderTime === Infinity || tier0Optimal) {
      if (tier0.length > 0) return { candidates: tier0, marginal: false };
      if (tier1.length > 0) return { candidates: tier1, marginal: true };
      return null;
    }

    radius = Math.min(maxRangeCells, radius * 2);
  }
}

function measure(path: number[]): RouteLeg {
  let distance = 0;
  let time = 0;
  const diagonal = cellM * Math.SQRT2;
  for (let k = 1; k < path.length; k++) {
    const a = path[k - 1];
    const b = path[k];
    const isDiagonal = a % width !== b % width && Math.floor(a / width) !== Math.floor(b / width);
    const step = isDiagonal ? diagonal : cellM;
    distance += step;
    const spd = stepSpeed(a, b);
    time += spd > 0 ? step / spd : Infinity;
  }
  return { distance_m: distance, time_s: time };
}

/**
 * Supercover grid traversal along line segment (c0, r0) -> (c1, r1), including both
 * orthogonal corner neighbors on diagonal transitions so segments never graze forbidden pixels.
 */
function supercoverCells(c0: number, r0: number, c1: number, r1: number): number[] {
  const cells: number[] = [];
  let c = c0;
  let r = r0;
  const dc = Math.abs(c1 - c0);
  const dr = Math.abs(r1 - r0);
  const sc = c1 > c0 ? 1 : c1 < c0 ? -1 : 0;
  const sr = r1 > r0 ? 1 : r1 < r0 ? -1 : 0;
  let err = dc - dr;
  cells.push(r * width + c);
  while (c !== c1 || r !== r1) {
    const e2 = 2 * err;
    const stepC = e2 > -dr;
    const stepR = e2 < dc;
    if (stepC && stepR) {
      if (c + sc >= 0 && c + sc < width) cells.push(r * width + (c + sc));
      if (r + sr >= 0 && r + sr < height) cells.push((r + sr) * width + c);
    }
    if (stepC) {
      err -= dr;
      c += sc;
    }
    if (stepR) {
      err += dc;
      r += sr;
    }
    cells.push(r * width + c);
  }
  return cells;
}

interface SmoothedLeg {
  cells: number[];
  cols: number[];
  rows: number[];
  distance_m: number;
  time_s: number;
}

/**
 * String-pulls an 8-connected A* leg into hazard-safe straight chords using supercover
 * visibility checks, eliminating diagonal staircase zigzag inflation on both geometry and length.
 */
function smoothLegPath(rawCells: number[]): SmoothedLeg {
  const n = rawCells.length;
  if (n <= 1) {
    const cell = rawCells[0] ?? 0;
    const col = cell % width;
    const row = (cell - col) / width;
    return {
      cells: n === 1 ? [cell] : [],
      cols: n === 1 ? [col] : [],
      rows: n === 1 ? [row] : [],
      distance_m: 0,
      time_s: 0,
    };
  }
  if (n === 2) {
    const a = rawCells[0];
    const b = rawCells[1];
    const ac = a % width;
    const ar = (a - ac) / width;
    const bc = b % width;
    const br = (b - bc) / width;
    const leg = measure(rawCells);
    return { cells: [a, b], cols: [ac, bc], rows: [ar, br], distance_m: leg.distance_m, time_s: leg.time_s };
  }

  // Precompute prefix cumulative time, slope, no-data count, hazard severity, and ground tier on raw A* cells
  const diagonal = cellM * Math.SQRT2;
  const rawCumTime = new Float64Array(n);
  const rawSlope = new Float32Array(n);
  const rawHazTier = new Uint8Array(n);
  const rawGroundTier = new Uint8Array(n);
  const rawIsNd = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const c = rawCells[i];
    const nd = isNoData(c);
    rawIsNd[i] = nd ? 1 : 0;
    rawSlope[i] = nd ? 0 : slopeDegAt(c);
    rawHazTier[i] = hazard![c] === HAZARD_CAUTION ? 1 : 0;
    rawGroundTier[i] = groundTierAt(c);
    if (i > 0) {
      const prev = rawCells[i - 1];
      const isDiag = prev % width !== c % width && Math.floor(prev / width) !== Math.floor(c / width);
      const step = isDiag ? diagonal : cellM;
      const spd = stepSpeed(prev, c);
      rawCumTime[i] = rawCumTime[i - 1] + (spd > 0 ? step / spd : Infinity);
    }
  }

  interface ChordSample {
    cells: number[];
    cols: number[];
    rows: number[];
    distance_m: number;
    time_s: number;
  }

  const validateChord = (i0: number, i1: number): ChordSample | null => {
    const cA = rawCells[i0] % width;
    const rA = (rawCells[i0] - cA) / width;
    const cB = rawCells[i1] % width;
    const rB = (rawCells[i1] - cB) / width;

    let maxSubSlope = 0;
    let maxSubHaz = 0;
    let maxSubGround = 0;
    let allowChordNd = false;
    for (let k = i0; k <= i1; k++) {
      if (rawSlope[k] > maxSubSlope) maxSubSlope = rawSlope[k];
      if (rawHazTier[k] > maxSubHaz) maxSubHaz = rawHazTier[k];
      if (rawGroundTier[k] > maxSubGround) maxSubGround = rawGroundTier[k];
      if (rawIsNd[k]) allowChordNd = true;
    }

    const cover = supercoverCells(cA, rA, cB, rB);
    for (let k = 0; k < cover.length; k++) {
      const m = cover[k];
      if (cellSpeedAt(m) <= 0) return null;
      const nd = isNoData(m);
      if (nd && !allowChordNd) return null;
      const hazTier = hazard![m] === HAZARD_CAUTION ? 1 : 0;
      if (hazTier > maxSubHaz) return null;
      if (groundTierAt(m) > maxSubGround) return null;
      if (!nd && slopeDegAt(m) > maxSubSlope + 0.5) return null;
    }

    const chordDist = Math.hypot(cB - cA, rB - rA) * cellM;
    const steps = Math.max(1, Math.round(Math.hypot(cB - cA, rB - rA)));
    const subStepM = chordDist / steps;
    const cells: number[] = [];
    const cols: number[] = [];
    const rows: number[] = [];
    let chordTime = 0;
    let prevCell = rawCells[i0];

    for (let j = 1; j <= steps; j++) {
      const t = j / steps;
      const col = cA + (cB - cA) * t;
      const row = rA + (rB - rA) * t;
      const snapCol = j === steps ? cB : Math.min(width - 1, Math.max(0, Math.round(col)));
      const snapRow = j === steps ? rB : Math.min(height - 1, Math.max(0, Math.round(row)));
      const snapCell = snapRow * width + snapCol;
      const spd = stepSpeed(prevCell, snapCell);
      if (spd <= 0) return null;
      chordTime += subStepM / spd;
      cells.push(snapCell);
      cols.push(col);
      rows.push(row);
      prevCell = snapCell;
    }

    const rawSubTime = rawCumTime[i1] - rawCumTime[i0];
    if (Number.isFinite(rawSubTime) && chordTime > rawSubTime * 1.005 + 1e-6) return null;

    return { cells, cols, rows, distance_m: chordDist, time_s: chordTime };
  };

  const outCells: number[] = [rawCells[0]];
  const outCols: number[] = [rawCells[0] % width];
  const outRows: number[] = [Math.floor(rawCells[0] / width)];
  let totalDist = 0;
  let totalTime = 0;

  let anchor = 0;
  const MAX_LOOKAHEAD = 256;
  while (anchor < n - 1) {
    const maxEnd = Math.min(n - 1, anchor + MAX_LOOKAHEAD);
    let lastValidIdx = anchor + 1;
    let lastValidSample: ChordSample | null = null;
    let firstBadIdx = maxEnd + 1;

    // Exponential probing then binary search within [lastValidIdx, firstBadIdx - 1]
    let step = 2;
    while (anchor + step <= maxEnd) {
      const probeIdx = anchor + step;
      const sample = validateChord(anchor, probeIdx);
      if (sample) {
        lastValidIdx = probeIdx;
        lastValidSample = sample;
        if (probeIdx === maxEnd) break;
        step *= 2;
      } else {
        firstBadIdx = probeIdx;
        break;
      }
    }
    if (lastValidIdx < maxEnd && firstBadIdx > maxEnd) {
      const tailSample = validateChord(anchor, maxEnd);
      if (tailSample) {
        lastValidIdx = maxEnd;
        lastValidSample = tailSample;
      } else {
        firstBadIdx = maxEnd;
      }
    }

    let lo = lastValidIdx;
    let hi = Math.min(maxEnd, firstBadIdx - 1);
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      const sample = validateChord(anchor, mid);
      if (sample) {
        lo = mid;
        lastValidIdx = mid;
        lastValidSample = sample;
      } else {
        hi = mid - 1;
      }
    }

    if (lastValidIdx > anchor + 1 || lastValidSample) {
      const chosen = lastValidSample!;
      for (let k = 0; k < chosen.cells.length; k++) {
        outCells.push(chosen.cells[k]);
        outCols.push(chosen.cols[k]);
        outRows.push(chosen.rows[k]);
      }
      totalDist += chosen.distance_m;
      totalTime += chosen.time_s;
      anchor = lastValidIdx;
    } else {
      const prev = rawCells[anchor];
      const next = rawCells[anchor + 1];
      const nc = next % width;
      const nr = (next - nc) / width;
      const isDiag = prev % width !== nc && Math.floor(prev / width) !== nr;
      const segDist = isDiag ? diagonal : cellM;
      const spd = stepSpeed(prev, next);
      outCells.push(next);
      outCols.push(nc);
      outRows.push(nr);
      totalDist += segDist;
      totalTime += spd > 0 ? segDist / spd : Infinity;
      anchor++;
    }
  }

  return { cells: outCells, cols: outCols, rows: outRows, distance_m: totalDist, time_s: totalTime };
}

/**
 * Computes exact shortest walking return time (seconds) from every cell in `full`
 * back to `originCell` using `walkBack.traverser`'s speed tables and slope limit.
 * Uses directed Reverse-Dijkstra edges (next -> cur) so walking uphill vs downhill back to
 * base accurately reflects directed walk-back speeds and TI rolling resistance.
 */
function computeWalkBackTimes(
  originCell: number,
  full: number[],
  walkBack: WalkBackSpec,
  allowNoData: boolean,
  clipAtLimit = false,
): Float64Array {
  const out = new Float64Array(full.length);
  out.fill(Infinity);
  const limitS = walkBack.limitS;
  if (full.length === 0 || !(limitS > 0)) return out;

  prepareSpeeds(walkBack.traverser, allowNoData);

  if (cellSpeedAt(originCell) === 0 || maxSpeed <= 0) {
    for (let k = 0; k < full.length; k++) {
      if (full[k] === originCell) out[k] = 0;
    }
    return out;
  }

  const oCol = originCell % width;
  const oRow = (originCell - oCol) / width;
  const gridSpan = Math.max(width, height);
  const searchCapS = clipAtLimit ? limitS : limitS * 1.5;

  const maxRangeCells = Number.isFinite(searchCapS)
    ? Math.max(1, Math.min(gridSpan, Math.ceil((maxSpeed * searchCapS) / cellM) + 4))
    : gridSpan;

  const targetCells = new Set<number>();
  let maxTargetCheb = 0;
  for (let k = 0; k < full.length; k++) {
    const c = full[k];
    if (c === originCell) continue;
    if (cellSpeedAt(c) === 0) continue;
    const cc = c % width;
    const cr = (c - cc) / width;
    const cheb = Math.max(Math.abs(cc - oCol), Math.abs(cr - oRow));
    if (cheb > maxRangeCells) continue;
    targetCells.add(c);
    if (cheb > maxTargetCheb) maxTargetCheb = cheb;
  }

  if (targetCells.size === 0) {
    for (let k = 0; k < full.length; k++) {
      if (full[k] === originCell) out[k] = 0;
    }
    return out;
  }

  const diagonal = cellM * Math.SQRT2;
  let radius = Math.min(maxRangeCells, Math.max(160, Math.ceil(maxTargetCheb * 1.35) + 16));

  for (;;) {
    const c0 = Math.max(0, oCol - radius);
    const c1 = Math.min(width - 1, oCol + radius);
    const r0 = Math.max(0, oRow - radius);
    const r1 = Math.min(height - 1, oRow + radius);
    const atMaxWindow = (c0 === 0 && c1 === width - 1 && r0 === 0 && r1 === height - 1) || radius >= maxRangeCells;

    const winW = c1 - c0 + 1;
    const winH = r1 - r0 + 1;
    ensureWindow(winW * winH);

    const openMark = nextSearchMark();
    const closedMark = openMark + 1;
    const startLocal = (oRow - r0) * winW + (oCol - c0);

    const settled = new Map<number, number>();
    let maxSettledTargetG = 0;
    let firstUnclippedBorderTime = Infinity;

    const open = new MinHeap();
    stamp[startLocal] = openMark;
    gScore[startLocal] = 0;
    parentDir[startLocal] = PARENT_NONE;
    open.push(0, startLocal);

    let allTargetsOptimal = false;
    while (open.size > 0) {
      const curLocal = open.pop();
      if (stamp[curLocal] === closedMark) continue;
      const currentG = isSeen(curLocal, openMark) ? gScore[curLocal] : Infinity;
      if (currentG > searchCapS) break;
      stamp[curLocal] = closedMark;

      const lCol = curLocal % winW;
      const lRow = (curLocal - lCol) / winW;
      const col = c0 + lCol;
      const row = r0 + lRow;
      if (firstUnclippedBorderTime === Infinity && isOnUnclippedBorder(col, row, c0, r0, c1, r1)) {
        firstUnclippedBorderTime = currentG;
      }

      const curGlobal = row * width + col;
      if (targetCells.has(curGlobal)) {
        settled.set(curGlobal, currentG);
        if (currentG > maxSettledTargetG) maxSettledTargetG = currentG;
        if (settled.size === targetCells.size) {
          if (atMaxWindow || maxSettledTargetG <= firstUnclippedBorderTime) {
            allTargetsOptimal = true;
          }
          break;
        }
      }

      if (cellSpeedAt(curGlobal) <= 0) continue;
      for (let d = 0; d < 8; d++) {
        const dc = NEIGHBOUR_DC[d];
        const dr = NEIGHBOUR_DR[d];
        const nlCol = lCol + dc;
        const nlRow = lRow + dr;
        if (nlCol < 0 || nlRow < 0 || nlCol >= winW || nlRow >= winH) continue;
        const nextLocal = nlRow * winW + nlCol;
        if (stamp[nextLocal] === closedMark) continue;
        const nc = col + dc;
        const nr = row + dr;
        const nextGlobal = nr * width + nc;
        const isDiagonal = d >= 4;
        if (isDiagonal && (cellSpeedAt(row * width + nc) === 0 || cellSpeedAt(nr * width + col) === 0)) continue;
        // Walk-back escape edge runs from route point nextGlobal TOWARD origin curGlobal.
        const spd = stepSpeed(nextGlobal, curGlobal);
        if (spd <= 0) continue;
        const stepTime = (isDiagonal ? diagonal : cellM) / spd;
        const tentative = currentG + stepTime;
        if (tentative > searchCapS) continue;
        const prevG = stamp[nextLocal] === openMark ? gScore[nextLocal] : Infinity;
        if (tentative < prevG) {
          stamp[nextLocal] = openMark;
          gScore[nextLocal] = tentative;
          parentDir[nextLocal] = d;
          open.push(tentative, nextLocal);
        }
      }
    }

    if (
      allTargetsOptimal ||
      atMaxWindow ||
      firstUnclippedBorderTime === Infinity ||
      firstUnclippedBorderTime > searchCapS
    ) {
      for (let k = 0; k < full.length; k++) {
        const c = full[k];
        if (c === originCell) out[k] = 0;
        else {
          const t = settled.get(c);
          if (t !== undefined) out[k] = t;
        }
      }
      return out;
    }

    radius = Math.min(maxRangeCells, radius * 2);
  }
}

interface MissionPlanOk {
  ok: true;
  effectiveMode: 'manual' | 'auto-landing';
  landingCandidates: LandingCandidate[];
  activeLandingCell: number | null;
  marginalLanding: boolean;
  full: number[];
  fullCols: number[];
  fullRows: number[];
  stopCountsInFull: Map<number, number>;
  legs: RouteLeg[];
  distance_m: number;
  travelTime_s: number;
  stopTime_s: number;
  time_s: number;
  optimizeStopsEnabled: boolean;
  stopOrder: number[];
  stopOrderChanged: boolean;
  stopOrderCapped: boolean;
  stopOrderCap: number;
  unoptimizedTime_s: number | null;
}

type MissionPlanFail = RouteFailure extends infer U ? (U extends RouteFailure ? Omit<U, 'type' | 'id'> : never) : never;
type MissionPlanResult = MissionPlanOk | MissionPlanFail;

function planMission(
  mode: 'manual' | 'auto-landing',
  waypoints: number[],
  chosenLandingCell: number | null | undefined,
  minSeparationM: number,
  explicitMaxLandingTimeS: number | null | undefined,
  roundTrip: boolean,
  stopWorkS: number,
  allowNoData: boolean,
  traverser: RouterTraverser,
  minTargetStandoffM = 0,
  optimizeStops = false,
): MissionPlanResult {
  prepareSpeeds(traverser, allowNoData);

  for (let w = 0; w < waypoints.length; w++) {
    const why = blockReason(waypoints[w]);
    if (why) return { ok: false, reason: 'blocked-waypoint', waypointIndex: w, why };
  }

  const effectiveMode: 'manual' | 'auto-landing' = mode === 'auto-landing' && landing ? 'auto-landing' : 'manual';
  const stopCells = effectiveMode === 'auto-landing' ? waypoints.slice() : waypoints.slice(1);
  const stopCount = stopCells.length;
  const perStopS = Math.max(0, Number.isFinite(stopWorkS) ? stopWorkS : 0);
  const stopTime_s = stopCount * perStopS;

  let landingCandidates: LandingCandidate[] = [];
  let activeLandingCell: number | null = null;
  let marginalLanding = false;
  let primaryLandingSmooth: SmoothedLeg | null = null;

  const hasStintBudget =
    typeof traverser.stintDistM === 'number' && Number.isFinite(traverser.stintDistM) && traverser.stintDistM > 0;

  if (effectiveMode === 'auto-landing' && landing && waypoints.length > 0) {
    let maxLandingS = Infinity;
    if (explicitMaxLandingTimeS !== undefined) {
      if (typeof explicitMaxLandingTimeS === 'number' && Number.isFinite(explicitMaxLandingTimeS) && explicitMaxLandingTimeS > 0) {
        maxLandingS = explicitMaxLandingTimeS;
      }
    } else if (!hasStintBudget && typeof traverser.maxTimeS === 'number' && Number.isFinite(traverser.maxTimeS) && traverser.maxTimeS > 0) {
      const availTravelS = traverser.maxTimeS - stopTime_s;
      if (availTravelS <= 0) {
        return { ok: false, reason: 'no-landing', withinRangeChecked: true };
      }
      // Directed uphill/downhill costs are asymmetric, so landing -> Stop 1 cannot safely prune at availTravelS / 2.
      maxLandingS = availTravelS;
    }

    let found = suggestLandingSites(waypoints[0], maxLandingS, minSeparationM, minTargetStandoffM);
    if (!found && minTargetStandoffM > 0) {
      found = suggestLandingSites(waypoints[0], maxLandingS, minSeparationM, Math.max(0, minTargetStandoffM - cellM));
    }
    if (!found) {
      return { ok: false, reason: 'no-landing', withinRangeChecked: Number.isFinite(maxLandingS) };
    }

    marginalLanding = found.marginal;
    landingCandidates = found.candidates.map(({ cell, tier, distance_m, time_s }) => ({ cell, tier, distance_m, time_s }));

    const picked =
      (chosenLandingCell != null ? found.candidates.find((c) => c.cell === chosenLandingCell) : undefined) ??
      found.candidates[0];
    activeLandingCell = picked.cell;
    primaryLandingSmooth = smoothLegPath(picked.pathToTarget);
  }

  const originCell = effectiveMode === 'auto-landing' ? activeLandingCell! : waypoints[0];
  const optimizeStopsEnabled = optimizeStops === true;
  const identityOrder = Array.from({ length: stopCount }, (_, i) => i);
  const stopOrderCapped = optimizeStopsEnabled && stopCount > MAX_OPTIMIZE_STOPS;

  let chosenOrder = identityOrder;
  let stopOrderChanged = false;
  let unoptimizedTime_s: number | null = null;

  const nodes = stopCount > 0 ? [originCell, ...stopCells] : [];
  const legCache = new Map<number, SmoothedLeg | null>();
  const cacheStride = stopCount + 1;
  if (primaryLandingSmooth && stopCount > 0) {
    legCache.set(0 * cacheStride + 1, primaryLandingSmooth);
  }

  const getLeg = (fromNode: number, toNode: number): SmoothedLeg | null => {
    const cacheKey = fromNode * cacheStride + toNode;
    if (legCache.has(cacheKey)) return legCache.get(cacheKey)!;
    const raw = findPath(nodes[fromNode], nodes[toNode]);
    const smoothed = raw ? smoothLegPath(raw) : null;
    legCache.set(cacheKey, smoothed);
    return smoothed;
  };

  if (optimizeStopsEnabled && !stopOrderCapped && stopCount >= 2 && stopCount <= MAX_OPTIMIZE_STOPS) {
    // Evaluate identity order first as exact baseline
    let identityOk = true;
    let identityTravelTime = 0;
    let prev = 0;
    for (let i = 0; i < stopCount; i++) {
      const leg = getLeg(prev, i + 1);
      if (!leg) {
        identityOk = false;
        break;
      }
      identityTravelTime += leg.time_s;
      prev = i + 1;
    }
    if (identityOk && roundTrip) {
      const ret = getLeg(prev, 0);
      if (!ret) identityOk = false;
      else identityTravelTime += ret.time_s;
    }
    if (identityOk) unoptimizedTime_s = identityTravelTime + stopTime_s;

    let bestOrder = identityOrder.slice();
    let bestTravelTime = identityOk ? identityTravelTime : Infinity;
    const used = new Uint8Array(stopCount + 1);
    const curPerm = new Int32Array(stopCount);

    const dfs = (depth: number, prevNode: number, accTime: number): void => {
      if (accTime >= bestTravelTime - 1e-6) return;
      if (depth === stopCount) {
        let totalT = accTime;
        if (roundTrip) {
          const ret = getLeg(prevNode, 0);
          if (!ret) return;
          totalT += ret.time_s;
          if (totalT >= bestTravelTime - 1e-6) return;
        }
        bestTravelTime = totalT;
        for (let i = 0; i < stopCount; i++) bestOrder[i] = curPerm[i] - 1;
        return;
      }
      for (let node = 1; node <= stopCount; node++) {
        if (used[node]) continue;
        const leg = getLeg(prevNode, node);
        if (!leg) continue;
        used[node] = 1;
        curPerm[depth] = node;
        dfs(depth + 1, node, accTime + leg.time_s);
        used[node] = 0;
      }
    };

    dfs(0, 0, 0);

    for (let i = 0; i < stopCount; i++) {
      if (bestOrder[i] !== i) {
        stopOrderChanged = true;
        break;
      }
    }
    chosenOrder = bestOrder;
  }

  // Materialize full smoothed route, stop indices, and legs along chosenOrder
  const full: number[] = [];
  const fullCols: number[] = [];
  const fullRows: number[] = [];
  const stopCountsInFull = new Map<number, number>();
  const addStopAt = (idx: number) => stopCountsInFull.set(idx, (stopCountsInFull.get(idx) ?? 0) + 1);
  const legs: RouteLeg[] = [];

  if (waypoints.length > 0) {
    const startCol = originCell % width;
    const startRow = (originCell - startCol) / width;
    full.push(originCell);
    fullCols.push(startCol);
    fullRows.push(startRow);

    let prevNode = 0;
    for (let i = 0; i < stopCount; i++) {
      const targetNode = chosenOrder[i] + 1;
      const leg = getLeg(prevNode, targetNode);
      if (!leg) {
        return { ok: false, reason: 'no-route', legIndex: effectiveMode === 'auto-landing' ? i : i };
      }
      legs.push({ distance_m: leg.distance_m, time_s: leg.time_s });
      for (let k = 1; k < leg.cells.length; k++) {
        full.push(leg.cells[k]);
        fullCols.push(leg.cols[k]);
        fullRows.push(leg.rows[k]);
      }
      addStopAt(full.length - 1);
      prevNode = targetNode;
    }

    if (roundTrip && legs.length > 0) {
      const lastStopCell = nodes[prevNode];
      if (lastStopCell === originCell) {
        legs.push({ distance_m: 0, time_s: 0, isReturn: true });
      } else {
        // Never reverse the outbound leg: return leg has opposite uphill/downhill slopes!
        const ret = getLeg(prevNode, 0);
        if (!ret) return { ok: false, reason: 'no-route', legIndex: legs.length, isReturnLeg: true };
        legs.push({ distance_m: ret.distance_m, time_s: ret.time_s, isReturn: true });
        for (let k = 1; k < ret.cells.length; k++) {
          full.push(ret.cells[k]);
          fullCols.push(ret.cols[k]);
          fullRows.push(ret.rows[k]);
        }
      }
    }
  }

  const distance_m = legs.reduce((sum, l) => sum + l.distance_m, 0);
  const travelTime_s = legs.reduce((sum, l) => sum + l.time_s, 0);
  const appliedStopTime = legs.length > 0 ? stopTime_s : 0;
  return {
    ok: true,
    effectiveMode,
    landingCandidates,
    activeLandingCell,
    marginalLanding,
    full,
    fullCols,
    fullRows,
    stopCountsInFull,
    legs,
    distance_m,
    travelTime_s,
    stopTime_s: appliedStopTime,
    time_s: travelTime_s + appliedStopTime,
    optimizeStopsEnabled,
    stopOrder: chosenOrder,
    stopOrderChanged,
    stopOrderCapped,
    stopOrderCap: MAX_OPTIMIZE_STOPS,
    unoptimizedTime_s,
  };
}

function evaluateDecision(params: {
  exceededMaxTime: boolean;
  walkBackExceeded: boolean;
  radialCapExceeded: boolean;
  radialCapLimitM: number | null;
  totalDistExceeded: boolean;
  totalDistCapM: number | null;
  energyExceeded: boolean;
  minMarginRatio: number | null;
  assumedTerrainData: boolean;
  hasThermalInertiaData: boolean;
  hasRockData: boolean;
  noDataCells: number;
  cautionCells: number;
  marginalLanding: boolean;
}): {
  brokenConditions: BrokenCondition[];
  decision: SafetyDecision;
  decisionReasons: string[];
} {
  const brokenConditions: BrokenCondition[] = [];
  if (params.exceededMaxTime || params.walkBackExceeded) brokenConditions.push('time');
  if (params.radialCapExceeded || params.totalDistExceeded) brokenConditions.push('distance');
  if (params.energyExceeded) brokenConditions.push('energy');

  if (brokenConditions.length > 0) {
    const reasons: string[] = [];
    if (params.walkBackExceeded) reasons.push('walk-back survival time limit exceeded (broken: time)');
    if (params.exceededMaxTime) reasons.push('max mission duration exceeded (broken: time)');
    if (params.radialCapExceeded) {
      const capKm = params.radialCapLimitM !== null ? Number((params.radialCapLimitM / 1000).toFixed(2)) : 10;
      reasons.push(`radial standoff > ${capKm} km from base (broken: distance)`);
    }
    if (params.totalDistExceeded) {
      const capKm = params.totalDistCapM !== null ? Number((params.totalDistCapM / 1000).toFixed(2)) : 0;
      reasons.push(`total traverser range > ${capKm} km exceeded (broken: distance)`);
    }
    if (params.energyExceeded) {
      reasons.push('usable battery exhausted before reserve (broken: energy)');
    }
    return { brokenConditions, decision: 'NO-GO', decisionReasons: reasons };
  }

  const cautionReasons: string[] = [];
  if (params.minMarginRatio !== null && params.minMarginRatio < 0.1) {
    const pct = Math.max(0, Math.round(params.minMarginRatio * 100));
    cautionReasons.push(`safety time margin < 10% (${pct}% remaining)`);
  }
  if (params.noDataCells > 0) {
    cautionReasons.push('route crosses unmapped no-data terrain');
  }
  if (params.cautionCells > 0) {
    cautionReasons.push('route crosses caution hazard terrain');
  }
  if (params.marginalLanding) {
    cautionReasons.push('marginal (class 1) landing site');
  }
  // Dataset-level assumptions apply to every route on a grid, so they are reported as
  // notes next to the decision but do not by themselves turn a route into CAUTION;
  // otherwise GO could never appear and CAUTION would carry no route-specific meaning.
  const datasetNotes: string[] = [];
  if (!params.hasRockData && !params.hasThermalInertiaData) {
    datasetNotes.push('rock and thermal inertia data not available (assumed)');
  } else if (!params.hasRockData) {
    datasetNotes.push('sub-grid rock data not resolved at grid scale (assumed)');
  } else if (!params.hasThermalInertiaData) {
    datasetNotes.push('thermal inertia not resolved at grid scale (assumed)');
  } else if (params.assumedTerrainData) {
    datasetNotes.push('rock and thermal inertia data not available (assumed)');
  }

  if (cautionReasons.length > 0) {
    return { brokenConditions, decision: 'CAUTION', decisionReasons: [...cautionReasons, ...datasetNotes] };
  }
  return {
    brokenConditions,
    decision: 'GO',
    decisionReasons: ['all evaluated corridor checks passed', ...datasetNotes],
  };
}

interface EnvelopeEvaluation {
  noDataCells: number;
  cautionCells: number;
  noDataM: number;
  cautionM: number;
  looseGroundM: number;
  hasThermalInertiaGrid: boolean;
  maxSlope_deg: number;
  turnAroundCell: number | null;
  turnAroundDist_m: number | null;
  exceededMaxTime: boolean;
  walkBackLimit_s: number | null;
  maxWalkBackTotal_s: number | null;
  peakWalkBackDist_m: number | null;
  walkBackExceeded: boolean;
  walkBackCell: number | null;
  walkBackDist_m: number | null;
  maxRadialDist_m: number;
  radialCapLimit_m: number | null;
  radialCapExceeded: boolean;
  radialCapCell: number | null;
  radialCapDist_m: number | null;
  totalDistCap_m: number | null;
  totalDistExceeded: boolean;
  totalDistCell: number | null;
  totalDistThreshold_m: number | null;
  energyUsable_wh: number | null;
  energyReserve_wh: number | null;
  energyUsed_wh: number | null;
  energyDrive_wh: number | null;
  energyBase_wh: number | null;
  energyRemaining_wh: number | null;
  energyExceeded: boolean;
  energyCell: number | null;
  energyDist_m: number | null;
  stintStops: StintStop[];
  totalStints: number;
  stintDistBudget_m: number | null;
  minMarginRatio: number | null;
  brokenConditions: BrokenCondition[];
  decision: SafetyDecision;
  decisionReasons: string[];
  unsafeMask: Uint8Array | null;
  profileDist: Float32Array;
  profileTime: Float32Array;
  profileSlope: Float32Array;
  profileElev: Float32Array | null;
}

function evaluateRouteEnvelope(params: {
  planned: MissionPlanOk;
  traverser: RouterTraverser;
  stopWorkS: number;
  allowNoData: boolean;
  walkBack: WalkBackSpec | null | undefined;
  assumedTerrainData: boolean;
  hasThermalInertiaData: boolean;
  hasRockData: boolean;
  includeProfiles: boolean;
  fastWalkBack?: boolean;
}): EnvelopeEvaluation {
  const { planned, traverser, stopWorkS, allowNoData, walkBack, includeProfiles } = params;
  const haz = hazard!;
  const { full, fullCols, fullRows, stopCountsInFull } = planned;

  prepareSpeeds(traverser, allowNoData);

  const hasElevation = elevI16 !== null || elevF32 !== null;
  const hasThermalInertiaGrid = thermalU16 !== null;
  const profileDist = new Float32Array(full.length);
  const profileTime = new Float32Array(full.length);
  const profileSlope = new Float32Array(includeProfiles ? full.length : 0);
  const profileElev = includeProfiles && hasElevation && planned.legs.length > 0 ? new Float32Array(full.length) : null;
  const cumArrival = new Float64Array(full.length);
  const cumAfterStop = new Float64Array(full.length);

  const positiveOrNull = (v: number | null | undefined): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;

  const maxTimeS = positiveOrNull(traverser.maxTimeS);
  const radialCapLimit_m = positiveOrNull(traverser.maxRadialDistM);
  const stintDistBudget_m = positiveOrNull(traverser.stintDistM);
  const stintTimeBudget_s = positiveOrNull(traverser.stintTimeS);
  const totalDistCap_m = positiveOrNull(traverser.totalDistCapM);
  const perStopS = Math.max(0, Number.isFinite(stopWorkS) ? stopWorkS : 0);

  const ep = traverser.energyProfile ?? null;
  const energyReserve_wh = ep ? ep.enerji_kapasite_wh * ep.rezerv_orani : null;
  const energyUsable_wh = ep && energyReserve_wh !== null ? ep.enerji_kalan_wh - energyReserve_wh : null;
  const cumEnergyWh = ep ? new Float64Array(full.length) : null;

  const originCell = full.length > 0 ? full[0] : 0;
  const oCol = originCell % width;
  const oRow = (originCell - oCol) / width;
  const radialDist = new Float64Array(full.length);

  let noDataCells = 0;
  let cautionCells = 0;
  let noDataM = 0;
  let cautionM = 0;
  let looseGroundM = 0;
  let maxSlope_deg = 0;
  let maxRadialDist_m = 0;
  let radialCapExceeded = false;
  let radialCapCell: number | null = null;
  let radialCapDist_m: number | null = null;
  let totalDistExceeded = false;
  let totalDistCell: number | null = null;
  let totalDistThreshold_m: number | null = null;

  let cumDriveWh = 0;
  let cumBaseWh = 0;
  let energyExceeded = false;
  let energyCell: number | null = null;
  let energyDist_m: number | null = null;

  let along = 0;
  let cumTime = 0;

  for (let k = 0; k < full.length; k++) {
    const cell = full[k];
    const cellNd = isNoData(cell);
    const isCaution = haz[cell] === HAZARD_CAUTION;
    const isLoose = isCaution || groundTierAt(cell) > 0;
    if (cellNd) noDataCells++;
    else {
      const deg = slopeDegAt(cell);
      if (deg > maxSlope_deg) maxSlope_deg = deg;
    }
    if (isCaution) cautionCells++;

    if (k > 0) {
      const prev = full[k - 1];
      const step = Math.hypot(fullCols[k] - fullCols[k - 1], fullRows[k] - fullRows[k - 1]) * cellM;
      const spd = stepSpeed(prev, cell);
      const stepTimeS = spd > 0 ? step / spd : 0;
      along += step;
      cumTime += stepTimeS;

      const ndWeight = (isNoData(prev) ? 0.5 : 0) + (cellNd ? 0.5 : 0);
      const cWeight = (haz[prev] === HAZARD_CAUTION ? 0.5 : 0) + (isCaution ? 0.5 : 0);
      const prevLoose = haz[prev] === HAZARD_CAUTION || groundTierAt(prev) > 0;
      const lWeight = (prevLoose ? 0.5 : 0) + (isLoose ? 0.5 : 0);
      noDataM += step * ndWeight;
      cautionM += step * cWeight;
      looseGroundM += step * lWeight;

      if (ep) {
        const zPrev = hasElevation ? elevMetresAt(prev) : NaN;
        const zCur = hasElevation ? elevMetresAt(cell) : NaN;
        const stepClimb = !Number.isNaN(zPrev) && !Number.isNaN(zCur) && zCur > zPrev ? zCur - zPrev : 0;
        const stepCrr = 0.5 * (groundCrrAt(prev, ep) + groundCrrAt(cell, ep));
        cumDriveWh += (ep.kutle_kg * ep.yercekimi_m_s2 * (stepClimb + stepCrr * step)) / (ep.verim * 3600);
        cumBaseWh += ep.baz_guc_w * (stepTimeS / 3600);
      }
    }

    cumArrival[k] = cumTime;
    const energyBeforeStops = cumDriveWh + cumBaseWh;
    const stopsHere = stopCountsInFull.get(k);
    if (stopsHere) {
      const dwellS = stopsHere * perStopS;
      cumTime += dwellS;
      if (ep) cumBaseWh += ep.baz_guc_w * (dwellS / 3600);
    }
    cumAfterStop[k] = cumTime;

    profileDist[k] = along;
    profileTime[k] = cumTime;
    if (includeProfiles) {
      profileSlope[k] = cellNd ? NaN : slopeDegAt(cell);
      if (profileElev) profileElev[k] = elevMetresAt(cell);
    }

    if (ep && cumEnergyWh && energyUsable_wh !== null) {
      const usedAfter = cumDriveWh + cumBaseWh;
      cumEnergyWh[k] = usedAfter;
      if (!energyExceeded && planned.legs.length > 0 && usedAfter > energyUsable_wh) {
        energyExceeded = true;
        const eIdx = energyBeforeStops > energyUsable_wh && k > 0 ? k - 1 : k;
        energyCell = full[eIdx];
        energyDist_m = profileDist[eIdx];
      }
    }

    const cCol = fullCols[k];
    const cRow = fullRows[k];
    const rM = Math.hypot(cCol - oCol, cRow - oRow) * cellM;
    radialDist[k] = rM;
    if (rM > maxRadialDist_m) maxRadialDist_m = rM;

    if (!radialCapExceeded && radialCapLimit_m !== null && planned.legs.length > 0 && rM > radialCapLimit_m) {
      radialCapExceeded = true;
      const rIdx = k > 0 ? k - 1 : 0;
      radialCapCell = full[rIdx];
      radialCapDist_m = profileDist[rIdx];
    }
    if (!totalDistExceeded && totalDistCap_m !== null && planned.legs.length > 0 && along > totalDistCap_m) {
      totalDistExceeded = true;
      const tIdx = k > 0 ? k - 1 : 0;
      totalDistCell = full[tIdx];
      totalDistThreshold_m = profileDist[tIdx];
    }
  }

  // Compute candidate stint split points (stopping before radial/total/energy caps) so per-stint limits apply cleanly.
  const stintStops: StintStop[] = [];
  const stintStartTimeAt = new Float64Array(full.length);
  if (stintDistBudget_m !== null && planned.legs.length > 0 && full.length > 1) {
    let stintStartDist = 0;
    let stintStartTime = 0;
    let nextStint = 2;
    for (let k = 0; k < full.length; k++) {
      stintStartTimeAt[k] = stintStartTime;
      if (k === 0 || k >= full.length - 1) continue;
      const overRadial = radialCapLimit_m !== null && radialDist[k] > radialCapLimit_m;
      const overTotal = totalDistCap_m !== null && profileDist[k] > totalDistCap_m;
      const overEnergy = cumEnergyWh !== null && energyUsable_wh !== null && cumEnergyWh[k] > energyUsable_wh;
      if (overRadial || overTotal || overEnergy) continue;
      const distSinceStart = profileDist[k] - stintStartDist;
      const timeSinceStart = cumArrival[k] - stintStartTime;
      if (
        distSinceStart >= stintDistBudget_m ||
        (stintTimeBudget_s !== null && timeSinceStart >= stintTimeBudget_s)
      ) {
        stintStops.push({
          cell: full[k],
          pathIndex: k,
          dist_m: profileDist[k],
          time_s: cumAfterStop[k],
          nextStint,
        });
        nextStint++;
        stintStartDist = profileDist[k];
        stintStartTime = cumAfterStop[k];
      }
    }
  }

  // Segment reachable mission across EVA / sol budgets; total duration cap only applies when unsegmented.
  const applyContinuousTimeCap = stintDistBudget_m === null && maxTimeS !== null;
  const exceededMaxTime = applyContinuousTimeCap && planned.legs.length > 0 && planned.time_s > maxTimeS;
  let turnAroundCell: number | null = null;
  let turnAroundDist_m: number | null = null;
  if (exceededMaxTime && full.length > 0) {
    for (let k = 0; k < full.length; k++) {
      if (cumAfterStop[k] > maxTimeS!) {
        const tIdx = cumArrival[k] > maxTimeS! && k > 0 ? k - 1 : k;
        turnAroundCell = full[tIdx];
        turnAroundDist_m = profileDist[tIdx];
        break;
      }
    }
  }

  const activeWalkBack =
    walkBack && typeof walkBack.limitS === 'number' && Number.isFinite(walkBack.limitS) && walkBack.limitS > 0
      ? walkBack
      : null;
  let walkBackLimit_s: number | null = null;
  let maxWalkBackTotal_s: number | null = null;
  let peakWalkBackDist_m: number | null = null;
  let walkBackExceeded = false;
  let walkBackCell: number | null = null;
  let walkBackDist_m: number | null = null;
  let walkTimes: Float64Array | null = null;

  if (activeWalkBack && planned.legs.length > 0 && full.length > 0) {
    walkBackLimit_s = activeWalkBack.limitS;
    walkTimes = computeWalkBackTimes(full[0], full, activeWalkBack, allowNoData, params.fastWalkBack === true);
    let peakTotal = -1;
    for (let k = 0; k < full.length; k++) {
      const elapsedInStint = cumAfterStop[k] - stintStartTimeAt[k];
      const arrivalInStint = cumArrival[k] - stintStartTimeAt[k];
      const totalAfter = elapsedInStint + walkTimes[k];
      if (totalAfter > peakTotal) {
        peakTotal = totalAfter;
        peakWalkBackDist_m = profileDist[k];
      }
      if (!walkBackExceeded && totalAfter > walkBackLimit_s) {
        walkBackExceeded = true;
        const wbIdx = arrivalInStint + walkTimes[k] > walkBackLimit_s && k > 0 ? k - 1 : k;
        walkBackCell = full[wbIdx];
        walkBackDist_m = profileDist[wbIdx];
      }
    }
    maxWalkBackTotal_s = peakTotal >= 0 ? peakTotal : 0;
  }

  let unsafeMask: Uint8Array | null = null;
  if ((exceededMaxTime || walkBackExceeded || radialCapExceeded || totalDistExceeded || energyExceeded) && full.length > 0) {
    unsafeMask = new Uint8Array(full.length);
    for (let k = 0; k < full.length; k++) {
      const overTime = applyContinuousTimeCap && cumAfterStop[k] > maxTimeS!;
      const overWalk =
        walkBackLimit_s !== null &&
        walkTimes !== null &&
        cumAfterStop[k] - stintStartTimeAt[k] + walkTimes[k] > walkBackLimit_s;
      const overRadial = radialCapLimit_m !== null && radialDist[k] > radialCapLimit_m;
      const overTotal = totalDistCap_m !== null && profileDist[k] > totalDistCap_m;
      const overEnergy = cumEnergyWh !== null && energyUsable_wh !== null && cumEnergyWh[k] > energyUsable_wh;
      if (overTime || overWalk || overRadial || overTotal || overEnergy) unsafeMask[k] = 1;
    }
  }

  const filteredStintStops = unsafeMask ? stintStops.filter((s) => unsafeMask![s.pathIndex] === 0) : stintStops;
  const totalStints = planned.legs.length > 0 ? 1 + filteredStintStops.length : 0;

  const energyDrive_wh = ep ? cumDriveWh : null;
  const energyBase_wh = ep ? cumBaseWh : null;
  const energyUsed_wh = ep ? cumDriveWh + cumBaseWh : null;
  const energyRemaining_wh = ep && energyUsed_wh !== null ? ep.enerji_kalan_wh - energyUsed_wh : null;

  let minMarginRatio: number | null = null;
  if (planned.legs.length > 0) {
    if (walkBackLimit_s !== null && maxWalkBackTotal_s !== null) {
      minMarginRatio = (walkBackLimit_s - maxWalkBackTotal_s) / walkBackLimit_s;
    }
    if (applyContinuousTimeCap && maxTimeS !== null) {
      const missionMargin = (maxTimeS - planned.time_s) / maxTimeS;
      minMarginRatio = minMarginRatio === null ? missionMargin : Math.min(minMarginRatio, missionMargin);
    }
    if (totalDistCap_m !== null) {
      const rangeMargin = (totalDistCap_m - planned.distance_m) / totalDistCap_m;
      minMarginRatio = minMarginRatio === null ? rangeMargin : Math.min(minMarginRatio, rangeMargin);
    }
    if (energyUsable_wh !== null && energyUsable_wh > 0 && energyUsed_wh !== null) {
      const energyMargin = (energyUsable_wh - energyUsed_wh) / energyUsable_wh;
      minMarginRatio = minMarginRatio === null ? energyMargin : Math.min(minMarginRatio, energyMargin);
    }
  }

  const hasTiEffective = params.hasThermalInertiaData || (hasThermalInertiaGrid && traverser.groundModel != null);
  const { brokenConditions, decision, decisionReasons } = evaluateDecision({
    exceededMaxTime,
    walkBackExceeded,
    radialCapExceeded,
    radialCapLimitM: radialCapLimit_m,
    totalDistExceeded,
    totalDistCapM: totalDistCap_m,
    energyExceeded,
    minMarginRatio,
    assumedTerrainData: params.assumedTerrainData,
    hasThermalInertiaData: hasTiEffective,
    hasRockData: params.hasRockData,
    noDataCells,
    cautionCells,
    marginalLanding: planned.marginalLanding,
  });

  return {
    noDataCells,
    cautionCells,
    noDataM,
    cautionM,
    looseGroundM,
    hasThermalInertiaGrid,
    maxSlope_deg,
    turnAroundCell,
    turnAroundDist_m,
    exceededMaxTime,
    walkBackLimit_s,
    maxWalkBackTotal_s,
    peakWalkBackDist_m,
    walkBackExceeded,
    walkBackCell,
    walkBackDist_m,
    maxRadialDist_m,
    radialCapLimit_m,
    radialCapExceeded,
    radialCapCell,
    radialCapDist_m,
    totalDistCap_m,
    totalDistExceeded,
    totalDistCell,
    totalDistThreshold_m,
    energyUsable_wh,
    energyReserve_wh,
    energyUsed_wh,
    energyDrive_wh,
    energyBase_wh,
    energyRemaining_wh,
    energyExceeded,
    energyCell,
    energyDist_m,
    stintStops: filteredStintStops,
    totalStints,
    stintDistBudget_m,
    minMarginRatio,
    brokenConditions,
    decision,
    decisionReasons,
    unsafeMask,
    profileDist,
    profileTime,
    profileSlope,
    profileElev,
  };
}

let latestRouteId = 0;

function runRouteCore(
  id: number,
  msg: Omit<Extract<ToWorker, { type: 'route' }>, 'type' | 'id'>,
): { result: RouteSuccess | RouteFailure; transfer: Transferable[] } {
  const roundTrip = msg.roundTrip === true;
  const stopWorkS = msg.stopWorkS ?? 0;
  const allowNoData = msg.allowNoData === true;
  const assumedTerrainData = msg.assumedTerrainData !== false;
  const hasThermalInertiaData = msg.hasThermalInertiaData ?? !assumedTerrainData;
  const hasRockData = msg.hasRockData ?? !assumedTerrainData;

  const planned = planMission(
    msg.mode,
    msg.waypoints,
    msg.chosenLandingCell,
    msg.minSeparationM,
    msg.maxLandingTimeS,
    roundTrip,
    stopWorkS,
    allowNoData,
    msg.traverser,
    msg.minTargetStandoffM ?? 0,
    msg.optimizeStops === true,
  );

  if (!planned.ok) {
    return { result: { type: 'route-result', id, ...planned }, transfer: [] };
  }

  const path = Int32Array.from(planned.full);
  const pathCols = Float32Array.from(planned.fullCols);
  const pathRows = Float32Array.from(planned.fullRows);
  const env = evaluateRouteEnvelope({
    planned,
    traverser: msg.traverser,
    stopWorkS,
    allowNoData,
    walkBack: msg.walkBack,
    assumedTerrainData,
    hasThermalInertiaData,
    hasRockData,
    includeProfiles: true,
    fastWalkBack: false,
  });

  const transfer: Transferable[] = [
    path.buffer,
    pathCols.buffer,
    pathRows.buffer,
    env.profileDist.buffer,
    env.profileTime.buffer,
    env.profileSlope.buffer,
    ...(env.profileElev ? [env.profileElev.buffer] : []),
    ...(env.unsafeMask ? [env.unsafeMask.buffer] : []),
  ];

  return {
    result: {
      type: 'route-result',
      id,
      ok: true,
      mode: planned.effectiveMode,
      roundTrip,
      landingCandidates: planned.landingCandidates,
      activeLandingCell: planned.activeLandingCell,
      marginalLanding: planned.marginalLanding,
      path,
      pathCols,
      pathRows,
      legs: planned.legs,
      distance_m: planned.distance_m,
      time_s: planned.time_s,
      travelTime_s: planned.travelTime_s,
      stopTime_s: planned.stopTime_s,
      optimizeStopsEnabled: planned.optimizeStopsEnabled,
      stopOrder: planned.stopOrder,
      stopOrderChanged: planned.stopOrderChanged,
      stopOrderCapped: planned.stopOrderCapped,
      stopOrderCap: planned.stopOrderCap,
      unoptimizedTime_s: planned.unoptimizedTime_s,
      noDataCells: env.noDataCells,
      cautionCells: env.cautionCells,
      noDataM: env.noDataM,
      cautionM: env.cautionM,
      looseGroundM: env.looseGroundM,
      hasThermalInertiaGrid: env.hasThermalInertiaGrid,
      turnAroundCell: env.turnAroundCell,
      turnAroundDist_m: env.turnAroundDist_m,
      walkBackLimit_s: env.walkBackLimit_s,
      maxWalkBackTotal_s: env.maxWalkBackTotal_s,
      peakWalkBackDist_m: env.peakWalkBackDist_m,
      walkBackExceeded: env.walkBackExceeded,
      walkBackCell: env.walkBackCell,
      walkBackDist_m: env.walkBackDist_m,
      maxRadialDist_m: env.maxRadialDist_m,
      radialCapLimit_m: env.radialCapLimit_m,
      radialCapExceeded: env.radialCapExceeded,
      radialCapCell: env.radialCapCell,
      radialCapDist_m: env.radialCapDist_m,
      energyUsable_wh: env.energyUsable_wh,
      energyReserve_wh: env.energyReserve_wh,
      energyUsed_wh: env.energyUsed_wh,
      energyDrive_wh: env.energyDrive_wh,
      energyBase_wh: env.energyBase_wh,
      energyRemaining_wh: env.energyRemaining_wh,
      energyExceeded: env.energyExceeded,
      energyCell: env.energyCell,
      energyDist_m: env.energyDist_m,
      minMarginRatio: env.minMarginRatio,
      brokenConditions: env.brokenConditions,
      decision: env.decision,
      decisionReasons: env.decisionReasons,
      stintStops: env.stintStops,
      totalStints: env.totalStints,
      stintDistBudget_m: env.stintDistBudget_m,
      totalDistCap_m: env.totalDistCap_m,
      totalDistExceeded: env.totalDistExceeded,
      totalDistCell: env.totalDistCell,
      totalDistThreshold_m: env.totalDistThreshold_m,
      unsafeMask: env.unsafeMask,
      profileDist: env.profileDist,
      profileTime: env.profileTime,
      profileSlope: env.profileSlope,
      profileElev: env.profileElev,
    },
    transfer,
  };
}

async function route(msg: Extract<ToWorker, { type: 'route' }>): Promise<void> {
  if ((!slopeU8 && !slopeF32) || !hazard) return;
  if (msg.id !== latestRouteId) return;

  try {
    await ensureElevationLoaded();
    if (msg.id !== latestRouteId) return;
    const { result, transfer } = runRouteCore(msg.id, msg);
    post(result, transfer);
  } finally {
    trimWindowBuffers();
  }
}

export function computeRouteForTest(
  msg: Omit<Extract<ToWorker, { type: 'route' }>, 'type' | 'id'>,
): RouteSuccess | RouteFailure {
  if ((!slopeU8 && !slopeF32) || !hazard) {
    throw new Error('Grid not initialized; call initGridFromBuffers first');
  }
  try {
    return runRouteCore(1, msg).result;
  } finally {
    trimWindowBuffers();
  }
}

function runCompareCore(msg: Omit<Extract<ToWorker, { type: 'compare' }>, 'type' | 'id'>): TraverserComparisonRow[] {
  const assumedTerrainData = msg.assumedTerrainData !== false;
  const hasThermalInertiaData = msg.hasThermalInertiaData ?? !assumedTerrainData;
  const hasRockData = msg.hasRockData ?? !assumedTerrainData;
  const minTargetStandoffM = msg.minTargetStandoffM ?? 0;

  return msg.entries.map((entry) => {
    const res = planMission(
      msg.mode,
      msg.waypoints,
      null,
      msg.minSeparationM,
      undefined,
      msg.roundTrip,
      msg.stopWorkS,
      msg.allowNoData,
      entry.traverser,
      minTargetStandoffM,
      msg.optimizeStops === true,
    );
    if (!res.ok) {
      let failReason = 'Unreachable';
      if (res.reason === 'blocked-waypoint') {
        failReason =
          res.why === 'forbidden'
            ? 'Stop in forbidden zone'
            : res.why === 'no-data'
            ? 'Stop in no-data zone'
            : `Stop > ${entry.traverser.maxSlopeDeg}°`;
      } else if (res.reason === 'no-landing') {
        failReason = res.withinRangeChecked ? 'No landing within max duration' : 'No reachable landing site';
      } else {
        failReason = `Blocked (> ${entry.traverser.maxSlopeDeg}° or forbidden)`;
      }
      return { id: entry.id, name: entry.name, ok: false, failReason };
    }

    const env = evaluateRouteEnvelope({
      planned: res,
      traverser: entry.traverser,
      stopWorkS: msg.stopWorkS,
      allowNoData: msg.allowNoData,
      walkBack: entry.walkBack,
      assumedTerrainData,
      hasThermalInertiaData,
      hasRockData,
      includeProfiles: false,
      fastWalkBack: true,
    });

    const withinLimit = !env.exceededMaxTime && !env.totalDistExceeded && !env.energyExceeded;
    return {
      id: entry.id,
      name: entry.name,
      ok: true,
      distance_m: res.distance_m,
      time_s: res.time_s,
      travelTime_s: res.travelTime_s,
      stopTime_s: res.stopTime_s,
      maxSlope_deg: env.maxSlope_deg,
      withinLimit,
      walkBackExceeded: env.walkBackExceeded,
      radialCapExceeded: env.radialCapExceeded,
      energyExceeded: env.energyExceeded,
      brokenConditions: env.brokenConditions,
      decision: env.decision,
      decisionReasons: env.decisionReasons,
      marginalLanding: res.marginalLanding,
      totalStints: env.totalStints,
    };
  });
}

function compareTraversers(msg: Extract<ToWorker, { type: 'compare' }>): void {
  if ((!slopeU8 && !slopeF32) || !hazard) return;
  try {
    const rows = runCompareCore(msg);
    post({ type: 'compare-result', id: msg.id, rows });
  } finally {
    trimWindowBuffers();
  }
}

export function computeCompareForTest(
  msg: Omit<Extract<ToWorker, { type: 'compare' }>, 'type' | 'id'>,
): TraverserComparisonRow[] {
  if ((!slopeU8 && !slopeF32) || !hazard) {
    throw new Error('Grid not initialized; call initGridFromBuffers first');
  }
  try {
    return runCompareCore(msg);
  } finally {
    trimWindowBuffers();
  }
}

function runEscapeCore(
  id: number,
  msg: Omit<Extract<ToWorker, { type: 'escape' }>, 'type' | 'id'>,
): { result: EscapeResult; transfer: Transferable[] } {
  const totalCells = width * height;
  if (
    !Number.isInteger(msg.fromCell) ||
    !Number.isInteger(msg.toCell) ||
    msg.fromCell < 0 ||
    msg.toCell < 0 ||
    msg.fromCell >= totalCells ||
    msg.toCell >= totalCells
  ) {
    return { result: { type: 'escape-result', id, ok: false, reason: 'blocked' }, transfer: [] };
  }

  prepareSpeeds(msg.walker, msg.allowNoData);

  if (msg.fromCell === msg.toCell) {
    const col = msg.fromCell % width;
    const row = (msg.fromCell - col) / width;
    const path = new Int32Array([msg.fromCell]);
    const pathCols = new Float32Array([col]);
    const pathRows = new Float32Array([row]);
    const s = isNoData(msg.fromCell) ? 0 : slopeDegAt(msg.fromCell);
    return {
      result: {
        type: 'escape-result',
        id,
        ok: true,
        path,
        pathCols,
        pathRows,
        distance_m: 0,
        time_s: 0,
        maxSlope_deg: s,
        noDataM: 0,
        cautionM: 0,
      },
      transfer: [path.buffer, pathCols.buffer, pathRows.buffer],
    };
  }

  if (blockReason(msg.fromCell) !== null || blockReason(msg.toCell) !== null) {
    return { result: { type: 'escape-result', id, ok: false, reason: 'blocked' }, transfer: [] };
  }

  const rawCells = findPath(msg.fromCell, msg.toCell);
  if (!rawCells) {
    return { result: { type: 'escape-result', id, ok: false, reason: 'no-route' }, transfer: [] };
  }

  const smoothed = smoothLegPath(rawCells);
  const { cells, cols, rows } = smoothed;
  let maxSlope_deg = 0;
  let noDataM = 0;
  let cautionM = 0;
  for (let k = 0; k < cells.length; k++) {
    const c = cells[k];
    if (!isNoData(c)) {
      const deg = slopeDegAt(c);
      if (deg > maxSlope_deg) maxSlope_deg = deg;
    }
    if (k > 0) {
      const prev = cells[k - 1];
      const step = Math.hypot(cols[k] - cols[k - 1], rows[k] - rows[k - 1]) * cellM;
      const ndWeight = (isNoData(prev) ? 0.5 : 0) + (isNoData(c) ? 0.5 : 0);
      const cWeight = (hazard![prev] === HAZARD_CAUTION ? 0.5 : 0) + (hazard![c] === HAZARD_CAUTION ? 0.5 : 0);
      noDataM += step * ndWeight;
      cautionM += step * cWeight;
    }
  }
  const path = Int32Array.from(cells);
  const pathCols = Float32Array.from(cols);
  const pathRows = Float32Array.from(rows);
  return {
    result: {
      type: 'escape-result',
      id,
      ok: true,
      path,
      pathCols,
      pathRows,
      distance_m: smoothed.distance_m,
      time_s: smoothed.time_s,
      maxSlope_deg,
      noDataM,
      cautionM,
    },
    transfer: [path.buffer, pathCols.buffer, pathRows.buffer],
  };
}

function computeEscapeRoute(msg: Extract<ToWorker, { type: 'escape' }>): void {
  if ((!slopeU8 && !slopeF32) || !hazard) return;
  try {
    const { result, transfer } = runEscapeCore(msg.id, msg);
    post(result, transfer);
  } finally {
    trimWindowBuffers();
  }
}

export function computeEscapeForTest(
  msg: Omit<Extract<ToWorker, { type: 'escape' }>, 'type' | 'id'>,
): EscapeResult {
  if ((!slopeU8 && !slopeF32) || !hazard) {
    throw new Error('Grid not initialized; call initGridFromBuffers first');
  }
  try {
    return runEscapeCore(1, msg).result;
  } finally {
    trimWindowBuffers();
  }
}

function probeCell(cell: number): void {
  if ((!slopeU8 && !slopeF32) || !hazard) return;
  if (!Number.isInteger(cell) || cell < 0 || cell >= width * height) return;
  const slopeDeg = isSlopeNoData(cell) ? null : slopeDegAt(cell);
  const maxValidByte = slopeNoData === 255 ? 254 : 255;
  const slopeAtOrAboveMaxByte = slopeU8 !== null && slopeU8[cell] === maxValidByte;
  const hazardClass = hazard[cell];
  const landingClass = landing ? landing[cell] : null;
  const hasElev = elevI16 !== null || elevF32 !== null;
  const z = hasElev ? elevMetresAt(cell) : NaN;
  post({
    type: 'probe-result',
    cell,
    slopeDeg,
    slopeAtOrAboveMaxByte,
    hazardClass,
    landingClass,
    elevM: Number.isNaN(z) ? null : z,
    elevLoaded,
    thermalInertia: tiAt(cell),
  });
}

let taskChain: Promise<void> = Promise.resolve();

if (ctx) {
  ctx.onmessage = (event: MessageEvent<ToWorker>) => {
    const msg = event.data;
    if (msg.type === 'probe') {
      probeCell(msg.cell);
      return;
    }
    if (msg.type === 'route') latestRouteId = msg.id;
    taskChain = taskChain.then(async () => {
      try {
        if (msg.type === 'init') await init(msg);
        else if (msg.type === 'route') await route(msg);
        else if (msg.type === 'compare') compareTraversers(msg);
        else if (msg.type === 'escape') computeEscapeRoute(msg);
      } catch (err: unknown) {
        post({ type: 'init-error', message: err instanceof Error ? err.message : String(err) });
      }
    });
  };
}
