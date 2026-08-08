import { EventEmitter } from "node:events";
import {
  GRID,
  TILE,
  TICK_MS,
  GRACE_MS,
  SHRINK_INTERVAL_MS,
  BOMB_FUSE_MS,
  FLAME_DURATION_MS,
  BASE_SPEED,
  SPEED_STEP,
  MAX_SPEED,
  PLAYER_SIZE,
  BASE_BOMBS,
  MAX_BOMBS,
  BASE_BLAST,
  MAX_BLAST,
  POWERUP,
  POWERUP_DROP_CHANCE,
  DEATH,
} from "./constants.js";
import { generateMap, makeRng, ringOf, tileAt, setTile, isSolid, blocksBlast, SPAWNS } from "./arena.js";
import { MatchLog } from "./matchLog.js";

let bombSeq = 0;

/**
 * Authoritative simulation for one match.
 *
 * Emits:
 *  - "death"     { victim, killer|null, cause }   one per elimination
 *  - "tickDeaths" [death, ...]                    all deaths from a single tick
 *  - "state"     snapshot                         broadcast payload
 *  - "mapUpdate" { tiles }                        after destruction / collapse
 *  - "finished"  { winner }                       exactly once
 *
 * Deaths are emitted grouped per tick as well as individually. Grouping is what
 * lets the settlement layer collapse a late-game burst into a single
 * `processKillBatch` call instead of queueing several txs behind one relayer's
 * sequential nonce (PRD §5.3).
 */
export class Match extends EventEmitter {
  constructor({ matchId, seed }) {
    super();
    this.matchId = matchId;
    this.seed = seed;
    this.rng = makeRng(seed ^ 0x9e3779b9);
    this.tiles = generateMap(seed);
    this.log = new MatchLog(matchId, seed);

    /** @type {Map<string, object>} */
    this.players = new Map();
    /** @type {Map<number, object>} */
    this.bombs = new Map();
    /** @type {Array<{x:number,y:number,until:number,ownerId:string}>} */
    this.flames = [];
    /** @type {Map<number, {x:number,y:number,type:string}>} */
    this.powerups = new Map();

    this.state = "lobby";
    this.tick = 0;
    this.startedAt = null;
    this.safeRing = 1; // rings < safeRing have collapsed; ring 0 is the wall
    this.nextShrinkAt = null;
    this.timer = null;
    this.usedSpawns = new Set();
  }

  // ------------------------------------------------------------------
  // Lobby
  // ------------------------------------------------------------------

  addPlayer({ id, address, name, isBot }) {
    if (this.players.has(id)) return this.players.get(id);

    // Spread spawns out instead of filling in order, so a half-empty demo lobby
    // does not cluster everyone in one corner.
    let spawnIndex = -1;
    const order = [0, 15, 3, 12, 5, 10, 6, 9, 1, 14, 2, 13, 4, 11, 7, 8];
    for (const i of order) {
      if (!this.usedSpawns.has(i)) {
        spawnIndex = i;
        break;
      }
    }
    if (spawnIndex === -1) return null;
    this.usedSpawns.add(spawnIndex);

    const spawn = SPAWNS[spawnIndex];
    const player = {
      id,
      address: address.toLowerCase(),
      name,
      isBot: Boolean(isBot),
      spawnIndex,
      x: spawn.x + 0.5,
      y: spawn.y + 0.5,
      alive: true,
      kills: 0,
      earnings: 0n,
      maxBombs: BASE_BOMBS,
      blastRadius: BASE_BLAST,
      speed: BASE_SPEED,
      activeBombs: 0,
      input: { up: false, down: false, left: false, right: false },
      wantBomb: false,
      deathCause: null,
      diedAtTick: null,
      placedAt: Date.now(),
    };

    this.players.set(id, player);
    this.log.append("join", { playerId: id, address: player.address, name, isBot: player.isBot, spawnIndex });
    return player;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    // Mid-match disconnects must still resolve on chain, otherwise the player's
    // bounty would sit in the vault until the timeout escape hatch.
    if (this.state === "running" && p.alive) {
      this._killPlayer(p, null, DEATH.ENVIRONMENT, []);
    } else if (this.state === "lobby") {
      this.usedSpawns.delete(p.spawnIndex);
      this.players.delete(id);
    }
  }

  setInput(id, input) {
    const p = this.players.get(id);
    if (!p || !p.alive) return;
    p.input = {
      up: Boolean(input.up),
      down: Boolean(input.down),
      left: Boolean(input.left),
      right: Boolean(input.right),
    };
  }

