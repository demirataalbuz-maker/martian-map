// AI-assisted code: written with Claude (Anthropic), reviewed by the team.
//
// Route planning UI: tap the map to set the start and the science stops (visited
// in the order tapped); the Web Worker returns the least-time path.

import { Marker, type GeoJSONSource, type Map as MlMap, type MapMouseEvent } from 'maplibre-gl';
import { ELEVATION_URL, HAZARD_URL, SLOPE_URL } from './config';
import type { GridMeta, LonLat, Traverser } from './data';
import type { GridGeo } from './grid';
import { renderResults } from './results';
import type { FromWorker, RouteSuccess, RouterTraverser, ToWorker } from './route-types';

const ROUTE_SOURCE = 'route';

const absoluteUrl = (url: string): string => new URL(url, document.baseURI).href;

export interface RouteController {
  setTraverser(traverser: Traverser): void;
  /** Adds a point to the route (start if it is the first), optionally with a name. */
  addPoint(lonLat: LonLat, name?: string): void;
}

export interface RouteOptions {
  /** True while the app runs on synthetic placeholder data; recorded in the exported file. */
  synthetic: boolean;
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
  const hint = root.querySelector<HTMLElement>('#route-hint')!;
  const message = root.querySelector<HTMLElement>('#route-message')!;
  const results = root.querySelector<HTMLElement>('#route-results')!;
  const undoButton = root.querySelector<HTMLButtonElement>('#route-undo')!;
  const clearButton = root.querySelector<HTMLButtonElement>('#route-clear')!;
  const downloadButton = root.querySelector<HTMLButtonElement>('#route-download')!;

  // ------------------------------------------------------------ state
  let traverser = initialTraverser;
  const waypoints: number[] = [];
  /** Name of each waypoint when it came from a predefined science stop, else null. */
  const names: (string | null)[] = [];
  let lastResult: RouteSuccess | null = null;
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
      const role = index === 0 ? 'Start' : `Science stop ${index}`;
      element.title = names[index] ? `${role}: ${names[index]}` : role;
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
    lastResult = result && result.legs.length > 0 ? result : null;
    downloadButton.disabled = lastResult === null;
    renderResults(results, result, traverser, grid.hucre_m);
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
      if (pendingNotice) showMessage(pendingNotice, 'error');
      else showMessage('');
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
        names.pop();
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
    elevationUrl: absoluteUrl(ELEVATION_URL),
    width: grid.genislik,
    height: grid.yukseklik,
    cellM: grid.hucre_m,
  });

  // ------------------------------------------------------------ interaction
  const addPoint = (lonLat: LonLat, name?: string): void => {
    if (!ready) return;
    const cell = geo.lonLatToIndex(lonLat[0], lonLat[1]);
    if (cell === null) {
      showMessage('That point is outside the mapped area.', 'error');
      return;
    }
    if (waypoints[waypoints.length - 1] === cell) return;
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
    lastActionWasAdd = false;
    pendingNotice = '';
    requestRoute();
  });
  clearButton.addEventListener('click', () => {
    waypoints.length = 0;
    names.length = 0;
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
    const collection = {
      type: 'FeatureCollection',
      properties: {
        body: 'Mars',
        note: 'Coordinates are Mars [longitude, latitude] in the same system as the map layers, NOT Earth WGS 84. Distances and times were computed on the cost grid, not from these coordinates.',
        synthetic_data: options.synthetic,
        grid_cell_m: grid.hucre_m,
      },
      features: [
        {
          type: 'Feature',
          properties: {
            kind: 'route',
            traverser_id: traverser.id,
            traverser_name: traverser.ad_en,
            distance_m: round(result.distance_m, 1),
            estimated_time_s: Math.round(result.time_s),
            no_data_m: round(result.noDataCells * grid.hucre_m, 1),
            caution_m: round(result.cautionCells * grid.hucre_m, 1),
            legs: result.legs.map((leg) => ({ distance_m: round(leg.distance_m, 1), estimated_time_s: Math.round(leg.time_s) })),
          },
          geometry: { type: 'LineString', coordinates: Array.from(result.path, coordinate) },
        },
        ...waypoints.map((cell, index) => ({
          type: 'Feature',
          properties: { kind: index === 0 ? 'start' : 'science_stop', order: index, name: names[index] },
          geometry: { type: 'Point', coordinates: coordinate(cell) },
        })),
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
