// AI-assisted code: written with Claude (Anthropic) and Antigravity (Google DeepMind), reviewed by the team.
// Loaders and types for the team's data contract (field names are Turkish by agreement).

import { DATA_DIR, GRID_URL, LAYERS_URL, MOBILITY_URL, STOPS_URL } from './config';

export type LonLat = [number, number];
/** Corner order: top-left (NW), top-right (NE), bottom-right (SE), bottom-left (SW). */
export type Corners = [LonLat, LonLat, LonLat, LonLat];
/** Bounding box order: [west, south, east, north] in [longitude, latitude]. */
export type TileBounds = [number, number, number, number];
export type TileScheme = 'xyz' | 'tms';
export type SlopeEncoding = 'uint8' | 'float32';
export type ElevationEncoding = 'int16' | 'float32';

export interface LegendEntry {
  renk: string;
  etiket_en: string;
}

export interface LayerDef {
  id: string;
  ad_en: string;
  tur: string;
  /** Single-image source path (present when karolar is omitted). */
  dosya?: string;
  koseler?: Corners;
  /** Raster tile template, e.g. "karolar/<id>/{z}/{x}/{y}.webp". */
  karolar?: string;
  sema?: TileScheme;
  min_zoom?: number;
  max_zoom?: number;
  sinir?: TileBounds;
  karo_boyutu?: number;
  varsayilan_acik?: boolean;
  varsayilan_saydamlik?: number;
  kaynak: string;
  cozunurluk_m: number;
  guven_notu_en: string;
  lejant?: LegendEntry[];
}

export interface LayerCatalog {
  synthetic: boolean;
  siteName?: string;
  layers: LayerDef[];
}

export interface GridMeta {
  synthetic: boolean;
  siteName?: string;
  genislik: number;
  yukseklik: number;
  hucre_m: number;
  koseler: Corners;
  egim_tipi: SlopeEncoding;
  egim_olcek: number;
  egim_veri_yok: number;
  egim_taban_uzunlugu_m?: number;
  egim_yontemi_en?: string;
  yukseklik_tipi: ElevationEncoding;
  yukseklik_taban_m: number;
  yukseklik_olcek_m: number;
  yukseklik_veri_yok: number;
  kaynak_en?: string;
  guven_notu_en?: string;
}

const MAX_MERCATOR_LAT = 85.051129;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPositive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
const isNonNegative = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

