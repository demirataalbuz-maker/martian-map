# Marswalk Map

A layered, local-scale map for a single Mars surface excursion ("Marswalk"), with
obstacle-avoiding route planning between science stops.

Built for the NASA Space Apps Challenge 2026, challenge *Interplanetary Survival
Guide: Martian Map*. Static single-page web app, no backend.

> **Live site:** https://demirataalbuz-maker.github.io/martian-map/ (no login needed)
>
> **Status:** all planned features are in place and deployed with **real Mars orbital & terrain datasets (Package v5)**:
> global `z0–z5` Mars globe (`USGS Viking MDIM 2.1` color mosaic + `MOLA / TES / MDAD` environmental context & landing screening), a `20 m` CTX regional grid (`86 × 107.5 km` around Jezero crater & Nili Planum), and a `5 m` HiRISE fine grid (`~20 × 21 km` Perseverance landing & delta zone).

## Run it

```bash
npm install
npm run fake-data   # writes synthetic placeholder data into public/
npm run dev         # http://localhost:5173
npm run build       # static site in dist/
```

## Data contract

The app reads everything at runtime from `public/` (field names are Turkish by
team agreement). To switch from synthetic to real data, replace these files — no
code change is needed.

```
public/
  veri/
    katmanlar.json        layer list: either tile layers (karolar, sema, min_zoom,
                          max_zoom, sinir) or single-image layers (dosya, koseler),
                          plus id, ad_en, tur, kaynak, cozunurluk_m, guven_notu_en, lejant
    karolar/<id>/{z}/{x}/{y}.<ext>   Web Mercator XYZ / TMS raster tile pyramid
    <layer_id>.<ext>      single 4-corner image layer; transparent pixel = no data
    duraklar.json         optional science stops (id, ad_en, konum, aciklama_en, foto, foto_kaynak)
    maliyet/izgara.json   genislik, yukseklik, hucre_m, koseler, plus binary encoding
                          fields (egim_tipi, egim_olcek, egim_veri_yok, egim_taban_uzunlugu_m,
                          yukseklik_tipi, yukseklik_taban_m, yukseklik_olcek_m, yukseklik_veri_yok)
    maliyet/egim.bin      Uint8 ceiling-quantized slope (or Float32 fallback); 255 = no data
    maliyet/tehlike.bin   Uint8; 0 free, 1 caution, 2 forbidden, 255 = no data
    maliyet/inis.bin      optional Uint8; 0 suitable, 1 marginal, 2 unsuitable, 255 = no data
    maliyet/yukseklik.bin optional Int16 little-endian (or Float32); lazy-loaded on 1st route
  mobilite_parametreleri.json   yuruyen_insan, roverli_insan, rover & inis_araci ({ deger, kaynak, guven })
```

Key contract details:

- `koseler` order is top-left (NW), top-right (NE), bottom-right (SE), bottom-left (SW), each `[longitude, latitude]`.
- `sinir` on tile layers is `[west, south, east, north]` in `[longitude, latitude]`, passed to MapLibre `bounds` so out-of-footprint tiles are never requested.
- Row 0 of every raster is the north edge; multi-byte binaries (`Int16`, `Float32`) are little-endian.
- `maliyet/yukseklik.bin` is **lazy-loaded on the first route request** rather than at page startup to avoid downloading ~46 MB before a route is needed.

## Design rules

- No limit, speed or duration is hard-coded; they come from `mobilite_parametreleri.json`.
- Distance and time are computed from the cost grid (cells × `hucre_m`, diagonal × 1.414), never from the map library, which assumes Earth's radius. The scale bar is drawn by this app from the grid for the same reason.
- "No data" (255) and "forbidden" (2) are different things and are shown differently.
- No Earth basemap tiles or external CDNs. Layers are served locally as Web Mercator XYZ raster tile pyramids (`karolar`) or placed by their four corners (`koseler`).
- Raw mission data is not stored in this repository.

## Result panel, mission options and warnings

