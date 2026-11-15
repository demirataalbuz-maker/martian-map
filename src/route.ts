// AI-assisted code: written with Claude (Anthropic) and Antigravity (Google DeepMind), reviewed by the team.
//
// Route & landing planning UI + interactive Mission Control simulation dock:
//   - Auto-landing mode (reverse Dijkstra) or manual start
//   - Real-time rover / astronaut route playback & interactive SVG chart scrubbing
//   - Game-style "Trigger Rover Fault!" simulator computing live A* walking
//     escape back to Landing / Start and checking remaining suit life-support

import { LngLatBounds, Marker, type GeoJSONSource, type Map as MlMap, type MapMouseEvent } from 'maplibre-gl';
import {
  ELEVATION_URL,
  FINE_ELEVATION_URL,
  FINE_HAZARD_URL,
  FINE_SLOPE_URL,
  HAZARD_URL,
  LANDING_CREWED_URL,
  LANDING_FALLBACK_URL,
  LANDING_ROBOTIC_URL,
  SLOPE_URL,
  THERMAL_INERTIA_URL,
} from './config';
import type { GroundMobilityModel, GridMeta, LandingCraftParams, LonLat, ScienceStop, Traverser } from './data';
import type { GridGeo } from './grid';
import { formatStintStopLabel, onLangChange, stintUnitLabel, translateDecisionReason, traverserShortName, ui } from './i18n';
import { computeDemoEnergy, formatDuration, renderComparison, renderResults, updateChartsCursor } from './results';
import { findWalkBackReference } from './traverser';
import type {
  EscapeResult,
  FromWorker,
  LandingCandidate,
  RouteSuccess,
  RouterGroundModel,
  RouterTraverser,
  ToWorker,
  TraverserComparisonRow,
  WalkBackSpec,
} from './route-types';

const ROUTE_SOURCE = 'route';
const ROUTE_ABANDONED_SOURCE = 'route-abandoned-src';
const ROUTE_UNSAFE_SOURCE = 'route-unsafe-src';
const ROUTE_ESCAPE_SOURCE = 'route-escape-src';

const SVG_NS = 'http://www.w3.org/2000/svg';
const SPEED_OPTIONS = [60, 240, 600, 1200] as const;

const absoluteUrl = (url: string): string => new URL(url, document.baseURI).href;
const fmtMB = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function makeVehicleIcon(id: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('width', '17');
  svg.setAttribute('height', '17');
  const add = (tag: string, attrs: Record<string, string>) => {
    const n = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    svg.append(n);
  };
  if (id === 'yuruyen_insan' || id === 'suited_astronaut') {
    add('circle', { cx: '10', cy: '4.5', r: '2.5', fill: 'currentColor' });
    add('path', {
      d: 'M10 7.5v5l-3 5M10 12.5l3 5M6.5 10.5l3.5-1.5 3.5 1.5',
      stroke: 'currentColor',
      'stroke-width': '2',
      'stroke-linecap': 'round',
      fill: 'none',
    });
  } else if (id === 'roverli_insan') {
    add('rect', { x: '3', y: '7', width: '12', height: '5', rx: '1.5', fill: 'currentColor' });
    add('circle', { cx: '10', cy: '4.5', r: '1.7', fill: 'currentColor' });
    add('circle', { cx: '5.5', cy: '15', r: '2', fill: 'currentColor' });
    add('circle', { cx: '13.5', cy: '15', r: '2', fill: 'currentColor' });
  } else {
    add('rect', { x: '4', y: '8', width: '12', height: '4.5', rx: '1', fill: 'currentColor' });
    add('path', { d: 'M8 8V4h4', stroke: 'currentColor', 'stroke-width': '1.6', fill: 'none' });
    add('circle', { cx: '5.5', cy: '15', r: '1.8', fill: 'currentColor' });
    add('circle', { cx: '10', cy: '15', r: '1.8', fill: 'currentColor' });
    add('circle', { cx: '14.5', cy: '15', r: '1.8', fill: 'currentColor' });
  }
  return svg;
}

function toRouterTraverser(t: Traverser, ground?: GroundMobilityModel | null): RouterTraverser {
  const groundModel: RouterGroundModel | null = ground
    ? {
        tiLooseThreshold: ground.tiLooseThreshold,
        tiVeryLooseThreshold: ground.tiVeryLooseThreshold,
        looseSpeedFactor: ground.looseSpeedFactor,
        veryLooseSpeedFactor: ground.veryLooseSpeedFactor,
        hardRollingResistance: ground.hardRollingResistance,
        looseRollingResistance: ground.looseRollingResistance,
        veryLooseRollingResistance: ground.veryLooseRollingResistance,
      }
    : null;
  return {
    maxSlopeDeg: t.azami_egim_derece,
    speedTable: t.hiz_tablosu.map((entry): [number, number] => [entry.egim_derece, entry.hiz_m_s]),
    downhillSpeedTable: t.inis_hiz_tablosu?.map((entry): [number, number] => [entry.egim_derece, entry.hiz_m_s]),
    maxTimeS:
      typeof t.azami_sure_saat === 'number' && Number.isFinite(t.azami_sure_saat) && t.azami_sure_saat > 0
        ? t.azami_sure_saat * 3600
        : null,
    maxRadialDistM:
      typeof t.uzaklik_tavani_m === 'number' && Number.isFinite(t.uzaklik_tavani_m) && t.uzaklik_tavani_m > 0
        ? t.uzaklik_tavani_m
        : null,
    stintDistM:
      typeof t.sefer_mesafe_m === 'number' && Number.isFinite(t.sefer_mesafe_m) && t.sefer_mesafe_m > 0
        ? t.sefer_mesafe_m
        : null,
    totalDistCapM:
      typeof t.toplam_menzil_m === 'number' && Number.isFinite(t.toplam_menzil_m) && t.toplam_menzil_m > 0
        ? t.toplam_menzil_m
        : null,
    energyProfile: t.enerji_profili ?? null,
    groundModel,
  };
}

