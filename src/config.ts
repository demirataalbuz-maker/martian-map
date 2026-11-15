// AI-assisted code: written with Claude (Anthropic) and Antigravity (Google DeepMind), reviewed by the team.

// Everything the app loads at runtime lives under these paths (relative to the
// deployed site root).
const base = import.meta.env.BASE_URL;

export const DATA_CACHE_TAG = 'v5';
const v = `?v=${DATA_CACHE_TAG}`;

export const DATA_DIR = `${base}veri`;
export const LAYERS_URL = `${DATA_DIR}/katmanlar.json${v}`;
export const STOPS_URL = `${DATA_DIR}/duraklar.json${v}`;
export const MOBILITY_URL = `${base}mobilite_parametreleri.json${v}`;
export const CAGATAY_MOBILITY_URL = `${DATA_DIR}/mobilite_cagatay_2026-11-15.json${v}`;

// Crewed scenario (20 m CTX grid)
export const GRID_URL = `${DATA_DIR}/maliyet/izgara.json${v}`;
export const SLOPE_URL = `${DATA_DIR}/maliyet/egim.bin${v}`;
export const HAZARD_URL = `${DATA_DIR}/maliyet/tehlike.bin${v}`;
export const ELEVATION_URL = `${DATA_DIR}/maliyet/yukseklik.bin${v}`;
export const THERMAL_INERTIA_URL = `${DATA_DIR}/maliyet/termal_atalet.bin${v}`;
export const LANDING_CREWED_URL = `${DATA_DIR}/maliyet/inis_insanli.bin${v}`;
export const LANDING_FALLBACK_URL = `${DATA_DIR}/maliyet/inis.bin${v}`;
export const LANDING_URL = LANDING_CREWED_URL;

// Robotic Rover scenario (5 m HiRISE fine grid)
export const FINE_GRID_URL = `${DATA_DIR}/ince/maliyet/izgara.json${v}`;
export const FINE_SLOPE_URL = `${DATA_DIR}/ince/maliyet/egim.bin${v}`;
export const FINE_HAZARD_URL = `${DATA_DIR}/ince/maliyet/tehlike.bin${v}`;
export const FINE_ELEVATION_URL = `${DATA_DIR}/ince/maliyet/yukseklik.bin${v}`;
export const LANDING_ROBOTIC_URL = `${DATA_DIR}/ince/maliyet/inis_robotik.bin${v}`;

// Global & vector metadata
export const KURE_META_URL = `${DATA_DIR}/kure/kure.json${v}`;
export const KURE_RADIATION_URL = `${DATA_DIR}/kure/radyasyon.json${v}`;
export const KURE_DUST_URL = `${DATA_DIR}/kure/toz_firtinasi.json${v}`;
export const ELLIPSE_GEOJSON_URL = `${DATA_DIR}/vektor/inis_elipsi.geojson${v}`;
export const PLACE_NAMES_GEOJSON_URL = `${DATA_DIR}/vektor/yer_adlari.geojson${v}`;
export const CRATER_FEATURES_GEOJSON_URL = `${DATA_DIR}/vektor/konum_ozellikleri.geojson${v}`;

// Fallback display name when neither katmanlar.json nor izgara.json specifies alan_en.
export const SITE_NAME = 'Jezero crater region';
