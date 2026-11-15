// AI-assisted code: written with Claude (Anthropic) and Antigravity (Google DeepMind), reviewed by the team.
//
// Layer panel, built entirely from katmanlar.json: visibility toggle, opacity,
// legend, and the source / resolution / confidence note of every layer.

import type { Map as MlMap } from 'maplibre-gl';
import { layerImageUrl, layerTileUrl, type LayerDef } from './data';
import { onLangChange, ui } from './i18n';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatResolution(metres: number): string {
  if (!(typeof metres === 'number' && Number.isFinite(metres))) return ui('not stated', 'belirtilmedi');
  return ui(`${metres} m / pixel`, `${metres} m / piksel`);
}

interface LayerState {
  index: number;
  layer: LayerDef;
  visible: boolean;
  opacityPct: number;
  detailsOpen: boolean;
  mounted: boolean;
}

export type GlobeBaseId = 'kure_viking_renkli' | 'kure_yukseklik' | 'kure_albedo' | 'kure_termal_atalet';
export type GlobeOverlayId =
  | 'none'
  | 'kure_uygunluk_insanli'
  | 'kure_uygunluk_robotik'
  | 'kure_atmosfer_kalkani'
  | 'kure_toz_firtinasi';

export interface LayerController {
  setGlobeBase(baseId: GlobeBaseId): void;
  setGlobeSuitability(id: GlobeOverlayId): void;
  syncScenario(scenario: 'crewed' | 'rover', isGlobe: boolean): void;
}

const GLOBE_BASE_IDS = new Set<string>(['kure_viking_renkli', 'kure_yukseklik', 'kure_albedo', 'kure_termal_atalet']);
const GLOBE_OVERLAY_IDS = new Set<string>([
  'kure_uygunluk_insanli',
  'kure_uygunluk_robotik',
  'kure_atmosfer_kalkani',
  'kure_toz_firtinasi',
]);
const CTX_BASE_IDS = new Set<string>(['ctx_murray', 'ctx_usgs_m2020']);
const CATALOGUE_TOP_ANCHOR_ID = '__catalogue-layers-top__';

/**
 * Registers catalogue layers lazily on demand (preserving catalogue Z-order below route/stop
 * overlays so hidden ~40 MB PNGs never block initial startup) and renders layer controls with
 * details collapsed by default.
 */
