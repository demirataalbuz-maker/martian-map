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
  FromWorker,
  LandingCandidate,
  RouteFailure,
  RouteLeg,
  RouterTraverser,
  SafetyDecision,
  ToWorker,
  TraverserComparisonRow,
  WalkBackSpec,
} from './route-types';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (message: FromWorker, transfer: Transferable[] = []) => ctx.postMessage(message, transfer);

const ELEV_MIN_VALID = -9000;

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

// 256-entry speed lookup tables (~3 KB total; replaces the full-grid cellSpeed array)
let speedKey = '';
const speedFreeLut = new Float32Array(256);
const speedCautionLut = new Float32Array(256);
const speedNoDataHazardLut = new Float32Array(256);
let slowestSpeed = 0;
let maxSpeed = 0;
let currentMaxSlopeDeg = 0;
let currentAllowNoData = false;
let currentSpeedTable: [number, number][] = [];

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
    if (!force && percent - lastPercent < 2 && now - lastPostMs < 80) return;
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

  const cells = width * height;
  const slopeBytes = slopeType === 'uint8' ? cells : cells * 4;
  const progress = createProgressTracker('terrain', slopeBytes + cells + cells);

  // yukseklik.bin is intentionally NOT downloaded at startup; it is fetched lazily
  // on the first route request so initial page load avoids pulling ~46 MB extra.
  const [slopeBuf, hazardBuf, landingBuf] = await Promise.all([
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
  ]);
  progress.finish();

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

  gScore = new Float64Array(0);
  parentDir = new Uint8Array(0);
  stamp = new Uint16Array(0);
  searchId = 0;
  speedKey = '';

  let noData = 0;
  for (let i = 0; i < cells; i++) if (isNoData(i)) noData++;
  post({
    type: 'ready',
    noDataCells: noData,
    totalCells: cells,
    hasElevation: false,
    hasLanding: landing !== null,
  });
}

