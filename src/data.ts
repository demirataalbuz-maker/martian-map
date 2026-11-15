// AI-assisted code: written with Claude (Anthropic) and Antigravity (Google DeepMind), reviewed by the team.
// Loaders and types for the team's data contract (field names are Turkish by agreement).

import {
  CAGATAY_MOBILITY_URL,
  DATA_CACHE_TAG,
  DATA_DIR,
  GRID_URL,
  KURE_DUST_URL,
  KURE_META_URL,
  KURE_RADIATION_URL,
  LAYERS_URL,
  MOBILITY_URL,
  STOPS_URL,
} from './config';

export type LonLat = [number, number];
/** Corner order: top-left (NW), top-right (NE), bottom-right (SE), bottom-left (SW). */
export type Corners = [LonLat, LonLat, LonLat, LonLat];
/** Bounding box order: [west, south, east, north] in [longitude, latitude]. */
export type TileBounds = [number, number, number, number];
export type TileScheme = 'xyz' | 'tms';
export type SlopeEncoding = 'uint8' | 'float32';
export type ElevationEncoding = 'int16' | 'float32';
export type LayerArea = 'kure' | 'ctx' | 'hirise';

export interface LegendEntry {
  renk: string;
  etiket_en: string;
}

export interface LayerDef {
  id: string;
  alan?: LayerArea;
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
  lisans?: string;
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
  /** True only when an explicit rock-abundance cost input was evaluated; otherwise false/undefined (assumed). */
  kaya_verisi_var?: boolean;
  /** True only when an explicit thermal-inertia cost input was evaluated; otherwise false/undefined (assumed). */
  termal_atalet_verisi_var?: boolean;
}

const MAX_MERCATOR_LAT = 85.051129;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPositive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
const isNonNegative = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