function cleanRelPath(file: string): string {
  return file.replace(/^\.?\//, '').replace(/^veri\//, '');
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url} (HTTP ${res.status})`);
  return res.json();
}

export function assertCorners(value: unknown, where: string): asserts value is Corners {
  const ok =
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((c) => Array.isArray(c) && c.length === 2 && c.every((n) => typeof n === 'number' && Number.isFinite(n)));
  if (!ok) throw new Error(`${where}: "koseler" must be 4 [longitude, latitude] pairs`);

  const corners = value as Corners;
  for (let i = 0; i < 4; i++) {
    const [lon, lat] = corners[i];
    if (lon < -360 || lon > 360 || Math.abs(lat) > MAX_MERCATOR_LAT) {
      throw new Error(
        `${where}: corner ${i} [${lon}, ${lat}] is out of bounds (expected [longitude, latitude] with |lat| <= ${MAX_MERCATOR_LAT}°)`,
      );
    }
  }

  const [nw, ne, se, sw] = corners;
  const ax = ne[0] - nw[0];
  const ay = ne[1] - nw[1];
  const bx = sw[0] - nw[0];
  const by = sw[1] - nw[1];
  // Clockwise [NW, NE, SE, SW] in [lon, lat] (east = +x, north = +y) has ax*by - ay*bx < 0.
  const det = ax * by - bx * ay;
  if (!(det < -1e-18)) {
    throw new Error(`${where}: "koseler" must be ordered clockwise [NW, NE, SE, SW] with row 0 at the north edge`);
  }
  // Guard against self-intersecting / swapped SE-SW corners.
  const expectedSeLon = ne[0] + sw[0] - nw[0];
  const expectedSeLat = ne[1] + sw[1] - nw[1];
  const span = Math.hypot(ax, ay) + Math.hypot(bx, by);
  if (Math.hypot(se[0] - expectedSeLon, se[1] - expectedSeLat) > span * 0.15) {
    throw new Error(`${where}: SE corner does not match the [NW, NE, SE, SW] parallelogram (check corner order)`);
  }
}

export function assertBounds(value: unknown, where: string): asserts value is TileBounds {
  const ok = Array.isArray(value) && value.length === 4 && value.every((n) => typeof n === 'number' && Number.isFinite(n));
  if (!ok) throw new Error(`${where}: "sinir" must be [west, south, east, north] numbers`);
  const [west, south, east, north] = value as TileBounds;
  if (west >= east || south >= north) {
    throw new Error(`${where}: "sinir" [${west}, ${south}, ${east}, ${north}] must have west < east and south < north`);
  }
  if (west < -360 || east > 360 || Math.abs(south) > MAX_MERCATOR_LAT || Math.abs(north) > MAX_MERCATOR_LAT) {
    throw new Error(`${where}: "sinir" [${west}, ${south}, ${east}, ${north}] is outside valid Web Mercator bounds`);
  }
}

function boundsFromCorners(corners: Corners): TileBounds {
  const lons = corners.map((c) => c[0]);
  const lats = corners.map((c) => c[1]);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
}

/** Accepts either a bare array of layers or an object with a "katmanlar" array. */
export async function loadLayerCatalog(): Promise<LayerCatalog> {
  const raw = await fetchJson(LAYERS_URL);
  const obj = Array.isArray(raw) ? { katmanlar: raw } : isRecord(raw) ? raw : null;
  if (!obj || !Array.isArray(obj.katmanlar) || obj.katmanlar.length === 0) {
    throw new Error('katmanlar.json contains no layers');
  }
  const seenIds = new Set<string>(['background', 'route-casing', 'route-line', 'route-unsafe']);
  const layers = (obj.katmanlar as unknown[]).map((item, idx): LayerDef => {
    if (!isRecord(item)) throw new Error(`katmanlar.json: layer #${idx} is not an object`);
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id) throw new Error(`katmanlar.json: layer #${idx} is missing "id"`);
    if (seenIds.has(id)) throw new Error(`katmanlar.json: duplicate or reserved layer id "${id}"`);
    seenIds.add(id);

    const where = `Layer "${id}"`;
    const karolarRaw = typeof item.karolar === 'string' ? item.karolar.trim() : '';
    const karolar = karolarRaw ? (/^https?:\/\//i.test(karolarRaw) ? karolarRaw : cleanRelPath(karolarRaw)) : undefined;

    let dosya: string | undefined;
    let koseler: Corners | undefined;
    let sema: TileScheme | undefined;
    let min_zoom: number | undefined;
    let max_zoom: number | undefined;
    let sinir: TileBounds | undefined;
    let karo_boyutu: number | undefined;

    if (karolar) {
      if (!karolar.includes('{z}') || !karolar.includes('{x}') || (!karolar.includes('{y}') && !karolar.includes('{-y}'))) {
        throw new Error(`${where}: "karolar" template must include {z}, {x}, and {y}`);
      }
      if (item.sema !== undefined) {
        if (item.sema !== 'xyz' && item.sema !== 'tms') {
          throw new Error(`${where}: "sema" must be "xyz" or "tms"`);
        }
        sema = item.sema;
      } else {
        sema = 'xyz';
      }
      if (item.min_zoom !== undefined) {
        if (!(typeof item.min_zoom === 'number' && Number.isInteger(item.min_zoom) && item.min_zoom >= 0 && item.min_zoom <= 24)) {
          throw new Error(`${where}: "min_zoom" must be an integer between 0 and 24`);
        }
        min_zoom = item.min_zoom;
      }
      if (item.max_zoom !== undefined) {
        if (!(typeof item.max_zoom === 'number' && Number.isInteger(item.max_zoom) && item.max_zoom >= 0 && item.max_zoom <= 24)) {
          throw new Error(`${where}: "max_zoom" must be an integer between 0 and 24`);
        }
        max_zoom = item.max_zoom;
      }
      if (min_zoom !== undefined && max_zoom !== undefined && min_zoom > max_zoom) {
        throw new Error(`${where}: "min_zoom" (${min_zoom}) cannot exceed "max_zoom" (${max_zoom})`);
      }
      if (item.sinir !== undefined) {
        assertBounds(item.sinir, where);
        sinir = item.sinir;
      } else if (item.koseler !== undefined) {
        assertCorners(item.koseler, where);
        koseler = item.koseler;
        sinir = boundsFromCorners(item.koseler);
      } else {
        throw new Error(`${where}: tile layer needs "sinir" [west, south, east, north]`);
      }
      if (item.karo_boyutu !== undefined) {
        if (!(typeof item.karo_boyutu === 'number' && Number.isInteger(item.karo_boyutu) && item.karo_boyutu > 0)) {
          throw new Error(`${where}: "karo_boyutu" must be a positive integer`);
        }
        karo_boyutu = item.karo_boyutu;
      }
    } else {
      const dosyaStr = typeof item.dosya === 'string' ? cleanRelPath(item.dosya.trim()) : '';
      if (!dosyaStr) throw new Error(`${where}: layer needs either "karolar" or "dosya" + "koseler"`);
      assertCorners(item.koseler, where);
      dosya = dosyaStr;
      koseler = item.koseler;
    }

    const lejant = Array.isArray(item.lejant)
      ? item.lejant
          .filter((e): e is Record<string, unknown> => isRecord(e) && typeof e.renk === 'string' && typeof e.etiket_en === 'string')
          .map((e) => ({ renk: e.renk as string, etiket_en: e.etiket_en as string }))
      : [];

    const acikRaw = item.varsayilan_acik ?? item.acik;
    const varsayilan_acik = typeof acikRaw === 'boolean' ? acikRaw : undefined;
    const saydamlikRaw = item.varsayilan_saydamlik ?? item.saydamlik;
    let varsayilan_saydamlik: number | undefined;
    if (typeof saydamlikRaw === 'number' && Number.isFinite(saydamlikRaw) && saydamlikRaw >= 0 && saydamlikRaw <= 100) {
      varsayilan_saydamlik = saydamlikRaw > 1 ? saydamlikRaw / 100 : saydamlikRaw;
    }

    return {
      id,
      ad_en: typeof item.ad_en === 'string' && item.ad_en ? item.ad_en : id,
      tur: typeof item.tur === 'string' ? item.tur : '',
      dosya,
      koseler,
      karolar,
      sema,
      min_zoom,
      max_zoom,
      sinir,
      karo_boyutu,
      varsayilan_acik,
      varsayilan_saydamlik,
      kaynak: typeof item.kaynak === 'string' ? item.kaynak : '',
      cozunurluk_m: typeof item.cozunurluk_m === 'number' ? item.cozunurluk_m : NaN,
      guven_notu_en: typeof item.guven_notu_en === 'string' ? item.guven_notu_en : '',
      lejant,
    };
  });
  const siteName = typeof obj.alan_en === 'string' && obj.alan_en.trim() ? obj.alan_en.trim() : undefined;
  return { synthetic: obj.sahte === true, siteName, layers };
}

