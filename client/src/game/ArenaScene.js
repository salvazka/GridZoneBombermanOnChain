import Phaser from "phaser";
import { colorForPlayer } from "../lib/format.js";

const TILE = { EMPTY: 0, HARD: 1, SOFT: 2, COLLAPSED: 3 };

const COLORS = {
  floorA: 0x1a0f33,
  floorB: 0x150c2b,
  gridLine: 0x2c1a52,
  // Indestructible walls need to read as *structure* at a glance, competing
  // against a neon-lit backdrop, coloured soft blocks, and coloured players.
  // A mid-tone slate wasn't enough contrast once actual gameplay art (bombs,
  // flames, actors) was on screen, so this goes further: a near-white fill
  // with a bright cyan rim light (matches nothing else in the palette) over a
  // near-black border. Nothing else in the scene is this light or has a cyan
  // outline, so a wall can't be confused with anything else regardless of
  // what's next to it.
  hard: 0xe2e8f0,
  hardShade: 0xb9c2d6,
  hardRim: 0x22d3ee,
  hardOutline: 0x020617,
  soft: 0x7c3aed,
  softTop: 0xa78bfa,
  softOutline: 0x2e1065,
  bomb: 0x1c1128,
  flameCore: 0xfef3c7,
  flameMid: 0xfb923c,
  powerBomb: 0xf43f5e,
  powerBlast: 0xfb923c,
  powerSpeed: 0x22d3ee,
};

/** How long a bomb-drop arm animation plays before returning to the walk cycle. */
const BOMB_THROW_MS = 260;

/** Radians of walk-cycle phase per (tile/second) of measured speed, per ms. */
const WALK_PHASE_RATE = 0.0075;

function darken(color, amt) {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  const f = 1 - amt;
  return (Math.round(r * f) << 16) | (Math.round(g * f) << 8) | Math.round(b * f);
}

function lighten(color, amt) {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  const lr = r + (255 - r) * amt;
  const lg = g + (255 - g) * amt;
  const lb = b + (255 - b) * amt;
  return (Math.round(lr) << 16) | (Math.round(lg) << 8) | Math.round(lb);
}

/**
 * Renders the arena from server snapshots.
 *
 * Everything is drawn with Graphics primitives rather than sprite sheets: the
 * project ships no art beyond the lobby backdrop, and neon vector shapes match
 * that backdrop better than improvised pixel art would.
 *
 * The server is authoritative at 30Hz while the browser paints at ~60fps, so
 * positions are interpolated toward the latest snapshot instead of being snapped.
 * Snapping is clearly visible as stutter, and PRD §10 lists zero-stutter
 * gameplay as a success metric.
 */
export class ArenaScene extends Phaser.Scene {
  constructor() {
    super("arena");
    this.grid = 20;
    this.tileSize = 36;
    this.tiles = null;
    this.snapshot = null;
    this.selfId = null;
    /** @type {Map<string, {x:number,y:number}>} render positions */
    this.rendered = new Map();
    /** @type {Map<string, object>} per-player animation state (facing, walk
     *  cycle phase, bomb-throw timer, own-death flash) keyed by player id */
    this.actorAnim = new Map();
    /** @type {Map<number, {age:number, x:number, y:number}>} bomb id -> local
     *  clock, so a fresh explosion always starts its shockwave from zero even
     *  though the server tells us about it via a snapshot, not an event */
    this.knownBombs = new Map();
    /** @type {Array<object>} short-lived explosion shockwave rings + embers,
     *  driven entirely on the client between snapshots for a smooth 60fps burst
     *  instead of the server's 30Hz flame tiles alone. */
    this.blasts = [];
  }

  init(data) {
    this.grid = data?.grid ?? 20;
    this.selfId = data?.selfId ?? null;
  }

  create() {
    this.tileSize = Math.floor(this.scale.height / this.grid);

    // Explicit creation order = explicit stacking order (later = drawn on top).
    // The red zone sits above the floor/tiles but below items/actors, so a
    // player standing in it stays visible while the hazard is still obviously
    // painted over the ground beneath them. Blasts sit above actors so an
    // explosion visually overlays whoever it's about to hit.
    this.floorLayer = this.add.graphics();
    this.tileLayer = this.add.graphics();
    this.redZoneLayer = this.add.graphics();
    this.itemLayer = this.add.graphics();
    this.actorLayer = this.add.graphics();
    this.blastLayer = this.add.graphics();
    this.labelLayer = this.add.container(0, 0);

    this._drawFloor();
  }

