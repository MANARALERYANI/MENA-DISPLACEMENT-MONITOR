// Data shapes written by scripts/refresh_dtm.py → data/data.json.
// Kept in sync with DESIGN.md §5. Two metric types share one payload; Yemen (flow)
// adds district drill-down fields.

export type MetricType = 'flow' | 'stock';

export interface Week { i: number; start: string; end: string; label: string; }
export interface GovInfo { name: string; lat: number | null; lon: number | null; }
export interface Flow { o: string; d: string; hh: number; }              // origin/dest gov pcode
export interface DFlow { og: string; od: string; dg: string; dd: string; hh: number; } // district flow
export interface DCent { name: string; lat: number; lon: number; g: string; }

export interface PerWeek {
  i: number;
  total: number;
  dest: Record<string, number>;       // gov pcode → value
  flows: Flow[];
  reasons: Record<string, number>;
  dflows?: DFlow[];                    // Yemen only
}

export interface GeoFeature {
  type: 'Feature';
  properties: { pc: string; name: string };
  geometry: any;                       // Polygon | MultiPolygon
}
export interface FeatureCollection { type: 'FeatureCollection'; features: GeoFeature[]; }

export interface CountryPayload {
  country: string;
  label?: string;                      // dataset label (selector + title); e.g. "West Coast Escalation"
  subtitle?: string;                   // one-line description under the title
  iso: string;
  metric_type: MetricType;
  unit: string;                        // "households" | "individuals"
  hh_to_people: number;                // multiplier for indicative people (Yemen=6, stock=1)
  weeks: Week[];
  perweek: PerWeek[];
  gov: Record<string, GovInfo>;
  geo: FeatureCollection;
  // Yemen-only:
  dcent?: Record<string, DCent>;
  dgeo?: Record<string, FeatureCollection>;
  dbbox?: Record<string, [number, number, number, number]>;
  total_all?: number;
  total_latest?: number;
  operation?: string;
}

export interface AppData {
  generated: string;
  countries: Record<string, CountryPayload>;   // keyed by dataset label
  pending: string[];
  default?: string;                             // label of the dataset to show first
}

// ---- aggregated view models (output of aggGov / aggDist) ----
export interface Arc { oPc: string; dPc: string; o: [number, number]; d: [number, number]; v: number; }
export interface Loop { oPc: string; pos: [number, number]; v: number; }
export interface AggGov {
  dest: Record<string, number>;        // gov pcode → value
  flows: Arc[];                        // gov→gov, excludes self-loops
  intern: Record<string, number>;      // gov pcode → within-area (self-loop) value
  reasons: Record<string, number>;
  total: number;
}
export interface AggDist {
  dest: Record<string, number>;        // district pcode → value
  intern: Arc[];                       // district→district within the gov
  internBubble: Record<string, number>; // district self-loop
  inflow: Arc[];                       // external gov → this gov (aggregated)
  total: number;
}
