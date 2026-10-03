import type { CountryPayload } from './types';
import { fmt, fmtK } from './data';

// Inline-SVG / HTML builders — themed through CSS custom properties, no chart lib.

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Weekly / per-round trend: area + line + markers. The selected period is shaded so it
 *  reads at a glance which weeks the map is showing. */
export function trendSVG(c: CountryPayload, selected: Set<number>): string {
  const W = 300, H = 96, pad = { l: 6, r: 6, t: 12, b: 16 };
  const pts = c.perweek.map((p) => ({ i: p.i, v: p.total }));
  if (pts.length === 0) return '';
  const max = Math.max(1, ...pts.map((p) => p.v));
  const n = pts.length;
  const x = (i: number) => pad.l + (n === 1 ? (W - pad.l - pad.r) / 2 : (i / (n - 1)) * (W - pad.l - pad.r));
  const y = (v: number) => pad.t + (1 - v / max) * (H - pad.t - pad.b);
  const step = n > 1 ? (W - pad.l - pad.r) / (n - 1) : 20;

  const line = pts.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(pts[n - 1].i).toFixed(1)} ${(H - pad.b).toFixed(1)} L${x(pts[0].i).toFixed(1)} ${(H - pad.b).toFixed(1)} Z`;

  const sel = pts.filter((p) => selected.has(p.i));
  const band = sel.length && sel.length < n
    ? `<rect class="tr-band" x="${(x(sel[0].i) - step / 2).toFixed(1)}" y="${pad.t - 6}" width="${(x(sel[sel.length - 1].i) - x(sel[0].i) + step).toFixed(1)}" height="${H - pad.b - pad.t + 6}" rx="4"/>`
    : '';
  const peak = pts.reduce((a, b) => (b.v > a.v ? b : a));

  const marks = pts.map((p) => {
    const on = selected.has(p.i);
    return `<circle cx="${x(p.i).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="${on ? 2.6 : 1.6}"
      class="${on ? 'tr-dot on' : 'tr-dot'}"><title>${esc(c.weeks[p.i]?.label ?? '')}: ${fmt(p.v)}</title></circle>`;
  }).join('');

  const first = esc(c.weeks[0]?.label?.split('–')[0] ?? '');
  const last = esc(c.weeks[n - 1]?.label ?? '');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="none" role="img" aria-label="Trend">
    ${band}
    <path d="${area}" class="tr-area"/>
    <path d="${line}" class="tr-line"/>
    ${marks}
    <text x="${x(peak.i).toFixed(1)}" y="${(y(peak.v) - 4).toFixed(1)}" class="tr-peak" text-anchor="${peak.i > n * 0.7 ? 'end' : peak.i < n * 0.3 ? 'start' : 'middle'}">peak ${fmtK(peak.v)}</text>
    <text x="${pad.l}" y="${H - 3}" class="tr-axis">${first}</text>
    <text x="${W - pad.r}" y="${H - 3}" class="tr-axis" text-anchor="end">${last}</text>
  </svg>`;
}

/** Ranked list of top areas by value. Rows carry data-pc so main.ts can link hover →
 *  map highlight and click → drill. */
export function barsHTML(items: { pc: string; name: string; value: number; drill: boolean }[], mult = 1): string {
  const top = items.filter((d) => d.value > 0).sort((a, b) => b.value - a.value).slice(0, 8);
  if (top.length === 0) return `<p class="empty">No movement in this selection.</p>`;
  const max = Math.max(1, ...top.map((d) => d.value));
  return top.map((d) => {
    const w = Math.max(2, (d.value / max) * 100);
    const ppl = mult > 1 ? `<span class="br-ppl">~${fmtK(d.value * mult)} ppl</span>` : '';
    return `<div class="br-row${d.drill ? ' drill' : ''}" data-pc="${esc(d.pc)}" ${d.drill ? 'role="button" tabindex="0"' : ''} title="${esc(d.name)}: ${fmt(d.value)}">
      <span class="br-name">${esc(clip(d.name, 18))}</span>
      <span class="br-track"><i style="width:${w.toFixed(1)}%"></i></span>
      <span class="br-val">${fmtK(d.value)}${ppl}</span>
    </div>`;
  }).join('');
}
