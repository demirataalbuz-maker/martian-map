// AI-assisted code: written with Claude (Anthropic) and Antigravity (Google DeepMind), reviewed by the team.
//
// Route & landing planning UI:
//   - Auto-landing mode (default when inis.bin exists): tap a science target on
//     the map; the Web Worker recommends the closest safe landing site plus
//     separated backups via reverse Dijkstra, and draws the route.
//   - Manual mode: tap the start point first, then science stops.

import { Marker, type GeoJSONSource, type Map as MlMap, type MapMouseEvent } from 'maplibre-gl';
import { ELEVATION_URL, HAZARD_URL, LANDING_URL, SLOPE_URL } from './config';
import type { GridMeta, LandingCraftParams, LonLat, Traverser } from './data';
import type { GridGeo } from './grid';
import { formatDuration, renderResults } from './results';
import type { FromWorker, LandingCandidate, RouteSuccess, RouterTraverser, ToWorker } from './route-types';

const ROUTE_SOURCE = 'route';

const absoluteUrl = (url: string): string => new URL(url, document.baseURI).href;

export interface RouteController {
  setTraverser(traverser: Traverser): void;
  /** Adds a point (science target/stop in auto-landing mode; start then stops in manual mode). */
  addPoint(lonLat: LonLat, name?: string): void;
}

export interface RouteOptions {
  /** True while any loaded file is marked synthetic; recorded in the exported GeoJSON. */
  synthetic: boolean;
  /** Landing craft parameters from mobilite_parametreleri.json (drives backup separation). */
  landingCraft: LandingCraftParams | null;
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
  const hint = root.querySelector<HTMLElement>('#route-hint')!;
  const message = root.querySelector<HTMLElement>('#route-message')!;
  const landingBox = root.querySelector<HTMLElement>('#landing-candidates')!;
  const results = root.querySelector<HTMLElement>('#route-results')!;
  const undoButton = root.querySelector<HTMLButtonElement>('#route-undo')!;
  const clearButton = root.querySelector<HTMLButtonElement>('#route-clear')!;
  const downloadButton = root.querySelector<HTMLButtonElement>('#route-download')!;

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
  let ready = false;
  let elevationRequestedOnce = false;
  let requestId = 0;
  let lastActionWasAdd = false;
  let pendingNotice = '';

  // Minimum centre-to-centre distance between primary and backup landing zones (from JSON, never hardcoded).
  const minSeparationM = options.landingCraft?.guvenli_alan_capi_m ?? 0;

