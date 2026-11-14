// AI-assisted code: written with Claude (Anthropic) and Antigravity (Google DeepMind), reviewed by the team.
// Messages exchanged between the page and the routing Web Worker.

export type SafetyDecision = 'GO' | 'CAUTION' | 'NO-GO';
export type BrokenCondition = 'time' | 'distance';

/** The part of a traverser's parameters the router needs. All values come from mobilite_parametreleri.json. */
export interface RouterTraverser {
  maxSlopeDeg: number;
  /** [slope in degrees, speed in m/s], sorted by slope. */
  speedTable: [number, number][];
  /** Optional maximum excursion duration in seconds (derived from azami_sure_saat * 3600). */
  maxTimeS: number | null;
  /** Optional straight-line radial standoff cap from base/landing in metres (derived from uzaklik_tavani_m). */
  maxRadialDistM?: number | null;
}

/** Apollo walk-back survival rule parameters (elapsed time + walking return time <= limitS). */
export interface WalkBackSpec {
  traverser: RouterTraverser;
  limitS: number;
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

export interface TraverserComparisonEntry {
  id: string;
  name: string;
  traverser: RouterTraverser;
  walkBack?: WalkBackSpec | null;
}

export interface TraverserComparisonRow {
  id: string;
  name: string;
  ok: boolean;
  distance_m?: number;
  time_s?: number;
  travelTime_s?: number;
  stopTime_s?: number;
  maxSlope_deg?: number;
  withinLimit?: boolean;
  walkBackExceeded?: boolean;
  radialCapExceeded?: boolean;
  brokenConditions?: BrokenCondition[];
  decision?: SafetyDecision;
  decisionReasons?: string[];
  marginalLanding?: boolean;
  failReason?: string;
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
      /** Optional cap on one-way travel time (s) from landing site to Stop 1. */
      maxLandingTimeS?: number | null;
      /** When true, appends a return leg from the final stop back to the landing site / start. */
      roundTrip?: boolean;
      /** User-selected work duration per science stop in seconds (default 0). */
      stopWorkS?: number;
      /** When true, allows crossing unmapped (no-data = 255) cells at slowest speed; default false (blocked). */
      allowNoData?: boolean;
      /** True when rock abundance or thermal inertia layers are absent (assumed), triggering CAUTION when otherwise safe. */
      assumedTerrainData?: boolean;
      traverser: RouterTraverser;
      /** Optional Apollo walk-back survival check (used for crewed rover). */
      walkBack?: WalkBackSpec | null;
    }
  | {
      type: 'probe';
      cell: number;
    }
  | {
      type: 'compare';
      id: number;
      mode: 'manual' | 'auto-landing';
      waypoints: number[];
      minSeparationM: number;
      roundTrip: boolean;
      stopWorkS: number;
      allowNoData: boolean;
      assumedTerrainData?: boolean;
      entries: TraverserComparisonEntry[];
    };

export type BlockReason = 'forbidden' | 'too-steep' | 'no-data';

export interface RouteLeg {
  distance_m: number;
  time_s: number;
  isReturn?: boolean;
}

export interface RouteSuccess {
  type: 'route-result';
  id: number;
  ok: true;
  mode: 'manual' | 'auto-landing';
  roundTrip: boolean;
  /** Suggested landing sites (primary + separated backups) when mode === 'auto-landing'. */
  landingCandidates: LandingCandidate[];
  /** Active landing cell when mode === 'auto-landing', else null. */
  activeLandingCell: number | null;
  /** True when no tier-0 landing site was in range so tier-1 (marginal) sites were used. */
  marginalLanding: boolean;
  /** Cell indices (row * width + col) from start/landing through all stops (and back if roundTrip). */
  path: Int32Array;
  legs: RouteLeg[];
  distance_m: number;
  /** Total mission duration in seconds (travelTime_s + stopTime_s). */
  time_s: number;
  travelTime_s: number;
  stopTime_s: number;
  /** Cells on the path with no slope/hazard data. */
  noDataCells: number;
  /** Cells on the path classed "caution". */
  cautionCells: number;
  /** Exact step-weighted distance (including diagonal ×√2) across no-data cells. */
  noDataM: number;
  /** Exact step-weighted distance (including diagonal ×√2) across caution cells. */
  cautionM: number;
  /** Last cell along the path before cumulative mission time exceeds maxTimeS (null when within limit). */
  turnAroundCell: number | null;
  turnAroundDist_m: number | null;
  /** Apollo walk-back survival check results (non-null when walk-back applies, e.g. crewed rover). */
  walkBackLimit_s: number | null;
  maxWalkBackTotal_s: number | null;
  peakWalkBackDist_m: number | null;
  walkBackExceeded: boolean;
  walkBackCell: number | null;
  walkBackDist_m: number | null;
  /** Straight-line Euclidean Mars grid distance from base/landing (metres) and optional radial cap check. */
  maxRadialDist_m: number;
  radialCapLimit_m: number | null;
  radialCapExceeded: boolean;
  radialCapCell: number | null;
  radialCapDist_m: number | null;
  /** Lowest remaining time safety margin ratio across all points (e.g. 0.08 = 8%), or null when no time cap applies. */
  minMarginRatio: number | null;
  /** Broken safety condition(s) along the route ('time' and/or 'distance'), empty when none broke. */
  brokenConditions: BrokenCondition[];
  /** Corridor suitability decision: NO-GO if any red unsafe segment; CAUTION if margin < 10% or assumed terrain data; else GO. */
  decision: SafetyDecision;
  decisionReasons: string[];
  /** Per path cell: 1 where mission time, walk-back, or radial distance cap is exceeded, 0 where safe; null when wholly safe. */
  unsafeMask: Uint8Array | null;
  /** Per path cell: distance from the start in metres (grid-based). */
  profileDist: Float32Array;
  /** Per path cell: slope in degrees, NaN where there is no data. */
  profileSlope: Float32Array;
  /** Per path cell: elevation in metres, NaN where there is no data; null when no elevation grid exists. */
  profileElev: Float32Array | null;
}

export type RouteFailure =
  | { type: 'route-result'; id: number; ok: false; reason: 'blocked-waypoint'; waypointIndex: number; why: BlockReason }
  | { type: 'route-result'; id: number; ok: false; reason: 'no-route'; legIndex: number; isReturnLeg?: boolean }
  | { type: 'route-result'; id: number; ok: false; reason: 'no-landing'; withinRangeChecked: boolean };

export type FromWorker =
  | {
      type: 'load-progress';
      phase: 'terrain' | 'elevation';
      loadedBytes: number;
      totalBytes: number;
      percent: number;
    }
  | { type: 'ready'; noDataCells: number; totalCells: number; hasElevation: boolean; hasLanding: boolean }
  | { type: 'init-error'; message: string }
  | {
      type: 'probe-result';
      cell: number;
      slopeDeg: number | null;
      slopeAtOrAboveMaxByte: boolean;
      hazardClass: number;
      landingClass: number | null;
      elevM: number | null;
      elevLoaded: boolean;
    }
  | { type: 'compare-result'; id: number; rows: TraverserComparisonRow[] }
  | RouteSuccess
  | RouteFailure;