  setSelfId(id) {
    this.selfId = id;
  }

  setMap(payload) {
    this.grid = payload.grid;
    this.tiles = Uint8Array.from(payload.tiles);
    this.tileSize = Math.floor(this.scale.height / this.grid);
    this._drawFloor();
    this._drawTiles();
  }

  applyMapUpdate({ destroyed, collapsed }) {
    if (!this.tiles) return;
    for (const c of destroyed ?? []) this.tiles[c.y * this.grid + c.x] = TILE.EMPTY;
    for (const c of collapsed ?? []) this.tiles[c.y * this.grid + c.x] = TILE.COLLAPSED;
    this._drawTiles();
  }

  setSnapshot(snapshot) {
    const previous = this.snapshot;
    this.snapshot = snapshot;

    // Seed render positions for players seen for the first time, otherwise they
    // would visibly slide in from the origin.
    for (const p of snapshot.players) {
      if (!this.rendered.has(p.id)) this.rendered.set(p.id, { x: p.x, y: p.y });
      if (!this.actorAnim.has(p.id)) {
        this.actorAnim.set(p.id, { facing: "down", walkPhase: 0, throwUntil: 0, deathAt: p.alive ? 0 : this.time?.now ?? 0 });
      }
    }
    for (const id of [...this.rendered.keys()]) {
      if (!snapshot.players.some((p) => p.id === id)) {
        this.rendered.delete(id);
        this.actorAnim.delete(id);
      }
    }

    // A newly placed bomb starts its own local age counter so the pulse and
    // eventual shockwave are perfectly smooth between the server's 30Hz ticks,
    // rather than jumping in discrete steps.
    const nowIds = new Set();
    for (const b of snapshot.bombs ?? []) {
      nowIds.add(b.id);
      if (!this.knownBombs.has(b.id)) {
        this.knownBombs.set(b.id, { x: b.x, y: b.y, ownerId: b.ownerId });
        // A bomb appearing for the first time is this client's only signal that
        // *someone* just placed one (bots included, and the local player too if
        // playBombThrow's optimistic swing already expired). Trigger the throw
        // pose here so every player's drop looks animated, not just your own.
        this.playBombThrow(b.ownerId);
      }
    }
    // A bomb id present a moment ago and gone now just detonated: spawn a
    // shockwave burst at its last known tile.
    for (const [id, info] of this.knownBombs) {
      if (!nowIds.has(id)) this._spawnBlast(info.x, info.y);
    }
    this.knownBombs = new Map([...this.knownBombs].filter(([id]) => nowIds.has(id)));

    // A tile igniting for the first time (present now, absent from the previous
    // snapshot) is also a valid trigger, e.g. for a chained bomb this client
    // never separately tracked, or the first frame flames appear at all.
    const prevFlameKeys = new Set((previous?.flames ?? []).map((f) => `${f.x},${f.y}`));
    for (const f of snapshot.flames ?? []) {
      const key = `${f.x},${f.y}`;
      if (!prevFlameKeys.has(key) && !this._hasRecentBlastAt(f.x, f.y)) {
        this._spawnEmbers(f.x, f.y);
      }
    }
  }

  _hasRecentBlastAt(x, y) {
    return this.blasts.some((b) => b.x === x && b.y === y && b.age < 80);
  }

  /** One shockwave ring plus a handful of debris chips at a detonation centre. */
  _spawnBlast(x, y) {
    this.blasts.push({ kind: "shock", x, y, age: 0, life: 420 });
    const chipCount = 6;
    for (let i = 0; i < chipCount; i++) {
      const angle = (Math.PI * 2 * i) / chipCount + Math.random() * 0.5;
      this.blasts.push({
        kind: "chip",
        x,
        y,
        age: 0,
        life: 380 + Math.random() * 160,
        angle,
        dist: 0.55 + Math.random() * 0.35,
      });
    }
    this._spawnEmbers(x, y);
  }