  // ------------------------------------------------------------ map layers
  map.addSource(ROUTE_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
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

  const setLine = (path: Int32Array | null): void => {
    const coordinates = path ? Array.from(path, (cell) => geo.indexToLonLat(cell)) : [];
    (map.getSource(ROUTE_SOURCE) as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: coordinates.length >= 2 ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } }] : [],
    });
  };

  // ------------------------------------------------------------ rendering
  const showMessage = (text: string, kind: 'info' | 'warn' | 'error' = 'info'): void => {
    message.textContent = text;
    message.dataset.kind = kind;
    message.hidden = text === '';
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

  const renderSummary = (result: RouteSuccess | null): void => {
    lastResult = result && result.legs.length > 0 ? result : null;
    downloadButton.disabled = lastResult === null;
    renderResults(results, result, traverser, grid.hucre_m, grid.egim_taban_uzunlugu_m);
  };

  const syncModeButtons = (): void => {
    modeGroup.hidden = !hasLandingGrid;
    modeAutoBtn.classList.toggle('active', mode === 'auto-landing');
    modeManualBtn.classList.toggle('active', mode === 'manual');
  };

  // ------------------------------------------------------------ worker
  const worker = new Worker(new URL('./route-worker.ts', import.meta.url), { type: 'module' });
  const send = (msg: ToWorker): void => worker.postMessage(msg);

  const routerTraverser = (): RouterTraverser => ({
    maxSlopeDeg: traverser.azami_egim_derece,
    speedTable: traverser.hiz_tablosu.map((entry): [number, number] => [entry.egim_derece, entry.hiz_m_s]),
    maxTimeS:
      typeof traverser.azami_sure_saat === 'number' && Number.isFinite(traverser.azami_sure_saat) && traverser.azami_sure_saat > 0
        ? traverser.azami_sure_saat * 3600
        : null,
  });

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
            ? 'Loading elevation grid & finding safe landing sites…'
            : 'Loading elevation grid & calculating route…',
        );
      } else {
        showMessage(mode === 'auto-landing' ? 'Finding safe landing sites and route…' : 'Calculating route…');
      }
    }
    send({
      type: 'route',
      id: ++requestId,
      mode,
      waypoints: [...waypoints],
      chosenLandingCell,
      minSeparationM,
      traverser: routerTraverser(),
    });
  };

  worker.onmessage = (event: MessageEvent<FromWorker>) => {
    const msg = event.data;
    if (msg.type === 'ready') {
      ready = true;
      hasLandingGrid = msg.hasLanding;
      mode = hasLandingGrid ? 'auto-landing' : 'manual';
      syncModeButtons();
      showMessage('');
      requestRoute();
      return;
    }
    if (msg.type === 'init-error') {
      showMessage(`Route planning is unavailable: ${msg.message}`, 'error');
      return;
    }
    if (msg.id !== requestId) return; // stale answer

    if (msg.ok) {
      if (msg.legs.length > 0) elevationRequestedOnce = true;
      renderLandingCandidates(msg.landingCandidates, msg.activeLandingCell);
      setLine(msg.path);
      renderSummary(msg);
      if (pendingNotice) showMessage(pendingNotice, 'error');
      else showMessage('');
      pendingNotice = '';
      lastActionWasAdd = false;
      return;
    }

    clearLandingUI();
    setLine(null);
    renderSummary(null);

    if (msg.reason === 'blocked-waypoint') {
      const stopNum = mode === 'auto-landing' ? msg.waypointIndex + 1 : msg.waypointIndex;
      const name = mode === 'manual' && msg.waypointIndex === 0 ? 'The start point' : `Science stop ${stopNum}`;
      const why =
        msg.why === 'forbidden'
          ? 'is in a forbidden area'
          : `is on a slope steeper than the ${traverser.azami_egim_derece}° limit for "${traverser.ad_en}"`;
      const justAdded = lastActionWasAdd && msg.waypointIndex === waypoints.length - 1;
      if (justAdded) {
        waypoints.pop();
        names.pop();
        lastActionWasAdd = false;
        const notice = `That point ${why}, so it was not added. Pick another point.`;
        requestRoute();
        if (waypoints.length > 0) pendingNotice = notice;
        showMessage(notice, 'error');
      } else {
        lastActionWasAdd = false;
        showMessage(`${name} ${why}. Remove it or choose another traverser.`, 'error');
      }
    } else if (msg.reason === 'no-landing') {
      lastActionWasAdd = false;
      const limitText =
        msg.withinRangeChecked && traverser.azami_sure_saat
          ? ` within the ${traverser.azami_sure_saat} h range of "${traverser.ad_en}"`
          : '';
      showMessage(
        `No suitable or marginal landing zone can reach Stop 1${limitText} without crossing forbidden terrain or slopes above ${traverser.azami_egim_derece}°. Try another target or traverser.`,
        'error',
      );
    } else {
      lastActionWasAdd = false;
      const from =
        mode === 'auto-landing'
          ? msg.legIndex === 0
            ? 'the landing zone'
            : `stop ${msg.legIndex}`
          : msg.legIndex === 0
          ? 'the start'
          : `stop ${msg.legIndex}`;
      showMessage(
        `No route found from ${from} to stop ${msg.legIndex + 1}: every path is blocked by forbidden terrain or slopes above the ${traverser.azami_egim_derece}° limit for "${traverser.ad_en}".`,
        'error',
      );
    }
  };
  worker.onerror = (event) => showMessage(`Route planning failed: ${event.message}`, 'error');

  showMessage('Loading the cost and landing grids…');
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
    syncModeButtons();
    requestRoute();
  };
  modeAutoBtn.addEventListener('click', () => setMode('auto-landing'));
  modeManualBtn.addEventListener('click', () => setMode('manual'));

  const addPoint = (lonLat: LonLat, name?: string): void => {
    if (!ready) {
      showMessage('Cost grid is still loading; please wait a moment.', 'info');
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
    requestRoute();
  };
  map.on('click', (event: MapMouseEvent) => addPoint([event.lngLat.lng, event.lngLat.lat]));
  undoButton.addEventListener('click', () => {
    waypoints.pop();
    names.pop();
    if (waypoints.length === 0) chosenLandingCell = null;
    lastActionWasAdd = false;
    pendingNotice = '';
    requestRoute();
  });
  clearButton.addEventListener('click', () => {
    waypoints.length = 0;
    names.length = 0;
    chosenLandingCell = null;
    lastActionWasAdd = false;
    pendingNotice = '';
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
      },
      features: [
        {
          type: 'Feature',
          properties: {
            kind: 'route',
            traverser_id: traverser.id,
            traverser_name: traverser.ad_en,
            marginal_landing: result.marginalLanding,
            distance_m: round(result.distance_m, 1),
            estimated_time_s: Math.round(result.time_s),
            no_data_m: round(result.noDataCells * grid.hucre_m, 1),
            caution_m: round(result.cautionCells * grid.hucre_m, 1),
            legs: result.legs.map((leg) => ({ distance_m: round(leg.distance_m, 1), estimated_time_s: Math.round(leg.time_s) })),
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
    setTraverser(next) {
      traverser = next;
      lastActionWasAdd = false;
      pendingNotice = '';
      requestRoute();
    },
  };
}
