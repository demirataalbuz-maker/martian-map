// AI-assisted code: written with Claude (Anthropic), reviewed by the team.
// Loaders and types for the team's data contract (field names are Turkish by agreement).

import { DATA_DIR, GRID_URL, LAYERS_URL, MOBILITY_URL, STOPS_URL } from './config';

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

// ------------------------------------------------------------ mobility parameters

export interface SpeedEntry {
  egim_derece: number;
  hiz_m_s: number;
}

export interface Traverser {
  id: string;
  ad_en: string;
  azami_egim_derece: number;
  hiz_tablosu: SpeedEntry[];
  /** Optional: slope from which the route counts as "close to the limit". */
  uyari_egim_derece?: number;
  azami_engel_m?: number;
  azami_sure_saat?: number;
  enerji_katsayisi?: number;
  kaynaklar?: Record<string, string>;
}

export interface MobilityParams {
  synthetic: boolean;
  traversers: Traverser[];
}

const isPositive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/** Every limit and speed used by the app comes from this file; nothing is hard-coded. */
export async function loadMobility(): Promise<MobilityParams> {
  const raw = (await fetchJson(MOBILITY_URL)) as { sahte?: boolean; gezginler?: unknown };
  if (!Array.isArray(raw.gezginler) || raw.gezginler.length === 0) {
    throw new Error('mobilite_parametreleri.json contains no traversers ("gezginler")');
  }
  const traversers = raw.gezginler as Traverser[];
  for (const t of traversers) {
    const where = `mobilite_parametreleri.json, traverser "${t.id ?? '?'}"`;
    if (!t.id || !t.ad_en) throw new Error(`${where}: "id" and "ad_en" are required`);
    if (!isPositive(t.azami_egim_derece)) throw new Error(`${where}: "azami_egim_derece" must be a positive number`);
    if (!Array.isArray(t.hiz_tablosu) || t.hiz_tablosu.length === 0) throw new Error(`${where}: "hiz_tablosu" is empty`);
    for (const entry of t.hiz_tablosu) {
      if (typeof entry.egim_derece !== 'number' || !isPositive(entry.hiz_m_s)) {
        throw new Error(`${where}: every "hiz_tablosu" entry needs "egim_derece" and a positive "hiz_m_s"`);
      }
    }
    t.hiz_tablosu = [...t.hiz_tablosu].sort((a, b) => a.egim_derece - b.egim_derece);
  }
  return { synthetic: raw.sahte === true, traversers };
}

// ------------------------------------------------------------ science stops

export interface ScienceStop {
  id: string;
  ad_en: string;
  /** [longitude, latitude] */
  konum: LonLat;
  aciklama_en?: string;
  /** Image file name inside the data folder (optional). */
  foto?: string;
  /** Photo credit (mission / instrument / image id). */
  foto_kaynak?: string;
}

/** The stops file is optional: without it the app simply shows no predefined stops. */
export async function loadStops(): Promise<ScienceStop[]> {
  let raw: unknown;
  try {
    raw = await fetchJson(STOPS_URL);
  } catch {
    return [];
  }
  const list = Array.isArray(raw) ? raw : (raw as { duraklar?: unknown }).duraklar;
  if (!Array.isArray(list)) return [];
  return (list as ScienceStop[]).filter(
    (stop) => stop && typeof stop.ad_en === 'string' && Array.isArray(stop.konum) && stop.konum.length === 2 && stop.konum.every((n) => Number.isFinite(n)),
  );
}