export async function loadGridMeta(): Promise<GridMeta> {
  const raw = await fetchJson(GRID_URL);
  if (!isRecord(raw)) throw new Error('izgara.json must be a JSON object');
  for (const key of ['genislik', 'yukseklik'] as const) {
    const v = raw[key];
    if (!(typeof v === 'number' && Number.isInteger(v) && v > 0)) {
      throw new Error(`izgara.json: "${key}" must be a positive integer`);
    }
  }
  if (!isPositive(raw.hucre_m)) throw new Error('izgara.json: "hucre_m" must be a positive number');
  assertCorners(raw.koseler, 'izgara.json');

  // Slope binary metadata (default "float32" for backward compatibility; production uses "uint8").
  const slopeTypeRaw = typeof raw.egim_tipi === 'string' ? raw.egim_tipi.toLowerCase().trim() : 'float32';
  if (slopeTypeRaw !== 'uint8' && slopeTypeRaw !== 'float32') {
    throw new Error(`izgara.json: unsupported "egim_tipi" "${String(raw.egim_tipi)}" (expected "uint8" or "float32")`);
  }
  const egim_tipi: SlopeEncoding = slopeTypeRaw;
  let egim_olcek = 1;
  if (egim_tipi === 'uint8') {
    if (!isPositive(raw.egim_olcek)) {
      throw new Error('izgara.json: "egim_olcek" must be a positive number when "egim_tipi" is "uint8"');
    }
    egim_olcek = raw.egim_olcek;
  } else if (raw.egim_olcek !== undefined) {
    if (!isPositive(raw.egim_olcek)) throw new Error('izgara.json: "egim_olcek" must be a positive number');
    egim_olcek = raw.egim_olcek;
  }

  let egim_veri_yok = egim_tipi === 'uint8' ? 255 : -9999;
  if (raw.egim_veri_yok !== undefined) {
    if (!(typeof raw.egim_veri_yok === 'number' && Number.isFinite(raw.egim_veri_yok))) {
      throw new Error('izgara.json: "egim_veri_yok" must be a finite number');
    }
    if (egim_tipi === 'uint8' && (!Number.isInteger(raw.egim_veri_yok) || raw.egim_veri_yok < 0 || raw.egim_veri_yok > 255)) {
      throw new Error('izgara.json: "egim_veri_yok" must be an integer 0..255 for uint8 slope');
    }
    egim_veri_yok = raw.egim_veri_yok;
  }

  let egim_taban_uzunlugu_m: number | undefined;
  if (raw.egim_taban_uzunlugu_m !== undefined) {
    if (!isPositive(raw.egim_taban_uzunlugu_m)) {
      throw new Error('izgara.json: "egim_taban_uzunlugu_m" must be a positive number');
    }
    egim_taban_uzunlugu_m = raw.egim_taban_uzunlugu_m;
  }

  // Elevation binary metadata (default "float32" for backward compatibility; production uses little-endian "int16").
  const elevTypeRaw = typeof raw.yukseklik_tipi === 'string' ? raw.yukseklik_tipi.toLowerCase().trim() : 'float32';
  if (elevTypeRaw !== 'int16' && elevTypeRaw !== 'float32') {
    throw new Error(`izgara.json: unsupported "yukseklik_tipi" "${String(raw.yukseklik_tipi)}" (expected "int16" or "float32")`);
  }
  const yukseklik_tipi: ElevationEncoding = elevTypeRaw;

  let yukseklik_taban_m = 0;
  if (yukseklik_tipi === 'int16') {
    if (!(typeof raw.yukseklik_taban_m === 'number' && Number.isFinite(raw.yukseklik_taban_m))) {
      throw new Error('izgara.json: "yukseklik_taban_m" must be a finite number when "yukseklik_tipi" is "int16"');
    }
    yukseklik_taban_m = raw.yukseklik_taban_m;
  } else if (raw.yukseklik_taban_m !== undefined) {
    if (!(typeof raw.yukseklik_taban_m === 'number' && Number.isFinite(raw.yukseklik_taban_m))) {
      throw new Error('izgara.json: "yukseklik_taban_m" must be a finite number');
    }
    yukseklik_taban_m = raw.yukseklik_taban_m;
  }

  let yukseklik_olcek_m = 1;
  if (yukseklik_tipi === 'int16') {
    if (!isPositive(raw.yukseklik_olcek_m)) {
      throw new Error('izgara.json: "yukseklik_olcek_m" must be a positive number when "yukseklik_tipi" is "int16"');
    }
    yukseklik_olcek_m = raw.yukseklik_olcek_m;
  } else if (raw.yukseklik_olcek_m !== undefined) {
    if (!isPositive(raw.yukseklik_olcek_m)) {
      throw new Error('izgara.json: "yukseklik_olcek_m" must be a positive number');
    }
    yukseklik_olcek_m = raw.yukseklik_olcek_m;
  }

  let yukseklik_veri_yok = yukseklik_tipi === 'int16' ? -32768 : -9999;
  if (raw.yukseklik_veri_yok !== undefined) {
    if (!(typeof raw.yukseklik_veri_yok === 'number' && Number.isFinite(raw.yukseklik_veri_yok))) {
      throw new Error('izgara.json: "yukseklik_veri_yok" must be a finite number');
    }
    if (
      yukseklik_tipi === 'int16' &&
      (!Number.isInteger(raw.yukseklik_veri_yok) || raw.yukseklik_veri_yok < -32768 || raw.yukseklik_veri_yok > 32767)
    ) {
      throw new Error('izgara.json: "yukseklik_veri_yok" must be an integer -32768..32767 for int16 elevation');
    }
    yukseklik_veri_yok = raw.yukseklik_veri_yok;
  }

  const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const siteName = optStr(raw.alan_en);
  return {
    synthetic: raw.sahte === true,
    siteName,
    genislik: raw.genislik as number,
    yukseklik: raw.yukseklik as number,
    hucre_m: raw.hucre_m,
    koseler: raw.koseler,
    egim_tipi,
    egim_olcek,
    egim_veri_yok,
    egim_taban_uzunlugu_m,
    egim_yontemi_en: optStr(raw.egim_yontemi_en),
    yukseklik_tipi,
    yukseklik_taban_m,
    yukseklik_olcek_m,
    yukseklik_veri_yok,
    kaynak_en: optStr(raw.kaynak_en),
    guven_notu_en: optStr(raw.guven_notu_en),
  };
}

