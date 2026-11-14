// AI-assisted code: written with Claude (Anthropic), reviewed by the team.
//
// Result panel: totals, warnings, and elevation / slope profiles along the
// route. Charts are plain SVG drawn here (no chart library). Every threshold
// comes from mobilite_parametreleri.json.

import type { Traverser } from './data';
import type { RouteSuccess } from './route-types';

const SVG_NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, text?: string): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}

export function formatDuration(seconds: number): string {
  const totalMinutes = Math.round(seconds / 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

/**
 * Slope from which the route counts as "close to the limit": the optional
 * "uyari_egim_derece" field, otherwise the highest speed-table breakpoint that
 * is still below the limit. Null when the file gives nothing to derive it from.
 */
export function nearLimitSlope(t: Traverser): number | null {
  if (typeof t.uyari_egim_derece === 'number' && Number.isFinite(t.uyari_egim_derece)) return t.uyari_egim_derece;
  const below = t.hiz_tablosu.map((entry) => entry.egim_derece).filter((deg) => deg < t.azami_egim_derece);
  return below.length > 0 ? Math.max(...below) : null;
}

// ------------------------------------------------------------ chart

interface ChartSpec {
  title: string;
  unit: string;
  xs: Float32Array;
  ys: Float32Array;
  total: number;
  /** Horizontal reference lines, e.g. the slope limit. */
  refs?: { y: number; label: string; className: string }[];
  /** Distances of the science stops along the route. */
  stops: number[];
  /** [from, to] distance spans with no data. */
  gaps: [number, number][];
  includeZero?: boolean;
}

const VIEW_W = 300;
const VIEW_H = 124;
const M = { left: 40, right: 8, top: 20, bottom: 18 };

function drawChart(spec: ChartSpec): SVGSVGElement {
  const root = svg('svg', { viewBox: `0 0 ${VIEW_W} ${VIEW_H}`, class: 'chart', role: 'img', 'aria-label': `${spec.title} along the route` });
  const plotW = VIEW_W - M.left - M.right;
  const plotH = VIEW_H - M.top - M.bottom;

  let lo = Infinity;
  let hi = -Infinity;
  for (const y of spec.ys) {
    if (Number.isNaN(y)) continue;
    lo = Math.min(lo, y);
    hi = Math.max(hi, y);
  }
  for (const ref of spec.refs ?? []) hi = Math.max(hi, ref.y);
  if (spec.includeZero) lo = Math.min(lo, 0);
  if (!Number.isFinite(lo)) {
    lo = 0;
    hi = 1;
  }
  if (hi - lo < 1e-6) hi = lo + 1;

  const px = (x: number) => M.left + (spec.total > 0 ? (x / spec.total) * plotW : 0);
  const py = (y: number) => M.top + (1 - (y - lo) / (hi - lo)) * plotH;

  root.append(svg('text', { x: M.left, y: 12, class: 'chart-title' }, `${spec.title} (${spec.unit})`));
  root.append(svg('rect', { x: M.left, y: M.top, width: plotW, height: plotH, class: 'chart-frame' }));

  for (const [from, to] of spec.gaps) {
    root.append(svg('rect', { x: px(from), y: M.top, width: Math.max(1.5, px(to) - px(from)), height: plotH, class: 'chart-nodata' }));
  }
  for (const stop of spec.stops) {
    root.append(svg('line', { x1: px(stop), x2: px(stop), y1: M.top, y2: M.top + plotH, class: 'chart-stop' }));
  }
  for (const ref of spec.refs ?? []) {
    root.append(svg('line', { x1: M.left, x2: M.left + plotW, y1: py(ref.y), y2: py(ref.y), class: `chart-ref ${ref.className}` }));
    root.append(svg('text', { x: M.left + plotW - 2, y: py(ref.y) - 2, class: `chart-ref-label ${ref.className}`, 'text-anchor': 'end' }, ref.label));
  }

  let d = '';
  let pen = false;
  for (let i = 0; i < spec.xs.length; i++) {
    const y = spec.ys[i];
    if (Number.isNaN(y)) {
      pen = false;
      continue;
    }
    d += `${pen ? 'L' : 'M'}${px(spec.xs[i]).toFixed(1)} ${py(y).toFixed(1)}`;
    pen = true;
  }
  root.append(svg('path', { d, class: 'chart-line' }));

  const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1));
  root.append(svg('text', { x: M.left - 4, y: M.top + 4, class: 'chart-tick', 'text-anchor': 'end' }, fmt(hi)));
  root.append(svg('text', { x: M.left - 4, y: M.top + plotH, class: 'chart-tick', 'text-anchor': 'end' }, fmt(lo)));
  root.append(svg('text', { x: M.left, y: VIEW_H - 4, class: 'chart-tick' }, '0 m'));
  root.append(svg('text', { x: M.left + plotW, y: VIEW_H - 4, class: 'chart-tick', 'text-anchor': 'end' }, `${Math.round(spec.total)} m`));
  return root;
}

