# DESIGN.md — v1 rebuild plan (deck.gl GIS + SharePoint-embeddable)

**Status:** Phase 1 built & verified (2026-09-22) · Supersedes the v0 hand-SVG map,
keeps the v0 data pipeline (`data/data.json`, `scripts/refresh_dtm.py`) unchanged.

> **Phase 1 done:** Vite + deck.gl app renders Yemen — UNICEF-branded (Cyan `#1CABE2`,
> orange arcs, self-hosted Roboto), choropleth + flow arcs + internal bubbles, gov→district
> drill with clipped inflow arrows, KPIs/trend/bars, country selector wired (Yemen only),
> period control, light/dark, tooltips, tile-less, `npm run build` → static `dist/`.
> Known polish for Phase 2: district-label collision in dense areas; arc/inflow tuning.
>
> **Iteration 2 (2026-09-22):** directional **arrowheads** on all flows; **deterministic
> map hover** (choropleth only → always area total + within-area + top origins + drill
> hint); **last-refresh pill** (build date + staleness dot); light confirmed as default.
>
> **Iteration 3 (2026-09-22):** "Top movements" is now a **bipartite Sankey** (FROM→TO,
> gov→gov, or district→district on drill); hovering a Sankey ribbon isolates the matching
> map arc and vice-versa. Verified DTM API admin2 reality (see §9) — corrected the docs.
>
> **Iteration 4 (2026-09-22):** wider rail (392px) + taller Sankey; map draws top-20 arcs
> (mid-tail dests like Hadramawt now show); **all** area labels render (faint when no
> movement); tighter default fit (fills Yemen); **line-priority hover** with 8px tolerance
> (near a line → that flow; empty ground → area total); drilled view keeps **surrounding
> governorates** as context (gov outline only, click to switch). Stock default = latest round.
>
> **Iteration 5 (2026-09-22):** escalation valued in **households** (not individuals) for
> consistency; escalation reuses the RDT's **full 21-gov geography** (no governorate
> disappears); **label de-collision** (Sana'a vs Sana'a City); **taller Sankey** incl.
> **self-loops** (Taiz→Taiz); within-area shown as a **circular loop-arrow** (tinted per
> origin, drawn on top); map arcs + Sankey ribbons **coloured by origin governorate**
> (categorical palette); **bendier arcs** (distance-scaled `getHeight`).
>
> **Data fetch (2026-09-22):** ran `refresh_dtm.py` with the DTM key → `data.json` now has
> **Yemen (flow) + Iraq / Syria / Lebanon (stock)**. **Iran confirmed absent from the DTM
> IDP API** (not includable). Env note: Anaconda has all deps; `pyogrio`/pyarrow break under
> NumPy 2 but geopandas falls back to fiona; run with `PYTHONIOENCODING=utf-8`.
> **Known stock gap:** round selector overflows with many rounds (Iraq=82) — needs a
> compact control (dropdown/slider); flagged for stock-mode polish.

---

## 1. Goal & scope

A strong, beautifully designed **interactive population-movement map** — real GIS,
animated origin→destination flow arrows, governorate/district drill-down — that
**deploys as static files** and can eventually be **embedded in a SharePoint page**.

**Country scope: MENA countries with IOM DTM data.** Target set (2026-09-22):

| Country | Metric | Shape | Drill | Notes |
|---|---|---|---|---|
| **Yemen** | flow | weekly, households | gov → **district** | RDT Excel; only district-level country |
| **Iraq** | stock | monthly rounds, individuals | admin1 | API; has origin→dest |
| **Syria** | stock | monthly rounds, individuals | admin1 | API; has origin→dest |
| **Lebanon** | stock | monthly rounds, individuals | admin1 | API |
| **Iran** | stock? | **unverified** | admin1 | ⚠ must confirm the API returns IDP data — see §9 |

Dropped from the old pipeline: **Libya, Sudan** (still one line away in the refresh
script if wanted back). **4 of 5 targets are "stock"** — so stock mode is *core*, not a
later add-on (see §7).

