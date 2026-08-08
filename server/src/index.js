import { createServer } from "node:http";
import express from "express";
import cors from "cors";
import { Server as SocketServer } from "socket.io";
import { isAddress } from "viem";
import { config } from "./config.js";
import { log } from "./logger.js";
import { publicClient, ownerAccount } from "./chain/clients.js";
import { relayerPool } from "./chain/relayerPool.js";
import { gasOracle } from "./chain/gasOracle.js";
import { Matchmaker } from "./matchmaker.js";
import { LOBBY_SIZE, GRID, GRACE_MS, SHRINK_INTERVAL_MS, TICK_HZ } from "./game/constants.js";

const app = express();
app.use(cors({ origin: config.clientOrigin === "*" ? true : config.clientOrigin }));
app.use(express.json());

const httpServer = createServer(app);
const io = new SocketServer(httpServer, {
  cors: { origin: config.clientOrigin === "*" ? true : config.clientOrigin },
});

const matchmaker = new Matchmaker(io);

// ---------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------

/**
 * Root route. This server is an API + websocket backend, not the site itself
 * (the Phaser client is a separate static build), so hitting / used to return
 * Express's bare "Cannot GET /" — indistinguishable from a broken deploy when
 * you open the generated Railway/Render URL in a browser. This returns a small
 * status document instead, so the URL is self-explaining.
 */
app.get("/", (_req, res) => {
  res.json({
    service: "gridzone-server",
    status: "ok",
    note: "API + websocket backend. The playable client is a separate static site.",
    endpoints: ["/api/health", "/api/config", "/api/settlements", "/api/match/:matchId/log"],
    chainId: config.chainId,
    arenaAddress: config.arenaAddress,
  });
});

/** Everything the client needs to talk to the chain. Served from here so the
 *  frontend never hardcodes an address that could drift from the deployment. */
app.get("/api/config", (_req, res) => {
  res.json({
    chainId: config.chainId,
    rpcUrl: config.rpcUrl,
    explorerBase: config.explorerBase,
    arenaAddress: config.arenaAddress,
    usdcAddress: config.usdcAddress,
    entryFee: "1000000",
    lobbySize: LOBBY_SIZE,
    grid: GRID,
    tickHz: TICK_HZ,
    gracePeriodMs: GRACE_MS,
    shrinkIntervalMs: SHRINK_INTERVAL_MS,
  });
});

app.get("/api/health", async (_req, res) => {
  try {
    const [block, ownerBalance] = await Promise.all([
      publicClient.getBlockNumber(),
      publicClient.getBalance({ address: ownerAccount.address }),
    ]);
    res.json({
      ok: true,
      blockNumber: block.toString(),
      owner: ownerAccount.address,
      ownerBalanceWei: ownerBalance.toString(),
      relayerPoolReady: relayerPool.ready,
      // Live gas limits actually in use, so the real cost is inspectable.
      gasLimits: gasOracle.snapshot(),
      ...matchmaker.overview(),
    });
  } catch (err) {
    res.status(503).json({ ok: false, error: err?.shortMessage ?? err?.message });
  }
});

/** Recent settlement activity, for the live chain feed in the UI. */
app.get("/api/settlements", (_req, res) => {
  res.json({ settlements: matchmaker.recentSettlements.slice(0, 50) });
});

/**
 * Full match log behind a committed Merkle root.
 * This endpoint is the other half of the auditability claim in PRD §5.4: the
 * root on chain is only meaningful if the underlying log is public.
 */
app.get("/api/match/:matchId/log", (req, res) => {
  const room = matchmaker.roomFor(req.params.matchId);
  if (!room) return res.status(404).json({ error: "Unknown or expired match" });
  res.json(room.match.log.toJSON());
});

/**
 * Reserves a seat and tells the client which match to pay into.
 * Deliberately does not take payment: the client pays the contract directly, so
 * the server never custodies funds.
 */
app.post("/api/join", async (req, res) => {
  const { address, socketId } = req.body ?? {};
  if (!address || !isAddress(address)) {
    return res.status(400).json({ error: "A valid wallet address is required" });
  }

  try {
    const room = await matchmaker.findOrCreateOpenRoom();
    matchmaker.reserveSeat(room, address, socketId ?? null);
    res.json({
      matchId: room.matchId,
      arenaAddress: config.arenaAddress,
      usdcAddress: config.usdcAddress,
      entryFee: "1000000",
      lobby: matchmaker.lobbyView(room),
    });
  } catch (err) {
    log.error(`/api/join: ${err?.message}`);
    res.status(503).json({ error: err?.message ?? "Could not open a match" });
  }
});

// ---------------------------------------------------------------------
// Sockets
// ---------------------------------------------------------------------

io.on("connection", (socket) => {
  log.info(`socket connected ${socket.id}`);

  socket.emit("hello", { socketId: socket.id });

  /** Called after the client's depositEntryFee tx is mined. */
  socket.on("seat:confirm", async ({ matchId, address, name }, ack) => {
    try {
      const room = matchmaker.roomFor(matchId);
      if (!room) return ack?.({ ok: false, reason: "Unknown match" });

      socket.join(matchId);
      const result = await matchmaker.confirmSeat(room, address, { socketId: socket.id, name });

      if (result.ok) {
        socket.emit("lobby:update", matchmaker.lobbyView(room));
        // A player joining mid-countdown still needs the map to render.
        if (room.state === "running" || room.state === "starting") {
          socket.emit("match:starting", {
            matchId,
            inMs: 0,
            map: room.match.mapPayload(),
            players: room.match.snapshot().players,
          });
        }
      }
      ack?.(result);
    } catch (err) {
      log.error(`seat:confirm: ${err?.shortMessage ?? err?.message}`);
      ack?.({ ok: false, reason: err?.shortMessage ?? err?.message ?? "Failed to confirm seat" });
    }
  });

  socket.on("input", (input) => matchmaker.handleInput(socket.id, input ?? {}));
  socket.on("bomb", () => matchmaker.handleBomb(socket.id));

  socket.on("spectate", ({ matchId }) => {
    const room = matchmaker.roomFor(matchId);
    if (!room) return;
    socket.join(matchId);
    socket.emit("match:starting", {
      matchId,
      inMs: 0,
      map: room.match.mapPayload(),
      players: room.match.snapshot().players,
    });
  });

  socket.on("disconnect", () => {
    log.info(`socket disconnected ${socket.id}`);
    matchmaker.handleDisconnect(socket.id);
  });
});

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------

async function main() {
  log.info("GridZone server starting");
  log.info(`chain    : ${config.chainId} via ${config.rpcUrl}`);
  log.info(`arena    : ${config.arenaAddress}`);
  log.info(`usdc     : ${config.usdcAddress}`);
  log.info(`owner    : ${ownerAccount.address}`);

  const chainId = await publicClient.getChainId();
  if (chainId !== config.chainId) {
    throw new Error(`RPC reports chain ${chainId}, expected ${config.chainId}`);
  }

  // Fail fast if the arena is not actually deployed: every later error would
  // otherwise surface as a confusing revert during gameplay.
  const code = await publicClient.getCode({ address: config.arenaAddress });
  if (!code || code === "0x") {
    throw new Error(`No contract at ${config.arenaAddress} on chain ${chainId}. Deploy first.`);
  }

  await relayerPool.init();

  httpServer.listen(config.port, () => {
    log.info(`HTTP + WebSocket listening on http://localhost:${config.port}`);
    log.info(`allowed client origin: ${config.clientOrigin}`);
  });
}

main().catch((err) => {
  log.error(err?.message ?? err);
  process.exit(1);
});
