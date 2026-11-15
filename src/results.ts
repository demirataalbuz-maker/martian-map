// AI-assisted code: written with Claude (Anthropic) and Antigravity (Google DeepMind), reviewed by the team.
//
// Result panel: totals, warnings, and elevation / slope profiles along the
// route. Charts are plain SVG drawn here (no chart library) with synchronized
// map-chart hover/playback cursors. Every threshold comes from mobilite_parametreleri.json.

import type { EnergyProfile, Traverser } from './data';
import { getLang, stintUnitLabel, translateDecisionReason, ui } from './i18n';
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
  if (getLang() === 'tr') {
    return h > 0 ? `${h} sa ${m} dk` : `${m} dk`;
  }
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
  if (
    result.energyUsed_wh !== null &&
    result.energyDrive_wh !== null &&
    result.energyBase_wh !== null &&
    result.energyUsable_wh !== null &&
    result.energyReserve_wh !== null &&
    result.energyRemaining_wh !== null
  ) {
    return {
      profileName: ep.profil_adi_en,
      driveWh: result.energyDrive_wh,
      baseWh: result.energyBase_wh,
      usedWh: result.energyUsed_wh,
      remainingWh: result.energyRemaining_wh,
      reserveWh: result.energyReserve_wh,
      usableWh: result.energyUsable_wh,
      dipsIntoReserve: result.energyExceeded,
      elevationIncluded: result.profileElev !== null,
    };
  }
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
  refs?: { y: number; label: string; className: string }[];
  stops: number[];
  stints?: number[];
  thresholds?: ChartThreshold[];
  gaps: [number, number][];
  includeZero?: boolean;
}

const chartUpdaters = new WeakMap<SVGSVGElement, (distM: number | null) => void>();

export function updateChartsCursor(root: HTMLElement, distM: number | null): void {
  root.querySelectorAll<SVGSVGElement>('svg.chart').forEach((chartEl) => {
    chartUpdaters.get(chartEl)?.(distM);
  });
}

function sampleYAtDist(xs: Float32Array, ys: Float32Array, distM: number): number {
  if (xs.length === 0) return NaN;
  if (distM <= xs[0]) return ys[0];
  if (distM >= xs[xs.length - 1]) return ys[ys.length - 1];
  let lo = 0;
  let hi = xs.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= distM) lo = mid;
    else hi = mid;
  }
  const span = xs[hi] - xs[lo];
  const frac = span > 0 ? (distM - xs[lo]) / span : 0;
  const y0 = ys[lo];
  const y1 = ys[hi];
  if (Number.isNaN(y0) || Number.isNaN(y1)) return Number.isNaN(y0) ? y1 : y0;
  return y0 + (y1 - y0) * frac;
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

