// AI-assisted code: written with Claude (Anthropic) and Antigravity (Google DeepMind), reviewed by the team.
//
// Routing Web Worker:
//   1) Compact binary cost grids: Uint8 ceiling-quantized slope + little-endian Int16 elevation
//      (with Float32 fallback for older datasets), Uint8 hazard & landing grids.
//   2) 256-entry per-traverser speed lookup table (zero full-grid cellSpeed allocation).
//   3) Windowed 8-connected A* with border-touch re-expansion, plus windowed Reverse-Dijkstra
//      landing recommender with range clipping and progressive boundary-verified expansion.

/// <reference lib="webworker" />

import type { BlockReason, FromWorker, LandingCandidate, RouteLeg, RouterTraverser, ToWorker } from './route-types';

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

// 256-entry speed lookup tables (~2 KB total; replaces the full-grid cellSpeed array)
let speedKey = '';
const speedFreeLut = new Float32Array(256);
const speedCautionLut = new Float32Array(256);
let slowestSpeed = 0;
let maxSpeed = 0;
let currentMaxSlopeDeg = 0;
let currentSpeedTable: [number, number][] = [];

// Window-scoped stamp search state (~11 B per window cell: 8 B Float64 gScore + 1 B parentDir + 2 B Uint16 stamp)
// For a run with base `openMark = searchId`:
//   stamp[i] === openMark     -> discovered (open), gScore[i] & parentDir[i] are valid
//   stamp[i] === openMark + 1 -> expanded (closed), gScore[i] & parentDir[i] are valid
//   otherwise                 -> untouched in this search
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

