import './styles.css';
import { Deck, MapView, WebMercatorViewport, FlyToInterpolator, LinearInterpolator } from '@deck.gl/core';
import { GeoJsonLayer } from '@deck.gl/layers';
import { PathStyleExtension } from '@deck.gl/extensions';
import type { AppData, CountryPayload, Arc, AggGov, AggDist } from './types';
import {
  loadData, aggGov, aggDist, selectedWeekIdxs, readTokens, makeScale, fmt, fmtK,
} from './data';
import type { RGB, Tokens } from './data';
import { trendSVG, barsHTML } from './charts';
import { sankeySVG } from './sankey';
import { FlowOverlay, arrowWidth, legendArrowSVG } from './arrows';
import type { ArrowSpec, LoopSpec, LabelSpec, Scene, Emph } from './arrows';

// ------------------------------------------------------------------ state ---
interface State {
  country: string;
  period: number;
  level: 'gov' | 'dist';
  selGov: string | null;
  topN: number;                 // arrows drawn: 10 | 20 | 0 (= all)
  hoverKey: string | null;      // flow / loop under the pointer (map or Sankey)
  pinKey: string | null;        // flow clicked on the map — stays highlighted
  hoverArea: string | null;     // area under the pointer (map or bar list) → polygon highlight
  listArea: string | null;      // area hovered in the list → also fades unrelated arrows
  animate: boolean;
}
const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const state: State = {
  country: '', period: 0, level: 'gov', selGov: null, topN: 20,
  hoverKey: null, pinKey: null, hoverArea: null, listArea: null, animate: !reducedMotion,
};

const SEP = '\u0001';
const flowKey = (o: string, d: string) => o + SEP + d;
// Flow → last 4 weeks (or all, if shorter). Stock → latest round, never summed across rounds.
const defaultPeriod = (c: CountryPayload) => (c.metric_type === 'stock' ? c.weeks.length - 1 : c.weeks.length >= 4 ? 4 : 0);
const dashed = new PathStyleExtension({ dash: true });

let DATA: AppData;
let C: CountryPayload;
let curGov: AggGov | null = null;
let curDist: AggDist | null = null;
let tokens: Tokens = readTokens();
let deck: Deck<any>;
let overlay: FlowOverlay;
let viewState: any = { longitude: 47, latitude: 15.5, zoom: 5, pitch: 0, bearing: 0 };
let homeZoom = 5;                         // zoom of the country-fit view (anchors arrow growth)
let countryBox: [number, number, number, number] = [42, 12, 54, 19];   // full extent (pan limit)
let fitBox: [number, number, number, number] = countryBox;              // mainland (framing)
let userMoved = false;                    // has the person panned/zoomed since the last fit?
let scene: Omit<Scene, 'emph' | 'zoomK' | 'tokens' | 'animate'> = { arrows: [], loops: [], maxV: 1, maxLoop: 1, labels: [] };
let originColors: Record<string, RGB> = {};
let names: Record<string, string> = {};   // pcode → display name (govs + districts)

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const rgba = (c: RGB, a = 255): [number, number, number, number] => [c[0], c[1], c[2], a];
const rgbCss = (c: RGB) => `rgb(${c[0]},${c[1]},${c[2]})`;
const nameOf = (pc: string) => names[pc] || pc;

// Categorical colours keyed by ORIGIN, shared by the map arrows and the Sankey ribbons.
const ORIGIN_PALETTE: RGB[] = [
  [226, 35, 26], [242, 106, 33], [233, 168, 0], [0, 131, 61], [28, 171, 226], [55, 78, 162],
  [150, 26, 73], [122, 81, 149], [0, 150, 150], [106, 142, 47], [201, 79, 140], [90, 100, 110],
  [180, 95, 6], [46, 139, 87], [70, 130, 180],
];
function computeOriginColors(origins: string[]) {
  const uniq = [...new Set(origins)].sort();
  originColors = {};
  uniq.forEach((o, i) => { originColors[o] = ORIGIN_PALETTE[i % ORIGIN_PALETTE.length]; });
}
const originColor = (pc: string): RGB => originColors[pc] || tokens.accent;

// -------------------------------------------------------------------- boot ---
init().catch((e) => {
  console.error(e);
  $('nowebgl').textContent = 'Failed to load data. ' + e.message;
  $('nowebgl').hidden = false;
});

async function init() {
  initTheme();
  DATA = await loadData();
  const labels = Object.keys(DATA.countries);
  state.country = (DATA.default && labels.includes(DATA.default)) ? DATA.default : labels[0];
  selectCountry(state.country);

  buildCountrySelector(labels);
  wireControls();

  if (!setupDeck()) return;
  fitCountry(false);
  render();
  document.fonts?.ready.then(() => drawOverlay());
  // Resizing re-frames the current level unless the person has moved the map themselves.
  let rz = 0;
  new ResizeObserver(() => {
    sizeOverlay(); deck.setProps({}); drawOverlay();
    clearTimeout(rz);
    rz = window.setTimeout(() => { if (!userMoved) { state.level === 'dist' && state.selGov ? fitGov(state.selGov, false) : fitCountry(false); } }, 120);
  }).observe($('map'));
  if (state.animate) startAnim();
  // ?debug exposes internals for automated visual checks; no effect otherwise.
  if (new URLSearchParams(location.search).has('debug')) (window as any).__dm = { deck, state, get scene() { return scene; } };
}

function selectCountry(label: string) {
  state.country = label;
  C = DATA.countries[label];
  state.period = defaultPeriod(C);
  state.level = 'gov'; state.selGov = null;
  state.hoverKey = state.pinKey = state.hoverArea = state.listArea = null;
  names = {};
  for (const [pc, g] of Object.entries(C.gov)) names[pc] = g.name;
  for (const [pc, d] of Object.entries(C.dcent || {})) names[pc] = d.name;
  countryBox = bboxOf(C.geo);
  fitBox = bboxOf(C.geo, 0.01);
}

