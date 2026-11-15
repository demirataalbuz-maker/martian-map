// AI-assisted code: written with Claude (Anthropic) and Antigravity (Google DeepMind), reviewed by the team.
//
// Science stops from veri/duraklar.json: a marker per stop; tapping it opens a
// card with the description, the surface photo (when one is provided) and a
// button that adds the stop to the route.

import { Marker, Popup, type Map as MlMap } from 'maplibre-gl';
import { DATA_DIR } from './config';
import type { ScienceStop } from './data';
import { onLangChange, ui } from './i18n';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export interface StopsController {
  setFilter(predicate: ((stop: ScienceStop) => boolean) | null): void;
}

export function initStops(map: MlMap, stops: ScienceStop[], onAddToRoute: (stop: ScienceStop) => void): StopsController {
  const updaters: (() => void)[] = [];
  const entries: { stop: ScienceStop; marker: Marker; popup: Popup }[] = [];

  for (const stop of stops) {
    const popup = new Popup({ offset: 16, maxWidth: '280px', closeButton: true });
    const element = el('button', 'stop-marker');
    element.type = 'button';
    element.title = stop.ad_en;
    element.addEventListener('click', (event) => event.stopPropagation());

    const buildCard = () => {
      const card = el('div', 'stop-card');
      card.append(el('h3', undefined, stop.ad_en));
      if (stop.aciklama_en) card.append(el('p', undefined, stop.aciklama_en));

      if (stop.foto) {
        const figure = el('figure');
        const img = el('img');
        img.src = `${DATA_DIR}/${stop.foto}`;
        img.alt = ui(`Surface photo at ${stop.ad_en}`, `${stop.ad_en} yüzey fotoğrafı`);
        img.loading = 'lazy';
        img.addEventListener('error', () =>
          figure.replaceChildren(el('p', 'stop-nophoto', ui('Photo could not be loaded.', 'Fotoğraf yüklenemedi.'))),
        );
        figure.append(img);
        figure.append(
          el(
            'figcaption',
            undefined,
            stop.foto_kaynak
              ? ui(`Credit: ${stop.foto_kaynak}`, `Kaynak: ${stop.foto_kaynak}`)
              : ui('Credit: not stated', 'Kaynak: belirtilmedi'),
          ),
        );
        card.append(figure);
      } else {
        card.append(el('p', 'stop-nophoto', ui('No surface photo provided for this stop.', 'Bu durak için yüzey fotoğrafı sağlanmadı.')));
      }

      const add = el('button', 'stop-add', ui('Add to route', 'Rotaya ekle'));
      add.type = 'button';
      add.addEventListener('click', () => {
        onAddToRoute(stop);
        popup.remove();
      });
      card.append(add);
      popup.setDOMContent(card);
      element.setAttribute('aria-label', ui(`Science stop: ${stop.ad_en}`, `Bilim durağı: ${stop.ad_en}`));
    };

    buildCard();
    updaters.push(buildCard);

    const marker = new Marker({ element }).setLngLat(stop.konum).addTo(map);
    entries.push({ stop, marker, popup });
    element.addEventListener('click', () => {
      if (popup.isOpen()) popup.remove();
      else popup.setLngLat(stop.konum).addTo(map);
    });
  }

  onLangChange(() => {
    for (const u of updaters) u();
  });

  return {
    setFilter(predicate) {
      for (const entry of entries) {
        const show = predicate ? predicate(entry.stop) : true;
        entry.marker.getElement().style.display = show ? '' : 'none';
        if (!show && entry.popup.isOpen()) entry.popup.remove();
      }
    },
  };
}
