# v1.1: visual and interaction overhaul (2026-10-03)

This is a separate copy of the app. The original v1.0 folder was not touched. The data
pipeline (`scripts/refresh_dtm.py` → `data/data.json`) is unchanged, so both versions read
the same `data.json`.

## Arrows: rebuilt from scratch (`src/arrows.ts`)

**What was wrong in v1.0:** arrows were deck.gl `ArcLayer` arcs (raised into 3D) with a
separate billboard arrowhead icon. The head pointed along the straight line between the
two places, not along the curve, and the arc's apparent shape changed with zoom. So when
you zoomed in, heads came loose from the arcs and pointed the wrong way.

**v1.1:** every arrow is redrawn each frame in screen space, on a 2D canvas over the map:
- **Bends consistently.** Each route is a smooth curve whose bend is a fixed share of its
  on-screen length, so it keeps the same shape at every zoom. A→B and B→A bow to opposite
  sides, so return flows never sit on top of each other.
- **Head and body are one shape.** The arrowhead is built into the same outline as the
  body, so it always follows the curve. Short arrows shrink their head so it never takes
  over the whole arrow.
- **3D look:**
  - a soft ground shadow along a flatter curve; the ends touch the ground and the middle
    lifts off. The higher an arrow floats, the softer its shadow;
  - a slim tail that widens toward the head, with a colour gradient from tail to head;
  - a glossy highlight on the side facing the light and a darker core shade, so each
    arrow reads as a rounded tube;
  - a lit facet on the arrowhead and a crisp rim.
- **Same widths everywhere.** Width is in pixels, proportional to √households, on one
  scale shared by routes and within-area loops. Arrows grow gently as you zoom in (capped)
  instead of turning into blobs or hairlines. The legend draws its sample arrows with the
  same geometry and current zoom.
- **Direction cue.** Soft light pulses travel toward the head. Pause them with the ⏸
  button; they're off automatically if the system has *reduce motion* turned on.
- **Within-area movement** is a circular arrow drawn in the same style.
- **Deep zoom works.** Long routes whose two ends are both off-screen still render as
  they cross the view.
- **Labels** are drawn on the same canvas, in sync with the map. Overlapping labels are
  dropped by importance instead of being nudged off their places. The top destinations
  also show their arrival totals.

## Consistent zoom and pan
- One camera model: the country fit sets the zoom range (about one level out, up to
  zoom 11 in), and panning stays near the country. Every programmatic move (fit, drill,
  back) uses the same fly-to.
- The frame hugs the mainland; offshore islets no longer push the country off-centre.
  Fitting also leaves room for the floating controls.
- Scroll zoom is calmer (about 0.4 levels per wheel notch). Double-click zoom is off,
  because a single click drills in and the two clashed.
- Resizing the window re-frames the map, unless you have moved it yourself.

## Map controls (all on the map, in one style)
- **Top-left:** breadcrumb with a back button (Yemen › Taiz districts).
- **Top-right:** zoom in, zoom out, fit to view; pause/play animation.
- **Bottom-left:** a compact one-line legend: arrivals colour scale with its values,
  arrow-width samples with values, the within-area symbol, and "showing N of M routes".
  It collapses to a "Legend" button on phones.
- **Bottom-right:** **Arrows: Top 10 / Top 20 / All.** You choose how many routes to draw.

## Interaction rules
- **Hover an arrow:** it lights up and glows, the others fade, and a tooltip shows the
  route, households, indicative people and share of all movement.
- **Click an arrow:** it stays highlighted. Click it again, or press **Esc**, to release
  it. On touchscreens a tap also opens the details.
- **Click an area:** drills into its districts. In district view, clicking a neighbouring
  governorate switches to it. **Esc** or **‹** goes back.
- **Linked panels:**
  - Top movements (Sankey) ↔ map arrows: hovering one highlights the other.
  - Arrivals list ↔ map areas: hovering a row highlights the area and fades routes that
    don't touch it; clicking a row drills in.
- **Keyboard:** `+` / `−` zoom, `0` fit, `Esc` release the highlight or go back.
- Map clicks are now detected from pointer events, so they behave the same with mouse,
  pen and touch, and never fire at the end of a drag. In v1.0, deck's click recogniser
  did not fire reliably.

## Side panel
- KPIs: households, indicative people, **top destination**, and conflict share (or the
  number of areas receiving people).
- "Arrivals by governorate/district" is now a ranked, clickable list instead of a static
  chart.
- The trend chart shades the selected period and labels the peak. The selected date range
  is shown next to the Period control.

## Other
- District view: a land base under the drilled governorate, so districts without data
  aren't holes, plus a crisp outline. Inflows from other governorates are drawn slimmer
  and lighter than the district-to-district routes.
- Light/dark choice is remembered. On narrow screens the map comes first and the side
  panel follows below it.
- `?debug` in the URL exposes internals for automated screenshots. It has no effect
  otherwise.

## Files changed
`index.html`, `src/main.ts`, `src/styles.css`, `src/charts.ts`, `src/data.ts`,
`src/types.ts`, `src/arrows.ts` (new), `package.json` (version 1.1.0), `.gitignore`.
`src/sankey.ts` has minor styling tweaks only.

The data, fonts, pipeline scripts and docs are unchanged copies.

## Run
```
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/
```
