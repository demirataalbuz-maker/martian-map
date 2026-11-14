// AI-assisted code: written with Claude (Anthropic), reviewed by the team.
//
// Layer panel, built entirely from katmanlar.json: visibility toggle, opacity,
// legend, and the source / resolution / confidence note of every layer.

import type { Map as MlMap } from 'maplibre-gl';
import { layerImageUrl, type LayerDef } from './data';

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
 * renders its controls. Only the first layer starts visible.
 */
export function initLayerPanel(map: MlMap, layers: LayerDef[], root: HTMLElement): void {
  root.replaceChildren();

  layers.forEach((layer, index) => {
    const visible = index === 0;
    map.addSource(layer.id, { type: 'image', url: layerImageUrl(layer), coordinates: layer.koseler });
    map.addLayer({
      id: layer.id,
      type: 'raster',
      source: layer.id,
      layout: { visibility: visible ? 'visible' : 'none' },
      paint: { 'raster-fade-duration': 0, 'raster-opacity': 1 },
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
    slider.value = '100';
    slider.disabled = !visible;
    const opacityValue = el('output', undefined, '100%');
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
    for (const entry of layer.lejant ?? []) {
      const li = el('li');
      const swatch = el('span', 'swatch');
      swatch.style.background = entry.renk;
      li.append(swatch, el('span', undefined, entry.etiket_en));
      legend.append(li);
    }
    const noData = el('li');
    noData.append(el('span', 'swatch nodata'), el('span', undefined, 'No data (transparent)'));
    legend.append(noData);

    // Provenance: always visible next to the layer
    const facts = el('dl', 'facts');
    const rows: [string, string][] = [
      ['Source', layer.kaynak || 'not stated'],
      ['Resolution', formatResolution(layer.cozunurluk_m)],
      ['Confidence', layer.guven_notu_en || 'not stated'],
    ];
    for (const [term, value] of rows) facts.append(el('dt', undefined, term), el('dd', undefined, value));

    item.append(head, opacityRow, legend, facts);
    root.append(item);
  });
}
