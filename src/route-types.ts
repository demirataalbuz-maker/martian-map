// AI-assisted code: written with Claude (Anthropic) and Antigravity (Google DeepMind), reviewed by the team.
// Messages exchanged between the page and the routing Web Worker.

export type SafetyDecision = 'GO' | 'CAUTION' | 'NO-GO';
export type BrokenCondition = 'time' | 'distance' | 'energy';

/** Boundary marker along a multi-stint route (end of 1 EVA or 1 sol -> STOP / DUR). */
export interface StintStop {
  cell: number;
  pathIndex: number;
  dist_m: number;
  time_s: number;
  /** 1-based index of the stint starting right after this STOP (2 = EVA 2 / Sol 2). */
  nextStint: number;
}

export interface RouterEnergyProfile {
  profil_adi_en: string;
  kutle_kg: number;
  yercekimi_m_s2: number;
  yuvarlanma_direnci: number;
  verim: number;
  baz_guc_w: number;
  enerji_kapasite_wh: number;
  enerji_kalan_wh: number;
  rezerv_orani: number;
}

export interface RouterGroundModel {
  tiLooseThreshold: number;
  tiVeryLooseThreshold: number;
  looseSpeedFactor: number;
  veryLooseSpeedFactor: number;
  hardRollingResistance: number;
  looseRollingResistance: number;
  veryLooseRollingResistance: number;
}

/** The part of a traverser's parameters the router needs. All values come from mobilite_parametreleri.json. */
export interface RouterTraverser {
  maxSlopeDeg: number;
  /** [slope in degrees, speed in m/s], sorted by slope (used for climb/uphill and unsigned fallback). */
  speedTable: [number, number][];
  /** Optional downhill speed table [slope in degrees, speed in m/s] along negative elevation grade. */
  downhillSpeedTable?: [number, number][];
  /** Optional maximum excursion duration in seconds (derived from azami_sure_saat * 3600). */
  maxTimeS: number | null;
  /** Optional straight-line radial standoff cap from base/landing in metres (derived from uzaklik_tavani_m). */
  maxRadialDistM?: number | null;
  /** Optional single-stint (1 EVA or 1 sol) distance budget in metres (sefer_butcesi). */
  stintDistM?: number | null;
  /** Optional single-stint time budget in seconds. */
  stintTimeS?: number | null;
  /** Optional cumulative total distance cap in metres (e.g. rover 45.22 km). */
  totalDistCapM?: number | null;
  /** Optional vehicle battery/drive energy profile for reserve-floor GO/NO-GO checks. */
  energyProfile?: RouterEnergyProfile | null;
  /** Optional ground/thermal-inertia speed and rolling-resistance modifiers (when TI grid is loaded). */
  groundModel?: RouterGroundModel | null;
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
  energyExceeded?: boolean;
  brokenConditions?: BrokenCondition[];
  decision?: SafetyDecision;
  decisionReasons?: string[];
  marginalLanding?: boolean;
  totalStints?: number;
  failReason?: string;
}

