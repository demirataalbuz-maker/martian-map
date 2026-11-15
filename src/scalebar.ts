// AI-assisted code: written with Claude (Anthropic) and Antigravity (Google DeepMind), reviewed by the team.
//
// Scale bar drawn from the cost grid, NOT from the map library: map libraries
// assume Earth's radius. Ground distance comes from the grid (cells x hucre_m);
// the map is only asked where the grid's corners land on screen.

import type { Map as MlMap } from 'maplibre-gl';
import type { GridMeta } from './data';

const MAX_BAR_PX = 140;
const NICE_STEPS = [1, 2, 5];

function niceLength(maxMetres: number): number {
  const pow = 10 ** Math.floor(Math.log10(maxMetres));
  let best = pow;
  for (const step of NICE_STEPS) if (step * pow <= maxMetres) best = step * pow;
  return best;
}

export interface ScaleBarController {
  setGrid(nextGrid: GridMeta): void;
  setVisible(visible: boolean): void;
}

export function attachScaleBar(map: MlMap, grid: GridMeta, root: HTMLElement): ScaleBarController {
  const line = root.querySelector<HTMLElement>('.scalebar-line')!;
  const label = root.querySelector<HTMLElement>('.scalebar-label')!;
  let activeGrid = grid;
  let visible = true;

  const update = () => {
    if (!visible) return;
    const widthMetres = activeGrid.genislik * activeGrid.hucre_m;
    const nw = map.project(activeGrid.koseler[0]);
    const ne = map.project(activeGrid.koseler[1]);
    const widthPx = Math.hypot(ne.x - nw.x, ne.y - nw.y);
    if (!(widthPx > 0)) return;
    const metresPerPx = widthMetres / widthPx;
    const metres = niceLength(MAX_BAR_PX * metresPerPx);
    line.style.width = `${metres / metresPerPx}px`;
    label.textContent = metres >= 1000 ? `${metres / 1000} km` : `${metres} m`;
  };

  map.on('move', update);
  map.on('resize', update);
  update();

  return {
    setGrid(nextGrid) {
      activeGrid = nextGrid;
      update();
    },
    setVisible(nextVisible) {
      visible = nextVisible;
      root.style.display = visible ? '' : 'none';
      if (visible) update();
    },
  };
}
