// AI-assisted code: written with Claude (Anthropic), reviewed by the team.

import { LngLatBounds, Map as MlMap, setWorkerUrl, type ErrorEvent } from 'maplibre-gl';
// MapLibre 6 loads its worker from a URL; let Vite bundle it so it also works on a static host.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { SITE_NAME } from './config';
import { loadGridMeta, loadLayerCatalog, loadMobility, type Corners } from './data';
import { makeGridGeo } from './grid';
import { initRoute } from './route';
import { initLayerPanel } from './layers';
import { attachScaleBar } from './scalebar';
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

function initPanelToggle(): void {
  const panel = document.getElementById('panel')!;
  const button = document.getElementById('panel-toggle')!;
  button.addEventListener('click', () => {
    const collapsed = panel.classList.toggle('collapsed');
    button.setAttribute('aria-expanded', String(!collapsed));
  });
}

async function start(): Promise<void> {
  initPanelToggle();
  showStatus('Loading map data…');
  document.getElementById('site-name')!.textContent = SITE_NAME;

  const [catalog, grid, mobility] = await Promise.all([loadLayerCatalog(), loadGridMeta(), loadMobility()]);
  document.getElementById('synthetic-badge')!.hidden = !(catalog.synthetic || mobility.synthetic);
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
    initLayerPanel(map, catalog.layers, document.getElementById('layer-list')!);
    const route = initRoute(map, grid, geo, mobility.traversers[0], document.getElementById('route-panel')!);
    initTraverserSelector(mobility.traversers, document.getElementById('route-traverser')!, (t) => route.setTraverser(t));
    attachScaleBar(map, grid, document.getElementById('scalebar')!);
    showStatus('');
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
