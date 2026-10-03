import type {
  AppData, CountryPayload, AggGov, AggDist, Arc,
} from './types';

// ------------------------------- load ---------------------------------------
export async function loadData(): Promise<AppData> {
  const url = import.meta.env.BASE_URL + 'data/data.json';
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to load ${url}: ${r.status}`);
  return r.json();
}

// ----------------------------- formatting -----------------------------------
export const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
export const fmtK = (n: number) => {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + 'M';
  if (n >= 10_000) return Math.round(n / 1000) + 'k';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(Math.round(n));
};

// ------------------------- selected-week helpers ---------------------------
// Flow: period 0 = cumulative (all weeks), 1..N = last N weeks.
// Stock: `period` is treated as a single round index (handled by caller passing [idx]).
export function selectedWeekIdxs(c: CountryPayload, period: number): number[] {
  const n = c.weeks.length;
  if (c.metric_type === 'stock') {
    const idx = period < 0 || period >= n ? n - 1 : period; // default latest
    return [idx];
  }
  if (period <= 0) return c.weeks.map((w) => w.i);          // cumulative
  return c.weeks.slice(Math.max(0, n - period)).map((w) => w.i);
}

// --------------------------- gov aggregation -------------------------------
export function aggGov(c: CountryPayload, idxs: number[]): AggGov {
  const dest: Record<string, number> = {};
  const intern: Record<string, number> = {};
  const reasons: Record<string, number> = {};
  const flowMap = new Map<string, number>();
  let total = 0;

  for (const i of idxs) {
    const pw = c.perweek[i];
    if (!pw) continue;
    total += pw.total;
    for (const [pc, v] of Object.entries(pw.dest)) dest[pc] = (dest[pc] || 0) + v;
    for (const [k, v] of Object.entries(pw.reasons)) reasons[k] = (reasons[k] || 0) + v;
    for (const f of pw.flows) {
      if (f.o === f.d) { intern[f.d] = (intern[f.d] || 0) + f.hh; continue; }
      const key = f.o + '\u0001' + f.d;
      flowMap.set(key, (flowMap.get(key) || 0) + f.hh);
    }
  }

  const flows: Arc[] = [];
  for (const [key, v] of flowMap) {
    const [o, d] = key.split('\u0001');
    const go = c.gov[o], gd = c.gov[d];
    if (!go?.lon || !gd?.lon) continue;
    flows.push({ oPc: o, dPc: d, o: [go.lon, go.lat!], d: [gd.lon, gd.lat!], v });
  }
  flows.sort((a, b) => b.v - a.v);
  return { dest, flows, intern, reasons, total };
}

// ------------------------- district aggregation ----------------------------
export function aggDist(c: CountryPayload, idxs: number[], G: string): AggDist {
  const dest: Record<string, number> = {};
  const internBubble: Record<string, number> = {};
  const internMap = new Map<string, number>();
  const inflowMap = new Map<string, number>();  // source gov → sum
  let total = 0;
  const cent = c.dcent || {};
  const gov = c.gov;

  for (const i of idxs) {
    const pw = c.perweek[i];
    if (!pw?.dflows) continue;
    for (const f of pw.dflows) {
      if (f.dg === G) {
        dest[f.dd] = (dest[f.dd] || 0) + f.hh;
        total += f.hh;
        if (f.og === G) {
          if (f.od === f.dd) internBubble[f.dd] = (internBubble[f.dd] || 0) + f.hh;
          else internMap.set(f.od + '\u0001' + f.dd, (internMap.get(f.od + '\u0001' + f.dd) || 0) + f.hh);
        } else {
          inflowMap.set(f.og, (inflowMap.get(f.og) || 0) + f.hh);
        }
      }
    }
  }

  const intern: Arc[] = [];
  for (const [key, v] of internMap) {
    const [od, dd] = key.split('\u0001');
    const a = cent[od], b = cent[dd];
    if (!a || !b) continue;
    intern.push({ oPc: od, dPc: dd, o: [a.lon, a.lat], d: [b.lon, b.lat], v });
  }
  intern.sort((a, b) => b.v - a.v);

  const inflow: Arc[] = [];
  const gc = gov[G];
  for (const [og, v] of inflowMap) {
    const src = gov[og];
    if (!src?.lon || !gc?.lon) continue;
    inflow.push({ oPc: og, dPc: G, o: [src.lon, src.lat!], d: [gc.lon, gc.lat!], v });
  }
  inflow.sort((a, b) => b.v - a.v);
  return { dest, intern, internBubble, inflow, total };
}

// ------------------------------- color -------------------------------------
export type RGB = [number, number, number];
const hex2rgb = (h: string): RGB => {
  const s = h.trim().replace('#', '');
  const f = s.length === 3 ? s.split('').map((x) => x + x).join('') : s;
  return [parseInt(f.slice(0, 2), 16), parseInt(f.slice(2, 4), 16), parseInt(f.slice(4, 6), 16)];
};

// Read the live theme tokens so colors follow light/dark + any rebrand.
export function readTokens() {
  const cs = getComputedStyle(document.documentElement);
  const g = (n: string) => cs.getPropertyValue(n) || '#000';
  const ramp: RGB[] = ['--b1', '--b2', '--b3', '--b4', '--b5', '--b6'].map((v) => hex2rgb(g(v)));
  return {
    ramp,
    accent: hex2rgb(g('--accent')),
    accentD: hex2rgb(g('--accent-d')),
    conflict: hex2rgb(g('--conflict')),
    land: hex2rgb(g('--map-land')),
    stroke: hex2rgb(g('--map-stroke')),
    bg: hex2rgb(g('--map-bg')),
    ink: hex2rgb(g('--ink')),
    ink2: hex2rgb(g('--ink2')),
    mut: hex2rgb(g('--mut')),
    focus: hex2rgb(g('--unicef-cyan')),
    dark: document.documentElement.getAttribute('data-theme') === 'dark',
  };
}
export type Tokens = ReturnType<typeof readTokens>;

// Interpolate the 6-stop ramp on a sqrt scale (compresses the long tail).
export function makeScale(max: number, ramp: RGB[]) {
  const hi = Math.max(1, max);
  return (v: number): RGB => {
    if (v <= 0) return ramp[0];
    const t = Math.sqrt(v / hi);            // 0..1
    const x = Math.min(0.999, Math.max(0, t)) * (ramp.length - 1);
    const i = Math.floor(x), frac = x - i;
    const a = ramp[i], b = ramp[Math.min(ramp.length - 1, i + 1)];
    return [
      Math.round(a[0] + (b[0] - a[0]) * frac),
      Math.round(a[1] + (b[1] - a[1]) * frac),
      Math.round(a[2] + (b[2] - a[2]) * frac),
    ];
  };
}