**SCOPE (2026-09-22): Yemen only, TWO selectable datasets** (the selector switches datasets,
not countries; both share the same map/Sankey/drill engine, no double-counting — verified
the two products measure different frames and can't be summed):
- **West Coast Escalation** (default) — the acute emergency: *daily*, real **individuals**,
  district→district, 7 destination govs, current through the latest escalation update.
- **Rapid Displacement Tracking** — the weekly routine baseline: households (×6), full-year
  2026, all 21 govs, district drill.
Data is keyed by dataset label with a `default` field; the pipeline builds both from their
respective DTM workbooks (`build_escalation` / `build_yemen`), no API needed for either.

**Earlier scope note:** the country selector stays wired so more can be added later as a
*data* change, but the shipped app is Yemen-only. Why the others were
dropped (all verified against the live DTM API + HDX, same day):
- **Iran** — not in the DTM IDP API at all.
- **Iraq** (data ends 2024-12) & **Lebanon** (ends 2025-10) — no 2026 IDP data.
- **Syria** — has 2026 rounds but no origin data (choropleth-only, no movement).
- Combined with the user's "one year (2026)" and "drop countries without 2026 data", only
  Yemen remains.

**Yemen source = RDT files, NOT the DTM API (important, verified).** The `dtmapi` API
(`/v3/displacement/admin0-2`) serves only IDP *stock*; Yemen there ends **2025-02-01** and
is monthly/quarterly. Yemen's weekly **2026** movement data is the **RDT** product,
published as **files on HDX + dtm.iom.int** (e.g. weekly RDT updates through 2026), not via
the API. So Yemen refresh = pulling the RDT workbook (manual now; automatable from HDX,
though HDX currently lags the local file, latest there ≈ 5 Sep vs local 12 Sep).

Confirmed decisions (2026-09-22):
- **Host:** build host-agnostic; ship to **GitHub Pages** by default (can move to
  Azure Static Web Apps later with no code change).
- **Basemap:** **tile-less** — admin boundaries on a clean background, no external
  map tiles. Fully self-contained and corporate-network-safe.
- **Branding:** **UNICEF** — see §8. Cyan `#1CABE2`, Roboto (self-hosted, UNICEF's
  sanctioned web substitute for its proprietary Univers font).
- **Process:** this spec first, then a **Yemen** prototype with the country selector wired.

---

## 2. Stack & why

| Concern | Choice | Why |
|---|---|---|
| Map / flow engine | **deck.gl** (WebGL) | `ArcLayer` = curved gradient O→D arrows sized by volume; `GeoJsonLayer` = choropleth; `TripsLayer` = optional animated movement over time. Purpose-built for movement maps. |
| Camera / projection | **deck.gl MapView**, **no basemap** | Renders our GeoJSON + arcs directly; smooth zoom/pan/pitch without any tile server. |
| App shell | **Vanilla TS + Vite** (no React) | Data model is small and already defined; keeps bundle lean and the app approachable, matching v0's spirit. React is not needed for this surface. |
| Charts (trend / bars) | Inline SVG helpers (carried from v0) | No chart lib; already themable via CSS tokens. |
| Build | **Vite** → static `dist/` | **Bundles every dependency locally** (deck.gl vendored). Final site makes **zero external network calls** — no CDN, no tiles. |
| Styling | Existing CSS custom properties | `--b1..--b6` blue ramp, `--accent` orange, `--conflict` red, light/dark — reused as-is. |

**Self-containment is a hard requirement**, not a nice-to-have: SharePoint and corporate
networks frequently block CDNs and third-party tile servers. Vite bundling + tile-less
rendering means the app runs from a folder of static files with nothing external.

---

## 3. Architecture

```
mena-displacement-monitor/
├── src/
│   ├── main.ts            App entry: load data.json → state → render
│   ├── state.ts           {country, period, level, selGov, metricMode, animate}
│   ├── data.ts            Load + typed accessors; aggGov() / aggDist() (ported)
│   ├── layers/
│   │   ├── choropleth.ts  GeoJsonLayer (ADM1 / ADM2), value→blue ramp
│   │   ├── flows.ts       ArcLayer (top-N O→D), width∝hh, gradient by direction
│   │   ├── internal.ts    ScatterplotLayer bubbles (displaced within same area)
│   │   └── trips.ts       (Phase 2) TripsLayer animated movement
│   ├── panels/
│   │   ├── kpis.ts        KPI cards
│   │   ├── trend.ts       SVG weekly-trend line
│   │   ├── bars.ts        SVG by-area bar chart
│   │   └── controls.ts    Country / period / level / animate controls
│   ├── theme.ts           Token access + light/dark
│   └── styles.css         Ported + extended
├── data/data.json         UNCHANGED (v0 pipeline output)
├── scripts/refresh_dtm.py UNCHANGED
├── index.html             Vite entry (mount point only)
├── vite.config.ts         base:'./' (relative paths → embeds anywhere)
└── dist/                  Built static site (what gets deployed / embedded)
```

**No backend.** Data is the static `data/data.json`, refreshed by the existing Python
script and re-deployed. `base: './'` (relative asset paths) is what lets the built
`dist/` sit inside a SharePoint library or any subpath without breaking.

---

## 4. Visual & interaction design

**Layout** — left rail (controls + KPIs + trend + bars), main stage = the deck.gl map,
legend under it. Responsive: rail collapses above the map on narrow/embedded widths.

**Map layers (bottom→top)**
1. Governorate/district polygons — choropleth on displacement volume, `--b1..--b6` ramp.
2. **Flow arcs** — top-N origin→destination arcs, width ∝ households, orange `--accent`,
   subtle source→dest gradient, soft glow; hover highlights one arc + dims the rest.
3. **Internal-displacement bubbles** — `--conflict` red circles sized by within-area moves.
4. Labels for the largest hubs.

**Interactions**
- Hover any polygon/arc/bubble → tooltip (name, households, indicative people ×6).
- Click a governorate with district data → **drill in**: camera flies to its bbox,
  layers switch to ADM2, arcs become internal + clipped external-inflow arrows.
- "← All governorates" returns.
- Period control: cumulative or last N weeks (flow). *(Phase 2: stock = pick a round.)*
- **Animate toggle** (Phase 2): plays weeks in sequence; arcs draw/fade, trend cursor
  sweeps — the "population moving over time" view.
- Full light/dark; keyboard-focusable controls; reduced-motion respected.

**Design language:** clean humanitarian product — generous whitespace, one orange accent,
blue sequential data ramp, red reserved for conflict/internal. No basemap clutter.

---

## 5. Data mapping (already fits) — flow vs stock

Both metric types share the same core payload (`geo`, `gov`, `perweek[i]` with
`total/dest/flows/reasons`), so **one renderer draws both**; the period control and
aggregation differ:

**Flow (Yemen)** — additive weeks:
- `perweek[i].flows[{o,d,hh}]` → gov arcs; `.dest{gov:val}` → choropleth; `.reasons` → KPI.
- `.dflows[{og,od,dg,dd,hh}]` + `dgeo{gov:ADM2 FC}` / `dbbox` / `dcent` → district drill.
- Period = cumulative or last N weeks; **sum** the selected weeks (`aggGov`/`aggDist`,
  ported 1:1 from v0).

**Stock (Iraq/Syria/Lebanon/Iran)** — snapshots, never summed:
- `weeks` are monthly **rounds** (labels like "Sep 2026"); `metric_type:"stock"`,
  `unit:"individuals"`, `hh_to_people:1`.
- Period control = **pick a round** (default latest), not "last N weeks".
- KPIs / choropleth / arcs come from that **single round's** `perweek[i]`; the trend
  line plots `total` across rounds (stock over time). No cross-round summing.
- Admin1 only (no `dgeo`/`dflows`) → drill-down disabled for these; hover still works.
- Reason labels need normalizing (e.g. "Conflict" vs "Conflict; Insecurity") for the
  conflict KPI — see §7 Phase 3.

---

## 6. Hosting & SharePoint embedding

**Build once, deploy anywhere:** `vite build` → `dist/` (fully static, relative paths).

- **GitHub Pages (default):** push repo, Settings → Pages → deploy `dist/` (or an Action).
  Live at `https://<you>.github.io/mena-displacement-monitor/`. Refresh = re-run script,
  commit new `data.json`, push.
- **SharePoint embed path (when ready):**
  1. **Embed web part** — paste `<iframe src="…github.io/…">`. Requires a **SharePoint/M365
     admin to allow-list the domain** (HTML Field Security). True for any external host.
  2. **No-admin fallback** — a link/button web part to the hosted site (always works).
  3. **Fully-internal option** — because `dist/` is self-contained static files, it can
     later move to **Azure Static Web Apps** in your tenant (trusted domain, optional
     org sign-in) with zero code change — the smoothest embed if data must stay private.

Decision on which SharePoint route is deferred until the app is built; nothing here
blocks that choice.

---

## 7. Delivery plan

**Phase 0 — data scope fix (quick, gating).**
Set `MENA_API_COUNTRIES = ["Iraq","Syrian Arab Republic","Lebanon"]` + **verify Iran**
via `refresh_dtm.py --discover` (needs your DTM key + deps). If Iran returns IDP admin1
data, add it; if not, note the fallback (§8). Re-run the refresh → new `data.json` with
the target countries. *(I can prep the code change; running it needs your key/env.)*

**Phase 1 — dual-mode prototype (core value).**
Scaffold Vite+TS; port data/aggregation; choropleth + flow arcs + internal bubbles.
Build **both metric modes at once**: Yemen (flow, week aggregation, gov→district drill)
**and** a stock country (round selector, snapshot render, stock trend). KPIs, trend, bars;
country switcher; light/dark; tooltips; vendored bundle.
→ Deliver a working `dist/` proving both data shapes look strong.

**Phase 2 — all countries + polish & motion.**
Wire the full target set; `TripsLayer` time-animation + play control (flow); arc
glow/curvature tuning; legend + reason-label normalization; narrow-width/embed layout
pass; a11y + reduced-motion; WebGL-unavailable fallback.

**Phase 3 — deploy.**
GitHub Pages (Action to build `dist/`) + a documented SharePoint embed guide. Optional
UNICEF palette swap. *(District drill for stock countries stays out of scope — needs
ADM2 data the DTM API doesn't provide; revisit only if required.)*

---

## 8. UNICEF branding

No UNICEF design system exists in Claude Design (checked 2026-09-22) — reconstructed from
UNICEF's public brand guidelines. All assets **vendored** (no external font/CDN calls).

- **Primary — UNICEF Cyan `#1CABE2`** (Pantone Process Cyan): anchor of the sequential
  choropleth ramp `--b1..--b6` (light cyan tint → deep teal/navy).
- **Accent — UNICEF Orange** (flow arcs `--accent`): warm, high-contrast on cyan.
- **Alert — UNICEF Red** (internal-displacement / conflict `--conflict`).
- **Neutrals** — warm greys per brand book for text/surfaces; full light + dark themes.
- **Font — Roboto, self-hosted.** UNICEF's brand face **Univers LT Pro is proprietary**
  and cannot ship in a static public app; UNICEF's guidelines name **Roboto** as the web
  substitute for Univers (Arial as the ultimate fallback). Roboto woff2 vendored locally.
- ⚠ **To finalize:** confirm exact secondary hexes (orange/red/greys) against the official
  UNICEF brand PDF; add the UNICEF logo lockup (needs the correct asset + usage clearance).

Tokens live at the top of the stylesheet (as in v0), so a later exact-hex tweak is one edit.

## 9. Risks / open items

- **Iran data availability (highest-priority unknown).** Iran is **not** in the current
  pipeline and DTM's Iran work is largely migrant/returnee *flow monitoring*, not IDP
  *stock*. `get_idp_admin1_data(CountryName="Iran…")` may return nothing or a different
  dataset. **Gate:** confirm via `--discover` before promising Iran (find the exact API
  country name too — likely "Iran (Islamic Republic of)"). Fallbacks if no IDP data:
  (a) include Iran from a different DTM dataset with a labeled caveat, or (b) exclude it
  and note "no IOM DTM IDP data available." Do not fabricate coverage.
- **DTM API admin levels (verified 2026-09-22).** The API *does* expose admin2
  (`get_idp_admin2_data`), incl. Yemen (5,763 rows) — earlier "admin1 only" was wrong.
  BUT: destination is admin2 while **origin is only admin1** (`idpOriginAdmin1Pcode`, no
  admin2 origin), so the API cannot give true **district→district** O-D — only
  district-of-arrival × governorate-of-origin. And the API's **Yemen IDP data is `stock`
  ending 2025-02-01** (round 26) — no 2026. The weekly **RDT flow** (through Sep 2026,
  district→district) is a separate product, Excel-only. Net: current district-level Yemen
  flows require the RDT Excel; the API is the source for the other countries' stock.
- **CDN/tile blocking** → mitigated by vendored bundle + tile-less rendering (core reason
  for the stack choice).
- **SharePoint allow-listing** needs an admin — flag early; link-out fallback if refused.
- **deck.gl bundle size** (~few hundred KB gzipped) — fine for static hosting; tree-shaken.
- **Household→people ×6** stays an *indicative* estimate, labeled as such (unchanged from v0).
- **WebGL requirement** — all modern browsers/SharePoint host it; add a graceful message
  if WebGL is unavailable.
```
