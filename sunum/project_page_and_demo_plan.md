<!-- AI-assisted document: drafted with Claude (Anthropic) and Antigravity (Google DeepMind), reviewed by the team. -->
# Marswalk Map — 30s Demo Video Script & 7-Slide English Project Page Text

> [!NOTE]
> **Draft Status (Pre-Real-Data Freeze):**
> - Subtitle cue timestamps in `marswalk_captions.srt` are initial draft targets (`0–5 s`, `5–13 s`, `13–21 s`, `21–27 s`, `27–29.5 s`) and will be retimed to the final screen recording captured on real Mars data.
> - **Section 4 (Planetary Data & Sources)** and the `27–30 s` end-card credit in `marswalk_endcard_and_slides.html` are marked **DRAFT** and will be filled with exact product IDs and citations once the GIS package (`public/veri`) is finalized.

> [!CAUTION]
> **Global Judging Eligibility Guardrails (Strict Disqualification Rules)**
> 1. **Hard 30-Second Cap:** Export the video at **29.0 – 29.5 seconds** (`≤ 29.5 s`). YouTube and Vimeo often round `30.1 s` up to `0:31`, which disqualifies a team from Global Judging.
> 2. **Either ≤ 30s Video OR ≤ 7 Slides (Title Included):** Never exceed 7 slides if uploading a deck. Below, the 7-slide structure is written in **100% English** directly as your **Space Apps Project Page text** (and maps 1-to-1 to the 7-slide deck in `marswalk_endcard_and_slides.html`).
> 3. **Zero NASA / USGS Logos:** On the `27–30 s` end card, use **only your own project/team title mark** (*Marswalk Map*) and **plain text** (`"Data: NASA PDS / JPL-Caltech / USGS Astrogeology / Caltech Murray Lab / ASU"`). Never place the NASA Meatball, NASA Worm, or USGS emblem.
> 4. **Mandatory AI Watermark:** Recording real screen captures of the app + real Mars orbital layers requires no AI imagery. If you add **any** AI-generated graphic, icon, or background frame anywhere in the video or slides, place a visible **`AI-Generated Visual`** watermark on every frame/slide where it appears.

---

## Part 1 — 30-Second Screen-Recording Plan (English Subtitled)

Pre-stage before pressing Record:
- Open the site at `1920 × 1080` (`100%` or `110%` browser zoom so text is crisp), wait for terrain loading to finish so the map is clean, and hover near a predefined science stop in the **Jezero crater region**.

| Time (Draft) | On-Screen Action (Exact Mouse Moves) | Burned-in / `.srt` English Subtitle |
| :--- | :--- | :--- |
| **0.0 – 5.0 s** | Click a diamond science stop (or **Try sample mission**). Recommended candidate landing site **`L`** and separated backups **`B1` / `B2`** pop onto the map (`≥ 400 m` apart per `guvenli_alan_capi_m`). | **Click a Mars science target — Marswalk Map suggests the closest suitable candidate landing site (`L`) and separated backups (`B1`, `B2`).** |
| **5.0 – 13.0 s** | Show the cyan least-time route, `GO / CAUTION / NO-GO` decision badge, distance/time/energy summary, and SVG **Elevation & Slope** profiles (with **Round-trip** ON by default and dashed red + **`!`** marking any `time` or `10 km` `distance` violation). | **It plots the fastest route and elevation profile; Round-trip checks the real return leg and marks life-support turn-around (`!`).** |
| **13.0 – 21.0 s** | Expand **Compare all traversers on this mission** and click between *Walking astronaut*, *Crewed rover*, and *Uncrewed rover*. | **Compare a suited astronaut, crewed rover, and robotic rover side by side on the exact same mission.** |
| **21.0 – 27.0 s** | Sweep the cursor across terrain to highlight the bottom-right **Mars HUD** (slope / hazard / landing readout), the unchecked **Allow crossing unmapped terrain** toggle, and **How mobility limits were chosen** confidence tags. | **Live 20 m terrain readout keeps "No data" distinct from "Forbidden" (unmapped off by default), with sourced confidence tags.** |
| **27.0 – 29.5 s** | Clean dark end card: **Marswalk Map** project title + `demirataalbuz-maker.github.io/martian-map` + text credit *(to be locked to exact shipped NASA/USGS/Caltech products)*. | **Marswalk Map — Open-source Mars EVA & landing planner · `demirataalbuz-maker.github.io/martian-map` \| NASA / USGS / Caltech data.** |

---

## Part 2 — Space Apps Project Page Text (7-Slide Structure, 100% English)

### High-Level Project Summary (Short Form Box — ~440 characters)

> **Marswalk Map** flips Mars traverse planning from *"Where do we start?"* to *"What science target do we want to reach?"* Over an 86 × 107.5 km Jezero crater region box at 20 m grid resolution (~23.1M cells), our serverless web app suggests suitable candidate landing sites via reverse Dijkstra, verifies round-trip walk-back and 10 km standoff rules (`GO / CAUTION / NO-GO`) for three traversers, and tags every parameter's provenance.

---

