// AI-assisted code: written with Claude (Anthropic), reviewed by the team.
//
// Traverser selector, built entirely from mobilite_parametreleri.json. Shows
// each parameter of the selected traverser together with its stated source.

import type { Traverser } from './data';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const present = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

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

export function initTraverserSelector(traversers: Traverser[], root: HTMLElement, onChange: (traverser: Traverser) => void): void {
  root.replaceChildren();

  const group = el('div', 'traverser-options');
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', 'Traverser type');
  const details = el('details', 'traverser-details');
  const summary = el('summary', undefined, 'Parameters and sources');
  const list = el('dl', 'facts');
  details.append(summary, list);

  const showParameters = (t: Traverser): void => {
    list.replaceChildren();
    for (const row of parameterRows(t)) {
      const dd = el('dd', undefined, row.value);
      dd.append(el('span', 'source', `Source: ${t.kaynaklar?.[row.key] ?? 'not stated'}`));
      list.append(el('dt', undefined, row.label), dd);
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
  root.append(group, details);
}
