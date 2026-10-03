// Screen-space flow arrows, drawn on a 2D canvas that sits over the deck.gl map.
//
// Why screen space: the arrows are rebuilt every frame from the *projected* origin and
// destination, so their curvature, head size and stroke width are defined in pixels and
// look identical at every zoom level. The arrowhead is part of the same outline as the
// body, so it always follows the curve's tangent (it can never "detach" or point off
// at an angle the way a separate billboard icon on a 3D arc does).
//
// The 3D look comes from four cheap passes per arrow:
//   1. a soft ground shadow along a *flatter* curve between the same two points — the
//      ends touch the ground, the middle lifts off, which reads as height;
//   2. the body: a tapered ribbon with a tail→head colour gradient;
//   3. a glossy highlight strip offset toward the light (screen-up), and a faint core
//      shade on the opposite side, which make the ribbon read as a rounded tube;
//   4. a crisp darker rim.
import type { RGB, Tokens } from './data';

type Pt = [number, number];
export interface ArrowSpec { key: string; o: Pt; d: Pt; v: number; color: RGB; secondary?: boolean; }
export interface LoopSpec { key: string; pos: Pt; v: number; color: RGB; }
export interface LabelSpec { text: string; sub?: string; pos: Pt; rank: number; cls: 'big' | 'norm' | 'faint' | 'ctx' | 'sel'; }
export type Emph = 'on' | 'dim' | 'norm';

export interface Scene {
  arrows: ArrowSpec[];
  loops: LoopSpec[];
  maxV: number;              // value that maps to the widest arrow
  maxLoop: number;
  labels: LabelSpec[];
  emph: (key: string) => Emph;
  zoomK: number;             // gentle growth with zoom (1 at the level's home view)
  tokens: Tokens;
  animate: boolean;
}

export interface Projector { project(lngLat: number[]): number[]; }

// ------------------------------- sizing -------------------------------------
// Shared with the legend so the swatches match the map exactly.
export const ARROW_W = { min: 2.2, max: 14 };
export function arrowWidth(v: number, maxV: number, k = 1) {
  return (ARROW_W.min + (ARROW_W.max - ARROW_W.min) * Math.sqrt(Math.max(0, v) / Math.max(1, maxV))) * k;
}
const BEND = 0.2;            // peak offset of the curve as a fraction of its length
// The shadow follows a flatter curve between the same end points; the gap at mid-span is
// the arrow's apparent height. Cap it in pixels so a long arrow (or a deep zoom) never
// throws its shadow far away from itself.
const MAX_LIFT = 10;
const shadowBend = (L: number, k: number) => BEND - Math.min(BEND * 0.75, (MAX_LIFT * Math.min(1.5, k)) / Math.max(1, L));

// ------------------------------ geometry ------------------------------------
interface Poly { pts: Pt[]; cum: number[]; len: number; }
function poly(pts: Pt[]): Poly {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return { pts, cum, len: cum[cum.length - 1] };
}
// Control point of the curved route between two screen points.
function ctrl(p0: Pt, p1: Pt, bend: number): Pt {
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
  return [(p0[0] + p1[0]) / 2 - dy * bend * 2, (p0[1] + p1[1]) / 2 + dx * bend * 2];
}
function quad(p0: Pt, p1: Pt, bend: number): Poly {
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
  // Sample density follows on-screen length, so long arcs stay smooth at deep zoom.
  const n = Math.max(48, Math.min(1600, Math.round(Math.hypot(dx, dy) / 6)));
  // Right-hand normal of travel: A→B and B→A bow to opposite sides and never overlap.
  const cx = (p0[0] + p1[0]) / 2 - dy * bend * 2, cy = (p0[1] + p1[1]) / 2 + dx * bend * 2;
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, c = t * t;
    pts.push([a * p0[0] + b * cx + c * p1[0], a * p0[1] + b * cy + c * p1[1]]);
  }
  return poly(pts);
}
function circleArc(c: Pt, r: number, a0: number, a1: number, n = 64): Poly {
  const pts: Pt[] = [];
  for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * (i / n); pts.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]); }
  return poly(pts);
}
// Position + unit tangent at arc length s.
function at(P: Poly, s: number): { x: number; y: number; tx: number; ty: number } {
  const { pts, cum } = P;
  s = Math.max(0, Math.min(P.len, s));
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
  const seg = cum[hi] - cum[lo] || 1, f = (s - cum[lo]) / seg;
  const a = pts[lo], b = pts[hi];
  const tx = b[0] - a[0], ty = b[1] - a[1], tl = Math.hypot(tx, ty) || 1;
  return { x: a[0] + tx * f, y: a[1] + ty * f, tx: tx / tl, ty: ty / tl };
}

