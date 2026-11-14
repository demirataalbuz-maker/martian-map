# Marswalk Map

A layered, local-scale map for a single Mars surface excursion ("Marswalk"), with
obstacle-avoiding route planning between science stops.

Built for the NASA Space Apps Challenge 2026, challenge *Interplanetary Survival
Guide: Martian Map*. Static single-page web app, no backend.

> **Live site:** https://demirataalbuz-maker.github.io/martian-map/ (no login needed)
>
> **Status:** all planned features are in place and deployed.
> The data in `public/veri` is **synthetic** and is
> labelled as such in the UI.

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
- No Earth basemap tiles. Layers are placed as images by their four corners.
- Raw mission data is not stored in this repository.

## Result panel and warnings

- Totals: distance, estimated one-way time, steepest slope, climb / descent, per-leg figures.
- Elevation and slope profiles are plain SVG drawn by the app (no chart library).
- Warnings: estimated time above `azami_sure_saat`; slope close to the limit; crossing "no data"; crossing "caution".
- "Close to the limit" uses the optional `uyari_egim_derece` field of a traverser; without it, the highest speed-table breakpoint below the limit is used.
- Without `maliyet/yukseklik.bin` the app still works and says the elevation profile is unavailable.

## Science stops and export

- Diamond markers are the predefined science stops; tapping one shows its description, its surface photo with credit (when provided) and an "Add to route" button.
- "Download route (GeoJSON)" saves the route line, start and stops with distance, time and per-leg figures. Coordinates are Mars longitude / latitude in the layers' own system, not Earth WGS 84; the file says so.

## Use of AI

Code in this repository was written with the assistance of AI coding assistants
(Claude by Anthropic, and Antigravity by Google DeepMind) and reviewed by the
team. Each source file says so in its header. The synthetic placeholder images
are produced procedurally by `scripts/make-fake-data.mjs`, not by an
image-generation model.

## License and references

Apache License 2.0 — see [LICENSE](LICENSE). Third-party libraries and data
sources are listed in [REFERENCES.md](REFERENCES.md).

## Routing model

The route is the least-**time** path on the cost grid (A*, 8-connected, in a Web
Worker). All numbers come from the data files:

- step length = `hucre_m` (orthogonal) or `hucre_m` × √2 (diagonal); step time = length / speed
- cell speed = the traverser's speed table interpolated at the cell's slope
- impassable = hazard class 2 (forbidden) or slope above the traverser's limit; diagonal steps never cut a blocked corner
- **assumption to confirm with the team:** "caution" and "no data" cells are passable, but only at the slowest speed in the traverser's table, and the route panel warns when the path crosses them
