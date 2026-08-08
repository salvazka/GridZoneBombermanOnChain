// Tuning values for the simulation. Every number here traces back to a
// decision recorded in the PRD; see the reference in each comment.

/** Arena is 20x20 tiles (PRD §3.1). */
export const GRID = 20;

/** Server tick rate. PRD §9.5: 20-30Hz with client interpolation is the right
 *  target for a discrete-state grid game; 60 FPS is a client render metric. */
export const TICK_HZ = 30;
export const TICK_MS = 1000 / TICK_HZ;

/** Tile ids. */
export const TILE = {
  EMPTY: 0,
  HARD: 1,
  SOFT: 2,
  COLLAPSED: 3,
};

/** Red zone: no shrink for the first 40s, then one full ring per 15s (PRD §3.1).
 *  Ring 0 is the outer wall, so the first collapse that can kill is ring 1. */
export const GRACE_MS = 40_000;
export const SHRINK_INTERVAL_MS = 15_000;

/** Bomb behaviour. */
export const BOMB_FUSE_MS = 2_500;
export const FLAME_DURATION_MS = 500;

/** Movement, in tiles per second. */
export const BASE_SPEED = 3.6;
export const SPEED_STEP = 0.9;
export const MAX_SPEED = 7.2;

/** Player collision box, in tiles. Slightly under 1 so corners are forgiving. */
export const PLAYER_SIZE = 0.72;

/** Power-up caps (PRD §3.2). */
export const BASE_BOMBS = 1;
export const MAX_BOMBS = 6;
export const BASE_BLAST = 1;
export const MAX_BLAST = 6;

export const POWERUP = {
  EXTRA_BOMB: "extra_bomb",
  BLAST_RADIUS: "blast_radius",
  SPEED: "speed",
};

/** Fraction of eligible interior tiles that become destructible blocks. */
export const SOFT_BLOCK_DENSITY = 0.55;

/** Chance a destroyed soft block drops a power-up. */
export const POWERUP_DROP_CHANCE = 0.35;

/** Lobby size (PRD §9.1: 16 on a 20x20 grid, ~12.5 tiles per player). */
export const LOBBY_SIZE = 16;

/** How long to wait for more humans before filling the lobby with bots. */
export const LOBBY_COUNTDOWN_MS = 10_000;

/** Countdown once the lobby is full and bots are seated. */
export const START_DELAY_MS = 3_000;

/** Death causes, mapped to the three settlement paths in PRD §3.3. */
export const DEATH = {
  PVP: "pvp",
  SELF: "self",
  ENVIRONMENT: "environment",
};