  requestBomb(id) {
    const p = this.players.get(id);
    if (!p || !p.alive) return;
    p.wantBomb = true;
  }

  get alivePlayers() {
    return [...this.players.values()].filter((p) => p.alive);
  }

  // ------------------------------------------------------------------
  // Loop
  // ------------------------------------------------------------------

  start() {
    if (this.state !== "lobby") return;
    this.state = "running";
    this.startedAt = Date.now();
    this.nextShrinkAt = this.startedAt + GRACE_MS;
    this.log.append("match_start", { players: this.players.size, gracePeriodMs: GRACE_MS });

    this.timer = setInterval(() => {
      try {
        this._step();
      } catch (err) {
        // A crash inside the loop must not leave the interval spinning and
        // spamming the same error forever.
        this.emit("error", err);
        this.stop();
      }
    }, TICK_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  _step() {
    if (this.state !== "running") return;
    const now = Date.now();
    this.tick++;

    const deaths = [];

    this._movePlayers();
    this._collectPowerups();
    this._placeBombs(now);
    this._detonate(now, deaths);
    this._expireFlames(now);
    this._applyRedZone(now, deaths);
    this._checkFlameDeaths(now, deaths);

    if (deaths.length > 0) {
      this.emit("tickDeaths", deaths);
      for (const d of deaths) this.emit("death", d);
    }

    this.emit("state", this.snapshot());

    this._checkWin();
  }

  // ------------------------------------------------------------------
  // Movement
  // ------------------------------------------------------------------

  _movePlayers() {
    const dt = TICK_MS / 1000;

    for (const p of this.players.values()) {
      if (!p.alive) continue;

      let dx = 0;
      let dy = 0;
      if (p.input.left) dx -= 1;
      if (p.input.right) dx += 1;
      if (p.input.up) dy -= 1;
      if (p.input.down) dy += 1;
      if (dx === 0 && dy === 0) continue;

      // Normalise so diagonal movement is not faster than orthogonal.
      if (dx !== 0 && dy !== 0) {
        const inv = Math.SQRT1_2;
        dx *= inv;
        dy *= inv;
      }

      const dist = p.speed * dt;
      // Resolve axes independently so sliding along a wall works instead of
      // stopping dead when one axis is blocked.
      this._tryMove(p, dx * dist, 0);
      this._tryMove(p, 0, dy * dist);
    }
  }

  _tryMove(p, dx, dy) {
    if (dx === 0 && dy === 0) return;
    const nx = p.x + dx;
    const ny = p.y + dy;
    if (!this._collides(nx, ny)) {
      p.x = nx;
      p.y = ny;
    }
  }

  /** AABB against the tile grid: checks the four corners of the player box. */
  _collides(cx, cy) {
    const h = PLAYER_SIZE / 2;
    const corners = [
      [cx - h, cy - h],
      [cx + h, cy - h],
      [cx - h, cy + h],
      [cx + h, cy + h],
    ];
    for (const [x, y] of corners) {
      if (isSolid(this.tiles, Math.floor(x), Math.floor(y))) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------
  // Bombs
  // ------------------------------------------------------------------

  _placeBombs(now) {
    for (const p of this.players.values()) {
      if (!p.wantBomb) continue;
      p.wantBomb = false;
      if (!p.alive) continue;
      if (p.activeBombs >= p.maxBombs) continue;

      const tx = Math.floor(p.x);
      const ty = Math.floor(p.y);
      if (this._bombAt(tx, ty)) continue;

      const bomb = {
        id: ++bombSeq,
        ownerId: p.id,
        x: tx,
        y: ty,
        explodeAt: now + BOMB_FUSE_MS,
        blastRadius: p.blastRadius,
      };
      this.bombs.set(bomb.id, bomb);
      p.activeBombs++;
      this.log.append("bomb_placed", { playerId: p.id, x: tx, y: ty, tick: this.tick });
    }
  }

  _bombAt(x, y) {
    for (const b of this.bombs.values()) if (b.x === x && b.y === y) return b;
    return null;
  }

  _detonate(now, deaths) {
    const queue = [];
    for (const b of this.bombs.values()) {
      if (b.explodeAt <= now) queue.push(b);
    }
    if (queue.length === 0) return;

    const destroyed = [];
    const exploded = new Set();

    // Breadth-first so one bomb catching another chains, without recursing into
    // a cycle when two bombs are inside each other's blast.
    while (queue.length > 0) {
      const bomb = queue.shift();
      if (exploded.has(bomb.id)) continue;
      exploded.add(bomb.id);

      this.bombs.delete(bomb.id);
      const owner = this.players.get(bomb.ownerId);
      if (owner) owner.activeBombs = Math.max(0, owner.activeBombs - 1);

      const cells = [{ x: bomb.x, y: bomb.y }];
      const dirs = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ];

      for (const [dx, dy] of dirs) {
        for (let step = 1; step <= bomb.blastRadius; step++) {
          const x = bomb.x + dx * step;
          const y = bomb.y + dy * step;

          if (blocksBlast(this.tiles, x, y)) break;

          cells.push({ x, y });

          if (tileAt(this.tiles, x, y) === TILE.SOFT) {
            setTile(this.tiles, x, y, TILE.EMPTY);
            destroyed.push({ x, y });
            this._maybeDropPowerup(x, y);
            break; // a soft block absorbs the rest of the blast
          }

          const chained = this._bombAt(x, y);
          if (chained && !exploded.has(chained.id)) queue.push(chained);
        }
      }

      for (const c of cells) {
        this.flames.push({ x: c.x, y: c.y, until: now + FLAME_DURATION_MS, ownerId: bomb.ownerId });
      }

      this.log.append("bomb_exploded", {
        bombId: bomb.id,
        ownerId: bomb.ownerId,
        x: bomb.x,
        y: bomb.y,
        radius: bomb.blastRadius,
        tick: this.tick,
      });
    }

    if (destroyed.length > 0) this.emit("mapUpdate", { destroyed });
  }

  _maybeDropPowerup(x, y) {
    if (this.rng() >= POWERUP_DROP_CHANCE) return;
    const types = [POWERUP.EXTRA_BOMB, POWERUP.BLAST_RADIUS, POWERUP.SPEED];
    const type = types[Math.floor(this.rng() * types.length)];
    const key = y * GRID + x;
    this.powerups.set(key, { x, y, type });
  }

  _collectPowerups() {
    if (this.powerups.size === 0) return;
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const key = Math.floor(p.y) * GRID + Math.floor(p.x);
      const pu = this.powerups.get(key);
      if (!pu) continue;
      this.powerups.delete(key);

      if (pu.type === POWERUP.EXTRA_BOMB) p.maxBombs = Math.min(MAX_BOMBS, p.maxBombs + 1);
      else if (pu.type === POWERUP.BLAST_RADIUS) p.blastRadius = Math.min(MAX_BLAST, p.blastRadius + 1);
      else if (pu.type === POWERUP.SPEED) p.speed = Math.min(MAX_SPEED, p.speed + SPEED_STEP);

      this.log.append("powerup", { playerId: p.id, type: pu.type, x: pu.x, y: pu.y, tick: this.tick });
    }
  }

  _expireFlames(now) {
    if (this.flames.length === 0) return;
    this.flames = this.flames.filter((f) => f.until > now);
  }

  // ------------------------------------------------------------------
  // Deaths
  // ------------------------------------------------------------------

  _checkFlameDeaths(now, deaths) {
    if (this.flames.length === 0) return;

    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const px = Math.floor(p.x);
      const py = Math.floor(p.y);

      const flame = this.flames.find((f) => f.x === px && f.y === py && f.until > now);
      if (!flame) continue;

      // The three-way split from PRD §3.3 is decided right here: a blast from
      // your own bomb has no beneficiary and must not be paid out as a PvP kill.
      const selfInflicted = flame.ownerId === p.id;
      const killer = selfInflicted ? null : this.players.get(flame.ownerId) ?? null;
      const cause = selfInflicted ? DEATH.SELF : DEATH.PVP;

      this._killPlayer(p, killer, cause, deaths);
    }
  }

  _applyRedZone(now, deaths) {
    if (this.nextShrinkAt === null || now < this.nextShrinkAt) return;

    const ring = this.safeRing;
    const maxRing = Math.floor(GRID / 2) - 1;
    if (ring > maxRing) {
      this.nextShrinkAt = null;
      return;
    }

    // One full ring collapses at once (PRD §3.1). Collapsing a row/column at a
    // time would need 36 steps, far too slow for a match this length.
    const collapsed = [];
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        if (ringOf(x, y) !== ring) continue;
        setTile(this.tiles, x, y, TILE.COLLAPSED);
        this.powerups.delete(y * GRID + x);
        collapsed.push({ x, y });
      }
    }