// ------------------------------------------------------------ deck setup ---
function setupDeck(): boolean {
  try {
    overlay = new FlowOverlay($<HTMLCanvasElement>('overlay'));
    sizeOverlay();
    deck = new Deck({
      canvas: 'deck',
      views: [new MapView({ repeat: false })],
      viewState,
      controller: {
        dragRotate: false, touchRotate: false, keyboard: false,
        doubleClickZoom: false,          // single click = select/drill; no double-click surprise
        scrollZoom: { speed: 0.006, smooth: true },
        inertia: 250,
      },
      parameters: { cullMode: 'none' } as any,
      onViewStateChange: ({ viewState: vs, interactionState: is }: any) => {
        if (is?.isDragging || is?.isZooming || is?.isPanning) userMoved = true;
        viewState = constrain(vs);
        deck.setProps({ viewState });
        hideTip();
        return viewState;
      },
      onAfterRender: () => drawOverlay(),
      onHover,
      getCursor: ({ isDragging }: any) => (isDragging ? 'grabbing' : cursor),
      layers: [],
    });
    return true;
  } catch (e) {
    console.error(e);
    $('nowebgl').hidden = false;
    return false;
  }
}

function sizeOverlay() {
  const el = $('map');
  overlay?.resize(el.clientWidth, el.clientHeight);
}

// --------------------------------------------------------- camera / zoom ---
// One consistent camera model everywhere: the country fit defines the zoom range
// (can't zoom out past ~1 level beyond it, or in beyond street-ish level), panning is
// kept around the country, every programmatic move animates the same way.
const MAX_ZOOM = 11;
function constrain(vs: any) {
  const minZoom = homeZoom - 0.8;
  const zoom = Math.max(minZoom, Math.min(MAX_ZOOM, vs.zoom));
  const [x0, y0, x1, y1] = countryBox;
  const padX = (x1 - x0) * 0.35, padY = (y1 - y0) * 0.35;
  return {
    ...vs, zoom, minZoom, maxZoom: MAX_ZOOM, pitch: 0, bearing: 0,
    longitude: Math.max(x0 - padX, Math.min(x1 + padX, vs.longitude)),
    latitude: Math.max(y0 - padY, Math.min(y1 + padY, vs.latitude)),
  };
}

// Bounding box of a FeatureCollection. With `minShare`, polygons smaller than that share
// of the total area (offshore islets) are ignored so the frame hugs the mainland.
function bboxOf(fc: { features: any[] }, minShare = 0): [number, number, number, number] {
  const rings: number[][][] = [];
  for (const f of fc.features) {
    const g = f.geometry;
    for (const poly of g.type === 'Polygon' ? [g.coordinates] : g.coordinates) rings.push(poly[0]);
  }
  const area = (r: number[][]) => { let a = 0; for (let i = 0; i < r.length - 1; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1]; return Math.abs(a) / 2; };
  const areas = rings.map(area), total = areas.reduce((s, a) => s + a, 0);
  let mnx = 180, mny = 90, mxx = -180, mxy = -90;
  rings.forEach((r, i) => {
    if (areas[i] < total * minShare) return;
    for (const [x, y] of r) { mnx = Math.min(mnx, x); mxx = Math.max(mxx, x); mny = Math.min(mny, y); mxy = Math.max(mxy, y); }
  });
  return [mnx, mny, mxx, mxy];
}

function fitView(b: [number, number, number, number], animate: boolean, pad = 40) {
  const el = $('map'); const w = el.clientWidth || 800, h = el.clientHeight || 600;
  const vp = new WebMercatorViewport({ width: w, height: h });
  // Leave room for the floating map controls (crumb/tools on top, legend at the bottom).
  const legendH = ($('legendBox') as HTMLDetailsElement).open ? $('legendBox').offsetHeight : 40;
  const padding = {
    top: Math.min(60, h * 0.1) + pad * 0.4,
    bottom: Math.min(legendH + 16, h * 0.28) + pad * 0.3,
    left: Math.min(pad, w * 0.03), right: Math.min(pad + 40, w * 0.03 + (w < 600 ? 0 : 30)),
  };
  const { longitude, latitude, zoom } = vp.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding });
  return { longitude, latitude, zoom: Math.min(zoom, 9.5), animate };
}
function flyTo(target: { longitude: number; latitude: number; zoom: number }, animate = true, ms = 800) {
  userMoved = false;
  viewState = constrain({
    ...viewState, ...target,
    transitionDuration: animate && !reducedMotion ? ms : 0,
    transitionInterpolator: animate && !reducedMotion ? new FlyToInterpolator({ speed: 1.8 }) : undefined,
  });
  deck?.setProps({ viewState });
}
function fitCountry(animate = true) {
  const t = fitView(fitBox, animate, 24);
  homeZoom = t.zoom;
  flyTo(t, animate);
}
function fitGov(g: string, animate = true) {
  const bb = C.dbbox?.[g];
  if (!bb) return;
  const [x0, y0, x1, y1] = bb; const dx = (x1 - x0) * 0.12, dy = (y1 - y0) * 0.12;
  flyTo(fitView([x0 - dx, y0 - dy, x1 + dx, y1 + dy], animate, 36), animate);
}
function fitCurrent() { state.level === 'dist' && state.selGov ? fitGov(state.selGov) : fitCountry(); }
function zoomBy(delta: number) {
  userMoved = true;
  viewState = constrain({
    ...viewState, zoom: viewState.zoom + delta,
    transitionDuration: reducedMotion ? 0 : 280, transitionInterpolator: new LinearInterpolator(['zoom']),
  });
  deck.setProps({ viewState });
}
// Arrows grow gently as you zoom in (and shrink a little zooming out) so they stay in
// proportion with the map without ever becoming blobs or hairlines.
const zoomK = () => Math.max(0.78, Math.min(1.9, Math.pow(2, (viewState.zoom - homeZoom) * 0.3)));

