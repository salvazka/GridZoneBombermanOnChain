import { randomBytes } from "node:crypto";
import { keccak256, toHex } from "viem";
import { config } from "./config.js";
import { publicClient, ownerClient, ownerAccount, deriveAccount, txUrl } from "./chain/clients.js";
import { gridZoneArenaAbi } from "./chain/abis.js";
import { gasOracle } from "./chain/gasOracle.js";
import { relayerPool } from "./chain/relayerPool.js";
import { Settlement } from "./chain/settlement.js";
import { Match } from "./game/match.js";
import { BotController } from "./game/bots.js";
import { LOBBY_SIZE, LOBBY_COUNTDOWN_MS, START_DELAY_MS, DEATH } from "./game/constants.js";
import { log } from "./logger.js";

const BOT_NAMES = [
  "Blaster", "Fuse", "Kaboom", "Tick", "Ember", "Shrapnel", "Cinder", "Flash",
  "Nitro", "Scorch", "Wick", "Blitz", "Ash", "Bolt", "Fizz", "Volt",
];

let botCounter = 0;

/**
 * Owns the lifecycle of every match: on-chain registration, seating, the
 * simulation, settlement, and finalization.
 */
export class Matchmaker {
  /** @param {import('socket.io').Server} io */
  constructor(io) {
    this.io = io;
    /** @type {Map<string, object>} matchId -> room */
    this.rooms = new Map();
    /** @type {Map<string, string>} socketId -> matchId */
    this.socketMatch = new Map();
    this.recentSettlements = [];
  }

  // ------------------------------------------------------------------
  // Lobby assignment
  // ------------------------------------------------------------------

  /**
   * Returns a lobby a player can pay into, creating one if needed.
   *
   * The match must exist on chain before anyone deposits, because
   * `depositEntryFee` reverts on an unopened match. So registration happens
   * here, not at match start.
   */
  async findOrCreateOpenRoom() {
    for (const room of this.rooms.values()) {
      if (room.state === "lobby" && room.seats.size + room.reserved.size < LOBBY_SIZE) {
        return room;
      }
    }
    return this.createRoom();
  }

  async createRoom() {
    const matchId = keccak256(toHex(`gridzone:${Date.now()}:${randomBytes(8).toString("hex")}`));
    const seed = randomBytes(4).readUInt32BE(0);
    const relayer = relayerPool.acquire();

    const match = new Match({ matchId, seed });
    const bots = new BotController(match);

    const room = {
      matchId,
      seed,
      relayer,
      match,
      bots,
      settlement: null,
      state: "opening",
      /** addresses verified as paid, address -> {socketId,name} */
      seats: new Map(),
      /** addresses we expect to pay soon, so the lobby is not oversold */
      reserved: new Map(),
      countdownTimer: null,
      startTimer: null,
      createdAt: Date.now(),
      openTxHash: null,
    };

    this.rooms.set(matchId, room);

    try {
      // openMatch is onlyOwner: the owner registers the match and binds the
      // sharded relayer key that will settle it.
      const openCall = {
        address: config.arenaAddress,
        abi: gridZoneArenaAbi,
        functionName: "openMatch",
        args: [matchId, relayer.address],
      };
      const hash = await ownerClient.writeContract({
        ...openCall,
        gas: await gasOracle.limitFor("openMatch", { ...openCall, account: ownerAccount }, config.gas.openMatch),
      });
      room.openTxHash = hash;
      await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });

      room.state = "lobby";
      room.settlement = new Settlement({
        relayer,
        matchId,
        onEvent: (event) => this._onSettlementEvent(room, event),
      });