function ensureElevationLoaded(): Promise<void> {
  if (elevLoaded || !elevationUrl) {
    elevLoaded = true;
    return Promise.resolve();
  }
  if (!elevLoadPromise) {
    const cells = width * height;
    const elevBytes = elevType === 'int16' ? cells * 2 : cells * 4;
    const progress = createProgressTracker('elevation', elevBytes);
    elevLoadPromise = fetchBinaryWithProgress(
      elevationUrl,
      elevBytes,
      `yukseklik.bin (${width} x ${height} ${elevType})`,
      true,
      (d) => progress.addBytes(d),
      () => progress.dropOptionalBytes(elevBytes),
    )
      .then((elevBuf) => {
        progress.finish();
        if (elevBuf) {
          if (elevType === 'int16') {
            elevI16 = decodeInt16LE(elevBuf);
            elevF32 = null;
          } else {
            elevF32 = decodeFloat32LE(elevBuf);
            elevI16 = null;
          }
        } else {
          elevI16 = null;
          elevF32 = null;
        }
        elevLoaded = true;
      })
      .catch((err: unknown) => {
        elevLoadPromise = null;
        throw err;
      });
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
  const raw = elevF32![i];
  if (raw === elevNoData || !Number.isFinite(raw)) return NaN;
  const z = elevBaseM + raw * elevScaleM;
  return z <= ELEV_MIN_VALID ? NaN : z;
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
  const key = JSON.stringify({
    maxSlopeDeg: traverser.maxSlopeDeg,
    speedTable: traverser.speedTable,
    allowNoData,
    slopeType,
    slopeScale,
    slopeNoData,
  });
  if (key === speedKey) return;
  const table = traverser.speedTable;
  slowestSpeed = Math.min(...table.map((entry) => entry[1]));
  maxSpeed = Math.max(...table.map((entry) => entry[1]));
  currentMaxSlopeDeg = traverser.maxSlopeDeg;
  currentAllowNoData = allowNoData;
  currentSpeedTable = table;

  if (slopeType === 'uint8') {
    const noDataSpeed = allowNoData ? slowestSpeed : 0;
    for (let b = 0; b < 256; b++) {
      if (b === slopeNoData) {
        speedFreeLut[b] = noDataSpeed;
        speedCautionLut[b] = noDataSpeed;
        speedNoDataHazardLut[b] = noDataSpeed;
      } else {
        const deg = b * slopeScale;
        if (deg > currentMaxSlopeDeg) {
          speedFreeLut[b] = 0;
          speedCautionLut[b] = 0;
          speedNoDataHazardLut[b] = 0;
        } else {
          speedFreeLut[b] = speedAtSlope(table, deg);
          speedCautionLut[b] = slowestSpeed;
          speedNoDataHazardLut[b] = noDataSpeed;
        }
      }
    }
  }
  speedKey = key;
}

function cellSpeedAt(i: number): number {
  const h = hazard![i];
  if (slopeU8) {
    const b = slopeU8[i];
    if (h === HAZARD_FREE) return speedFreeLut[b];
    if (h === HAZARD_FORBIDDEN) return 0;
    if (h === HAZARD_CAUTION) return speedCautionLut[b];
    return speedNoDataHazardLut[b];
  }
  if (h === HAZARD_FORBIDDEN) return 0;
  const deg = slopeDegAt(i);
  const noSlope = Number.isNaN(deg);
  if (!noSlope && deg > currentMaxSlopeDeg) return 0;
  if (noSlope || h === HAZARD_NODATA) return currentAllowNoData ? slowestSpeed : 0;
  if (h === HAZARD_CAUTION) return slowestSpeed;
  return speedAtSlope(currentSpeedTable, deg);
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
    const speedHere = cellSpeedAt(row * width + col);
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
      const speedNext = cellSpeedAt(nr * width + nc);
      if (speedNext === 0) continue;
      const isDiagonal = d >= 4;
      if (isDiagonal && (cellSpeedAt(row * width + nc) === 0 || cellSpeedAt(nr * width + col) === 0)) continue;
      const stepTime = (isDiagonal ? diagonal : cellM) / Math.min(speedHere, speedNext);
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
): { candidates: DiscoveredLanding[]; marginal: boolean } | null {
  if (!landing || maxTimeS < 0) return null;
  const tCol = targetCell % width;
  const tRow = (targetCell - tCol) / width;
  const diagonal = cellM * Math.SQRT2;

  const gridSpan = Math.max(width, height);
  const maxRangeCells = Number.isFinite(maxTimeS)
    ? Math.max(1, Math.min(gridSpan, Math.ceil((maxSpeed * maxTimeS) / cellM) + 2))
    : gridSpan;
  let radius = Math.min(maxRangeCells, Math.max(256, Math.ceil((Math.max(minSeparationM, cellM) * 4) / cellM)));

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
      if (lClass === LANDING_SUITABLE && farFromPicked(curGlobal, tier0, minSeparationM)) {
        const pathToTarget = traceWindowToRoot(curLocal, c0, r0, winW, openMark);
        const leg = measure(pathToTarget);
        tier0.push({ cell: curGlobal, tier: 0, distance_m: leg.distance_m, time_s: leg.time_s, pathToTarget });
        if (tier0.length >= MAX_LANDING_CANDIDATES) break;
      } else if (
        lClass === LANDING_MARGINAL &&
        tier0.length === 0 &&
        tier1.length < MAX_LANDING_CANDIDATES &&
        farFromPicked(curGlobal, tier1, minSeparationM)
      ) {
        const pathToTarget = traceWindowToRoot(curLocal, c0, r0, winW, openMark);
        const leg = measure(pathToTarget);
        tier1.push({ cell: curGlobal, tier: 1, distance_m: leg.distance_m, time_s: leg.time_s, pathToTarget });
      }

      const speedHere = cellSpeedAt(curGlobal);
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
        const speedNext = cellSpeedAt(nr * width + nc);
        if (speedNext === 0) continue;
        const isDiagonal = d >= 4;
        if (isDiagonal && (cellSpeedAt(row * width + nc) === 0 || cellSpeedAt(nr * width + col) === 0)) continue;
        const stepTime = (isDiagonal ? diagonal : cellM) / Math.min(speedHere, speedNext);
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
    time += step / Math.min(cellSpeedAt(a), cellSpeedAt(b));
  }
  return { distance_m: distance, time_s: time };
}