export type ToWorker =
  | {
      type: 'init';
      scenarioKey?: string;
      slopeUrl: string;
      hazardUrl: string;
      elevationUrl: string;
      thermalInertiaUrl?: string;
      landingUrl: string;
      fallbackLandingUrl?: string;
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
      /** When true (and 2..7 science stops), solves exact shortest-duration stop visit order. */
      optimizeStops?: boolean;
      /** Minimum separation in metres between primary and backup landing centres (from inis_araci.guvenli_alan_capi_m). */
      minSeparationM: number;
      /** Minimum distance in metres between target Stop 1 and the selected landing zone (e.g. 1000 m plume keep-out). */
      minTargetStandoffM?: number;
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
      /** True when thermal inertia hazard input IS included in tehlike.bin (e.g. Crewed 20 m CTX), false when omitted. */
      hasThermalInertiaData?: boolean;
      /** True when sub-grid rock abundance data is evaluated (false at 5 m / 20 m scale). */
      hasRockData?: boolean;
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
      optimizeStops?: boolean;
      minSeparationM: number;
      minTargetStandoffM?: number;
      roundTrip: boolean;
      stopWorkS: number;
      allowNoData: boolean;
      assumedTerrainData?: boolean;
      hasThermalInertiaData?: boolean;
      hasRockData?: boolean;
      entries: TraverserComparisonEntry[];
    }
  | {
      type: 'escape';
      id: number;
      fromCell: number;
      toCell: number;
      allowNoData: boolean;
      walker: RouterTraverser;
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
  /** Smoothed continuous grid column coordinates corresponding 1-to-1 with path. */
  pathCols?: Float32Array;
  /** Smoothed continuous grid row coordinates corresponding 1-to-1 with path. */
  pathRows?: Float32Array;
  legs: RouteLeg[];
  distance_m: number;
  /** Total mission duration in seconds (travelTime_s + stopTime_s). */
  time_s: number;
  travelTime_s: number;
  stopTime_s: number;
  /** Optional stop-order optimization metadata (TSP over science stops). */
  optimizeStopsEnabled: boolean;
  stopOrder: number[];
  stopOrderChanged: boolean;
  stopOrderCapped: boolean;
  stopOrderCap: number;
  unoptimizedTime_s: number | null;
  /** Cells on the path with no slope/hazard data. */
  noDataCells: number;
  /** Cells on the path classed "caution". */
  cautionCells: number;
  /** Exact step-weighted distance across no-data cells. */
  noDataM: number;
  /** Exact step-weighted distance across caution cells. */
  cautionM: number;
  /** Distance across loose regolith / eolian sand (TI < 350 or Aeb caution). */
  looseGroundM: number;
  /** True when the active scenario loaded a real thermal-inertia raster (20 m CTX). */
  hasThermalInertiaGrid: boolean;
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
  /** Vehicle battery & ground-resistance energy balance (when traverser defines energyProfile). */
  energyUsable_wh: number | null;
  energyReserve_wh: number | null;
  energyUsed_wh: number | null;
  energyDrive_wh: number | null;
  energyBase_wh: number | null;
  energyRemaining_wh: number | null;
  energyExceeded: boolean;
  energyCell: number | null;
  energyDist_m: number | null;
  /** Lowest remaining time safety margin ratio across all points (e.g. 0.08 = 8%), or null when no time cap applies. */
  minMarginRatio: number | null;
  /** Broken safety condition(s) along the route ('time', 'distance', and/or 'energy'), empty when none broke. */
  brokenConditions: BrokenCondition[];
  /** Corridor suitability decision: NO-GO if any red unsafe segment; CAUTION if margin < 10% or assumed terrain data; else GO. */
  decision: SafetyDecision;
  decisionReasons: string[];
  /** Multi-EVA / multi-sol STOP markers along reachable green segments. */
  stintStops: StintStop[];
  /** Total number of EVAs or sols required for the reachable portion (1 + stintStops.length). */
  totalStints: number;
  /** Applied single-stint distance budget (m), or null when unsegmented. */
  stintDistBudget_m: number | null;
  /** Applied cumulative total distance cap (m), or null when none applies. */
  totalDistCap_m: number | null;
  totalDistExceeded: boolean;
  totalDistCell: number | null;
  totalDistThreshold_m: number | null;
  /** Per path cell: 1 where mission time, walk-back, total range, radial standoff, or usable battery energy is exceeded; null when wholly safe. */
  unsafeMask: Uint8Array | null;
  /** Per path cell: distance from the start in metres (grid-based). */
  profileDist: Float32Array;
  /** Per path cell: cumulative mission time from the start in seconds (including stop work time). */
  profileTime: Float32Array;
  /** Per path cell: slope in degrees, NaN where there is no data. */
  profileSlope: Float32Array;
  /** Per path cell: elevation in metres, NaN where there is no data; null when no elevation grid exists. */
  profileElev: Float32Array | null;
}

export type EscapeResult =
  | {
      type: 'escape-result';
      id: number;
      ok: true;
      path: Int32Array;
      pathCols?: Float32Array;
      pathRows?: Float32Array;
      distance_m: number;
      time_s: number;
      maxSlope_deg: number;
      noDataM: number;
      cautionM: number;
    }
  | {
      type: 'escape-result';
      id: number;
      ok: false;
      reason: 'blocked' | 'no-route';
    };

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
  | { type: 'ready'; noDataCells: number; totalCells: number; hasElevation: boolean; hasLanding: boolean; hasThermalInertia: boolean }
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
      thermalInertia: number | null;
    }
  | { type: 'compare-result'; id: number; rows: TraverserComparisonRow[] }
  | EscapeResult
  | RouteSuccess
  | RouteFailure;