// ------------------------------------------------------------ navigation ---
function drill(pc: string) {
  if (!C.dgeo?.[pc]) return;
  state.level = 'dist'; state.selGov = pc;
  state.hoverKey = state.pinKey = state.hoverArea = state.listArea = null;
  hideTip();
  fitGov(pc);
  render();
}
function goUp() {
  if (state.level !== 'dist') return;
  state.level = 'gov'; state.selGov = null;
  state.hoverKey = state.pinKey = state.hoverArea = state.listArea = null;
  hideTip();
  fitCountry();
  render();
}

// ---------------------------------------------------------------- render ---
function render() {
  C = DATA.countries[state.country];
  tokens = readTokens();
  const idxs = selectedWeekIdxs(C, state.period);
  if (state.level === 'gov') buildGov(idxs); else buildDist(idxs);
  deck.setProps({ layers: mapLayers() });
  updatePanels(new Set(idxs));
  updateChrome();
  drawOverlay();
}

// Build the arrow / loop / label scene for the governorate view.
function buildGov(idxs: number[]) {
  const A = aggGov(C, idxs); curGov = A; curDist = null;
  const flows = state.topN ? A.flows.slice(0, state.topN) : A.flows;
  const loops: LoopSpec[] = Object.entries(A.intern).map(([pc, v]) => {
    const g = C.gov[pc]; return g?.lon != null ? { key: flowKey(pc, pc), pos: [g.lon, g.lat!] as [number, number], v, color: [0, 0, 0] as RGB } : null;
  }).filter(Boolean) as LoopSpec[];
  computeOriginColors([...flows.map((f) => f.oPc), ...loops.map((l) => l.key.split(SEP)[0])]);
  loops.forEach((l) => { l.color = originColor(l.key.split(SEP)[0]); });

  const maxDest = Math.max(1, ...Object.values(A.dest));
  const ranked = Object.entries(A.dest).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([pc]) => pc);
  const labels: LabelSpec[] = Object.entries(C.gov).filter(([, g]) => g.lon != null).map(([pc, g]) => {
    const v = A.dest[pc] || 0, r = ranked.indexOf(pc);
    return {
      text: g.name, pos: [g.lon!, g.lat!] as [number, number],
      sub: r >= 0 && r < 5 ? fmtK(v) : undefined,
      rank: v <= 0 ? 1 : 10 + v / maxDest,
      cls: v <= 0 ? 'faint' : r < 3 ? 'big' : 'norm',
    } as LabelSpec;
  });

  const maxLoop = Math.max(1, ...loops.map((l) => l.v));
  const maxFlow = Math.max(1, ...flows.map((f) => f.v));
  scene = {
    arrows: flows.map((f) => toArrow(f)),
    loops, labels,
    maxV: Math.max(maxFlow, maxLoop), maxLoop,
  };
}

function buildDist(idxs: number[]) {
  const G = state.selGov!;
  const A = aggDist(C, idxs, G); curDist = A; curGov = null;
  const intern = state.topN ? A.intern.slice(0, state.topN) : A.intern;
  const inflow = A.inflow.slice(0, 6);
  const loops: LoopSpec[] = Object.entries(A.internBubble).map(([pc, v]) => {
    const d = C.dcent?.[pc]; return d ? { key: flowKey(pc, pc), pos: [d.lon, d.lat] as [number, number], v, color: [0, 0, 0] as RGB } : null;
  }).filter(Boolean) as LoopSpec[];
  computeOriginColors([...inflow.map((a) => a.oPc), ...intern.map((a) => a.oPc), ...loops.map((l) => l.key.split(SEP)[0])]);
  loops.forEach((l) => { l.color = originColor(l.key.split(SEP)[0]); });

  const maxDest = Math.max(1, ...Object.values(A.dest));
  const ranked = Object.entries(A.dest).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([pc]) => pc);
  const labels: LabelSpec[] = [];
  for (const [pc, dc] of Object.entries(C.dcent || {})) {
    if (dc.g !== G) continue;
    const v = A.dest[pc] || 0, r = ranked.indexOf(pc);
    labels.push({
      text: dc.name, pos: [dc.lon, dc.lat], sub: r >= 0 && r < 4 ? fmtK(v) : undefined,
      rank: v <= 0 ? 1 : 10 + v / maxDest, cls: v <= 0 ? 'faint' : r < 3 ? 'big' : 'norm',
    });
  }
  for (const [pc, g] of Object.entries(C.gov)) {
    if (pc === G || g.lon == null) continue;
    labels.push({ text: g.name, pos: [g.lon, g.lat!], rank: 0, cls: 'ctx' });
  }
  const all = [...inflow, ...intern];
  const maxLoop = Math.max(1, ...loops.map((l) => l.v));
  scene = {
    // Inflow from other governorates is context: drawn slimmer and lighter than the
    // district-to-district routes that are the subject of this view.
    arrows: [...inflow.map((f) => ({ ...toArrow(f), secondary: true })), ...intern.map((f) => toArrow(f))],
    loops, labels,
    maxV: Math.max(1, ...all.map((f) => f.v), maxLoop), maxLoop,
  };
}
const toArrow = (f: Arc): ArrowSpec => ({ key: flowKey(f.oPc, f.dPc), o: f.o, d: f.d, v: f.v, color: originColor(f.oPc) });

