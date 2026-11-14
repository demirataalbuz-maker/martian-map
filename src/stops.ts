// AI-assisted code: written with Claude (Anthropic), reviewed by the team.
//
// Science stops from veri/duraklar.json: a marker per stop; tapping it opens a
// card with the description, the surface photo (when one is provided) and a
// button that adds the stop to the route.

import { Marker, Popup, type Map as MlMap } from 'maplibre-gl';
import { DATA_DIR } from './config';
import type { ScienceStop } from './data';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function initStops(map: MlMap, stops: ScienceStop[], onAddToRoute: (stop: ScienceStop) => void): void {
  for (const stop of stops) {
    const card = el('div', 'stop-card');
    card.append(el('h3', undefined, stop.ad_en));
    if (stop.aciklama_en) card.append(el('p', undefined, stop.aciklama_en));

    if (stop.foto) {
      const figure = el('figure');
      const img = el('img');
      img.src = `${DATA_DIR}/${stop.foto}`;
      img.alt = `Surface photo at ${stop.ad_en}`;
      img.loading = 'lazy';
      img.addEventListener('error', () => figure.replaceChildren(el('p', 'stop-nophoto', 'Photo could not be loaded.')));
      figure.append(img);
      figure.append(el('figcaption', undefined, stop.foto_kaynak ? `Credit: ${stop.foto_kaynak}` : 'Credit: not stated'));
      card.append(figure);
    } else {
      card.append(el('p', 'stop-nophoto', 'No surface photo provided for this stop.'));
    }

    const popup = new Popup({ offset: 16, maxWidth: '280px', closeButton: true });
    const add = el('button', 'stop-add', 'Add to route');
    add.type = 'button';
    add.addEventListener('click', () => {
      onAddToRoute(stop);
      popup.remove();
    });
    card.append(add);
    popup.setDOMContent(card);

    const element = el('button', 'stop-marker');
    element.type = 'button';
    element.title = stop.ad_en;
    element.setAttribute('aria-label', `Science stop: ${stop.ad_en}`);
    // Keep the tap from reaching the map, where it would add a route point.
    element.addEventListener('click', (event) => event.stopPropagation());

    new Marker({ element }).setLngLat(stop.konum).addTo(map);
    element.addEventListener('click', () => {
      if (popup.isOpen()) popup.remove();
      else popup.setLngLat(stop.konum).addTo(map);
    });
  }
}
