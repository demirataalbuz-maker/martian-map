<!-- AI-assisted document: drafted with Claude (Anthropic) and Antigravity (Google DeepMind), reviewed by the team. -->
# Marswalk Map — 30s Demo Video Script & 7-Slide English Project Page Text

> [!NOTE]
> **Draft Status (Pre-Real-Data Freeze):**
> - Subtitle cue timestamps in `marswalk_captions.srt` are initial draft targets (`0–5 s`, `5–13 s`, `13–21 s`, `21–27 s`, `27–29.5 s`) and will be retimed to the final screen recording captured on real Mars data.
> - Dataset citations on Slide 4 and the `27–30 s` end card (`marswalk_endcard_and_slides.html`) will be narrowed/updated to the exact shipped product list once the GIS pipeline (`public/veri`) is finalized.

> [!CAUTION]
> **Global Judging Eligibility Guardrails (Strict Disqualification Rules)**
> 1. **Hard 30-Second Cap:** Export the video at **29.0 – 29.5 seconds** (`≤ 29.5 s`). YouTube and Vimeo often round `30.1 s` up to `0:31`, which disqualifies a team from Global Judging.
> 2. **Either ≤ 30s Video OR ≤ 7 Slides (Title Included):** Never exceed 7 slides if uploading a deck. Below, the 7-slide structure is written in **100% English** directly as your **Space Apps Project Page text** (and maps 1-to-1 to the 7-slide deck in `marswalk_endcard_and_slides.html`).
> 3. **Zero NASA / USGS Logos:** On the `27–30 s` end card, use **only your own project/team title mark** (*Marswalk Map*) and **plain text** (`"Data: NASA PDS / JPL-Caltech / USGS Astrogeology / ASU"`). Never place the NASA Meatball, NASA Worm, or USGS emblem.
> 4. **Mandatory AI Watermark:** Recording real screen captures of the app + real Mars orbital layers requires no AI imagery. If you add **any** AI-generated graphic, icon, or background frame anywhere in the video or slides, place a visible **`AI-Generated Visual`** watermark on every frame/slide where it appears.

---

## Part 1 — 30-Second Screen-Recording Plan (English Subtitled)

Pre-stage before pressing Record:
- Open the site at `1920 × 1080` (`100%` or `110%` browser zoom so text is crisp), wait for terrain loading to finish so the map is clean, and hover near a predefined science stop in **Jezero–Northeast**.

| Time (Draft) | On-Screen Action (Exact Mouse Moves) | Burned-in / `.srt` English Subtitle |
| :--- | :--- | :--- |
| **0.0 – 5.0 s** | Click a diamond science stop (or **Try sample mission**). Recommended landing zone **`L`** and separated backups **`B1` / `B2`** pop onto the map (`≥ 250 m` apart). | **Click a Mars science target — Marswalk Map finds the closest safe landing site (`L`) and separated backups (`B1`, `B2`).** |
| **5.0 – 13.0 s** | Show the cyan least-time route, total distance/time, and SVG **Elevation & Slope** profiles. Tick **Round-trip** ON (with stop work set) so the red **`!`** (`max t`) turn-around marker appears on the map and charts. | **It plots the fastest safe route and elevation profile; enabling Round-trip checks the real return leg and marks life-support turn-around (`!`).** |
| **13.0 – 21.0 s** | Expand **Compare all traversers on this mission** and click between *Walking astronaut*, *Crewed rover*, and *Uncrewed rover*. | **Compare a suited astronaut, crewed rover, and robotic rover side by side on the exact same mission.** |
| **21.0 – 27.0 s** | Sweep the cursor across terrain to highlight the bottom-right **Mars HUD** (slope / hazard / landing readout), the unchecked **Allow crossing unmapped terrain** toggle, and **How mobility limits were chosen** confidence tags. | **Live 20 m terrain readout keeps "No data" distinct from "Forbidden" (unmapped off by default), with sourced confidence tags.** |
| **27.0 – 29.5 s** | Clean dark end card: **Marswalk Map** project title + `demirataalbuz-maker.github.io/martian-map` + text credit *(updated to exact shipped NASA/USGS products)*. | **Marswalk Map — Open-source, zero-backend Mars EVA planner · Built on NASA PDS & USGS Mars data.** |

---

## Part 2 — Space Apps Project Page Text (7-Slide Structure, 100% English)

### High-Level Project Summary (Short Form Box — ~430 characters)