// Which arrows to emphasise: a focused flow wins; otherwise an area hovered in the list
// keeps the arrows that start or end there and fades the rest. (Hovering areas on the map
// itself only highlights the polygon, so arrows don't flicker as the pointer moves.)
function emph(key: string): Emph {
  const focus = state.pinKey ?? state.hoverKey;
  if (focus) return key === focus ? 'on' : 'dim';
  if (state.listArea) {
    const [o, d] = key.split(SEP);
    const touches = o === state.listArea || d === state.listArea;
    return touches ? 'norm' : (areaHasFlows(state.listArea) ? 'dim' : 'norm');
  }
  return 'norm';
}
function areaHasFlows(pc: string) {
  return scene.arrows.some((a) => a.key.split(SEP).includes(pc)) || scene.loops.some((l) => l.key.startsWith(pc + SEP));
}

let lastT = 0;
function drawOverlay(t = lastT) {
  if (!deck || !overlay || !(deck as any).isInitialized) return;   // deck asserts before its first frame
  const vp = deck.getViewports()[0] as any;
  if (!vp) return;
  lastT = t;
  overlay.draw(vp, { ...scene, emph, zoomK: zoomK(), tokens, animate: state.animate }, t);
}

let animId = 0;
function startAnim() {
  cancelAnimationFrame(animId);
  const loop = (t: number) => { if (!document.hidden) drawOverlay(t); animId = requestAnimationFrame(loop); };
  animId = requestAnimationFrame(loop);
}
function stopAnim() { cancelAnimationFrame(animId); animId = 0; drawOverlay(); }

// ------------------------------------------------------------ map layers ---
function featIndex(fc: { features: any[] }, pc: string | null) {
  if (!pc) return -1;
  return fc.features.findIndex((f) => f.properties.pc === pc);
}
function mapLayers() {
  const hl = tokens.dark ? [255, 255, 255, 46] : [255, 255, 255, 70];
  if (state.level === 'gov' && curGov) {
    const A = curGov;
    const scale = makeScale(Math.max(1, ...Object.values(A.dest)), tokens.ramp);
    return [
      new GeoJsonLayer({
        id: 'gov-choropleth', data: C.geo as any, pickable: true, stroked: true, filled: true,
        highlightedObjectIndex: featIndex(C.geo, state.hoverArea), highlightColor: hl as any,
        getFillColor: (f: any) => rgba(scale(A.dest[f.properties.pc] || 0), 240),
        getLineColor: rgba(tokens.stroke, 255), lineWidthUnits: 'pixels', getLineWidth: 1.2,
        updateTriggers: { getFillColor: [state.country, state.period, tokens] },
      }),
    ];
  }
  const G = state.selGov!, A = curDist!;
  const dgeo = C.dgeo?.[G] || { type: 'FeatureCollection', features: [] };
  const neighbors = neighborsFor(G);
  const scale = makeScale(Math.max(1, ...Object.values(A.dest)), tokens.ramp);
  return [
    new GeoJsonLayer({
      id: 'dist-neighbors', data: neighbors, pickable: true, stroked: true, filled: true,
      highlightedObjectIndex: featIndex(neighbors, state.hoverArea), highlightColor: [28, 171, 226, 50],
      getFillColor: rgba(tokens.land, 170), getLineColor: rgba(tokens.stroke, 220),
      lineWidthUnits: 'pixels', getLineWidth: 1,
      updateTriggers: { getFillColor: [tokens], getLineColor: [tokens] },
    }),
    // district lines of the surrounding governorates, dashed so they read as context
    new GeoJsonLayer({
      id: 'dist-context', data: contextDistricts(G), pickable: false, stroked: true, filled: false,
      getLineColor: rgba(tokens.ink2, tokens.dark ? 170 : 160), lineWidthUnits: 'pixels', getLineWidth: 1.1,
      getDashArray: [5, 3], dashJustified: true, extensions: [dashed],
      updateTriggers: { getLineColor: [tokens] },
    } as any),
    // governorate borders on top of the dashed district lines
    new GeoJsonLayer({
      id: 'dist-neighbor-outline', data: neighbors, pickable: false, stroked: true, filled: false,
      getLineColor: rgba(tokens.ink2, tokens.dark ? 170 : 150), lineWidthUnits: 'pixels', getLineWidth: 1.4,
      updateTriggers: { getLineColor: [tokens] },
    }),
    // land base for the drilled governorate, so districts without data aren't holes
    new GeoJsonLayer({
      id: 'dist-base', data: govFeature(G), pickable: false, stroked: false, filled: true,
      getFillColor: rgba(tokens.land, 255), updateTriggers: { getFillColor: [tokens] },
    }),
    new GeoJsonLayer({
      id: 'dist-choropleth', data: dgeo as any, pickable: true, stroked: true, filled: true,
      highlightedObjectIndex: featIndex(dgeo, state.hoverArea), highlightColor: hl as any,
      getFillColor: (f: any) => rgba(scale(A.dest[f.properties.pc] || 0), 245),
      getLineColor: rgba(tokens.stroke, 250), lineWidthUnits: 'pixels', getLineWidth: 1.1,
      updateTriggers: { getFillColor: [G, state.period, tokens] },
    }),
    // crisp outline of the drilled governorate
    new GeoJsonLayer({
      id: 'dist-outline', data: govFeature(G), pickable: false, stroked: true, filled: false,
      getLineColor: rgba(tokens.ink2, 200), lineWidthUnits: 'pixels', getLineWidth: 2,
      updateTriggers: { getLineColor: [tokens] },
    }),
  ];
}
// Stable FeatureCollections per country+gov so hover-driven layer rebuilds keep the same
// data reference and deck.gl skips re-parsing.
const fcCache = new Map<string, any>();
function contextDistricts(G: string) {
  const key = C.iso + ':' + state.country + ':d:' + G;
  if (!fcCache.has(key)) fcCache.set(key, { type: 'FeatureCollection', features: (C.adm2?.features ?? []).filter((f) => f.properties.g !== G) });
  return fcCache.get(key);
}
function neighborsFor(G: string) {
  const key = C.iso + ':' + state.country + ':n:' + G;
  if (!fcCache.has(key)) fcCache.set(key, { type: 'FeatureCollection', features: C.geo.features.filter((f) => f.properties.pc !== G) });
  return fcCache.get(key);
}
function govFeature(G: string) {
  const key = C.iso + ':' + state.country + ':g:' + G;
  if (!fcCache.has(key)) fcCache.set(key, { type: 'FeatureCollection', features: C.geo.features.filter((f) => f.properties.pc === G) });
  return fcCache.get(key);
}
function refreshHighlights() {
  deck.setProps({ layers: mapLayers() });
  syncSankey(); syncBars();
  drawOverlay();
}

