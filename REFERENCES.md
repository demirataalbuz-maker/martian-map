# References

Every library, tool and data source used by this project.

## Libraries (shipped in the site)

| Name | Version | License | URL |
| --- | --- | --- | --- |
| MapLibre GL JS | 6.18.0 | BSD-3-Clause | https://github.com/maplibre/maplibre-gl-js |

## Build tools (not shipped)

| Name | Version | License | URL |
| --- | --- | --- | --- |
| Vite | 8.3.8 | MIT | https://github.com/vitejs/vite |
| TypeScript | 7.0.2 | Apache-2.0 | https://github.com/microsoft/TypeScript |
| Node.js | 24.x | MIT | https://nodejs.org |

## Data

| Layer | Source | License & Notes |
| --- | --- | --- |
| Global color mosaic (z0–z5) | USGS Astrogeology / NASA Ames — Mars Viking Colorized Global Mosaic 232 m (MDIM 2.1, via OpenPlanetaryMap tiles) | Public Domain (17 U.S.C. § 105, U.S. Government Work) |
| Global elevation (MOLA, z0–z4) | MGS MOLA MEGDR 16 px/deg (`megt90n000eb`), PDS Geosciences Node; Smith et al. 2001, JGR 106, 23689 | Public Domain (NASA PDS); used for global screening & hydrostatic shield |
| Global albedo (TES, z0–z4) | MGS TES bolometric albedo 7410 m, USGS Astrogeology (Christensen et al. 2001) | Public Domain (USGS / NASA PDS); dust screening gate |
| Global thermal inertia (TES, z0–z4) | TES nighttime thermal inertia, Putzig & Mellon 2007 (Icarus 191, 68), via ASU JMARS | Academic / NASA PDS; coarse `0.1°` global screening |
| Atmospheric radiation shield (z0–z4) | Guo et al. 2018 (`arXiv:1712.06987`, Curiosity RAD dose-pressure) + MGS MOLA MEGDR | Planning context (`~248 µGy/day` estimated at Jezero) |
| Global dust storm frequency (z0–z4) | Mars Dust Activity Database v1.1 (Battalio & Wang 2021, Icarus 354; Battalio et al. 2023), MRO MARCI MY 28–32, Zenodo `doi:10.5281/zenodo.7480334` | CC BY 4.0 |
| Jezero regional imagery (`5–6 m`) | Murray Lab CTX Global Mosaic V01 (`doi:10.1029/2024EA003555`) & USGS Mars 2020 TRN CTX orthomosaic (`JEZ_ctx_B_soc_008`) | Free for all purposes (Murray Lab/Caltech) / Public Domain (USGS) |
| Jezero regional topography (`20 m`) | 64 USGS Astrogeology CTX DTMs referenced to MOLA & aligned to Mars 2020 TRN CTX orthomosaic via ASP `dem_mosaic` | Public Domain (USGS / NASA); `~75–80 m` effective resolution |
| Perseverance / Delta detail (`5 m`) | USGS Astrogeology Mars 2020 TRN HiRISE DTM mosaic `JEZ_hirise_soc_006` (`1 m` averaged to `5 m`) | Public Domain (USGS / NASA); covers central `~20 × 21 km` |
| Jezero geologic units (`40 m`) | Sun & Stack (2020), *Geologic map of Jezero crater and Nili Planum*, USGS SIM 3464, 1:75,000 (`doi:10.3133/sim3464`) | Public Domain (USGS); supplies unit `Aeb` eolian sand/dunes hazard |
| Jezero thermal inertia (`100 m -> 20 m`) | USGS Astrogeology THEMIS Quantitative 32-bit Thermal Inertia Mosaic (Fergason, Christensen & Kieffer 2006, JGR 111, E12004) | Public Domain (USGS / ASU); resampled to `20 m` CTX grid (`±20%` accuracy) |
| Synthetic generator (`make-fake-data.mjs`) | Procedural fallback generator in `scripts/` (not active when real Package v5 data is present) | Apache-2.0 |

## AI tools

| Tool | Used for |
| --- | --- |
| Claude (Anthropic) | Writing and reviewing application code, mobility parameter & algorithm research, presentation drafts, and the synthetic data generator |
| Antigravity (Google DeepMind) | Writing, auditing, and testing application code, performance optimizations, and presentation drafts |
| Gemini (Google) | Mobility parameter literature research and engineering documentation |
