// AI-assisted code: written with Claude (Anthropic) and Antigravity (Google DeepMind), reviewed by the team.
//
// Route & landing planning UI:
//   - Auto-landing mode (default when inis.bin exists): tap a science target on
//     the map; the Web Worker recommends the closest safe landing site plus
//     separated backups via reverse Dijkstra, and draws the route.
//   - Manual mode: tap the start point first, then science stops.
//   - Mission options: round-trip return, per-stop work duration, unmapped
//     (no-data) terrain policy, live Mars terrain HUD, sample mission, and
//     all-traverser mission comparison.

import { LngLatBounds, Marker, type GeoJSONSource, type Map as MlMap, type MapMouseEvent } from 'maplibre-gl';
import { ELEVATION_URL, HAZARD_URL, LANDING_URL, SLOPE_URL } from './config';
import type { GridMeta, LandingCraftParams, LonLat, ScienceStop, Traverser } from './data';
import type { GridGeo } from './grid';
import { computeDemoEnergy, formatDuration, renderComparison, renderResults } from './results';
import { findWalkBackReference } from './traverser';
import type {
  FromWorker,
  LandingCandidate,
  RouteSuccess,
  RouterTraverser,
  ToWorker,
  TraverserComparisonRow,
  WalkBackSpec,
} from './route-types';

const ROUTE_SOURCE = 'route';
const ROUTE_UNSAFE_SOURCE = 'route-unsafe-src';

const absoluteUrl = (url: string): string => new URL(url, document.baseURI).href;
const fmtMB = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);