// ---------------------------------------------------------- interactions ---
let cursor = 'grab';
function onHover(info: any) {
  const { x, y } = info;
  if (x == null || x < 0) { setHover(null, null); hideTip(); cursor = 'grab'; return; }

  // Arrows sit visually above areas, so they win the pick.
  const key = overlay.hit(x, y);
  if (key) {
    setHover(key, null);
    showTip(flowTip(key), info);
    cursor = 'pointer';
    return;
  }
  const o = info.object, id: string | undefined = info.layer?.id;
  const pc: string | undefined = o?.properties?.pc;
  setHover(null, pc ?? null);
  if (!pc) { hideTip(); cursor = 'grab'; return; }
  if (id === 'dist-neighbors') {
    showTip(`<b>${o.properties.name}</b>${C.dgeo?.[pc] ? '<div class="tip-hint">Click to view its districts</div>' : ''}`, info);
    cursor = C.dgeo?.[pc] ? 'pointer' : 'grab';
  } else {
    showTip(areaTip(pc, o.properties.name), info);
    cursor = state.level === 'gov' && C.dgeo?.[pc] ? 'pointer' : 'grab';
  }
}
function setHover(key: string | null, area: string | null) {
  if (key === state.hoverKey && area === state.hoverArea) return;
  state.hoverKey = key; state.hoverArea = area;
  refreshHighlights();
}

// Clicks are detected from raw pointer events (press + release within a few px) rather
// than deck's gesture recogniser, so a click behaves the same with mouse, pen or touch and
// never fires at the end of a drag.
function wireMapClicks() {
  const el = $('map');
  let down: { x: number; y: number; t: number; id: number } | null = null;
  el.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('.mapbox, .maptools')) return;
    down = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
  });
  el.addEventListener('pointerup', (e) => {
    const d = down; down = null;
    if (!d || d.id !== e.pointerId) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6 || performance.now() - d.t > 700) return;
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const picked: any = deck.pickObject({ x, y, radius: 2 }) || {};
    onClick({ ...picked, x, y });
  });
}

function onClick(info: any) {
  const { x, y } = info;
  if (x == null) return;
  const key = overlay.hit(x, y);
  if (key) {                                       // click an arrow → pin / unpin it
    state.pinKey = state.pinKey === key ? null : key;
    refreshHighlights();
    // Touch screens have no hover, so a tap also opens the details.
    if (state.pinKey) showTip(flowTip(key), info); else hideTip();
    return;
  }
  if (state.pinKey) { state.pinKey = null; refreshHighlights(); }
  const pc: string | undefined = info.object?.properties?.pc;
  const id: string | undefined = info.layer?.id;
  if (!pc) {                                       // empty map → back to the whole country
    if (state.level === 'dist') goUp(); else fitCountry();
    return;
  }
  if (state.level === 'gov' || id === 'dist-neighbors') drill(pc);
}

function onKey(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement)?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (e.key === 'Escape') {
    if (state.pinKey) { state.pinKey = null; refreshHighlights(); } else goUp();
  } else if (e.key === '+' || e.key === '=') zoomBy(1);
  else if (e.key === '-' || e.key === '_') zoomBy(-1);
  else if (e.key === '0') fitCurrent();
}

// --------------------------------------------------------------- tooltip ---
function showTip(html: string, info: any) {
  const tip = $('tip');
  tip.innerHTML = html;
  tip.classList.add('on'); tip.setAttribute('aria-hidden', 'false');
  const r = $('map').getBoundingClientRect();
  const cx = r.left + info.x, cy = r.top + info.y;
  const tw = tip.offsetWidth, th = tip.offsetHeight, pad = 16;
  let left = cx + pad, top = cy + pad;
  if (left + tw > window.innerWidth - 8) left = cx - tw - pad;
  if (top + th > window.innerHeight - 8) top = cy - th - pad;
  tip.style.left = Math.max(8, left) + 'px';
  tip.style.top = Math.max(8, top) + 'px';
}
function hideTip() { const tip = $('tip'); tip.classList.remove('on'); tip.setAttribute('aria-hidden', 'true'); }

// People: 'reported' when the source publishes individuals, otherwise an estimate from households.
const reported = () => C.people_basis === 'reported';
const approx = () => (reported() ? '' : '≈');
const people = (v: number) => (C.hh_to_people > 1 ? `<span class="tip-ppl">${approx()}${approx() ? ' ' : ''}${fmtK(v * C.hh_to_people)} people</span>` : '');
function flowTip(key: string): string {
  const [o, d] = key.split(SEP);
  const v = o === d
    ? (curGov ? curGov.intern[o] : curDist?.internBubble[o]) || 0
    : scene.arrows.find((a) => a.key === key)?.v || 0;
  const total = curGov?.total ?? curDist?.total ?? 0;
  const share = total > 0 ? `<span class="tip-share">${Math.max(1, Math.round((v / total) * 100))}% of all movement</span>` : '';
  const route = o === d ? `${nameOf(o)} <span class="tip-arw">↻</span> within area` : `${nameOf(o)} <span class="tip-arw">→</span> ${nameOf(d)}`;
  const sw = `<i class="tip-sw" style="background:${rgbCss(originColor(o))}"></i>`;
  return `<div class="tip-hd">${sw}<b>${route}</b></div>
    <div class="tip-big"><span class="tv">${fmt(v)}</span> ${C.unit}</div>
    <div class="tip-meta">${people(v)}${share}</div>
    <div class="tip-hint">${state.pinKey === key ? 'Click again to release' : 'Click to keep highlighted'}</div>`;
}

