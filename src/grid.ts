// AI-assisted code: written with Claude (Anthropic), reviewed by the team.
//
// Conversion between cost-grid cells and [longitude, latitude].
// Coordinates are used ONLY to place things on screen. Distances and times are
// always computed from the grid (cells x hucre_m), never from coordinates.

import type { GridMeta, LonLat } from './data';

export interface GridGeo {
  readonly width: number;
  readonly height: number;
  /** Centre of a cell. */
  cellToLonLat(col: number, row: number): LonLat;
  indexToLonLat(index: number): LonLat;
  /** Cell index (row * width + col) under a coordinate, or null when outside the grid. */
  lonLatToIndex(lon: number, lat: number): number | null;
}

/**
 * The grid is treated as a parallelogram spanned by its NW, NE and SW corners
 * (row 0 = north edge, column 0 = west edge).
 */
export function makeGridGeo(meta: GridMeta): GridGeo {
  const [nw, ne, , sw] = meta.koseler;
  const ax = ne[0] - nw[0]; // along columns
  const ay = ne[1] - nw[1];
  const bx = sw[0] - nw[0]; // along rows
  const by = sw[1] - nw[1];
  const det = ax * by - bx * ay;
  if (Math.abs(det) < 1e-18) throw new Error('izgara.json: corner coordinates are degenerate');
  const { genislik: width, yukseklik: height } = meta;

  const cellToLonLat = (col: number, row: number): LonLat => {
    const u = (col + 0.5) / width;
    const v = (row + 0.5) / height;
    return [nw[0] + u * ax + v * bx, nw[1] + u * ay + v * by];
  };

  return {
    width,
    height,
    cellToLonLat,
    indexToLonLat: (index) => cellToLonLat(index % width, Math.floor(index / width)),
    lonLatToIndex: (lon, lat) => {
      const px = lon - nw[0];
      const py = lat - nw[1];
      const u = (px * by - bx * py) / det;
      const v = (ax * py - px * ay) / det;
      if (u < 0 || u >= 1 || v < 0 || v >= 1) return null;
      return Math.floor(v * height) * width + Math.floor(u * width);
    },
  };
}
