# Marswalk Map

A layered, local-scale map for a single Mars surface excursion ("Marswalk"), with
obstacle-avoiding route planning between science stops.

Built for the NASA Space Apps Challenge 2026, challenge *Interplanetary Survival
Guide: Martian Map*. Static single-page web app, no backend.

> **Status:** step 2 of 7 — synthetic data generator, map, and a layer panel
> built from `katmanlar.json`. The data in `public/veri` is **synthetic** and is
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
    katmanlar.json        layer list: id, ad_en, tur, dosya, koseler, kaynak,
                          cozunurluk_m, guven_notu_en, lejant
    <layer_id>.png        transparent pixel = no data
    maliyet/izgara.json   genislik, yukseklik, hucre_m, koseler
    maliyet/egim.bin      Float32, row by row, degrees; -9999 = no data
    maliyet/tehlike.bin   Uint8; 0 free, 1 caution, 2 forbidden, 255 = no data
  mobilite_parametreleri.json   per-traverser limits, each number with its source
```

Assumptions the code makes, **to be confirmed with the data owners**:

- `koseler` order is top-left (NW), top-right (NE), bottom-right (SE), bottom-left (SW), each `[longitude, latitude]`.
- Row 0 of every raster is the north edge; binaries are little-endian.
- `katmanlar.json` is either a bare array or `{ "katmanlar": [...] }`; `lejant` is a list of `{ "renk": "#rrggbb", "etiket_en": "..." }`.
- `maliyet/yukseklik.bin` (Float32, metres, -9999 = no data) is a **proposed addition**: the elevation profile cannot be drawn from slope alone.

## Design rules

- No limit, speed or duration is hard-coded; they come from `mobilite_parametreleri.json`.
- Distance and time are computed from the cost grid (cells × `hucre_m`, diagonal × 1.414), never from the map library, which assumes Earth's radius. The scale bar is drawn by this app from the grid for the same reason.
- "No data" (255) and "forbidden" (2) are different things and are shown differently.
- No Earth basemap tiles. Layers are placed as images by their four corners.
- Raw mission data is not stored in this repository.

## Use of AI

Code in this repository was written with the assistance of an AI coding
assistant (Claude, Anthropic) and reviewed by the team. Each source file says so
in its header. The synthetic placeholder images are produced procedurally by
`scripts/make-fake-data.mjs`, not by an image-generation model.

## License and references

Apache License 2.0 — see [LICENSE](LICENSE). Third-party libraries and data
sources are listed in [REFERENCES.md](REFERENCES.md).