function drawChart(spec: ChartSpec, onScrubDistance?: (distM: number | null) => void): SVGSVGElement {
  const root = svg('svg', {
    viewBox: `0 0 ${VIEW_W} ${VIEW_H}`,
    class: 'chart',
    role: 'img',
    'aria-label': ui(`${spec.title} along the route`, `Rota boyunca ${spec.title}`),
  });
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
  for (const stintX of spec.stints ?? []) {
    root.append(svg('line', { x1: px(stintX), x2: px(stintX), y1: M.top, y2: M.top + plotH, class: 'chart-stint' }));
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
    root.append(svg('text', { x: tx + dx, y: labelY, class: 'chart-turnaround-label', 'text-anchor': anchor }, th.label));
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

  const cursorLine = svg('line', { x1: M.left, x2: M.left, y1: M.top, y2: M.top + plotH, class: 'chart-cursor-line' });
  const cursorDot = svg('circle', { cx: M.left, cy: M.top, r: '3.2', class: 'chart-cursor-dot' });
  cursorLine.style.display = 'none';
  cursorDot.style.display = 'none';
  root.append(cursorLine, cursorDot);

  chartUpdaters.set(root, (distM) => {
    if (distM === null || !Number.isFinite(distM) || spec.total <= 0) {
      cursorLine.style.display = 'none';
      cursorDot.style.display = 'none';
      return;
    }
    const clamped = Math.max(0, Math.min(spec.total, distM));
    const xSvg = px(clamped);
    cursorLine.setAttribute('x1', xSvg.toFixed(1));
    cursorLine.setAttribute('x2', xSvg.toFixed(1));
    cursorLine.style.display = '';
    const yVal = sampleYAtDist(spec.xs, spec.ys, clamped);
    if (!Number.isNaN(yVal)) {
      cursorDot.setAttribute('cx', xSvg.toFixed(1));
      cursorDot.setAttribute('cy', py(yVal).toFixed(1));
      cursorDot.style.display = '';
    } else {
      cursorDot.style.display = 'none';
    }
  });

  if (onScrubDistance && spec.total > 0) {
    root.style.cursor = 'crosshair';
    const distFromClientX = (clientX: number): number | null => {
      const rect = root.getBoundingClientRect();
      if (!(rect.width > 0)) return null;
      const svgX = ((clientX - rect.left) / rect.width) * VIEW_W;
      const ratio = (svgX - M.left) / plotW;
      return Math.max(0, Math.min(1, ratio)) * spec.total;
    };
    root.addEventListener('pointermove', (e) => {
      const dm = distFromClientX(e.clientX);
      if (dm !== null) onScrubDistance(dm);
    });
    root.addEventListener('pointerdown', (e) => {
      const dm = distFromClientX(e.clientX);
      if (dm !== null) onScrubDistance(dm);
    });
    root.addEventListener('pointerleave', () => onScrubDistance(null));
  }

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
  onScrubDistance?: (distM: number | null) => void,
): void {
  root.replaceChildren();
  root.hidden = !result || result.legs.length === 0;
  if (!result || result.legs.length === 0) return;

  const xs = result.profileDist;
  const slopes = result.profileSlope;
  const elev = result.profileElev;

  let maxSlope = -Infinity;
  let ascent = 0;
  let descent = 0;
  let nearLimitM = 0;
  const near = nearLimitSlope(traverser);
  let previousElev = NaN;

  for (let i = 0; i < slopes.length; i++) {
    const s = slopes[i];
    if (!Number.isNaN(s)) maxSlope = Math.max(maxSlope, s);
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
  const localizedReasons = result.decisionReasons.map(translateDecisionReason);
  const reasonSummary = localizedReasons.join('; ');
  decisionBadge.textContent = reasonSummary ? `${result.decision}: ${reasonSummary}` : result.decision;
  root.append(decisionBadge);

  if (result.optimizeStopsEnabled && (result.stopOrderChanged || result.stopOrderCapped)) {
    const tspBanner = el('div', 'tsp-banner');
    if (result.stopOrderCapped) {
      tspBanner.classList.add('warn');
      tspBanner.dataset.kind = 'capped';
      tspBanner.textContent = ui(
        `Stop-order limit (${result.stopOrderCap} stops max): ${result.stopOrder.length} stops exceed exact optimization, so click order is kept.`,
        `Durak optimizasyonu üst sınırı (${result.stopOrderCap} durak): ${result.stopOrder.length} durak sınırı aştığı için tıkladığınız sıra korundu.`,
      );
    } else {
      tspBanner.dataset.kind = 'reordered';
      const seq = result.stopOrder.map((origIdx) => `#${origIdx + 1}`).join(' → ');
      const savedS = result.unoptimizedTime_s !== null ? Math.max(0, result.unoptimizedTime_s - result.time_s) : 0;
      const savedTxt =
        savedS >= 60
          ? ui(` (saves ${formatDuration(savedS)} vs click order)`, ` (tıklama sırasına göre ${formatDuration(savedS)} tasarruf)`)
          : '';
      tspBanner.textContent = ui(
        `Optimized stop order: ${seq}${savedTxt}.`,
        `Optimize edilen durak sırası: ${seq}${savedTxt}.`,
      );
    }
    root.append(tspBanner);
  }

  const originLabel =
    result.mode === 'auto-landing'
      ? ui('Landing', 'İniş noktası')
      : ui('Start', 'Başlangıç');
  const originLower = originLabel.toLowerCase();
  const totals = el('dl', 'route-summary');
  const limitHours = traverser.azami_sure_saat;
  const hasLimit = typeof limitHours === 'number' && Number.isFinite(limitHours) && limitHours > 0;
  const hasBaseline = typeof slopeBaselineM === 'number' && Number.isFinite(slopeBaselineM) && slopeBaselineM > 0;
  const baselineSuffix = hasBaseline ? ui(` on ${slopeBaselineM} m baseline`, ` (${slopeBaselineM} m taban)`) : '';
  const limitSuffix = hasLimit
    ? result.stintDistBudget_m !== null
      ? ui(` (${limitHours} h/EVA)`, ` (${limitHours} sa/EVA)`)
      : ui(` (limit ${limitHours} h)`, ` (limit ${limitHours} sa)`)
    : '';
  const timeBreakdown =
    result.stopTime_s > 0
      ? ui(
          ` — ${formatDuration(result.travelTime_s)} travel + ${formatDuration(result.stopTime_s)} at stops`,
          ` — ${formatDuration(result.travelTime_s)} sürüş + ${formatDuration(result.stopTime_s)} durak çalışma`,
        )
      : '';

  const radialKm = (result.maxRadialDist_m / 1000).toFixed(2);
  const radialCapKm = result.radialCapLimit_m !== null ? Number((result.radialCapLimit_m / 1000).toFixed(2)) : null;
  const radialText =
    radialCapKm !== null
      ? ui(
          `${radialKm} km (limit ${radialCapKm} km${result.radialCapExceeded ? ' — broken: distance' : ''})`,
          `${radialKm} km (tavan ${radialCapKm} km${result.radialCapExceeded ? ' — bozulan: mesafe' : ''})`,
        )
      : `${radialKm} km`;

  const rows: [string, string][] = [
    [
      ui('Distance', 'Mesafe'),
      `${Math.round(result.distance_m)} m${result.roundTrip ? ui(' (round-trip)', ' (gidiş-dönüş)') : ''}`,
    ],
  ];
  if (result.stintDistBudget_m !== null && result.totalStints > 0) {
    const stintLabel = stintUnitLabel(traverser.id, result.totalStints);
    const isRover = traverser.id === 'rover';
    let stintValue: string;
    if (isRover) {
      const avgSpeed = traverser.surus_gunu_ortalamasi_m;
      const measuredNote =
        typeof avgSpeed === 'number' && avgSpeed > 0
          ? ui(
              `; ~${Math.max(1, Math.ceil(result.distance_m / avgSpeed))} sols @ ${avgSpeed} m/sol driving avg`,
              `; ~${Math.max(1, Math.ceil(result.distance_m / avgSpeed))} sol @ ${avgSpeed} m/sol sürüş ort.`,
            )
          : '';
      stintValue = ui(
        `${stintLabel} (@ ${Math.round(result.stintDistBudget_m)} m/sol record${measuredNote})`,
        `${stintLabel} (@ ${Math.round(result.stintDistBudget_m)} m/sol rekor${measuredNote})`,
      );
    } else {
      const budgetKm = Number((result.stintDistBudget_m / 1000).toFixed(2));
      stintValue = ui(
        `${stintLabel} (@ ${budgetKm} km budget; ${result.stintStops.length} STOP markers)`,
        `${stintLabel} (@ ${budgetKm} km bütçe; ${result.stintStops.length} DUR noktası)`,
      );
    }
    rows.push([ui('Mission schedule', 'Görev takvimi'), stintValue]);
  }
  if (result.totalDistCap_m !== null) {
    const totKm = (result.distance_m / 1000).toFixed(2);
    const capKm = (result.totalDistCap_m / 1000).toFixed(2);
    rows.push([
      ui('Total traverser range', 'Azami gezgin menzili'),
      ui(
        `${totKm} / ${capKm} km${result.totalDistExceeded ? ' — broken: distance' : ''}`,
        `${totKm} / ${capKm} km${result.totalDistExceeded ? ' — bozulan: mesafe' : ''}`,
      ),
    ]);
  }
  rows.push(
    [ui(`Max ${originLower} standoff`, 'Üsten azami kuş uçuşu'), radialText],
    [ui('Estimated time', 'Tahmini süre'), `${formatDuration(result.time_s)}${limitSuffix}${timeBreakdown}`],
    [
      ui('Steepest slope', 'En dik eğim'),
      Number.isFinite(maxSlope)
        ? ui(
            `${maxSlope.toFixed(1)}°${baselineSuffix} (limit ${traverser.azami_egim_derece}°)`,
            `${maxSlope.toFixed(1)}°${baselineSuffix} (limit ${traverser.azami_egim_derece}°)`,
          )
        : ui('unknown', 'bilinmiyor'),
    ],
  );
  if (elev) rows.push([ui('Climb / descent', 'Tırmanış / iniş'), `+${Math.round(ascent)} m / −${Math.round(descent)} m`]);

  if (result.walkBackLimit_s !== null) {
    const wbLimitH = Number((result.walkBackLimit_s / 3600).toFixed(2));
    if (!result.walkBackExceeded && result.maxWalkBackTotal_s !== null && Number.isFinite(result.maxWalkBackTotal_s)) {
      const remS = Math.max(0, result.walkBackLimit_s - result.maxWalkBackTotal_s);
      const remPct = Math.max(0, Math.round((remS / result.walkBackLimit_s) * 100));
      rows.push([
        ui('Walk-back check', 'Yaya dönüş kontrolü'),
        ui(
          `Peak ${formatDuration(result.maxWalkBackTotal_s)} ≤ ${wbLimitH} h (min margin ${formatDuration(remS)}, ${remPct}% at ~${Math.round(result.peakWalkBackDist_m ?? 0)} m)`,
          `Tepe ${formatDuration(result.maxWalkBackTotal_s)} ≤ ${wbLimitH} sa (en dar pay ${formatDuration(remS)}, %${remPct} @ ~${Math.round(result.peakWalkBackDist_m ?? 0)} m)`,
        ),
      ]);
    } else if (result.maxWalkBackTotal_s !== null && Number.isFinite(result.maxWalkBackTotal_s)) {
      rows.push([
        ui('Walk-back check', 'Yaya dönüş kontrolü'),
        ui(
          `Peak ${formatDuration(result.maxWalkBackTotal_s)} > ${wbLimitH} h — broken: time at ~${Math.round(result.walkBackDist_m ?? 0)} m`,
          `Tepe ${formatDuration(result.maxWalkBackTotal_s)} > ${wbLimitH} sa — bozulan: süre (~${Math.round(result.walkBackDist_m ?? 0)} m)`,
        ),
      ]);
    } else {
      rows.push([
        ui('Walk-back check', 'Yaya dönüş kontrolü'),
        ui(
          `Unwalkable return > ${wbLimitH} h — broken: time at ~${Math.round(result.walkBackDist_m ?? 0)} m`,
          `Yürünemez dönüş > ${wbLimitH} sa — bozulan: süre (~${Math.round(result.walkBackDist_m ?? 0)} m)`,
        ),
      ]);
    }
  }

  const demoEnergy = traverser.enerji_profili ? computeDemoEnergy(result, traverser.enerji_profili) : null;
  if (demoEnergy) {
    const energyBroken = result.energyExceeded || demoEnergy.dipsIntoReserve;
    const reserveNote = energyBroken ? ui(' — broken: energy (reserve breach)', ' — bozulan: enerji (rezerv aşıldı)') : '';
    const elevNote = !demoEnergy.elevationIncluded ? ui('; flat-ground lower bound', '; düz zemin alt sınırı') : '';
    rows.push([
      ui('Energy budget', 'Enerji bütçesi'),
      ui(
        `${Math.round(demoEnergy.usedWh)} / ${Math.round(demoEnergy.usableWh)} Wh usable · ${Math.round(demoEnergy.remainingWh)} Wh left (${Math.round(demoEnergy.reserveWh)} Wh reserve floor${reserveNote}${elevNote})`,
        `${Math.round(demoEnergy.usedWh)} / ${Math.round(demoEnergy.usableWh)} Wh kullanılabilir · ${Math.round(demoEnergy.remainingWh)} Wh kaldı (${Math.round(demoEnergy.reserveWh)} Wh rezerv tabanı${reserveNote}${elevNote})`,
      ),
    ]);
  }

  if (result.hasThermalInertiaGrid) {
    rows.push([
      ui('Loose regolith / sand (TI < 350)', 'Gevşek zemin / toz (TI < 350)'),
      result.looseGroundM > 0
        ? ui(
            `${Math.round(result.looseGroundM)} m (VARSAYIM c_rr 0.08–0.12 · reduced speed)`,
            `${Math.round(result.looseGroundM)} m (VARSAYIM c_rr 0.08–0.12 · hız düşümü)`,
          )
        : ui('0 m (firm terrain TI ≥ 350 · c_rr 0.05)', '0 m (sert zemin TI ≥ 350 · c_rr 0.05)'),
    ]);
  } else {
    rows.push([
      ui('Ground / regolith model', 'Zemin modeli'),
      ui(
        'unmodeled at 5 m HiRISE (no thermal-inertia grid; assumes firm c_rr = 0.05)',
        '5 m HiRISE için katman yok (termal atalet ızgarası yok; sabit sert c_rr = 0.05 varsayılır)',
      ),
    ]);
  }

  for (const [term, value] of rows) totals.append(el('dt', undefined, term), el('dd', undefined, value));
  root.append(totals);

  if (result.legs.length >= 1) {
    const stopCount = result.roundTrip ? result.legs.length - 1 : result.legs.length;
    const stopLabel = (visitedIdx: number): string => {
      if (result.stopOrderChanged && result.stopOrder.length === stopCount && visitedIdx >= 0 && visitedIdx < stopCount) {
        const orig = result.stopOrder[visitedIdx] + 1;
        return ui(`Stop #${orig}`, `Durak #${orig}`);
      }
      return ui(`Stop ${visitedIdx + 1}`, `Durak ${visitedIdx + 1}`);
    };
    const legs = el('ol', 'route-legs');
    result.legs.forEach((leg, index) => {
      if (leg.isReturn) {
        const from = stopCount > 0 ? stopLabel(stopCount - 1) : originLabel;
        legs.append(
          el(
            'li',
            undefined,
            ui(
              `${from} → ${originLabel} (return): ${Math.round(leg.distance_m)} m, ${formatDuration(leg.time_s)}`,
              `${from} → ${originLabel} (dönüş): ${Math.round(leg.distance_m)} m, ${formatDuration(leg.time_s)}`,
            ),
          ),
        );
      } else {
        const from = index === 0 ? originLabel : stopLabel(index - 1);
        const to = stopLabel(index);
        legs.append(
          el(
            'li',
            undefined,
            ui(
              `${from} → ${to}: ${Math.round(leg.distance_m)} m, ${formatDuration(leg.time_s)}`,
              `${from} → ${to}: ${Math.round(leg.distance_m)} m, ${formatDuration(leg.time_s)}`,
            ),
          ),
        );
      }
    });
    root.append(legs);
  }

  // Warnings
  const warnings: string[] = [];
  if (result.marginalLanding) {
    warnings.push(
      ui(
        'No class-0 suitable landing zone was reachable within range; using a marginal (borderline, class 1) landing zone.',
        'Menzil içinde sınıf-0 (uygun) iniş alanı bulunamadı; sınırda (sınıf-1) iniş alanı kullanılıyor.',
      ),
    );
  }
  if (result.walkBackExceeded && result.walkBackLimit_s !== null) {
    const wbLimitH = Number((result.walkBackLimit_s / 3600).toFixed(2));
    warnings.push(
      ui(
        `Beyond ~${Math.round(result.walkBackDist_m ?? 0)} m ("!" on the map; dashed red segment), if the rover fails, walking back is not viable — broken condition: time (elapsed + walk-back exceeds ${wbLimitH} h suit limit or return is blocked by steeper terrain).`,
        `~${Math.round(result.walkBackDist_m ?? 0)} m sonrasında (haritada "!"; kırmızı kesikli hat) rover arızalanırsa yürüyerek dönüş mümkün değil — bozulan koşul: süre (${wbLimitH} sa sınırı aşıldı veya yaya dönüş dik engelle tıkandı).`,
      ),
    );
  }
  if (result.radialCapExceeded && radialCapKm !== null) {
    warnings.push(
      ui(
        `Beyond ~${Math.round(result.radialCapDist_m ?? 0)} m ("!" on the map; dashed red segment), straight-line distance from ${originLower} reaches ${radialKm} km — broken condition: distance (> ${radialCapKm} km radial standoff cap).`,
        `~${Math.round(result.radialCapDist_m ?? 0)} m sonrasında (haritada "!"; kırmızı kesikli hat) üsten kuş uçuşu mesafe ${radialKm} km'ye ulaşıyor — bozulan koşul: mesafe (> ${radialCapKm} km tavanı).`,
      ),
    );
  }
  if (result.totalDistExceeded && result.totalDistCap_m !== null) {
    const capKm = (result.totalDistCap_m / 1000).toFixed(2);
    warnings.push(
      ui(
        `Beyond ~${Math.round(result.totalDistThreshold_m ?? 0)} m ("!" on the map; red tail), cumulative traverse exceeds the ${capKm} km total traverser range cap — broken condition: distance.`,
        `~${Math.round(result.totalDistThreshold_m ?? 0)} m sonrasında (haritada "!"; kırmızı kesikli hat) toplam rota ${capKm} km gezgin menzil sınırını aşıyor — bozulan koşul: mesafe.`,
      ),
    );
  }
  if (hasLimit && result.stintDistBudget_m === null && result.brokenConditions.includes('time') && result.time_s > limitHours * 3600) {
    const turnNote =
      result.turnAroundDist_m !== null
        ? ui(
            ` Budget is exhausted around ${Math.round(result.turnAroundDist_m)} m along the route (marked "!" on the map; dashed red segment).`,
            ` Bütçe rota boyunca yaklaşık ${Math.round(result.turnAroundDist_m)} m civarında tükeniyor (haritada "!").`,
          )
        : '';
    warnings.push(
      ui(
        `Estimated mission time ${formatDuration(result.time_s)} exceeds the ${limitHours} h maximum for "${traverser.ad_en}" — broken condition: time.${turnNote}`,
        `Tahmini görev süresi (${formatDuration(result.time_s)}), "${traverser.ad_en}" için ${limitHours} sa azami sınırını aşıyor — bozulan koşul: süre.${turnNote}`,
      ),
    );
  }
  if (result.brokenConditions.length === 0 && result.minMarginRatio !== null && result.minMarginRatio < 0.1) {
    warnings.push(
      ui(
        `Safety time margin drops below 10% (${Math.max(0, Math.round(result.minMarginRatio * 100))}% remaining at the tightest point).`,
        `Güvenlik süre payı %10'un altına düşüyor (en dar noktada %${Math.max(0, Math.round(result.minMarginRatio * 100))} kaldı).`,
      ),
    );
  }
  if (demoEnergy && (result.energyExceeded || demoEnergy.dipsIntoReserve)) {
    const atDist =
      result.energyDist_m !== null
        ? ui(` around ~${Math.round(result.energyDist_m)} m ("!" marker)`, ` (~${Math.round(result.energyDist_m)} m civarında "!" işareti)`)
        : '';
    warnings.push(
      ui(
        `NO-GO (broken: energy) — Vehicle energy (${demoEnergy.profileName}): estimated ${Math.round(demoEnergy.usedWh)} Wh exceeds the ${Math.round(demoEnergy.usableWh)} Wh usable allowance above the ${Math.round(demoEnergy.reserveWh)} Wh reserve floor${atDist}.`,
        `NO-GO (bozulan: enerji) — Araç enerjisi (${demoEnergy.profileName}): tahmini ${Math.round(demoEnergy.usedWh)} Wh tüketim, ${Math.round(demoEnergy.reserveWh)} Wh rezerv tabanı üzerindeki ${Math.round(demoEnergy.usableWh)} Wh kullanılabilir bütçeyi aşıyor${atDist}.`,
      ),
    );
  }
  if (near !== null && nearLimitM > 0) {
    warnings.push(
      ui(
        `About ${Math.max(1, Math.round(nearLimitM))} m of the route is on slopes of ${near}° or more, close to the ${traverser.azami_egim_derece}° limit.`,
        `Rotanın yaklaşık ${Math.max(1, Math.round(nearLimitM))} m'si ${traverser.azami_egim_derece}° limitine yakın (≥ ${near}°) eğimlerden geçiyor.`,
      ),
    );
  }
  if (result.noDataCells > 0) {
    warnings.push(
      ui(
        `The route crosses about ${Math.max(1, Math.round(result.noDataM))} m with NO DATA. Terrain there is unknown; this is not the same as forbidden.`,
        `Rota yaklaşık ${Math.max(1, Math.round(result.noDataM))} m VERİ YOK (haritasız) alandan geçiyor. Arazi bilinmiyor; yasak (forbidden) ile aynı değildir.`,
      ),
    );
  }
  if (result.cautionCells > 0) {
    warnings.push(
      ui(
        `The route crosses about ${Math.max(1, Math.round(result.cautionM))} m of terrain marked "caution".`,
        `Rota yaklaşık ${Math.max(1, Math.round(result.cautionM))} m "dikkat (caution)" işaretli araziden geçiyor.`,
      ),
    );
  }
  const list = el('ul', 'route-warnings');
  if (warnings.length === 0) {
    list.append(
      el(
        'li',
        'ok',
        ui('No route warnings beyond dataset-level assumptions above.', 'Yukarıdaki veri seti varsayımları dışında rota uyarısı yok.'),
      ),
    );
  }
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
    thresholds.push({ x: result.walkBackDist_m, label: ui('time (walk-back)', 'süre (yaya dönüş)') });
  }
  if (result.radialCapExceeded && result.radialCapDist_m !== null) {
    thresholds.push({ x: result.radialCapDist_m, label: ui(`dist (${radialCapKm ?? 10} km)`, `mesafe (${radialCapKm ?? 10} km)`) });
  }
  if (result.totalDistExceeded && result.totalDistThreshold_m !== null) {
    thresholds.push({ x: result.totalDistThreshold_m, label: ui('range cap', 'menzil tavanı') });
  }
  if (result.turnAroundDist_m !== null && result.turnAroundDist_m !== result.walkBackDist_m) {
    thresholds.push({ x: result.turnAroundDist_m, label: ui('time (max)', 'süre (azami)') });
  }
  if (result.energyExceeded && result.energyDist_m !== null) {
    thresholds.push({ x: result.energyDist_m, label: ui('energy (reserve)', 'enerji (rezerv)') });
  }
  const stints = result.stintStops.map((s) => s.dist_m);

  const charts = el('div', 'charts');
  if (elev) {
    charts.append(
      drawChart(
        {
          title: ui('Elevation', 'Yükseklik'),
          unit: 'm',
          xs,
          ys: elev,
          total: result.distance_m,
          stops,
          stints,
          thresholds,
          gaps: elevGaps,
        },
        onScrubDistance,
      ),
    );
  } else {
    charts.append(el('p', 'chart-missing', ui('Elevation profile unavailable: no elevation grid was provided.', 'Yükseklik profili yok: yükseklik verisi sağlanmadı.')));
  }
  const refs = [{ y: traverser.azami_egim_derece, label: ui(`limit ${traverser.azami_egim_derece}°`, `limit ${traverser.azami_egim_derece}°`), className: 'limit' }];
  if (near !== null) refs.push({ y: near, label: `${near}°`, className: 'near' });
  const slopeTitle = hasBaseline ? ui(`Slope (${slopeBaselineM} m baseline)`, `Eğim (${slopeBaselineM} m taban)`) : ui('Slope', 'Eğim');
  charts.append(
    drawChart(
      {
        title: slopeTitle,
        unit: '°',
        xs,
        ys: slopes,
        total: result.distance_m,
        stops,
        stints,
        thresholds,
        gaps: slopeGaps,
        refs,
        includeZero: true,
      },
      onScrubDistance,
    ),
  );
  root.append(charts);

  const scaleM = typeof cellM === 'number' && Number.isFinite(cellM) && cellM > 0 ? cellM : 20;
  root.append(
    el(
      'p',
      'route-scale-note',
      ui(
        `Computed with ${scaleM} m resolution data; obstacles smaller than this scale were not evaluated.`,
        `Computed with ${scaleM} m resolution data; obstacles smaller than this scale were not evaluated. (${scaleM} m çözünürlüklü veriyle hesaplandı; bu ölçekten küçük engeller değerlendirilmedi.)`,
      ),
    ),
  );

  const timeBasis = result.roundTrip
    ? result.stopTime_s > 0
      ? ui('Time includes round-trip travel and work time at science stops.', 'Süre gidiş-dönüş yolculuğu ve duraklardaki çalışma süresini içerir.')
      : ui('Time is round-trip travel (work per stop is set to 0 min).', 'Süre gidiş-dönüş yolculuğudur (durak çalışması 0 dk).')
    : result.stopTime_s > 0
    ? ui('Time includes one-way travel and work time at science stops (no return leg).', 'Süre tek yön yolculuk ve durak çalışmasını içerir (dönüş yok).')
    : ui('Time is one-way travel only (no time at stops, no return).', 'Süre yalnızca tek yön yolculuktur.');
  const baselineNote = hasBaseline
    ? ui(`Terrain slope is ceiling-quantized over a ${slopeBaselineM} m baseline.`, `Arazi eğimi ${slopeBaselineM} m taban üzerinde yukarı yuvarlanmıştır.`)
    : '';
  const boundaryText = result.hasThermalInertiaGrid
    ? ui(
        'Model boundaries: directed uphill/downhill slope speeds (downhill tagged VARSAYIM); 20 m THEMIS thermal inertia scales loose-soil speed and rolling resistance (VARSAYIM); optional exact TSP stop optimization capped at 7 stops; solar/night charging and turn-angle penalties omitted.',
        'Model sınırları: yönlü çıkış/iniş eğim hızları kullanılır (iniş değerleri VARSAYIM); 20 m THEMIS termal ataleti gevşek zemin hızı ve yuvarlanma direncini ölçekler (VARSAYIM); isteğe bağlı durak optimizasyonu 7 durakla sınırlıdır; güneş/şarj modeli ve dönüş cezası yoktur.',
      )
    : ui(
        'Model boundaries: directed uphill/downhill slope speeds (downhill tagged VARSAYIM); 5 m HiRISE has no thermal-inertia raster so firm c_rr = 0.05 is assumed; optional exact TSP stop optimization capped at 7 stops; solar/night charging and turn-angle penalties omitted.',
        'Model sınırları: yönlü çıkış/iniş eğim hızları kullanılır (iniş değerleri VARSAYIM); 5 m HiRISE için termal atalet katmanı olmadığından sabit c_rr = 0.05 varsayılır; durak optimizasyonu 7 durakla sınırlıdır; güneş/şarj modeli ve dönüş cezası yoktur.',
      );
  root.append(
    el(
      'p',
      'route-note',
      ui(
        `${timeBasis} ${baselineNote} ${boundaryText} Grey spans in the charts have no data.`,
        `${timeBasis} ${baselineNote} ${boundaryText} Gri alanlarda veri yoktur.`,
      ),
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
    container.append(el('p', 'route-note', ui('Comparing traversers…', 'Araçlar karşılaştırılıyor…')));
    return;
  }

  const table = el('table', 'compare-table');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of [
    ui('Traverser', 'Araç / Yaya'),
    ui('Dist.', 'Mesafe'),
    ui('Time', 'Süre'),
    ui('Max °', 'Maks °'),
    ui('Stints', 'EVA / Sol'),
    ui('Status', 'Durum'),
  ]) {
    hr.append(el('th', undefined, h));
  }
  thead.append(hr);
  table.append(thead);

  const tbody = el('tbody');
  for (const row of rows) {
    const tr = el('tr', `compare-row${row.id === activeId ? ' active' : ''}`);
    tr.title = ui(`Switch to ${row.name}`, `${row.name} seçeneğine geç`);
    tr.addEventListener('click', () => onSelect(row.id));

    tr.append(el('td', undefined, row.name));
    if (row.ok) {
      tr.append(el('td', undefined, `${Math.round(row.distance_m ?? 0)} m`));
      tr.append(el('td', undefined, formatDuration(row.time_s ?? 0)));
      tr.append(el('td', undefined, `${(row.maxSlope_deg ?? 0).toFixed(1)}°`));
      tr.append(el('td', undefined, row.totalStints && row.totalStints > 0 ? stintUnitLabel(row.id, row.totalStints) : '—'));
      const decision = row.decision ?? 'CAUTION';
      const detailTitle = row.decisionReasons?.length
        ? `${decision}: ${row.decisionReasons.map(translateDecisionReason).join('; ')}`
        : decision;
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
      tr.append(el('td', undefined, '—'));
      tr.append(el('td', 'compare-status-bad', row.failReason ?? ui('Blocked', 'Tıkalı')));
    }
    tbody.append(tr);
  }
  table.append(tbody);
  container.append(table);
  container.append(el('p', 'route-note', ui('Click any row to switch to that traverser.', 'Geçiş yapmak için herhangi bir satıra tıklayın.')));
}