export const layerImageUrl = (layer: LayerDef): string => new URL(`${DATA_DIR}/${layer.dosya}`, document.baseURI).href;

/**
 * Resolves a relative tile template against document.baseURI so MapLibre's
 * bundled Web Worker fetches from the right subpath (e.g. GitHub Pages) without
 * percent-encoding the {z}/{x}/{y} placeholders.
 */
export function layerTileUrl(karolar: string): string {
  if (/^https?:\/\//i.test(karolar)) return karolar;
  const base = new URL(`${DATA_DIR}/`, document.baseURI).href;
  return `${base}${karolar.replace(/^\/+/, '')}`;
}

// ------------------------------------------------------------ mobility & landing craft parameters

export type ConfidenceLevel = 'olculmus' | 'tasarim_degeri' | 'olceklenmis' | 'VARSAYIM' | string;

export interface ParamMeta {
  kaynak?: string;
  guven?: ConfidenceLevel;
}

export interface SpeedEntry {
  egim_derece: number;
  hiz_m_s: number;
}

export interface Traverser {
  id: string;
  ad_en: string;
  aciklama_en?: string;
  azami_egim_derece: number;
  hiz_tablosu: SpeedEntry[];
  /** Optional: slope from which the route counts as "close to the limit". */
  uyari_egim_derece?: number;
  azami_engel_m?: number;
  azami_sure_saat?: number;
  /** Optional explicit suit life-support limit (hours) for walk-back survival checks. */
  yasam_destek_saat?: number;
  /** Optional explicit toggle for walk-back survival check (defaults to true for roverli_insan). */
  yuruyus_donus?: boolean;
  enerji_katsayisi?: number;
  kaynaklar: Record<string, string>;
  guvenler: Record<string, ConfidenceLevel>;
}

export interface LandingCraftParams {
  azami_egim_derece?: number;
  azami_kaya_m?: number;
  azami_yukseklik_m?: number;
  guvenli_alan_capi_m?: number;
  kaynaklar: Record<string, string>;
  guvenler: Record<string, ConfidenceLevel>;
}

export interface MobilityParams {
  synthetic: boolean;
  traversers: Traverser[];
  landingCraft: LandingCraftParams | null;
}

const TRAVERSER_LABELS_EN: Record<string, { name: string; note?: string }> = {
  yuruyen_insan: { name: 'Walking astronaut (suited)' },
  roverli_insan: { name: 'Crewed rover', note: 'Range bounded by walk-back survival rule if rover fails.' },
  rover: { name: 'Uncrewed rover' },
  suited_astronaut: { name: 'Suited astronaut' },
  loaded_astronaut: { name: 'Astronaut carrying load' },
};

const RESERVED_MOBILITY_KEYS = new Set(['sahte', 'not_en', 'aciklama_en', 'gezginler', 'inis_araci', 'kaynaklar']);

interface Unwrapped<T> {
  value: T | undefined;
  kaynak?: string;
  guven?: ConfidenceLevel;
}

function unwrapField(raw: unknown): Unwrapped<unknown> {
  if (isRecord(raw) && 'deger' in raw) {
    return {
      value: raw.deger,
      kaynak: typeof raw.kaynak === 'string' ? raw.kaynak : undefined,
      guven: typeof raw.guven === 'string' ? raw.guven : undefined,
    };
  }
  return { value: raw };
}

function parseSpeedTable(rawField: unknown, where: string): { entries: SpeedEntry[]; kaynak?: string; guven?: ConfidenceLevel } {
  const { value, kaynak, guven } = unwrapField(rawField);
  const entries: SpeedEntry[] = [];
  let rowKaynak = kaynak;
  let rowGuven = guven;

  if (Array.isArray(value)) {
    for (const item of value) {
      if (Array.isArray(item) && item.length >= 2) {
        const s = unwrapField(item[0]).value;
        const v = unwrapField(item[1]);
        if (!isNonNegative(s) || !isPositive(v.value)) {
          throw new Error(`${where}: invalid [slope, speed] tuple in "hiz_tablosu"`);
        }
        rowKaynak ??= v.kaynak;
        rowGuven ??= v.guven;
        entries.push({ egim_derece: s, hiz_m_s: v.value });
      } else if (isRecord(item)) {
        const s = unwrapField(item.egim_derece ?? item.egim ?? item.slope_deg).value;
        const v = unwrapField(item.hiz_m_s ?? item.hiz ?? item.speed_m_s);
        if (!isNonNegative(s) || !isPositive(v.value)) {
          throw new Error(`${where}: every "hiz_tablosu" entry needs non-negative "egim_derece" and positive "hiz_m_s"`);
        }
        rowKaynak ??= v.kaynak;
        rowGuven ??= v.guven;
        entries.push({ egim_derece: s, hiz_m_s: v.value });
      } else {
        throw new Error(`${where}: malformed entry in "hiz_tablosu"`);
      }
    }
  } else if (isRecord(value)) {
    // Supports dictionary form: { "0": 1.0, "5": 0.9 } or { "0": { deger: 1.0, kaynak, guven } }
    for (const [degKey, speedVal] of Object.entries(value)) {
      const deg = Number(degKey);
      const v = unwrapField(speedVal);
      if (!isNonNegative(deg) || !isPositive(v.value)) {
        throw new Error(`${where}: invalid slope/speed pair "${degKey}" in "hiz_tablosu"`);
      }
      rowKaynak ??= v.kaynak;
      rowGuven ??= v.guven;
      entries.push({ egim_derece: deg, hiz_m_s: v.value });
    }
  }

  if (entries.length === 0) throw new Error(`${where}: "hiz_tablosu" is empty`);
  entries.sort((a, b) => a.egim_derece - b.egim_derece);
  return { entries, kaynak: rowKaynak, guven: rowGuven };
}

function parseTraverser(idFallback: string, raw: Record<string, unknown>): Traverser {
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : idFallback;
  const where = `mobilite_parametreleri.json, traverser "${id}"`;
  const fallbackLabel = TRAVERSER_LABELS_EN[id];
  const ad_en =
    typeof raw.ad_en === 'string' && raw.ad_en.trim()
      ? raw.ad_en.trim()
      : fallbackLabel?.name ?? id.replace(/_/g, ' ');
  const aciklama_en =
    typeof raw.aciklama_en === 'string' && raw.aciklama_en.trim()
      ? raw.aciklama_en.trim()
      : fallbackLabel?.note;

  const baseSources = isRecord(raw.kaynaklar) ? (raw.kaynaklar as Record<string, string>) : {};
  const baseConf = isRecord(raw.guvenler) ? (raw.guvenler as Record<string, ConfidenceLevel>) : {};
  const kaynaklar: Record<string, string> = { ...baseSources };
  const guvenler: Record<string, ConfidenceLevel> = { ...baseConf };

  const readNum = (key: string, altKeys: string[] = []): number | undefined => {
    let field = raw[key];
    for (const alt of altKeys) if (field === undefined) field = raw[alt];
    if (field === undefined) return undefined;
    const u = unwrapField(field);
    if (u.kaynak) kaynaklar[key] = u.kaynak;
    if (u.guven) guvenler[key] = u.guven;
    if (u.value === null || u.value === undefined) return undefined;
    if (!(typeof u.value === 'number' && Number.isFinite(u.value))) {
      throw new Error(`${where}: "${key}" must be a finite number`);
    }
    return u.value;
  };

  const azami_egim_derece = readNum('azami_egim_derece');
  if (!isPositive(azami_egim_derece)) {
    throw new Error(`${where}: "azami_egim_derece" must be a positive number`);
  }

  const speedParsed = parseSpeedTable(raw.hiz_tablosu, where);
  if (speedParsed.kaynak) kaynaklar.hiz_tablosu = speedParsed.kaynak;
  if (speedParsed.guven) guvenler.hiz_tablosu = speedParsed.guven;

  const uyariRaw = readNum('uyari_egim_derece');
  const engelRaw = readNum('azami_engel_m', ['azami_kaya_m']);
  const sureRaw = readNum('azami_sure_saat');
  const yasamRaw = readNum('yasam_destek_saat', ['yuruyus_sure_saat', 'walk_back_saat']);
  const enerjiRaw = readNum('enerji_katsayisi');

  const walkFlagField = raw.yuruyus_donus ?? raw.walk_back;
  const walkFlagUnwrapped = walkFlagField !== undefined ? unwrapField(walkFlagField).value : undefined;
  const yuruyus_donus = typeof walkFlagUnwrapped === 'boolean' ? walkFlagUnwrapped : undefined;

  return {
    id,
    ad_en,
    aciklama_en,
    azami_egim_derece,
    hiz_tablosu: speedParsed.entries,
    uyari_egim_derece: isPositive(uyariRaw) && uyariRaw < azami_egim_derece ? uyariRaw : undefined,
    azami_engel_m: isPositive(engelRaw) ? engelRaw : undefined,
    azami_sure_saat: isPositive(sureRaw) ? sureRaw : undefined,
    yasam_destek_saat: isPositive(yasamRaw) ? yasamRaw : undefined,
    yuruyus_donus,
    enerji_katsayisi: isPositive(enerjiRaw) ? enerjiRaw : undefined,
    kaynaklar,
    guvenler,
  };
}

function parseLandingCraft(raw: unknown): LandingCraftParams | null {
  if (!isRecord(raw)) return null;
  const kaynaklar: Record<string, string> = isRecord(raw.kaynaklar) ? { ...(raw.kaynaklar as Record<string, string>) } : {};
  const guvenler: Record<string, ConfidenceLevel> = isRecord(raw.guvenler) ? { ...(raw.guvenler as Record<string, ConfidenceLevel>) } : {};

  const readOpt = (key: string): number | undefined => {
    if (!(key in raw)) return undefined;
    const u = unwrapField(raw[key]);
    if (u.kaynak) kaynaklar[key] = u.kaynak;
    if (u.guven) guvenler[key] = u.guven;
    return typeof u.value === 'number' && Number.isFinite(u.value) ? u.value : undefined;
  };

  const azami_egim_derece = readOpt('azami_egim_derece');
  const azami_kaya_m = readOpt('azami_kaya_m');
  const azami_yukseklik_m = readOpt('azami_yukseklik_m');
  const capi = readOpt('guvenli_alan_capi_m');

  return {
    azami_egim_derece: isPositive(azami_egim_derece) ? azami_egim_derece : undefined,
    azami_kaya_m: isPositive(azami_kaya_m) ? azami_kaya_m : undefined,
    azami_yukseklik_m,
    guvenli_alan_capi_m: isPositive(capi) ? capi : undefined,
    kaynaklar,
    guvenler,
  };
}

/**
 * Supports both:
 *   1) Dictionary schema (team mobility contract): { yuruyen_insan: {...}, roverli_insan: {...}, rover: {...}, inis_araci: {...} }
 *      with { deger, kaynak, guven } parameter objects, and
 *   2) Legacy list schema: { gezginler: [...] } or a bare [...] array.
 */
export async function loadMobility(): Promise<MobilityParams> {
  const raw = await fetchJson(MOBILITY_URL);
  if (Array.isArray(raw)) {
    if (raw.length === 0) throw new Error('mobilite_parametreleri.json contains no traversers');
    const traversers = raw.map((item, i) => {
      if (!isRecord(item)) throw new Error(`mobilite_parametreleri.json: traverser #${i} is not an object`);
      return parseTraverser(`traverser_${i + 1}`, item);
    });
    return { synthetic: false, traversers, landingCraft: null };
  }

  if (!isRecord(raw)) throw new Error('mobilite_parametreleri.json must be an object or array');
  const landingCraft = parseLandingCraft(raw.inis_araci);
  let traversers: Traverser[] = [];

  if (Array.isArray(raw.gezginler)) {
    traversers = raw.gezginler.map((item, i) => {
      if (!isRecord(item)) throw new Error(`mobilite_parametreleri.json: traverser #${i} is not an object`);
      return parseTraverser(`traverser_${i + 1}`, item);
    });
  } else if (isRecord(raw.gezginler)) {
    for (const [key, val] of Object.entries(raw.gezginler)) {
      if (isRecord(val)) traversers.push(parseTraverser(key, val));
    }
  } else {
    // Top-level dictionary: yuruyen_insan, roverli_insan, rover (or any traverser block with azami_egim_derece & hiz_tablosu)
    const preferredOrder = ['yuruyen_insan', 'roverli_insan', 'rover'];
    const keys = [
      ...preferredOrder.filter((k) => k in raw),
      ...Object.keys(raw).filter((k) => !RESERVED_MOBILITY_KEYS.has(k) && !preferredOrder.includes(k)),
    ];
    for (const key of keys) {
      const val = raw[key];
      if (isRecord(val) && ('hiz_tablosu' in val || 'azami_egim_derece' in val)) {
        traversers.push(parseTraverser(key, val));
      }
    }
  }

  if (traversers.length === 0) {
    throw new Error('mobilite_parametreleri.json contains no traversers');
  }
  return { synthetic: raw.sahte === true, traversers, landingCraft };
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

export interface StopsCatalog {
  synthetic: boolean;
  stops: ScienceStop[];
}

/** The stops file is optional: without it the app simply shows no predefined stops. */
export async function loadStops(): Promise<StopsCatalog> {
  let raw: unknown;
  try {
    raw = await fetchJson(STOPS_URL);
  } catch {
    return { synthetic: false, stops: [] };
  }
  if (!raw || (typeof raw !== 'object' && !Array.isArray(raw))) {
    return { synthetic: false, stops: [] };
  }
  const synthetic = isRecord(raw) && raw.sahte === true;
  const list = Array.isArray(raw) ? raw : isRecord(raw) ? raw.duraklar : undefined;
  if (!Array.isArray(list)) return { synthetic, stops: [] };
  const stops = list
    .filter(
      (stop): stop is Record<string, unknown> =>
        isRecord(stop) &&
        typeof stop.ad_en === 'string' &&
        Array.isArray(stop.konum) &&
        stop.konum.length === 2 &&
        stop.konum.every((n) => typeof n === 'number' && Number.isFinite(n)) &&
        Math.abs(stop.konum[1] as number) <= MAX_MERCATOR_LAT,
    )
    .map((stop, idx): ScienceStop => ({
      id: typeof stop.id === 'string' && stop.id ? stop.id : `stop_${idx + 1}`,
      ad_en: stop.ad_en as string,
      konum: stop.konum as LonLat,
      aciklama_en: typeof stop.aciklama_en === 'string' ? stop.aciklama_en : undefined,
      foto: typeof stop.foto === 'string' && stop.foto.trim() ? cleanRelPath(stop.foto.trim()) : undefined,
      foto_kaynak: typeof stop.foto_kaynak === 'string' ? stop.foto_kaynak : undefined,
    }));
  return { synthetic, stops };
}