function cleanRelPath(file: string): string {
  return file.replace(/^\.?\//, '').replace(/^veri\//, '');
}

/** Structured error thrown when fetching or decoding a JSON data file fails. */
export class DataLoadError extends Error {
  readonly url: string;
  readonly reason: string;
  readonly status?: number;

  constructor(url: string, reason: string, status?: number) {
    super(`Could not load "${url}": ${reason}`);
    this.name = 'DataLoadError';
    this.url = url;
    this.reason = reason;
    this.status = status;
  }
}

export async function fetchJson(url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new DataLoadError(url, `Network request failed (${detail})`);
  }

  if (!res.ok) {
    const statusDesc = res.status === 404 ? 'File not found (HTTP 404)' : `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
    throw new DataLoadError(url, statusDesc, res.status);
  }

  const ct = (res.headers.get('content-type') ?? '').toLowerCase();
  const text = await res.text();
  const trimmed = text.trimStart();
  if (ct.includes('text/html') || trimmed.startsWith('<')) {
    throw new DataLoadError(url, 'File missing or misrouted (server returned HTML instead of JSON)', res.status);
  }

  try {
    return JSON.parse(text);
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new DataLoadError(url, `Invalid JSON (${detail})`, res.status);
  }
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
  const seenIds = new Set<string>([
    'background',
    'route-casing',
    'route-line',
    'route-abandoned',
    'route-unsafe',
    'route-escape-casing',
    'route-escape',
    'inis-elipsi-line',
    'hirise-frame-line',
    'hirise-frame-glow',
  ]);
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

    const alanRaw = typeof item.alan === 'string' ? item.alan.trim().toLowerCase() : '';
    const alan: LayerArea | undefined =
      alanRaw === 'kure' || alanRaw === 'ctx' || alanRaw === 'hirise' ? alanRaw : undefined;

    return {
      id,
      alan,
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
      lisans: typeof item.lisans === 'string' && item.lisans.trim() ? item.lisans.trim() : undefined,
      cozunurluk_m: typeof item.cozunurluk_m === 'number' ? item.cozunurluk_m : NaN,
      guven_notu_en: typeof item.guven_notu_en === 'string' ? item.guven_notu_en : '',
      lejant,
    };
  });
  const siteName = typeof obj.alan_en === 'string' && obj.alan_en.trim() ? obj.alan_en.trim() : undefined;
  return { synthetic: obj.sahte === true, siteName, layers };
}

export async function loadGridMeta(url: string = GRID_URL): Promise<GridMeta> {
  const raw = await fetchJson(url);
  if (!isRecord(raw)) throw new Error(`${url} must be a JSON object`);
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
    kaya_verisi_var: raw.kaya_verisi_var === true,
    termal_atalet_verisi_var: raw.termal_atalet_verisi_var === true,
  };
}

export async function loadOptionalGridMeta(url: string): Promise<GridMeta | null> {
  try {
    return await loadGridMeta(url);
  } catch {
    return null;
  }
}

export const layerImageUrl = (layer: LayerDef): string => {
  const u = new URL(`${DATA_DIR}/${layer.dosya}`, document.baseURI);
  u.searchParams.set('v', DATA_CACHE_TAG);
  return u.href;
};

/**
 * Resolves a relative tile template against document.baseURI so MapLibre's
 * bundled Web Worker fetches from the right subpath (e.g. GitHub Pages) without
 * percent-encoding the {z}/{x}/{y} placeholders.
 */
export function layerTileUrl(karolar: string): string {
  const raw = /^https?:\/\//i.test(karolar)
    ? karolar
    : `${new URL(`${DATA_DIR}/`, document.baseURI).href}${karolar.replace(/^\/+/, '')}`;
  return `${raw}${raw.includes('?') ? '&' : '?'}v=${DATA_CACHE_TAG}`;
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
  hiz_km_sa?: number;
}

export interface EnergyProfile {
  profil_adi_en: string;
  kutle_kg: number;
  yercekimi_m_s2: number;
  yuvarlanma_direnci: number;
  verim: number;
  baz_guc_w: number;
  enerji_kapasite_wh: number;
  enerji_kalan_wh: number;
  rezerv_orani: number;
}

export interface GroundMobilityModel {
  /** Thermal inertia below which fine dust is considered hazardous (J m^-2 K^-1 s^-1/2). */
  tiDustThreshold: number;
  /** Thermal inertia below which ground is classed as loose fine regolith (caution band). */
  tiLooseThreshold: number;
  /** Thermal inertia split for soft unconsolidated sand inside the <350 caution band. */
  tiVeryLooseThreshold: number;
  /** Assumed speed multiplier on loose regolith (200 <= TI < 350). */
  looseSpeedFactor: number;
  /** Assumed speed multiplier on very loose sand / eolian bedforms (TI < 200). */
  veryLooseSpeedFactor: number;
  /** Baseline firm-rock rolling resistance coefficient (c_rr). */
  hardRollingResistance: number;
  /** Assumed rolling resistance coefficient on loose regolith. */
  looseRollingResistance: number;
  /** Assumed rolling resistance coefficient on soft sand / eolian bedforms. */
  veryLooseRollingResistance: number;
  kaynaklar: Record<string, string>;
  guvenler: Record<string, ConfidenceLevel>;
}

export interface Traverser {
  id: string;
  ad_en: string;
  aciklama_en?: string;
  azami_egim_derece: number;
  hiz_tablosu: SpeedEntry[];
  /** Optional downhill speed lookup table (symmetric fallback to hiz_tablosu when omitted). */
  inis_hiz_tablosu?: SpeedEntry[];
  /** Optional: slope from which the route counts as "close to the limit". */
  uyari_egim_derece?: number;
  azami_engel_m?: number;
  azami_sure_saat?: number;
  /** Optional design life-support duration before safety reserve factor (hours). */
  yasam_destek_tasarim_saat?: number;
  /** Optional life-support safety factor (0..1). */
  sure_payi?: number;
  /** Optional flat-ground reference walking speed (km/h). */
  yurume_baz_hiz_km_sa?: number;
  /** Optional explicit suit life-support limit (hours) for walk-back survival checks. */
  yasam_destek_saat?: number;
  /** Optional explicit toggle for walk-back survival check (defaults to true for roverli_insan). */
  yuruyus_donus?: boolean;
  /** Optional straight-line radial standoff cap from base/landing (metres). */
  uzaklik_tavani_m?: number;
  /** Optional single-stint (1 EVA or 1 sol) distance budget in metres from sefer_butcesi. */
  sefer_mesafe_m?: number;
  /** Optional measured average drive per driving sol in metres (e.g. Perseverance 83.1 m). */
  surus_gunu_ortalamasi_m?: number;
  /** Optional measured average drive across all mission sols (e.g. Perseverance 22.9 m). */
  sol_basina_ortalama_m?: number;
  /** Optional total cumulative lifetime/campaign range cap in metres (e.g. rover odometer cap). */
  toplam_menzil_m?: number;
  /** Optional number of EVAs per day (e.g. 1 EVA/day). */
  gunde_eva_sayisi?: number;
  /** Optional post-hoc vehicle energy profile (evaluated on drawn route without altering A* search). */
  enerji_profili?: EnergyProfile;
  enerji_katsayisi?: number;
  kaynaklar: Record<string, string>;
  guvenler: Record<string, ConfidenceLevel>;
}

export interface LandingCraftParams {
  azami_egim_derece?: number;
  azami_kaya_m?: number;
  azami_yukseklik_m?: number;
  guvenli_alan_capi_m?: number;
  puskurtme_guvenlik_yaricapi_m?: number;
  kaynaklar: Record<string, string>;
  guvenler: Record<string, ConfidenceLevel>;
}

export interface MobilityParams {
  synthetic: boolean;
  traversers: Traverser[];
  landingCraft: LandingCraftParams | null;
  landingCraftCrewed: LandingCraftParams | null;
  landingCraftRobotic: LandingCraftParams | null;
  ground: GroundMobilityModel | null;
}

const TRAVERSER_LABELS_EN: Record<string, { name: string; note?: string }> = {
  yuruyen_insan: { name: 'Walking astronaut (suited)' },
  roverli_insan: { name: 'Crewed rover', note: 'Range bounded by walk-back survival rule if rover fails.' },
  rover: { name: 'Uncrewed rover' },
  suited_astronaut: { name: 'Suited astronaut' },
  loaded_astronaut: { name: 'Astronaut carrying load' },
};

const RESERVED_MOBILITY_KEYS = new Set([
  'sahte',
  'not',
  'not_en',
  'aciklama_en',
  'gezginler',
  'inis_araci',
  'inis_araci_insanli',
  'inis_araci_robotik',
  'sefer_butcesi',
  'zemin',
  'zemin_etkisi',
  'kaynaklar',
]);

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
        const vKmh = unwrapField(item.hiz_km_sa ?? item.hiz_km_h ?? item.speed_km_h);
        const vMs = unwrapField(item.hiz_m_s ?? item.hiz ?? item.speed_m_s);
        const hasKmh = isPositive(vKmh.value);
        const hasMs = isPositive(vMs.value);
        if (!isNonNegative(s) || (!hasKmh && !hasMs)) {
          throw new Error(
            `${where}: every "hiz_tablosu" entry needs non-negative "egim_derece" and positive "hiz_m_s" or "hiz_km_sa"`,
          );
        }
        rowKaynak ??= vKmh.kaynak ?? vMs.kaynak;
        rowGuven ??= vKmh.guven ?? vMs.guven;
        const speedMs = hasKmh ? (vKmh.value as number) / 3.6 : (vMs.value as number);
        entries.push({
          egim_derece: s,
          hiz_m_s: speedMs,
          ...(hasKmh ? { hiz_km_sa: vKmh.value as number } : {}),
        });
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

  let inis_hiz_tablosu: SpeedEntry[] | undefined;
  if ('inis_hiz_tablosu' in raw && raw.inis_hiz_tablosu !== undefined) {
    const downParsed = parseSpeedTable(raw.inis_hiz_tablosu, `${where} (inis_hiz_tablosu)`);
    inis_hiz_tablosu = downParsed.entries;
    if (downParsed.kaynak) kaynaklar.inis_hiz_tablosu = downParsed.kaynak;
    if (downParsed.guven) guvenler.inis_hiz_tablosu = downParsed.guven;
  }

  const uyariRaw = readNum('uyari_egim_derece');
  const engelRaw = readNum('azami_engel_m', ['azami_kaya_m']);
  const sureRaw = readNum('azami_sure_saat');
  const yasamTasarimRaw = readNum('yasam_destek_tasarim_saat');
  const surePayiRaw = readNum('sure_payi');
  const yurumeBazRaw = readNum('yurume_baz_hiz_km_sa');
  const yasamRaw = readNum('yasam_destek_saat', ['yuruyus_sure_saat', 'walk_back_saat']);
  let uzaklikM = readNum('uzaklik_tavani_m');
  if (uzaklikM === undefined) {
    const uzaklikKm = readNum('uzaklik_tavani_km');
    if (isPositive(uzaklikKm)) {
      uzaklikM = uzaklikKm * 1000;
      if (kaynaklar.uzaklik_tavani_km && !kaynaklar.uzaklik_tavani_m) kaynaklar.uzaklik_tavani_m = kaynaklar.uzaklik_tavani_km;
      if (guvenler.uzaklik_tavani_km && !guvenler.uzaklik_tavani_m) guvenler.uzaklik_tavani_m = guvenler.uzaklik_tavani_km;
    }
  }
  const seferMesafeRaw = readNum('sefer_mesafe_m');
  const surusGunuOrtRaw = readNum('surus_gunu_ortalamasi_m');
  const solBasinaOrtRaw = readNum('sol_basina_ortalama_m');
  const toplamMenzilRaw = readNum('toplam_menzil_m');
  const gundeEvaRaw = readNum('gunde_eva_sayisi');
  const enerjiRaw = readNum('enerji_katsayisi');

  let enerji_profili: EnergyProfile | undefined;
  if ('enerji_profili' in raw && raw.enerji_profili !== undefined) {
    const epUnwrapped = unwrapField(raw.enerji_profili);
    if (epUnwrapped.kaynak) kaynaklar.enerji_profili = epUnwrapped.kaynak;
    if (epUnwrapped.guven) guvenler.enerji_profili = epUnwrapped.guven;
    if (isRecord(epUnwrapped.value)) {
      const ep = epUnwrapped.value;
      if (
        isPositive(ep.kutle_kg) &&
        isPositive(ep.yercekimi_m_s2) &&
        isNonNegative(ep.yuvarlanma_direnci) &&
        isPositive(ep.verim) &&
        isNonNegative(ep.baz_guc_w) &&
        isPositive(ep.enerji_kapasite_wh) &&
        isPositive(ep.enerji_kalan_wh) &&
        isNonNegative(ep.rezerv_orani)
      ) {
        enerji_profili = {
          profil_adi_en:
            typeof ep.profil_adi_en === 'string' && ep.profil_adi_en.trim()
              ? ep.profil_adi_en.trim()
              : 'Demo vehicle profile',
          kutle_kg: ep.kutle_kg,
          yercekimi_m_s2: ep.yercekimi_m_s2,
          yuvarlanma_direnci: ep.yuvarlanma_direnci,
          verim: ep.verim,
          baz_guc_w: ep.baz_guc_w,
          enerji_kapasite_wh: ep.enerji_kapasite_wh,
          enerji_kalan_wh: ep.enerji_kalan_wh,
          rezerv_orani: ep.rezerv_orani,
        };
      }
    }
  }

  const walkFlagField = raw.yuruyus_donus ?? raw.walk_back;
  const walkFlagUnwrapped = walkFlagField !== undefined ? unwrapField(walkFlagField).value : undefined;
  const yuruyus_donus = typeof walkFlagUnwrapped === 'boolean' ? walkFlagUnwrapped : undefined;

  return {
    id,
    ad_en,
    aciklama_en,
    azami_egim_derece,
    hiz_tablosu: speedParsed.entries,
    inis_hiz_tablosu,
    uyari_egim_derece: isPositive(uyariRaw) && uyariRaw < azami_egim_derece ? uyariRaw : undefined,
    azami_engel_m: isPositive(engelRaw) ? engelRaw : undefined,
    azami_sure_saat: isPositive(sureRaw) ? sureRaw : undefined,
    yasam_destek_tasarim_saat: isPositive(yasamTasarimRaw) ? yasamTasarimRaw : undefined,
    sure_payi: isPositive(surePayiRaw) ? surePayiRaw : undefined,
    yurume_baz_hiz_km_sa: isPositive(yurumeBazRaw) ? yurumeBazRaw : undefined,
    yasam_destek_saat: isPositive(yasamRaw) ? yasamRaw : undefined,
    yuruyus_donus,
    uzaklik_tavani_m: isPositive(uzaklikM) ? uzaklikM : undefined,
    sefer_mesafe_m: isPositive(seferMesafeRaw) ? seferMesafeRaw : undefined,
    surus_gunu_ortalamasi_m: isPositive(surusGunuOrtRaw) ? surusGunuOrtRaw : undefined,
    sol_basina_ortalama_m: isPositive(solBasinaOrtRaw) ? solBasinaOrtRaw : undefined,
    toplam_menzil_m: isPositive(toplamMenzilRaw) ? toplamMenzilRaw : undefined,
    gunde_eva_sayisi: isPositive(gundeEvaRaw) ? gundeEvaRaw : undefined,
    enerji_profili,
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
  const plumeR = readOpt('puskurtme_guvenlik_yaricapi_m');

  return {
    azami_egim_derece: isPositive(azami_egim_derece) ? azami_egim_derece : undefined,
    azami_kaya_m: isPositive(azami_kaya_m) ? azami_kaya_m : undefined,
    azami_yukseklik_m,
    guvenli_alan_capi_m: isPositive(capi) ? capi : undefined,
    puskurtme_guvenlik_yaricapi_m: isPositive(plumeR) ? plumeR : undefined,
    kaynaklar,
    guvenler,
  };
}

function applyCagataySupplement(
  rawSup: unknown,
  traversers: Traverser[],
  crewedLander: LandingCraftParams | null,
  roboticLander: LandingCraftParams | null,
): { crewedLander: LandingCraftParams | null; roboticLander: LandingCraftParams | null } {
  if (!isRecord(rawSup)) return { crewedLander, roboticLander };
  const parsedCrewed = parseLandingCraft(rawSup.inis_araci_insanli);
  const parsedRobotic = parseLandingCraft(rawSup.inis_araci_robotik);
  const nextCrewed = parsedCrewed ?? crewedLander;
  const nextRobotic = parsedRobotic ?? roboticLander;

  const budgets = isRecord(rawSup.sefer_butcesi) ? rawSup.sefer_butcesi : null;
  if (budgets) {
    type MergeNumKey =
      | 'sefer_mesafe_m'
      | 'surus_gunu_ortalamasi_m'
      | 'sol_basina_ortalama_m'
      | 'uzaklik_tavani_m'
      | 'toplam_menzil_m'
      | 'azami_sure_saat'
      | 'azami_egim_derece'
      | 'uyari_egim_derece'
      | 'gunde_eva_sayisi';

    const mergeNum = (
      t: Traverser,
      srcBlock: unknown,
      srcKey: string,
      dstKey: MergeNumKey,
    ) => {
      if (!isRecord(srcBlock) || !(srcKey in srcBlock)) return;
      const u = unwrapField(srcBlock[srcKey]);
      if (isPositive(u.value)) {
        t[dstKey] = u.value;
        if (u.kaynak) t.kaynaklar[dstKey] = u.kaynak;
        if (u.guven) t.guvenler[dstKey] = u.guven;
      }
    };

    const y = traversers.find((t) => t.id === 'yuruyen_insan' || t.id === 'suited_astronaut');
    if (y && isRecord(budgets.yuruyen_insan)) {
      mergeNum(y, budgets.yuruyen_insan, 'gidis_donus_azami_m', 'sefer_mesafe_m');
      mergeNum(y, budgets.yuruyen_insan, 'planlama_suresi_saat', 'azami_sure_saat');
      mergeNum(y, budgets.yuruyen_insan, 'geri_yurume_azami_m', 'uzaklik_tavani_m');
      mergeNum(y, budgets.yuruyen_insan, 'gunde_eva_sayisi', 'gunde_eva_sayisi');
      mergeNum(y, budgets.yuruyen_insan, 'azami_egim_derece', 'azami_egim_derece');
      mergeNum(y, budgets.yuruyen_insan, 'dikkat_egim_derece', 'uyari_egim_derece');
    }

    const rCrew = traversers.find((t) => t.id === 'roverli_insan');
    if (rCrew && isRecord(budgets.aracli_insan)) {
      mergeNum(rCrew, budgets.aracli_insan, 'gunluk_menzil_m', 'sefer_mesafe_m');
      mergeNum(rCrew, budgets.aracli_insan, 'geri_yurume_azami_m', 'uzaklik_tavani_m');
      mergeNum(rCrew, budgets.aracli_insan, 'azami_egim_derece', 'azami_egim_derece');
      mergeNum(rCrew, budgets.aracli_insan, 'dikkat_egim_derece', 'uyari_egim_derece');
    }

    const rBot = traversers.find((t) => t.id === 'rover');
    if (rBot && isRecord(budgets.rover)) {
      mergeNum(rBot, budgets.rover, 'sol_basina_en_yuksek_m', 'sefer_mesafe_m');
      mergeNum(rBot, budgets.rover, 'surus_gunu_ortalamasi_m', 'surus_gunu_ortalamasi_m');
      mergeNum(rBot, budgets.rover, 'sol_basina_ortalama_m', 'sol_basina_ortalama_m');
      mergeNum(rBot, budgets.rover, 'toplam_menzil_m', 'toplam_menzil_m');
      mergeNum(rBot, budgets.rover, 'azami_egim_derece', 'azami_egim_derece');
      mergeNum(rBot, budgets.rover, 'dikkat_egim_derece', 'uyari_egim_derece');
    }

    // Keep caution threshold below max slope and extend speed table tail if max slope rose
    for (const t of traversers) {
      if (t.uyari_egim_derece !== undefined && t.uyari_egim_derece >= t.azami_egim_derece) {
        t.uyari_egim_derece = undefined;
      }
      for (const tbl of [t.hiz_tablosu, t.inis_hiz_tablosu]) {
        if (!tbl || tbl.length === 0) continue;
        const last = tbl[tbl.length - 1];
        if (t.azami_egim_derece > last.egim_derece) {
          const fallbackSpeed = [...tbl].reverse().find((e) => e.hiz_m_s > 0)?.hiz_m_s ?? 0.01;
          tbl.push({
            egim_derece: t.azami_egim_derece,
            hiz_m_s: last.hiz_m_s > 0 ? last.hiz_m_s : fallbackSpeed,
          });
        }
      }
    }
  }

  return { crewedLander: nextCrewed, roboticLander: nextRobotic };
}

function parseGroundMobilityModel(rawMain: Record<string, unknown>, rawSup: unknown): GroundMobilityModel | null {
  const zeminSup = isRecord(rawSup) && isRecord(rawSup.zemin) ? rawSup.zemin : null;
  const effectMain = isRecord(rawMain.zemin_etkisi) ? rawMain.zemin_etkisi : null;
  if (!zeminSup && !effectMain) return null;

  const kaynaklar: Record<string, string> = {};
  const guvenler: Record<string, ConfidenceLevel> = {};
  const readG = (src: Record<string, unknown> | null, key: string, dstKey: string, fallback: number): number => {
    if (!src || !(key in src)) return fallback;
    const u = unwrapField(src[key]);
    if (u.kaynak) kaynaklar[dstKey] = u.kaynak;
    if (u.guven) guvenler[dstKey] = u.guven;
    return typeof u.value === 'number' && Number.isFinite(u.value) ? u.value : fallback;
  };

  return {
    tiDustThreshold: readG(zeminSup, 'toz_esigi_termal_atalet', 'toz_esigi_termal_atalet', 100),
    tiLooseThreshold: readG(zeminSup, 'gevsek_zemin_dikkat_termal_atalet', 'gevsek_zemin_dikkat_termal_atalet', 350),
    tiVeryLooseThreshold: readG(effectMain, 'cok_gevsek_termal_atalet', 'cok_gevsek_termal_atalet', 200),
    looseSpeedFactor: readG(effectMain, 'gevsek_hiz_carpani', 'gevsek_hiz_carpani', 0.85),
    veryLooseSpeedFactor: readG(effectMain, 'cok_gevsek_hiz_carpani', 'cok_gevsek_hiz_carpani', 0.7),
    hardRollingResistance: 0.05,
    looseRollingResistance: readG(effectMain, 'gevsek_yuvarlanma_direnci', 'gevsek_yuvarlanma_direnci', 0.08),
    veryLooseRollingResistance: readG(effectMain, 'cok_gevsek_yuvarlanma_direnci', 'cok_gevsek_yuvarlanma_direnci', 0.12),
    kaynaklar,
    guvenler,
  };
}

/** Parses already-fetched mobility JSON payloads (exported for deterministic unit testing). */
export function parseMobilityParams(raw: unknown, sup: unknown = null): MobilityParams {
  if (Array.isArray(raw)) {
    if (raw.length === 0) throw new Error('mobilite_parametreleri.json contains no traversers');
    const traversers = raw.map((item, i) => {
      if (!isRecord(item)) throw new Error(`mobilite_parametreleri.json: traverser #${i} is not an object`);
      return parseTraverser(`traverser_${i + 1}`, item);
    });
    const landers = applyCagataySupplement(sup, traversers, null, null);
    return {
      synthetic: false,
      traversers,
      landingCraft: landers.crewedLander,
      landingCraftCrewed: landers.crewedLander,
      landingCraftRobotic: landers.roboticLander,
      ground: null,
    };
  }

  if (!isRecord(raw)) throw new Error('mobilite_parametreleri.json must be an object or array');
  const baseLander = parseLandingCraft(raw.inis_araci);
  let landingCraftCrewed = parseLandingCraft(raw.inis_araci_insanli) ?? baseLander;
  let landingCraftRobotic = parseLandingCraft(raw.inis_araci_robotik);
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
    // Top-level dictionary: only parse objects defining "hiz_tablosu" so non-traverser blocks
    // like landers (inis_araci_insanli) are never misclassified as traversers.
    const preferredOrder = ['yuruyen_insan', 'roverli_insan', 'rover'];
    const keys = [
      ...preferredOrder.filter((k) => k in raw),
      ...Object.keys(raw).filter((k) => !RESERVED_MOBILITY_KEYS.has(k) && !preferredOrder.includes(k)),
    ];
    for (const key of keys) {
      const val = raw[key];
      if (isRecord(val) && 'hiz_tablosu' in val) {
        traversers.push(parseTraverser(key, val));
      }
    }
  }

  if (traversers.length === 0) {
    throw new Error('mobilite_parametreleri.json contains no traversers');
  }
  const merged = applyCagataySupplement(sup, traversers, landingCraftCrewed, landingCraftRobotic);
  landingCraftCrewed = merged.crewedLander;
  landingCraftRobotic = merged.roboticLander;

  return {
    synthetic: raw.sahte === true,
    traversers,
    landingCraft: landingCraftCrewed ?? baseLander,
    landingCraftCrewed,
    landingCraftRobotic,
    ground: parseGroundMobilityModel(raw, sup),
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
  let sup: unknown = null;
  try {
    sup = await fetchJson(CAGATAY_MOBILITY_URL);
  } catch {
    sup = null;
  }
  return parseMobilityParams(raw, sup);
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

export interface SimpleGeoJsonFeature {
  type: 'Feature';
  properties: Record<string, unknown> | null;
  geometry: {
    type: string;
    coordinates: unknown;
  };
}

export interface SimpleGeoJsonCollection {
  type: 'FeatureCollection';
  features: SimpleGeoJsonFeature[];
}

export async function loadOptionalGeoJson(url: string): Promise<SimpleGeoJsonCollection | null> {
  try {
    const raw = await fetchJson(url);
    if (isRecord(raw) && raw.type === 'FeatureCollection' && Array.isArray(raw.features)) {
      return raw as unknown as SimpleGeoJsonCollection;
    }
    return null;
  } catch {
    return null;
  }
}

export interface GlobeContextMeta {
  kure: Record<string, unknown> | null;
  radyasyon: Record<string, unknown> | null;
  tozFirtinasi: Record<string, unknown> | null;
}

async function fetchOptionalJsonRecord(url: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fetchJson(url);
    return isRecord(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** Loads optional v5 global Mars context metadata JSONs (`kure.json`, `radyasyon.json`, `toz_firtinasi.json`). */
export async function loadOptionalKureMeta(): Promise<GlobeContextMeta> {
  const [kure, radyasyon, tozFirtinasi] = await Promise.all([
    fetchOptionalJsonRecord(KURE_META_URL),
    fetchOptionalJsonRecord(KURE_RADIATION_URL),
    fetchOptionalJsonRecord(KURE_DUST_URL),
  ]);
  return { kure, radyasyon, tozFirtinasi };
}