/**
 * Computes exact shortest walking return time (seconds) from every cell in `full`
 * back to `originCell` using `walkBack.traverser`'s speed table and slope limit.
 * Uses symmetric undirected edge costs via a single windowed Dijkstra from `originCell`,
 * clipped at `walkBack.limitS` because any cell with walk time > limitS already violates
 * `elapsed + walkBack <= limitS`.
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

      const speedHere = cellSpeedAt(curGlobal);
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
        const speedNext = cellSpeedAt(nr * width + nc);
        if (speedNext === 0) continue;
        const isDiagonal = d >= 4;
        if (isDiagonal && (cellSpeedAt(row * width + nc) === 0 || cellSpeedAt(nr * width + col) === 0)) continue;
        const stepTime = (isDiagonal ? diagonal : cellM) / Math.min(speedHere, speedNext);
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
  stopCountsInFull: Map<number, number>;
  legs: RouteLeg[];
  distance_m: number;
  travelTime_s: number;
  stopTime_s: number;
  time_s: number;
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
): MissionPlanResult {
  prepareSpeeds(traverser, allowNoData);

  for (let w = 0; w < waypoints.length; w++) {
    const why = blockReason(waypoints[w]);
    if (why) return { ok: false, reason: 'blocked-waypoint', waypointIndex: w, why };
  }

  const effectiveMode: 'manual' | 'auto-landing' = mode === 'auto-landing' && landing ? 'auto-landing' : 'manual';
  const stopCount = effectiveMode === 'auto-landing' ? waypoints.length : Math.max(0, waypoints.length - 1);
  const perStopS = Math.max(0, Number.isFinite(stopWorkS) ? stopWorkS : 0);
  const stopTime_s = stopCount * perStopS;

  let landingCandidates: LandingCandidate[] = [];
  let activeLandingCell: number | null = null;
  let marginalLanding = false;
  const full: number[] = [];
  const stopCountsInFull = new Map<number, number>();
  const addStopAt = (idx: number) => stopCountsInFull.set(idx, (stopCountsInFull.get(idx) ?? 0) + 1);
  const legs: RouteLeg[] = [];

  if (effectiveMode === 'auto-landing' && landing && waypoints.length > 0) {
    let maxLandingS = Infinity;
    if (explicitMaxLandingTimeS !== undefined) {
      if (typeof explicitMaxLandingTimeS === 'number' && Number.isFinite(explicitMaxLandingTimeS) && explicitMaxLandingTimeS > 0) {
        maxLandingS = explicitMaxLandingTimeS;
      }
    } else if (typeof traverser.maxTimeS === 'number' && Number.isFinite(traverser.maxTimeS) && traverser.maxTimeS > 0) {
      const availTravelS = traverser.maxTimeS - stopTime_s;
      if (availTravelS <= 0) {
        return { ok: false, reason: 'no-landing', withinRangeChecked: true };
      }
      // By triangle inequality on symmetric undirected edge costs, any round-trip visiting Stop 1
      // takes at least 2 * time(Landing -> Stop 1), halving the Reverse-Dijkstra search radius!
      maxLandingS = roundTrip ? availTravelS / 2 : availTravelS;
    }

    const found = suggestLandingSites(waypoints[0], maxLandingS, minSeparationM);
    if (!found) {
      return { ok: false, reason: 'no-landing', withinRangeChecked: Number.isFinite(maxLandingS) };
    }

    marginalLanding = found.marginal;
    landingCandidates = found.candidates.map(({ cell, tier, distance_m, time_s }) => ({ cell, tier, distance_m, time_s }));

    const picked =
      (chosenLandingCell != null ? found.candidates.find((c) => c.cell === chosenLandingCell) : undefined) ??
      found.candidates[0];
    activeLandingCell = picked.cell;

    full.push(...picked.pathToTarget);
    addStopAt(full.length - 1);
    legs.push({ distance_m: picked.distance_m, time_s: picked.time_s });

    for (let leg = 0; leg + 1 < waypoints.length; leg++) {
      const path = findPath(waypoints[leg], waypoints[leg + 1]);
      if (!path) return { ok: false, reason: 'no-route', legIndex: leg + 1 };
      legs.push(measure(path));
      for (let k = 1; k < path.length; k++) full.push(path[k]);
      addStopAt(full.length - 1);
    }
  } else {
    if (waypoints.length > 0) full.push(waypoints[0]);
    for (let leg = 0; leg + 1 < waypoints.length; leg++) {
      const path = findPath(waypoints[leg], waypoints[leg + 1]);
      if (!path) return { ok: false, reason: 'no-route', legIndex: leg };
      legs.push(measure(path));
      for (let k = 1; k < path.length; k++) full.push(path[k]);
      addStopAt(full.length - 1);
    }
  }

  if (roundTrip && legs.length > 0) {
    const originCell = effectiveMode === 'auto-landing' ? activeLandingCell! : waypoints[0];
    const lastStopCell = waypoints[waypoints.length - 1];
    if (legs.length === 1) {
      // Single outbound leg: by symmetric undirected costs, shortest return is exact reverse
      legs.push({ distance_m: legs[0].distance_m, time_s: legs[0].time_s, isReturn: true });
      for (let k = full.length - 2; k >= 0; k--) full.push(full[k]);
    } else if (lastStopCell === originCell) {
      legs.push({ distance_m: 0, time_s: 0, isReturn: true });
    } else {
      const retPath = findPath(lastStopCell, originCell);
      if (!retPath) return { ok: false, reason: 'no-route', legIndex: legs.length, isReturnLeg: true };
      const retLeg = measure(retPath);
      legs.push({ distance_m: retLeg.distance_m, time_s: retLeg.time_s, isReturn: true });
      for (let k = 1; k < retPath.length; k++) full.push(retPath[k]);
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
    stopCountsInFull,
    legs,
    distance_m,
    travelTime_s,
    stopTime_s: appliedStopTime,
    time_s: travelTime_s + appliedStopTime,
  };
}

function evaluateDecision(params: {
  exceededMaxTime: boolean;
  walkBackExceeded: boolean;
  radialCapExceeded: boolean;
  radialCapLimitM: number | null;
  minMarginRatio: number | null;
  assumedTerrainData: boolean;
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
  if (params.radialCapExceeded) brokenConditions.push('distance');

  if (brokenConditions.length > 0) {
    const reasons: string[] = [];
    if (params.walkBackExceeded) reasons.push('walk-back survival time limit exceeded (broken: time)');
    if (params.exceededMaxTime) reasons.push('max mission duration exceeded (broken: time)');
    if (params.radialCapExceeded) {
      const capKm = params.radialCapLimitM !== null ? Number((params.radialCapLimitM / 1000).toFixed(2)) : 10;
      reasons.push(`radial standoff > ${capKm} km from base (broken: distance)`);
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
  if (params.assumedTerrainData) {
    cautionReasons.push('rock and thermal inertia data not available (assumed)');
  }

  if (cautionReasons.length > 0) {
    return { brokenConditions, decision: 'CAUTION', decisionReasons: cautionReasons };
  }
  return { brokenConditions, decision: 'GO', decisionReasons: ['all evaluated corridor checks passed'] };
}

let latestRouteId = 0;

async function route(msg: Extract<ToWorker, { type: 'route' }>): Promise<void> {
  if ((!slopeU8 && !slopeF32) || !hazard) return;
  if (msg.id !== latestRouteId) return;

  const roundTrip = msg.roundTrip === true;
  const stopWorkS = msg.stopWorkS ?? 0;
  const allowNoData = msg.allowNoData === true;
  const assumedTerrainData = msg.assumedTerrainData !== false;

  try {
    const willComputeLeg =
      (msg.mode === 'auto-landing' && landing !== null && msg.waypoints.length > 0) || msg.waypoints.length > 1;
    const elevPromise = willComputeLeg ? ensureElevationLoaded() : null;

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
    );

    if (!planned.ok) {
      elevPromise?.catch(() => {});
      post({ type: 'route-result', id: msg.id, ...planned });
      return;
    }

    if (elevPromise) await elevPromise;
    if (msg.id !== latestRouteId) return;

    // Re-ensure speed LUT matches msg.traverser & allowNoData when computing step times for turn-around
    prepareSpeeds(msg.traverser, allowNoData);

    const { full, stopCountsInFull } = planned;
    let noDataCells = 0;
    let cautionCells = 0;
    for (const cell of full) {
      if (isNoData(cell)) noDataCells++;
      if (hazard[cell] === HAZARD_CAUTION) cautionCells++;
    }

    const hasElevation = elevI16 !== null || elevF32 !== null;
    const path = Int32Array.from(full);
    const profileDist = new Float32Array(full.length);
    const profileSlope = new Float32Array(full.length);
    const profileElev = hasElevation && planned.legs.length > 0 ? new Float32Array(full.length) : null;
    const cumArrival = new Float64Array(full.length);
    const cumAfterStop = new Float64Array(full.length);
    const diagonal = cellM * Math.SQRT2;

    const maxTimeS =
      typeof msg.traverser.maxTimeS === 'number' && Number.isFinite(msg.traverser.maxTimeS) && msg.traverser.maxTimeS > 0
        ? msg.traverser.maxTimeS
        : null;
    const radialCapLimit_m =
      typeof msg.traverser.maxRadialDistM === 'number' &&
      Number.isFinite(msg.traverser.maxRadialDistM) &&
      msg.traverser.maxRadialDistM > 0
        ? msg.traverser.maxRadialDistM
        : null;
    const perStopS = Math.max(0, Number.isFinite(stopWorkS) ? stopWorkS : 0);

    const originCell = full.length > 0 ? full[0] : 0;
    const oCol = originCell % width;
    const oRow = (originCell - oCol) / width;
    const radialDist = new Float64Array(full.length);
    let maxRadialDist_m = 0;
    let radialCapExceeded = false;
    let radialCapCell: number | null = null;
    let radialCapDist_m: number | null = null;

    let along = 0;
    let cumTime = 0;
    let noDataM = 0;
    let cautionM = 0;

    for (let k = 0; k < full.length; k++) {
      const cell = full[k];
      if (k > 0) {
        const prev = full[k - 1];
        const isDiag = prev % width !== cell % width && Math.floor(prev / width) !== Math.floor(cell / width);
        const step = isDiag ? diagonal : cellM;
        along += step;
        cumTime += step / Math.min(cellSpeedAt(prev), cellSpeedAt(cell));

        const ndWeight = (isNoData(prev) ? 0.5 : 0) + (isNoData(cell) ? 0.5 : 0);
        const cWeight = (hazard[prev] === HAZARD_CAUTION ? 0.5 : 0) + (hazard[cell] === HAZARD_CAUTION ? 0.5 : 0);
        noDataM += step * ndWeight;
        cautionM += step * cWeight;
      }

      cumArrival[k] = cumTime;
      const stopsHere = stopCountsInFull.get(k);
      if (stopsHere) {
        cumTime += stopsHere * perStopS;
      }
      cumAfterStop[k] = cumTime;

      profileDist[k] = along;
      profileSlope[k] = isNoData(cell) ? NaN : slopeDegAt(cell);
      if (profileElev) {
        profileElev[k] = elevMetresAt(cell);
      }

      const cCol = cell % width;
      const cRow = (cell - cCol) / width;
      const rM = Math.hypot(cCol - oCol, cRow - oRow) * cellM;
      radialDist[k] = rM;
      if (rM > maxRadialDist_m) maxRadialDist_m = rM;
      if (!radialCapExceeded && radialCapLimit_m !== null && planned.legs.length > 0 && rM > radialCapLimit_m) {
        radialCapExceeded = true;
        const rIdx = k > 0 ? k - 1 : 0;
        radialCapCell = full[rIdx];
        radialCapDist_m = profileDist[rIdx];
      }
    }

    const exceededLimit = maxTimeS !== null && planned.legs.length > 0 && planned.time_s > maxTimeS;
    let turnAroundCell: number | null = null;
    let turnAroundDist_m: number | null = null;
    if (exceededLimit && full.length > 0) {
      for (let k = 0; k < full.length; k++) {
        if (cumAfterStop[k] > maxTimeS) {
          const tIdx = cumArrival[k] > maxTimeS && k > 0 ? k - 1 : k;
          turnAroundCell = full[tIdx];
          turnAroundDist_m = profileDist[tIdx];
          break;
        }
      }
    }

    const activeWalkBack =
      msg.walkBack && typeof msg.walkBack.limitS === 'number' && Number.isFinite(msg.walkBack.limitS) && msg.walkBack.limitS > 0
        ? msg.walkBack
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
      walkTimes = computeWalkBackTimes(full[0], full, activeWalkBack, allowNoData);
      let peakTotal = -1;
      for (let k = 0; k < full.length; k++) {
        const totalAfter = cumAfterStop[k] + walkTimes[k];
        if (totalAfter > peakTotal) {
          peakTotal = totalAfter;
          peakWalkBackDist_m = profileDist[k];
        }
        if (!walkBackExceeded && totalAfter > walkBackLimit_s) {
          walkBackExceeded = true;
          const wbIdx = cumArrival[k] + walkTimes[k] > walkBackLimit_s && k > 0 ? k - 1 : k;
          walkBackCell = full[wbIdx];
          walkBackDist_m = profileDist[wbIdx];
        }
      }
      maxWalkBackTotal_s = peakTotal >= 0 ? peakTotal : 0;
    }

    let minMarginRatio: number | null = null;
    if (planned.legs.length > 0) {
      if (walkBackLimit_s !== null && maxWalkBackTotal_s !== null) {
        minMarginRatio = (walkBackLimit_s - maxWalkBackTotal_s) / walkBackLimit_s;
      }
      if (maxTimeS !== null) {
        const missionMargin = (maxTimeS - planned.time_s) / maxTimeS;
        minMarginRatio = minMarginRatio === null ? missionMargin : Math.min(minMarginRatio, missionMargin);
      }
    }

    const { brokenConditions, decision, decisionReasons } = evaluateDecision({
      exceededMaxTime: exceededLimit,
      walkBackExceeded,
      radialCapExceeded,
      radialCapLimitM: radialCapLimit_m,
      minMarginRatio,
      assumedTerrainData,
      noDataCells,
      cautionCells,
      marginalLanding: planned.marginalLanding,
    });

    let unsafeMask: Uint8Array | null = null;
    if ((exceededLimit || walkBackExceeded || radialCapExceeded) && full.length > 0) {
      unsafeMask = new Uint8Array(full.length);
      for (let k = 0; k < full.length; k++) {
        const overTime = maxTimeS !== null && cumAfterStop[k] > maxTimeS;
        const overWalk = walkBackLimit_s !== null && walkTimes !== null && cumAfterStop[k] + walkTimes[k] > walkBackLimit_s;
        const overDist = radialCapLimit_m !== null && radialDist[k] > radialCapLimit_m;
        if (overTime || overWalk || overDist) unsafeMask[k] = 1;
      }
    }

    post(
      {
        type: 'route-result',
        id: msg.id,
        ok: true,
        mode: planned.effectiveMode,
        roundTrip,
        landingCandidates: planned.landingCandidates,
        activeLandingCell: planned.activeLandingCell,
        marginalLanding: planned.marginalLanding,
        path,
        legs: planned.legs,
        distance_m: planned.distance_m,
        time_s: planned.time_s,
        travelTime_s: planned.travelTime_s,
        stopTime_s: planned.stopTime_s,
        noDataCells,
        cautionCells,
        noDataM,
        cautionM,
        turnAroundCell,
        turnAroundDist_m,
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
        minMarginRatio,
        brokenConditions,
        decision,
        decisionReasons,
        unsafeMask,
        profileDist,
        profileSlope,
        profileElev,
      },
      [
        path.buffer,
        profileDist.buffer,
        profileSlope.buffer,
        ...(profileElev ? [profileElev.buffer] : []),
        ...(unsafeMask ? [unsafeMask.buffer] : []),
      ],
    );
  } finally {
    trimWindowBuffers();
  }
}

function compareTraversers(msg: Extract<ToWorker, { type: 'compare' }>): void {
  if ((!slopeU8 && !slopeF32) || !hazard) return;
  const haz = hazard;
  const assumedTerrainData = msg.assumedTerrainData !== false;
  try {
    const rows: TraverserComparisonRow[] = msg.entries.map((entry) => {
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

      let maxSlope = 0;
      let noDataCells = 0;
      let cautionCells = 0;
      const oCell = res.full.length > 0 ? res.full[0] : 0;
      const oCol = oCell % width;
      const oRow = (oCell - oCol) / width;
      const radialCapLimitM =
        typeof entry.traverser.maxRadialDistM === 'number' &&
        Number.isFinite(entry.traverser.maxRadialDistM) &&
        entry.traverser.maxRadialDistM > 0
          ? entry.traverser.maxRadialDistM
          : null;
      let radialCapExceeded = false;

      for (const cell of res.full) {
        if (isNoData(cell)) noDataCells++;
        else {
          const s = slopeDegAt(cell);
          if (s > maxSlope) maxSlope = s;
        }
        if (haz[cell] === HAZARD_CAUTION) cautionCells++;
        if (!radialCapExceeded && radialCapLimitM !== null && res.legs.length > 0) {
          const cc = cell % width;
          const cr = (cell - cc) / width;
          if (Math.hypot(cc - oCol, cr - oRow) * cellM > radialCapLimitM) {
            radialCapExceeded = true;
          }
        }
      }

      const maxTimeS =
        typeof entry.traverser.maxTimeS === 'number' && Number.isFinite(entry.traverser.maxTimeS) && entry.traverser.maxTimeS > 0
          ? entry.traverser.maxTimeS
          : null;
      const withinLimit = maxTimeS === null ? true : res.time_s <= maxTimeS;
      const exceededMaxTime = !withinLimit && res.legs.length > 0;

      let walkBackExceeded = false;
      let minMarginRatio: number | null =
        maxTimeS !== null && res.legs.length > 0 ? (maxTimeS - res.time_s) / maxTimeS : null;

      if (
        entry.walkBack &&
        typeof entry.walkBack.limitS === 'number' &&
        Number.isFinite(entry.walkBack.limitS) &&
        entry.walkBack.limitS > 0 &&
        res.legs.length > 0 &&
        res.full.length > 0
      ) {
        prepareSpeeds(entry.traverser, msg.allowNoData);
        const perStopS = Math.max(0, Number.isFinite(msg.stopWorkS) ? msg.stopWorkS : 0);
        const diagonal = cellM * Math.SQRT2;
        const cumAfter = new Float64Array(res.full.length);
        let t = 0;
        for (let k = 0; k < res.full.length; k++) {
          const cell = res.full[k];
          if (k > 0) {
            const prev = res.full[k - 1];
            const isDiag = prev % width !== cell % width && Math.floor(prev / width) !== Math.floor(cell / width);
            const step = isDiag ? diagonal : cellM;
            t += step / Math.min(cellSpeedAt(prev), cellSpeedAt(cell));
          }
          const stopsHere = res.stopCountsInFull.get(k);
          if (stopsHere) t += stopsHere * perStopS;
          cumAfter[k] = t;
        }
        const wbTimes = computeWalkBackTimes(res.full[0], res.full, entry.walkBack, msg.allowNoData, true);
        let peakWb = 0;
        for (let k = 0; k < res.full.length; k++) {
          const tot = cumAfter[k] + wbTimes[k];
          if (tot > peakWb) peakWb = tot;
          if (tot > entry.walkBack.limitS) {
            walkBackExceeded = true;
            break;
          }
        }
        const wbMargin = walkBackExceeded ? -1 : (entry.walkBack.limitS - peakWb) / entry.walkBack.limitS;
        minMarginRatio = minMarginRatio === null ? wbMargin : Math.min(minMarginRatio, wbMargin);
      }

      const { brokenConditions, decision, decisionReasons } = evaluateDecision({
        exceededMaxTime,
        walkBackExceeded,
        radialCapExceeded,
        radialCapLimitM,
        minMarginRatio,
        assumedTerrainData,
        noDataCells,
        cautionCells,
        marginalLanding: res.marginalLanding,
      });

      return {
        id: entry.id,
        name: entry.name,
        ok: true,
        distance_m: res.distance_m,
        time_s: res.time_s,
        travelTime_s: res.travelTime_s,
        stopTime_s: res.stopTime_s,
        maxSlope_deg: maxSlope,
        withinLimit,
        walkBackExceeded,
        radialCapExceeded,
        brokenConditions,
        decision,
        decisionReasons,
        marginalLanding: res.marginalLanding,
      };
    });
    post({ type: 'compare-result', id: msg.id, rows });
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
  });
}

let taskChain: Promise<void> = Promise.resolve();

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
    } catch (err: unknown) {
      post({ type: 'init-error', message: err instanceof Error ? err.message : String(err) });
    }
  });
};
