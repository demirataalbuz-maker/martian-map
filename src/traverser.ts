// AI-assisted code: written with Claude (Anthropic) and Antigravity (Google DeepMind), reviewed by the team.
//
// Traverser selector, built entirely from mobilite_parametreleri.json. Shows
// each parameter of the selected traverser (and landing craft constraints)
// together with its stated source and confidence level.

import type { ConfidenceLevel, LandingCraftParams, Traverser } from './data';

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
  const speeds = t.hiz_tablosu.map((entry) => `${entry.hiz_m_s} m/s at ${entry.egim_derece}°`).join(', ');
  const rows = [
    { label: 'Slope limit', value: `${t.azami_egim_derece}°`, key: 'azami_egim_derece' },
    { label: 'Speed by slope', value: speeds, key: 'hiz_tablosu' },
  ];
  if (present(t.azami_engel_m)) rows.push({ label: 'Max obstacle', value: `${t.azami_engel_m} m`, key: 'azami_engel_m' });
  if (present(t.azami_sure_saat)) rows.push({ label: 'Max duration', value: `${t.azami_sure_saat} h`, key: 'azami_sure_saat' });
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

export function initTraverserSelector(
  traversers: Traverser[],
  landingCraft: LandingCraftParams | null,
  root: HTMLElement,
  onChange: (traverser: Traverser) => void,
  slopeBaselineM?: number,
): void {
  root.replaceChildren();

  const group = el('div', 'traverser-options');
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', 'Traverser type');
  const noteEl = el('p', 'traverser-note');
  const details = el('details', 'traverser-details');
  const summary = el('summary', undefined, 'Parameters, sources & confidence');
  const list = el('dl', 'facts');
  details.append(summary, list);

  const showParameters = (t: Traverser): void => {
    noteEl.textContent = t.aciklama_en ?? '';
    noteEl.hidden = !t.aciklama_en;
    list.replaceChildren();
    if (present(slopeBaselineM) && slopeBaselineM > 0) {
      const dd = el('dd', undefined, `${slopeBaselineM} m`);
      dd.append(el('span', 'source', 'Grid slope measurement baseline (izgara.json)'));
      list.append(el('dt', undefined, 'Slope baseline'), dd);
    }
    for (const row of parameterRows(t)) {
      const dd = el('dd', undefined, row.value);
      dd.append(el('span', 'source', formatMeta(t.kaynaklar[row.key], t.guvenler[row.key])));
      list.append(el('dt', undefined, row.label), dd);
    }
    if (landingCraft) {
      for (const row of landingRows(landingCraft)) {
        const dd = el('dd', undefined, row.value);
        dd.append(el('span', 'source', formatMeta(landingCraft.kaynaklar[row.key], landingCraft.guvenler[row.key])));
        list.append(el('dt', undefined, row.label), dd);
      }
    }
  };

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
    label.append(radio, el('span', 'traverser-name', t.ad_en), el('span', 'traverser-limit', `≤ ${t.azami_egim_derece}°`));
    group.append(label);
  });

  showParameters(traversers[0]);
  root.append(group, noteEl, details);
}