> **Marswalk Map** flips Mars traverse planning from *"Where do we start?"* to *"What science target do we want to reach?"* Over an 86 × 107 km Jezero–Northeast study box at 20 m grid resolution (~23.1M cells), our serverless web app recommends safe primary and backup landing zones via reverse Dijkstra, computes obstacle-avoiding round-trip routes for three traverser types, and pairs every engineering limit and planetary layer with explicit provenance.

---

### Full Project Description (7-Section / 7-Slide Ready Copy)

#### 1. Marswalk Map — Target-First Landing & Traverse Planner
- **Challenge:** *Interplanetary Survival Guide: Martian Map*
- **Live App (No Login):** https://demirataalbuz-maker.github.io/martian-map/
- **Source Code (Apache-2.0):** https://github.com/demirataalbuz-maker/martian-map
- **Core Idea:** Traditional route tools ask the user to drop an arbitrary start pin first. On Mars, science drives landing selection: a planner clicks the geological target first, and **Marswalk Map** automatically recommends the closest reachable, safe landing zone (**`L`**) plus spatially separated backup sites (**`B1`**, **`B2`**) before drawing the multi-stop surface route.

#### 2. The Operational Problem on Mars
Planning a human or robotic "Marswalk" (EVA) requires reconciling three coupled constraints at once:
1. **Lander Footprint Safety:** A lander needs a low-slope, low-rock-abundance circle (`guvenli_alan_capi_m`), and backup landing zones must be separated by at least that safe-zone diameter so a single local hazard cannot invalidate all candidates.
2. **Surface Traversability:** Suited astronauts, pressurized/unpressurized crewed rovers, and robotic rovers face different slope limits, speed-versus-slope curves, and obstacle clearances.
3. **Life-Support & Walk-Back Budgets:** Human excursions are bounded by suit consumables, and crewed rover missions are bounded by the *walk-back survival rule* if the vehicle fails at the farthest point.

#### 3. Target-First Workflow & Multi-Traverser Mission Planning
- **Automatic Landing Recommendation:** Tapping any science stop runs range-clipped reverse Dijkstra outward from Stop 1, selecting up to three class-0 (*suitable*) landing centers separated by the lander's safe diameter—or falling back to class-1 (*marginal*) sites with an explicit warning when no class-0 site lies within mission range.
- **Real Round-Trip & Stop Work Budgeting:** Enabling **Round-trip** computes the actual return path from the final stop back to the landing site (never a straight-line radius estimate) and adds configurable science work time per stop. Whenever total mission time exceeds `azami_sure_saat`, the exact budget-exhaustion point is marked **`!`** on both the map and profile charts.
- **Side-by-Side Traverser Comparison:** With one click, planners compare **Walking Astronaut (suited)**, **Crewed Rover**, and **Uncrewed Rover** on the identical set of targets—seeing total distance, mission duration, steepest slope encountered, and feasibility status, and clicking any row to switch vehicles immediately.

#### 4. Planetary Data & Sources (Jezero–Northeast, 76.667–78.198° E, 17.586–19.400° N)

Candidate datasets from open NASA Planetary Data System (PDS) and USGS Astrogeology archives *(final table to be trimmed/locked to the exact shipped product IDs once GIS export completes)*:

| Dataset & Resolution | Role in Marswalk Map | Attribution / Citation | License & Terms |
| :--- | :--- | :--- | :--- |
| **USGS MRO CTX DEM (20 m/px) & Orthomosaic (~5 m/px)** | Primary `86.1 × 107.5 km` (`4300 × 5375` cell) elevation (`yukseklik.bin`), ceiling-quantized 20 m baseline slope (`egim.bin`), and regional basemap tile pyramid (`z8–z14`). | Fergason, R. L., Galuszka, D. M., Hare, T. M., Mayer, D. P., & Redding, B. L. (2020). *Mars 2020 Terrain Relative Navigation CTX DTM & Orthorectified Image Mosaics*. USGS Astrogeology Science Center. DOI: `10.5066/P906QQT8`. | **U.S. Public Domain** (`17 U.S.C. § 105` / CC0 1.0 Universal). |
| **MRO HiRISE DTM (1 m/px) & Orthoimage (0.25 m/px)** | Core-zone meter-scale hazard validation, boulder/scarp screening (`tehlike.bin`, `inis.bin`), and high-zoom (`z15–z16`) local detail tiles. | Fergason, R. L., et al. (2020). *Mars 2020 TRN HiRISE DTM (`10.5066/P9REJ9JN`) & Orthorectified Mosaic (`10.5066/P9QJDP48`)*, USGS; instrument data: NASA/JPL-Caltech/Univ. of Arizona (McEwen et al., 2007). | **U.S. Public Domain** (`CC0 1.0 Universal` / NASA & USGS Open Data). |
| **2001 Mars Odyssey THEMIS Thermal Inertia & IR (~100 m/px)** | Thermophysical surface characterization (indurated bedrock vs. unconsolidated dust/sand hazard weighting and landing suitability screening). | Christensen, P. R., et al. (2004); Fergason, R. L., Christensen, P. R., & Kieffer, H. H. (2006, *JGR*, `10.1029/2006JE002735`). ASU Mars Space Flight Facility & NASA PDS. | **Open Planetary Archive** (NASA PDS Public Domain; credit: NASA/JPL-Caltech/Arizona State Univ.). |
| **Mars 2020 Perseverance Rover Traverse & Waypoints** | Ground-truth reference science stops (`duraklar.json`) and localized surface context inside Jezero Crater. | Deen, R. G. (Ed.) (2022–2026). *Mars 2020 Rover PLACES Localization Bundle*. NASA/JPL-Caltech, PDS Geosciences Node. DOI: `10.17189/btz6-5a82`. | **U.S. Public Domain** (NASA/JPL-Caltech Open Data Policy; no NASA insignia used). |

