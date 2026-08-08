// Tuning values for the simulation. Every number here traces back to a
// decision recorded in the PRD; see the reference in each comment.

/**
 * Arena is 19x19 tiles. An odd size is deliberate: the red zone (see
 * _applyRedZone in match.js) collapses one full ring at a time counted inward
 * from the border, and on an odd grid that sequence converges on exactly one
 * walkable centre tile rather than a leftover 2x2 block. That single-point
 * convergence is what makes the shrink look symmetric as it closes in,
 * instead of visibly favouring one side once only a small block is left.
 * PRD §3.1 originally specified 20x20; this intentionally deviates from it.
 */
export const GRID = 19;

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

/**
 * Demo mode: bots move at a fraction of a human's speed so a presenter can
 * reliably chase one down and land a kill on camera, instead of the outcome
 * depending on luck. Human players are completely unaffected — this only
 * scales bot speed in Match.addPlayer. Set to 1 to restore equal-speed bots.
 */
export const BOT_SPEED_MULTIPLIER = 0.55;

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
