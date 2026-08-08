import { GRID, TILE, BOMB_FUSE_MS } from "./constants.js";
import { tileAt, ringOf, isSolid, blocksBlast } from "./arena.js";

/**
 * Heuristic bots so a lobby can reach 16 players without 16 humans (PRD §9.3).
 *
 * Deliberately simple and readable rather than strong. The priority order is
 * survival first, then farming, then aggression, because a bot that blows itself
 * up immediately makes the demo look broken, and a bot that never dies makes the
 * match never end. They re-decide a few times a second rather than every tick:
 * 30Hz decisions produce visible jitter as the bot flip-flops between equally
 * good directions.
 */

// Demo mode: bots re-decide (re-plan escapes, notice danger, retarget) more
// slowly than the original 140ms, on top of their reduced movement speed
// (constants.js BOT_SPEED_MULTIPLIER). A slower reaction time means a bot
// closing in on a human takes visibly longer to react to an incoming bomb,
// which is what actually makes it easy to land an on-camera elimination
// rather than just easy to outrun.
const DECISION_INTERVAL_MS = 320;

const DIRS = [
  { dx: 0, dy: -1, key: "up" },
  { dx: 0, dy: 1, key: "down" },
  { dx: -1, dy: 0, key: "left" },
  { dx: 1, dy: 0, key: "right" },
];

export class BotController {
  constructor(match) {
    this.match = match;
    /** @type {Map<string, {lastDecision:number, path:Array<{x:number,y:number}>, plantedAt:number}>} */
    this.memory = new Map();
  }

  /** Called once per simulation tick; internally rate-limited. */
  step() {
    const match = this.match;
    if (match.state !== "running") return;
    const now = Date.now();

    const danger = this._dangerMap(now);

    for (const p of match.players.values()) {
      if (!p.isBot || !p.alive) continue;

      let mem = this.memory.get(p.id);
      if (!mem) {
        mem = { lastDecision: 0, path: [], plantedAt: 0 };
        this.memory.set(p.id, mem);
      }

      if (now - mem.lastDecision < DECISION_INTERVAL_MS) {
        this._followPath(p, mem);
        continue;
      }
      mem.lastDecision = now;

      this._decide(p, mem, danger, now);
      this._followPath(p, mem);
    }
  }