  /** Small ember flecks over a burning tile; purely decorative, layered above
   *  the flat flame-tile fill that already carries the actual hazard reading. */
  _spawnEmbers(x, y) {
    for (let i = 0; i < 3; i++) {
      this.blasts.push({
        kind: "ember",
        x,
        y,
        age: 0,
        life: 260 + Math.random() * 220,
        angle: -Math.PI / 2 + (Math.random() - 0.5) * 1.4,
        dist: 0.2 + Math.random() * 0.3,
      });
    }
  }

  update(_time, delta) {
    if (!this.snapshot) return;

    // Exponential smoothing, framerate independent. ~18% of the remaining gap
    // per 16ms frame: fast enough to feel responsive, slow enough to hide the
    // 33ms gaps between snapshots.
    const alpha = 1 - Math.pow(1 - 0.18, delta / 16.67);

    for (const p of this.snapshot.players) {
      const r = this.rendered.get(p.id);
      if (!r) continue;

      const dx = p.x - r.x;
      const dy = p.y - r.y;
      r.x += dx * alpha;
      r.y += dy * alpha;

      const anim = this.actorAnim.get(p.id);
      if (anim && p.alive) {
        const moveSpeed = Math.hypot(dx, dy);
        if (moveSpeed > 0.01) {
          if (Math.abs(dx) > Math.abs(dy)) anim.facing = dx > 0 ? "right" : "left";
          else anim.facing = dy > 0 ? "down" : "up";
          anim.walkPhase += delta * WALK_PHASE_RATE * Math.min(3, 1 + moveSpeed * 40);
        }
      }
    }

    if (this.blasts.length > 0) {
      for (const b of this.blasts) b.age += delta;
      this.blasts = this.blasts.filter((b) => b.age < b.life);
    }

    this._drawItems();
    this._drawRedZone();
    this._drawActors();
    this._drawBlasts();
  }

  /** Called by main.js right when the local player's own bomb key is pressed,
   *  so the arm swings out even before the server snapshot confirms the bomb
   *  exists. Purely cosmetic: the server remains authoritative for whether the
   *  bomb was actually placed. */
  playBombThrow(playerId) {
    const anim = this.actorAnim.get(playerId);
    if (anim) anim.throwUntil = (this.time?.now ?? 0) + BOMB_THROW_MS;
  }

  // ------------------------------------------------------------------
  // Drawing
  // ------------------------------------------------------------------

  _drawFloor() {
    const g = this.floorLayer;
    const ts = this.tileSize;
    g.clear();

    for (let y = 0; y < this.grid; y++) {
      for (let x = 0; x < this.grid; x++) {
        g.fillStyle((x + y) % 2 === 0 ? COLORS.floorA : COLORS.floorB, 1);
        g.fillRect(x * ts, y * ts, ts, ts);
      }
    }

    g.lineStyle(1, COLORS.gridLine, 0.55);
    for (let i = 0; i <= this.grid; i++) {
      g.lineBetween(i * ts, 0, i * ts, this.grid * ts);
      g.lineBetween(0, i * ts, this.grid * ts, i * ts);
    }
  }

  _drawTiles() {
    const g = this.tileLayer;
    const ts = this.tileSize;
    g.clear();
    if (!this.tiles) return;

    for (let y = 0; y < this.grid; y++) {
      for (let x = 0; x < this.grid; x++) {
        const t = this.tiles[y * this.grid + x];
        const px = x * ts;
        const py = y * ts;

        if (t === TILE.HARD) {
          this._drawHardWall(g, px, py, ts);
        } else if (t === TILE.SOFT) {
          g.fillStyle(COLORS.soft, 1);
          g.fillRoundedRect(px + 1, py + 1, ts - 2, ts - 2, 3);
          g.lineStyle(1, COLORS.softOutline, 0.9);
          g.strokeRoundedRect(px + 1, py + 1, ts - 2, ts - 2, 3);
          g.fillStyle(COLORS.softTop, 0.85);
          g.fillRect(px + 3, py + 3, ts - 6, Math.max(2, ts * 0.12));
        }
        // TILE.COLLAPSED (the red zone) is intentionally NOT drawn here: it is
        // rendered separately in _drawRedZone as an animated full-screen
        // overlay, because a per-tile fill this same weight as everything else
        // is exactly what made it hard to spot in the first place.
      }
    }
  }