async function fetchRequiredBinary(url: string, expectedBytes: number, label: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${label} (HTTP ${res.status})`);
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('text/html')) throw new Error(`Could not load ${label} (received HTML instead of binary data)`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength !== expectedBytes) {
    throw new Error(`${label} is ${buf.byteLength} bytes, expected ${expectedBytes}`);
  }
  return buf;
}

async function fetchOptionalBinary(url: string, expectedBytes: number, label: string): Promise<ArrayBuffer | null> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    return null;
  }
  if (res.status === 404 || !res.ok) return null;
  const ct = res.headers.get('content-type') ?? '';
  // Static hosts sometimes serve index.html with HTTP 200 for missing files.
  if (ct.includes('text/html')) return null;
  const buf = await res.arrayBuffer();
  if (buf.byteLength !== expectedBytes) {
    throw new Error(`${label} is ${buf.byteLength} bytes, expected ${expectedBytes}`);
  }
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

  // yukseklik.bin is intentionally NOT downloaded at startup; it is fetched lazily
  // on the first route request so initial page load avoids pulling ~46 MB extra.
  const [slopeBuf, hazardBuf, landingBuf] = await Promise.all([
    fetchRequiredBinary(msg.slopeUrl, slopeBytes, `egim.bin (${width} x ${height} ${slopeType})`),
    fetchRequiredBinary(msg.hazardUrl, cells, `tehlike.bin (${width} x ${height} uint8)`),
    fetchOptionalBinary(msg.landingUrl, cells, `inis.bin (${width} x ${height} uint8)`),
  ]);

  if (slopeType === 'uint8') {
    slopeU8 = new Uint8Array(slopeBuf);
    slopeF32 = null;
  } else {
    slopeF32 = decodeFloat32LE(slopeBuf);
    slopeU8 = null;
  }

  hazard = new Uint8Array(hazardBuf);
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
    elevLoadPromise = fetchOptionalBinary(
      elevationUrl,
      elevBytes,
      `yukseklik.bin (${width} x ${height} ${elevType})`,
    )
      .then((elevBuf) => {
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

function prepareSpeeds(traverser: RouterTraverser): void {
  const key = JSON.stringify({
    maxSlopeDeg: traverser.maxSlopeDeg,
    speedTable: traverser.speedTable,
    slopeType,
    slopeScale,
    slopeNoData,
  });
  if (key === speedKey) return;
  const table = traverser.speedTable;
  slowestSpeed = Math.min(...table.map((entry) => entry[1]));
  maxSpeed = Math.max(...table.map((entry) => entry[1]));
  currentMaxSlopeDeg = traverser.maxSlopeDeg;
  currentSpeedTable = table;

  if (slopeType === 'uint8') {
    for (let b = 0; b < 256; b++) {
      if (b === slopeNoData) {
        speedFreeLut[b] = slowestSpeed;
        speedCautionLut[b] = slowestSpeed;
      } else {
        const deg = b * slopeScale;
        if (deg > currentMaxSlopeDeg) {
          speedFreeLut[b] = 0;
          speedCautionLut[b] = 0;
        } else {
          speedFreeLut[b] = speedAtSlope(table, deg);
          speedCautionLut[b] = slowestSpeed;
        }
      }
    }
  }
  speedKey = key;
}

function cellSpeedAt(i: number): number {
  const h = hazard![i];
  if (slopeU8) {
    if (h === HAZARD_FREE) return speedFreeLut[slopeU8[i]];
    if (h === HAZARD_FORBIDDEN) return 0;
    return speedCautionLut[slopeU8[i]];
  }
  if (h === HAZARD_FORBIDDEN) return 0;
  const deg = slopeDegAt(i);
  const noSlope = Number.isNaN(deg);
  if (!noSlope && deg > currentMaxSlopeDeg) return 0;
  if (noSlope || h === HAZARD_CAUTION || h === HAZARD_NODATA) return slowestSpeed;
  return speedAtSlope(currentSpeedTable, deg);
}

function blockReason(i: number): BlockReason | null {
  if (cellSpeedAt(i) > 0) return null;
  return hazard![i] === HAZARD_FORBIDDEN ? 'forbidden' : 'too-steep';
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
 * if no path is found or the found path touches an unclipped window boundary
 * (indicating a potentially faster detour outside the window), doubles the
 * window margin and retries up to the full grid.
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
  /** Path from this landing cell to the primary target stop. */
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

/**
 * Windowed Reverse Dijkstra outward from `targetCell`. Clipped to the traverser's
 * maximum travel range (and grid bounds), starting with a compact window and
 * expanding only if the search reaches an unclipped window boundary before
 * provably locking 3 separated class-0 landing sites.
 */
function suggestLandingSites(
  targetCell: number,
  maxTimeS: number,
  minSeparationM: number,
): { candidates: DiscoveredLanding[]; marginal: boolean } | null {
  if (!landing) return null;
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

let latestRouteId = 0;

async function route(msg: Extract<ToWorker, { type: 'route' }>): Promise<void> {
  if ((!slopeU8 && !slopeF32) || !hazard) return;
  if (msg.id !== latestRouteId) return;
  prepareSpeeds(msg.traverser);

  try {
    for (let w = 0; w < msg.waypoints.length; w++) {
      const why = blockReason(msg.waypoints[w]);
      if (why) {
        post({ type: 'route-result', id: msg.id, ok: false, reason: 'blocked-waypoint', waypointIndex: w, why });
        return;
      }
    }

    const willComputeLeg =
      (msg.mode === 'auto-landing' && landing !== null && msg.waypoints.length > 0) || msg.waypoints.length > 1;
    // Start lazy download of yukseklik.bin concurrently with pathfinding on the first real route request.
    const elevPromise = willComputeLeg ? ensureElevationLoaded() : null;

    let landingCandidates: LandingCandidate[] = [];
    let activeLandingCell: number | null = null;
    let marginalLanding = false;
    const full: number[] = [];
    const legs: RouteLeg[] = [];

    if (msg.mode === 'auto-landing' && landing && msg.waypoints.length > 0) {
      const rawLimit = msg.maxLandingTimeS !== undefined ? msg.maxLandingTimeS : msg.traverser.maxTimeS;
      const maxTimeS = typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : Infinity;
      const found = suggestLandingSites(msg.waypoints[0], maxTimeS, msg.minSeparationM);
      if (!found) {
        elevPromise?.catch(() => {});
        post({
          type: 'route-result',
          id: msg.id,
          ok: false,
          reason: 'no-landing',
          withinRangeChecked: Number.isFinite(maxTimeS),
        });
        return;
      }

      marginalLanding = found.marginal;
      landingCandidates = found.candidates.map(({ cell, tier, distance_m, time_s }) => ({ cell, tier, distance_m, time_s }));

      const picked =
        (msg.chosenLandingCell != null ? found.candidates.find((c) => c.cell === msg.chosenLandingCell) : undefined) ??
        found.candidates[0];
      activeLandingCell = picked.cell;

      full.push(...picked.pathToTarget);
      legs.push({ distance_m: picked.distance_m, time_s: picked.time_s });

      for (let leg = 0; leg + 1 < msg.waypoints.length; leg++) {
        const path = findPath(msg.waypoints[leg], msg.waypoints[leg + 1]);
        if (!path) {
          elevPromise?.catch(() => {});
          post({ type: 'route-result', id: msg.id, ok: false, reason: 'no-route', legIndex: leg + 1 });
          return;
        }
        legs.push(measure(path));
        for (let k = 1; k < path.length; k++) full.push(path[k]);
      }
    } else {
      if (msg.waypoints.length > 0) full.push(msg.waypoints[0]);
      for (let leg = 0; leg + 1 < msg.waypoints.length; leg++) {
        const path = findPath(msg.waypoints[leg], msg.waypoints[leg + 1]);
        if (!path) {
          elevPromise?.catch(() => {});
          post({ type: 'route-result', id: msg.id, ok: false, reason: 'no-route', legIndex: leg });
          return;
        }
        legs.push(measure(path));
        for (let k = 1; k < path.length; k++) full.push(path[k]);
      }
    }

    if (elevPromise) await elevPromise;
    if (msg.id !== latestRouteId) return;

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
    const profileElev = hasElevation && legs.length > 0 ? new Float32Array(full.length) : null;
    const diagonal = cellM * Math.SQRT2;
    let along = 0;
    for (let k = 0; k < full.length; k++) {
      const cell = full[k];
      if (k > 0) {
        const prev = full[k - 1];
        const isDiagonal = prev % width !== cell % width && Math.floor(prev / width) !== Math.floor(cell / width);
        along += isDiagonal ? diagonal : cellM;
      }
      profileDist[k] = along;
      profileSlope[k] = isNoData(cell) ? NaN : slopeDegAt(cell);
      if (profileElev) {
        profileElev[k] = elevMetresAt(cell);
      }
    }

    post(
      {
        type: 'route-result',
        id: msg.id,
        ok: true,
        mode: msg.mode === 'auto-landing' && landing ? 'auto-landing' : 'manual',
        landingCandidates,
        activeLandingCell,
        marginalLanding,
        path,
        legs,
        distance_m: legs.reduce((sum, l) => sum + l.distance_m, 0),
        time_s: legs.reduce((sum, l) => sum + l.time_s, 0),
        noDataCells,
        cautionCells,
        profileDist,
        profileSlope,
        profileElev,
      },
      [path.buffer, profileDist.buffer, profileSlope.buffer, ...(profileElev ? [profileElev.buffer] : [])],
    );
  } finally {
    trimWindowBuffers();
  }
}

let taskChain: Promise<void> = Promise.resolve();

ctx.onmessage = (event: MessageEvent<ToWorker>) => {
  const msg = event.data;
  if (msg.type === 'route') latestRouteId = msg.id;
  taskChain = taskChain.then(async () => {
    try {
      if (msg.type === 'init') await init(msg);
      else await route(msg);
    } catch (err: unknown) {
      post({ type: 'init-error', message: err instanceof Error ? err.message : String(err) });
    }
  });
};
