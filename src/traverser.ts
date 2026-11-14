// AI-assisted code: written with Claude (Anthropic) and Antigravity (Google DeepMind), reviewed by the team.
//
// Traverser selector, built entirely from mobilite_parametreleri.json. Shows
// each parameter of the selected traverser (and landing craft constraints)
// together with its stated source and confidence level.

import type { ConfidenceLevel, GridMeta, LandingCraftParams, Traverser } from './data';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const present = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

const CONFIDENCE_LABELS_EN: Record<string, string> = {
  olculmus: 'measured',
  tasarim_degeri: 'design value',
  olceklenmis: 'scaled',
  varsayim: 'ASSUMPTION',
};

function formatConfidence(raw?: ConfidenceLevel): string | null {
  if (!raw) return null;
  const mapped = CONFIDENCE_LABELS_EN[raw.toLowerCase()];
  return mapped ?? raw;
}

function formatMeta(kaynak?: string, guven?: ConfidenceLevel): string {
  const src = kaynak || 'not stated';
  const conf = formatConfidence(guven);
  return conf ? `Source: ${src} · Confidence: ${conf}` : `Source: ${src}`;
}

function parameterRows(t: Traverser): { label: string; value: string; key: string }[] {
  const speeds = t.hiz_tablosu
    .map((entry) =>
      present(entry.hiz_km_sa)
        ? `${entry.hiz_km_sa} km/h (${entry.hiz_m_s.toFixed(2)} m/s) at ${entry.egim_derece}°`
        : `${entry.hiz_m_s} m/s at ${entry.egim_derece}°`,
    )
    .join(', ');
  const rows: { label: string; value: string; key: string }[] = [
    { label: 'Slope limit', value: `${t.azami_egim_derece}°`, key: 'azami_egim_derece' },
  ];
  if (present(t.yurume_baz_hiz_km_sa)) {
    rows.push({ label: 'Base walk speed', value: `${t.yurume_baz_hiz_km_sa} km/h`, key: 'yurume_baz_hiz_km_sa' });
  }
  rows.push({ label: 'Speed by slope', value: speeds, key: 'hiz_tablosu' });
  if (present(t.uzaklik_tavani_m)) {
    const km = Number((t.uzaklik_tavani_m / 1000).toFixed(2));
    rows.push({ label: 'Max radial standoff', value: `${km} km (${Math.round(t.uzaklik_tavani_m)} m)`, key: 'uzaklik_tavani_m' });
  }
  if (present(t.yasam_destek_tasarim_saat)) {
    rows.push({ label: 'Suit design duration', value: `${t.yasam_destek_tasarim_saat} h`, key: 'yasam_destek_tasarim_saat' });
  }
  if (present(t.sure_payi)) {
    rows.push({ label: 'Life-support margin factor', value: String(t.sure_payi), key: 'sure_payi' });
  }
  if (present(t.azami_sure_saat)) rows.push({ label: 'Max duration budget', value: `${t.azami_sure_saat} h`, key: 'azami_sure_saat' });
  if (present(t.azami_engel_m)) rows.push({ label: 'Max obstacle', value: `${t.azami_engel_m} m`, key: 'azami_engel_m' });
  if (t.enerji_profili) {
    const ep = t.enerji_profili;
    const reserveWh = Math.round(ep.enerji_kapasite_wh * ep.rezerv_orani);
    const usableWh = Math.round(ep.enerji_kalan_wh - reserveWh);
    rows.push({
      label: 'Energy profile (demo)',
      value: `${ep.profil_adi_en} — ${ep.kutle_kg} kg, ${usableWh} Wh usable + ${reserveWh} Wh reserve`,
      key: 'enerji_profili',
    });
  }
  if (present(t.enerji_katsayisi)) rows.push({ label: 'Energy coefficient', value: String(t.enerji_katsayisi), key: 'enerji_katsayisi' });
  return rows;
}

function landingRows(lc: LandingCraftParams): { label: string; value: string; key: string }[] {
  const rows: { label: string; value: string; key: string }[] = [];
  if (present(lc.guvenli_alan_capi_m)) {
    rows.push({ label: 'Safe landing circle Ø', value: `${lc.guvenli_alan_capi_m} m`, key: 'guvenli_alan_capi_m' });
  }
  if (present(lc.azami_egim_derece)) {
    rows.push({ label: 'Lander slope limit', value: `${lc.azami_egim_derece}°`, key: 'azami_egim_derece' });
  }
  if (present(lc.azami_kaya_m)) {
    rows.push({ label: 'Lander max rock', value: `${lc.azami_kaya_m} m`, key: 'azami_kaya_m' });
  }
  if (present(lc.azami_yukseklik_m)) {
    rows.push({ label: 'Lander max elevation', value: `${lc.azami_yukseklik_m} m`, key: 'azami_yukseklik_m' });
  }
  return rows;
}

