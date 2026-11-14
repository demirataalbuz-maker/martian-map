// AI-assisted code: written with Claude (Anthropic), reviewed by the team.
// Messages exchanged between the page and the routing Web Worker.

/** The part of a traverser's parameters the router needs. All values come from mobilite_parametreleri.json. */
export interface RouterTraverser {
  maxSlopeDeg: number;
  /** [slope in degrees, speed in m/s], sorted by slope. */
  speedTable: [number, number][];
}

export type ToWorker =
  | { type: 'init'; slopeUrl: string; hazardUrl: string; width: number; height: number; cellM: number }
  | { type: 'route'; id: number; waypoints: number[]; traverser: RouterTraverser };

export type BlockReason = 'forbidden' | 'too-steep';

export interface RouteLeg {
  distance_m: number;
  time_s: number;
}

export interface RouteSuccess {
  type: 'route-result';
  id: number;
  ok: true;
  /** Cell indices (row * width + col) from start to last stop. */
  path: Int32Array;
  legs: RouteLeg[];
  distance_m: number;
  time_s: number;
  /** Cells on the path with no slope/hazard data. */
  noDataCells: number;
  /** Cells on the path classed "caution". */
  cautionCells: number;
}

export type RouteFailure =
  | { type: 'route-result'; id: number; ok: false; reason: 'blocked-waypoint'; waypointIndex: number; why: BlockReason }
  | { type: 'route-result'; id: number; ok: false; reason: 'no-route'; legIndex: number };

export type FromWorker =
  | { type: 'ready'; noDataCells: number; totalCells: number }
  | { type: 'init-error'; message: string }
  | RouteSuccess
  | RouteFailure;
