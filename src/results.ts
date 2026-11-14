// AI-assisted code: written with Claude (Anthropic) and Antigravity (Google DeepMind), reviewed by the team.
//
// Result panel: totals, warnings, and elevation / slope profiles along the
// route. Charts are plain SVG drawn here (no chart library). Every threshold
// comes from mobilite_parametreleri.json.

import type { EnergyProfile, Traverser } from './data';
import type { RouteSuccess, TraverserComparisonRow } from './route-types';

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
 * "uyari_egim_derece" field, otherwise the highest positive speed-table
 * breakpoint still below the limit. Null when the file gives nothing usable.
 */
export function nearLimitSlope(t: Traverser): number | null {
  if (typeof t.uyari_egim_derece === 'number' && Number.isFinite(t.uyari_egim_derece) && t.uyari_egim_derece > 0) {
    return t.uyari_egim_derece;
  }
  const below = t.hiz_tablosu.map((entry) => entry.egim_derece).filter((deg) => deg > 0 && deg < t.azami_egim_derece);
  return below.length > 0 ? Math.max(...below) : null;
}

export interface EnergySummary {
  profileName: string;
  driveWh: number;
  baseWh: number;
  usedWh: number;
  remainingWh: number;
  reserveWh: number;
  usableWh: number;
  dipsIntoReserve: boolean;
  elevationIncluded: boolean;
}

/**
 * Post-hoc vehicle energy calculation along the already-selected route (Mars Rover Demo v1
 * physics: uphill mechanical work without regenerative braking + rolling resistance + base load),
 * leaving A* least-time search untouched.
 */
export function computeDemoEnergy(result: RouteSuccess, ep: EnergyProfile): EnergySummary {
  const elev = result.profileElev;
  let climbM = 0;
  if (elev && elev.length === result.profileDist.length) {
    let prevZ = NaN;
    for (let i = 0; i < elev.length; i++) {
      const z = elev[i];
      if (!Number.isNaN(z) && !Number.isNaN(prevZ) && z > prevZ) {
        climbM += z - prevZ;
      }
      prevZ = z;
    }
  }
  const driveWh =
    (ep.kutle_kg * ep.yercekimi_m_s2 * (climbM + ep.yuvarlanma_direnci * result.distance_m)) /
    (ep.verim * 3600);
  const baseWh = ep.baz_guc_w * (result.time_s / 3600);
  const usedWh = driveWh + baseWh;
  const reserveWh = ep.enerji_kapasite_wh * ep.rezerv_orani;
  const usableWh = ep.enerji_kalan_wh - reserveWh;
  const remainingWh = ep.enerji_kalan_wh - usedWh;
  return {
    profileName: ep.profil_adi_en,
    driveWh,
    baseWh,
    usedWh,
    remainingWh,
    reserveWh,
    usableWh,
    dipsIntoReserve: remainingWh < reserveWh,
    elevationIncluded: elev !== null,
  };
}

// ------------------------------------------------------------ chart

interface ChartThreshold {
  x: number;
  label: string;
}

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
  /** Optional safety threshold markers along the route (time / distance caps). */
  thresholds?: ChartThreshold[];
  /** [from, to] distance spans with no data. */
  gaps: [number, number][];
  includeZero?: boolean;
}

