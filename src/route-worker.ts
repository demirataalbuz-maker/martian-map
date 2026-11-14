// AI-assisted code: written with Claude (Anthropic), reviewed by the team.
//
// Routing Web Worker: least-TIME path on the cost grid with A*.
//
// Cost model (every number comes from the data files, none is hard-coded):
//   - step length  = hucre_m for an orthogonal step, hucre_m * sqrt(2) for a diagonal one
//   - step time    = step length / speed, speed = slower of the two cells
//   - cell speed   = speed table interpolated at the cell's slope
//   - impassable   = hazard class 2 (forbidden), or slope above the traverser's limit
//   - no data / caution cells are passable, but only at the SLOWEST speed in the
//     traverser's table (a conservative assumption), and are reported back.

/// <reference lib="webworker" />

import type { BlockReason, FromWorker, RouteLeg, RouterTraverser, ToWorker } from './route-types';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (message: FromWorker, transfer: Transferable[] = []) => ctx.postMessage(message, transfer);

const SLOPE_NODATA = -9999;
const HAZARD_CAUTION = 1;
const HAZARD_FORBIDDEN = 2;
const HAZARD_NODATA = 255;

let width = 0;
let height = 0;
let cellM = 0;
let slope: Float32Array | null = null;
let hazard: Uint8Array | null = null;

// Per-traverser cache
let speedKey = '';
let cellSpeed = new Float32Array(0); // m/s, 0 = impassable
let maxSpeed = 0;

// Search state, reused between legs
let gScore = new Float64Array(0);
let cameFrom = new Int32Array(0);
let closed = new Uint8Array(0);