- Mission options: round-trip return to landing / start (enabled by default), configurable work duration per science stop, policy toggle for unmapped ("no data") terrain (blocked by default), 1-click sample mission, live Mars terrain cursor/tap HUD, and side-by-side comparison across all traversers.
- Thematic overlays (`tur !== 'altlik'`) start hidden with 65% default opacity so the primary basemap stays legible underneath when toggled on.
- Totals: `GO / CAUTION / NO-GO` corridor suitability badge, distance, max straight-line base standoff, estimated mission time (with travel + stop work breakdown), steepest slope (with measurement baseline), climb / descent, crewed rover walk-back check, post-hoc demo vehicle energy summary (`Wh`), and per-leg figures.
- Elevation and slope profiles are plain SVG drawn by the app (no chart library), marking stops, no-data spans, and any time or radial-distance threshold point.
- Warnings & decision badge: `NO-GO` when any red unsafe segment occurs (`time` — walk-back or max duration exceeded; `distance` — `> 10 km` radial standoff cap exceeded); `CAUTION` when minimum time margin `< 10%` or when rock abundance / thermal inertia data are not available (`assumed`); `GO` otherwise. Full route remains drawn with unsafe spans highlighted in dashed red and `!` threshold markers.
- "Close to the limit" uses the optional `uyari_egim_derece` field of a traverser; without it, the highest positive speed-table breakpoint below the limit is used.
- Without `maliyet/yukseklik.bin` the app still works and says the elevation profile is unavailable.

## Science stops and export

- Diamond markers are the predefined science stops; tapping one shows its description, its surface photo with credit (when provided) and an "Add to route" button.
- "Download route (GeoJSON)" saves the route line, start and stops with distance, time and per-leg figures. Coordinates are Mars longitude / latitude in the layers' own system, not Earth WGS 84; the file says so.

## Use of AI

Code in this repository was written with the assistance of AI coding assistants
(Claude by Anthropic, and Antigravity by Google DeepMind) and reviewed by the
team; each source file says so in its header. Mobility parameter literature
research and engineering documentation also used Claude (Anthropic) and Gemini
(Google). The synthetic placeholder images are produced procedurally by
`scripts/make-fake-data.mjs`, not by an image-generation model.

## License and references

Apache License 2.0 — see [LICENSE](LICENSE). Third-party libraries and data
sources are listed in [REFERENCES.md](REFERENCES.md).

## Routing model

The route is the least-**time** path on the active scenario's cost grid (A*, 8-connected, in a Web
Worker: `20 m` CTX grid for the Crewed scenario, `5 m` HiRISE grid for the Robotic Rover scenario). All numbers come from the data files:

- step length = `hucre_m` (orthogonal) or `hucre_m` × √2 (diagonal); step time = length / speed
- **directed uphill/downhill travel:** elevation differences (`yukseklik.bin`) compute exact signed slope angle per step so uphill vs downhill speeds and energy consumption differ
- **20 m regolith & slope coupling:** in the `20 m` CTX scenario, cell speed blends slope speed limits with the THEMIS thermal inertia (`termal_atalet.bin`) loose-regolith model (`TI < 200` soft sand/dust slowdowns + rolling resistance scaling); in `5 m` HiRISE, rock abundance/thermal inertia grids are unmodeled and reported as `CAUTION (assumed)`
- impassable = hazard class 2 (forbidden) or slope above the traverser's limit; diagonal steps never cut a blocked corner
- "caution" cells are passable at the slowest speed in the traverser's table and trigger a route warning; unmapped ("no data", 255) cells are **not crossed by default** (distinct from "forbidden" 2, with a dedicated message) and can optionally be allowed at slowest speed with a warning via the UI toggle
- **stop order & battery reserve:** users may keep manual click order or toggle exact branch-and-bound TSP reordering (up to 7 science stops); for crewed rover missions (`roverli_insan`), exceeding the battery reserve triggers `NO-GO (broken: energy)` and marks the depletion point on the map/chart
- for crewed rover traverses (`roverli_insan` or `yuruyus_donus: true`), a grid Dijkstra walk-back time field from the start / landing cell using the suited walking astronaut speed table checks `elapsed_time(n) + walk_back_time(n) ≤ suit_life_support_limit` at every step along the route, alongside the `10 km` straight-line radial standoff cap from base

## Model boundaries and limitations

- **Spatial scale:** `20 m` CTX evaluates regional terrain (`~75–80 m` effective DTM detail; boulders `< 20 m` unresolved); `5 m` HiRISE evaluates central delta & landing terrain (individual rocks `< 1–2 m` unresolved).
- **Regolith model scope:** `20 m` CTX models loose dust/regolith slowdown and rolling resistance from `100 m` resampled THEMIS thermal inertia (`±20%` uncertainty) + USGS SIM 3464 sand dunes (`Aeb`); quantitative thermal inertia / rock abundance at `5 m` HiRISE resolution is not available (`CAUTION: assumed` baseline).
- **Remaining physical simplifications:** A* optimizes route geometry for travel time first and checks battery energy / EVA life-support / `10 km` walk-back budgets along the route (no solar charging, diurnal thermal cycling, or dynamic slip transients); exact TSP stop optimization caps at `7` stops (`> 7` keeps user click order); turn-angle time penalties are omitted.
