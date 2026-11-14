// AI-assisted code: written with Claude (Anthropic), reviewed by the team.

// Everything the app loads at runtime lives under these paths (relative to the
// deployed site root). To switch from synthetic to real data, replace the
// contents of public/veri and public/mobilite_parametreleri.json — no code change.
const base = import.meta.env.BASE_URL;

export const DATA_DIR = `${base}veri`;
export const LAYERS_URL = `${DATA_DIR}/katmanlar.json`;
export const GRID_URL = `${DATA_DIR}/maliyet/izgara.json`;
export const SLOPE_URL = `${DATA_DIR}/maliyet/egim.bin`;
export const HAZARD_URL = `${DATA_DIR}/maliyet/tehlike.bin`;
export const ELEVATION_URL = `${DATA_DIR}/maliyet/yukseklik.bin`;
export const STOPS_URL = `${DATA_DIR}/duraklar.json`;
export const MOBILITY_URL = `${base}mobilite_parametreleri.json`;

// Display name only; update when the team fixes the study area.
export const SITE_NAME = 'Jezero crater — delta front';
