// AI-assisted code: written with Claude (Anthropic) and Antigravity (Google DeepMind), reviewed by the team.
//
// Demo mission presets ("★ Sample" menu). Every preset is plain data in
// veri/ornek_gorevler.json: stop coordinates plus mission options. The outcome
// (GO / CAUTION / NO-GO) is NOT stored as an override; it is whatever the real
// terrain grids and the real limits produce when the preset is planned.

import { DATA_CACHE_TAG, DATA_DIR } from './config';
import type { LonLat } from './data';

export const PRESETS_URL = `${DATA_DIR}/ornek_gorevler.json?v=${DATA_CACHE_TAG}`;

export type PresetScenario = 'crewed' | 'rover';
export type PresetExpectation = 'GO' | 'CAUTION' | 'NO-GO';

export interface PresetStop {
  /** [longitude, latitude] */
  konum: LonLat;
  ad_en?: string;
}

export interface MissionPreset {
  id: string;
  ad_en: string;
  ad_tr: string;
  aciklama_en: string;
  aciklama_tr: string;
  senaryo: PresetScenario;
  /** Traverser id from mobilite_parametreleri.json (yuruyen_insan / roverli_insan / rover). */
  gezgin: string;
  /** 'auto' = recommended landing site; 'manual' = the first stop is the start point. */
  baslangic: 'auto' | 'manual';
  duraklar: PresetStop[];
  gidis_donus: boolean;
  durak_calisma_dk: number;
  sira_optimize: boolean;
  verisiz_gecis: boolean;
  /** Outcome observed when the preset was verified; shown as a hint only, never enforced. */
  beklenen: PresetExpectation;
  /** Broken condition observed for NO-GO presets (time / distance / energy / unreachable). */
  bozulan?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

function parseStop(raw: unknown): PresetStop | null {
  if (!isRecord(raw) || !Array.isArray(raw.konum) || raw.konum.length !== 2) return null;
  const [lon, lat] = raw.konum as unknown[];
  if (typeof lon !== 'number' || typeof lat !== 'number' || !Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return { konum: [lon, lat], ad_en: typeof raw.ad_en === 'string' ? raw.ad_en : undefined };
}

function parsePreset(raw: unknown, idx: number): MissionPreset | null {
  if (!isRecord(raw)) return null;
  const senaryo = raw.senaryo === 'rover' ? 'rover' : raw.senaryo === 'crewed' ? 'crewed' : null;
  const gezgin = str(raw.gezgin);
  const stops = Array.isArray(raw.duraklar) ? raw.duraklar.map(parseStop).filter((s): s is PresetStop => s !== null) : [];
  if (!senaryo || !gezgin || stops.length === 0) return null;
  const beklenen = raw.beklenen === 'GO' || raw.beklenen === 'NO-GO' ? raw.beklenen : 'CAUTION';
  const workMin = typeof raw.durak_calisma_dk === 'number' && raw.durak_calisma_dk >= 0 ? raw.durak_calisma_dk : 0;
  const adEn = str(raw.ad_en, `Sample ${idx + 1}`);
  return {
    id: str(raw.id, `preset_${idx + 1}`),
    ad_en: adEn,
    ad_tr: str(raw.ad_tr, adEn),
    aciklama_en: str(raw.aciklama_en),
    aciklama_tr: str(raw.aciklama_tr, str(raw.aciklama_en)),
    senaryo,
    gezgin,
    baslangic: raw.baslangic === 'manual' ? 'manual' : 'auto',
    duraklar: stops,
    gidis_donus: raw.gidis_donus !== false,
    durak_calisma_dk: workMin,
    sira_optimize: raw.sira_optimize === true,
    verisiz_gecis: raw.verisiz_gecis === true,
    beklenen,
    bozulan: typeof raw.bozulan === 'string' ? raw.bozulan : undefined,
  };
}

/** The presets file is optional: without it the Sample button keeps its single built-in mission. */
export async function loadPresets(): Promise<MissionPreset[]> {
  try {
    const res = await fetch(PRESETS_URL);
    if (!res.ok) return [];
    const raw: unknown = await res.json();
    const list = isRecord(raw) ? raw.gorevler : raw;
    if (!Array.isArray(list)) return [];
    return list.map(parsePreset).filter((p): p is MissionPreset => p !== null);
  } catch {
    return [];
  }
}
