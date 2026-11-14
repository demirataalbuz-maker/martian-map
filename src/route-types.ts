// AI-assisted code: written with Claude (Anthropic) and Antigravity (Google DeepMind), reviewed by the team.
// Messages exchanged between the page and the routing Web Worker.

/** The part of a traverser's parameters the router needs. All values come from mobilite_parametreleri.json. */
export interface RouterTraverser {
  maxSlopeDeg: number;
  /** [slope in degrees, speed in m/s], sorted by slope. */
  speedTable: [number, number][];
  /** Optional maximum excursion duration in seconds (derived from azami_sure_saat * 3600). */
  maxTimeS: number | null;
}

export interface LandingCandidate {
  /** Cell index (row * width + col) of the landing zone centre. */
  cell: number;
  /** 0 = suitable (inilebilir), 1 = marginal / borderline (sınırda). */
  tier: 0 | 1;
  /** Grid travel distance from this landing site to the primary target stop (metres). */
  distance_m: number;
  /** Estimated one-way travel time from this landing site to the primary target stop (seconds). */
  time_s: number;
}

export type ToWorker =
  | {
      type: 'init';
      slopeUrl: string;
      hazardUrl: string;
      elevationUrl: string;
      landingUrl: string;
      width: number;
      height: number;
      cellM: number;
      slopeType: 'uint8' | 'float32';
      slopeScale: number;
      slopeNoData: number;
      elevType: 'int16' | 'float32';
      elevBaseM: number;
      elevScaleM: number;
      elevNoData: number;
    }
  | {
      type: 'route';
      id: number;
      mode: 'manual' | 'auto-landing';
      /**
       * In 'manual' mode: [start, stop1, stop2, ...].
       * In 'auto-landing' mode: [targetStop1, stop2, ...] (worker prepends the chosen landing site).
       */
      waypoints: number[];
      /** Optional user-picked landing site among the suggested candidates in 'auto-landing' mode. */
      chosenLandingCell?: number | null;
      /** Minimum separation in metres between primary and backup landing centres (from inis_araci.guvenli_alan_capi_m). */
      minSeparationM: number;
      /** Optional cap on one-way travel time (s) from landing site to Stop 1 (e.g. halved in round-trip mode). */
      maxLandingTimeS?: number | null;
      traverser: RouterTraverser;
    };

export type BlockReason = 'forbidden' | 'too-steep';

export interface RouteLeg {
  distance_m: number;
  time_s: number;
}

export interface RouteSuccess {
  type: 'route-result';
  id: number;
  ok: true;
  mode: 'manual' | 'auto-landing';
  /** Suggested landing sites (primary + separated backups) when mode === 'auto-landing'. */
  landingCandidates: LandingCandidate[];
  /** Active landing cell when mode === 'auto-landing', else null. */
  activeLandingCell: number | null;
  /** True when no tier-0 landing site was in range so tier-1 (marginal) sites were used. */
  marginalLanding: boolean;
  /** Cell indices (row * width + col) from start/landing to last stop. */
  path: Int32Array;
  legs: RouteLeg[];
  distance_m: number;
  time_s: number;
  /** Cells on the path with no slope/hazard data. */
  noDataCells: number;
  /** Cells on the path classed "caution". */
  cautionCells: number;
  /** Per path cell: distance from the start in metres (grid-based). */
  profileDist: Float32Array;
  /** Per path cell: slope in degrees, NaN where there is no data. */
  profileSlope: Float32Array;
  /** Per path cell: elevation in metres, NaN where there is no data; null when no elevation grid exists. */
  profileElev: Float32Array | null;
}

export type RouteFailure =
  | { type: 'route-result'; id: number; ok: false; reason: 'blocked-waypoint'; waypointIndex: number; why: BlockReason }
  | { type: 'route-result'; id: number; ok: false; reason: 'no-route'; legIndex: number }
  | { type: 'route-result'; id: number; ok: false; reason: 'no-landing'; withinRangeChecked: boolean };

export type FromWorker =
  | { type: 'ready'; noDataCells: number; totalCells: number; hasElevation: boolean; hasLanding: boolean }
  | { type: 'init-error'; message: string }
  | RouteSuccess
  | RouteFailure;
