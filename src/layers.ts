// AI-assisted code: written with Claude (Anthropic) and Antigravity (Google DeepMind), reviewed by the team.
//
// Layer panel, built entirely from katmanlar.json: visibility toggle, opacity,
// legend, and the source / resolution / confidence note of every layer.

import type { Map as MlMap } from 'maplibre-gl';
import { layerImageUrl, layerTileUrl, type LayerDef } from './data';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatResolution(metres: number): string {
  if (!(typeof metres === 'number' && Number.isFinite(metres))) return 'not stated';
  return `${metres} m / pixel`;
}

/**
 * Adds every catalogue layer to the map (catalogue order = bottom to top) and
 * renders its controls. By default only the primary basemap starts visible, and
 * thematic overlays (tur !== 'altlik') start translucent so the basemap remains
 * legible underneath when toggled on.
 */
export function initLayerPanel(map: MlMap, layers: LayerDef[], root: HTMLElement): void {
  root.replaceChildren();

  layers.forEach((layer, index) => {
    const visible = layer.varsayilan_acik !== undefined ? layer.varsayilan_acik : index === 0;
    const isOverlay = Boolean(layer.tur) && layer.tur.toLowerCase() !== 'altlik';
    const initialOpacity = layer.varsayilan_saydamlik !== undefined ? layer.varsayilan_saydamlik : isOverlay ? 0.65 : 1;
    const initialPct = Math.round(initialOpacity * 100);

    if (layer.karolar) {
      map.addSource(layer.id, {
        type: 'raster',
        tiles: [layerTileUrl(layer.karolar)],
        scheme: layer.sema ?? 'xyz',
        ...(layer.min_zoom !== undefined ? { minzoom: layer.min_zoom } : {}),
        ...(layer.max_zoom !== undefined ? { maxzoom: layer.max_zoom } : {}),
        ...(layer.sinir ? { bounds: layer.sinir } : {}),
        tileSize: layer.karo_boyutu ?? 256,
      });
    } else {
      map.addSource(layer.id, {
        type: 'image',
        url: layerImageUrl(layer),
        coordinates: layer.koseler!,
      });
    }
    map.addLayer({
      id: layer.id,
      type: 'raster',
      source: layer.id,
      layout: { visibility: visible ? 'visible' : 'none' },
      paint: { 'raster-fade-duration': 0, 'raster-opacity': initialOpacity },
    });

    const item = el('section', 'layer');
    item.dataset.layerId = layer.id;

    // Header row: toggle + name
    const head = el('label', 'layer-head');
    const toggle = el('input');
    toggle.type = 'checkbox';
    toggle.checked = visible;
    head.append(toggle, el('span', 'layer-name', layer.ad_en ?? layer.id));

    // Opacity
    const opacityRow = el('label', 'layer-opacity');
    const slider = el('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.step = '5';
    slider.value = String(initialPct);
    slider.disabled = !visible;
    const opacityValue = el('output', undefined, `${initialPct}%`);
    opacityRow.append(el('span', undefined, 'Opacity'), slider, opacityValue);

    toggle.addEventListener('change', () => {
      map.setLayoutProperty(layer.id, 'visibility', toggle.checked ? 'visible' : 'none');
      slider.disabled = !toggle.checked;
      item.classList.toggle('off', !toggle.checked);
    });
    slider.addEventListener('input', () => {
      map.setPaintProperty(layer.id, 'raster-opacity', Number(slider.value) / 100);
      opacityValue.textContent = `${slider.value}%`;
    });
    item.classList.toggle('off', !visible);

    // Legend
    const legend = el('ul', 'legend');
    const entries = layer.lejant ?? [];
    for (const entry of entries) {
      const li = el('li');
      const swatch = el('span', 'swatch');
      swatch.style.background = entry.renk;
      li.append(swatch, el('span', undefined, entry.etiket_en));
      legend.append(li);
    }
    const assetPath = layer.karolar ?? layer.dosya ?? '';
    const isJpeg = /\.(jpe?g)(?:$|[?#])/i.test(assetPath);
    const alreadyHasNoData = entries.some((e) => /no\s*data/i.test(e.etiket_en));
    if (!isJpeg && !alreadyHasNoData) {
      const noData = el('li');
      noData.append(el('span', 'swatch nodata'), el('span', undefined, 'No data (transparent)'));
      legend.append(noData);
    }

    // Provenance: always visible next to the layer
    const facts = el('dl', 'facts');
    const rows: [string, string][] = [
      ['Source', layer.kaynak || 'not stated'],
      ['Resolution', formatResolution(layer.cozunurluk_m)],
    ];
    if (layer.karolar && (layer.min_zoom !== undefined || layer.max_zoom !== undefined)) {
      const zoomLabel =
        layer.min_zoom !== undefined && layer.max_zoom !== undefined
          ? `z${layer.min_zoom}–z${layer.max_zoom}`
          : layer.max_zoom !== undefined
          ? `up to z${layer.max_zoom}`
          : `from z${layer.min_zoom}`;
      rows.push(['Tile pyramid', zoomLabel]);
    }
    rows.push(['Confidence', layer.guven_notu_en || 'not stated']);
    for (const [term, value] of rows) facts.append(el('dt', undefined, term), el('dd', undefined, value));

    item.append(head, opacityRow, legend, facts);
    root.append(item);
  });
}
