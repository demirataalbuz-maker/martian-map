// AI-assisted code: written with Claude (Anthropic) and Antigravity (Google DeepMind), reviewed by the team.

// Everything the app loads at runtime lives under these paths (relative to the
// deployed site root).
const base = import.meta.env.BASE_URL;

export const DATA_DIR = `${base}veri`;
export const LAYERS_URL = `${DATA_DIR}/katmanlar.json`;
export const STOPS_URL = `${DATA_DIR}/duraklar.json`;
export const MOBILITY_URL = `${base}mobilite_parametreleri.json`;
export const CAGATAY_MOBILITY_URL = `${DATA_DIR}/mobilite_cagatay_2026-11-15.json`;

// Crewed scenario (20 m CTX grid)
export const GRID_URL = `${DATA_DIR}/maliyet/izgara.json`;
export const SLOPE_URL = `${DATA_DIR}/maliyet/egim.bin`;
export const HAZARD_URL = `${DATA_DIR}/maliyet/tehlike.bin`;
export const ELEVATION_URL = `${DATA_DIR}/maliyet/yukseklik.bin`;
export const THERMAL_INERTIA_URL = `${DATA_DIR}/maliyet/termal_atalet.bin`;
export const LANDING_CREWED_URL = `${DATA_DIR}/maliyet/inis_insanli.bin`;
export const LANDING_FALLBACK_URL = `${DATA_DIR}/maliyet/inis.bin`;
export const LANDING_URL = LANDING_CREWED_URL;

// Robotic Rover scenario (5 m HiRISE fine grid)
export const FINE_GRID_URL = `${DATA_DIR}/ince/maliyet/izgara.json`;
export const FINE_SLOPE_URL = `${DATA_DIR}/ince/maliyet/egim.bin`;
export const FINE_HAZARD_URL = `${DATA_DIR}/ince/maliyet/tehlike.bin`;
export const FINE_ELEVATION_URL = `${DATA_DIR}/ince/maliyet/yukseklik.bin`;
export const LANDING_ROBOTIC_URL = `${DATA_DIR}/ince/maliyet/inis_robotik.bin`;

// Global & vector metadata
export const KURE_META_URL = `${DATA_DIR}/kure/kure.json`;
export const KURE_RADIATION_URL = `${DATA_DIR}/kure/radyasyon.json`;
export const KURE_DUST_URL = `${DATA_DIR}/kure/toz_firtinasi.json`;
export const ELLIPSE_GEOJSON_URL = `${DATA_DIR}/vektor/inis_elipsi.geojson`;
export const PLACE_NAMES_GEOJSON_URL = `${DATA_DIR}/vektor/yer_adlari.geojson`;
export const CRATER_FEATURES_GEOJSON_URL = `${DATA_DIR}/vektor/konum_ozellikleri.geojson`;

// Fallback display name when neither katmanlar.json nor izgara.json specifies alan_en.
export const SITE_NAME = 'Jezero crater region';