async function fetchBinary(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url} (HTTP ${res.status})`);
  return res.arrayBuffer();
}

async function init(msg: Extract<ToWorker, { type: 'init' }>): Promise<void> {
  width = msg.width;
  height = msg.height;
  cellM = msg.cellM;
  const cells = width * height;
  const [slopeBuf, hazardBuf] = await Promise.all([fetchBinary(msg.slopeUrl), fetchBinary(msg.hazardUrl)]);
  if (slopeBuf.byteLength !== cells * 4) {
    throw new Error(`egim.bin is ${slopeBuf.byteLength} bytes, expected ${cells * 4} (${width} x ${height} Float32)`);
  }
  if (hazardBuf.byteLength !== cells) {
    throw new Error(`tehlike.bin is ${hazardBuf.byteLength} bytes, expected ${cells} (${width} x ${height} Uint8)`);
  }
  slope = new Float32Array(slopeBuf);
  hazard = new Uint8Array(hazardBuf);
  gScore = new Float64Array(cells);
  cameFrom = new Int32Array(cells);
  closed = new Uint8Array(cells);
  let noData = 0;
  for (let i = 0; i < cells; i++) if (isNoData(i)) noData++;
  post({ type: 'ready', noDataCells: noData, totalCells: cells });
}

function isNoData(i: number): boolean {
  return hazard![i] === HAZARD_NODATA || slope![i] === SLOPE_NODATA || Number.isNaN(slope![i]);
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
  const key = JSON.stringify(traverser);
  if (key === speedKey) return;
  const table = traverser.speedTable;
  const slowest = Math.min(...table.map((entry) => entry[1]));
  maxSpeed = Math.max(...table.map((entry) => entry[1]));
  const cells = width * height;
  if (cellSpeed.length !== cells) cellSpeed = new Float32Array(cells);
  for (let i = 0; i < cells; i++) {
    const h = hazard![i];
    if (h === HAZARD_FORBIDDEN) cellSpeed[i] = 0;
    else if (isNoData(i) || h === HAZARD_CAUTION) {
      // Unknown slope still must not exceed the limit where it IS known.
      const known = slope![i] !== SLOPE_NODATA && !Number.isNaN(slope![i]);
      cellSpeed[i] = known && slope![i] > traverser.maxSlopeDeg ? 0 : slowest;
    } else if (slope![i] > traverser.maxSlopeDeg) cellSpeed[i] = 0;
    else cellSpeed[i] = speedAtSlope(table, slope![i]);
  }
  speedKey = key;
}

function blockReason(i: number): BlockReason | null {
  if (cellSpeed[i] > 0) return null;
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

// 8-connected neighbourhood: [dCol, dRow]
const NEIGHBOURS: [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

/** A* from `start` to `goal`. Returns cell indices start..goal, or null when unreachable. */
function findPath(start: number, goal: number): number[] | null {
  if (start === goal) return [start];
  gScore.fill(Infinity);
  cameFrom.fill(-1);
  closed.fill(0);
  const goalCol = goal % width;
  const goalRow = Math.floor(goal / width);
  const diagonal = cellM * Math.SQRT2;
  // Admissible heuristic: octile distance covered at the fastest possible speed.
  const heuristic = (col: number, row: number): number => {
    const dc = Math.abs(col - goalCol);
    const dr = Math.abs(row - goalRow);
    return (cellM * Math.abs(dc - dr) + diagonal * Math.min(dc, dr)) / maxSpeed;
  };

  const open = new MinHeap();
  gScore[start] = 0;
  open.push(heuristic(start % width, Math.floor(start / width)), start);

  while (open.size > 0) {
    const current = open.pop();
    if (closed[current]) continue;
    if (current === goal) {
      const path = [goal];
      for (let c = cameFrom[goal]; c !== -1; c = cameFrom[c]) path.push(c);
      return path.reverse();
    }
    closed[current] = 1;
    const col = current % width;
    const row = (current - col) / width;
    const speedHere = cellSpeed[current];
    for (const [dc, dr] of NEIGHBOURS) {
      const nc = col + dc;
      const nr = row + dr;
      if (nc < 0 || nr < 0 || nc >= width || nr >= height) continue;
      const next = nr * width + nc;
      if (closed[next] || cellSpeed[next] === 0) continue;
      const isDiagonal = dc !== 0 && dr !== 0;
      // Never squeeze diagonally between two blocked cells or cut a blocked corner.
      if (isDiagonal && (cellSpeed[row * width + nc] === 0 || cellSpeed[nr * width + col] === 0)) continue;
      const stepTime = (isDiagonal ? diagonal : cellM) / Math.min(speedHere, cellSpeed[next]);
      const tentative = gScore[current] + stepTime;
      if (tentative < gScore[next]) {
        gScore[next] = tentative;
        cameFrom[next] = current;
        open.push(tentative + heuristic(nc, nr), next);
      }
    }
  }
  return null;
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
    time += step / Math.min(cellSpeed[a], cellSpeed[b]);
  }
  return { distance_m: distance, time_s: time };
}

function route(msg: Extract<ToWorker, { type: 'route' }>): void {
  if (!slope || !hazard) return;
  prepareSpeeds(msg.traverser);

  for (let w = 0; w < msg.waypoints.length; w++) {
    const why = blockReason(msg.waypoints[w]);
    if (why) {
      post({ type: 'route-result', id: msg.id, ok: false, reason: 'blocked-waypoint', waypointIndex: w, why });
      return;
    }
  }

  const full: number[] = msg.waypoints.length > 0 ? [msg.waypoints[0]] : [];
  const legs: RouteLeg[] = [];
  for (let leg = 0; leg + 1 < msg.waypoints.length; leg++) {
    const path = findPath(msg.waypoints[leg], msg.waypoints[leg + 1]);
    if (!path) {
      post({ type: 'route-result', id: msg.id, ok: false, reason: 'no-route', legIndex: leg });
      return;
    }
    legs.push(measure(path));
    for (let k = 1; k < path.length; k++) full.push(path[k]);
  }

  let noDataCells = 0;
  let cautionCells = 0;
  for (const cell of full) {
    if (isNoData(cell)) noDataCells++;
    else if (hazard[cell] === HAZARD_CAUTION) cautionCells++;
  }
  const path = Int32Array.from(full);
  post(
    {
      type: 'route-result',
      id: msg.id,
      ok: true,
      path,
      legs,
      distance_m: legs.reduce((sum, l) => sum + l.distance_m, 0),
      time_s: legs.reduce((sum, l) => sum + l.time_s, 0),
      noDataCells,
      cautionCells,
    },
    [path.buffer],
  );
}

ctx.onmessage = (event: MessageEvent<ToWorker>) => {
  const msg = event.data;
  if (msg.type === 'init') {
    init(msg).catch((err: unknown) => post({ type: 'init-error', message: err instanceof Error ? err.message : String(err) }));
  } else {
    route(msg);
  }
};
