// AI-assisted code: written with Claude (Anthropic), reviewed by the team.

import { LngLatBounds, Map as MlMap, setWorkerUrl, type ErrorEvent } from 'maplibre-gl';
// MapLibre 6 loads its worker from a URL; let Vite bundle it so it also works on a static host.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { SITE_NAME } from './config';
import { layerImageUrl, loadGridMeta, loadLayerCatalog, type Corners, type LayerDef } from './data';
import { attachScaleBar } from './scalebar';

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

function renderLayerCard(layer: LayerDef): void {
  const card = document.getElementById('layer-card')!;
  card.replaceChildren();
  const title = document.createElement('h2');
  title.textContent = layer.ad_en;
  const facts = document.createElement('dl');
  const rows: [string, string][] = [
    ['Source', layer.kaynak],
    ['Resolution', `${layer.cozunurluk_m} m / pixel`],
    ['Confidence', layer.guven_notu_en],
  ];
  for (const [term, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = value;
    facts.append(dt, dd);
  }
  card.append(title, facts);
  card.hidden = false;
}

async function start(): Promise<void> {
  showStatus('Loading map data…');
  document.getElementById('site-name')!.textContent = SITE_NAME;

  const [catalog, grid] = await Promise.all([loadLayerCatalog(), loadGridMeta()]);
  document.getElementById('synthetic-badge')!.hidden = !catalog.synthetic;

  // Step 1: a single layer. The layer panel (step 2) will drive all of them.
  const layer = catalog.layers[0];
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
    map.addSource(layer.id, { type: 'image', url: layerImageUrl(layer), coordinates: layer.koseler });
    map.addLayer({ id: layer.id, type: 'raster', source: layer.id, paint: { 'raster-fade-duration': 0 } });
    renderLayerCard(layer);
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