// Area tooltip: arrivals, within-area moves and where people came from.
function areaTip(pc: string, nm: string): string {
  let arrivals = 0, within = 0, origins: { pc: string; v: number }[] = [];
  if (state.level === 'gov' && curGov) {
    arrivals = curGov.dest[pc] || 0; within = curGov.intern[pc] || 0;
    origins = curGov.flows.filter((f) => f.dPc === pc).map((f) => ({ pc: f.oPc, v: f.v }));
  } else if (curDist) {
    arrivals = curDist.dest[pc] || 0; within = curDist.internBubble[pc] || 0;
    origins = [...curDist.inflow.filter((f) => f.dPc === pc), ...curDist.intern.filter((f) => f.dPc === pc)]
      .map((f) => ({ pc: f.oPc, v: f.v }));
  }
  origins = origins.sort((a, b) => b.v - a.v).slice(0, 3);
  const rows = [
    within > 0 ? `<div class="tip-row"><span>↻ within area</span><b>${fmtK(within)}</b></div>` : '',
    ...origins.map((f) => `<div class="tip-row"><span><i class="tip-dot" style="background:${rgbCss(originColor(f.pc))}"></i>from ${nameOf(f.pc)}</span><b>${fmtK(f.v)}</b></div>`),
  ].join('');
  const drillHint = state.level === 'gov' && C.dgeo?.[pc] ? '<div class="tip-hint">Click to view its districts</div>' : '';
  return `<div class="tip-hd"><b>${nm}</b></div>
    <div class="tip-big"><span class="tv">${fmt(arrivals)}</span> ${C.unit} arrived</div>
    <div class="tip-meta">${people(arrivals)}</div>
    ${rows ? `<div class="tip-sec">Where they came from</div>${rows}` : ''}${drillHint}`;
}

// ---------------------------------------------------------------- panels ---
function updatePanels(selSet: Set<number>) {
  const mult = C.hh_to_people;
  let total: number, conflict = 0, areasActive: number;
  let barItems: { pc: string; name: string; value: number; drill: boolean }[];
  let flowPairs: { oName: string; dName: string; v: number; key: string; oPc: string }[];

  if (state.level === 'gov' && curGov) {
    const A = curGov;
    total = A.total;
    conflict = Object.entries(A.reasons).filter(([k]) => /conflict/i.test(k)).reduce((s, [, v]) => s + v, 0);
    barItems = Object.entries(A.dest).map(([pc, v]) => ({ pc, name: nameOf(pc), value: v, drill: !!C.dgeo?.[pc] }));
    flowPairs = [
      ...A.flows.map((f) => ({ oName: nameOf(f.oPc), dName: nameOf(f.dPc), v: f.v, key: flowKey(f.oPc, f.dPc), oPc: f.oPc })),
      ...Object.entries(A.intern).map(([pc, v]) => ({ oName: nameOf(pc), dName: nameOf(pc), v, key: flowKey(pc, pc), oPc: pc })),
    ];
  } else {
    const A = curDist!;
    total = A.total;
    barItems = Object.entries(A.dest).map(([pc, v]) => ({ pc, name: nameOf(pc), value: v, drill: false }));
    flowPairs = [
      ...A.inflow.map((f) => ({ oName: nameOf(f.oPc), dName: nameOf(f.dPc), v: f.v, key: flowKey(f.oPc, f.dPc), oPc: f.oPc })),
      ...A.intern.map((f) => ({ oName: nameOf(f.oPc), dName: nameOf(f.dPc), v: f.v, key: flowKey(f.oPc, f.dPc), oPc: f.oPc })),
      ...Object.entries(A.internBubble).map(([pc, v]) => ({ oName: nameOf(pc), dName: nameOf(pc), v, key: flowKey(pc, pc), oPc: pc })),
    ];
  }
  areasActive = barItems.filter((d) => d.value > 0).length;
  const top = [...barItems].sort((a, b) => b.value - a.value)[0];

  const flowWord = C.metric_type === 'flow' ? 'displaced' : 'IDPs (present)';
  const kpis = [
    { v: fmtK(total), n: `${C.unit} ${flowWord}`, cls: 'cyan' },
    ...(mult > 1 ? [{ v: `${approx()}${fmtK(total * mult)}`, n: reported() ? 'people (IOM-reported)' : 'people (estimated)', cls: 'accent' }] : []),
    ...(top && top.value > 0 ? [{ v: top.name, n: `top destination · ${fmtK(top.value)}`, cls: 'name' }] : []),
    ...(state.level === 'gov' && conflict > 0
      ? [{ v: `${Math.round((conflict / Math.max(1, total)) * 100)}%`, n: 'conflict-driven', cls: 'red' }]
      : [{ v: String(areasActive), n: state.level === 'gov' ? 'areas receiving' : 'districts receiving', cls: '' }]),
  ].slice(0, 4);
  $('kpis').innerHTML = kpis.map((k) => `<div class="kpi ${k.cls}"><div class="v" title="${k.v}">${k.v}</div><div class="n">${k.n}</div></div>`).join('');

  $('flows').innerHTML = sankeySVG(flowPairs, C.unit, mult, (oPc) => rgbCss(originColor(oPc)), reported() ? '' : '~');
  wireSankey();

  $('trend').innerHTML = trendSVG(C, selSet);
  $('bars').innerHTML = barsHTML(barItems, mult, reported() ? '' : '~');
  wireBars();
  $('barsSub').textContent = areasActive > 8 ? `top 8 of ${areasActive}` : `${areasActive} ${areasActive === 1 ? 'area' : 'areas'}`;
  $('trendSub').textContent = C.metric_type === 'flow' ? `${C.weeks.length} weeks` : `${C.weeks.length} rounds`;
}