#### 5. Physical Honesty, Safety Rules & Browser Architecture
- **True Mars Grid Geometry (Zero Earth-Radius Distortion):** No Earth basemap is loaded. MapLibre GL JS is used strictly to render raster tile pyramids and 4-corner overlays; every distance, travel time, warning span, and the custom scale bar is computed directly on the Mars cost grid (`hucre_m`, with diagonal steps weighted by `× √2`).
- **`"No Data" (255) ≠ "Forbidden" (2)`:** Unmapped pixels are visually hatched in legends, shaded as grey gaps on SVG charts, and **blocked by default** (*"Allow crossing unmapped (no-data) terrain"* starts **OFF** so astronauts are never routed across unknown ground unless explicitly opted in at slowest speed with a warning).
- **Sourced Parameters & Compact Client Engine:** Zero speeds, slope limits, or durations are hardcoded—each value is read at runtime from `mobilite_parametreleri.json` alongside its engineering citation and confidence tag (`measured`, `design value`, `scaled`, or `ASSUMPTION`). Inside a Web Worker, 256-entry speed lookup tables, corridor-windowed 8-connected A* (`~11 bytes/cell` with automatic border-touch expansion), and lazy streaming `Int16` elevation loading keep 23.1M-cell routing fast and tablet-safe without a backend server.

#### 6. Actionable Outputs & Cross-Mission Reusability
- **Interactive Diagnostics:** Live cursor/tap Mars HUD (`lat/lon`, ceiling-quantized slope with `≥` saturation indicator, hazard class, landing class, and elevation), plain-SVG **Elevation** and **Slope** profiles (zero chart libraries), and resilient rollback that preserves the active route if a newly clicked point is unreachable.
- **GeoJSON Mission Export:** Exports the selected landing site, backups, science stops, per-leg distances/times, and full route polyline—explicitly tagged as Mars coordinates rather than Earth WGS 84.
- **Drop-In Portability:** Switching to another Mars region or a Lunar Artemis site requires replacing only static JSON and binary files in `public/veri`—zero code changes.

#### 7. Model Limitations, Open Source & Use of AI Disclosure
- **Explicit Physical Limitations:**
  1. *Undirected slope speed:* **Speed depends on slope magnitude only; uphill and downhill are treated the same.** Incorporating directional grade (Tobler/energetic asymmetry) and solar illumination shadows is our next engineering step.
  2. *Baseline quantization:* Slope values in `egim.bin` are ceiling-quantized (`Uint8`) over the stated grid baseline (`egim_taban_uzunlugu_m`) so quantization never underestimates terrain steepness; sub-grid obstacles rely on the companion hazard/HiRISE screening layer.
- **Open Source & Third-Party Software:** Released under **Apache License 2.0**. Runtime uses only **MapLibre GL JS 6.18** (`BSD-3-Clause`); build tooling uses **Vite** (`MIT`) and **TypeScript** (`Apache-2.0`).
- **Transparent Use of AI:** Application code, tests, and documentation were developed with assistance from **Claude (Anthropic)** and **Antigravity (Google DeepMind)** and reviewed/verified by the team; every source file carries an explicit header attribution. No AI-generated imagery is presented as Mars data (any AI-generated decorative graphic, if used in presentation media, carries a visible watermark).