    this.safeRing = ring + 1;
    this.nextShrinkAt = now + SHRINK_INTERVAL_MS;
    this.log.append("ring_collapsed", { ring, tick: this.tick });
    this.emit("mapUpdate", { collapsed, ring });

    // Anyone standing on the ring dies as an environment death: no killer, so
    // the whole bounty rolls into the jackpot.
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      if (ringOf(Math.floor(p.x), Math.floor(p.y)) <= ring) {
        this._killPlayer(p, null, DEATH.ENVIRONMENT, deaths);
      }
    }
  }

  _killPlayer(victim, killer, cause, deaths) {
    if (!victim.alive) return;
    victim.alive = false;
    victim.deathCause = cause;
    victim.diedAtTick = this.tick;

    if (killer && killer.id !== victim.id) killer.kills++;

    const record = {
      matchId: this.matchId,
      victim: { id: victim.id, address: victim.address, name: victim.name },
      killer: killer ? { id: killer.id, address: killer.address, name: killer.name } : null,
      cause,
      tick: this.tick,
      at: { x: Number(victim.x.toFixed(3)), y: Number(victim.y.toFixed(3)) },
    };

    this.log.append("death", {
      victimId: victim.id,
      victimAddress: victim.address,
      killerId: killer ? killer.id : null,
      killerAddress: killer ? killer.address : null,
      cause,
      tick: this.tick,
      x: record.at.x,
      y: record.at.y,
    });

    deaths.push(record);
  }

  _checkWin() {
    if (this.state !== "running") return;
    const alive = this.alivePlayers;
    if (alive.length > 1) return;

    let winner = alive[0] ?? null;
    let rule = "last_standing";

    if (!winner) {
      // Mutual destruction. Bomberman makes this genuinely reachable: one blast
      // can kill its own owner and the last opponent in the same tick, and the
      // red zone can take the final two together.
      //
      // Leaving the match without a winner is the worst option available: the
      // contract pays exactly one address, so the entire $16 pot would sit in the
      // vault until the one-hour timeout, recoverable only piecemeal through
      // emergencyWithdraw. Instead the win goes to whoever was still standing in
      // the final tick, most kills first. The rule is recorded in the match log
      // so the payout stays explainable from the published audit trail.
      winner = this._lastStandWinner();
      rule = "last_stand_tiebreak";
    }

    this.state = "finished";
    this.stop();
    this.log.append("match_end", {
      winnerId: winner ? winner.id : null,
      winnerAddress: winner ? winner.address : null,
      winnerRule: winner ? rule : "none",
      tick: this.tick,
    });
    this.emit("finished", { winner, rule });
  }

  /** Highest-scoring player among those eliminated in the final tick. */
  _lastStandWinner() {
    const players = [...this.players.values()];
    if (players.length === 0) return null;

    const finalTick = Math.max(...players.map((p) => p.diedAtTick ?? -1));
    const contenders = players.filter((p) => (p.diedAtTick ?? -1) === finalTick);
    if (contenders.length === 0) return null;

    // Sort deterministically: a replay of the same log must name the same winner.
    contenders.sort((a, b) => {
      if (b.kills !== a.kills) return b.kills - a.kills;
      if (a.spawnIndex !== b.spawnIndex) return a.spawnIndex - b.spawnIndex;
      return a.id < b.id ? -1 : 1;
    });

    return contenders[0];
  }

  // ------------------------------------------------------------------
  // Serialisation
  // ------------------------------------------------------------------

  /** Full map, sent once when a client joins or the match starts. */
  mapPayload() {
    return {
      grid: GRID,
      seed: this.seed,
      tiles: Array.from(this.tiles),
    };
  }

  /** Per-tick delta. Kept small: positions are rounded to 2dp because the client
   *  interpolates anyway, and full precision would triple the payload. */
  snapshot() {
    const now = Date.now();
    return {
      matchId: this.matchId,
      state: this.state,
      tick: this.tick,
      safeRing: this.safeRing,
      nextShrinkInMs: this.nextShrinkAt ? Math.max(0, this.nextShrinkAt - now) : null,
      elapsedMs: this.startedAt ? now - this.startedAt : 0,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        address: p.address,
        isBot: p.isBot,
        x: Number(p.x.toFixed(2)),
        y: Number(p.y.toFixed(2)),
        alive: p.alive,
        kills: p.kills,
        earnings: p.earnings.toString(),
        maxBombs: p.maxBombs,
        blastRadius: p.blastRadius,
        deathCause: p.deathCause,
      })),
      bombs: [...this.bombs.values()].map((b) => ({
        id: b.id,
        x: b.x,
        y: b.y,
        ownerId: b.ownerId,
        fuseRemainingMs: Math.max(0, b.explodeAt - now),
      })),
      flames: this.flames.map((f) => ({ x: f.x, y: f.y })),
      powerups: [...this.powerups.values()],
    };
  }
}