function gapsFromSeries(xs: Float32Array, ys: Float32Array): [number, number][] {
  const gaps: [number, number][] = [];
  if (xs.length === 0) return gaps;
  let gapStart = -1;
  for (let i = 0; i < ys.length; i++) {
    if (Number.isNaN(ys[i])) {
      if (gapStart < 0) gapStart = i;
    } else if (gapStart >= 0) {
      const from = gapStart > 0 ? xs[gapStart - 1] : xs[0];
      gaps.push([from, xs[i]]);
      gapStart = -1;
    }
  }
  if (gapStart >= 0) {
    const from = gapStart > 0 ? xs[gapStart - 1] : xs[0];
    gaps.push([from, xs[xs.length - 1]]);
  }
  return gaps;
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
  const placedXs: number[] = [];
  for (const th of spec.thresholds ?? []) {
    if (!Number.isFinite(th.x)) continue;
    const tx = px(th.x);
    root.append(svg('line', { x1: tx, x2: tx, y1: M.top, y2: M.top + plotH, class: 'chart-turnaround' }));
    const anchor = tx > M.left + plotW * 0.72 ? 'end' : 'start';
    const dx = anchor === 'end' ? -3 : 3;
    const closeCount = placedXs.filter((prev) => Math.abs(prev - tx) < 60).length;
    const labelY = M.top + 9 + closeCount * 10;
    placedXs.push(tx);
    root.append(
      svg('text', { x: tx + dx, y: labelY, class: 'chart-turnaround-label', 'text-anchor': anchor }, th.label),
    );
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

export function renderResults(
  root: HTMLElement,
  result: RouteSuccess | null,
  traverser: Traverser,
  slopeBaselineM?: number,
  cellM?: number,
): void {
  root.replaceChildren();
  root.hidden = !result || result.legs.length === 0;
  if (!result || result.legs.length === 0) return;

  const xs = result.profileDist;
  const slopes = result.profileSlope;
  const elev = result.profileElev;

  // Derived figures (step-weighted so diagonal steps count as cellM * sqrt(2))
  let maxSlope = -Infinity;
  let ascent = 0;
  let descent = 0;
  let nearLimitM = 0;
  const near = nearLimitSlope(traverser);
  let previousElev = NaN;
  for (let i = 0; i < slopes.length; i++) {
    const s = slopes[i];
    if (!Number.isNaN(s)) {
      maxSlope = Math.max(maxSlope, s);
    }
    if (i > 0 && near !== null) {
      const step = xs[i] - xs[i - 1];
      const prevNear = !Number.isNaN(slopes[i - 1]) && slopes[i - 1] >= near ? 0.5 : 0;
      const curNear = !Number.isNaN(s) && s >= near ? 0.5 : 0;
      nearLimitM += step * (prevNear + curNear);
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
  const slopeGaps = gapsFromSeries(xs, slopes);
  const elevGaps = elev ? gapsFromSeries(xs, elev) : [];

  // GO / CAUTION / NO-GO corridor suitability badge
  const decisionBadge = el('div', 'decision-badge');
  decisionBadge.dataset.decision = result.decision;
  const reasonSummary = result.decisionReasons.join('; ');
  decisionBadge.textContent = reasonSummary ? `${result.decision}: ${reasonSummary}` : result.decision;
  root.append(decisionBadge);

  // Totals
  const originLabel = result.mode === 'auto-landing' ? 'Landing' : 'Start';
  const totals = el('dl', 'route-summary');
  const limitHours = traverser.azami_sure_saat;
  const hasLimit = typeof limitHours === 'number' && Number.isFinite(limitHours) && limitHours > 0;
  const hasBaseline = typeof slopeBaselineM === 'number' && Number.isFinite(slopeBaselineM) && slopeBaselineM > 0;
  const baselineSuffix = hasBaseline ? ` on ${slopeBaselineM} m baseline` : '';
  const limitSuffix = hasLimit ? ` (limit ${limitHours} h)` : '';
  const timeBreakdown =
    result.stopTime_s > 0
      ? ` — ${formatDuration(result.travelTime_s)} travel + ${formatDuration(result.stopTime_s)} at stops`
      : '';

  const radialKm = (result.maxRadialDist_m / 1000).toFixed(2);
  const radialCapKm =
    result.radialCapLimit_m !== null ? Number((result.radialCapLimit_m / 1000).toFixed(2)) : null;
  const radialText =
    radialCapKm !== null
      ? `${radialKm} km (limit ${radialCapKm} km${result.radialCapExceeded ? ' — broken: distance' : ''})`
      : `${radialKm} km`;

  const rows: [string, string][] = [
    ['Distance', `${Math.round(result.distance_m)} m${result.roundTrip ? ' (round-trip)' : ''}`],
    [`Max ${originLabel.toLowerCase()} standoff`, radialText],
    ['Estimated time', `${formatDuration(result.time_s)}${limitSuffix}${timeBreakdown}`],
    [
      'Steepest slope',
      Number.isFinite(maxSlope) ? `${maxSlope.toFixed(1)}°${baselineSuffix} (limit ${traverser.azami_egim_derece}°)` : 'unknown',
    ],
  ];
  if (elev) rows.push(['Climb / descent', `+${Math.round(ascent)} m / −${Math.round(descent)} m`]);
  if (result.walkBackLimit_s !== null) {
    const wbLimitH = Number((result.walkBackLimit_s / 3600).toFixed(2));
    if (!result.walkBackExceeded && result.maxWalkBackTotal_s !== null && Number.isFinite(result.maxWalkBackTotal_s)) {
      const remS = Math.max(0, result.walkBackLimit_s - result.maxWalkBackTotal_s);
      const remPct = Math.max(0, Math.round((remS / result.walkBackLimit_s) * 100));
      rows.push([
        'Walk-back check',
        `Peak ${formatDuration(result.maxWalkBackTotal_s)} ≤ ${wbLimitH} h (min margin ${formatDuration(remS)}, ${remPct}% at ~${Math.round(result.peakWalkBackDist_m ?? 0)} m)`,
      ]);
    } else if (result.maxWalkBackTotal_s !== null && Number.isFinite(result.maxWalkBackTotal_s)) {
      rows.push([
        'Walk-back check',
        `Peak ${formatDuration(result.maxWalkBackTotal_s)} > ${wbLimitH} h — broken: time at ~${Math.round(result.walkBackDist_m ?? 0)} m`,
      ]);
    } else {
      rows.push([
        'Walk-back check',
        `Unwalkable return > ${wbLimitH} h — broken: time at ~${Math.round(result.walkBackDist_m ?? 0)} m`,
      ]);
    }
  }

  const demoEnergy = traverser.enerji_profili ? computeDemoEnergy(result, traverser.enerji_profili) : null;
  if (demoEnergy) {
    const reserveNote = demoEnergy.dipsIntoReserve ? ' — dips into reserve' : '';
    const elevNote = !demoEnergy.elevationIncluded ? '; flat-ground lower bound' : '';
    rows.push([
      'Energy (demo profile)',
      `${Math.round(demoEnergy.usedWh)} Wh used · ${Math.round(demoEnergy.remainingWh)} Wh left · ${Math.round(demoEnergy.reserveWh)} Wh reserve (${demoEnergy.profileName}${reserveNote}${elevNote})`,
    ]);
  }

  for (const [term, value] of rows) totals.append(el('dt', undefined, term), el('dd', undefined, value));
  root.append(totals);

  if (result.legs.length >= 1) {
    const stopCount = result.roundTrip ? result.legs.length - 1 : result.legs.length;
    const legs = el('ol', 'route-legs');
    result.legs.forEach((leg, index) => {
      if (leg.isReturn) {
        const from = stopCount > 0 ? `Stop ${stopCount}` : originLabel;
        legs.append(
          el('li', undefined, `${from} → ${originLabel} (return): ${Math.round(leg.distance_m)} m, ${formatDuration(leg.time_s)}`),
        );
      } else {
        const from = index === 0 ? originLabel : `Stop ${index}`;
        legs.append(el('li', undefined, `${from} → Stop ${index + 1}: ${Math.round(leg.distance_m)} m, ${formatDuration(leg.time_s)}`));
      }
    });
    root.append(legs);
  }

  // Warnings
  const warnings: string[] = [];
  if (result.marginalLanding) {
    warnings.push(
      'No class-0 suitable landing zone was reachable within range; using a marginal (borderline, class 1) landing zone.',
    );
  }
  if (result.walkBackExceeded && result.walkBackLimit_s !== null) {
    const wbLimitH = Number((result.walkBackLimit_s / 3600).toFixed(2));
    warnings.push(
      `Beyond ~${Math.round(result.walkBackDist_m ?? 0)} m ("!" on the map; dashed red segment), if the rover fails, walking back is not viable — broken condition: time (elapsed + walk-back exceeds ${wbLimitH} h suit limit or return is blocked by steeper terrain).`,
    );
  }
  if (result.radialCapExceeded && radialCapKm !== null) {
    warnings.push(
      `Beyond ~${Math.round(result.radialCapDist_m ?? 0)} m ("!" on the map; dashed red segment), straight-line distance from ${originLabel.toLowerCase()} reaches ${radialKm} km — broken condition: distance (> ${radialCapKm} km radial standoff cap).`,
    );
  }
  if (hasLimit && result.time_s > limitHours * 3600) {
    const turnNote =
      result.turnAroundDist_m !== null
        ? ` Budget is exhausted around ${Math.round(result.turnAroundDist_m)} m along the route (marked "!" on the map; dashed red segment).`
        : '';
    warnings.push(
      `Estimated mission time ${formatDuration(result.time_s)} exceeds the ${limitHours} h maximum for "${traverser.ad_en}" — broken condition: time.${turnNote}`,
    );
  }
  if (
    result.brokenConditions.length === 0 &&
    result.minMarginRatio !== null &&
    result.minMarginRatio < 0.1
  ) {
    warnings.push(
      `Safety time margin drops below 10% (${Math.max(0, Math.round(result.minMarginRatio * 100))}% remaining at the tightest point).`,
    );
  }
  if (demoEnergy && demoEnergy.dipsIntoReserve) {
    warnings.push(
      `Demo vehicle energy (${demoEnergy.profileName}): estimated ${Math.round(demoEnergy.usedWh)} Wh exceeds the ${Math.round(demoEnergy.usableWh)} Wh usable allowance before the ${Math.round(demoEnergy.reserveWh)} Wh reserve (post-hoc summary; route search is least-time).`,
    );
  }
  if (near !== null && nearLimitM > 0) {
    warnings.push(
      `About ${Math.max(1, Math.round(nearLimitM))} m of the route is on slopes of ${near}° or more, close to the ${traverser.azami_egim_derece}° limit.`,
    );
  }
  if (result.noDataCells > 0) {
    warnings.push(
      `The route crosses about ${Math.max(1, Math.round(result.noDataM))} m with NO DATA. Terrain there is unknown; this is not the same as forbidden.`,
    );
  }
  if (result.cautionCells > 0) {
    warnings.push(`The route crosses about ${Math.max(1, Math.round(result.cautionM))} m of terrain marked "caution".`);
  }
  const list = el('ul', 'route-warnings');
  if (warnings.length === 0) list.append(el('li', 'ok', 'No route warnings beyond dataset-level assumptions above.'));
  for (const text of warnings) list.append(el('li', undefined, text));
  root.append(list);

  // Profiles
  const stops: number[] = [];
  let along = 0;
  for (const leg of result.legs.slice(0, -1)) {
    along += leg.distance_m;
    stops.push(along);
  }
  const thresholds: ChartThreshold[] = [];
  if (result.walkBackExceeded && result.walkBackDist_m !== null) {
    thresholds.push({ x: result.walkBackDist_m, label: 'time (walk-back)' });
  }
  if (result.radialCapExceeded && result.radialCapDist_m !== null) {
    thresholds.push({ x: result.radialCapDist_m, label: `dist (${radialCapKm ?? 10} km)` });
  }
  if (result.turnAroundDist_m !== null && result.turnAroundDist_m !== result.walkBackDist_m) {
    thresholds.push({ x: result.turnAroundDist_m, label: 'time (max)' });
  }

  const charts = el('div', 'charts');
  if (elev) {
    charts.append(
      drawChart({
        title: 'Elevation',
        unit: 'm',
        xs,
        ys: elev,
        total: result.distance_m,
        stops,
        thresholds,
        gaps: elevGaps,
      }),
    );
  } else {
    charts.append(el('p', 'chart-missing', 'Elevation profile unavailable: no elevation grid was provided.'));
  }
  const refs = [{ y: traverser.azami_egim_derece, label: `limit ${traverser.azami_egim_derece}°`, className: 'limit' }];
  if (near !== null) refs.push({ y: near, label: `${near}°`, className: 'near' });
  const slopeTitle = hasBaseline ? `Slope (${slopeBaselineM} m baseline)` : 'Slope';
  charts.append(
    drawChart({
      title: slopeTitle,
      unit: '°',
      xs,
      ys: slopes,
      total: result.distance_m,
      stops,
      thresholds,
      gaps: slopeGaps,
      refs,
      includeZero: true,
    }),
  );
  root.append(charts);

  const scaleM = typeof cellM === 'number' && Number.isFinite(cellM) && cellM > 0 ? cellM : 20;
  root.append(
    el(
      'p',
      'route-scale-note',
      `Computed with ${scaleM} m resolution data; obstacles smaller than this scale were not evaluated.`,
    ),
  );

  const timeBasis = result.roundTrip
    ? result.stopTime_s > 0
      ? 'Time includes round-trip travel and work time at science stops.'
      : 'Time is round-trip travel (work per stop is set to 0 min).'
    : result.stopTime_s > 0
    ? 'Time includes one-way travel and work time at science stops (no return leg).'
    : 'Time is one-way travel only (no time at stops, no return).';
  const baselineNote = hasBaseline
    ? `Terrain slope is ceiling-quantized over a ${slopeBaselineM} m baseline.`
    : '';
  root.append(
    el(
      'p',
      'route-note',
      `${timeBasis} ${baselineNote} Model boundaries: speed depends on slope magnitude only (no directed uphill/downhill search), stops are visited in user-selected order (no TSP reordering), and turn-angle penalties are omitted. Grey spans in the charts have no data.`,
    ),
  );
}

export function renderComparison(
  container: HTMLElement,
  rows: TraverserComparisonRow[] | null,
  activeId: string,
  onSelect: (id: string) => void,
): void {
  container.replaceChildren();
  if (!rows) {
    container.append(el('p', 'route-note', 'Comparing traversers…'));
    return;
  }

  const table = el('table', 'compare-table');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of ['Traverser', 'Dist.', 'Time', 'Max °', 'Status']) {
    hr.append(el('th', undefined, h));
  }
  thead.append(hr);
  table.append(thead);

  const tbody = el('tbody');
  for (const row of rows) {
    const tr = el('tr', `compare-row${row.id === activeId ? ' active' : ''}`);
    tr.title = `Switch to ${row.name}`;
    tr.addEventListener('click', () => onSelect(row.id));

    tr.append(el('td', undefined, row.name));
    if (row.ok) {
      tr.append(el('td', undefined, `${Math.round(row.distance_m ?? 0)} m`));
      tr.append(el('td', undefined, formatDuration(row.time_s ?? 0)));
      tr.append(el('td', undefined, `${(row.maxSlope_deg ?? 0).toFixed(1)}°`));
      const decision = row.decision ?? 'CAUTION';
      const detailTitle = row.decisionReasons?.length ? `${decision}: ${row.decisionReasons.join('; ')}` : decision;
      if (decision === 'NO-GO') {
        const broken = row.brokenConditions?.length ? ` (${row.brokenConditions.join(', ')})` : '';
        const td = el('td', 'compare-status-bad', `NO-GO${broken}`);
        td.title = detailTitle;
        tr.append(td);
      } else if (decision === 'CAUTION') {
        const td = el('td', 'compare-status-warn', 'CAUTION');
        td.title = detailTitle;
        tr.append(td);
      } else {
        const td = el('td', 'compare-status-ok', 'GO');
        td.title = detailTitle;
        tr.append(td);
      }
    } else {
      tr.append(el('td', undefined, '—'));
      tr.append(el('td', undefined, '—'));
      tr.append(el('td', undefined, '—'));
      tr.append(el('td', 'compare-status-bad', row.failReason ?? 'Blocked'));
    }
    tbody.append(tr);
  }
  table.append(tbody);
  container.append(table);
  container.append(el('p', 'route-note', 'Click any row to switch to that traverser.'));
}
