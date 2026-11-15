// AI-assisted code: written with Claude (Anthropic) and Antigravity (Google DeepMind), reviewed by the team.
//
// Traverser selector & What-If Parameter Sandbox, initialized strictly from
// mobilite_parametreleri.json. Supports live parameter overrides tagged as
// USER_OVERRIDE and 1-click reset back to JSON baseline.

import type { ConfidenceLevel, GridMeta, GroundMobilityModel, LandingCraftParams, Traverser } from './data';
import { getLang, onLangChange, traverserName, traverserNote, traverserShortName, ui } from './i18n';

const SVG_NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function makeTraverserGlyph(id: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.flexShrink = '0';

  const add = (tag: string, attrs: Record<string, string>) => {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    svg.append(node);
  };

  if (id === 'yuruyen_insan' || id === 'suited_astronaut') {
    add('circle', { cx: '10', cy: '4.5', r: '2.5', fill: 'currentColor' });
    add('path', {
      d: 'M10 7.5v5l-3 5M10 12.5l3 5M6.5 10.5l3.5-1.5 3.5 1.5',
      stroke: 'currentColor',
      'stroke-width': '1.8',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      fill: 'none',
    });
  } else if (id === 'roverli_insan') {
    add('rect', { x: '3', y: '7', width: '12', height: '5', rx: '1.5', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6' });
    add('circle', { cx: '10.5', cy: '5', r: '1.6', fill: 'currentColor' });
    add('circle', { cx: '6', cy: '15', r: '2', fill: 'currentColor' });
    add('circle', { cx: '14', cy: '15', r: '2', fill: 'currentColor' });
    add('path', { d: 'M15 9l2.5-2', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round' });
  } else {
    add('rect', { x: '4', y: '8', width: '12', height: '4.5', rx: '1', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6' });
    add('path', { d: 'M8 8V4h4', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', fill: 'none' });
    add('circle', { cx: '6', cy: '15', r: '1.8', fill: 'currentColor' });
    add('circle', { cx: '10', cy: '15', r: '1.8', fill: 'currentColor' });
    add('circle', { cx: '14', cy: '15', r: '1.8', fill: 'currentColor' });
  }
  return svg;
}

const present = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

const CONFIDENCE_LABELS_EN: Record<string, string> = {
  olculmus: 'measured',
  tasarim_degeri: 'design value',
  olceklenmis: 'scaled',
  varsayim: 'ASSUMPTION',
  user_override: 'USER OVERRIDE',
};

const CONFIDENCE_LABELS_TR: Record<string, string> = {
  olculmus: 'ölçülmüş',
  tasarim_degeri: 'tasarım değeri',
  olceklenmis: 'ölçeklenmiş',
  varsayim: 'VARSAYIM',
  user_override: 'KULLANICI DEĞİŞİKLİĞİ',
};

function formatConfidence(raw?: ConfidenceLevel): string | null {
  if (!raw) return null;
  const map = getLang() === 'tr' ? CONFIDENCE_LABELS_TR : CONFIDENCE_LABELS_EN;
  return map[raw.toLowerCase()] ?? raw;
}

function formatMeta(kaynak?: string, guven?: ConfidenceLevel): string {
  const src = kaynak || ui('not stated', 'belirtilmedi');
  const conf = formatConfidence(guven);
  return conf
    ? ui(`Source: ${src} · Confidence: ${conf}`, `Kaynak: ${src} · Güven: ${conf}`)
    : ui(`Source: ${src}`, `Kaynak: ${src}`);
}

interface TraverserOverride {
  maxSlopeDeg?: number;
  speedScale?: number;
  maxDurationHours?: number;
  radialCapKm?: number;
  stintDistM?: number;
}

function cloneTraverser(t: Traverser): Traverser {
  return {
    ...t,
    hiz_tablosu: t.hiz_tablosu.map((e) => ({ ...e })),
    ...(t.inis_hiz_tablosu ? { inis_hiz_tablosu: t.inis_hiz_tablosu.map((e) => ({ ...e })) } : {}),
    enerji_profili: t.enerji_profili ? { ...t.enerji_profili } : undefined,
    kaynaklar: { ...t.kaynaklar },
    guvenler: { ...t.guvenler },
  };
}

function applyOverride(base: Traverser, ov?: TraverserOverride): Traverser {
  const copy = cloneTraverser(base);
  if (!ov) return copy;

  const overrideSource = ui('User What-If override (UI sandbox)', 'Kullanıcı senaryo değişikliği');

  if (present(ov.maxSlopeDeg) && Math.abs(ov.maxSlopeDeg - base.azami_egim_derece) > 1e-6) {
    copy.azami_egim_derece = Number(ov.maxSlopeDeg.toFixed(1));
    copy.kaynaklar.azami_egim_derece = overrideSource;
    copy.guvenler.azami_egim_derece = 'USER_OVERRIDE';
    if (copy.uyari_egim_derece !== undefined && copy.uyari_egim_derece >= copy.azami_egim_derece) {
      copy.uyari_egim_derece = Number((copy.azami_egim_derece * 0.75).toFixed(1));
    }
  }

  if (present(ov.speedScale) && Math.abs(ov.speedScale - 1) > 1e-6) {
    const scale = ov.speedScale;
    copy.hiz_tablosu = base.hiz_tablosu.map((e) => ({
      egim_derece: e.egim_derece,
      hiz_m_s: e.hiz_m_s * scale,
      ...(present(e.hiz_km_sa) ? { hiz_km_sa: Number((e.hiz_km_sa * scale).toFixed(2)) } : {}),
    }));
    copy.kaynaklar.hiz_tablosu = `${overrideSource} (${scale.toFixed(2)}×)`;
    copy.guvenler.hiz_tablosu = 'USER_OVERRIDE';
    if (base.inis_hiz_tablosu) {
      copy.inis_hiz_tablosu = base.inis_hiz_tablosu.map((e) => ({
        egim_derece: e.egim_derece,
        hiz_m_s: e.hiz_m_s * scale,
        ...(present(e.hiz_km_sa) ? { hiz_km_sa: Number((e.hiz_km_sa * scale).toFixed(2)) } : {}),
      }));
      copy.kaynaklar.inis_hiz_tablosu = `${overrideSource} (${scale.toFixed(2)}×)`;
      copy.guvenler.inis_hiz_tablosu = 'USER_OVERRIDE';
    }
  }

  if (present(ov.maxDurationHours) && present(base.azami_sure_saat) && Math.abs(ov.maxDurationHours - base.azami_sure_saat) > 1e-6) {
    const val = Number(ov.maxDurationHours.toFixed(1));
    copy.azami_sure_saat = val;
    copy.kaynaklar.azami_sure_saat = overrideSource;
    copy.guvenler.azami_sure_saat = 'USER_OVERRIDE';
    if (present(base.yasam_destek_saat)) {
      copy.yasam_destek_saat = val;
      copy.kaynaklar.yasam_destek_saat = overrideSource;
      copy.guvenler.yasam_destek_saat = 'USER_OVERRIDE';
    }
  }

  if (present(ov.radialCapKm) && present(base.uzaklik_tavani_m)) {
    const targetM = Math.round(ov.radialCapKm * 1000);
    if (Math.abs(targetM - base.uzaklik_tavani_m) > 1) {
      copy.uzaklik_tavani_m = targetM;
      copy.kaynaklar.uzaklik_tavani_m = overrideSource;
      copy.guvenler.uzaklik_tavani_m = 'USER_OVERRIDE';
    }
  }

  if (present(ov.stintDistM) && present(base.sefer_mesafe_m)) {
    const targetM = Math.round(ov.stintDistM);
    if (Math.abs(targetM - base.sefer_mesafe_m) >= 1) {
      copy.sefer_mesafe_m = targetM;
      copy.kaynaklar.sefer_mesafe_m = overrideSource;
      copy.guvenler.sefer_mesafe_m = 'USER_OVERRIDE';
    }
  }

  return copy;
}

function hasAnyOverride(base: Traverser, ov?: TraverserOverride): boolean {
  if (!ov) return false;
  if (present(ov.maxSlopeDeg) && Math.abs(ov.maxSlopeDeg - base.azami_egim_derece) > 1e-6) return true;
  if (present(ov.speedScale) && Math.abs(ov.speedScale - 1) > 1e-6) return true;
  if (present(ov.maxDurationHours) && present(base.azami_sure_saat) && Math.abs(ov.maxDurationHours - base.azami_sure_saat) > 1e-6) return true;
  if (present(ov.radialCapKm) && present(base.uzaklik_tavani_m) && Math.abs(ov.radialCapKm * 1000 - base.uzaklik_tavani_m) > 1) return true;
  if (present(ov.stintDistM) && present(base.sefer_mesafe_m) && Math.abs(ov.stintDistM - base.sefer_mesafe_m) >= 1) return true;
  return false;
}

function formatSpeedEntries(table: Traverser['hiz_tablosu']): string {
  return table
    .map((entry) =>
      present(entry.hiz_km_sa)
        ? `${entry.hiz_km_sa.toFixed(2)} km/h (${entry.hiz_m_s.toFixed(2)} m/s) @ ${entry.egim_derece}°`
        : `${entry.hiz_m_s.toFixed(2)} m/s @ ${entry.egim_derece}°`,
    )
    .join(', ');
}

function formatTraverserSpecs(t: Traverser): { compact: string; full: string } {
  const flatEntry = t.hiz_tablosu[0];
  const flatKmH = flatEntry
    ? present(flatEntry.hiz_km_sa)
      ? flatEntry.hiz_km_sa
      : flatEntry.hiz_m_s * 3.6
    : 0;
  const speedPart =
    flatKmH > 0 && flatKmH < 1
      ? ui(`${Math.round(flatKmH * 1000)} m/h`, `${Math.round(flatKmH * 1000)} m/sa`)
      : ui(`${Number(flatKmH.toFixed(1))} km/h`, `${Number(flatKmH.toFixed(1))} km/sa`);

  const compactParts = [speedPart];
  const fullParts = [speedPart];

  const isRover = t.id === 'rover';
  if (present(t.sefer_mesafe_m)) {
    const stintLabel = isRover
      ? `${Math.round(t.sefer_mesafe_m)} m/sol`
      : t.id === 'roverli_insan'
      ? `${Number((t.sefer_mesafe_m / 1000).toFixed(1))} km/${ui('day', 'gün')}`
      : `${Number((t.sefer_mesafe_m / 1000).toFixed(1))} km EVA`;
    compactParts.push(stintLabel);
    fullParts.push(stintLabel);
  }
  if (present(t.azami_sure_saat)) {
    const durLabel = `${t.azami_sure_saat} ${ui('h', 'sa')}`;
    if (!present(t.sefer_mesafe_m)) compactParts.push(durLabel);
    fullParts.push(durLabel);
  }
  if (isRover && present(t.toplam_menzil_m)) {
    fullParts.push(ui(`max ${Number((t.toplam_menzil_m / 1000).toFixed(1))} km`, `tavan ${Number((t.toplam_menzil_m / 1000).toFixed(1))} km`));
  } else if (t.enerji_profili) {
    const usableWh = Math.round(
      t.enerji_profili.enerji_kalan_wh - t.enerji_profili.enerji_kapasite_wh * t.enerji_profili.rezerv_orani,
    );
    fullParts.push(`${usableWh} Wh`);
  }
  return { compact: compactParts.join(' · '), full: fullParts.join(' · ') };
}

function parameterRows(t: Traverser): { label: string; value: string; key: string }[] {
  const speeds = formatSpeedEntries(t.hiz_tablosu);
  const rows: { label: string; value: string; key: string }[] = [
    { label: ui('Slope limit', 'Eğim limiti'), value: `${t.azami_egim_derece}°`, key: 'azami_egim_derece' },
  ];
  if (present(t.yurume_baz_hiz_km_sa)) {
    rows.push({ label: ui('Base walk speed', 'Baz yürüme hızı'), value: `${t.yurume_baz_hiz_km_sa} km/h`, key: 'yurume_baz_hiz_km_sa' });
  }
  rows.push({ label: ui('Speed by slope (uphill / flat)', 'Eğime göre hız (çıkış / düz)'), value: speeds, key: 'hiz_tablosu' });
  if (t.inis_hiz_tablosu?.length) {
    rows.push({
      label: ui('Downhill speed by slope', 'İniş hızı tablosu'),
      value: formatSpeedEntries(t.inis_hiz_tablosu),
      key: 'inis_hiz_tablosu',
    });
  }
  if (present(t.sefer_mesafe_m)) {
    const isRover = t.id === 'rover';
    const isWalker = t.id === 'yuruyen_insan' || t.id === 'suited_astronaut';
    rows.push({
      label: isRover
        ? ui('Sol max budget (record)', 'Sol başı en yüksek mesafe (rekor)')
        : isWalker
        ? ui('EVA round-trip budget', 'Tek EVA gidiş-dönüş bütçesi')
        : ui('Daily traverse budget', 'Günlük menzil bütçesi'),
      value: isRover
        ? `${Math.round(t.sefer_mesafe_m)} m/sol`
        : `${Number((t.sefer_mesafe_m / 1000).toFixed(2))} km (${Math.round(t.sefer_mesafe_m)} m)`,
      key: 'sefer_mesafe_m',
    });
  }
  if (present(t.surus_gunu_ortalamasi_m)) {
    const allSol = present(t.sol_basina_ortalama_m) ? ui(` · ${t.sol_basina_ortalama_m} m/all sols`, ` · ${t.sol_basina_ortalama_m} m/tüm sollar`) : '';
    rows.push({
      label: ui('Measured driving-sol avg', 'Ölçülmüş sürüş solü ort.'),
      value: `${t.surus_gunu_ortalamasi_m} m/sol${allSol}`,
      key: 'surus_gunu_ortalamasi_m',
    });
  }
  if (present(t.toplam_menzil_m)) {
    rows.push({
      label: ui('Total mission range cap', 'Toplam görev menzili limiti'),
      value: `${Number((t.toplam_menzil_m / 1000).toFixed(2))} km (${Math.round(t.toplam_menzil_m)} m)`,
      key: 'toplam_menzil_m',
    });
  }
  if (present(t.uzaklik_tavani_m)) {
    const km = Number((t.uzaklik_tavani_m / 1000).toFixed(2));
    rows.push({ label: ui('Max radial standoff', 'Kuş uçuşu mesafe tavanı'), value: `${km} km (${Math.round(t.uzaklik_tavani_m)} m)`, key: 'uzaklik_tavani_m' });
  }
  if (present(t.yasam_destek_tasarim_saat)) {
    rows.push({ label: ui('Suit design duration', 'Kıyafet tasarım süresi'), value: `${t.yasam_destek_tasarim_saat} h`, key: 'yasam_destek_tasarim_saat' });
  }
  if (present(t.sure_payi)) {
    rows.push({ label: ui('Life-support margin factor', 'Güvenlik payı çarpanı'), value: String(t.sure_payi), key: 'sure_payi' });
  }
  if (present(t.azami_sure_saat)) {
    rows.push({ label: ui('Max duration budget', 'Azami süre bütçesi'), value: `${t.azami_sure_saat} h`, key: 'azami_sure_saat' });
  }
  if (present(t.azami_engel_m)) {
    rows.push({ label: ui('Max obstacle', 'Azami engel yüksekliği'), value: `${t.azami_engel_m} m`, key: 'azami_engel_m' });
  }
  if (t.enerji_profili) {
    const ep = t.enerji_profili;
    const reserveWh = Math.round(ep.enerji_kapasite_wh * ep.rezerv_orani);
    const usableWh = Math.round(ep.enerji_kalan_wh - reserveWh);
    rows.push({
      label: ui('Energy profile (demo)', 'Enerji profili (demo)'),
      value: `${ep.profil_adi_en} — ${ep.kutle_kg} kg, ${usableWh} Wh usable + ${reserveWh} Wh reserve`,
      key: 'enerji_profili',
    });
  }
  if (present(t.enerji_katsayisi)) {
    rows.push({ label: ui('Energy coefficient', 'Enerji katsayısı'), value: String(t.enerji_katsayisi), key: 'enerji_katsayisi' });
  }
  return rows;
}

function landingRows(lc: LandingCraftParams): { label: string; value: string; key: string }[] {
  const rows: { label: string; value: string; key: string }[] = [];
  if (present(lc.guvenli_alan_capi_m)) {
    rows.push({ label: ui('Safe landing circle Ø', 'Güvenli iniş dairesi Ø'), value: `${lc.guvenli_alan_capi_m} m`, key: 'guvenli_alan_capi_m' });
  }
  if (present(lc.puskurtme_guvenlik_yaricapi_m)) {
    rows.push({
      label: ui('Plume keep-out standoff', 'Püskürtme güvenlik yarıçapı'),
      value: `${Math.round(lc.puskurtme_guvenlik_yaricapi_m)} m`,
      key: 'puskurtme_guvenlik_yaricapi_m',
    });
  }
  if (present(lc.azami_egim_derece)) {
    rows.push({ label: ui('Lander slope limit', 'İniş aracı eğim limiti'), value: `${lc.azami_egim_derece}°`, key: 'azami_egim_derece' });
  }
  if (present(lc.azami_kaya_m)) {
    rows.push({ label: ui('Lander max rock', 'İniş aracı kaya limiti'), value: `${lc.azami_kaya_m} m`, key: 'azami_kaya_m' });
  }
  if (present(lc.azami_yukseklik_m)) {
    rows.push({ label: ui('Lander max elevation', 'İniş aracı yükseklik limiti'), value: `${lc.azami_yukseklik_m} m`, key: 'azami_yukseklik_m' });
  }
  return rows;
}

export interface TraverserSelectorController {
  selectById(id: string): void;
  getEffectiveTraversers(): Traverser[];
  setScenarioContext(
    scenario: 'crewed' | 'rover',
    nextGrid?: Pick<GridMeta, 'hucre_m' | 'egim_taban_uzunlugu_m' | 'egim_yontemi_en' | 'kaynak_en' | 'guven_notu_en'>,
    nextLander?: LandingCraftParams | null,
  ): { active: Traverser; effectiveList: Traverser[] };
}

export interface TraverserSandboxUI {
  ground?: GroundMobilityModel | null;
  topTraversersRoot?: HTMLElement;
  paramsPopoverRoot?: HTMLElement;
  paramsButton?: HTMLButtonElement;
  onTraversersUpdated?: (effective: Traverser[], active: Traverser) => void;
}

export function findWalkBackReference(
  traversers: Traverser[],
  current: Traverser,
): { walker: Traverser; limitHours: number; source?: string; conf?: ConfidenceLevel } | null {
  const usesWalkBack = current.yuruyus_donus === true || (current.yuruyus_donus !== false && current.id === 'roverli_insan');
  if (!usesWalkBack) return null;
  const walker = traversers.find((x) => x.id === 'yuruyen_insan' || x.id === 'suited_astronaut');
  if (!walker || walker.id === current.id) return null;
  if (present(current.yasam_destek_saat) && current.yasam_destek_saat > 0) {
    return {
      walker,
      limitHours: current.yasam_destek_saat,
      source: current.kaynaklar.yasam_destek_saat,
      conf: current.guvenler.yasam_destek_saat,
    };
  }
  if (present(walker.azami_sure_saat) && walker.azami_sure_saat > 0) {
    return {
      walker,
      limitHours: walker.azami_sure_saat,
      source: walker.kaynaklar.azami_sure_saat,
      conf: walker.guvenler.azami_sure_saat,
    };
  }
  if (present(current.azami_sure_saat) && current.azami_sure_saat > 0) {
    return {
      walker,
      limitHours: current.azami_sure_saat,
      source: current.kaynaklar.azami_sure_saat,
      conf: current.guvenler.azami_sure_saat,
    };
  }
  return null;
}

export function initTraverserSelector(
  traversers: Traverser[],
  landingCraft: LandingCraftParams | null,
  root: HTMLElement,
  onChange: (traverser: Traverser) => void,
  grid?: Pick<GridMeta, 'hucre_m' | 'egim_taban_uzunlugu_m' | 'egim_yontemi_en' | 'kaynak_en' | 'guven_notu_en'>,
  sandboxUI?: TraverserSandboxUI,
): TraverserSelectorController {
  root.replaceChildren();
  const baseline = traversers.map(cloneTraverser);
  const overrides = new Map<string, TraverserOverride>();
  let currentScenario: 'crewed' | 'rover' = 'crewed';
  let activeGrid = grid;
  let activeLander = landingCraft;
  const inScenario = (t: Traverser, sc: 'crewed' | 'rover'): boolean =>
    sc === 'rover' ? t.id === 'rover' : t.id !== 'rover';
  const scenarioList = (sc: 'crewed' | 'rover') => {
    const filtered = baseline.filter((t) => inScenario(t, sc));
    return filtered.length > 0 ? filtered : baseline;
  };
  let lastCrewedId = scenarioList('crewed')[0].id;
  let activeId = scenarioList('crewed')[0].id;
  let debounceTimer: number | null = null;

  const getEffectiveList = (): Traverser[] => baseline.map((b) => applyOverride(b, overrides.get(b.id)));
  const getActivePair = () => {
    const base = baseline.find((b) => b.id === activeId) ?? baseline[0];
    const effectiveList = getEffectiveList();
    const effective = effectiveList.find((t) => t.id === activeId) ?? effectiveList[0];
    return { base, effective, effectiveList };
  };

  const group = el('div', 'traverser-options');
  group.setAttribute('role', 'radiogroup');
  const noteEl = el('p', 'traverser-note');
  const details = el('details', 'traverser-details');
  const summary = el('summary');
  const methodNote = el('p', 'route-note');
  const list = el('dl', 'facts');
  details.append(summary, methodNote, list);
  root.append(group, noteEl, details);

  const notifyUpdated = (immediate: boolean): void => {
    const fire = () => {
      const { effective, effectiveList } = getActivePair();
      if (sandboxUI?.onTraversersUpdated) sandboxUI.onTraversersUpdated(effectiveList, effective);
      else onChange(effective);
    };
    if (debounceTimer !== null) {
      window.clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (immediate) fire();
    else debounceTimer = window.setTimeout(fire, 80);
  };

  const renderDetails = (): void => {
    const { effective, effectiveList } = getActivePair();
    const slopeBaselineM = activeGrid?.egim_taban_uzunlugu_m;
    group.setAttribute('aria-label', ui('Traverser type', 'Araç / yürüyüş tipi'));
    summary.textContent = ui(
      'How mobility limits were chosen (parameters & sources)',
      'Mobilite limitleri nasıl seçildi (parametreler ve kaynaklar)',
    );
    const cellScaleNote = present(activeGrid?.hucre_m)
      ? ui(
          `Computed with ${activeGrid!.hucre_m} m resolution data; obstacles smaller than this scale were not evaluated. `,
          `${activeGrid!.hucre_m} m çözünürlüklü veriyle hesaplandı; bu ölçekten küçük engeller değerlendirilmedi. `,
        )
      : '';
    methodNote.textContent = ui(
      `${cellScaleNote}Every limit, speed table and duration budget is read from mobilite_parametreleri.json & mobilite_cagatay_2026-11-15.json with its source and confidence tag. Model boundaries: directed uphill vs. downhill speeds from elevation deltas, 20 m THEMIS thermal-inertia regolith scaling (not resolved at 5 m HiRISE scale), optional shortest-duration stop optimization (exact TSP up to 7 stops), battery reserve-floor NO-GO enforcement (no solar/recharging model), hazard-safe visibility smoothing, no turn-angle penalty, sub-grid obstacles (< grid scale) assumed navigable, and multi-EVA / multi-sol budgets split at STOP/DUR points.`,
      `${cellScaleNote}Tüm sınırlar, hız tabloları ve sefer bütçeleri mobilite_parametreleri.json ve mobilite_cagatay_2026-11-15.json dosyalarından kaynak ve güven etiketiyle okunur. Model sınırları: yükseklik farkına göre yönlü çıkış/iniş hızları, 20 m THEMIS termal atalet zemin etkisi (5 m HiRISE ölçeğinde yok), isteğe bağlı en kısa durak sırası optimizasyonu (en fazla 7 durak), rezerv altı pil tüketiminde NO-GO kararı (güneş/şarj modeli yok), engel güvenli yumuşatma, dönüş açısı cezası yok, ızgara ölçeği altı engeller varsayılır ve erişilebilir rota EVA/sol bütçelerine göre DUR noktalarıyla bölünür.`,
    );

    const nText = traverserNote(effective);
    noteEl.textContent = nText;
    noteEl.hidden = !nText;

    list.replaceChildren();
    if (present(slopeBaselineM) && slopeBaselineM > 0) {
      const dd = el('dd', undefined, `${slopeBaselineM} m`);
      dd.append(el('span', 'source', activeGrid?.egim_yontemi_en || ui('Grid slope measurement baseline (izgara.json)', 'Grid eğim taban uzunluğu (izgara.json)')));
      list.append(el('dt', undefined, ui('Slope baseline', 'Eğim taban uzunluğu')), dd);
    }
    if (activeGrid?.kaynak_en) {
      const dd = el('dd', undefined, activeGrid.kaynak_en);
      if (activeGrid.guven_notu_en) dd.append(el('span', 'source', ui(`Confidence: ${activeGrid.guven_notu_en}`, `Güven: ${activeGrid.guven_notu_en}`)));
      list.append(el('dt', undefined, ui('Cost grid', 'Maliyet gridi')), dd);
    }
    for (const row of parameterRows(effective)) {
      const dd = el('dd', undefined, row.value);
      dd.append(el('span', 'source', formatMeta(effective.kaynaklar[row.key], effective.guvenler[row.key])));
      list.append(el('dt', undefined, row.label), dd);
    }
    if (sandboxUI?.ground) {
      const g = sandboxUI.ground;
      const gDd =
        currentScenario === 'crewed'
          ? el(
              'dd',
              undefined,
              ui(
                `TI ≥ ${g.tiLooseThreshold}: 1.00× speed (c_rr=${effective.enerji_profili?.yuvarlanma_direnci ?? g.hardRollingResistance}); ${g.tiVeryLooseThreshold}–${g.tiLooseThreshold - 1}: ${g.looseSpeedFactor.toFixed(2)}× (c_rr=${g.looseRollingResistance}); < ${g.tiVeryLooseThreshold}: ${g.veryLooseSpeedFactor.toFixed(2)}× (c_rr=${g.veryLooseRollingResistance})`,
                `TI ≥ ${g.tiLooseThreshold}: 1.00× hız (c_rr=${effective.enerji_profili?.yuvarlanma_direnci ?? g.hardRollingResistance}); ${g.tiVeryLooseThreshold}–${g.tiLooseThreshold - 1}: ${g.looseSpeedFactor.toFixed(2)}× (c_rr=${g.looseRollingResistance}); < ${g.tiVeryLooseThreshold}: ${g.veryLooseSpeedFactor.toFixed(2)}× (c_rr=${g.veryLooseRollingResistance})`,
              ),
            )
          : el(
              'dd',
              undefined,
              ui(
                'Not evaluated at 5 m HiRISE (no TI binary in ince/maliyet/; hard-regolith baseline used)',
                '5 m HiRISE ölçeğinde değerlendirilmez (ince/maliyet/ içinde TI ikili verisi yok; sert zemin temeli kullanılır)',
              ),
            );
      const gSource =
        g.kaynaklar.gevsek_zemin_dikkat_termal_atalet ??
        g.kaynaklar.gevsek_hiz_carpani ??
        g.kaynaklar.toz_esigi_termal_atalet;
      const gConf =
        g.guvenler.gevsek_hiz_carpani ??
        g.guvenler.gevsek_zemin_dikkat_termal_atalet ??
        g.guvenler.toz_esigi_termal_atalet;
      gDd.append(el('span', 'source', formatMeta(gSource, gConf)));
      list.append(el('dt', undefined, ui('Ground / regolith model', 'Zemin / regolit modeli')), gDd);
    }
    const wb = findWalkBackReference(effectiveList, effective);
    if (wb) {
      const dd = el(
        'dd',
        undefined,
        ui(
          `${wb.limitHours} h (elapsed + walk-back ≤ suit limit; walk ≤ ${wb.walker.azami_egim_derece}°)`,
          `${wb.limitHours} sa (geçen + yaya dönüş ≤ kıyafet limiti; yürüyüş ≤ ${wb.walker.azami_egim_derece}°)`,
        ),
      );
      dd.append(
        el(
          'span',
          'source',
          ui(
            `${formatMeta(wb.source, wb.conf)} · Walk speeds from "${traverserName(wb.walker)}"`,
            `${formatMeta(wb.source, wb.conf)} · Yürüyüş hızları: "${traverserName(wb.walker)}"`,
          ),
        ),
      );
      list.append(el('dt', undefined, ui('Walk-back limit', 'Yürüyerek dönüş limiti')), dd);
    }
    if (activeLander) {
      for (const row of landingRows(activeLander)) {
        const dd = el('dd', undefined, row.value);
        dd.append(el('span', 'source', formatMeta(activeLander.kaynaklar[row.key], activeLander.guvenler[row.key])));
        list.append(el('dt', undefined, row.label), dd);
      }
    }
  };

  const renderSelectors = (): void => {
    const effectiveList = getEffectiveList();
    const shownList = effectiveList.filter((t) => inScenario(t, currentScenario));
    group.replaceChildren();
    if (sandboxUI?.topTraversersRoot) sandboxUI.topTraversersRoot.replaceChildren();

    for (const t of shownList) {
      const base = baseline.find((b) => b.id === t.id)!;
      const overridden = hasAnyOverride(base, overrides.get(t.id));

      const specs = formatTraverserSpecs(t);
      const tName = traverserName(t);

      // Drawer radio item
      const label = el('label', 'traverser-option');
      const radio = el('input');
      radio.type = 'radio';
      radio.name = 'traverser';
      radio.value = t.id;
      radio.checked = t.id === activeId;
      radio.setAttribute('aria-label', `${tName}, ${specs.full}, ≤ ${t.azami_egim_derece}°`);
      radio.addEventListener('change', () => {
        if (!radio.checked) return;
        selectTraverser(t.id, true);
      });
      label.append(
        radio,
        el('span', 'traverser-name', tName),
        el('span', 'traverser-limit', `≤ ${t.azami_egim_derece}°${overridden ? ' *' : ''}`),
        el('span', 'traverser-specs', specs.full),
      );
      group.append(label);

      // Top command bar segmented pill button
      if (sandboxUI?.topTraversersRoot) {
        const btn = el('button', `top-trav-btn${t.id === activeId ? ' active' : ''}`);
        btn.type = 'button';
        btn.setAttribute('aria-pressed', String(t.id === activeId));
        btn.setAttribute('aria-label', `${traverserShortName(t)}: ${specs.full}, ≤ ${t.azami_egim_derece}°`);
        btn.title = `${tName} · ${specs.full} · ≤ ${t.azami_egim_derece}°`;
        btn.append(
          makeTraverserGlyph(t.id),
          el('span', undefined, traverserShortName(t)),
          el('span', 'top-trav-limit', `≤${t.azami_egim_derece}°`),
          el('span', 'top-trav-specs', specs.compact),
        );
        if (overridden) {
          const dot = el('span', 'top-trav-dot');
          dot.title = ui('USER OVERRIDE active', 'KULLANICI DEĞİŞİKLİĞİ aktif');
          btn.append(dot);
        }
        btn.addEventListener('click', () => selectTraverser(t.id, true));
        sandboxUI.topTraversersRoot.append(btn);
      }
    }

    if (sandboxUI?.paramsButton) {
      const anyActiveOverride = shownList.some((t) => {
        const base = baseline.find((b) => b.id === t.id)!;
        return hasAnyOverride(base, overrides.get(t.id));
      });
      sandboxUI.paramsButton.textContent = ui(
        anyActiveOverride ? '⚙ Params •' : '⚙ Params',
        anyActiveOverride ? '⚙ Ayarlar •' : '⚙ Ayarlar',
      );
    }
  };

  const renderPopover = (): void => {
    const pop = sandboxUI?.paramsPopoverRoot;
    if (!pop) return;
    pop.replaceChildren();

    const { base, effective } = getActivePair();
    const ov = overrides.get(base.id) ?? {};
    const anyOverridden = hasAnyOverride(base, ov);

    const head = el('div', 'params-pop-head');
    head.append(el('span', 'params-pop-title', ui(`What-If Sandbox — ${traverserName(base)}`, `Senaryo Düzenleyici — ${traverserName(base)}`)));
    const closeBtn = el('button', 'drawer-close', '✕');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', ui('Close parameter sandbox', 'Parametre penceresini kapat'));
    closeBtn.addEventListener('click', () => {
      pop.hidden = true;
      sandboxUI?.paramsButton?.setAttribute('aria-expanded', 'false');
    });
    head.append(closeBtn);

    const sub = el(
      'p',
      'params-pop-sub',
      ui(
        'Defaults come strictly from mobilite_parametreleri.json. Drag sliders to test sensitivity; modified metrics are tagged USER OVERRIDE.',
        'Varsayılanlar mobilite_parametreleri.json dosyasından gelir. Değişiklikler KULLANICI DEĞİŞİKLİĞİ etiketiyle işaretlenir.',
      ),
    );
    pop.append(head, sub);

    const makeField = (
      labelText: string,
      valueText: () => string,
      isModified: () => boolean,
      min: number,
      max: number,
      step: number,
      initialVal: number,
      onSlide: (v: number) => void,
    ) => {
      const wrap = el('div', 'param-field');
      const row = el('div', 'param-label-row');
      const left = el('span', undefined, labelText);
      const pill = el('span', 'override-pill', ui('USER OVERRIDE', 'DEĞİŞTİRİLDİ'));
      pill.hidden = !isModified();
      const valStrong = el('strong', undefined, valueText());
      row.append(left, valStrong);

      const input = el('input');
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(initialVal);
      input.setAttribute('aria-label', labelText);

      input.addEventListener('input', () => {
        onSlide(Number(input.value));
        valStrong.textContent = valueText();
        pill.hidden = !isModified();
        renderSelectors();
        renderDetails();
        notifyUpdated(false);
      });
      input.addEventListener('change', () => notifyUpdated(true));

      const metaRow = el('div', 'param-label-row');
      metaRow.append(pill);
      wrap.append(row, input, metaRow);
      return wrap;
    };

    const setOv = (patch: Partial<TraverserOverride>) => {
      const next = { ...(overrides.get(base.id) ?? {}), ...patch };
      overrides.set(base.id, next);
    };

    // 1. Slope limit slider
    const slopeMax = Math.max(35, Math.ceil(base.azami_egim_derece * 1.5));
    pop.append(
      makeField(
        ui('Slope limit', 'Azami eğim limiti'),
        () => `${(overrides.get(base.id)?.maxSlopeDeg ?? base.azami_egim_derece).toFixed(1)}°`,
        () => present(overrides.get(base.id)?.maxSlopeDeg) && Math.abs(overrides.get(base.id)!.maxSlopeDeg! - base.azami_egim_derece) > 1e-6,
        5,
        slopeMax,
        0.5,
        effective.azami_egim_derece,
        (v) => setOv({ maxSlopeDeg: v }),
      ),
    );

    // 2. Speed multiplier slider
    const topEntry0 = base.hiz_tablosu[0];
    const topBaseKmh = present(topEntry0?.hiz_km_sa) ? topEntry0.hiz_km_sa : (topEntry0?.hiz_m_s ?? 1 / 3.6) * 3.6;
    pop.append(
      makeField(
        ui('Speed factor', 'Hız çarpanı'),
        () => {
          const s = overrides.get(base.id)?.speedScale ?? 1;
          return `${s.toFixed(2)}× (${(topBaseKmh * s).toFixed(2)} km/h @ 0°)`;
        },
        () => present(overrides.get(base.id)?.speedScale) && Math.abs(overrides.get(base.id)!.speedScale! - 1) > 1e-6,
        0.25,
        2.0,
        0.05,
        ov.speedScale ?? 1,
        (v) => setOv({ speedScale: v }),
      ),
    );

    // 3. Max duration / suit budget (when traverser has azami_sure_saat in JSON)
    if (present(base.azami_sure_saat)) {
      const durMax = Math.max(16, Math.ceil(base.azami_sure_saat * 2));
      pop.append(
        makeField(
          ui('Time / suit budget', 'Süre / yaşam destek bütçesi'),
          () => `${(overrides.get(base.id)?.maxDurationHours ?? base.azami_sure_saat!).toFixed(1)} h`,
          () =>
            present(overrides.get(base.id)?.maxDurationHours) &&
            Math.abs(overrides.get(base.id)!.maxDurationHours! - base.azami_sure_saat!) > 1e-6,
          1,
          durMax,
          0.2,
          effective.azami_sure_saat ?? base.azami_sure_saat,
          (v) => setOv({ maxDurationHours: v }),
        ),
      );
    }

    // 4. Radial standoff cap (when traverser has uzaklik_tavani_m in JSON)
    if (present(base.uzaklik_tavani_m)) {
      const baseKm = base.uzaklik_tavani_m / 1000;
      const radMax = Math.max(25, Math.ceil(baseKm * 2));
      pop.append(
        makeField(
          ui('Max radial standoff', 'Kuş uçuşu mesafe tavanı'),
          () => `${(overrides.get(base.id)?.radialCapKm ?? baseKm).toFixed(1)} km`,
          () =>
            present(overrides.get(base.id)?.radialCapKm) &&
            Math.abs(overrides.get(base.id)!.radialCapKm! - baseKm) > 1e-3,
          1,
          radMax,
          0.5,
          (effective.uzaklik_tavani_m ?? base.uzaklik_tavani_m) / 1000,
          (v) => setOv({ radialCapKm: v }),
        ),
      );
    }

    // 5. Stint budget slider (EVA / Sol split budget, sefer_mesafe_m)
    if (present(base.sefer_mesafe_m)) {
      const isRover = base.id === 'rover';
      const minStint = isRover ? 50 : 2000;
      const maxStint = isRover ? 1000 : Math.ceil(base.sefer_mesafe_m * 2);
      const stepStint = isRover ? 10 : 200;
      pop.append(
        makeField(
          isRover ? ui('Sol split budget', 'Sol başı bölme bütçesi') : ui('EVA / day split budget', 'EVA / günlük bölme bütçesi'),
          () => {
            const m = overrides.get(base.id)?.stintDistM ?? base.sefer_mesafe_m!;
            return isRover ? `${Math.round(m)} m/sol` : `${(m / 1000).toFixed(1)} km`;
          },
          () =>
            present(overrides.get(base.id)?.stintDistM) &&
            Math.abs(overrides.get(base.id)!.stintDistM! - base.sefer_mesafe_m!) >= 1,
          minStint,
          maxStint,
          stepStint,
          effective.sefer_mesafe_m ?? base.sefer_mesafe_m,
          (v) => setOv({ stintDistM: v }),
        ),
      );
    }

    const foot = el('div', 'params-pop-foot');
    const jsonStatus = el(
      'span',
      'source',
      anyOverridden
        ? ui('Modified from JSON baseline', 'JSON varsayılanından değiştirildi')
        : ui('Using JSON baseline', 'JSON varsayılanı aktif'),
    );
    const resetBtn = el('button', 'sim-btn', ui('Reset to JSON baseline', 'JSON Varsayılanına Sıfırla'));
    resetBtn.type = 'button';
    resetBtn.disabled = !anyOverridden;
    resetBtn.addEventListener('click', () => {
      overrides.delete(base.id);
      renderSelectors();
      renderDetails();
      renderPopover();
      notifyUpdated(true);
    });
    foot.append(jsonStatus, resetBtn);
    pop.append(foot);
  };

  function selectTraverser(id: string, emitChange: boolean): void {
    if (!baseline.some((b) => b.id === id)) return;
    if (id !== 'rover') lastCrewedId = id;
    if (activeId === id) return;
    activeId = id;
    renderSelectors();
    renderDetails();
    if (sandboxUI?.paramsPopoverRoot && !sandboxUI.paramsPopoverRoot.hidden) renderPopover();
    if (emitChange) notifyUpdated(true);
  }

  if (sandboxUI?.paramsButton && sandboxUI?.paramsPopoverRoot) {
    sandboxUI.paramsButton.addEventListener('click', () => {
      const pop = sandboxUI.paramsPopoverRoot!;
      const opening = pop.hidden;
      if (opening) renderPopover();
      pop.hidden = !opening;
      sandboxUI.paramsButton!.setAttribute('aria-expanded', String(opening));
    });
  }

  renderSelectors();
  renderDetails();
  if (sandboxUI?.paramsPopoverRoot && !sandboxUI.paramsPopoverRoot.hidden) renderPopover();

  onLangChange(() => {
    renderSelectors();
    renderDetails();
    if (sandboxUI?.paramsPopoverRoot && !sandboxUI.paramsPopoverRoot.hidden) renderPopover();
  });

  return {
    selectById(id: string) {
      selectTraverser(id, true);
    },
    getEffectiveTraversers: getEffectiveList,
    setScenarioContext(scenario, nextGrid, nextLander) {
      currentScenario = scenario;
      if (nextGrid) activeGrid = nextGrid;
      if (nextLander !== undefined) activeLander = nextLander;
      if (scenario === 'rover') {
        const roverTarget = baseline.find((b) => b.id === 'rover');
        if (roverTarget) activeId = roverTarget.id;
      } else {
        const crewList = scenarioList('crewed');
        const preferred = crewList.find((b) => b.id === lastCrewedId) ?? crewList[0];
        if (preferred) {
          activeId = preferred.id;
          lastCrewedId = preferred.id;
        }
      }
      renderSelectors();
      renderDetails();
      if (sandboxUI?.paramsPopoverRoot && !sandboxUI.paramsPopoverRoot.hidden) renderPopover();
      const { effective, effectiveList } = getActivePair();
      return { active: effective, effectiveList };
    },
  };
}