// Hovering a Sankey ribbon highlights the matching arrow on the map (and vice versa).
function wireSankey() {
  $('flows').querySelectorAll<SVGElement>('.sk-link').forEach((r) => {
    const k = (r as any).dataset.key || null;
    r.addEventListener('mouseenter', () => { state.hoverKey = k; refreshHighlights(); });
    r.addEventListener('mouseleave', () => { state.hoverKey = null; refreshHighlights(); });
    r.addEventListener('click', () => { state.pinKey = state.pinKey === k ? null : k; refreshHighlights(); });
  });
}
function syncSankey() {
  const focus = state.pinKey ?? state.hoverKey;
  $('flows').querySelectorAll<SVGElement>('.sk-link').forEach((el) => {
    const k = (el as any).dataset.key as string;
    const touches = state.listArea ? k.split(SEP).includes(state.listArea) : false;
    el.classList.toggle('on', focus != null ? k === focus : touches);
    el.classList.toggle('dim', focus != null ? k !== focus : (state.listArea != null && !touches && areaHasFlows(state.listArea)));
  });
}
// Hovering a bar highlights the area on the map; clicking a governorate drills in.
function wireBars() {
  $('bars').querySelectorAll<HTMLElement>('.br-row').forEach((row) => {
    const pc = row.dataset.pc!;
    row.addEventListener('mouseenter', () => { state.hoverArea = state.listArea = pc; refreshHighlights(); });
    row.addEventListener('mouseleave', () => { state.hoverArea = state.listArea = null; refreshHighlights(); });
    if (row.classList.contains('drill')) {
      row.addEventListener('click', () => drill(pc));
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); drill(pc); } });
    }
  });
}
function syncBars() {
  $('bars').querySelectorAll<HTMLElement>('.br-row').forEach((row) => row.classList.toggle('on', row.dataset.pc === state.hoverArea));
}

// ---------------------------------------------------------------- chrome ---
function updateChrome() {
  const flow = C.metric_type === 'flow';
  $('appTitle').textContent = C.label ? `${C.country} · ${C.label}` : `${C.country} · Displacement Monitor`;
  $('appSub').textContent = C.subtitle ?? (flow ? 'New internal displacement — origin → destination'
    : 'Present internally displaced persons (stock) — by round');
  $('trendTitle').textContent = flow ? 'Weekly trend' : 'Stock over rounds';
  $('barsTitle').textContent = state.level === 'gov' ? 'Arrivals by governorate' : 'Arrivals by district';
  $('flowTitle').textContent = 'Top movements';
  $('flowSub').textContent = state.level === 'gov'
    ? (flow ? 'governorate → governorate' : 'origin → present area')
    : 'into ' + nameOf(state.selGov!);
  const pplNote = !(flow && C.hh_to_people > 1) ? ''
    : reported() ? `People = individuals as reported by IOM (${C.hh_to_people} per household on average).`
    : `People = households × ${C.hh_to_people} (estimated; this dataset records households only).`;
  $('srcNote').innerHTML = `Source: IOM DTM — ${flow ? (C.label ?? 'Rapid Displacement Tracking') : 'DTM API'}. `
    + `Boundaries: geoBoundaries. ${pplNote}`;

  updateRefreshPill();
  buildPeriod(flow);
  buildTopN();

  // breadcrumb + back
  $('backBtn').hidden = state.level !== 'dist';
  const crumb = $('crumb');
  if (state.level === 'dist') {
    crumb.innerHTML = `<button class="crumb-lnk" id="crumbAll">${C.country}</button><span class="crumb-sep">›</span><b>${nameOf(state.selGov!)}</b><span class="crumb-dim">districts</span>`;
    $('crumbAll').addEventListener('click', goUp);
  } else {
    crumb.innerHTML = `<b>${C.country}</b><span class="crumb-dim">all governorates</span>`;
  }
  $('hint').innerHTML = state.level === 'gov'
    ? '<b>Click</b> a governorate for districts · <b>Hover</b> an arrow for details'
    : '<b>Esc</b> or <b>‹</b> to go back · <b>Click</b> a neighbour to switch';
  buildLegend();
}