interface Shape {
  outline: Path2D;
  c: Pt[]; n: Pt[]; hw: number[];      // body centre line, left normals, half widths
  tail: Pt; tip: Pt; base: Pt; dir: Pt; headW: number; headL: number;
}

// Build a tapered arrow (round tail, swept head) along P between s0 and sTip.
function shape(P: Poly, s0: number, sTip: number, w: number, headW: number, headL: number): Shape | null {
  const usable = sTip - s0;
  if (usable < 4) return null;
  // Short arrows: shrink the head (and body) so it never swallows the arrow.
  const cap = usable * 0.5;
  if (headL > cap) { const f = cap / headL; headL *= f; headW *= f; w = Math.min(w, headW * 0.62); }
  const s1 = sTip - headL;                      // head base
  const tipP = at(P, sTip), baseP = at(P, s1);
  let dx = tipP.x - baseP.x, dy = tipP.y - baseP.y; const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
  const hn: Pt = [-dy, dx];

  const N = Math.max(8, Math.min(700, Math.round((s1 - s0) / 4)));
  const c: Pt[] = [], n: Pt[] = [], hw: number[] = [];
  for (let i = 0; i <= N; i++) {
    const u = i / N, p = at(P, s0 + (s1 - s0) * u);
    c.push([p.x, p.y]);
    n.push(i === N ? hn : [-p.ty, p.tx]);
    const e = 1 - (1 - u) * (1 - u);             // fast growth from a slim tail
    hw.push((w / 2) * (0.3 + 0.7 * e));
  }
  const back = headL * 0.14;                     // swept-back barbs
  const wingL: Pt = [baseP.x + hn[0] * headW / 2 - dx * back, baseP.y + hn[1] * headW / 2 - dy * back];
  const wingR: Pt = [baseP.x - hn[0] * headW / 2 - dx * back, baseP.y - hn[1] * headW / 2 - dy * back];

  const o = new Path2D();
  o.moveTo(c[0][0] + n[0][0] * hw[0], c[0][1] + n[0][1] * hw[0]);
  for (let i = 1; i <= N; i++) o.lineTo(c[i][0] + n[i][0] * hw[i], c[i][1] + n[i][1] * hw[i]);
  o.lineTo(wingL[0], wingL[1]);
  o.lineTo(tipP.x, tipP.y);
  o.lineTo(wingR[0], wingR[1]);
  for (let i = N; i >= 0; i--) o.lineTo(c[i][0] - n[i][0] * hw[i], c[i][1] - n[i][1] * hw[i]);
  // round tail cap
  const a0 = Math.atan2(-n[0][1], -n[0][0]);
  o.arc(c[0][0], c[0][1], hw[0], a0, a0 + Math.PI, false);
  o.closePath();
  return { outline: o, c, n, hw, tail: c[0], tip: [tipP.x, tipP.y], base: [baseP.x, baseP.y], dir: [dx, dy], headW, headL };
}

