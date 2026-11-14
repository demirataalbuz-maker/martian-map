// AI-assisted code: written with Claude (Anthropic), reviewed by the team.
//
// Route planning UI: tap the map to set the start and the science stops (visited
// in the order tapped); the Web Worker returns the least-time path.

import { Marker, type GeoJSONSource, type Map as MlMap, type MapMouseEvent } from 'maplibre-gl';
import { SLOPE_URL, HAZARD_URL } from './config';
import type { GridMeta, Traverser } from './data';
import type { GridGeo } from './grid';
import type { FromWorker, RouteSuccess, RouterTraverser, ToWorker } from './route-types';

const ROUTE_SOURCE = 'route';

function formatDuration(seconds: number): string {
  const totalMinutes = Math.round(seconds / 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

const absoluteUrl = (url: string): string => new URL(url, document.baseURI).href;

export interface RouteController {
  setTraverser(traverser: Traverser): void;
}

export function initRoute(map: MlMap, grid: GridMeta, geo: GridGeo, initialTraverser: Traverser, root: HTMLElement): RouteController {
  // ------------------------------------------------------------ DOM
  const hint = root.querySelector<HTMLElement>('#route-hint')!;
  const traverserLabel = root.querySelector<HTMLElement>('#route-traverser')!;
  const message = root.querySelector<HTMLElement>('#route-message')!;
  const summary = root.querySelector<HTMLElement>('#route-summary')!;
  const undoButton = root.querySelector<HTMLButtonElement>('#route-undo')!;
  const clearButton = root.querySelector<HTMLButtonElement>('#route-clear')!;

  // ------------------------------------------------------------ state
  let traverser = initialTraverser;
  const waypoints: number[] = [];
  const markers: Marker[] = [];
  let ready = false;
  let requestId = 0;
  let lastActionWasAdd = false;
  /** A notice that must survive the next successful recalculation (e.g. "point not added"). */
  let pendingNotice = '';

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

  const renderMarkers = (): void => {
    markers.splice(0).forEach((marker) => marker.remove());
    waypoints.forEach((cell, index) => {
      const element = document.createElement('div');
      element.className = index === 0 ? 'waypoint start' : 'waypoint';
      element.textContent = index === 0 ? 'S' : String(index);
      element.title = index === 0 ? 'Start' : `Science stop ${index}`;
      markers.push(new Marker({ element }).setLngLat(geo.indexToLonLat(cell)).addTo(map));
    });
    undoButton.disabled = waypoints.length === 0;
    clearButton.disabled = waypoints.length === 0;
    hint.textContent =
      waypoints.length === 0
        ? 'Tap the map to set the start point.'
        : 'Tap the map to add a science stop. Stops are visited in the order you add them.';
  };

  const renderSummary = (result: RouteSuccess | null): void => {
    summary.replaceChildren();
    summary.hidden = !result || result.legs.length === 0;
    if (!result || result.legs.length === 0) return;
    const rows: [string, string][] = [
      ['Distance', `${Math.round(result.distance_m)} m`],
      ['Estimated time', formatDuration(result.time_s)],
    ];
    for (const [term, value] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = term;
      const dd = document.createElement('dd');
      dd.textContent = value;
      summary.append(dt, dd);
    }
  };

  // ------------------------------------------------------------ worker
  const worker = new Worker(new URL('./route-worker.ts', import.meta.url), { type: 'module' });
  const send = (msg: ToWorker): void => worker.postMessage(msg);

  const routerTraverser = (): RouterTraverser => ({
    maxSlopeDeg: traverser.azami_egim_derece,
    speedTable: traverser.hiz_tablosu.map((entry): [number, number] => [entry.egim_derece, entry.hiz_m_s]),
  });

  const requestRoute = (): void => {
    renderMarkers();
    if (!ready) return;
    if (waypoints.length === 0) {
      setLine(null);
      renderSummary(null);
      showMessage('');
      return;
    }
    if (waypoints.length > 1) showMessage('Calculating route…');
    send({ type: 'route', id: ++requestId, waypoints: [...waypoints], traverser: routerTraverser() });
  };

  worker.onmessage = (event: MessageEvent<FromWorker>) => {
    const msg = event.data;
    if (msg.type === 'ready') {
      ready = true;
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
      setLine(msg.path);
      renderSummary(msg);
      const warnings: string[] = [];
      if (msg.noDataCells > 0) {
        warnings.push(`The route crosses ${msg.noDataCells} cell(s) with NO DATA (${Math.round(msg.noDataCells * grid.hucre_m)} m or more). Terrain there is unknown.`);
      }
      if (msg.cautionCells > 0) warnings.push(`The route crosses ${msg.cautionCells} caution cell(s).`);
      if (pendingNotice) showMessage(pendingNotice, 'error');
      else showMessage(warnings.join(' '), warnings.length > 0 ? 'warn' : 'info');
      pendingNotice = '';
      return;
    }

    setLine(null);
    renderSummary(null);
    if (msg.reason === 'blocked-waypoint') {
      const name = msg.waypointIndex === 0 ? 'The start point' : `Science stop ${msg.waypointIndex}`;
      const why =
        msg.why === 'forbidden'
          ? 'is in a forbidden area'
          : `is on a slope steeper than the ${traverser.azami_egim_derece}° limit for "${traverser.ad_en}"`;
      const justAdded = lastActionWasAdd && msg.waypointIndex === waypoints.length - 1;
      if (justAdded) {
        waypoints.pop();
        lastActionWasAdd = false;
        const notice = `That point ${why}, so it was not added. Pick another point.`;
        requestRoute(); // restore the previous route
        if (waypoints.length > 0) pendingNotice = notice;
        showMessage(notice, 'error');
      } else {
        showMessage(`${name} ${why}. Remove it or choose another traverser.`, 'error');
      }
    } else {
      const from = msg.legIndex === 0 ? 'the start' : `stop ${msg.legIndex}`;
      showMessage(
        `No route found from ${from} to stop ${msg.legIndex + 1}: every path is blocked by forbidden terrain or slopes above the ${traverser.azami_egim_derece}° limit for "${traverser.ad_en}".`,
        'error',
      );
    }
  };
  worker.onerror = (event) => showMessage(`Route planning failed: ${event.message}`, 'error');

  showMessage('Loading the cost grid…');
  send({
    type: 'init',
    slopeUrl: absoluteUrl(SLOPE_URL),
    hazardUrl: absoluteUrl(HAZARD_URL),
    width: grid.genislik,
    height: grid.yukseklik,
    cellM: grid.hucre_m,
  });

  // ------------------------------------------------------------ interaction
  map.on('click', (event: MapMouseEvent) => {
    if (!ready) return;
    const cell = geo.lonLatToIndex(event.lngLat.lng, event.lngLat.lat);
    if (cell === null) {
      showMessage('That point is outside the mapped area.', 'error');
      return;
    }
    if (waypoints[waypoints.length - 1] === cell) return;
    waypoints.push(cell);
    lastActionWasAdd = true;
    pendingNotice = '';
    requestRoute();
  });
  undoButton.addEventListener('click', () => {
    waypoints.pop();
    lastActionWasAdd = false;
    pendingNotice = '';
    requestRoute();
  });
  clearButton.addEventListener('click', () => {
    waypoints.length = 0;
    lastActionWasAdd = false;
    pendingNotice = '';
    requestRoute();
  });

  const showTraverser = (): void => {
    traverserLabel.textContent = `Traverser: ${traverser.ad_en} (slope limit ${traverser.azami_egim_derece}°)`;
  };
  showTraverser();
  renderMarkers();

  return {
    setTraverser(next) {
      traverser = next;
      lastActionWasAdd = false;
      showTraverser();
      requestRoute();
    },
  };
}