function updateRefreshPill() {
  const pill = $('refreshPill');
  const built = new Date(DATA.generated + 'T00:00:00');
  const latest = C.weeks[C.weeks.length - 1]?.end;
  const days = Math.floor((Date.now() - built.getTime()) / 86400000);
  const d = (s?: string) => s ? new Date(s + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
  const stale = days > 8 ? 'stale' : days > 3 ? 'aging' : 'fresh';
  const ago = days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  pill.className = 'refresh ' + stale;
  pill.innerHTML = `<span class="rdot"></span> Data to ${d(latest)}`;
  pill.title = `Data built ${d(DATA.generated)} (${ago}); latest period ends ${d(latest)}`;
}

function buildPeriod(flow: boolean) {
  const seg = $('periodSeg'), lab = $('periodLab');
  if (flow) {
    lab.textContent = 'Period';
    const n = C.weeks.length;
    const opts = [{ v: 0, t: 'All' }, { v: 4, t: '4 wks' }, { v: 2, t: '2 wks' }, { v: 1, t: 'Latest' }].filter((o) => o.v <= n);
    seg.innerHTML = opts.map((o) => `<button data-p="${o.v}" aria-pressed="${state.period === o.v}">${o.t}</button>`).join('');
  } else {
    lab.textContent = 'Round';
    const n = C.weeks.length; const cur = state.period < 0 || state.period >= n ? n - 1 : state.period;
    seg.innerHTML = `<select id="roundSel" aria-label="Round">${C.weeks.map((w) => `<option value="${w.i}" ${cur === w.i ? 'selected' : ''}>${w.label}</option>`).join('')}</select>`;
    $('roundSel').addEventListener('change', (e) => { state.period = Number((e.target as HTMLSelectElement).value); render(); });
  }
  seg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    state.period = Number((b as HTMLElement).dataset.p); state.pinKey = null; render();
  }));
  // human-readable range of the selected weeks
  const idxs = selectedWeekIdxs(C, state.period);
  const a = C.weeks[idxs[0]], z = C.weeks[idxs[idxs.length - 1]];
  const d = (s: string) => new Date(s + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  $('periodRange').textContent = a && z ? `· ${d(a.start)} – ${d(z.end)}` : '';
}

function buildTopN() {
  const seg = $('topNSeg');
  const opts = [{ v: 10, t: 'Top 10' }, { v: 20, t: 'Top 20' }, { v: 0, t: 'All' }];
  seg.innerHTML = opts.map((o) => `<button data-n="${o.v}" aria-pressed="${state.topN === o.v}">${o.t}</button>`).join('');
  seg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    state.topN = Number((b as HTMLElement).dataset.n); state.pinKey = null; render();
  }));
}

function buildLegend() {
  const A = curGov ?? curDist!;
  const maxDest = Math.max(0, ...Object.values(A.dest));
  const ramp = tokens.ramp.map((c) => `<i style="background:rgb(${c.join(',')})"></i>`).join('');
  // Arrow swatches at the map's current zoom so the legend matches what you see.
  const k = Math.min(1.25, zoomK());
  const maxV = scene.maxV;
  const samples = [maxV, maxV / 4, maxV / 16].filter((v) => v >= 1).map((v) => Math.round(v));
  const nTotal = state.level === 'gov' ? (curGov?.flows.length ?? 0) : (curDist ? curDist.intern.length + Math.min(6, curDist.inflow.length) : 0);
  const nShown = scene.arrows.length;
  $('legend').innerHTML = `
    <div class="lg-sec">
      <div class="lg-t">Arrivals <span>${C.unit}</span></div>
      <div class="lg-ramp">${ramp}</div>
      <div class="lg-ends"><span>0</span><span>${fmtK(maxDest)}</span></div>
    </div>
    <div class="lg-sec">
      <div class="lg-t">Movement <span>arrow width</span></div>
      <div class="lg-arrows">${samples.map((v) => `<span class="lg-arrow">${legendArrowSVG(arrowWidth(v, maxV, k), undefined, 34)}<b>${fmtK(v)}</b></span>`).join('')}</div>
    </div>
    <div class="lg-sec">
      <div class="lg-t">Within area</div>
      <div class="lg-row"><span class="lg-loop" aria-hidden="true"></span><span>same area</span></div>
    </div>
    <div class="lg-sec lg-note">
      <div><b>Colour</b> = where people left from</div>
      <div>${nShown < nTotal ? `Showing ${nShown} of ${nTotal} routes` : `All ${nTotal} routes shown`}</div>
    </div>`;
}

// -------------------------------------------------------------- controls ---
function buildCountrySelector(labels: string[]) {
  const sel = $<HTMLSelectElement>('countrySel');
  sel.innerHTML = labels.map((n) => `<option value="${n}">${n}</option>`).join('')
    + DATA.pending.map((n) => `<option value="${n}" disabled>${n} (coming soon)</option>`).join('');
  sel.value = state.country;
  sel.addEventListener('change', () => {
    selectCountry(sel.value);
    fitCountry(true); render();
  });
}

function wireControls() {
  wireMapClicks();
  $('backBtn').addEventListener('click', goUp);
  $('zoomIn').addEventListener('click', () => zoomBy(1));
  $('zoomOut').addEventListener('click', () => zoomBy(-1));
  $('zoomFit').addEventListener('click', fitCurrent);
  const anim = $('animBtn');
  const syncAnim = () => anim.setAttribute('aria-pressed', String(state.animate));
  syncAnim();
  anim.addEventListener('click', () => {
    state.animate = !state.animate; syncAnim();
    state.animate ? startAnim() : stopAnim();
  });
  $('themeBtn').addEventListener('click', () => {
    const now = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    setTheme(now);
    try { localStorage.setItem('dm-theme', now); } catch { /* storage unavailable */ }
    render();
  });
  window.addEventListener('keydown', onKey);
  $('map').addEventListener('mouseleave', () => { hideTip(); setHover(null, null); });
  // Pointer over a floating control = not over the map: clear map hover state.
  document.querySelectorAll<HTMLElement>('.mapbox, .maptools, .hint').forEach((el) =>
    el.addEventListener('pointerenter', () => { hideTip(); setHover(null, null); }));
  // Collapse the legend by default on small screens so it never covers the map.
  if (window.innerWidth < 720) ($('legendBox') as HTMLDetailsElement).open = false;
}

function initTheme() {
  let t: string | null = null;
  try { t = localStorage.getItem('dm-theme'); } catch { /* ignore */ }
  setTheme(t === 'dark' || t === 'light' ? t : 'light');
}
function setTheme(t: string) {
  document.documentElement.setAttribute('data-theme', t);
  $('app').setAttribute('data-theme', t);
  tokens = readTokens();
}