  /**
   * An indestructible wall block. Bomberman's lattice needs to look completely
   * different from every other thing on screen (floor, soft blocks, players,
   * bombs, flames), so this uses a light near-white panel with a glowing cyan
   * rim and a near-black outline — the only light-coloured, cyan-rimmed shape
   * in the whole arena. The outline is drawn on every wall tile regardless of
   * neighbours, so a wall is never camouflaged by whatever happens to sit next
   * to it.
   */
  _drawHardWall(g, px, py, ts) {
    const inset = 1.5;

    // Glow first, underneath, so it bleeds slightly onto neighbouring tiles.
    g.fillStyle(COLORS.hardRim, 0.35);
    g.fillRect(px - 1, py - 1, ts + 2, ts + 2);

    g.fillStyle(COLORS.hardOutline, 1);
    g.fillRect(px, py, ts, ts);

    g.fillStyle(COLORS.hard, 1);
    g.fillRect(px + inset, py + inset, ts - inset * 2, ts - inset * 2);

    // Rim light on the top/left edges only, the classic "lit from above" cue.
    g.lineStyle(Math.max(1.5, ts * 0.06), COLORS.hardRim, 0.9);
    g.beginPath();
    g.moveTo(px + inset, py + ts - inset);
    g.lineTo(px + inset, py + inset);
    g.lineTo(px + ts - inset, py + inset);
    g.strokePath();

    // A darker inset panel reads as a rivet/plate rather than a flat card.
    const pad = ts * 0.22;
    g.fillStyle(COLORS.hardShade, 1);
    g.fillRect(px + pad, py + pad, ts - pad * 2, ts - pad * 2);
  }

  /**
   * The red zone (collapsed ring), rendered as one continuous animated overlay
   * across every collapsed tile rather than per-tile fills. A pulsing crimson
   * wash plus a moving hazard-stripe pattern reads immediately as "the floor
   * is gone here" even next to bright flames, coloured blocks, or players,
   * which a static maroon square did not survive visually once the rest of
   * the scene was busy.
   */
  _drawRedZone() {
    if (!this.tiles) return;
    const g = this.redZoneLayer;
    const ts = this.tileSize;
    g.clear();

    const t = this.time.now;
    const pulse = 0.75 + Math.sin(t / 260) * 0.15;

    for (let y = 0; y < this.grid; y++) {
      for (let x = 0; x < this.grid; x++) {
        if (this.tiles[y * this.grid + x] !== TILE.COLLAPSED) continue;
        const px = x * ts;
        const py = y * ts;

        g.fillStyle(0x1a0308, 1);
        g.fillRect(px, py, ts, ts);
        g.fillStyle(0xdc0f35, 0.55 * pulse);
        g.fillRect(px, py, ts, ts);

        // Diagonal hazard stripes, geometrically clipped to this tile's own
        // square so a stripe can never bleed into a neighbouring tile. Each
        // stripe is the line x - y = c intersected with [0,ts]x[0,ts]; c is
        // animated over time so the pattern visibly crawls like a barrier.
        const spacing = Math.max(4, ts * 0.22);
        const phase = (t / 18) % spacing;
        g.lineStyle(Math.max(1.5, ts * 0.09), 0xf43f5e, 0.7);
        for (let c = -ts + phase; c < ts; c += spacing) {
          const x0 = Math.max(0, c);
          const x1 = Math.min(ts, ts + c);
          if (x1 <= x0) continue;
          g.lineBetween(px + x0, py + (x0 - c), px + x1, py + (x1 - c));
        }

        g.lineStyle(Math.max(1, ts * 0.05), 0xfecdd3, 0.8 * pulse);
        g.strokeRect(px + 1, py + 1, ts - 2, ts - 2);
      }
    }
  }

