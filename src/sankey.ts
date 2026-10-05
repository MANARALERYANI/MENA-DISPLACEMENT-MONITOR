import { fmt, fmtK } from './data';

// Bipartite origin→destination Sankey (from-column left, to-column right). An area can
// appear on both sides — including self-loops (e.g. Taiz→Taiz), which are shown. Ribbons
// and origin nodes are coloured by origin via `colorFn(oPc)`. Link paths carry data-key so
// main.ts can wire hover → highlight the matching map arrow.
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function sankeySVG(
  flows: { oName: string; dName: string; v: number; key: string; oPc: string }[],
  unit: string, mult = 1, colorFn: (oPc: string) => string = () => 'var(--accent)', approx = '~',
): string {
  const top = flows.filter((f) => f.v > 0).sort((a, b) => b.v - a.v).slice(0, 9);
  if (top.length === 0) return `<p class="empty">No area-to-area movement in this selection.</p>`;

  const L = new Map<string, { val: number; oPc: string }>(), R = new Map<string, number>();
  for (const f of top) {
    const l = L.get(f.oName) || { val: 0, oPc: f.oPc }; l.val += f.v; L.set(f.oName, l);
    R.set(f.dName, (R.get(f.dName) || 0) + f.v);
  }
  const total = top.reduce((s, f) => s + f.v, 0);
  const Lnodes = [...L.entries()].sort((a, b) => b[1].val - a[1].val);
  const Rnodes = [...R.entries()].sort((a, b) => b[1] - a[1]);

  const W = 320, nodeW = 10, labelW = 78, padTop = 18, padBot = 8, gap = 9;
  const maxN = Math.max(Lnodes.length, Rnodes.length);
  const H = Math.max(220, Math.min(440, maxN * 44));
  const barsH = H - padTop - padBot - (maxN - 1) * gap;
  const scale = barsH / total;
  const xL0 = labelW, xL1 = labelW + nodeW, xR0 = W - labelW - nodeW, xR1 = W - labelW;
  const midX = (xL1 + xR0) / 2;

  type N = { y: number; h: number; off: number };
  const place = (rows: number[]) => {
    const used = rows.reduce((s, v) => s + v * scale, 0) + (rows.length - 1) * gap;
    let y = padTop + ((H - padTop - padBot) - used) / 2;
    return rows.map((v) => { const n: N = { y, h: v * scale, off: 0 }; y += v * scale + gap; return n; });
  };
  const LP = new Map<string, N>(); place(Lnodes.map((n) => n[1].val)).forEach((n, i) => LP.set(Lnodes[i][0], n));
  const RP = new Map<string, N>(); place(Rnodes.map((n) => n[1])).forEach((n, i) => RP.set(Rnodes[i][0], n));

  const links = top.map((f) => {
    const l = LP.get(f.oName)!, r = RP.get(f.dName)!;
    const th = Math.max(1, f.v * scale);
    const y0 = l.y + l.off + th / 2; l.off += f.v * scale;
    const y1 = r.y + r.off + th / 2; r.off += f.v * scale;
    const col = colorFn(f.oPc);
    const ppl = mult > 1 ? ` · ${approx}${fmtK(f.v * mult)} ppl` : '';
    const self = f.oName === f.dName ? ' (within area)' : '';
    return `<path class="sk-link" data-key="${esc(f.key)}" fill="none" stroke="${col}"
      d="M${xL1} ${y0.toFixed(1)} C${midX} ${y0.toFixed(1)} ${midX} ${y1.toFixed(1)} ${xR0} ${y1.toFixed(1)}"
      stroke-width="${th.toFixed(1)}"><title>${esc(f.oName)} → ${esc(f.dName)}${self}: ${fmt(f.v)} ${esc(unit)}${ppl}</title></path>`;
  }).join('');

  const leftNodes = Lnodes.map(([name, meta]) => {
    const n = LP.get(name)!;
    return `<rect class="sk-node" x="${xL0}" y="${n.y.toFixed(1)}" width="${nodeW}" height="${Math.max(1, n.h).toFixed(1)}" rx="2" fill="${colorFn(meta.oPc)}"/>`
      + `<text class="sk-lab" x="${xL0 - 5}" y="${(n.y + n.h / 2).toFixed(1)}" text-anchor="end" dominant-baseline="middle">${esc(clip(name, 11))}</text>`;
  }).join('');
  const rightNodes = Rnodes.map(([name]) => {
    const n = RP.get(name)!;
    return `<rect class="sk-node sk-node-dest" x="${xR0}" y="${n.y.toFixed(1)}" width="${nodeW}" height="${Math.max(1, n.h).toFixed(1)}" rx="2"/>`
      + `<text class="sk-lab" x="${xR1 + 5}" y="${(n.y + n.h / 2).toFixed(1)}" text-anchor="start" dominant-baseline="middle">${esc(clip(name, 11))}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Origin to destination flows" style="overflow:visible">
    <text class="sk-cap" x="${xL0}" y="9" text-anchor="start">FROM</text>
    <text class="sk-cap" x="${xR1}" y="9" text-anchor="end">TO</text>
    <g class="sk-links">${links}</g>
    ${leftNodes}${rightNodes}
  </svg>`;
}