  /**
   * Tiles that are lethal now or will be before a bot could cross them.
   * Values: 2 = active flame, 1 = inside a live bomb's blast, 0 = safe.
   */
  _dangerMap(now) {
    const match = this.match;
    const danger = new Uint8Array(GRID * GRID);

    for (const f of match.flames) {
      if (f.until > now) danger[f.y * GRID + f.x] = 2;
    }

    for (const bomb of match.bombs.values()) {
      danger[bomb.y * GRID + bomb.x] = Math.max(danger[bomb.y * GRID + bomb.x], 1);
      for (const { dx, dy } of DIRS) {
        for (let step = 1; step <= bomb.blastRadius; step++) {
          const x = bomb.x + dx * step;
          const y = bomb.y + dy * step;
          if (blocksBlast(match.tiles, x, y)) break;
          danger[y * GRID + x] = Math.max(danger[y * GRID + x], 1);
          if (tileAt(match.tiles, x, y) === TILE.SOFT) break;
        }
      }
    }

    // The next ring to collapse is a death sentence, so treat it as danger even
    // though nothing has exploded there.
    const nextRing = match.safeRing;
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        if (ringOf(x, y) < nextRing) danger[y * GRID + x] = 2;
        else if (ringOf(x, y) === nextRing && match.nextShrinkAt && match.nextShrinkAt - now < 4000) {
          danger[y * GRID + x] = Math.max(danger[y * GRID + x], 1);
        }
      }
    }

    return danger;
  }

  _decide(p, mem, danger, now) {
    const match = this.match;
    const tx = Math.floor(p.x);
    const ty = Math.floor(p.y);

    // 1. Standing somewhere lethal: nothing else matters.
    if (danger[ty * GRID + tx] > 0) {
      const escape = this._bfs(tx, ty, (x, y) => danger[y * GRID + x] === 0, danger, true);
      mem.path = escape ?? [];
      p.wantBomb = false;
      return;
    }

    // 2. Recently planted: keep moving away rather than admiring the bomb.
    if (now - mem.plantedAt < BOMB_FUSE_MS) {
      if (mem.path.length > 0) return;
      const away = this._bfs(tx, ty, (x, y) => danger[y * GRID + x] === 0 && (x !== tx || y !== ty), danger, true);
      mem.path = away ?? [];
      return;
    }

    // 3. Enemy in line and in range: attack, but only if an escape exists.
    if (p.activeBombs < p.maxBombs && this._enemyInBlast(p, tx, ty)) {
      if (this._hasEscape(tx, ty, danger, p.blastRadius)) {
        p.wantBomb = true;
        mem.plantedAt = now;
        mem.path = [];
        return;
      }
    }

    // 4. Adjacent soft block: farm it for power-ups.
    if (p.activeBombs < p.maxBombs && this._adjacentSoft(tx, ty)) {
      if (this._hasEscape(tx, ty, danger, p.blastRadius)) {
        p.wantBomb = true;
        mem.plantedAt = now;
        mem.path = [];
        return;
      }
    }

    // 5. Otherwise head for something useful: a power-up, then a soft block.
    if (mem.path.length > 0) return;

    const toPowerup = this._bfs(
      tx,
      ty,
      (x, y) => match.powerups.has(y * GRID + x),
      danger,
      false,
    );
    if (toPowerup && toPowerup.length > 0) {
      mem.path = toPowerup;
      return;
    }

    const toSoft = this._bfs(tx, ty, (x, y) => this._adjacentSoft(x, y), danger, false);
    if (toSoft && toSoft.length > 0) {
      mem.path = toSoft;
      return;
    }

    // Nothing to do: drift inward, away from the shrinking edge.
    const inward = this._bfs(
      tx,
      ty,
      (x, y) => ringOf(x, y) >= match.safeRing + 2,
      danger,
      false,
    );
    mem.path = inward ?? [];
  }

  _adjacentSoft(x, y) {
    for (const { dx, dy } of DIRS) {
      if (tileAt(this.match.tiles, x + dx, y + dy) === TILE.SOFT) return true;
    }
    return false;
  }

  _enemyInBlast(p, tx, ty) {
    const match = this.match;
    for (const other of match.players.values()) {
      if (other.id === p.id || !other.alive) continue;
      const ox = Math.floor(other.x);
      const oy = Math.floor(other.y);
      if (ox !== tx && oy !== ty) continue;

      const dist = Math.abs(ox - tx) + Math.abs(oy - ty);
      if (dist === 0 || dist > p.blastRadius) continue;

      // Line of sight: a hard wall between them means the blast never arrives.
      const dx = Math.sign(ox - tx);
      const dy = Math.sign(oy - ty);
      let blocked = false;
      for (let s = 1; s <= dist; s++) {
        if (blocksBlast(match.tiles, tx + dx * s, ty + dy * s)) {
          blocked = true;
          break;
        }
      }
      if (!blocked) return true;
    }
    return false;
  }

  /**
   * Would a bomb here leave the bot somewhere safe? Simulates the prospective
   * blast, then looks for a reachable tile outside it. Without this check bots
   * routinely trap themselves in dead-end corridors.
   */
  _hasEscape(tx, ty, danger, radius) {
    const match = this.match;
    const projected = Uint8Array.from(danger);
    projected[ty * GRID + tx] = 1;

    for (const { dx, dy } of DIRS) {
      for (let step = 1; step <= radius; step++) {
        const x = tx + dx * step;
        const y = ty + dy * step;
        if (blocksBlast(match.tiles, x, y)) break;
        projected[y * GRID + x] = 1;
        if (tileAt(match.tiles, x, y) === TILE.SOFT) break;
      }
    }

    const escape = this._bfs(tx, ty, (x, y) => projected[y * GRID + x] === 0, projected, true);
    return Boolean(escape && escape.length > 0 && escape.length <= 6);
  }

  /**
   * BFS over walkable tiles.
   * @param fleeing when true, danger tiles are traversable (you may have to run
   *        through a blast zone to get out of one) but never a destination.
   */
  _bfs(startX, startY, isGoal, danger, fleeing) {
    const match = this.match;
    const visited = new Uint8Array(GRID * GRID);
    const prev = new Int32Array(GRID * GRID).fill(-1);
    const queue = [startY * GRID + startX];
    visited[startY * GRID + startX] = 1;

    let goalIdx = -1;

    while (queue.length > 0) {
      const cur = queue.shift();
      const cx = cur % GRID;
      const cy = Math.floor(cur / GRID);

      if ((cx !== startX || cy !== startY) && isGoal(cx, cy)) {
        goalIdx = cur;
        break;
      }

      for (const { dx, dy } of DIRS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID) continue;

        const nIdx = ny * GRID + nx;
        if (visited[nIdx]) continue;
        if (isSolid(match.tiles, nx, ny)) continue;
        if (tileAt(match.tiles, nx, ny) === TILE.COLLAPSED) continue;
        // An active flame is impassable either way; a mere blast zone is only
        // impassable when we are not already trying to escape one.
        if (danger[nIdx] === 2) continue;
        if (!fleeing && danger[nIdx] === 1) continue;

        visited[nIdx] = 1;
        prev[nIdx] = cur;
        queue.push(nIdx);
      }
    }

    if (goalIdx === -1) return null;

    const path = [];
    let cur = goalIdx;
    while (cur !== -1 && cur !== startY * GRID + startX) {
      path.push({ x: cur % GRID, y: Math.floor(cur / GRID) });
      cur = prev[cur];
    }
    path.reverse();
    return path;
  }

  /** Converts the next path tile into directional input. */
  _followPath(p, mem) {
    if (mem.path.length === 0) {
      p.input = { up: false, down: false, left: false, right: false };
      return;
    }

    const target = mem.path[0];
    const cx = p.x;
    const cy = p.y;
    const targetCx = target.x + 0.5;
    const targetCy = target.y + 0.5;

    const dx = targetCx - cx;
    const dy = targetCy - cy;

    // Close enough: pop the waypoint. A loose threshold keeps the bot from
    // oscillating around a tile centre it can never hit exactly.
    if (Math.abs(dx) < 0.12 && Math.abs(dy) < 0.12) {
      mem.path.shift();
      return;
    }

    // Press both axes whenever the bot is off-centre on either one. A
    // one-axis-at-a-time bot can walk straight into a corner of the
    // indestructible lattice (every even/even tile) and simply stall there
    // with no way to re-centre, since the blocked axis never gets input and
    // the other axis is already satisfied. Movement resolves each axis
    // independently anyway (see _movePlayers), so this is safe: whichever
    // axis is clear still makes progress and nudges the bot back into a gap.
    const input = { up: false, down: false, left: false, right: false };
    const THRESHOLD = 0.08;
    if (dx > THRESHOLD) input.right = true;
    else if (dx < -THRESHOLD) input.left = true;
    if (dy > THRESHOLD) input.down = true;
    else if (dy < -THRESHOLD) input.up = true;
    p.input = input;
  }

  forget(id) {
    this.memory.delete(id);
  }
}