  _drawItems() {
    const g = this.itemLayer;
    const ts = this.tileSize;
    g.clear();
    const snap = this.snapshot;

    for (const pu of snap.powerups ?? []) {
      const cx = pu.x * ts + ts / 2;
      const cy = pu.y * ts + ts / 2;
      const color =
        pu.type === "extra_bomb"
          ? COLORS.powerBomb
          : pu.type === "blast_radius"
            ? COLORS.powerBlast
            : COLORS.powerSpeed;

      const pulse = 0.82 + Math.sin(this.time.now / 220) * 0.12;
      g.fillStyle(color, 0.22);
      g.fillCircle(cx, cy, ts * 0.42 * pulse);
      g.fillStyle(color, 1);
      g.fillRoundedRect(cx - ts * 0.2, cy - ts * 0.2, ts * 0.4, ts * 0.4, 3);
      g.fillStyle(0xffffff, 0.9);
      g.fillRect(cx - ts * 0.06, cy - ts * 0.06, ts * 0.12, ts * 0.12);
    }

    for (const b of snap.bombs ?? []) {
      const cx = b.x * ts + ts / 2;
      const cy = b.y * ts + ts / 2;
      // Pulse accelerates as the fuse runs down, so the danger is legible
      // without a numeric countdown on every bomb.
      const urgency = 1 - Math.min(1, b.fuseRemainingMs / 2500);
      const beat = Math.sin(this.time.now / (150 - urgency * 100));
      const radius = ts * (0.3 + urgency * 0.06) + beat * ts * 0.04;

      g.fillStyle(0xf43f5e, 0.16 + urgency * 0.3);
      g.fillCircle(cx, cy, radius * 1.7);
      g.fillStyle(COLORS.bomb, 1);
      g.fillCircle(cx, cy, radius);
      g.lineStyle(2, 0xf43f5e, 0.75 + urgency * 0.25);
      g.strokeCircle(cx, cy, radius);
      g.fillStyle(COLORS.flameCore, 1);
      g.fillCircle(cx + radius * 0.45, cy - radius * 0.75, Math.max(1.5, ts * 0.06));
    }

    for (const f of snap.flames ?? []) {
      this._drawFlameTile(g, f.x, f.y, ts);
    }
  }

  /**
   * One burning tile, rendered as a flickering multi-layer flame rather than a
   * flat orange square. Layers, largest to smallest: a soft glow bleeding into
   * neighbours, a licking outer flame whose points jitter per-frame, a hotter
   * inner flame, and a near-white core. The whole thing also fades out over its
   * last ~150ms so a flame tile visibly dies instead of vanishing on the tick
   * the server clears it.
   */
  _drawFlameTile(g, x, y, ts) {
    const cx = x * ts + ts / 2;
    const cy = y * ts + ts / 2;
    const t = this.time.now;

    // Two independent jitter signals (position + amplitude) so the flame reads
    // as turbulent rather than a single pulsing shape.
    const jitterA = Math.sin(t / 55 + x * 1.7 + y * 2.3);
    const jitterB = Math.sin(t / 37 + x * 0.9 - y * 1.1);
    const flicker = 0.85 + jitterA * 0.1 + jitterB * 0.06;

    g.fillStyle(COLORS.flameMid, 0.22);
    g.fillCircle(cx, cy, ts * 0.62 * flicker);

    const points = 6;
    const outer = [];
    for (let i = 0; i < points; i++) {
      const a = (Math.PI * 2 * i) / points + t / 900;
      const wobble = 0.34 + Math.sin(t / 70 + i * 1.9 + x) * 0.08;
      outer.push(new Phaser.Math.Vector2(cx + Math.cos(a) * ts * wobble, cy + Math.sin(a) * ts * wobble * 0.92));
    }
    g.fillStyle(COLORS.flameMid, 0.85 * flicker);
    g.fillPoints(outer, true);

    const innerPoints = [];
    for (let i = 0; i < points; i++) {
      const a = (Math.PI * 2 * i) / points + t / 620 + 0.5;
      const wobble = 0.2 + Math.sin(t / 60 + i * 2.4 + y) * 0.05;
      innerPoints.push(new Phaser.Math.Vector2(cx + Math.cos(a) * ts * wobble, cy + Math.sin(a) * ts * wobble * 0.85 - ts * 0.05));
    }
    g.fillStyle(0xfca94f, 0.9);
    g.fillPoints(innerPoints, true);

    g.fillStyle(COLORS.flameCore, 0.95);
    g.fillCircle(cx, cy - ts * 0.04, ts * (0.12 + jitterB * 0.02));
  }