// ------------------------------------------------------------ panel

export function renderResults(root: HTMLElement, result: RouteSuccess | null, traverser: Traverser, cellM: number): void {
  root.replaceChildren();
  root.hidden = !result || result.legs.length === 0;
  if (!result || result.legs.length === 0) return;

  const xs = result.profileDist;
  const slopes = result.profileSlope;
  const elev = result.profileElev;

  // Derived figures
  let maxSlope = -Infinity;
  let ascent = 0;
  let descent = 0;
  let nearCells = 0;
  const near = nearLimitSlope(traverser);
  const gaps: [number, number][] = [];
  let gapStart = -1;
  let previousElev = NaN;
  for (let i = 0; i < slopes.length; i++) {
    const s = slopes[i];
    if (Number.isNaN(s)) {
      if (gapStart < 0) gapStart = i;
    } else {
      if (gapStart >= 0) gaps.push([xs[gapStart], xs[i]]);
      gapStart = -1;
      maxSlope = Math.max(maxSlope, s);
      if (near !== null && s >= near) nearCells++;
    }
    if (elev) {
      const z = elev[i];
      if (!Number.isNaN(z) && !Number.isNaN(previousElev)) {
        if (z > previousElev) ascent += z - previousElev;
        else descent += previousElev - z;
      }
      previousElev = z;
    }
  }
  if (gapStart >= 0) gaps.push([xs[gapStart], xs[xs.length - 1]]);

  // Totals
  const totals = el('dl', 'route-summary');
  const limitHours = traverser.azami_sure_saat;
  const hasLimit = typeof limitHours === 'number' && Number.isFinite(limitHours);
  const rows: [string, string][] = [
    ['Distance', `${Math.round(result.distance_m)} m`],
    ['Estimated time', hasLimit ? `${formatDuration(result.time_s)} (limit ${limitHours} h)` : formatDuration(result.time_s)],
    ['Steepest slope', Number.isFinite(maxSlope) ? `${maxSlope.toFixed(1)}° (limit ${traverser.azami_egim_derece}°)` : 'unknown'],
  ];
  if (elev) rows.push(['Climb / descent', `+${Math.round(ascent)} m / −${Math.round(descent)} m`]);
  for (const [term, value] of rows) totals.append(el('dt', undefined, term), el('dd', undefined, value));
  root.append(totals);

  if (result.legs.length > 1) {
    const legs = el('ol', 'route-legs');
    result.legs.forEach((leg, index) => {
      const from = index === 0 ? 'Start' : `Stop ${index}`;
      legs.append(el('li', undefined, `${from} → Stop ${index + 1}: ${Math.round(leg.distance_m)} m, ${formatDuration(leg.time_s)}`));
    });
    root.append(legs);
  }

  // Warnings
  const warnings: string[] = [];
  if (hasLimit && result.time_s > limitHours * 3600) {
    warnings.push(`Estimated time ${formatDuration(result.time_s)} exceeds the ${limitHours} h maximum for "${traverser.ad_en}".`);
  }
  if (near !== null && nearCells > 0) {
    warnings.push(`About ${Math.round(nearCells * cellM)} m of the route is on slopes of ${near}° or more, close to the ${traverser.azami_egim_derece}° limit.`);
  }
  if (result.noDataCells > 0) {
    warnings.push(`The route crosses about ${Math.round(result.noDataCells * cellM)} m with NO DATA. Terrain there is unknown; this is not the same as forbidden.`);
  }
  if (result.cautionCells > 0) {
    warnings.push(`The route crosses about ${Math.round(result.cautionCells * cellM)} m of terrain marked "caution".`);
  }
  const list = el('ul', 'route-warnings');
  if (warnings.length === 0) list.append(el('li', 'ok', 'No warnings for this route.'));
  for (const text of warnings) list.append(el('li', undefined, text));
  root.append(list);

  // Profiles
  const stops: number[] = [];
  let along = 0;
  for (const leg of result.legs.slice(0, -1)) {
    along += leg.distance_m;
    stops.push(along);
  }
  const charts = el('div', 'charts');
  if (elev) {
    charts.append(drawChart({ title: 'Elevation', unit: 'm', xs, ys: elev, total: result.distance_m, stops, gaps }));
  } else {
    charts.append(el('p', 'chart-missing', 'Elevation profile unavailable: no elevation grid was provided.'));
  }
  const refs = [{ y: traverser.azami_egim_derece, label: `limit ${traverser.azami_egim_derece}°`, className: 'limit' }];
  if (near !== null) refs.push({ y: near, label: `${near}°`, className: 'near' });
  charts.append(drawChart({ title: 'Slope', unit: '°', xs, ys: slopes, total: result.distance_m, stops, gaps, refs, includeZero: true }));
  root.append(charts);

  root.append(
    el(
      'p',
      'route-note',
      'Time is one-way travel only (no time at stops, no return). Slope is the terrain slope of each cell, not the slope along the direction of travel. Grey spans in the charts have no data.',
    ),
  );
}
