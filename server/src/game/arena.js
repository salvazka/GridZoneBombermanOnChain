import { GRID, TILE, SOFT_BLOCK_DENSITY } from "./constants.js";

/**
 * Small deterministic PRNG (mulberry32).
 *
 * The map is generated from a seed that is recorded in the match log, so anyone
 * holding the log can rebuild the exact arena and replay the match. That is what
 * makes the auditability story in PRD §5.4 actually checkable rather than
 * aspirational.
 */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Ring index of a tile, counting inward from the border. Drives the red zone. */
export function ringOf(x, y) {
  return Math.min(x, y, GRID - 1 - x, GRID - 1 - y);
}

/**
 * Sixteen spawn points on odd coordinates so nobody starts inside the hard
 * lattice, spread far enough apart to avoid the instant spawn-kills that made
 * 32 players unworkable on this grid (PRD §9.1).
 */
export const SPAWNS = (() => {
  const coords = [1, 7, 11, 17];
  const out = [];
  for (const y of coords) for (const x of coords) out.push({ x, y });
  return out;
})();

/**
 * Classic Bomberman layout: solid border, an indestructible lattice on
 * even/even coordinates, destructible blocks scattered over the rest.
 */
export function generateMap(seed) {
  const rng = makeRng(seed);
  const tiles = new Uint8Array(GRID * GRID);
  const idx = (x, y) => y * GRID + x;

  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const isBorder = x === 0 || y === 0 || x === GRID - 1 || y === GRID - 1;
      const isLattice = x % 2 === 0 && y % 2 === 0;
      tiles[idx(x, y)] = isBorder || isLattice ? TILE.HARD : TILE.EMPTY;
    }
  }

  // Keep an L-shaped pocket around every spawn clear, so a player always has at
  // least two escape routes before they have blown anything up.
  const protected_ = new Set();
  for (const s of SPAWNS) {
    for (const [dx, dy] of [
      [0, 0],
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [2, 0],
      [-2, 0],
      [0, 2],
      [0, -2],
    ]) {
      const x = s.x + dx;
      const y = s.y + dy;
      if (x > 0 && y > 0 && x < GRID - 1 && y < GRID - 1) protected_.add(idx(x, y));
    }
  }

  for (let y = 1; y < GRID - 1; y++) {
    for (let x = 1; x < GRID - 1; x++) {
      const i = idx(x, y);
      if (tiles[i] !== TILE.EMPTY) continue;
      if (protected_.has(i)) continue;
      if (rng() < SOFT_BLOCK_DENSITY) tiles[i] = TILE.SOFT;
    }
  }

  return tiles;
}

export function tileAt(tiles, x, y) {
  if (x < 0 || y < 0 || x >= GRID || y >= GRID) return TILE.HARD;
  return tiles[y * GRID + x];
}

export function setTile(tiles, x, y, value) {
  if (x < 0 || y < 0 || x >= GRID || y >= GRID) return;
  tiles[y * GRID + x] = value;
}

/** Blocks movement. Collapsed tiles stay walkable so the red zone kills rather
 *  than silently trapping a player against an invisible wall. */
export function isSolid(tiles, x, y) {
  const t = tileAt(tiles, x, y);
  return t === TILE.HARD || t === TILE.SOFT;
}

/** Blocks blast propagation. */
export function blocksBlast(tiles, x, y) {
  return tileAt(tiles, x, y) === TILE.HARD;
}