  /** Client-only shockwave rings, debris chips, and embers, layered on top of
   *  the actual (server-authoritative) flame tiles so a detonation reads as an
   *  event rather than just tiles silently switching state. Purely cosmetic:
   *  nothing here affects who lives or dies. */
  _drawBlasts() {
    const g = this.blastLayer;
    const ts = this.tileSize;
    g.clear();

    for (const b of this.blasts) {
      const t = Math.min(1, b.age / b.life);
      const cx = b.x * ts + ts / 2;
      const cy = b.y * ts + ts / 2;

      if (b.kind === "shock") {
        // Expanding ring that thins and fades: the classic "boom" read.
        const radius = ts * (0.15 + t * 1.05);
        const alpha = (1 - t) * 0.8;
        g.lineStyle(Math.max(1, ts * 0.12 * (1 - t)), 0xfff4d6, alpha);
        g.strokeCircle(cx, cy, radius);
        g.fillStyle(0xffe9a8, alpha * 0.5);
        g.fillCircle(cx, cy, ts * (0.3 * (1 - t)));
      } else if (b.kind === "chip") {
        // A debris chip flying outward then arcing down under fake gravity.
        const travel = Math.sin((t * Math.PI) / 2) * ts * b.dist * 1.6;
        const drop = t * t * ts * 0.35;
        const px = cx + Math.cos(b.angle) * travel;
        const py = cy + Math.sin(b.angle) * travel + drop;
        const size = Math.max(1, ts * 0.09 * (1 - t * 0.7));
        g.fillStyle(0xd8b4fe, 0.9 * (1 - t));
        g.fillRect(px - size / 2, py - size / 2, size, size);
      } else {
        // Ember: a small rising, fading spark.
        const travel = t * ts * b.dist * 1.4;
        const px = cx + Math.cos(b.angle) * travel * 0.4;
        const py = cy + Math.sin(b.angle) * travel;
        const size = Math.max(1, ts * 0.05 * (1 - t));
        g.fillStyle(0xffd88a, 0.9 * (1 - t));
        g.fillCircle(px, py, size);
      }
    }
  }

