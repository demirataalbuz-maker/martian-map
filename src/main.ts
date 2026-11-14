// AI-assisted code: written with Claude (Anthropic) and Antigravity (Google DeepMind), reviewed by the team.

import { LngLatBounds, Map as MlMap, setWorkerUrl, type ErrorEvent } from 'maplibre-gl';
// MapLibre 6 loads its worker from a URL; let Vite bundle it so it also works on a static host.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { SITE_NAME } from './config';
import { loadGridMeta, loadLayerCatalog, loadMobility, loadStops, type Corners } from './data';
import { makeGridGeo } from './grid';
import { initRoute } from './route';
import { initLayerPanel } from './layers';
import { attachScaleBar } from './scalebar';
import { initStops } from './stops';
import { initTraverserSelector } from './traverser';

setWorkerUrl(maplibreWorkerUrl);

const statusEl = document.getElementById('status')!;

function showStatus(message: string, isError = false): void {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
  statusEl.hidden = message === '';
}

function boundsOf(corners: Corners): LngLatBounds {
  const bounds = new LngLatBounds();
  for (const c of corners) bounds.extend(c);
  return bounds;
}

function initPanelToggle(onToggle: () => void): void {
  const panel = document.getElementById('panel')!;
  const button = document.getElementById('panel-toggle')!;
  button.addEventListener('click', () => {
    const collapsed = panel.classList.toggle('collapsed');
    button.setAttribute('aria-expanded', String(!collapsed));
    onToggle();
  });
}

async function start(): Promise<void> {
  let routeRef: ReturnType<typeof initRoute> | null = null;
  initPanelToggle(() => routeRef?.syncCollapsedAlert());
  showStatus('Loading map data…');

  const [catalog, grid, mobility, stopsCatalog] = await Promise.all([
    loadLayerCatalog(),
    loadGridMeta(),
    loadMobility(),
    loadStops(),
  ]);

  document.getElementById('site-name')!.textContent = catalog.siteName ?? grid.siteName ?? SITE_NAME;
  const synthetic = catalog.synthetic || grid.synthetic || mobility.synthetic || stopsCatalog.synthetic;
  document.getElementById('synthetic-badge')!.hidden = !synthetic;
  const geo = makeGridGeo(grid);

  const bounds = boundsOf(grid.koseler);

  const map = new MlMap({
    container: 'map',
    // No basemap service: Earth tiles are meaningless here. Just a background colour.
    style: {
      version: 8,
      sources: {},
      layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#14100e' } }],
    },
    bounds,
    fitBoundsOptions: { padding: 24 },
    renderWorldCopies: false,
    attributionControl: false,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    maxZoom: 22,
  });
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();

  map.on('load', () => {
    try {
      showStatus('');
      initLayerPanel(map, catalog.layers, document.getElementById('layer-list')!);
      const selector = initTraverserSelector(
        mobility.traversers,
        mobility.landingCraft,
        document.getElementById('route-traverser')!,
        (t) => routeRef?.setTraverser(t),
        grid,
      );
      const route = initRoute(map, grid, geo, mobility.traversers[0], document.getElementById('route-panel')!, {
        synthetic,
        landingCraft: mobility.landingCraft,
        traversers: mobility.traversers,
        stops: stopsCatalog.stops,
        onSelectTraverser: (id) => selector.selectById(id),
        onStartupProgress: (text) => showStatus(text),
      });
      routeRef = route;
      initStops(map, stopsCatalog.stops, (stop) => route.addPoint(stop.konum, stop.ad_en));
      attachScaleBar(map, grid, document.getElementById('scalebar')!);
    } catch (err: unknown) {
      console.error(err);
      showStatus(err instanceof Error ? err.message : String(err), true);
    }
  });
  map.on('error', (e: ErrorEvent) => showStatus(`Map error: ${e.error?.message ?? 'unknown'}`, true));

  // Keep the whole study area in view when the container changes size (tablet
  // rotation, late layout), until the user starts navigating on their own.
  let userMoved = false;
  map.on('movestart', (e) => {
    if ('originalEvent' in e && e.originalEvent) userMoved = true;
  });
  map.on('resize', () => {
    if (!userMoved) map.fitBounds(bounds, { padding: 24, animate: false });
  });
}

start().catch((err: unknown) => {
  console.error(err);
  showStatus(err instanceof Error ? err.message : String(err), true);
});