// A ribbon along the body, offset toward screen-up (sign = +1) or screen-down (-1).
function sideStrip(S: Shape, sign: number, offF: number, widthF: number, from = 0.06, to = 0.97): Path2D {
  const { c, n, hw } = S, N = c.length - 1;
  const i0 = Math.round(N * from), i1 = Math.round(N * to);
  const L: Pt[] = [], R: Pt[] = [];
  for (let i = i0; i <= i1; i++) {
    // Choose the normal side facing the light; weight by how much it faces it so the
    // strip glides smoothly to the centre where the tube runs vertically.
    const up = -n[i][1];
    const off = sign * up * hw[i] * offF;
    const cx = c[i][0] + n[i][0] * off, cy = c[i][1] + n[i][1] * off;
    const h = hw[i] * widthF;
    L.push([cx + n[i][0] * h, cy + n[i][1] * h]);
    R.push([cx - n[i][0] * h, cy - n[i][1] * h]);
  }
  const p = new Path2D();
  L.forEach((q, k) => (k ? p.lineTo(q[0], q[1]) : p.moveTo(q[0], q[1])));
  for (let k = R.length - 1; k >= 0; k--) p.lineTo(R[k][0], R[k][1]);
  p.closePath();
  return p;
}

// ------------------------------- colour -------------------------------------
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const css = (c: RGB, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const WHITE: RGB = [255, 255, 255], BLACK: RGB = [0, 0, 0];

// --------------------------------- overlay ----------------------------------
interface Hit { key: string; path: Path2D; }

export class FlowOverlay {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private w = 0; private h = 0;
  private hits: Hit[] = [];

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  resize(w: number, h: number) {
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    this.w = w; this.h = h; this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
  }

  /** Topmost arrow under (x, y) in CSS pixels, with a few px of tolerance. */
  hit(x: number, y: number): string | null {
    const { ctx, dpr } = this;
    ctx.save(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.lineWidth = 7;
    let found: string | null = null;
    for (let i = this.hits.length - 1; i >= 0 && !found; i--) {
      const { key, path } = this.hits[i];
      if (ctx.isPointInPath(path, x * dpr, y * dpr) || ctx.isPointInStroke(path, x * dpr, y * dpr)) found = key;
    }
    ctx.restore();
    return found;
  }

  draw(vp: Projector, S: Scene, t: number) {
    const { ctx, dpr, w, h } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    this.hits = [];
    const k = S.zoomK, tk = S.tokens;
    const proj = (p: Pt): Pt => { const q = vp.project(p); return [q[0], q[1]]; };

    // ---- build shapes (largest first so smaller flows sit on top and stay visible) ----
    type Item = { key: string; S: Shape; shadow: Shape | null; lift: number; color: RGB; e: Emph; loop?: boolean; soft?: boolean };
    const items: Item[] = [];
    const margin = 400;
    // A quadratic curve lies inside the triangle of its end and control points, so test
    // that hull — an arrow whose ends are both off-screen can still cross the view.
    const onScreen = (a: Pt, b: Pt, c: Pt) =>
      !(Math.max(a[0], b[0], c[0]) < -margin || Math.min(a[0], b[0], c[0]) > w + margin
        || Math.max(a[1], b[1], c[1]) < -margin || Math.min(a[1], b[1], c[1]) > h + margin);

    const dotR = 3.2 * Math.min(1.4, k);
    const origins = new Map<string, { p: Pt; color: RGB; e: Emph }>();
    for (const a of [...S.arrows].sort((x, y) => y.v - x.v)) {
      const p0 = proj(a.o), p1 = proj(a.d);
      if (!onScreen(p0, p1, ctrl(p0, p1, BEND))) continue;
      const L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      if (L < 10) continue;
      const wv = Math.min(arrowWidth(a.v, S.maxV, k) * (a.secondary ? 0.6 : 1), L * 0.16);
      const headW = Math.max(wv * 2.15 + 3, 9 * Math.min(1.3, k));
      const headL = headW * 0.95;
      const P = quad(p0, p1, BEND);
      const s0 = dotR + 2, sTip = P.len - Math.max(3, dotR);
      const sh = shape(P, s0, sTip, wv, headW, headL);
      if (!sh) continue;
      const sb = shadowBend(L, k), lift = (BEND - sb) * L;
      const Ps = quad(p0, p1, sb);
      const shadow = shape(Ps, s0, Ps.len - Math.max(3, dotR), wv, headW, headL);
      const e = S.emph(a.key);
      items.push({ key: a.key, S: sh, shadow, lift, color: a.secondary ? mix(a.color, WHITE, 0.25) : a.color, e, soft: a.secondary });
      const ok = a.o.join(',');
      const prev = origins.get(ok);
      if (!prev || e === 'on' || (prev.e === 'dim' && e !== 'dim')) origins.set(ok, { p: p0, color: a.color, e });
    }
    for (const l of [...S.loops].sort((x, y) => y.v - x.v)) {
      const c = proj(l.pos);
      if (c[0] < -60 || c[1] < -60 || c[0] > w + 60 || c[1] > h + 60) continue;
      const f = Math.sqrt(l.v / Math.max(1, S.maxLoop));
      const R = (11 + f * 15) * Math.min(1.6, k);
      const wv = Math.min(arrowWidth(l.v, Math.max(S.maxLoop, S.maxV), k) * 0.85, R * 0.55);
      const headW = Math.max(wv * 2.1 + 3, 8);
      // Start lower-left, run clockwise over the top, head lands on the right side.
      const P = circleArc(c, R, Math.PI * 0.82, Math.PI * 2.32);
      const sh = shape(P, 0, P.len, wv, headW, headW * 0.95);
      if (!sh) continue;
      const Ps = circleArc([c[0] + 1.2, c[1] + 2.4], R, Math.PI * 0.82, Math.PI * 2.32);
      items.push({ key: l.key, S: sh, shadow: shape(Ps, 0, Ps.len, wv, headW, headW * 0.95), lift: 2, color: l.color, e: S.emph(l.key), loop: true });
    }

    const alphaOf = (e: Emph) => (e === 'dim' ? 0.14 : 1);

    // ---- pass 1: ground shadows (all of them, so no arrow casts onto another) ----
    // The higher an arrow floats, the softer and fainter its shadow — like a real one.
    const base: RGB = tk.dark ? BLACK : [16, 40, 56];
    const baseA = tk.dark ? 0.55 : 0.28;
    const FAR = 20000;
    ctx.save();
    ctx.translate(-FAR, 0);
    ctx.fillStyle = '#000';
    for (const it of items) {
      if (!it.shadow || it.e === 'dim') continue;
      ctx.shadowColor = css(base, baseA / (1 + it.lift / 14));
      ctx.shadowBlur = (3 + it.lift * 0.55) * dpr;
      ctx.shadowOffsetX = FAR * dpr + 1.5 * dpr; ctx.shadowOffsetY = 3 * dpr;
      ctx.fill(it.shadow.outline);
    }
    ctx.restore();

    // ---- pass 2: arrows ----
    for (const it of items) {
      const { S: sh, color } = it;
      ctx.save();
      ctx.globalAlpha = alphaOf(it.e) * (it.soft && it.e !== 'on' ? 0.8 : 1);

      // glow for the focused arrow
      if (it.e === 'on') {
        ctx.save();
        ctx.shadowColor = css(color, 0.75); ctx.shadowBlur = 16 * dpr;
        ctx.fillStyle = css(color, 1); ctx.fill(sh.outline);
        ctx.restore();
      }

      // body gradient: lighter, slightly translucent tail → saturated head
      const g = ctx.createLinearGradient(sh.tail[0], sh.tail[1], sh.tip[0], sh.tip[1]);
      g.addColorStop(0, css(mix(color, WHITE, 0.42), 0.82));
      g.addColorStop(0.55, css(color, 0.97));
      g.addColorStop(1, css(mix(color, BLACK, 0.12), 1));
      ctx.fillStyle = g;
      ctx.fill(sh.outline);

      // tube shading: core shade (away from light) then gloss (toward light)
      ctx.fillStyle = css(mix(color, BLACK, 0.45), 0.22);
      ctx.fill(sideStrip(sh, -1, 0.42, 0.34));
      ctx.fillStyle = css(WHITE, tk.dark ? 0.32 : 0.42);
      ctx.fill(sideStrip(sh, 1, 0.38, 0.26));

      // head facet: light the upper half so the head reads as a raised wedge
      const [bx, by] = sh.base, [dx, dy] = sh.dir, hn: Pt = [-dy, dx];
      const up = hn[1] < 0 ? 1 : -1;
      const wing: Pt = [bx + hn[0] * up * sh.headW / 2 - dx * sh.headL * 0.14, by + hn[1] * up * sh.headW / 2 - dy * sh.headL * 0.14];
      const facet = new Path2D();
      facet.moveTo(sh.tip[0], sh.tip[1]); facet.lineTo(wing[0], wing[1]); facet.lineTo(bx - dx * sh.headL * 0.05, by - dy * sh.headL * 0.05); facet.closePath();
      ctx.fillStyle = css(WHITE, tk.dark ? 0.16 : 0.22);
      ctx.fill(facet);

      // crisp rim
      ctx.lineWidth = 0.9;
      ctx.strokeStyle = css(mix(color, BLACK, 0.38), tk.dark ? 0.7 : 0.55);
      ctx.stroke(sh.outline);

      // travelling light pulses (direction cue)
      if (S.animate && it.e !== 'dim') this.pulses(sh, t, k);

      ctx.restore();
      this.hits.push({ key: it.key, path: sh.outline });
    }

    // ---- origin dots ----
    for (const { p, color, e } of origins.values()) {
      ctx.save();
      ctx.globalAlpha = alphaOf(e);
      ctx.beginPath(); ctx.arc(p[0], p[1], dotR, 0, Math.PI * 2);
      ctx.fillStyle = css(color); ctx.fill();
      ctx.lineWidth = 1.6; ctx.strokeStyle = tk.dark ? css(tk.bg) : '#fff'; ctx.stroke();
      ctx.restore();
    }

    // ---- labels (on top, de-collided) ----
    this.labels(vp, S);
  }

  private pulses(sh: Shape, t: number, k: number) {
    const { ctx } = this;
    const { c, hw } = sh, N = c.length - 1;
    // arc length along body samples
    const cum = [0];
    for (let i = 1; i <= N; i++) cum.push(cum[i - 1] + Math.hypot(c[i][0] - c[i - 1][0], c[i][1] - c[i - 1][1]));
    const len = cum[N];
    if (len < 24) return;
    const spacing = Math.max(46, 70 * Math.min(1.4, k)), speed = 42;
    const phase = ((t / 1000) * speed) % spacing;
    let i = 1;                                   // pulses advance monotonically: one pass
    for (let s = phase; s < len; s += spacing) {
      while (i < N && cum[i] < s) i++;
      const f = (s - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
      const x = c[i - 1][0] + (c[i][0] - c[i - 1][0]) * f, y = c[i - 1][1] + (c[i][1] - c[i - 1][1]) * f;
      if (x < -30 || y < -30 || x > this.w + 30 || y > this.h + 30) continue;
      const r = Math.max(1.1, (hw[i - 1] + (hw[i] - hw[i - 1]) * f) * 0.62);
      const u = s / len, fade = Math.min(1, u / 0.12, (1 - u) / 0.12);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r * 1.8);
      g.addColorStop(0, `rgba(255,255,255,${0.75 * fade})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, r * 1.8, 0, Math.PI * 2); ctx.fill();
    }
  }

  private labels(vp: Projector, S: Scene) {
    const { ctx, w, h } = this;
    const tk = S.tokens;
    const halo = css(tk.bg, 0.92);
    const style: Record<LabelSpec['cls'], { font: string; color: string; sub?: string }> = {
      sel: { font: '700 13px Roboto, system-ui, sans-serif', color: css(tk.ink) },
      big: { font: '700 12.5px Roboto, system-ui, sans-serif', color: css(tk.ink) },
      norm: { font: '600 11px Roboto, system-ui, sans-serif', color: css(tk.ink) },
      faint: { font: '500 10.5px Roboto, system-ui, sans-serif', color: css(tk.mut, 0.85) },
      ctx: { font: '600 10.5px Roboto, system-ui, sans-serif', color: css(tk.ink2, 0.62) },
    };
    const placed: [number, number, number, number][] = [];
    const items = S.labels
      .map((l) => ({ l, p: vp.project(l.pos) }))
      .filter(({ p }) => p[0] > -60 && p[1] > -20 && p[0] < w + 60 && p[1] < h + 20)
      .sort((a, b) => b.l.rank - a.l.rank);
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (const { l, p } of items) {
      const st = style[l.cls];
      ctx.font = st.font;
      const tw = ctx.measureText(l.text).width;
      let sw = 0;
      if (l.sub) { ctx.font = '600 10px Roboto, system-ui, sans-serif'; sw = ctx.measureText(l.sub).width; ctx.font = st.font; }
      const bw = Math.max(tw, sw) + 6, bh = l.sub ? 28 : 15;
      const box: [number, number, number, number] = [p[0] - bw / 2, p[1] - 8, p[0] + bw / 2, p[1] - 8 + bh];
      if (placed.some((q) => box[0] < q[2] && box[2] > q[0] && box[1] < q[3] && box[3] > q[1])) continue;
      placed.push(box);
      ctx.lineWidth = 3.4; ctx.strokeStyle = halo;
      ctx.strokeText(l.text, p[0], p[1]);
      ctx.fillStyle = st.color;
      ctx.fillText(l.text, p[0], p[1]);
      if (l.sub) {
        ctx.font = '600 10px Roboto, system-ui, sans-serif';
        ctx.strokeText(l.sub, p[0], p[1] + 12.5);
        ctx.fillStyle = css(tk.ink2, 0.95);
        ctx.fillText(l.sub, p[0], p[1] + 12.5);
      }
    }
    ctx.restore();
  }
}

/** Small standalone arrow for the legend, drawn with the same geometry and shading. */
export function legendArrowSVG(width: number, color = 'var(--legend-arrow)', len = 46): string {
  const hw = width / 2, headW = Math.max(width * 2.15 + 3, 9), headL = headW * 0.95;
  const y = 12 + Math.max(0, headW / 2 - 6), x0 = 3 + hw * 0.3, x1 = len - headL;
  const tail = hw * 0.3;
  const d = `M${x0} ${y - tail} C${x0 + (x1 - x0) * 0.35} ${y - hw * 0.8} ${x0 + (x1 - x0) * 0.6} ${y - hw} ${x1} ${y - hw}
    L${x1 - headL * 0.14} ${y - headW / 2} L${len} ${y} L${x1 - headL * 0.14} ${y + headW / 2} L${x1} ${y + hw}
    C${x0 + (x1 - x0) * 0.6} ${y + hw} ${x0 + (x1 - x0) * 0.35} ${y + hw * 0.8} ${x0} ${y + tail}
    A${tail} ${tail} 0 0 1 ${x0} ${y - tail} Z`;
  const H = y * 2;
  return `<svg width="${len + 2}" height="${H}" viewBox="0 0 ${len + 2} ${H}" aria-hidden="true">
    <path d="${d}" fill="${color}" stroke="rgba(0,0,0,.25)" stroke-width=".8"/>
    <path d="M${x0 + 4} ${y - hw * 0.35} L${x1 - 1} ${y - hw * 0.45}" stroke="rgba(255,255,255,.5)" stroke-width="${Math.max(0.8, hw * 0.45)}" stroke-linecap="round" fill="none"/>
  </svg>`;
}
