# CLAUDE.md — context for continuing this project in Claude Code

## What this is
A single-file, dependency-free dashboard (`index.html`) that visualizes IOM DTM
internal-displacement data from `data/data.json`. No framework, no bundler, no build
step — vanilla HTML/CSS/JS with hand-drawn SVG charts (deliberate: it deploys as
static files and never depends on external tiles or CDNs that a sandbox would block).

Status: **v0**. Yemen is complete (flow metric, click-to-drill to districts). The
MENA API countries' data can be pulled but the app's "stock mode" is not built yet.

## File map
- `index.html` — the whole app. Loads `data/data.json` via `fetch`, then `init()`.
- `data/data.json` — `{ generated, countries:{<name>:<payload>}, pending:[names] }`.
- `scripts/refresh_dtm.py` — builds `data/data.json`. Yemen from the Excel;
  MENA from the DTM API (`dtmapi` package). Reads the key from `../.env` /
  `scripts/dtm_key.txt` / `DTM_API_KEY`.

## Data schema (per country payload)
Common: `country, iso, metric_type ("flow"|"stock"), unit, hh_to_people,
weeks:[{i,start,end,label}], perweek:[…], gov:{pc:{name,lat,lon}},
geo:<ADM1 FeatureCollection, properties.pc/name>`.

`perweek[i]` = `{ i, total, dest:{gov_pc:value}, flows:[{o,d,hh}],
reasons:{label:value} }`.  (`hh` is the value in that country's `unit`.)

**Yemen only** adds district drill-down:
- `perweek[i].dflows:[{og,od,dg,dd,hh}]` — origin/dest gov+district pcodes.
- `dcent:{dist_pc:{name,lat,lon,g}}` — district centroids.
- `adm2:<FeatureCollection>` — every district (props `pc`, `name`, `g` = gov pcode).
  Unmatched districts get `pc` = `"x"+shapeID`. The app builds `dgeo[gov]` from this on
  load (for govs in `dbbox`) and draws other govs' districts dashed as context.
- `dbbox:{gov_pc:[minx,miny,maxx,maxy]}` — zoom target (and the drillable govs).
- `people_basis:"reported"|"estimate"` — West Coast Escalation reports individuals
  (IOM: HH × 6); RDT records households only, so people are estimated.
- When both datasets share geography, `geo`/`adm2` live once in top-level `shared`.

**Boundaries:** ADM2 is coverage-simplified (`GEO_TOL`) and governorates are the union
of their districts, so gov and district borders always coincide. Don't simplify
features one by one — that is what made borders misalign.

## How the app renders (index.html)
- `state = {country, period(0=cumulative|1..4=last N weeks), level('gov'|'dist'), selGov}`.
- `aggGov(D)` sums the selected weeks → gov `dest`, gov→gov `flows`, `reasons`.
- `aggDist(D,G)` sums selected weeks' `dflows` for gov G → district `dest`,
  internal district `intern` flows, and external `inflow` aggregated by source gov.
- `renderMapGov` / `renderMapDist` project GeoJSON to the 600×440 SVG (equirect +
  latitude compression), draw choropleth + **top-10** arcs + internal bubbles.
  District view zooms to `dbbox[G]` (expanded) and clips external-inflow arrows to
  the frame edge (`clipEntry`), one per source governorate (top-4).
- `renderTrend` = line + markers, selected weeks highlighted.
- Clicking a gov with `D.dgeo[pc]` drills in; `#back` returns.

## TODО (in priority order)
1. **Stock mode for API countries.** They are `metric_type:"stock"` (present IDPs,
   monthly rounds, individuals). Summing across rounds is WRONG. Build:
   - a period control that, for stock, selects a reporting round (default latest)
     instead of "last N weeks", and shows the round list;
   - KPIs/bar/flow off the selected round's snapshot; trend = stock over rounds;
   - then enable these countries in the dropdown (currently gated to "pending" in
     `init()` by `metric_type!=='stock'`).
2. **Reason labels** differ by source ("Conflict Reasons" in Yemen vs "Conflict" in
   the API, and compound "Conflict; Insecurity" strings). Normalize for the
   conflict KPI.
3. **District drill for API countries** needs ADM2 data — the DTM API is admin1
   only; would require the admin2 endpoint or a COD admin2 join. Optional.
4. **UNICEF branding** option (swap the placeholder blue/orange for UNICEF cyan +
   logo). Palette tokens live at the top of `index.html`.
5. **Returnees / onward-movement layers** — the Yemen Excel has `Returnees` and
   `WhoLeft` sheets not yet surfaced.

## Dev workflow
- View: `python -m http.server 8000` in the project root → http://localhost:8000
  (must be over HTTP; `file://` blocks the data fetch).
- Refresh data: `cd scripts && python refresh_dtm.py` (needs the key + deps in README).
- Editing charts: everything is inline SVG string-building in `index.html`; there is
  no chart library to learn. Colors are CSS custom properties (`--b1..--b6` blues,
  `--accent` orange, `--conflict` red) with light/dark defined at the top.

## Gotchas
- geoBoundaries files are Git-LFS; fetch the **media** endpoint
  (`media.githubusercontent.com/media/...`) to get real GeoJSON, not the pointer.
- Yemen district names are matched to ADM2 by normalized name within each gov
  (spatial join assigns ADM2→gov first). Unmatched districts fall back to the gov
  centroid — refine the match if new districts appear.
- Never commit `.env` / `dtm_key.txt` (already gitignored). Rotate the key if leaked.