function formatMarsCoord(lon: number, lat: number): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(3)}° ${ns}, ${Math.abs(lon).toFixed(3)}° ${ew}`;
}

function hudSpan(text: string, className?: string): HTMLSpanElement {
  const span = document.createElement('span');
  if (className) span.className = className;
  span.textContent = text;
  return span;
}

export interface RouteController {
  setTraverser(traverser: Traverser): void;
  setTraversersAndActive(traversers: Traverser[], active: Traverser): void;
  setScenario(
    scenario: 'crewed' | 'rover',
    nextGrid: GridMeta,
    nextGeo: GridGeo,
    nextLandingCraft: LandingCraftParams | null,
    activeTraverser: Traverser,
    effectiveTraversers: Traverser[],
  ): void;
  setGlobeMode(isGlobe: boolean): void;
  addPoint(lonLat: LonLat, name?: string): void;
  syncCollapsedAlert(): void;
}

export interface RouteOptions {
  synthetic: boolean;
  ground?: GroundMobilityModel | null;
  landingCraft: LandingCraftParams | null;
  traversers: Traverser[];
  stops: ScienceStop[];
  initialGlobeMode?: boolean;
  onSelectTraverser?: (id: string) => void;
  onRequireLocalView?: () => void;
  onStartupProgress?: (text: string, percent?: number) => void;
  onFatalError?: (message: string) => void;
  topControls?: {
    sampleBtn: HTMLButtonElement | null;
    undoBtn: HTMLButtonElement | null;
    clearBtn: HTMLButtonElement | null;
    emptyPrompt: HTMLElement | null;
    missionDock: HTMLElement | null;
    onOpenDrawer?: () => void;
  };
}

interface FaultState {
  faultCell: number;
  faultIdx: number;
  faultDistM: number;
  elapsedAtFaultS: number;
  escapeRequestId: number;
  escapeResult: EscapeResult | null;
  pendingEscape: boolean;
  originCell: number;
  walkRef: { walker: Traverser; limitHours: number } | null;
  traverserIdAtFault: string;
  peakAutoSelected: boolean;
}

export function initRoute(
  map: MlMap,
  grid: GridMeta,
  geo: GridGeo,
  initialTraverser: Traverser,
  root: HTMLElement,
  options: RouteOptions,
): RouteController {
  // ------------------------------------------------------------ DOM
  const modeGroup = root.querySelector<HTMLElement>('#route-mode')!;
  const modeAutoBtn = root.querySelector<HTMLButtonElement>('#mode-auto')!;
  const modeManualBtn = root.querySelector<HTMLButtonElement>('#mode-manual')!;
  const roundTripInput = root.querySelector<HTMLInputElement>('#opt-roundtrip')!;
  const optimizeStopsInput = root.querySelector<HTMLInputElement>('#opt-optimize-stops');
  const stopMinInput = root.querySelector<HTMLInputElement>('#opt-stop-min')!;
  const allowNoDataInput = root.querySelector<HTMLInputElement>('#opt-allow-nodata')!;
  const hint = root.querySelector<HTMLElement>('#route-hint')!;
  const sampleRow = root.querySelector<HTMLElement>('#route-sample-row')!;
  const sampleButton = root.querySelector<HTMLButtonElement>('#route-sample')!;
  const message = root.querySelector<HTMLElement>('#route-message')!;
  const progressWrap = root.querySelector<HTMLElement>('#load-progress')!;
  const progressBar = root.querySelector<HTMLElement>('#load-progress-bar')!;
  const landingBox = root.querySelector<HTMLElement>('#landing-candidates')!;
  const results = root.querySelector<HTMLElement>('#route-results')!;
  const compareDetails = root.querySelector<HTMLDetailsElement>('#route-compare')!;
  const compareBody = root.querySelector<HTMLElement>('#route-compare-body')!;
  const undoButton = root.querySelector<HTMLButtonElement>('#route-undo')!;
  const clearButton = root.querySelector<HTMLButtonElement>('#route-clear')!;
  const downloadButton = root.querySelector<HTMLButtonElement>('#route-download')!;

  const panelEl = document.getElementById('panel');
  const panelToggleBtn = document.getElementById('panel-toggle');
  const mapAlert = document.getElementById('map-alert');
  const terrainHud = document.getElementById('terrain-hud');

  const topSampleBtn = options.topControls?.sampleBtn ?? null;
  const topUndoBtn = options.topControls?.undoBtn ?? null;
  const topClearBtn = options.topControls?.clearBtn ?? null;
  const emptyPrompt = options.topControls?.emptyPrompt ?? null;
  const missionDock = options.topControls?.missionDock ?? null;

  const dockMetrics = document.getElementById('dock-metrics');
  const dockDetailsBtn = document.getElementById('dock-details-btn');
  const simPlayBtn = document.getElementById('sim-play') as HTMLButtonElement | null;
  const simSpeedBtn = document.getElementById('sim-speed') as HTMLButtonElement | null;
  const simScrub = document.getElementById('sim-scrub') as HTMLInputElement | null;
  const simTelemetry = document.getElementById('sim-telemetry');
  const simFaultBtn = document.getElementById('sim-fault') as HTMLButtonElement | null;
  const simClearFaultBtn = document.getElementById('sim-clear-fault') as HTMLButtonElement | null;
  const faultCard = document.getElementById('fault-card');

  // ------------------------------------------------------------ state
  let activeScenario: 'crewed' | 'rover' = 'crewed';
  let activeGrid = grid;
  let activeGeo = geo;
  let activeLandingCraft = options.landingCraft;
  let globeMode = options.initialGlobeMode === true;

  let traversersList = [...options.traversers];
  let traverser = initialTraverser;
  let hasLandingGrid = false;
  let mode: 'auto-landing' | 'manual' = 'manual';
  const waypoints: number[] = [];
  const names: (string | null)[] = [];
  let chosenLandingCell: number | null = null;
  let lastResult: RouteSuccess | null = null;
  let lastMessage: { text: string; kind: 'info' | 'warn' | 'error' } = { text: '', kind: 'info' };

  const markers: Marker[] = [];
  const landingMarkers: Marker[] = [];
  const turnAroundMarkers: Marker[] = [];
  const stintMarkers: Marker[] = [];

  let ready = false;
  let startupDone = false;
  let pendingSampleMission = false;
  let elevationRequestedOnce = false;
  let requestId = 0;
  let compareRequestId = 0;
  let escapeSeqId = 0;
  let compareDirty = true;
  let lastCompareRows: TraverserComparisonRow[] | null = null;
  let lastActionWasAdd = false;
  let pendingNotice = '';
  let fitToResultOnce = false;

  // Live simulation & fault state
  let simPlaying = false;
  let simPhase: 'route' | 'escape' = 'route';
  let simElapsedS = 0;
  let simDistM = 0;
  let simIdx = 0;
  let simSpeedIdx = 1; // default 240x
  let simLastFrameMs: number | null = null;
  let simRafId: number | null = null;
  let simMarker: Marker | null = null;
  let faultMarker: Marker | null = null;
  let faultState: FaultState | null = null;
  let escapeCumulativeTime: Float64Array | null = null;
  let escapeCumulativeDist: Float64Array | null = null;
  let escapeTotalTimeS = 0;

  const getMinSeparationM = (): number => activeLandingCraft?.guvenli_alan_capi_m ?? 0;
  const getMinTargetStandoffM = (): number => activeLandingCraft?.puskurtme_guvenlik_yaricapi_m ?? 0;
  // Crewed 20 m CTX hazard grid explicitly folds THEMIS thermal inertia (100 m); 5 m HiRISE relies on geometric slope/roughness.
  const getHasThermalInertia = (): boolean => activeScenario === 'crewed' || Boolean(activeGrid.termal_atalet_verisi_var);
  const getHasRockData = (): boolean => Boolean(activeGrid.kaya_verisi_var);
  const getAssumedTerrainData = (): boolean => !(getHasRockData() && getHasThermalInertia());

  let validSampleStops: ScienceStop[] = [];
  const refreshValidSampleStops = (): void => {
    validSampleStops = options.stops.filter((s) => activeGeo.lonLatToIndex(s.konum[0], s.konum[1]) !== null);
    sampleRow.hidden = validSampleStops.length === 0;
    if (topSampleBtn) topSampleBtn.hidden = validSampleStops.length === 0;
  };
  refreshValidSampleStops();

  const currentStopWorkS = (): number => {
    const mins = Number(stopMinInput.value);
    if (!Number.isFinite(mins) || mins <= 0) return 0;
    return Math.min(240, mins) * 60;
  };

  const invalidateComparison = (): void => {
    compareDirty = true;
    lastCompareRows = null;
  };

  const routerTraverserFor = (t: Traverser): RouterTraverser =>
    toRouterTraverser(t, activeScenario === 'crewed' ? (options.ground ?? null) : null);

  const coordAt = (path: Int32Array, k: number, cols?: Float32Array, rows?: Float32Array): LonLat => {
    if (cols && rows && cols.length === path.length && rows.length === path.length) {
      return activeGeo.cellToLonLat(cols[k], rows[k]);
    }
    return activeGeo.indexToLonLat(path[k]);
  };

  const walkBackSpecFor = (t: Traverser): WalkBackSpec | null => {
    const wb = findWalkBackReference(traversersList, t);
    if (!wb) return null;
    return { traverser: routerTraverserFor(wb.walker), limitS: wb.limitHours * 3600 };
  };

  // ------------------------------------------------------------ map layers
  map.addSource(ROUTE_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addSource(ROUTE_ABANDONED_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addSource(ROUTE_UNSAFE_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addSource(ROUTE_ESCAPE_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

  map.addLayer({
    id: 'route-abandoned',
    type: 'line',
    source: ROUTE_ABANDONED_SOURCE,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#9c8c82', 'line-width': 2.5, 'line-dasharray': [2, 2], 'line-opacity': 0.58 },
  });
  map.addLayer({
    id: 'route-casing',
    type: 'line',
    source: ROUTE_SOURCE,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#101010', 'line-width': 7, 'line-opacity': 0.8 },
  });
  map.addLayer({
    id: 'route-line',
    type: 'line',
    source: ROUTE_SOURCE,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#3ddc84', 'line-width': 3.6 },
  });
  map.addLayer({
    id: 'route-unsafe',
    type: 'line',
    source: ROUTE_UNSAFE_SOURCE,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#ff5252', 'line-width': 3.8, 'line-dasharray': [2, 1.5] },
  });
  map.addLayer({
    id: 'route-escape-casing',
    type: 'line',
    source: ROUTE_ESCAPE_SOURCE,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#14100e', 'line-width': 7, 'line-opacity': 0.88 },
  });
  map.addLayer({
    id: 'route-escape',
    type: 'line',
    source: ROUTE_ESCAPE_SOURCE,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#ffb020', 'line-width': 3.6, 'line-dasharray': [2.2, 1.4] },
  });

  const clearEscapeLine = (): void => {
    (map.getSource(ROUTE_ESCAPE_SOURCE) as GeoJSONSource).setData({ type: 'FeatureCollection', features: [] });
  };

  const setEscapeLine = (path: Int32Array | null, pathCols?: Float32Array, pathRows?: Float32Array): void => {
    const coordinates = path ? Array.from(path, (_, k) => coordAt(path, k, pathCols, pathRows)) : [];
    (map.getSource(ROUTE_ESCAPE_SOURCE) as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: coordinates.length >= 2 ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } }] : [],
    });
  };

  const setLine = (
    path: Int32Array | null,
    unsafeMask?: Uint8Array | null,
    splitIdx?: number | null,
    pathCols?: Float32Array,
    pathRows?: Float32Array,
  ): void => {
    const allCoords = path ? Array.from(path, (_, k) => coordAt(path, k, pathCols, pathRows)) : [];
    const cut = splitIdx !== null && splitIdx !== undefined && splitIdx >= 0 && splitIdx < allCoords.length ? splitIdx : null;

    const mainLimit = cut !== null ? cut + 1 : allCoords.length;
    const abandonedCoords = cut !== null ? allCoords.slice(cut) : [];

    const safeFeatures: { type: 'Feature'; properties: Record<string, never>; geometry: { type: 'LineString'; coordinates: LonLat[] } }[] = [];
    const unsafeFeatures: { type: 'Feature'; properties: Record<string, never>; geometry: { type: 'LineString'; coordinates: LonLat[] } }[] = [];

    if (path && unsafeMask && unsafeMask.length === path.length && allCoords.length >= 2) {
      let safeSeg: LonLat[] = [];
      let unsafeSeg: LonLat[] = [];
      for (let k = 0; k < mainLimit; k++) {
        if (unsafeMask[k] === 0) {
          if (unsafeSeg.length > 0) {
            unsafeSeg.push(allCoords[k]);
            if (unsafeSeg.length >= 2) unsafeFeatures.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: unsafeSeg } });
            unsafeSeg = [];
          }
          safeSeg.push(allCoords[k]);
        } else {
          if (safeSeg.length > 0) {
            if (safeSeg.length >= 2) safeFeatures.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: safeSeg } });
            safeSeg = [];
          }
          if (unsafeSeg.length === 0 && k > 0) unsafeSeg.push(allCoords[k - 1]);
          unsafeSeg.push(allCoords[k]);
        }
      }
      if (safeSeg.length >= 2) safeFeatures.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: safeSeg } });
      if (unsafeSeg.length >= 2) unsafeFeatures.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: unsafeSeg } });
    } else if (mainLimit >= 2) {
      safeFeatures.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: allCoords.slice(0, mainLimit) } });
    }

    (map.getSource(ROUTE_SOURCE) as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: safeFeatures,
    });
    (map.getSource(ROUTE_ABANDONED_SOURCE) as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features:
        abandonedCoords.length >= 2 ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: abandonedCoords } }] : [],
    });
    (map.getSource(ROUTE_UNSAFE_SOURCE) as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: unsafeFeatures,
    });
  };

  // ------------------------------------------------------------ rendering & simulation helpers
  const stopPlayback = (): void => {
    simPlaying = false;
    simLastFrameMs = null;
    if (simRafId !== null) {
      cancelAnimationFrame(simRafId);
      simRafId = null;
    }
    updatePlayButtonLabel();
  };

  const updatePlayButtonLabel = (): void => {
    if (!simPlayBtn) return;
    if (simPlaying && simPhase === 'route') {
      simPlayBtn.textContent = ui('⏸ Pause', '⏸ Duraklat');
    } else {
      simPlayBtn.textContent = ui('▶ Play', '▶ Oynat');
    }
  };

  const removeSimMarker = (): void => {
    if (simMarker) {
      simMarker.remove();
      simMarker = null;
    }
  };

  const ensureSimMarker = (lngLat: LonLat, modeKind: 'route' | 'escape'): void => {
    if (!simMarker) {
      const box = el('div', `sim-vehicle-marker${modeKind === 'escape' ? ' escape-mode' : ''}`);
      box.append(makeVehicleIcon(modeKind === 'escape' ? 'yuruyen_insan' : traverser.id));
      if (globeMode) box.style.display = 'none';
      simMarker = new Marker({ element: box }).setLngLat(lngLat).addTo(map);
    } else {
      const box = simMarker.getElement();
      box.className = `sim-vehicle-marker${modeKind === 'escape' ? ' escape-mode' : ''}`;
      box.replaceChildren(makeVehicleIcon(modeKind === 'escape' ? 'yuruyen_insan' : traverser.id));
      box.style.display = globeMode ? 'none' : '';
      simMarker.setLngLat(lngLat);
    }
  };

  const sampleRouteAtTime = (targetTimeS: number): { lonLat: LonLat; idx: number; distM: number; elapsedS: number; slopeDeg: number | null; elevM: number | null } | null => {
    if (!lastResult || lastResult.path.length === 0) return null;
    const { path, profileDist, profileTime, profileSlope, profileElev } = lastResult;
    const n = path.length;
    const totalT = profileTime[n - 1] ?? lastResult.time_s;
    const clampedT = Math.max(0, Math.min(totalT, targetTimeS));

    if (n === 1 || totalT <= 0) {
      return {
        lonLat: activeGeo.indexToLonLat(path[0]),
        idx: 0,
        distM: 0,
        elapsedS: 0,
        slopeDeg: Number.isNaN(profileSlope[0]) ? null : profileSlope[0],
        elevM: profileElev && !Number.isNaN(profileElev[0]) ? profileElev[0] : null,
      };
    }

    let lo = 0;
    let hi = n - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (profileTime[mid] <= clampedT) lo = mid;
      else hi = mid;
    }
    const spanT = profileTime[hi] - profileTime[lo];
    const frac = spanT > 1e-6 ? Math.max(0, Math.min(1, (clampedT - profileTime[lo]) / spanT)) : 0;
    const p0 = coordAt(path, lo, lastResult.pathCols, lastResult.pathRows);
    const p1 = coordAt(path, hi, lastResult.pathCols, lastResult.pathRows);
    const lon = p0[0] + (p1[0] - p0[0]) * frac;
    const lat = p0[1] + (p1[1] - p0[1]) * frac;
    const distM = profileDist[lo] + (profileDist[hi] - profileDist[lo]) * frac;
    const nearest = frac >= 0.5 ? hi : lo;
    const s = profileSlope[nearest];
    const z = profileElev ? profileElev[nearest] : NaN;
    return {
      lonLat: [lon, lat],
      idx: nearest,
      distM,
      elapsedS: clampedT,
      slopeDeg: Number.isNaN(s) ? null : s,
      elevM: Number.isNaN(z) ? null : z,
    };
  };

  const sampleRouteAtDist = (targetDistM: number): { lonLat: LonLat; idx: number; distM: number; elapsedS: number; slopeDeg: number | null; elevM: number | null } | null => {
    if (!lastResult || lastResult.path.length === 0) return null;
    const { path, profileDist, profileTime, profileSlope, profileElev } = lastResult;
    const n = path.length;
    const totalD = profileDist[n - 1] ?? lastResult.distance_m;
    const clampedD = Math.max(0, Math.min(totalD, targetDistM));

    if (n === 1 || totalD <= 0) return sampleRouteAtTime(0);

    let lo = 0;
    let hi = n - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (profileDist[mid] <= clampedD) lo = mid;
      else hi = mid;
    }
    const spanD = profileDist[hi] - profileDist[lo];
    const frac = spanD > 1e-6 ? Math.max(0, Math.min(1, (clampedD - profileDist[lo]) / spanD)) : 0;
    const p0 = coordAt(path, lo, lastResult.pathCols, lastResult.pathRows);
    const p1 = coordAt(path, hi, lastResult.pathCols, lastResult.pathRows);
    const lon = p0[0] + (p1[0] - p0[0]) * frac;
    const lat = p0[1] + (p1[1] - p0[1]) * frac;
    const elapsedS = profileTime[lo] + (profileTime[hi] - profileTime[lo]) * frac;
    const nearest = frac >= 0.5 ? hi : lo;
    const s = profileSlope[nearest];
    const z = profileElev ? profileElev[nearest] : NaN;
    return {
      lonLat: [lon, lat],
      idx: nearest,
      distM: clampedD,
      elapsedS,
      slopeDeg: Number.isNaN(s) ? null : s,
      elevM: Number.isNaN(z) ? null : z,
    };
  };

  const updateSimTelemetry = (distM: number, timeS: number, slopeDeg: number | null): void => {
    if (!simTelemetry) return;
    const slopeTxt = slopeDeg !== null ? ` · ${slopeDeg.toFixed(1)}°` : '';
    simTelemetry.textContent = `${Math.round(distM)} m · ${formatDuration(timeS)}${slopeTxt}`;
  };

  const renderFaultCard = (): void => {
    if (!faultCard || !faultState || !lastResult) {
      if (faultCard) faultCard.hidden = true;
      return;
    }
    faultCard.replaceChildren();
    faultCard.hidden = false;

    const { faultDistM, elapsedAtFaultS, pendingEscape, escapeResult, walkRef, traverserIdAtFault, peakAutoSelected } = faultState;
    const textWrap = el('div', 'fault-card-text');
    const peakNote = peakAutoSelected
      ? el(
          'div',
          undefined,
          ui(
            'Note: Triggered before Play — simulated at peak outbound distance near target, escaping back to Base.',
            'Not: Oynat öncesi basıldı — hedefe en uzak noktada arıza simüle edilip Üsse kaçış hesaplandı.',
          ),
        )
      : null;

    if (traverserIdAtFault === 'rover' || !walkRef) {
      faultCard.dataset.outcome = 'WARN';
      textWrap.append(
        el(
          'strong',
          undefined,
          ui(
            `ROBOTIC FAULT at ${Math.round(faultDistM)} m (${formatDuration(elapsedAtFaultS)})`,
            `${Math.round(faultDistM)} m'de ROBOT ARIZASI (${formatDuration(elapsedAtFaultS)})`,
          ),
        ),
        el(
          'div',
          undefined,
          ui(
            'Uncrewed rover immobilised — no suited astronaut aboard (remainder greyed out).',
            'İnsansız rover durdu — mürettebat yok (kalan rota griye alındı).',
          ),
        ),
      );
      if (peakNote) textWrap.append(peakNote);
      faultCard.append(textWrap);
      return;
    }

    const headerPrefix =
      traverserIdAtFault === 'yuruyen_insan' || traverserIdAtFault === 'suited_astronaut'
        ? ui('EVA ABORT / WALK-BACK', 'EVA İPTAL / YAYA DÖNÜŞ')
        : ui('ROVER FAULT → WALK ESCAPE', 'ROVER ARIZASI → YAYA KAÇIŞ');

    if (pendingEscape) {
      faultCard.dataset.outcome = 'WARN';
      textWrap.append(
        el('strong', undefined, `${headerPrefix} @ ${Math.round(faultDistM)} m`),
        el('div', undefined, ui('Computing shortest A* walking escape corridor…', 'En kısa A* yaya kaçış rotası hesaplanıyor…')),
      );
      faultCard.append(textWrap);
      return;
    }

    const limitS = walkRef.limitHours * 3600;
    if (!escapeResult || !escapeResult.ok) {
      faultCard.dataset.outcome = 'NO-GO';
      textWrap.append(
        el('strong', undefined, `${headerPrefix} — ${ui('TRAPPED / BLOCKED', 'MAHSUR / YOL YOK')}`),
        el(
          'div',
          undefined,
          ui(
            `Suit walking limit ${walkRef.walker.azami_egim_derece}° cannot traverse return terrain from here.`,
            `Yaya eğim limiti (${walkRef.walker.azami_egim_derece}°) buradan üsse yürüyüşe izin vermiyor.`,
          ),
        ),
      );
      faultCard.append(textWrap);
      return;
    }

    const totalSuitS = elapsedAtFaultS + escapeResult.time_s;
    const marginS = limitS - totalSuitS;
    const survivable = marginS >= 0;
    faultCard.dataset.outcome = survivable ? 'SURVIVABLE' : 'NO-GO';

    const title = el(
      'strong',
      undefined,
      survivable
        ? ui(`${headerPrefix}: SURVIVABLE (+${formatDuration(marginS)} left)`, `${headerPrefix}: KURTULUR (+${formatDuration(marginS)} pay)`)
        : ui(`${headerPrefix}: NO-GO (-${formatDuration(-marginS)} short)`, `${headerPrefix}: NO-GO (${formatDuration(-marginS)} yetersiz)`),
    );
    const sub = el(
      'div',
      undefined,
      ui(
        `Elapsed ${formatDuration(elapsedAtFaultS)} + ${Math.round(escapeResult.distance_m)} m walk (${formatDuration(escapeResult.time_s)}) = ${formatDuration(totalSuitS)} vs ${walkRef.limitHours} h suit cap`,
        `Geçen ${formatDuration(elapsedAtFaultS)} + ${Math.round(escapeResult.distance_m)} m yürüyüş (${formatDuration(escapeResult.time_s)}) = ${formatDuration(totalSuitS)} / ${walkRef.limitHours} sa limit`,
      ),
    );
    textWrap.append(title, sub);
    if (peakNote) textWrap.append(peakNote);
    faultCard.append(textWrap);

    if (escapeResult.path.length >= 2) {
      const walkBtn = el(
        'button',
        'sim-btn escape-play',
        simPlaying && simPhase === 'escape' ? ui('⏸ Pause Escape', '⏸ Duraklat') : ui('▶ Walk Escape', '▶ Kaçışı Yürü'),
      );
      walkBtn.type = 'button';
      walkBtn.addEventListener('click', () => startEscapeAnimation());
      faultCard.append(walkBtn);
    }
  };

  const clearFaultState = (keepLine = true): void => {
    if (simPhase === 'escape') stopPlayback();
    faultState = null;
    escapeCumulativeTime = null;
    escapeCumulativeDist = null;
    if (faultMarker) {
      faultMarker.remove();
      faultMarker = null;
    }
    clearEscapeLine();
    if (simClearFaultBtn) simClearFaultBtn.hidden = true;
    if (faultCard) faultCard.hidden = true;
    if (keepLine && lastResult) {
      setLine(lastResult.path, lastResult.unsafeMask, null, lastResult.pathCols, lastResult.pathRows);
    }
  };

  const setSimPositionByDist = (distM: number, updateScrubber = true): void => {
    const sample = sampleRouteAtDist(distM);
    if (!sample) return;
    simDistM = sample.distM;
    simElapsedS = sample.elapsedS;
    simIdx = sample.idx;
    ensureSimMarker(sample.lonLat, 'route');
    updateSimTelemetry(sample.distM, sample.elapsedS, sample.slopeDeg);
    updateChartsCursor(results, sample.distM);
    if (updateScrubber && simScrub && lastResult && lastResult.distance_m > 0) {
      simScrub.value = String(Math.round((sample.distM / lastResult.distance_m) * 1000));
    }
  };

  const applySimPositionByTime = (tS: number): boolean => {
    const sample = sampleRouteAtTime(tS);
    if (!sample || !lastResult) return false;
    simDistM = sample.distM;
    simElapsedS = sample.elapsedS;
    simIdx = sample.idx;
    ensureSimMarker(sample.lonLat, 'route');
    updateSimTelemetry(sample.distM, sample.elapsedS, sample.slopeDeg);
    updateChartsCursor(results, sample.distM);
    if (simScrub && lastResult.distance_m > 0) {
      simScrub.value = String(Math.round((sample.distM / lastResult.distance_m) * 1000));
    }
    return tS < (lastResult.profileTime[lastResult.profileTime.length - 1] ?? lastResult.time_s);
  };

  const buildEscapeCumulative = (esc: Extract<EscapeResult, { ok: true }>): void => {
    const walkerSpeed = Math.max(0.2, esc.time_s > 0 ? esc.distance_m / esc.time_s : 0.5);
    const n = esc.path.length;
    escapeCumulativeDist = new Float64Array(n);
    escapeCumulativeTime = new Float64Array(n);
    let d = 0;
    for (let k = 1; k < n; k++) {
      const a = esc.path[k - 1];
      const b = esc.path[k];
      const diag = a % activeGrid.genislik !== b % activeGrid.genislik && Math.floor(a / activeGrid.genislik) !== Math.floor(b / activeGrid.genislik);
      const step = diag ? activeGrid.hucre_m * Math.SQRT2 : activeGrid.hucre_m;
      d += step;
      escapeCumulativeDist[k] = d;
      escapeCumulativeTime[k] = esc.distance_m > 0 ? esc.time_s * (d / esc.distance_m) : d / walkerSpeed;
    }
    escapeTotalTimeS = esc.time_s;
  };

  const stepAnimation = (nowMs: number): void => {
    if (!simPlaying) return;
    if (simLastFrameMs === null) simLastFrameMs = nowMs;
    const dtS = Math.min(0.1, (nowMs - simLastFrameMs) / 1000);
    simLastFrameMs = nowMs;

    const mult = SPEED_OPTIONS[simSpeedIdx];
    simElapsedS += dtS * mult;

    if (simPhase === 'route') {
      const stillRunning = applySimPositionByTime(simElapsedS);
      if (!stillRunning) {
        stopPlayback();
        return;
      }
    } else if (faultState?.escapeResult?.ok && escapeCumulativeTime && escapeCumulativeDist) {
      const path = faultState.escapeResult.path;
      const total = escapeTotalTimeS;
      const clamped = Math.min(total, simElapsedS);
      let lo = 0;
      let hi = path.length - 1;
      while (lo + 1 < hi) {
        const mid = (lo + hi) >> 1;
        if (escapeCumulativeTime[mid] <= clamped) lo = mid;
        else hi = mid;
      }
      const span = escapeCumulativeTime[hi] - escapeCumulativeTime[lo];
      const frac = span > 1e-6 ? Math.max(0, Math.min(1, (clamped - escapeCumulativeTime[lo]) / span)) : 0;
      const p0 = coordAt(path, lo, faultState.escapeResult.pathCols, faultState.escapeResult.pathRows);
      const p1 = coordAt(path, hi, faultState.escapeResult.pathCols, faultState.escapeResult.pathRows);
      ensureSimMarker([p0[0] + (p1[0] - p0[0]) * frac, p0[1] + (p1[1] - p0[1]) * frac], 'escape');
      const dWalked = escapeCumulativeDist[lo] + (escapeCumulativeDist[hi] - escapeCumulativeDist[lo]) * frac;
      updateSimTelemetry(dWalked, faultState.elapsedAtFaultS + clamped, null);
      if (clamped >= total) {
        stopPlayback();
        renderFaultCard();
        return;
      }
    } else {
      stopPlayback();
      return;
    }

    simRafId = requestAnimationFrame(stepAnimation);
  };

  const startRouteAnimation = (): void => {
    if (!lastResult || lastResult.path.length < 2) return;
    if (simPhase === 'escape') {
      clearFaultState(true);
      simPhase = 'route';
    }
    const totalT = lastResult.profileTime[lastResult.profileTime.length - 1] ?? lastResult.time_s;
    if (simElapsedS >= totalT * 0.999) {
      simElapsedS = 0;
      simDistM = 0;
      simIdx = 0;
    }
    if (faultState) clearFaultState(true);
    simPhase = 'route';
    simPlaying = true;
    simLastFrameMs = null;
    updatePlayButtonLabel();
    simRafId = requestAnimationFrame(stepAnimation);
  };

  function startEscapeAnimation(): void {
    if (!faultState?.escapeResult?.ok || faultState.escapeResult.path.length < 2) return;
    if (simPlaying && simPhase === 'escape') {
      stopPlayback();
      renderFaultCard();
      return;
    }
    buildEscapeCumulative(faultState.escapeResult);
    simPhase = 'escape';
    simElapsedS = 0;
    simPlaying = true;
    simLastFrameMs = null;
    renderFaultCard();
    simRafId = requestAnimationFrame(stepAnimation);
  }

  const triggerRoverFault = (): void => {
    if (!ready || !lastResult || lastResult.path.length < 2) return;
    stopPlayback();

    let fIdx = simIdx;
    let peakAutoSelected = false;
    if (fIdx <= 1 && !faultState) {
      peakAutoSelected = true;
      // Pick peak outbound distance / walk-back stress point when triggered before Play
      if (lastResult.walkBackCell !== null) {
        const idx = lastResult.path.indexOf(lastResult.walkBackCell);
        if (idx > 0) fIdx = idx;
      } else {
        let bestIdx = Math.max(1, Math.floor(lastResult.path.length / 2));
        let bestR = -1;
        const oCell = lastResult.path[0];
        const oC = oCell % activeGrid.genislik;
        const oR = (oCell - oC) / activeGrid.genislik;
        for (let k = 1; k < lastResult.path.length; k++) {
          const c = lastResult.path[k];
          const col = c % activeGrid.genislik;
          const row = (c - col) / activeGrid.genislik;
          const r = Math.hypot(col - oC, row - oR);
          if (r > bestR) {
            bestR = r;
            bestIdx = k;
          }
        }
        fIdx = bestIdx;
      }
    }

    fIdx = Math.max(1, Math.min(lastResult.path.length - 1, fIdx));
    const faultCell = lastResult.path[fIdx];
    const faultDistM = lastResult.profileDist[fIdx] ?? 0;
    const elapsedAtFaultS = lastResult.profileTime[fIdx] ?? 0;

    setSimPositionByDist(faultDistM, true);

    if (faultMarker) {
      faultMarker.remove();
      faultMarker = null;
    }
    const fEl = el('div', 'waypoint fault', '⚠');
    fEl.title = ui(`Fault triggered @ ${Math.round(faultDistM)} m`, `${Math.round(faultDistM)} m noktasında arıza`);
    if (globeMode) fEl.style.display = 'none';
    faultMarker = new Marker({ element: fEl }).setLngLat(coordAt(lastResult.path, fIdx, lastResult.pathCols, lastResult.pathRows)).addTo(map);

    setLine(lastResult.path, lastResult.unsafeMask, fIdx, lastResult.pathCols, lastResult.pathRows);
    clearEscapeLine();

    const wb = findWalkBackReference(traversersList, traverser);
    const walkRef =
      wb
        ? { walker: wb.walker, limitHours: wb.limitHours }
        : traverser.id === 'yuruyen_insan' || traverser.id === 'suited_astronaut'
        ? { walker: traverser, limitHours: traverser.azami_sure_saat ?? 6.4 }
        : null;

    const escId = ++escapeSeqId;
    faultState = {
      faultCell,
      faultIdx: fIdx,
      faultDistM,
      elapsedAtFaultS,
      escapeRequestId: escId,
      escapeResult: null,
      pendingEscape: walkRef !== null,
      originCell: lastResult.path[0],
      walkRef,
      traverserIdAtFault: traverser.id,
      peakAutoSelected,
    };

    if (simClearFaultBtn) simClearFaultBtn.hidden = false;
    renderFaultCard();

    if (walkRef) {
      send({
        type: 'escape',
        id: escId,
        fromCell: faultCell,
        toCell: lastResult.path[0],
        allowNoData: allowNoDataInput.checked,
        walker: routerTraverserFor(walkRef.walker),
      });
    }
  };

  const renderDockSummary = (): void => {
    if (!missionDock || !dockMetrics) return;
    if (!lastResult || lastResult.legs.length === 0) {
      missionDock.hidden = true;
      removeSimMarker();
      stopPlayback();
      clearFaultState(false);
      return;
    }
    missionDock.hidden = globeMode;
    dockMetrics.replaceChildren();

    const badge = el('span', 'dock-pill', lastResult.decision);
    badge.dataset.decision = lastResult.decision;
    badge.title = lastResult.decisionReasons.map(translateDecisionReason).join('; ');
    dockMetrics.append(badge);

    const addMetric = (val: string, lbl: string) => {
      const m = el('span', 'dock-metric', val);
      if (lbl) m.append(el('span', undefined, ` ${lbl}`));
      dockMetrics.append(m);
    };

    addMetric(
      `${(lastResult.distance_m / 1000).toFixed(2)} km`,
      lastResult.roundTrip ? ui('(RT)', '(GD)') : ui('(1-way)', '(tek yön)'),
    );
    addMetric(formatDuration(lastResult.time_s), traverserShortName(traverser));
    if (lastResult.totalStints > 0 && lastResult.stintDistBudget_m) {
      addMetric(
        stintUnitLabel(traverser.id, lastResult.totalStints),
        lastResult.totalStints > 1 ? ui('split', 'duraklı') : '',
      );
    }
    let maxSlope = 0;
    for (const s of lastResult.profileSlope) if (!Number.isNaN(s) && s > maxSlope) maxSlope = s;
    addMetric(`${maxSlope.toFixed(1)}°`, ui('max slope', 'maks eğim'));

    if (traverser.enerji_profili) {
      const e = computeDemoEnergy(lastResult, traverser.enerji_profili);
      addMetric(`${Math.round(e.usedWh)} Wh`, e.dipsIntoReserve ? '⚠' : '');
    }

    if (dockDetailsBtn) dockDetailsBtn.textContent = ui('Charts & Details ▸', 'Grafikler & Detay ▸');
    if (simSpeedBtn) simSpeedBtn.textContent = `${SPEED_OPTIONS[simSpeedIdx]}×`;
    if (simFaultBtn) {
      simFaultBtn.textContent =
        traverser.id === 'yuruyen_insan' || traverser.id === 'suited_astronaut'
          ? ui('⚡ Trigger Suit Abort!', '⚡ Acil Yaya Dönüş!')
          : ui('⚡ Trigger Rover Fault!', '⚡ Rover Bozuldu!');
    }
    if (simClearFaultBtn) simClearFaultBtn.textContent = ui('↺ Clear Fault', '↺ Arızayı Temizle');
    updatePlayButtonLabel();
  };

  // Wire dock buttons
  if (dockDetailsBtn) {
    dockDetailsBtn.addEventListener('click', () => options.topControls?.onOpenDrawer?.());
  }
  if (simPlayBtn) {
    simPlayBtn.addEventListener('click', () => {
      if (simPlaying && simPhase === 'route') stopPlayback();
      else startRouteAnimation();
    });
  }
  if (simSpeedBtn) {
    simSpeedBtn.addEventListener('click', () => {
      simSpeedIdx = (simSpeedIdx + 1) % SPEED_OPTIONS.length;
      simSpeedBtn.textContent = `${SPEED_OPTIONS[simSpeedIdx]}×`;
    });
  }
  if (simScrub) {
    simScrub.addEventListener('input', () => {
      if (!lastResult) return;
      stopPlayback();
      if (faultState) clearFaultState(true);
      const frac = Number(simScrub.value) / 1000;
      setSimPositionByDist(frac * lastResult.distance_m, false);
    });
  }
  if (simFaultBtn) {
    simFaultBtn.addEventListener('click', triggerRoverFault);
  }
  if (simClearFaultBtn) {
    simClearFaultBtn.addEventListener('click', () => clearFaultState(true));
  }

  // ------------------------------------------------------------ alerts & messages
  const syncCollapsedAlert = (): void => {
    if (!mapAlert) return;
    const isCollapsed = panelEl?.classList.contains('collapsed') ?? false;
    const kind = message.dataset.kind;
    const isImportant = !message.hidden && message.textContent !== '' && (kind === 'error' || kind === 'warn');
    mapAlert.hidden = !(isCollapsed && isImportant);
    if (!mapAlert.hidden) {
      mapAlert.textContent = message.textContent;
      mapAlert.dataset.kind = kind ?? 'error';
    }
  };

  if (mapAlert) {
    mapAlert.title = ui('Click to open the route panel', 'Detay panelini açmak için tıklayın');
    mapAlert.addEventListener('click', () => {
      panelEl?.classList.remove('collapsed');
      panelToggleBtn?.setAttribute('aria-expanded', 'true');
      syncCollapsedAlert();
    });
  }

  const showMessage = (text: string, kind: 'info' | 'warn' | 'error' = 'info'): void => {
    lastMessage = { text, kind };
    message.textContent = text;
    message.dataset.kind = kind;
    message.hidden = text === '';
    syncCollapsedAlert();
  };

  const clearTurnAroundMarker = (): void => {
    turnAroundMarkers.splice(0).forEach((m) => m.remove());
    stintMarkers.splice(0).forEach((m) => m.remove());
  };

  const clearLandingUI = (): void => {
    landingMarkers.splice(0).forEach((m) => m.remove());
    landingBox.replaceChildren();
    landingBox.hidden = true;
  };

  const renderLandingCandidates = (candidates: LandingCandidate[], activeCell: number | null): void => {
    clearLandingUI();
    if (mode !== 'auto-landing' || candidates.length === 0) return;

    const minSepM = getMinSeparationM();
    const standoffM = getMinTargetStandoffM();
    const partsEn: string[] = [];
    const partsTr: string[] = [];
    if (minSepM > 0) {
      partsEn.push(`≥ ${minSepM} m apart`);
      partsTr.push(`≥ ${minSepM} m ayrı`);
    }
    if (standoffM > 0) {
      partsEn.push(`≥ ${standoffM} m plume standoff`);
      partsTr.push(`≥ ${standoffM} m egzoz mesafesi`);
    }
    const heading = document.createElement('h3');
    heading.className = 'landing-heading';
    heading.textContent =
      partsEn.length > 0
        ? ui(`Suggested landing sites (${partsEn.join(' · ')})`, `Önerilen iniş alanları (${partsTr.join(' · ')})`)
        : ui('Suggested landing sites', 'Önerilen iniş alanları');
    landingBox.append(heading);

    const list = document.createElement('div');
    list.className = 'landing-list';

    candidates.forEach((cand, idx) => {
      const isActive = cand.cell === activeCell;
      const code = idx === 0 ? 'L' : `B${idx}`;
      const roleLabel =
        idx === 0 ? ui('Recommended landing', 'Önerilen iniş') : ui(`Backup ${idx}`, `Yedek ${idx}`);
      const tierLabel = cand.tier === 0 ? ui('Suitable', 'Uygun') : ui('Marginal', 'Sınırda');

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `landing-option${isActive ? ' active' : ''}${cand.tier === 1 ? ' marginal' : ''}`;
      const badge = document.createElement('span');
      badge.className = `landing-badge${cand.tier === 1 ? ' marginal' : ''}`;
      badge.textContent = code;

      const body = document.createElement('span');
      body.className = 'landing-meta';
      const title = document.createElement('strong');
      title.textContent = `${roleLabel} (${tierLabel})`;
      const stats = document.createElement('span');
      stats.textContent = ui(
        `${Math.round(cand.distance_m)} m · ${formatDuration(cand.time_s)} to Stop 1`,
        `1. Durağa ${Math.round(cand.distance_m)} m · ${formatDuration(cand.time_s)}`,
      );
      body.append(title, stats);

      btn.append(badge, body);
      btn.addEventListener('click', () => {
        if (chosenLandingCell === cand.cell) return;
        chosenLandingCell = cand.cell;
        lastActionWasAdd = false;
        pendingNotice = '';
        requestRoute();
      });
      list.append(btn);

      const markerEl = document.createElement('button');
      markerEl.type = 'button';
      markerEl.className = `waypoint landing${isActive ? ' active' : ' backup'}${cand.tier === 1 ? ' marginal' : ''}`;
      markerEl.textContent = code;
      markerEl.title = ui(
        `${roleLabel} (${tierLabel}): ${Math.round(cand.distance_m)} m, ${formatDuration(cand.time_s)} to Stop 1`,
        `${roleLabel} (${tierLabel}): 1. durağa ${Math.round(cand.distance_m)} m, ${formatDuration(cand.time_s)}`,
      );
      markerEl.setAttribute('aria-label', markerEl.title);
      markerEl.addEventListener('click', (e) => {
        e.stopPropagation();
        if (chosenLandingCell === cand.cell) return;
        chosenLandingCell = cand.cell;
        lastActionWasAdd = false;
        pendingNotice = '';
        requestRoute();
      });
      if (globeMode) markerEl.style.display = 'none';
      landingMarkers.push(new Marker({ element: markerEl }).setLngLat(activeGeo.indexToLonLat(cand.cell)).addTo(map));
    });

    landingBox.append(list);
    landingBox.hidden = false;
  };

  const updateHint = (): void => {
    if (mode === 'auto-landing') {
      hint.textContent =
        waypoints.length === 0
          ? ui(
              'Tap a science target on the map; the closest safe landing zone and backups will be suggested automatically.',
              'Haritada bir bilim hedefine dokunun; en yakın güvenli iniş alanı ve yedekleri otomatik önerilsin.',
            )
          : ui(
              'Tap the map to add further science stops, or click a backup landing site (B1 / B2) to switch.',
              'Yeni bilim durağı eklemek için haritaya dokunun veya yedek inişe (B1 / B2) tıklayın.',
            );
    } else {
      hint.textContent =
        waypoints.length === 0
          ? ui('Tap the map to set the start point.', 'Başlangıç noktasını koymak için haritaya dokunun.')
          : ui(
              'Tap the map to add a science stop. Stops are visited in the order you add them.',
              'Bilim durağı eklemek için haritaya dokunun. Duraklar eklediğiniz sırayla gezilir.',
            );
    }
    if (emptyPrompt) {
      emptyPrompt.hidden = globeMode || !startupDone || waypoints.length > 0;
      if (!emptyPrompt.hidden) {
        emptyPrompt.textContent = ui(
          'Tap a science stop (◆) or terrain to plan · Use "★ Sample" in top bar for 1-click demo',
          'Haritadaki duraklara (◆) veya araziye tıklayın · Tek tık demo için üstteki "★ Örnek" butonunu kullanın',
        );
      }
    }
  };

  const syncButtonsState = (): void => {
    const empty = waypoints.length === 0;
    undoButton.disabled = empty;
    clearButton.disabled = empty;
    if (topUndoBtn) topUndoBtn.disabled = empty;
    if (topClearBtn) topClearBtn.disabled = empty;
    downloadButton.disabled = lastResult === null;
  };

  const renderMarkers = (): void => {
    markers.splice(0).forEach((marker) => marker.remove());
    waypoints.forEach((cell, index) => {
      const element = document.createElement('div');
      const isManualStart = mode === 'manual' && index === 0;
      const stopNum = mode === 'auto-landing' ? index + 1 : index;
      element.className = isManualStart ? 'waypoint start' : 'waypoint';
      element.textContent = isManualStart ? 'S' : String(stopNum);
      const role = isManualStart ? ui('Start', 'Başlangıç') : ui(`Science stop ${stopNum}`, `Bilim durağı ${stopNum}`);
      element.title = names[index] ? `${role}: ${names[index]}` : role;
      if (globeMode) element.style.display = 'none';
      markers.push(new Marker({ element }).setLngLat(activeGeo.indexToLonLat(cell)).addTo(map));
    });
    syncButtonsState();
    updateHint();
  };

  // ------------------------------------------------------------ worker
  const worker = new Worker(new URL('./route-worker.ts', import.meta.url), { type: 'module' });
  const send = (msg: ToWorker): void => worker.postMessage(msg);

  const selectTraverserFromComparison = (id: string): void => {
    if (id === traverser.id) return;
    if (options.onSelectTraverser) {
      options.onSelectTraverser(id);
    } else {
      const found = traversersList.find((t) => t.id === id);
      if (found) {
        traverser = found;
        lastActionWasAdd = false;
        pendingNotice = '';
        requestRoute();
      }
    }
  };

  const refreshComparison = (): void => {
    if (!lastResult || waypoints.length === 0 || traversersList.length < 2) {
      compareDetails.hidden = true;
      return;
    }
    compareDetails.hidden = false;
    if (!compareDetails.open) return;

    if (!compareDirty && lastCompareRows) {
      renderComparison(compareBody, lastCompareRows, traverser.id, selectTraverserFromComparison);
      return;
    }

    compareDirty = false;
    renderComparison(compareBody, null, traverser.id, selectTraverserFromComparison);
    send({
      type: 'compare',
      id: ++compareRequestId,
      mode,
      waypoints: [...waypoints],
      minSeparationM: getMinSeparationM(),
      minTargetStandoffM: getMinTargetStandoffM(),
      roundTrip: roundTripInput.checked,
      optimizeStops: optimizeStopsInput?.checked === true,
      stopWorkS: currentStopWorkS(),
      allowNoData: allowNoDataInput.checked,
      assumedTerrainData: getAssumedTerrainData(),
      hasThermalInertiaData: getHasThermalInertia(),
      hasRockData: getHasRockData(),
      entries: traversersList.map((t) => ({
        id: t.id,
        name: traverserShortName(t),
        traverser: routerTraverserFor(t),
        walkBack: walkBackSpecFor(t),
      })),
    });
  };

  compareDetails.addEventListener('toggle', () => {
    if (compareDetails.open) refreshComparison();
  });

  const renderStintStopMarkers = (result: RouteSuccess): void => {
    stintMarkers.splice(0).forEach((m) => m.remove());
    const stops = result.stintStops;
    if (stops.length === 0) return;

    const maxDomMarkers = 16;
    const picked: typeof stops = [];
    if (stops.length <= maxDomMarkers) {
      picked.push(...stops);
    } else {
      // Always keep first and last STOP markers and sample interior markers evenly.
      const lastIdx = stops.length - 1;
      for (let i = 0; i < maxDomMarkers; i++) {
        const idx = i === maxDomMarkers - 1 ? lastIdx : Math.round((i * lastIdx) / (maxDomMarkers - 1));
        const s = stops[idx];
        if (picked[picked.length - 1] !== s) picked.push(s);
      }
    }

    for (const s of picked) {
      const markerEl = document.createElement('div');
      markerEl.className = 'waypoint stint-stop';
      markerEl.textContent = formatStintStopLabel(traverser.id, s.nextStint);
      const kmTxt = (s.dist_m / 1000).toFixed(2);
      markerEl.title = ui(
        `${formatStintStopLabel(traverser.id, s.nextStint)} · ${kmTxt} km · ${formatDuration(s.time_s)}`,
        `${formatStintStopLabel(traverser.id, s.nextStint)} · ${kmTxt} km · ${formatDuration(s.time_s)}`,
      );
      markerEl.setAttribute('aria-label', markerEl.title);
      if (globeMode) markerEl.style.display = 'none';
      stintMarkers.push(new Marker({ element: markerEl }).setLngLat(activeGeo.indexToLonLat(s.cell)).addTo(map));
    }
  };

  const renderSummary = (result: RouteSuccess | null): void => {
    clearTurnAroundMarker();
    lastResult = result && result.legs.length > 0 ? result : null;
    syncButtonsState();

    renderResults(results, lastResult, traverser, activeGrid.egim_taban_uzunlugu_m, activeGrid.hucre_m, (distM) => {
      if (distM === null) {
        updateChartsCursor(results, simPlaying ? simDistM : null);
        return;
      }
      if (!simPlaying) {
        setSimPositionByDist(distM, true);
      }
    });

    if (lastResult) {
      renderStintStopMarkers(lastResult);

      const markerNotes = new Map<number, string[]>();
      const addThresholdNote = (cell: number | null, text: string) => {
        if (cell === null) return;
        const arr = markerNotes.get(cell);
        if (arr) arr.push(text);
        else markerNotes.set(cell, [text]);
      };

      if (lastResult.walkBackExceeded && lastResult.walkBackCell !== null) {
        const wbHours = lastResult.walkBackLimit_s ? Number((lastResult.walkBackLimit_s / 3600).toFixed(2)) : 0;
        addThresholdNote(
          lastResult.walkBackCell,
          ui(
            `Broken condition: time — walk-back survival limit (${wbHours} h) exceeded beyond ~${Math.round(lastResult.walkBackDist_m ?? 0)} m`,
            `Bozulan koşul: süre — walk-back limiti (${wbHours} sa) ~${Math.round(lastResult.walkBackDist_m ?? 0)} m sonrası aşıldı`,
          ),
        );
      }
      if (lastResult.radialCapExceeded && lastResult.radialCapCell !== null) {
        const capKm = lastResult.radialCapLimit_m ? Number((lastResult.radialCapLimit_m / 1000).toFixed(2)) : 10;
        addThresholdNote(
          lastResult.radialCapCell,
          ui(
            `Broken condition: distance — > ${capKm} km radial standoff cap exceeded beyond ~${Math.round(lastResult.radialCapDist_m ?? 0)} m`,
            `Bozulan koşul: mesafe — > ${capKm} km kuş uçuşu tavanı ~${Math.round(lastResult.radialCapDist_m ?? 0)} m sonrası aşıldı`,
          ),
        );
      }
      if (lastResult.totalDistExceeded && lastResult.totalDistCell !== null) {
        const capKm = lastResult.totalDistCap_m ? Number((lastResult.totalDistCap_m / 1000).toFixed(2)) : 0;
        addThresholdNote(
          lastResult.totalDistCell,
          ui(
            `Broken condition: distance — total rover range cap (${capKm} km) exceeded beyond ~${Math.round(lastResult.totalDistThreshold_m ?? 0)} m`,
            `Bozulan koşul: mesafe — toplam menzil sınırı (${capKm} km) ~${Math.round(lastResult.totalDistThreshold_m ?? 0)} m sonrası aşıldı`,
          ),
        );
      }
      if (lastResult.turnAroundCell !== null && lastResult.turnAroundCell !== lastResult.walkBackCell) {
        const limitLabel = traverser.azami_sure_saat ? `${traverser.azami_sure_saat} h` : 'max';
        addThresholdNote(
          lastResult.turnAroundCell,
          ui(
            `Broken condition: time — max mission duration (${limitLabel}) reached around ${Math.round(lastResult.turnAroundDist_m ?? 0)} m`,
            `Bozulan koşul: süre — azami süre (${limitLabel}) ~${Math.round(lastResult.turnAroundDist_m ?? 0)} m civarında doldu`,
          ),
        );
      }
      if (lastResult.energyExceeded && lastResult.energyCell !== null) {
        addThresholdNote(
          lastResult.energyCell,
          ui(
            `Broken condition: energy — usable battery (${Math.round(lastResult.energyUsable_wh ?? 0)} Wh above reserve) exhausted around ~${Math.round(lastResult.energyDist_m ?? 0)} m`,
            `Bozulan koşul: enerji — rezerv üstü kullanılabilir batarya (${Math.round(lastResult.energyUsable_wh ?? 0)} Wh) ~${Math.round(lastResult.energyDist_m ?? 0)} m civarında bitti`,
          ),
        );
      }

      for (const [cell, notes] of markerNotes) {
        const markerNode = document.createElement('div');
        markerNode.className = 'waypoint turnaround';
        markerNode.textContent = '!';
        const title = notes.join(' · ');
        markerNode.title = title;
        markerNode.setAttribute('aria-label', title);
        if (globeMode) markerNode.style.display = 'none';
        const pathIdx = lastResult.path.indexOf(cell);
        const lngLat =
          pathIdx >= 0 ? coordAt(lastResult.path, pathIdx, lastResult.pathCols, lastResult.pathRows) : activeGeo.indexToLonLat(cell);
        turnAroundMarkers.push(new Marker({ element: markerNode }).setLngLat(lngLat).addTo(map));
      }

      // Initialize vehicle marker smoothly at route start
      simPhase = 'route';
      simElapsedS = 0;
      simDistM = 0;
      simIdx = 0;
      setSimPositionByDist(0, true);
    } else {
      removeSimMarker();
    }

    renderDockSummary();
    refreshComparison();
  };

  const syncModeButtons = (): void => {
    modeGroup.hidden = !hasLandingGrid;
    modeAutoBtn.classList.toggle('active', mode === 'auto-landing');
    modeManualBtn.classList.toggle('active', mode === 'manual');
  };

  const requestRoute = (): void => {
    stopPlayback();
    clearFaultState(false);
    renderMarkers();
    if (!ready) return;
    if (waypoints.length === 0) {
      clearLandingUI();
      setLine(null);
      renderSummary(null);
      showMessage('');
      return;
    }
    if (mode === 'auto-landing' || waypoints.length > 1) {
      if (!elevationRequestedOnce) {
        showMessage(
          mode === 'auto-landing'
            ? ui('Loading elevation data & finding safe landing sites…', 'Yükseklik verisi yükleniyor ve güvenli iniş alanı aranıyor…')
            : ui('Loading elevation data & calculating route…', 'Yükseklik verisi yükleniyor ve rota hesaplanıyor…'),
        );
      } else {
        showMessage(
          mode === 'auto-landing'
            ? ui('Finding safe landing sites and route…', 'Güvenli iniş alanı ve rota hesaplanıyor…')
            : ui('Calculating route…', 'Rota hesaplanıyor…'),
        );
      }
    } else {
      clearLandingUI();
      setLine(null);
      renderSummary(null);
      showMessage('');
    }
    send({
      type: 'route',
      id: ++requestId,
      mode,
      waypoints: [...waypoints],
      chosenLandingCell,
      minSeparationM: getMinSeparationM(),
      minTargetStandoffM: getMinTargetStandoffM(),
      roundTrip: roundTripInput.checked,
      optimizeStops: optimizeStopsInput?.checked === true,
      stopWorkS: currentStopWorkS(),
      allowNoData: allowNoDataInput.checked,
      assumedTerrainData: getAssumedTerrainData(),
      hasThermalInertiaData: getHasThermalInertia(),
      hasRockData: getHasRockData(),
      traverser: routerTraverserFor(traverser),
      walkBack: walkBackSpecFor(traverser),
    });
  };

  // ------------------------------------------------------------ terrain HUD
  let pendingProbeLonLat: LonLat | null = null;
  let lastProbeLonLat: LonLat | null = null;
  let probeRaf = false;

  const scheduleProbe = (lonLat: LonLat): void => {
    pendingProbeLonLat = lonLat;
    if (probeRaf) return;
    probeRaf = true;
    requestAnimationFrame(() => {
      probeRaf = false;
      if (globeMode) {
        if (terrainHud) terrainHud.hidden = true;
        return;
      }
      if (!ready || !pendingProbeLonLat) return;
      const [lon, lat] = pendingProbeLonLat;
      const cell = activeGeo.lonLatToIndex(lon, lat);
      if (cell === null) {
        if (terrainHud) terrainHud.hidden = true;
        return;
      }
      lastProbeLonLat = [lon, lat];
      send({ type: 'probe', cell });
    });
  };

  map.on('mousemove', (event: MapMouseEvent) => scheduleProbe([event.lngLat.lng, event.lngLat.lat]));
  map.getCanvas().addEventListener('mouseleave', () => {
    if (terrainHud) terrainHud.hidden = true;
  });

  const renderProbeHud = (msg: Extract<FromWorker, { type: 'probe-result' }>): void => {
    if (!terrainHud || !lastProbeLonLat) return;
    terrainHud.replaceChildren();

    const parts: HTMLSpanElement[] = [];
    parts.push(hudSpan(formatMarsCoord(lastProbeLonLat[0], lastProbeLonLat[1]), 'hud-muted'));

    if (msg.slopeDeg === null) {
      parts.push(hudSpan(ui('Slope: no data', 'Eğim: veri yok'), 'hud-muted'));
    } else {
      const prefix = msg.slopeAtOrAboveMaxByte ? '≥ ' : '';
      const overLimit = msg.slopeDeg > traverser.azami_egim_derece;
      parts.push(hudSpan(`${ui('Slope', 'Eğim')}: ${prefix}${msg.slopeDeg.toFixed(1)}°`, overLimit ? 'hud-bad' : undefined));
    }

    if (msg.hazardClass === 0) parts.push(hudSpan(ui('Hazard: Free', 'Tehlike: Açık'), 'hud-ok'));
    else if (msg.hazardClass === 1) parts.push(hudSpan(ui('Hazard: Caution', 'Tehlike: Dikkat'), 'hud-warn'));
    else if (msg.hazardClass === 2) parts.push(hudSpan(ui('Hazard: Forbidden', 'Tehlike: Yasak'), 'hud-bad'));
    else parts.push(hudSpan(ui('Hazard: No data', 'Tehlike: Veri yok'), 'hud-muted'));

    if (msg.landingClass !== null) {
      if (msg.landingClass === 0) parts.push(hudSpan(ui('Landing: Suitable', 'İniş: Uygun'), 'hud-ok'));
      else if (msg.landingClass === 1) parts.push(hudSpan(ui('Landing: Marginal', 'İniş: Sınırda'), 'hud-warn'));
      else if (msg.landingClass === 2) parts.push(hudSpan(ui('Landing: Unsuitable', 'İniş: Uygunsuz'), 'hud-muted'));
      else parts.push(hudSpan(ui('Landing: No data', 'İniş: Veri yok'), 'hud-muted'));
    }

    if (msg.elevLoaded) {
      parts.push(
        msg.elevM !== null
          ? hudSpan(`${ui('Elev', 'Yükseklik')}: ${Math.round(msg.elevM)} m`)
          : hudSpan(ui('Elev: no data', 'Yükseklik: veri yok'), 'hud-muted'),
      );
    }

    if (msg.thermalInertia !== null) {
      const tiBand =
        msg.thermalInertia < (options.ground?.tiVeryLooseThreshold ?? 200)
          ? 'hud-bad'
          : msg.thermalInertia < (options.ground?.tiLooseThreshold ?? 350)
          ? 'hud-warn'
          : 'hud-ok';
      parts.push(hudSpan(`TI: ${Math.round(msg.thermalInertia)}`, tiBand));
    }

    parts.forEach((part, idx) => {
      if (idx > 0) terrainHud.append(hudSpan(' · ', 'hud-muted'));
      terrainHud.append(part);
    });
    terrainHud.hidden = false;
  };

  // ------------------------------------------------------------ worker messages
  worker.onmessage = (event: MessageEvent<FromWorker>) => {
    const msg = event.data;
    if (msg.type === 'load-progress') {
      progressWrap.hidden = false;
      progressBar.style.width = `${msg.percent}%`;
      if (msg.phase === 'terrain') {
        const text =
          msg.totalBytes > 0
            ? ui(
                `Loading terrain data… ${msg.percent}% (${fmtMB(msg.loadedBytes)} / ${fmtMB(msg.totalBytes)} MB)`,
                `Arazi verisi yükleniyor… %${msg.percent} (${fmtMB(msg.loadedBytes)} / ${fmtMB(msg.totalBytes)} MB)`,
              )
            : ui(`Loading terrain data… ${msg.percent}%`, `Arazi verisi yükleniyor… %${msg.percent}`);
        showMessage(text, 'info');
        if (!startupDone) options.onStartupProgress?.(text, 20 + Math.round(msg.percent * 0.8));
      } else {
        const text =
          msg.totalBytes > 0
            ? ui(
                `Loading elevation data… ${msg.percent}% (${fmtMB(msg.loadedBytes)} / ${fmtMB(msg.totalBytes)} MB)`,
                `Yükseklik verisi yükleniyor… %${msg.percent} (${fmtMB(msg.loadedBytes)} / ${fmtMB(msg.totalBytes)} MB)`,
              )
            : ui(`Loading elevation data… ${msg.percent}%`, `Yükseklik verisi yükleniyor… %${msg.percent}`);
        showMessage(text, 'info');
      }
      return;
    }

    if (msg.type === 'ready') {
      ready = true;
      startupDone = true;
      progressWrap.hidden = true;
      options.onStartupProgress?.('', 100);
      hasLandingGrid = msg.hasLanding;
      mode = hasLandingGrid ? 'auto-landing' : 'manual';
      syncModeButtons();
      showMessage('');
      if (pendingSampleMission) {
        pendingSampleMission = false;
        triggerSampleMission();
      } else {
        requestRoute();
      }
      return;
    }

    if (msg.type === 'init-error') {
      startupDone = true;
      pendingSampleMission = false;
      progressWrap.hidden = true;
      options.onStartupProgress?.('');
      showMessage(ui(`Route planning is unavailable: ${msg.message}`, `Rota planlama kullanılamıyor: ${msg.message}`), 'error');
      options.onFatalError?.(msg.message);
      return;
    }

    if (msg.type === 'probe-result') {
      renderProbeHud(msg);
      return;
    }

    if (msg.type === 'escape-result') {
      if (!faultState || msg.id !== faultState.escapeRequestId) return;
      faultState.pendingEscape = false;
      faultState.escapeResult = msg;
      if (msg.ok) {
        setEscapeLine(msg.path, msg.pathCols, msg.pathRows);
      } else {
        clearEscapeLine();
      }
      renderFaultCard();
      return;
    }

    if (msg.type === 'compare-result') {
      if (msg.id !== compareRequestId) return;
      lastCompareRows = msg.rows;
      if (compareDetails.open) {
        renderComparison(compareBody, lastCompareRows, traverser.id, selectTraverserFromComparison);
      }
      return;
    }

    if (msg.id !== requestId) return;
    progressWrap.hidden = true;

    if (msg.ok) {
      if (msg.legs.length > 0) elevationRequestedOnce = true;
      renderLandingCandidates(msg.landingCandidates, msg.activeLandingCell);
      setLine(msg.path, msg.unsafeMask, null, msg.pathCols, msg.pathRows);
      renderSummary(msg);
      if (fitToResultOnce && msg.path.length > 0 && !globeMode) {
        fitToResultOnce = false;
        const b = new LngLatBounds();
        for (let i = 0; i < msg.path.length; i++) b.extend(coordAt(msg.path, i, msg.pathCols, msg.pathRows));
        for (const cand of msg.landingCandidates) b.extend(activeGeo.indexToLonLat(cand.cell));
        map.fitBounds(b, { padding: 72, maxZoom: activeScenario === 'rover' ? 16 : 14 });
      }
      if (pendingNotice) showMessage(pendingNotice, 'error');
      else showMessage('');
      pendingNotice = '';
      lastActionWasAdd = false;
      return;
    }

    fitToResultOnce = false;
    const noDataClause = !allowNoDataInput.checked ? ui(', unmapped terrain,', ', haritasız arazi,') : '';

    if (msg.reason === 'blocked-waypoint') {
      const stopNum = mode === 'auto-landing' ? msg.waypointIndex + 1 : msg.waypointIndex;
      const name = mode === 'manual' && msg.waypointIndex === 0 ? ui('The start point', 'Başlangıç noktası') : ui(`Science stop ${stopNum}`, `${stopNum}. Bilim durağı`);
      const why =
        msg.why === 'forbidden'
          ? ui('is in a forbidden area', 'yasak bölgede')
          : msg.why === 'no-data'
          ? ui(
              'is in an unmapped (no-data) area while crossing unmapped terrain is turned off',
              'haritasız (veri yok) bölgede ve haritasız geçiş kapalı',
            )
          : ui(
              `is on a slope steeper than the ${traverser.azami_egim_derece}° limit for "${traverser.ad_en}"`,
              `"${traverserShortName(traverser)}" için ${traverser.azami_egim_derece}° eğim sınırından dik bir yamaçta`,
            );
      const justAdded = lastActionWasAdd && msg.waypointIndex === waypoints.length - 1;
      if (justAdded) {
        waypoints.pop();
        names.pop();
        lastActionWasAdd = false;
        invalidateComparison();
        const notice = ui(
          `That point ${why}, so it was not added. Pick another point.`,
          `Bu nokta ${why} olduğu için eklenmedi. Başka bir nokta seçin.`,
        );
        if (waypoints.length > 0) {
          pendingNotice = notice;
          showMessage(notice, 'error');
          requestRoute();
        } else {
          clearLandingUI();
          setLine(null);
          renderSummary(null);
          renderMarkers();
          showMessage(notice, 'error');
        }
      } else {
        lastActionWasAdd = false;
        clearLandingUI();
        setLine(null);
        renderSummary(null);
        showMessage(
          ui(
            `${name} ${why}. Remove it, adjust mission options, or choose another traverser.`,
            `${name} ${why}. Kaldırın, seçenekleri değiştirin veya başka araç seçin.`,
          ),
          'error',
        );
      }
    } else if (msg.reason === 'no-landing') {
      const limitText =
        msg.withinRangeChecked && traverser.azami_sure_saat
          ? ui(
              ` within the ${traverser.azami_sure_saat} h mission budget of "${traverser.ad_en}"`,
              ` (${traverser.azami_sure_saat} sa bütçe içinde)`,
            )
          : '';
      if (lastActionWasAdd && waypoints.length === 1) {
        waypoints.pop();
        names.pop();
        chosenLandingCell = null;
        lastActionWasAdd = false;
        invalidateComparison();
        clearLandingUI();
        setLine(null);
        renderSummary(null);
        renderMarkers();
        showMessage(
          ui(
            `No suitable or marginal landing zone can reach that target${limitText} without crossing forbidden terrain${noDataClause} or slopes above ${traverser.azami_egim_derece}°. Pick another target or traverser.`,
            `Yasak alan${noDataClause} veya ${traverser.azami_egim_derece}° üstü eğimleri aşmadan bu hedefe ulaşabilecek${limitText} uygun/sınırda iniş alanı bulunamadı.`,
          ),
          'error',
        );
      } else {
        lastActionWasAdd = false;
        clearLandingUI();
        setLine(null);
        renderSummary(null);
        showMessage(
          ui(
            `No suitable or marginal landing zone can reach Stop 1${limitText} without crossing forbidden terrain${noDataClause} or slopes above ${traverser.azami_egim_derece}°. Try another target, mission setting, or traverser.`,
            `1. durağa ulaşabilecek${limitText} iniş alanı bulunamadı. Başka bir hedef veya araç deneyin.`,
          ),
          'error',
        );
      }
    } else {
      if (lastActionWasAdd && waypoints.length > 1) {
        waypoints.pop();
        names.pop();
        lastActionWasAdd = false;
        invalidateComparison();
        const notice = ui(
          `No passable route could reach that point (blocked by forbidden terrain${noDataClause} or slopes above ${traverser.azami_egim_derece}° for "${traverser.ad_en}"), so it was not added.`,
          `Bu noktaya geçilebilir rota bulunamadı (${traverser.azami_egim_derece}° üstü eğim veya yasak arazi), nokta eklenmedi.`,
        );
        pendingNotice = notice;
        showMessage(notice, 'error');
        requestRoute();
      } else {
        lastActionWasAdd = false;
        clearLandingUI();
        setLine(null);
        renderSummary(null);
        if (msg.isReturnLeg) {
          const dest = mode === 'auto-landing' ? ui('the landing zone', 'iniş alanına') : ui('the start', 'başlangıca');
          showMessage(
            ui(
              `No return route found back to ${dest}: every path is blocked by forbidden terrain${noDataClause} or slopes above ${traverser.azami_egim_derece}°.`,
              `${dest} dönüş rotası bulunamadı: tüm yollar engelli.`,
            ),
            'error',
          );
        } else {
          const from =
            mode === 'auto-landing'
              ? msg.legIndex === 0
                ? ui('the landing zone', 'iniş alanından')
                : ui(`Stop ${msg.legIndex}`, `${msg.legIndex}. duraktan`)
              : msg.legIndex === 0
              ? ui('the start', 'başlangıçtan')
              : ui(`Stop ${msg.legIndex}`, `${msg.legIndex}. duraktan`);
          showMessage(
            ui(
              `No route found from ${from} to Stop ${msg.legIndex + 1}: every path is blocked by forbidden terrain${noDataClause} or slopes above the ${traverser.azami_egim_derece}° limit for "${traverser.ad_en}".`,
              `${from} ${msg.legIndex + 1}. durağa rota bulunamadı (${traverser.azami_egim_derece}° üstü eğim veya yasak bölge).`,
            ),
            'error',
          );
        }
      }
    }
  };

  worker.onerror = (event) => {
    progressWrap.hidden = true;
    options.onStartupProgress?.('');
    const msg = event.message || ui('Route worker crashed', 'Rota hesaplayıcı beklenmedik şekilde durdu');
    showMessage(ui(`Route planning failed: ${msg}`, `Rota planlama hatası: ${msg}`), 'error');
    options.onFatalError?.(msg);
  };

  const postInitWorker = (scenario: 'crewed' | 'rover', targetGrid: GridMeta): void => {
    ready = false;
    elevationRequestedOnce = false;
    send({
      type: 'init',
      scenarioKey: scenario,
      slopeUrl: absoluteUrl(scenario === 'rover' ? FINE_SLOPE_URL : SLOPE_URL),
      hazardUrl: absoluteUrl(scenario === 'rover' ? FINE_HAZARD_URL : HAZARD_URL),
      elevationUrl: absoluteUrl(scenario === 'rover' ? FINE_ELEVATION_URL : ELEVATION_URL),
      ...(scenario === 'crewed' ? { thermalInertiaUrl: absoluteUrl(THERMAL_INERTIA_URL) } : {}),
      landingUrl: absoluteUrl(scenario === 'rover' ? LANDING_ROBOTIC_URL : LANDING_CREWED_URL),
      ...(scenario === 'crewed' ? { fallbackLandingUrl: absoluteUrl(LANDING_FALLBACK_URL) } : {}),
      width: targetGrid.genislik,
      height: targetGrid.yukseklik,
      cellM: targetGrid.hucre_m,
      slopeType: targetGrid.egim_tipi,
      slopeScale: targetGrid.egim_olcek,
      slopeNoData: targetGrid.egim_veri_yok,
      elevType: targetGrid.yukseklik_tipi,
      elevBaseM: targetGrid.yukseklik_taban_m,
      elevScaleM: targetGrid.yukseklik_olcek_m,
      elevNoData: targetGrid.yukseklik_veri_yok,
    });
  };

  showMessage(ui('Loading terrain data… 0%', 'Arazi verisi yükleniyor… %0'));
  options.onStartupProgress?.(ui('Loading terrain data… 0%', 'Arazi verisi yükleniyor… %0'), 20);
  postInitWorker('crewed', activeGrid);

  // ------------------------------------------------------------ interactions
  const setMode = (next: 'auto-landing' | 'manual'): void => {
    if (mode === next) return;
    mode = next;
    chosenLandingCell = null;
    lastActionWasAdd = false;
    pendingNotice = '';
    invalidateComparison();
    syncModeButtons();
    requestRoute();
  };
  modeAutoBtn.addEventListener('click', () => setMode('auto-landing'));
  modeManualBtn.addEventListener('click', () => setMode('manual'));

  const onMissionOptionChange = (): void => {
    lastActionWasAdd = false;
    pendingNotice = '';
    invalidateComparison();
    requestRoute();
  };
  roundTripInput.addEventListener('change', onMissionOptionChange);
  optimizeStopsInput?.addEventListener('change', onMissionOptionChange);
  stopMinInput.addEventListener('change', onMissionOptionChange);
  allowNoDataInput.addEventListener('change', onMissionOptionChange);

  const addPoint = (lonLat: LonLat, name?: string): void => {
    if (globeMode) return;
    scheduleProbe(lonLat);
    if (!ready) {
      showMessage(ui('Terrain data is still loading; please wait a moment.', 'Arazi verisi hâlâ yükleniyor; lütfen bekleyin.'), 'info');
      return;
    }
    const cell = activeGeo.lonLatToIndex(lonLat[0], lonLat[1]);
    if (cell === null) {
      showMessage(ui('That point is outside the mapped area.', 'Bu nokta haritalanan alanın dışında.'), 'error');
      return;
    }
    if (waypoints[waypoints.length - 1] === cell) return;
    if (waypoints.length === 0) chosenLandingCell = null;
    waypoints.push(cell);
    names.push(name ?? null);
    lastActionWasAdd = true;
    pendingNotice = '';
    invalidateComparison();
    requestRoute();
  };
  map.on('click', (event: MapMouseEvent) => {
    if (globeMode) return;
    addPoint([event.lngLat.lng, event.lngLat.lat]);
  });

  const triggerSampleMission = (): void => {
    if (globeMode) options.onRequireLocalView?.();
    if (!ready) {
      pendingSampleMission = true;
      showMessage(
        ui(
          'Terrain data is still loading; the sample mission will open automatically once ready.',
          'Arazi verisi yükleniyor; hazır olduğunda örnek görev otomatik açılacak.',
        ),
        'info',
      );
      return;
    }
    pendingSampleMission = false;
    if (validSampleStops.length === 0) return;
    waypoints.length = 0;
    names.length = 0;
    chosenLandingCell = null;
    lastActionWasAdd = false;
    pendingNotice = '';
    mode = hasLandingGrid ? 'auto-landing' : 'manual';
    syncModeButtons();

    const pickCount = Math.min(2, validSampleStops.length);
    for (let i = 0; i < pickCount; i++) {
      const stop = validSampleStops[i];
      const cell = activeGeo.lonLatToIndex(stop.konum[0], stop.konum[1]);
      if (cell !== null) {
        waypoints.push(cell);
        names.push(stop.ad_en);
      }
    }
    invalidateComparison();
    fitToResultOnce = true;
    requestRoute();
  };

  const triggerUndo = (): void => {
    if (waypoints.length === 0) return;
    waypoints.pop();
    names.pop();
    if (waypoints.length === 0) chosenLandingCell = null;
    lastActionWasAdd = false;
    pendingNotice = '';
    invalidateComparison();
    requestRoute();
  };

  const triggerClear = (): void => {
    pendingSampleMission = false;
    if (waypoints.length === 0) return;
    waypoints.length = 0;
    names.length = 0;
    chosenLandingCell = null;
    lastActionWasAdd = false;
    pendingNotice = '';
    invalidateComparison();
    requestRoute();
  };

  sampleButton.addEventListener('click', triggerSampleMission);
  topSampleBtn?.addEventListener('click', triggerSampleMission);
  undoButton.addEventListener('click', triggerUndo);
  topUndoBtn?.addEventListener('click', triggerUndo);
  clearButton.addEventListener('click', triggerClear);
  topClearBtn?.addEventListener('click', triggerClear);

  // ------------------------------------------------------------ GeoJSON export
  const round = (value: number, digits: number): number => Number(value.toFixed(digits));
  const coordinate = (cell: number): LonLat => {
    const [lon, lat] = activeGeo.indexToLonLat(cell);
    return [round(lon, 7), round(lat, 7)];
  };

  downloadButton.addEventListener('click', () => {
    const result = lastResult;
    if (!result) return;
    const landingFeatures =
      result.mode === 'auto-landing'
        ? result.landingCandidates.map((cand, idx) => ({
            type: 'Feature' as const,
            properties: {
              kind: cand.cell === result.activeLandingCell ? 'selected_landing' : 'backup_landing',
              rank: idx + 1,
              suitability_class: cand.tier === 0 ? 'suitable' : 'marginal',
              distance_to_stop1_m: round(cand.distance_m, 1),
              estimated_time_to_stop1_s: Math.round(cand.time_s),
            },
            geometry: { type: 'Point' as const, coordinates: coordinate(cand.cell) },
          }))
        : [];

    const waypointFeatures = waypoints.map((cell, index) => ({
      type: 'Feature' as const,
      properties: {
        kind: result.mode === 'manual' && index === 0 ? 'start' : 'science_stop',
        order: result.mode === 'auto-landing' ? index + 1 : index,
        name: names[index],
      },
      geometry: { type: 'Point' as const, coordinates: coordinate(cell) },
    }));

    const stintFeatures = result.stintStops.map((s) => ({
      type: 'Feature' as const,
      properties: {
        kind: 'stint_stop',
        next_stint: s.nextStint,
        distance_m: round(s.dist_m, 1),
        estimated_time_s: Math.round(s.time_s),
      },
      geometry: { type: 'Point' as const, coordinates: coordinate(s.cell) },
    }));

    const collection = {
      type: 'FeatureCollection',
      properties: {
        body: 'Mars',
        note: 'Coordinates are Mars [longitude, latitude] in the same system as the map layers, NOT Earth WGS 84. Distances and times were computed on the cost grid, not from these coordinates.',
        scenario: activeScenario,
        synthetic_data: options.synthetic,
        grid_cell_m: activeGrid.hucre_m,
        slope_baseline_m: activeGrid.egim_taban_uzunlugu_m ?? null,
        mode: result.mode,
        round_trip: result.roundTrip,
        allow_no_data: allowNoDataInput.checked,
      },
      features: [
        {
          type: 'Feature',
          properties: {
            kind: 'route',
            scenario: activeScenario,
            traverser_id: traverser.id,
            traverser_name: traverser.ad_en,
            marginal_landing: result.marginalLanding,
            round_trip: result.roundTrip,
            distance_m: round(result.distance_m, 1),
            estimated_time_s: Math.round(result.time_s),
            travel_time_s: Math.round(result.travelTime_s),
            stop_work_time_s: Math.round(result.stopTime_s),
            total_stints: result.totalStints,
            stint_budget_m: result.stintDistBudget_m !== null ? round(result.stintDistBudget_m, 1) : null,
            total_range_cap_m: result.totalDistCap_m !== null ? round(result.totalDistCap_m, 1) : null,
            no_data_m: round(result.noDataM, 1),
            caution_m: round(result.cautionM, 1),
            loose_ground_m: round(result.looseGroundM, 1),
            stop_order_optimized: result.optimizeStopsEnabled && result.stopOrderChanged,
            stop_order: result.stopOrder,
            energy_exceeded: result.energyExceeded,
            decision: result.decision,
            decision_reasons: result.decisionReasons,
            broken_conditions: result.brokenConditions,
            max_radial_distance_m: round(result.maxRadialDist_m, 1),
            ...(result.radialCapLimit_m !== null
              ? {
                  radial_cap_m: round(result.radialCapLimit_m, 1),
                  radial_cap_exceeded: result.radialCapExceeded,
                  radial_cap_threshold_m: result.radialCapDist_m !== null ? round(result.radialCapDist_m, 1) : null,
                }
              : {}),
            ...(result.walkBackLimit_s !== null
              ? {
                  walk_back_limit_s: Math.round(result.walkBackLimit_s),
                  walk_back_exceeded: result.walkBackExceeded,
                  walk_back_threshold_m: result.walkBackDist_m !== null ? round(result.walkBackDist_m, 1) : null,
                }
              : {}),
            ...(traverser.enerji_profili
              ? (() => {
                  const e = computeDemoEnergy(result, traverser.enerji_profili);
                  return {
                    demo_energy_profile: e.profileName,
                    demo_energy_used_wh: Math.round(e.usedWh),
                    demo_energy_remaining_wh: Math.round(e.remainingWh),
                    demo_energy_reserve_wh: Math.round(e.reserveWh),
                  };
                })()
              : {}),
            legs: result.legs.map((leg) => ({
              distance_m: round(leg.distance_m, 1),
              estimated_time_s: Math.round(leg.time_s),
              is_return: Boolean(leg.isReturn),
            })),
          },
          geometry: {
            type: 'LineString',
            coordinates: Array.from(result.path, (_, k) => {
              const [lon, lat] = coordAt(result.path, k, result.pathCols, result.pathRows);
              return [round(lon, 7), round(lat, 7)] as LonLat;
            }),
          },
        },
        ...landingFeatures,
        ...waypointFeatures,
        ...stintFeatures,
      ],
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(collection, null, 2)], { type: 'application/geo+json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'marswalk-route.geojson';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  // React to EN/TR switch dynamically
  onLangChange(() => {
    renderMarkers();
    renderDockSummary();
    renderFaultCard();
    if (lastResult) {
      renderStintStopMarkers(lastResult);
      renderLandingCandidates(lastResult.landingCandidates, lastResult.activeLandingCell);
      renderResults(results, lastResult, traverser, activeGrid.egim_taban_uzunlugu_m, activeGrid.hucre_m, (distM) => {
        if (distM === null) {
          updateChartsCursor(results, simPlaying ? simDistM : null);
          return;
        }
        if (!simPlaying) setSimPositionByDist(distM, true);
      });
      if (lastCompareRows && compareDetails.open) {
        renderComparison(compareBody, lastCompareRows, traverser.id, selectTraverserFromComparison);
      }
    }
    if (lastMessage.text) showMessage(lastMessage.text, lastMessage.kind);
  });

  renderMarkers();

  const applyMarkerGlobeVisibility = (): void => {
    const disp = globeMode ? 'none' : '';
    for (const m of markers) m.getElement().style.display = disp;
    for (const m of landingMarkers) m.getElement().style.display = disp;
    for (const m of turnAroundMarkers) m.getElement().style.display = disp;
    for (const m of stintMarkers) m.getElement().style.display = disp;
    if (simMarker) simMarker.getElement().style.display = disp;
    if (faultMarker) faultMarker.getElement().style.display = disp;
    if (terrainHud && globeMode) terrainHud.hidden = true;
    if (emptyPrompt) emptyPrompt.hidden = globeMode || !startupDone || waypoints.length > 0;
    if (missionDock) {
      if (globeMode) missionDock.hidden = true;
      else renderDockSummary();
    }
  };

  return {
    addPoint,
    syncCollapsedAlert,
    setGlobeMode(isGlobe: boolean) {
      if (globeMode === isGlobe) return;
      globeMode = isGlobe;
      applyMarkerGlobeVisibility();
    },
    setScenario(nextScenario, nextGrid, nextGeo, nextLandingCraft, activeTraverser, effectiveTraversers) {
      stopPlayback();
      clearFaultState(false);

      const convertedWaypoints: number[] = [];
      const convertedNames: (string | null)[] = [];
      for (let i = 0; i < waypoints.length; i++) {
        const [lon, lat] = activeGeo.indexToLonLat(waypoints[i]);
        const mapped = nextGeo.lonLatToIndex(lon, lat);
        if (mapped !== null) {
          convertedWaypoints.push(mapped);
          convertedNames.push(names[i]);
        }
      }
      waypoints.splice(0, waypoints.length, ...convertedWaypoints);
      names.splice(0, names.length, ...convertedNames);
      chosenLandingCell = null;
      lastActionWasAdd = false;
      pendingNotice = '';

      activeScenario = nextScenario;
      activeGrid = nextGrid;
      activeGeo = nextGeo;
      activeLandingCraft = nextLandingCraft;
      traversersList = [...effectiveTraversers];
      traverser = activeTraverser;

      refreshValidSampleStops();
      clearLandingUI();
      setLine(null);
      renderSummary(null);
      renderMarkers();
      invalidateComparison();
      postInitWorker(nextScenario, nextGrid);
    },
    setTraverser(next) {
      traverser = next;
      lastActionWasAdd = false;
      pendingNotice = '';
      invalidateComparison();
      requestRoute();
    },
    setTraversersAndActive(effectiveList, active) {
      traversersList = effectiveList;
      traverser = active;
      lastActionWasAdd = false;
      pendingNotice = '';
      invalidateComparison();
      requestRoute();
    },
  };
}