function toRouterTraverser(t: Traverser): RouterTraverser {
  return {
    maxSlopeDeg: t.azami_egim_derece,
    speedTable: t.hiz_tablosu.map((entry): [number, number] => [entry.egim_derece, entry.hiz_m_s]),
    maxTimeS:
      typeof t.azami_sure_saat === 'number' && Number.isFinite(t.azami_sure_saat) && t.azami_sure_saat > 0
        ? t.azami_sure_saat * 3600
        : null,
    maxRadialDistM:
      typeof t.uzaklik_tavani_m === 'number' && Number.isFinite(t.uzaklik_tavani_m) && t.uzaklik_tavani_m > 0
        ? t.uzaklik_tavani_m
        : null,
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
  /** Adds a point (science target/stop in auto-landing mode; start then stops in manual mode). */
  addPoint(lonLat: LonLat, name?: string): void;
  /** Syncs the floating map alert banner when the side panel is collapsed/expanded. */
  syncCollapsedAlert(): void;
}

export interface RouteOptions {
  /** True while any loaded file is marked synthetic; recorded in the exported GeoJSON. */
  synthetic: boolean;
  /** Landing craft parameters from mobilite_parametreleri.json (drives backup separation). */
  landingCraft: LandingCraftParams | null;
  /** All loaded traversers from mobilite_parametreleri.json (for multi-traverser comparison). */
  traversers: Traverser[];
  /** Predefined science stops from duraklar.json (for 1-click sample mission). */
  stops: ScienceStop[];
  /** Programmatically switches the active traverser in the selector radio group. */
  onSelectTraverser?: (id: string) => void;
  /** Reports startup terrain download progress to the main map status overlay. */
  onStartupProgress?: (text: string) => void;
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

  // ------------------------------------------------------------ state
  let traverser = initialTraverser;
  let hasLandingGrid = false;
  let mode: 'auto-landing' | 'manual' = 'manual';
  const waypoints: number[] = [];
  /** Name of each waypoint when it came from a predefined science stop, else null. */
  const names: (string | null)[] = [];
  let chosenLandingCell: number | null = null;
  let lastResult: RouteSuccess | null = null;
  const markers: Marker[] = [];
  const landingMarkers: Marker[] = [];
  const turnAroundMarkers: Marker[] = [];
  let ready = false;
  let startupDone = false;
  let elevationRequestedOnce = false;
  let requestId = 0;
  let compareRequestId = 0;
  let compareDirty = true;
  let lastCompareRows: TraverserComparisonRow[] | null = null;
  let lastActionWasAdd = false;
  let pendingNotice = '';
  let fitToResultOnce = false;

  // Minimum centre-to-centre distance between primary and backup landing zones (from JSON, never hardcoded).
  const minSeparationM = options.landingCraft?.guvenli_alan_capi_m ?? 0;
  const assumedTerrainData = !(grid.kaya_verisi_var && grid.termal_atalet_verisi_var);

  const validSampleStops = options.stops.filter((s) => geo.lonLatToIndex(s.konum[0], s.konum[1]) !== null);
  sampleRow.hidden = validSampleStops.length === 0;

  const currentStopWorkS = (): number => {
    const mins = Number(stopMinInput.value);
    if (!Number.isFinite(mins) || mins <= 0) return 0;
    return Math.min(240, mins) * 60;
  };

  const invalidateComparison = (): void => {
    compareDirty = true;
    lastCompareRows = null;
  };

  const walkBackSpecFor = (t: Traverser): WalkBackSpec | null => {
    const wb = findWalkBackReference(options.traversers, t);
    if (!wb) return null;
    return { traverser: toRouterTraverser(wb.walker), limitS: wb.limitHours * 3600 };
  };

  // ------------------------------------------------------------ map layers
  map.addSource(ROUTE_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addSource(ROUTE_UNSAFE_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
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
    paint: { 'line-color': '#4fd8ff', 'line-width': 3.5 },
  });
  map.addLayer({
    id: 'route-unsafe',
    type: 'line',
    source: ROUTE_UNSAFE_SOURCE,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#ff6b6b', 'line-width': 3.8, 'line-dasharray': [2, 1.6] },
  });

  const setLine = (path: Int32Array | null, unsafeMask?: Uint8Array | null): void => {
    const coordinates = path ? Array.from(path, (cell) => geo.indexToLonLat(cell)) : [];
    (map.getSource(ROUTE_SOURCE) as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: coordinates.length >= 2 ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } }] : [],
    });

    const unsafeFeatures: { type: 'Feature'; properties: Record<string, never>; geometry: { type: 'LineString'; coordinates: LonLat[] } }[] = [];
    if (path && unsafeMask && unsafeMask.length === path.length && coordinates.length >= 2) {
      let seg: LonLat[] = [];
      for (let k = 0; k < unsafeMask.length; k++) {
        if (unsafeMask[k] === 1) {
          if (seg.length === 0 && k > 0) seg.push(coordinates[k - 1]);
          seg.push(coordinates[k]);
        } else if (seg.length > 0) {
          if (seg.length >= 2) {
            unsafeFeatures.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: seg } });
          }
          seg = [];
        }
      }
      if (seg.length >= 2) {
        unsafeFeatures.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: seg } });
      }
    }
    (map.getSource(ROUTE_UNSAFE_SOURCE) as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: unsafeFeatures,
    });
  };

  // ------------------------------------------------------------ rendering
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
    mapAlert.title = 'Click to open the route panel';
    mapAlert.addEventListener('click', () => {
      panelEl?.classList.remove('collapsed');
      panelToggleBtn?.setAttribute('aria-expanded', 'true');
      syncCollapsedAlert();
    });
  }

  const showMessage = (text: string, kind: 'info' | 'warn' | 'error' = 'info'): void => {
    message.textContent = text;
    message.dataset.kind = kind;
    message.hidden = text === '';
    syncCollapsedAlert();
  };

  const clearTurnAroundMarker = (): void => {
    turnAroundMarkers.splice(0).forEach((m) => m.remove());
  };

  const clearLandingUI = (): void => {
    landingMarkers.splice(0).forEach((m) => m.remove());
    landingBox.replaceChildren();
    landingBox.hidden = true;
  };

  const renderLandingCandidates = (candidates: LandingCandidate[], activeCell: number | null): void => {
    clearLandingUI();
    if (mode !== 'auto-landing' || candidates.length === 0) return;

    const heading = document.createElement('h3');
    heading.className = 'landing-heading';
    heading.textContent =
      minSeparationM > 0
        ? `Suggested landing sites (≥ ${minSeparationM} m apart)`
        : 'Suggested landing sites';
    landingBox.append(heading);

    const list = document.createElement('div');
    list.className = 'landing-list';

    candidates.forEach((cand, idx) => {
      const isActive = cand.cell === activeCell;
      const code = idx === 0 ? 'L' : `B${idx}`;
      const roleLabel = idx === 0 ? 'Recommended landing' : `Backup ${idx}`;
      const tierLabel = cand.tier === 0 ? 'Suitable' : 'Marginal';

      // Panel button
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
      stats.textContent = `${Math.round(cand.distance_m)} m · ${formatDuration(cand.time_s)} to Stop 1`;
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

      // Map marker
      const markerEl = document.createElement('button');
      markerEl.type = 'button';
      markerEl.className = `waypoint landing${isActive ? ' active' : ' backup'}${cand.tier === 1 ? ' marginal' : ''}`;
      markerEl.textContent = code;
      markerEl.title = `${roleLabel} (${tierLabel}): ${Math.round(cand.distance_m)} m, ${formatDuration(cand.time_s)} to Stop 1`;
      markerEl.setAttribute('aria-label', markerEl.title);
      markerEl.addEventListener('click', (e) => {
        e.stopPropagation();
        if (chosenLandingCell === cand.cell) return;
        chosenLandingCell = cand.cell;
        lastActionWasAdd = false;
        pendingNotice = '';
        requestRoute();
      });
      landingMarkers.push(new Marker({ element: markerEl }).setLngLat(geo.indexToLonLat(cand.cell)).addTo(map));
    });

    landingBox.append(list);
    landingBox.hidden = false;
  };

  const updateHint = (): void => {
    if (mode === 'auto-landing') {
      hint.textContent =
        waypoints.length === 0
          ? 'Tap a science target on the map; the closest safe landing zone and backups will be suggested automatically.'
          : 'Tap the map to add further science stops, or click a backup landing site (B1 / B2) to switch.';
    } else {
      hint.textContent =
        waypoints.length === 0
          ? 'Tap the map to set the start point.'
          : 'Tap the map to add a science stop. Stops are visited in the order you add them.';
    }
  };

  const renderMarkers = (): void => {
    markers.splice(0).forEach((marker) => marker.remove());
    waypoints.forEach((cell, index) => {
      const element = document.createElement('div');
      const isManualStart = mode === 'manual' && index === 0;
      const stopNum = mode === 'auto-landing' ? index + 1 : index;
      element.className = isManualStart ? 'waypoint start' : 'waypoint';
      element.textContent = isManualStart ? 'S' : String(stopNum);
      const role = isManualStart ? 'Start' : `Science stop ${stopNum}`;
      element.title = names[index] ? `${role}: ${names[index]}` : role;
      markers.push(new Marker({ element }).setLngLat(geo.indexToLonLat(cell)).addTo(map));
    });
    undoButton.disabled = waypoints.length === 0;
    clearButton.disabled = waypoints.length === 0;
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
      const found = options.traversers.find((t) => t.id === id);
      if (found) {
        traverser = found;
        lastActionWasAdd = false;
        pendingNotice = '';
        requestRoute();
      }
    }
  };

  const refreshComparison = (): void => {
    if (!lastResult || waypoints.length === 0 || options.traversers.length < 2) {
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
      minSeparationM,
      roundTrip: roundTripInput.checked,
      stopWorkS: currentStopWorkS(),
      allowNoData: allowNoDataInput.checked,
      assumedTerrainData,
      entries: options.traversers.map((t) => ({
        id: t.id,
        name: t.ad_en,
        traverser: toRouterTraverser(t),
        walkBack: walkBackSpecFor(t),
      })),
    });
  };

  compareDetails.addEventListener('toggle', () => {
    if (compareDetails.open) refreshComparison();
  });

  const renderSummary = (result: RouteSuccess | null): void => {
    clearTurnAroundMarker();
    lastResult = result && result.legs.length > 0 ? result : null;
    downloadButton.disabled = lastResult === null;
    renderResults(results, result, traverser, grid.egim_taban_uzunlugu_m, grid.hucre_m);

    if (lastResult) {
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
          `Broken condition: time — walk-back survival limit (${wbHours} h) exceeded beyond ~${Math.round(lastResult.walkBackDist_m ?? 0)} m`,
        );
      }
      if (lastResult.radialCapExceeded && lastResult.radialCapCell !== null) {
        const capKm = lastResult.radialCapLimit_m ? Number((lastResult.radialCapLimit_m / 1000).toFixed(2)) : 10;
        addThresholdNote(
          lastResult.radialCapCell,
          `Broken condition: distance — > ${capKm} km radial standoff cap exceeded beyond ~${Math.round(lastResult.radialCapDist_m ?? 0)} m`,
        );
      }
      if (lastResult.turnAroundCell !== null && lastResult.turnAroundCell !== lastResult.walkBackCell) {
        const limitLabel = traverser.azami_sure_saat ? `${traverser.azami_sure_saat} h` : 'max';
        addThresholdNote(
          lastResult.turnAroundCell,
          `Broken condition: time — max mission duration (${limitLabel}) reached around ${Math.round(lastResult.turnAroundDist_m ?? 0)} m`,
        );
      }

      for (const [cell, notes] of markerNotes) {
        const el = document.createElement('div');
        el.className = 'waypoint turnaround';
        el.textContent = '!';
        const title = notes.join(' · ');
        el.title = title;
        el.setAttribute('aria-label', title);
        turnAroundMarkers.push(new Marker({ element: el }).setLngLat(geo.indexToLonLat(cell)).addTo(map));
      }
    }

    refreshComparison();
  };

  const syncModeButtons = (): void => {
    modeGroup.hidden = !hasLandingGrid;
    modeAutoBtn.classList.toggle('active', mode === 'auto-landing');
    modeManualBtn.classList.toggle('active', mode === 'manual');
  };

  const requestRoute = (): void => {
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
            ? 'Loading elevation data & finding safe landing sites…'
            : 'Loading elevation data & calculating route…',
        );
      } else {
        showMessage(mode === 'auto-landing' ? 'Finding safe landing sites and route…' : 'Calculating route…');
      }
    } else {
      // Manual mode with only the start point placed so far
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
      minSeparationM,
      roundTrip: roundTripInput.checked,
      stopWorkS: currentStopWorkS(),
      allowNoData: allowNoDataInput.checked,
      assumedTerrainData,
      traverser: toRouterTraverser(traverser),
      walkBack: walkBackSpecFor(traverser),
    });
  };

  // ------------------------------------------------------------ terrain HUD (B3)
  let pendingProbeLonLat: LonLat | null = null;
  let lastProbeLonLat: LonLat | null = null;
  let probeRaf = false;

  const scheduleProbe = (lonLat: LonLat): void => {
    pendingProbeLonLat = lonLat;
    if (probeRaf) return;
    probeRaf = true;
    requestAnimationFrame(() => {
      probeRaf = false;
      if (!ready || !pendingProbeLonLat) return;
      const [lon, lat] = pendingProbeLonLat;
      const cell = geo.lonLatToIndex(lon, lat);
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
      parts.push(hudSpan('Slope: no data', 'hud-muted'));
    } else {
      const prefix = msg.slopeAtOrAboveMaxByte ? '≥ ' : '';
      const overLimit = msg.slopeDeg > traverser.azami_egim_derece;
      parts.push(hudSpan(`Slope: ${prefix}${msg.slopeDeg.toFixed(1)}°`, overLimit ? 'hud-bad' : undefined));
    }

    if (msg.hazardClass === 0) parts.push(hudSpan('Hazard: Free', 'hud-ok'));
    else if (msg.hazardClass === 1) parts.push(hudSpan('Hazard: Caution', 'hud-warn'));
    else if (msg.hazardClass === 2) parts.push(hudSpan('Hazard: Forbidden', 'hud-bad'));
    else parts.push(hudSpan('Hazard: No data', 'hud-muted'));

    if (msg.landingClass !== null) {
      if (msg.landingClass === 0) parts.push(hudSpan('Landing: Suitable', 'hud-ok'));
      else if (msg.landingClass === 1) parts.push(hudSpan('Landing: Marginal', 'hud-warn'));
      else if (msg.landingClass === 2) parts.push(hudSpan('Landing: Unsuitable', 'hud-muted'));
      else parts.push(hudSpan('Landing: No data', 'hud-muted'));
    }

    if (msg.elevLoaded) {
      parts.push(
        msg.elevM !== null ? hudSpan(`Elev: ${Math.round(msg.elevM)} m`) : hudSpan('Elev: no data', 'hud-muted'),
      );
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
            ? `Loading terrain data… ${msg.percent}% (${fmtMB(msg.loadedBytes)} / ${fmtMB(msg.totalBytes)} MB)`
            : `Loading terrain data… ${msg.percent}%`;
        showMessage(text, 'info');
        if (!startupDone) options.onStartupProgress?.(text);
      } else {
        const text =
          msg.totalBytes > 0
            ? `Loading elevation data… ${msg.percent}% (${fmtMB(msg.loadedBytes)} / ${fmtMB(msg.totalBytes)} MB)`
            : `Loading elevation data… ${msg.percent}%`;
        showMessage(text, 'info');
      }
      return;
    }

    if (msg.type === 'ready') {
      ready = true;
      startupDone = true;
      progressWrap.hidden = true;
      options.onStartupProgress?.('');
      hasLandingGrid = msg.hasLanding;
      mode = hasLandingGrid ? 'auto-landing' : 'manual';
      syncModeButtons();
      showMessage('');
      requestRoute();
      return;
    }

    if (msg.type === 'init-error') {
      startupDone = true;
      progressWrap.hidden = true;
      options.onStartupProgress?.('');
      showMessage(`Route planning is unavailable: ${msg.message}`, 'error');
      return;
    }

    if (msg.type === 'probe-result') {
      renderProbeHud(msg);
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

    if (msg.id !== requestId) return; // stale route answer
    progressWrap.hidden = true;

    if (msg.ok) {
      if (msg.legs.length > 0) elevationRequestedOnce = true;
      renderLandingCandidates(msg.landingCandidates, msg.activeLandingCell);
      setLine(msg.path, msg.unsafeMask);
      renderSummary(msg);
      if (fitToResultOnce && msg.path.length > 0) {
        fitToResultOnce = false;
        const b = new LngLatBounds();
        for (let i = 0; i < msg.path.length; i++) b.extend(geo.indexToLonLat(msg.path[i]));
        for (const cand of msg.landingCandidates) b.extend(geo.indexToLonLat(cand.cell));
        map.fitBounds(b, { padding: 56, maxZoom: 14 });
      }
      if (pendingNotice) showMessage(pendingNotice, 'error');
      else showMessage('');
      pendingNotice = '';
      lastActionWasAdd = false;
      return;
    }

    fitToResultOnce = false;
    const noDataClause = !allowNoDataInput.checked ? ', unmapped terrain,' : '';

    if (msg.reason === 'blocked-waypoint') {
      const stopNum = mode === 'auto-landing' ? msg.waypointIndex + 1 : msg.waypointIndex;
      const name = mode === 'manual' && msg.waypointIndex === 0 ? 'The start point' : `Science stop ${stopNum}`;
      const why =
        msg.why === 'forbidden'
          ? 'is in a forbidden area'
          : msg.why === 'no-data'
          ? 'is in an unmapped (no-data) area while crossing unmapped terrain is turned off'
          : `is on a slope steeper than the ${traverser.azami_egim_derece}° limit for "${traverser.ad_en}"`;
      const justAdded = lastActionWasAdd && msg.waypointIndex === waypoints.length - 1;
      if (justAdded) {
        waypoints.pop();
        names.pop();
        lastActionWasAdd = false;
        invalidateComparison();
        const notice = `That point ${why}, so it was not added. Pick another point.`;
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
        showMessage(`${name} ${why}. Remove it, adjust mission options, or choose another traverser.`, 'error');
      }
    } else if (msg.reason === 'no-landing') {
      const limitText =
        msg.withinRangeChecked && traverser.azami_sure_saat
          ? ` within the ${traverser.azami_sure_saat} h mission budget of "${traverser.ad_en}"`
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
          `No suitable or marginal landing zone can reach that target${limitText} without crossing forbidden terrain${noDataClause} or slopes above ${traverser.azami_egim_derece}°. Pick another target or traverser.`,
          'error',
        );
      } else {
        lastActionWasAdd = false;
        clearLandingUI();
        setLine(null);
        renderSummary(null);
        showMessage(
          `No suitable or marginal landing zone can reach Stop 1${limitText} without crossing forbidden terrain${noDataClause} or slopes above ${traverser.azami_egim_derece}°. Try another target, mission setting, or traverser.`,
          'error',
        );
      }
    } else {
      // msg.reason === 'no-route'
      if (lastActionWasAdd && waypoints.length > 1) {
        waypoints.pop();
        names.pop();
        lastActionWasAdd = false;
        invalidateComparison();
        const notice = `No passable route could reach that point (blocked by forbidden terrain${noDataClause} or slopes above ${traverser.azami_egim_derece}° for "${traverser.ad_en}"), so it was not added.`;
        pendingNotice = notice;
        showMessage(notice, 'error');
        requestRoute();
      } else {
        lastActionWasAdd = false;
        clearLandingUI();
        setLine(null);
        renderSummary(null);
        if (msg.isReturnLeg) {
          const dest = mode === 'auto-landing' ? 'the landing zone' : 'the start';
          showMessage(
            `No return route found back to ${dest}: every path is blocked by forbidden terrain${noDataClause} or slopes above ${traverser.azami_egim_derece}°.`,
            'error',
          );
        } else {
          const from =
            mode === 'auto-landing'
              ? msg.legIndex === 0
                ? 'the landing zone'
                : `Stop ${msg.legIndex}`
              : msg.legIndex === 0
              ? 'the start'
              : `Stop ${msg.legIndex}`;
          showMessage(
            `No route found from ${from} to Stop ${msg.legIndex + 1}: every path is blocked by forbidden terrain${noDataClause} or slopes above the ${traverser.azami_egim_derece}° limit for "${traverser.ad_en}".`,
            'error',
          );
        }
      }
    }
  };
  worker.onerror = (event) => {
    progressWrap.hidden = true;
    options.onStartupProgress?.('');
    showMessage(`Route planning failed: ${event.message}`, 'error');
  };

  showMessage('Loading terrain data… 0%');
  options.onStartupProgress?.('Loading terrain data… 0%');
  send({
    type: 'init',
    slopeUrl: absoluteUrl(SLOPE_URL),
    hazardUrl: absoluteUrl(HAZARD_URL),
    elevationUrl: absoluteUrl(ELEVATION_URL),
    landingUrl: absoluteUrl(LANDING_URL),
    width: grid.genislik,
    height: grid.yukseklik,
    cellM: grid.hucre_m,
    slopeType: grid.egim_tipi,
    slopeScale: grid.egim_olcek,
    slopeNoData: grid.egim_veri_yok,
    elevType: grid.yukseklik_tipi,
    elevBaseM: grid.yukseklik_taban_m,
    elevScaleM: grid.yukseklik_olcek_m,
    elevNoData: grid.yukseklik_veri_yok,
  });

  // ------------------------------------------------------------ interaction
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
  stopMinInput.addEventListener('change', onMissionOptionChange);
  allowNoDataInput.addEventListener('change', onMissionOptionChange);

  const addPoint = (lonLat: LonLat, name?: string): void => {
    scheduleProbe(lonLat);
    if (!ready) {
      showMessage('Terrain data is still loading; please wait a moment.', 'info');
      return;
    }
    const cell = geo.lonLatToIndex(lonLat[0], lonLat[1]);
    if (cell === null) {
      showMessage('That point is outside the mapped area.', 'error');
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
  map.on('click', (event: MapMouseEvent) => addPoint([event.lngLat.lng, event.lngLat.lat]));

  sampleButton.addEventListener('click', () => {
    if (!ready) {
      showMessage('Terrain data is still loading; please wait a moment.', 'info');
      return;
    }
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
      const cell = geo.lonLatToIndex(stop.konum[0], stop.konum[1]);
      if (cell !== null) {
        waypoints.push(cell);
        names.push(stop.ad_en);
      }
    }
    invalidateComparison();
    fitToResultOnce = true;
    requestRoute();
  });

  undoButton.addEventListener('click', () => {
    waypoints.pop();
    names.pop();
    if (waypoints.length === 0) chosenLandingCell = null;
    lastActionWasAdd = false;
    pendingNotice = '';
    invalidateComparison();
    requestRoute();
  });
  clearButton.addEventListener('click', () => {
    waypoints.length = 0;
    names.length = 0;
    chosenLandingCell = null;
    lastActionWasAdd = false;
    pendingNotice = '';
    invalidateComparison();
    requestRoute();
  });

  // ------------------------------------------------------------ GeoJSON export
  const round = (value: number, digits: number): number => Number(value.toFixed(digits));
  const coordinate = (cell: number): LonLat => {
    const [lon, lat] = geo.indexToLonLat(cell);
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

    const collection = {
      type: 'FeatureCollection',
      properties: {
        body: 'Mars',
        note: 'Coordinates are Mars [longitude, latitude] in the same system as the map layers, NOT Earth WGS 84. Distances and times were computed on the cost grid, not from these coordinates.',
        synthetic_data: options.synthetic,
        grid_cell_m: grid.hucre_m,
        slope_baseline_m: grid.egim_taban_uzunlugu_m ?? null,
        mode: result.mode,
        round_trip: result.roundTrip,
        allow_no_data: allowNoDataInput.checked,
      },
      features: [
        {
          type: 'Feature',
          properties: {
            kind: 'route',
            traverser_id: traverser.id,
            traverser_name: traverser.ad_en,
            marginal_landing: result.marginalLanding,
            round_trip: result.roundTrip,
            distance_m: round(result.distance_m, 1),
            estimated_time_s: Math.round(result.time_s),
            travel_time_s: Math.round(result.travelTime_s),
            stop_work_time_s: Math.round(result.stopTime_s),
            no_data_m: round(result.noDataM, 1),
            caution_m: round(result.cautionM, 1),
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
          geometry: { type: 'LineString', coordinates: Array.from(result.path, coordinate) },
        },
        ...landingFeatures,
        ...waypointFeatures,
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

  renderMarkers();

  return {
    addPoint,
    syncCollapsedAlert,
    setTraverser(next) {
      traverser = next;
      lastActionWasAdd = false;
      pendingNotice = '';
      requestRoute();
    },
  };
}