export interface TraverserSelectorController {
  selectById(id: string): void;
}

export function findWalkBackReference(traversers: Traverser[], current: Traverser): { walker: Traverser; limitHours: number; source?: string; conf?: ConfidenceLevel } | null {
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
): TraverserSelectorController {
  root.replaceChildren();

  const group = el('div', 'traverser-options');
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', 'Traverser type');
  const noteEl = el('p', 'traverser-note');
  const details = el('details', 'traverser-details');
  const summary = el('summary', undefined, 'How mobility limits were chosen (parameters & sources)');
  const cellScaleNote = present(grid?.hucre_m)
    ? `Computed with ${grid!.hucre_m} m resolution data; obstacles smaller than this scale were not evaluated. `
    : '';
  const methodNote = el(
    'p',
    'route-note',
    `${cellScaleNote}Every limit, speed table and duration budget is read from mobilite_parametreleri.json with its source and confidence tag. Model boundaries: undirected slope magnitude only (no directed uphill/downhill search; conservative uphill walking speeds used for walk-back), science stops visited in user-selected order (no TSP stop reordering), no turn-angle penalty, rock and thermal inertia data not available (assumed firm, rock-free baseline), and demo vehicle energy evaluated post-hoc on the selected route.`,
  );
  const list = el('dl', 'facts');
  details.append(summary, methodNote, list);

  const slopeBaselineM = grid?.egim_taban_uzunlugu_m;

  const showParameters = (t: Traverser): void => {
    noteEl.textContent = t.aciklama_en ?? '';
    noteEl.hidden = !t.aciklama_en;
    list.replaceChildren();
    if (present(slopeBaselineM) && slopeBaselineM > 0) {
      const dd = el('dd', undefined, `${slopeBaselineM} m`);
      dd.append(el('span', 'source', grid?.egim_yontemi_en || 'Grid slope measurement baseline (izgara.json)'));
      list.append(el('dt', undefined, 'Slope baseline'), dd);
    }
    if (grid?.kaynak_en) {
      const dd = el('dd', undefined, grid.kaynak_en);
      if (grid.guven_notu_en) dd.append(el('span', 'source', `Confidence: ${grid.guven_notu_en}`));
      list.append(el('dt', undefined, 'Cost grid'), dd);
    }
    for (const row of parameterRows(t)) {
      const dd = el('dd', undefined, row.value);
      dd.append(el('span', 'source', formatMeta(t.kaynaklar[row.key], t.guvenler[row.key])));
      list.append(el('dt', undefined, row.label), dd);
    }
    const wb = findWalkBackReference(traversers, t);
    if (wb) {
      const dd = el('dd', undefined, `${wb.limitHours} h (elapsed + walk-back ≤ suit limit; walk ≤ ${wb.walker.azami_egim_derece}°)`);
      dd.append(el('span', 'source', `${formatMeta(wb.source, wb.conf)} · Walk speeds from "${wb.walker.ad_en}"`));
      list.append(el('dt', undefined, 'Walk-back limit'), dd);
    }
    if (landingCraft) {
      for (const row of landingRows(landingCraft)) {
        const dd = el('dd', undefined, row.value);
        dd.append(el('span', 'source', formatMeta(landingCraft.kaynaklar[row.key], landingCraft.guvenler[row.key])));
        list.append(el('dt', undefined, row.label), dd);
      }
    }
  };

  const radios = new Map<string, { radio: HTMLInputElement; traverser: Traverser }>();

  traversers.forEach((t, index) => {
    const label = el('label', 'traverser-option');
    const radio = el('input');
    radio.type = 'radio';
    radio.name = 'traverser';
    radio.value = t.id;
    radio.checked = index === 0;
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      showParameters(t);
      onChange(t);
    });
    radios.set(t.id, { radio, traverser: t });
    label.append(radio, el('span', 'traverser-name', t.ad_en), el('span', 'traverser-limit', `≤ ${t.azami_egim_derece}°`));
    group.append(label);
  });

  showParameters(traversers[0]);
  root.append(group, noteEl, details);

  return {
    selectById(id: string) {
      const found = radios.get(id);
      if (!found || found.radio.checked) return;
      found.radio.checked = true;
      showParameters(found.traverser);
      onChange(found.traverser);
    },
  };
}
