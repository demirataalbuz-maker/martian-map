// AI-assisted code: written with Claude (Anthropic), reviewed by the team.
// Loaders and types for the team's data contract (field names are Turkish by agreement).

import { DATA_DIR, GRID_URL, LAYERS_URL } from './config';

export type LonLat = [number, number];
/** Corner order: top-left (NW), top-right (NE), bottom-right (SE), bottom-left (SW). */
export type Corners = [LonLat, LonLat, LonLat, LonLat];

export interface LegendEntry {
  renk: string;
  etiket_en: string;
}

export interface LayerDef {
  id: string;
  ad_en: string;
  tur: string;
  dosya: string;
  koseler: Corners;
  kaynak: string;
  cozunurluk_m: number;
  guven_notu_en: string;
  lejant?: LegendEntry[];
}

export interface LayerCatalog {
  synthetic: boolean;
  layers: LayerDef[];
}

export interface GridMeta {
  genislik: number;
  yukseklik: number;
  hucre_m: number;
  koseler: Corners;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url} (HTTP ${res.status})`);
  return res.json();
}

function assertCorners(value: unknown, where: string): asserts value is Corners {
  const ok =
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((c) => Array.isArray(c) && c.length === 2 && c.every((n) => typeof n === 'number' && Number.isFinite(n)));
  if (!ok) throw new Error(`${where}: "koseler" must be 4 [longitude, latitude] pairs`);
}

/** Accepts either a bare array of layers or an object with a "katmanlar" array. */
export async function loadLayerCatalog(): Promise<LayerCatalog> {
  const raw = await fetchJson(LAYERS_URL);
  const obj = (Array.isArray(raw) ? { katmanlar: raw } : raw) as { sahte?: boolean; katmanlar?: unknown };
  if (!Array.isArray(obj.katmanlar) || obj.katmanlar.length === 0) {
    throw new Error('katmanlar.json contains no layers');
  }
  const layers = obj.katmanlar as LayerDef[];
  for (const layer of layers) {
    if (!layer.id || !layer.dosya) throw new Error('katmanlar.json: every layer needs "id" and "dosya"');
    assertCorners(layer.koseler, `Layer "${layer.id}"`);
  }
  return { synthetic: obj.sahte === true, layers };
}

export async function loadGridMeta(): Promise<GridMeta> {
  const grid = (await fetchJson(GRID_URL)) as GridMeta;
  for (const key of ['genislik', 'yukseklik', 'hucre_m'] as const) {
    if (!(typeof grid[key] === 'number' && grid[key] > 0)) throw new Error(`izgara.json: "${key}" must be a positive number`);
  }
  assertCorners(grid.koseler, 'izgara.json');
  return grid;
}

export const layerImageUrl = (layer: LayerDef): string => `${DATA_DIR}/${layer.dosya}`;