      log.chain(`match opened ${matchId.slice(0, 12)}… relayer=${relayer.address.slice(0, 10)}… ${txUrl(hash)}`);
      this._wireMatch(room);
      return room;
    } catch (err) {
      // A room that never opened on chain must not linger, or players would be
      // told to deposit into a match that does not exist.
      this.rooms.delete(matchId);
      relayerPool.release(relayer);
      log.error(`openMatch failed: ${err?.shortMessage ?? err?.message}`);
      throw new Error(`Could not open a match on chain: ${err?.shortMessage ?? err?.message}`);
    }
  }

  /** Holds a slot while the player's deposit tx is in flight. */
  reserveSeat(room, address, socketId) {
    room.reserved.set(address.toLowerCase(), { socketId, at: Date.now() });
    // Reservations must expire or a player who abandons the wallet prompt would
    // block a seat until the match ends.
    setTimeout(() => {
      const held = room.reserved.get(address.toLowerCase());
      if (held && held.socketId === socketId) {
        room.reserved.delete(address.toLowerCase());
        this._broadcastLobby(room);
      }
    }, 90_000).unref?.();
  }

  /**
   * Confirms a deposit against chain state and seats the player.
   *
   * The client is never trusted here: it only tells us it thinks it paid. The
   * seat depends on `isPlayer(matchId, address)` reading true on chain, which is
   * the boundary between "client claims" and "the vault agrees".
   */
  async confirmSeat(room, address, { socketId, name }) {
    const addr = address.toLowerCase();

    const paid = await publicClient.readContract({
      address: config.arenaAddress,
      abi: gridZoneArenaAbi,
      functionName: "isPlayer",
      args: [room.matchId, addr],
    });

    if (!paid) return { ok: false, reason: "No entry fee found on chain for this address." };
    if (room.state !== "lobby") return { ok: false, reason: "Match already started." };

    room.reserved.delete(addr);

    if (room.seats.has(addr)) {
      // Reconnect: rebind the socket rather than rejecting or double-seating.
      room.seats.get(addr).socketId = socketId;
    } else {
      room.seats.set(addr, { socketId, name: name || `Player${room.seats.size + 1}` });
      room.match.addPlayer({ id: socketId, address: addr, name: name || `Player${room.seats.size}`, isBot: false });
    }

    this.socketMatch.set(socketId, room.matchId);
    this._broadcastLobby(room);
    this._scheduleStart(room);

    return { ok: true, matchId: room.matchId };
  }

  _scheduleStart(room) {
    if (room.state !== "lobby") return;

    if (room.seats.size >= LOBBY_SIZE) {
      this._beginMatch(room);
      return;
    }

    // First human starts the clock; the rest of the lobby fills with bots when
    // it expires so a demo never waits on 15 more humans.
    if (!room.countdownTimer && room.seats.size >= 1) {
      room.countdownAt = Date.now() + LOBBY_COUNTDOWN_MS;
      room.countdownTimer = setTimeout(() => {
        room.countdownTimer = null;
        this._beginMatch(room).catch((err) => log.error(`match start failed: ${err?.message}`));
      }, LOBBY_COUNTDOWN_MS);
      this._broadcastLobby(room);
    }
  }

  async _beginMatch(room) {
    if (room.state !== "lobby") return;
    room.state = "seating_bots";
    if (room.countdownTimer) {
      clearTimeout(room.countdownTimer);
      room.countdownTimer = null;
    }

    const humanCount = room.seats.size;
    const botsNeeded = Math.max(0, LOBBY_SIZE - humanCount);

    // Seating a full lobby plus settling every death is ~31 txs from this one
    // key. Verify it can afford that before starting, rather than discovering it
    // has run dry halfway through and leaving the match half-seated.
    const funded = await relayerPool.ensureFunded(room.relayer);
    if (!funded) {
      log.error("relayer could not be funded; keeping the lobby open");
      room.state = "lobby";
      this.io.to(room.matchId).emit("lobby:error", {
        reason: "Relayer is out of testnet MON. The operator needs to refill it.",
      });
      this._broadcastLobby(room);
      return;
    }

    if (botsNeeded > 0) {
      log.game(`seating ${botsNeeded} bot(s) for ${room.matchId.slice(0, 12)}…`);
      this.io.to(room.matchId).emit("lobby:seating_bots", { count: botsNeeded });

      const seated = await this._seatBots(room, botsNeeded);
      if (seated < botsNeeded) {
        log.warn(`only seated ${seated}/${botsNeeded} bots; starting anyway`);
      }
    }

    if (room.match.players.size < 2) {
      // A one-player match would end instantly and pay the entry fee straight
      // back, which looks like a bug. Return to the lobby and wait.
      log.warn("not enough players to start; returning to lobby");
      room.state = "lobby";
      this._broadcastLobby(room);
      return;
    }

    room.state = "starting";
    this.io.to(room.matchId).emit("match:starting", {
      matchId: room.matchId,
      inMs: START_DELAY_MS,
      map: room.match.mapPayload(),
      players: room.match.snapshot().players,
    });

    room.startTimer = setTimeout(() => {
      room.state = "running";
      room.match.start();
      log.game(`match ${room.matchId.slice(0, 12)}… started with ${room.match.players.size} players`);
      this.io.to(room.matchId).emit("match:started", { matchId: room.matchId, at: Date.now() });
    }, START_DELAY_MS);
  }

  /**
   * Seats demo bots. Each bot's entry fee is paid by the relayer, so bots hold a
   * real on-chain bounty. Free bots would break the conservation invariant the
   * moment one of them died (PRD §9.3).
   */
  async _seatBots(room, count) {
    const jobs = [];
    const pending = [];

    for (let i = 0; i < count; i++) {
      const index = botCounter++;
      const account = deriveAccount(config.botSeed, index);
      const name = `${BOT_NAMES[index % BOT_NAMES.length]}-${String(index).padStart(2, "0")}`;
      const id = `bot:${index}`;
      pending.push({ id, account, name });
      jobs.push(room.settlement.openMatchBounty(account.address));
    }

    const results = await Promise.allSettled(jobs);
    await room.settlement.drain();

    let seated = 0;
    for (let i = 0; i < pending.length; i++) {
      if (results[i].status !== "fulfilled" || !results[i].value) continue;

      const { id, account, name } = pending[i];
      // Trust chain state, not the tx result: a mined tx can still have reverted.
      const paid = await publicClient.readContract({
        address: config.arenaAddress,
        abi: gridZoneArenaAbi,
        functionName: "isPlayer",
        args: [room.matchId, account.address.toLowerCase()],
      });
      if (!paid) continue;

      room.match.addPlayer({ id, address: account.address, name, isBot: true });
      seated++;
    }

    return seated;
  }

  // ------------------------------------------------------------------
  // Simulation wiring
  // ------------------------------------------------------------------

  _wireMatch(room) {
    const { match } = room;

    match.on("state", (snapshot) => {
      room.bots.step();
      this.io.to(room.matchId).emit("match:state", snapshot);
    });

    match.on("mapUpdate", (payload) => {
      this.io.to(room.matchId).emit("match:map_update", payload);
    });

    match.on("tickDeaths", (deaths) => {
      // Announce immediately; the chain confirms a moment later. Waiting for the
      // receipt before showing the kill would add visible input lag to the demo.
      this.io.to(room.matchId).emit("match:deaths", deaths.map(serialiseDeath));

      room.settlement
        .settleDeaths(deaths)
        .catch((err) => log.error(`settleDeaths: ${err?.shortMessage ?? err?.message}`));
    });

    match.on("finished", ({ winner, rule }) => {
      this._finishMatch(room, winner, rule).catch((err) =>
        log.error(`finish failed: ${err?.shortMessage ?? err?.message}`),
      );
    });

    match.on("error", (err) => {
      log.error(`match ${room.matchId.slice(0, 12)}… loop error: ${err?.message}`);
    });
  }

  async _finishMatch(room, winner, rule = "last_standing") {
    if (room.state === "finished") return;
    room.state = "finished";

    log.game(
      `match ${room.matchId.slice(0, 12)}… won by ${winner ? winner.name : "nobody"} (${rule})`,
    );

    this.io.to(room.matchId).emit("match:finished", {
      matchId: room.matchId,
      winner: winner ? { id: winner.id, name: winner.name, address: winner.address, kills: winner.kills } : null,
      rule,
      logRoot: room.match.log.root(),
    });

    // Every kill must settle before finalization: finalizeMatch sweeps the
    // remaining bounties, so a kill landing after it would revert on an already
    // finalized match and the killer would silently lose their payout.
    await room.settlement.drain();

    const logRoot = room.match.log.root();

    if (winner) {
      const hash = await room.settlement.finalize(winner.address, logRoot);
      if (hash) await room.settlement.drain();
    } else {
      log.warn("no winner; leaving match unfinalized for the timeout escape hatch");
    }

    relayerPool.release(room.relayer);

    // Keep the room briefly so clients can read the final scoreboard and the
    // published log, then drop it.
    setTimeout(() => {
      for (const [socketId, matchId] of this.socketMatch.entries()) {
        if (matchId === room.matchId) this.socketMatch.delete(socketId);
      }
      this.rooms.delete(room.matchId);
    }, 120_000).unref?.();
  }

  _onSettlementEvent(room, event) {
    const enriched = { ...event, matchId: room.matchId };

    if (event.kind === "settlement_confirmed" && event.death) {
      // Credit the killer's running total only once the chain agrees.
      const killer = event.death.killer;
      if (killer && event.functionName === "processKillReward") {
        const p = room.match.players.get(killer.id);
        if (p) p.earnings += 640_000n; // 80% of the flat $0.80 head bounty
      }
    }

    if (event.kind === "settlement_confirmed" && Array.isArray(event.deaths)) {
      for (const d of event.deaths) {
        if (d.cause === DEATH.PVP && d.killer) {
          const p = room.match.players.get(d.killer.id);
          if (p) p.earnings += 640_000n;
        }
      }
    }

    this.recentSettlements.unshift(enriched);
    this.recentSettlements.length = Math.min(this.recentSettlements.length, 200);

    this.io.to(room.matchId).emit("chain:settlement", enriched);
    this.io.emit("chain:feed", enriched);
  }

  _broadcastLobby(room) {
    this.io.to(room.matchId).emit("lobby:update", this.lobbyView(room));
  }

  lobbyView(room) {
    return {
      matchId: room.matchId,
      state: room.state,
      seated: room.seats.size,
      reserved: room.reserved.size,
      capacity: LOBBY_SIZE,
      countdownAt: room.countdownAt ?? null,
      relayer: room.relayer.address,
      openTxHash: room.openTxHash,
      players: [...room.seats.entries()].map(([address, s]) => ({ address, name: s.name })),
    };
  }

  // ------------------------------------------------------------------
  // Socket plumbing
  // ------------------------------------------------------------------

  handleInput(socketId, input) {
    const matchId = this.socketMatch.get(socketId);
    if (!matchId) return;
    const room = this.rooms.get(matchId);
    if (!room || room.state !== "running") return;
    room.match.setInput(socketId, input);
  }

  handleBomb(socketId) {
    const matchId = this.socketMatch.get(socketId);
    if (!matchId) return;
    const room = this.rooms.get(matchId);
    if (!room || room.state !== "running") return;
    room.match.requestBomb(socketId);
  }

  handleDisconnect(socketId) {
    const matchId = this.socketMatch.get(socketId);
    if (!matchId) return;
    const room = this.rooms.get(matchId);
    this.socketMatch.delete(socketId);
    if (!room) return;

    if (room.state === "lobby") {
      for (const [address, seat] of room.seats.entries()) {
        if (seat.socketId === socketId) {
          // The deposit is already on chain, so the seat stays paid; only the
          // live connection goes away. The player can reconnect, and if they do
          // not, emergencyWithdraw is their escape hatch.
          room.match.removePlayer(socketId);
          room.seats.delete(address);
          break;
        }
      }
      this._broadcastLobby(room);
    } else if (room.state === "running") {
      room.match.removePlayer(socketId);
    }
  }

  roomFor(matchId) {
    return this.rooms.get(matchId) ?? null;
  }

  overview() {
    return {
      rooms: [...this.rooms.values()].map((r) => ({
        matchId: r.matchId,
        state: r.state,
        players: r.match.players.size,
        alive: r.match.alivePlayers.length,
        relayer: r.relayer.address,
        tick: r.match.tick,
        safeRing: r.match.safeRing,
      })),
      relayers: relayerPool.stats(),
    };
  }
}

function serialiseDeath(d) {
  return {
    matchId: d.matchId,
    victim: d.victim,
    killer: d.killer,
    cause: d.cause,
    tick: d.tick,
  };
}