### Full Project Description (7-Section / 7-Slide Ready Copy)

#### 1. Marswalk Map — Target-First Candidate Landing & Traverse Planner
- **Challenge:** *Interplanetary Survival Guide: Martian Map*
- **Live App (No Login):** https://demirataalbuz-maker.github.io/martian-map/
- **Source Code (Apache-2.0):** https://github.com/demirataalbuz-maker/martian-map
- **Core Idea:** Traditional route tools ask the user to drop an arbitrary start pin first. On Mars, science drives landing selection: a planner clicks the geological target first, and **Marswalk Map** automatically suggests the **closest suitable candidate landing site** (**`L`**) plus spatially separated backup candidates (**`B1`**, **`B2`**) before drawing the multi-stop surface route.

#### 2. The Operational Problem on Mars
Planning a human or robotic "Marswalk" (EVA) requires reconciling three coupled constraints at once:
1. **Lander Footprint Geometry:** A lander requires an entire suitable circular footprint (`guvenli_alan_capi_m`) meeting slope and elevation constraints—not just a single flat pixel—and backup candidate landing sites must be separated by at least that diameter so one local hazard cannot invalidate every candidate.
2. **Surface Traversability:** Suited astronauts, crewed rovers, and robotic rovers face different slope ceilings (`15°` human / crewed rover vs. `25°` uncrewed scout scenario), speed-versus-slope curves, and obstacle clearances.
3. **Life-Support, Walk-Back & Standoff Budgets:** Human excursions are bounded by a `6.4 h` operational budget (`8 h` suit design value × `0.80` reserve factor), crewed rover missions must satisfy the Apollo *walk-back survival rule* (`elapsed_time + walk_back_time ≤ 6.4 h`) at every point along the route, and human traverses observe a `10 km` straight-line radial standoff cap from base.

#### 3. Target-First Workflow & Multi-Traverser Mission Planning
- **Candidate Landing Site Recommendation:** Tapping any science stop runs range-clipped reverse Dijkstra outward from Stop 1, selecting up to three class-0 (*suitable*) candidate landing centers separated by the lander's footprint diameter—or falling back to class-1 (*marginal*) candidates with an explicit warning when no class-0 candidate lies within mission range.
- **Real Round-Trip, Safety Envelopes & `GO / CAUTION / NO-GO` Decision:** **Round-trip** starts enabled by default, computing the actual A* return path back to landing/start and adding configurable science work time per stop. Full routes remain visible even when operational envelopes are exceeded: violating segments are drawn in dashed red with **`!`** threshold markers on the map and charts, naming the broken condition (**`time`** and/or **`distance`**) and setting the corridor badge to **`NO-GO`** (or **`CAUTION`** when time margin `< 10%` or rock/thermal-inertia grids are absent). Post-hoc vehicle energy (`Wh`, Mars Rover Demo v1 scenario profile) is summarized without altering A* search.
- **Side-by-Side Traverser Comparison:** With one click, planners compare **Walking Astronaut (suited)**, **Crewed Rover**, and **Uncrewed Rover** on the identical set of targets—seeing total distance, mission duration, steepest slope, and `GO / CAUTION / NO-GO` status, and clicking any row to switch vehicles immediately.

#### 4. Planetary Data & Sources — DRAFT (`Jezero crater region`, `76.667–78.198° E`, `17.586–19.400° N`)

> **[DRAFT — Exact shipped product IDs, citations, and roles will be finalized once GIS export is locked]:**

| Dataset & Resolution (DRAFT) | Role in Marswalk Map | Attribution / Citation (DRAFT) | License & Terms |
| :--- | :--- | :--- | :--- |
| **MRO CTX Global Mosaic (~5 m/px)** | Regional visual basemap tile pyramid (up to `z14`) across the `86.1 × 107.5 km` Jezero crater region box. | Dickson, J. L., Ehlmann, B. L., Kerber, L., & Fassett, C. I. (2023/2024). *Mars MRO CTX Global Mosaic, Murray Lab v1*. Caltech Bruce Murray Laboratory for Planetary Visualization / NASA PDS (`10.17189/m23v-ae12`). | **Open Planetary Archive / CC BY / PDS** *(confirm exact Murray Lab v1 notice on final lock)*. |
| **USGS MRO CTX DEM (20 m/px)** | `4303 × 5376` cell elevation (`yukseklik.bin`), ceiling-quantized 20 m baseline slope (`egim.bin`), and slope/elevation inputs to `tehlike.bin` & `inis.bin`. | **[TBD on GIS lock]** — USGS Astrogeology CTX DTM product(s) or Mars 2020 TRN CTX DTM Mosaic (USGS Astrogeology Science Center). | **U.S. Public Domain** (`17 U.S.C. § 105` / CC0 1.0). |
| **MRO HiRISE DTM (~1 m/px) / Orthoimagery** | **[DRAFT — confirm exact role on GIS lock]** High-resolution local terrain/context reference inside the core Jezero zone (basemap tiles remain capped at `z14`). | **[TBD on GIS lock]** — USGS Astrogeology / MRO HiRISE (NASA/JPL-Caltech/Univ. of Arizona, McEwen et al., 2007). | **U.S. Public Domain** (`CC0 1.0` / NASA & USGS Open Data). |
| **Mars Odyssey THEMIS Day/Night IR Mosaic (~100 m/px)** | Regional daytime/nighttime infrared mosaic layer. | **[TBD on GIS lock]** — 2001 Mars Odyssey THEMIS Daytime/Nighttime IR Mosaic (USGS SIM 3464; Christensen et al. / Edwards et al., ASU Mars Space Flight Facility & USGS Astrogeology). | **U.S. Public Domain** (USGS / NASA PDS Open Data). |
| **Mars 2020 Perseverance Rover Traverse & Waypoints** | Reference science stops (`duraklar.json`) and traverse context in Jezero crater. | Deen, R. G. (Ed.) (2022–2026). *Mars 2020 Rover PLACES Localization Bundle*. NASA/JPL-Caltech, PDS Geosciences Node. DOI: `10.17189/btz6-5a82`. | **U.S. Public Domain** (NASA/JPL-Caltech Open Data Policy; no NASA insignia used). |