  _drawActors() {
    const g = this.actorLayer;
    const ts = this.tileSize;
    g.clear();
    this.labelLayer.removeAll(true);

    const snap = this.snapshot;
    const now = this.time.now;

    for (const p of snap.players) {
      if (!p.alive) continue;
      const r = this.rendered.get(p.id);
      if (!r) continue;
      const anim = this.actorAnim.get(p.id) ?? { facing: "down", walkPhase: 0, throwUntil: 0 };

      const cx = r.x * ts;
      const cy = r.y * ts;
      const color = colorForPlayer(p.id);
      const isSelf = p.id === this.selfId;
      const bodyR = ts * 0.32;
      const isThrowing = now < anim.throwUntil;
      const throwT = isThrowing ? 1 - Math.max(0, anim.throwUntil - now) / BOMB_THROW_MS : 0;

      if (isSelf) {
        g.fillStyle(0x22d3ee, 0.2);
        g.fillCircle(cx, cy, bodyR * 1.85);
        g.lineStyle(2, 0x22d3ee, 0.85);
        g.strokeCircle(cx, cy, bodyR * 1.6);
      }

      // Ground shadow first so limbs and body draw on top of it.
      g.fillStyle(0x120726, 0.5);
      g.fillEllipse(cx, cy + bodyR * 1.05, bodyR * 1.8, bodyR * 0.5);

      // Walk cycle: legs swing opposite each other, arms swing opposite the
      // same-side leg so the character doesn't look like it is marching with
      // both arms glued to its sides. A throw pose overrides the arm swing for
      // its short duration so the drop reads as a distinct action.
      const stride = Math.sin(anim.walkPhase);
      const legSwing = stride * bodyR * 0.42;
      const armSwing = -stride * bodyR * 0.36;
      const bob = Math.abs(Math.cos(anim.walkPhase)) * bodyR * 0.08;

      this._drawLimb(g, cx - bodyR * 0.32, cy + bodyR * 0.55 - bob, legSwing, bodyR * 0.9, darken(color, 0.45), ts);
      this._drawLimb(g, cx + bodyR * 0.32, cy + bodyR * 0.55 - bob, -legSwing, bodyR * 0.9, darken(color, 0.45), ts);

      // Torso, tilted slightly forward when moving fast, sits above the legs.
      g.fillStyle(color, 1);
      g.fillCircle(cx, cy - bob, bodyR);

      // Arms: a resting swing normally, or thrown up-and-forward toward the
      // facing direction while a bomb-drop plays.
      if (isThrowing) {
        const lift = Math.sin(throwT * Math.PI); // up then back down
        const dir = DIR_VECTORS[anim.facing] ?? DIR_VECTORS.down;
        const reach = bodyR * (0.55 + lift * 0.85);
        const armX = cx + dir.x * reach;
        const armY = cy - bob - bodyR * 0.1 + dir.y * reach - lift * bodyR * 0.5;
        this._drawLimb(g, cx - bodyR * 0.7, cy - bob, 0, bodyR * 0.7, lighten(color, 0.15), ts, armX - (cx - bodyR * 0.7), armY - (cy - bob));
        this._drawLimb(g, cx + bodyR * 0.7, cy - bob, 0, bodyR * 0.7, lighten(color, 0.15), ts, armX - (cx + bodyR * 0.7), armY - (cy - bob));

        // The bomb itself, mid-arc between the hands and the tile it will land on.
        g.fillStyle(COLORS.bomb, 1);
        g.fillCircle(armX, armY, Math.max(2, bodyR * 0.28));
        g.lineStyle(1.5, 0xf43f5e, 0.8);
        g.strokeCircle(armX, armY, Math.max(2, bodyR * 0.28));
      } else {
        this._drawLimb(g, cx - bodyR * 0.7, cy - bob, armSwing, bodyR * 0.68, lighten(color, 0.15), ts);
        this._drawLimb(g, cx + bodyR * 0.7, cy - bob, -armSwing, bodyR * 0.68, lighten(color, 0.15), ts);
      }

      // Visor band + eyes on the facing side, so the direction the bot/player
      // last moved is legible without a sprite.
      g.fillStyle(0xffffff, 0.92);
      g.fillRoundedRect(cx - bodyR * 0.6, cy - bob - bodyR * 0.32, bodyR * 1.2, bodyR * 0.58, 2);
      const eyeOffset = DIR_VECTORS[anim.facing] ?? DIR_VECTORS.down;
      const eyeShift = bodyR * 0.16;
      g.fillStyle(0x0c0518, 1);
      g.fillRect(
        cx - bodyR * 0.28 + eyeOffset.x * eyeShift,
        cy - bob - bodyR * 0.18 + eyeOffset.y * eyeShift * 0.4,
        bodyR * 0.2,
        bodyR * 0.28,
      );
      g.fillRect(
        cx + bodyR * 0.08 + eyeOffset.x * eyeShift,
        cy - bob - bodyR * 0.18 + eyeOffset.y * eyeShift * 0.4,
        bodyR * 0.2,
        bodyR * 0.28,
      );

      const label = this.add.text(cx, cy - bodyR - 12, p.isBot ? `${p.name} ·bot` : p.name, {
        fontFamily: "JetBrains Mono, monospace",
        fontSize: `${Math.max(8, Math.round(ts * 0.26))}px`,
        color: isSelf ? "#67e8f9" : "#ede9fe",
      });
      label.setOrigin(0.5, 1);
      label.setShadow(0, 1, "#0c0518", 3);
      this.labelLayer.add(label);
    }
  }

  /**
   * A rounded-capsule limb anchored at (baseX, baseY), swung by `swing` pixels
   * sideways (used for the natural walk-cycle arms/legs), or aimed at an
   * explicit (dirX, dirY) offset when supplied (used for the bomb-throw pose).
   * Drawing limbs as short thick lines rather than more circles is what turns
   * the silhouette into "a person" instead of "a snowman".
   */
  _drawLimb(g, baseX, baseY, swing, length, color, ts, dirX, dirY) {
    const width = Math.max(2, ts * 0.14);
    const endX = dirX !== undefined ? baseX + dirX : baseX + swing * 0.4;
    const endY = dirY !== undefined ? baseY + dirY : baseY + length;

    g.lineStyle(width, color, 1);
    g.lineBetween(baseX, baseY, endX, endY);
    g.fillStyle(color, 1);
    g.fillCircle(baseX, baseY, width * 0.55);
    g.fillCircle(endX, endY, width * 0.5);
  }
}

/** Unit vectors used to bias the visor eyes and the bomb-throw reach toward
 *  whichever direction the character last moved. */
const DIR_VECTORS = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};