export function initLayerPanel(map: MlMap, layers: LayerDef[], root: HTMLElement): LayerController {
  let currentScenario: 'crewed' | 'rover' = 'crewed';
  let currentIsGlobe = true;

  // Empty sentinel layer anchors the top of the catalogue stack below any route/label overlays.
  if (!map.getSource(CATALOGUE_TOP_ANCHOR_ID)) {
    map.addSource(CATALOGUE_TOP_ANCHOR_ID, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    map.addLayer({
      id: CATALOGUE_TOP_ANCHOR_ID,
      type: 'circle',
      source: CATALOGUE_TOP_ANCHOR_ID,
      layout: { visibility: 'none' },
    });
  }

  const states: LayerState[] = layers.map((layer, index) => {
    const visible = layer.varsayilan_acik !== undefined ? layer.varsayilan_acik : index === 0;
    const isOverlay = Boolean(layer.tur) && !layer.tur.toLowerCase().startsWith('altlik');
    const initialOpacity = layer.varsayilan_saydamlik !== undefined ? layer.varsayilan_saydamlik : isOverlay ? 0.65 : 1;
    const opacityPct = Math.round(initialOpacity * 100);
    return { index, layer, visible, opacityPct, detailsOpen: false, mounted: false };
  });

  const findBeforeId = (targetIndex: number): string => {
    for (let i = targetIndex + 1; i < states.length; i++) {
      if (states[i].mounted && map.getLayer(states[i].layer.id)) {
        return states[i].layer.id;
      }
    }
    return map.getLayer(CATALOGUE_TOP_ANCHOR_ID) ? CATALOGUE_TOP_ANCHOR_ID : '';
  };

  const ensureLayerMounted = (st: LayerState): void => {
    if (st.mounted) return;
    const { layer } = st;
    if (!map.getSource(layer.id)) {
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
    }
    if (!map.getLayer(layer.id)) {
      const beforeId = findBeforeId(st.index);
      map.addLayer(
        {
          id: layer.id,
          type: 'raster',
          source: layer.id,
          layout: { visibility: 'none' },
          paint: { 'raster-fade-duration': 0, 'raster-opacity': st.opacityPct / 100 },
        },
        beforeId || undefined,
      );
    }
    st.mounted = true;
  };

  const isLayerAllowedOnMap = (layer: LayerDef): boolean => {
    const area = layer.alan ?? 'ctx';
    if (area === 'kure') {
      return currentIsGlobe ? true : GLOBE_BASE_IDS.has(layer.id);
    }
    if (currentIsGlobe) return false;
    if (currentScenario === 'rover') {
      return area === 'hirise' || CTX_BASE_IDS.has(layer.id);
    }
    return area === 'ctx';
  };

  const applyMapVisibilities = (): void => {
    for (const st of states) {
      const show = st.visible && isLayerAllowedOnMap(st.layer);
      // Only mount tile pyramids up front or any layer when first made visible (lazy PNG image decode)
      if (show || st.layer.karolar) ensureLayerMounted(st);
      if (st.mounted && map.getLayer(st.layer.id)) {
        map.setLayoutProperty(st.layer.id, 'visibility', show ? 'visible' : 'none');
      }
    }
  };

  const isLayerInDrawerScope = (layer: LayerDef): boolean => {
    const area = layer.alan ?? 'ctx';
    if (currentIsGlobe) return area === 'kure';
    if (currentScenario === 'rover') return area === 'hirise' || CTX_BASE_IDS.has(layer.id);
    return area === 'ctx';
  };

  const render = (): void => {
    root.replaceChildren();
    const visibleStates = states.filter((st) => isLayerInDrawerScope(st.layer));
    for (const st of visibleStates) {
      const { layer } = st;
      const layerTitle = layer.ad_en ?? layer.id;
      const item = el('section', 'layer');
      item.dataset.layerId = layer.id;

      const head = el('label', 'layer-head');
      const toggle = el('input');
      toggle.type = 'checkbox';
      toggle.checked = st.visible;
      toggle.setAttribute('aria-label', ui(`Toggle layer: ${layerTitle}`, `Katmanı göster: ${layerTitle}`));
      head.append(toggle, el('span', 'layer-name', layerTitle));

      const opacityRow = el('label', 'layer-opacity');
      const slider = el('input');
      slider.type = 'range';
      slider.min = '0';
      slider.max = '100';
      slider.step = '5';
      slider.value = String(st.opacityPct);
      slider.disabled = !st.visible;
      slider.setAttribute('aria-label', ui(`${layerTitle} opacity (%)`, `${layerTitle} saydamlığı (%)`));
      const opacityValue = el('output', undefined, `${st.opacityPct}%`);
      opacityRow.append(el('span', undefined, ui('Opacity', 'Saydamlık')), slider, opacityValue);

      toggle.addEventListener('change', () => {
        st.visible = toggle.checked;
        applyMapVisibilities();
        slider.disabled = !st.visible;
        item.classList.toggle('off', !st.visible);
      });
      slider.addEventListener('input', () => {
        st.opacityPct = Number(slider.value);
        if (st.mounted && map.getLayer(layer.id)) {
          map.setPaintProperty(layer.id, 'raster-opacity', st.opacityPct / 100);
        }
        opacityValue.textContent = `${st.opacityPct}%`;
      });
      item.classList.toggle('off', !st.visible);

      const details = el('details', 'layer-details');
      details.open = st.detailsOpen;
      const summary = el('summary', 'layer-details-summary', ui('Legend & source details', 'Lejant ve kaynak detayları'));
      details.addEventListener('toggle', () => {
        st.detailsOpen = details.open;
      });

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
        noData.append(el('span', 'swatch nodata'), el('span', undefined, ui('No data (transparent)', 'Veri yok (şeffaf)')));
        legend.append(noData);
      }

      const facts = el('dl', 'facts');
      const rows: [string, string][] = [[ui('Source', 'Kaynak'), layer.kaynak || ui('not stated', 'belirtilmedi')]];
      if (layer.lisans) {
        rows.push([ui('License', 'Lisans'), layer.lisans]);
      }
      rows.push([ui('Resolution', 'Çözünürlük'), formatResolution(layer.cozunurluk_m)]);
      if (layer.karolar && (layer.min_zoom !== undefined || layer.max_zoom !== undefined)) {
        const zoomLabel =
          layer.min_zoom !== undefined && layer.max_zoom !== undefined
            ? `z${layer.min_zoom}–z${layer.max_zoom}`
            : layer.max_zoom !== undefined
            ? ui(`up to z${layer.max_zoom}`, `z${layer.max_zoom}'e kadar`)
            : ui(`from z${layer.min_zoom}`, `z${layer.min_zoom}'den`);
        rows.push([ui('Tile pyramid', 'Karo piramidi'), zoomLabel]);
      }
      rows.push([ui('Confidence', 'Güven'), layer.guven_notu_en || ui('not stated', 'belirtilmedi')]);
      for (const [term, value] of rows) facts.append(el('dt', undefined, term), el('dd', undefined, value));

      details.append(summary, legend, facts);
      item.append(head, opacityRow, details);
      root.append(item);
    }
  };

  applyMapVisibilities();
  render();
  onLangChange(render);

  return {
    setGlobeBase(baseId) {
      for (const st of states) {
        if (GLOBE_BASE_IDS.has(st.layer.id)) {
          st.visible = st.layer.id === baseId;
        }
      }
      applyMapVisibilities();
      render();
    },
    setGlobeSuitability(id) {
      for (const st of states) {
        if (GLOBE_OVERLAY_IDS.has(st.layer.id)) {
          st.visible = st.layer.id === id;
        }
      }
      applyMapVisibilities();
      render();
    },
    syncScenario(scenario, isGlobe) {
      const scenarioChanged = currentScenario !== scenario;
      currentScenario = scenario;
      currentIsGlobe = isGlobe;
      if (scenarioChanged && scenario === 'rover') {
        const usgs = states.find((s) => s.layer.id === 'ctx_usgs_m2020');
        if (usgs) usgs.visible = true;
      }
      applyMapVisibilities();
      render();
    },
  };
}