#### 5. Physical Honesty, Safety Rules & Browser Architecture
- **True Mars Grid Geometry (Zero Earth-Radius Distortion):** No Earth basemap is loaded. MapLibre GL JS is used strictly to render local raster tile pyramids (up to `z14`, with thematic overlays off by default at `65%` opacity) and 4-corner layers; every distance, radial standoff check, travel time, warning span, and the custom scale bar is computed directly on the Mars cost grid (`hucre_m`, with diagonal steps weighted by `× √2`).
- **`"No Data" (255) ≠ "Forbidden" (2)`:** Unmapped pixels are visually hatched in legends, shaded as grey gaps on SVG charts, and **blocked by default** (*"Allow crossing unmapped (no-data) terrain"* starts **OFF** so astronauts are never routed across unknown ground unless explicitly opted in at slowest speed with a warning).
- **Sourced Parameters & Compact Client Engine:** Zero speeds, slope limits, or durations are hardcoded—each value is read at runtime from `mobilite_parametreleri.json` alongside its engineering citation and confidence tag (`design value` or `ASSUMPTION` — never unverified `"measured"` labels). Inside a Web Worker, 256-entry speed lookup tables, corridor-windowed 8-connected A* (`~11 bytes/cell` with automatic border-touch expansion), grid Dijkstra walk-back verification, and lazy streaming `Int16` elevation loading keep 23.1M-cell routing fast and tablet-safe without a backend server.

#### 6. Actionable Outputs & Cross-Mission Reusability
- **Interactive Diagnostics:** Live cursor/tap Mars HUD (`lat/lon`, ceiling-quantized slope with `≥` saturation indicator, hazard class, landing class, and elevation), plain-SVG **Elevation** and **Slope** profiles (zero chart libraries), and resilient rollback that preserves the active route if a newly clicked point is unreachable.
- **GeoJSON Mission Export:** Exports the selected candidate landing site, backups, science stops, per-leg distances/times, walk-back / radial-standoff metrics, and full route polyline—explicitly tagged as Mars coordinates rather than Earth WGS 84.
- **Drop-In Portability:** Switching to another Mars region or a Lunar Artemis site requires replacing only static JSON and binary files in `public/veri`—zero code changes.

#### 7. Model Limitations, Open Source & Use of AI Disclosure
- **Explicit Physical & Algorithmic Boundaries:**
  1. *20 m resolution & missing rock/thermal layers:* **Computed with 20 m resolution data; obstacles smaller than this scale were not evaluated.** Slope values in `egim.bin` are ceiling-quantized (`Uint8`) over `egim_taban_uzunlugu_m` so quantization never underestimates terrain steepness over that baseline; because quantitative rock abundance and thermal inertia grids are not available, clean routes transparently report `CAUTION: rock and thermal inertia data not available (assumed)` and require high-resolution human verification before flight commitment.
  2. *Search simplifications & post-hoc energy:* Speed depends on slope magnitude only (no directed uphill/downhill search; conservative uphill walking speeds are used in the table), science stops are visited in the exact user-selected order (no TSP reordering), turn-angle penalties are omitted, and vehicle battery energy (`Wh`) is evaluated post-hoc on the selected route under the labelled Mars Rover Demo v1 scenario profile.
- **Open Source & Third-Party Software:** Released under **Apache License 2.0**. Runtime uses only **MapLibre GL JS 6.18** (`BSD-3-Clause`); build tooling uses **Vite** (`MIT`) and **TypeScript** (`Apache-2.0`).
- **Transparent Use of AI:** Application code, verification scripts, and presentation drafts were developed with assistance from **Claude (Anthropic)** and **Antigravity (Google DeepMind)**; mobility parameter literature research and algorithm documentation used **Claude (Anthropic)** and **Gemini (Google)**. All outputs were reviewed and verified by the team, and every source file carries an explicit header attribution. No AI-generated imagery is presented as Mars data (any AI-generated decorative graphic, if used in presentation media, carries a visible watermark).
