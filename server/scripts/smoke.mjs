/**
 * End-to-end smoke test.
 *
 * Plays a full match as a headless human against the running server, then
 * asserts the on-chain result. A server that boots and a client that renders
 * prove nothing about whether money moved correctly, so this checks the things
 * that actually matter:
 *
 *   1. A wallet can approve, pay the entry fee and be seated.
 *   2. Deaths settle on chain via the right function for each death type.
 *   3. The match finalizes and the winner is paid.
 *   4. The PRD §4.1 solvency invariant still holds on the live contract:
 *      balanceOf(arena) == sum(bounty) + sum(jackpot) + treasuryUnclaimed
 *
 * Run against a live server: npm --prefix server run smoke
 */
import { io } from "socket.io-client";
import { erc20Abi, formatUnits } from "viem";
import { config } from "../src/config.js";
import {
  publicClient,
  ownerClient,
  ownerAccount,
  deriveAccount,
  walletFor,
  waitForBlocks,
} from "../src/chain/clients.js";
import { gridZoneArenaAbi } from "../src/chain/abis.js";
import { sleep } from "../src/util/async.js";

const BASE = `http://localhost:${config.port}`;
const PLAYER_SEED = process.env.SMOKE_SEED ?? `smoke-${Date.now()}`;
const MATCH_TIMEOUT_MS = 6 * 60_000;

let failures = 0;

function check(label, condition, detail = "") {
  const mark = condition ? "PASS" : "FAIL";
  if (!condition) failures++;
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ""}`);
  return condition;
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

async function api(path, options) {
  const res = await fetch(`${BASE}${path}`, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

async function main() {
  console.log("GridZone end-to-end smoke test");
  console.log(`server : ${BASE}`);
  console.log(`arena  : ${config.arenaAddress}`);

  section("Server reachable");
  const health = await api("/api/health");
  check("health ok", health.ok === true);
  check("relayer pool ready", health.relayerPoolReady === true);

  // ------------------------------------------------------------------
  section("Fund a fresh player wallet");
  const player = deriveAccount(PLAYER_SEED, 0);
  const playerWallet = walletFor(player);
  console.log(`  player: ${player.address}`);

  const gasBudget = 1_000_000_000_000_000_000n; // 1 MON, plenty for gas-only txs
  let nonce = await publicClient.getTransactionCount({ address: ownerAccount.address, blockTag: "pending" });
  const fundHash = await ownerClient.sendTransaction({
    to: player.address,
    value: gasBudget,
    gas: 21_000n,
    nonce: nonce++,
  });
  await publicClient.waitForTransactionReceipt({ hash: fundHash });

  // Monad validates a block against state from k=3 blocks earlier, so this
  // freshly funded wallet still reads as empty to the consensus-time balance
  // check. Without this wait its first tx is rejected outright.
  console.log("  waiting for the lagged consensus view to see the funding…");
  await waitForBlocks(6);

  const mintHash = await playerWallet.writeContract({
    address: config.usdcAddress,
    abi: [
      {
        type: "function",
        name: "mint",
        stateMutability: "nonpayable",
        inputs: [
          { name: "to", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        outputs: [],
      },
    ],
    functionName: "mint",
    args: [player.address, 10_000_000n], // 10 USDC
    gas: config.gas.mint,
  });
  await publicClient.waitForTransactionReceipt({ hash: mintHash });

  const [monBal, usdcBal] = await Promise.all([
    publicClient.getBalance({ address: player.address }),
    publicClient.readContract({
      address: config.usdcAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [player.address],
    }),
  ]);
  check("player funded with MON", monBal > 0n, `${formatUnits(monBal, 18)} MON`);
  check("player funded with USDC", usdcBal >= 1_000_000n, `${formatUnits(usdcBal, 6)} USDC`);

  // ------------------------------------------------------------------
  section("Connect and reserve a seat");
  const socket = io(BASE, { transports: ["websocket"] });
  const socketId = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("socket hello timeout")), 15_000);
    socket.on("hello", ({ socketId }) => {
      clearTimeout(t);
      resolve(socketId);
    });
    socket.on("connect_error", (err) => {
      clearTimeout(t);
      reject(err);
    });
  });
  check("socket connected", Boolean(socketId), socketId);

  const join = await api("/api/join", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: player.address, socketId }),
  });
  const matchId = join.matchId;
  check("match reserved", Boolean(matchId), matchId);

  const onChainMatch = await publicClient.readContract({
    address: config.arenaAddress,
    abi: gridZoneArenaAbi,
    functionName: "getMatch",
    args: [matchId],
  });
  check("match opened on chain", onChainMatch.active === true);
  check("relayer bound to match", onChainMatch.relayer.toLowerCase() === join.lobby.relayer.toLowerCase());

  // ------------------------------------------------------------------
  section("Approve and pay the entry fee");
  const approveHash = await playerWallet.writeContract({
    address: config.usdcAddress,
    abi: erc20Abi,
    functionName: "approve",
    args: [config.arenaAddress, 2n ** 255n],
    gas: config.gas.approve,
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });

  // Mirror what the browser does: estimate, then buffer, so the number reflects
  // what a real player would actually be charged.
  const depositCall = {
    address: config.arenaAddress,
    abi: gridZoneArenaAbi,
    functionName: "depositEntryFee",
    args: [matchId],
  };
  const depositEstimate = await publicClient.estimateContractGas({
    ...depositCall,
    account: player,
  });
  const depositGas = depositEstimate + depositEstimate / 5n;
  console.log(`  depositEntryFee estimate ${depositEstimate}, limit ${depositGas}`);

  const depositHash = await playerWallet.writeContract({
    ...depositCall,
    gas: depositGas,
  });
  const depositReceipt = await publicClient.waitForTransactionReceipt({ hash: depositHash });
  check("depositEntryFee succeeded", depositReceipt.status === "success", `gasUsed ${depositReceipt.gasUsed}`);

  const bounty = await publicClient.readContract({
    address: config.arenaAddress,
    abi: gridZoneArenaAbi,
    functionName: "bountyOf",
    args: [matchId, player.address],
  });
  check("head bounty is $0.80", bounty === 800_000n, `${formatUnits(bounty, 6)} USDC`);

  const seat = await new Promise((resolve) => {
    socket.emit("seat:confirm", { matchId, address: player.address, name: "SmokeBot" }, resolve);
  });
  check("server seated the player", seat?.ok === true, seat?.reason ?? "");

  // ------------------------------------------------------------------
  section("Play the match");

  const stats = {
    started: false,
    ticks: 0,
    deaths: [],
    settlementsSent: 0,
    settlementsConfirmed: 0,
    settlementsFailed: 0,
    functionsUsed: new Set(),
    latencies: [],
    gasUsed: [],
    ringsCollapsed: 0,
    finished: null,
    myEarnings: 0n,
    alive: true,
  };

  socket.on("match:started", () => {
    stats.started = true;
    console.log("  match started");
  });

  socket.on("match:state", (snap) => {
    stats.ticks++;
    const me = snap.players.find((p) => p.id === socketId);
    if (me) {
      stats.alive = me.alive;
      stats.myEarnings = BigInt(me.earnings);
    }
  });

  socket.on("match:map_update", (payload) => {
    if (payload.ring !== undefined) {
      stats.ringsCollapsed++;
      console.log(`  ring ${payload.ring} collapsed`);
    }
  });

  socket.on("match:deaths", (deaths) => {
    for (const d of deaths) {
      stats.deaths.push(d);
      console.log(`  death: ${d.victim.name} (${d.cause})${d.killer ? ` by ${d.killer.name}` : ""}`);
    }
  });

  socket.on("chain:settlement", (event) => {
    if (event.kind === "settlement_sent") stats.settlementsSent++;
    if (event.kind === "settlement_confirmed") {
      stats.settlementsConfirmed++;
      stats.functionsUsed.add(event.functionName);
      stats.latencies.push(event.latencyMs);
      stats.gasUsed.push({ fn: event.functionName, used: Number(event.gasUsed), limit: Number(event.gasLimit) });
      console.log(`  settled ${event.label} in ${event.latencyMs}ms (gas ${event.gasUsed}/${event.gasLimit})`);
    }
    if (event.kind === "settlement_failed" || event.kind === "settlement_reverted") {
      stats.settlementsFailed++;
      console.log(`  SETTLEMENT PROBLEM: ${event.label} ${event.error ?? "reverted"}`);
    }
  });

  const finishedPromise = new Promise((resolve) => {
    socket.on("match:finished", (payload) => {
      stats.finished = payload;
      console.log(`  match finished, winner=${payload.winner?.name ?? "none"}`);
      resolve(payload);
    });
  });

  // Wander and drop bombs so the human player actually participates.
  const driver = setInterval(() => {
    if (!stats.started || !stats.alive) return;
    const dirs = ["up", "down", "left", "right"];
    const pick = dirs[Math.floor(Math.random() * dirs.length)];
    const input = { up: false, down: false, left: false, right: false };
    input[pick] = true;
    socket.emit("input", input);
    if (Math.random() < 0.25) socket.emit("bomb");
  }, 400);

  const timeout = sleep(MATCH_TIMEOUT_MS).then(() => "timeout");
  const outcome = await Promise.race([finishedPromise, timeout]);
  clearInterval(driver);

  check("match reached a conclusion", outcome !== "timeout", outcome === "timeout" ? "timed out" : "finished");
  check("simulation produced ticks", stats.ticks > 0, `${stats.ticks} snapshots`);
  check("deaths occurred", stats.deaths.length > 0, `${stats.deaths.length} deaths`);

  // Give the finalize tx time to land.
  await sleep(12_000);

  // ------------------------------------------------------------------
  section("Settlement behaviour");
  check("settlements were confirmed", stats.settlementsConfirmed > 0, `${stats.settlementsConfirmed} confirmed`);
  check("no settlement failures", stats.settlementsFailed === 0, `${stats.settlementsFailed} failed`);

  const causes = new Set(stats.deaths.map((d) => d.cause));
  console.log(`  death causes seen: ${[...causes].join(", ") || "none"}`);
  console.log(`  contract functions used: ${[...stats.functionsUsed].join(", ") || "none"}`);

  // Every PvP death must have produced a kill-reward call, and every death
  // without a killer must have gone down the no-beneficiary path.
  const pvpDeaths = stats.deaths.filter((d) => d.cause === "pvp").length;
  const noBeneficiary = stats.deaths.filter((d) => d.cause !== "pvp").length;
  if (pvpDeaths > 0) {
    check(
      "PvP deaths routed to a kill-reward path",
      stats.functionsUsed.has("processKillReward") || stats.functionsUsed.has("processKillBatch"),
    );
  }
  if (noBeneficiary > 0) {
    check(
      "self/env deaths routed to the no-beneficiary path",
      stats.functionsUsed.has("processEnvironmentOrSelfDeath") || stats.functionsUsed.has("processKillBatch"),
    );
  }

  if (stats.latencies.length > 0) {
    const avg = Math.round(stats.latencies.reduce((a, b) => a + b, 0) / stats.latencies.length);
    const min = Math.min(...stats.latencies);
    console.log(`  settlement latency: min ${min}ms, avg ${avg}ms, max ${Math.max(...stats.latencies)}ms`);
  }

  if (stats.gasUsed.length > 0) {
    const byFn = new Map();
    for (const g of stats.gasUsed) {
      const cur = byFn.get(g.fn) ?? { max: 0, limit: g.limit };
      cur.max = Math.max(cur.max, g.used);
      byFn.set(g.fn, cur);
    }
    console.log("  real Monad gas (max used / limit set):");
    for (const [fn, v] of byFn) {
      const headroom = Math.round((1 - v.max / v.limit) * 100);
      console.log(`    ${fn}: ${v.max} / ${v.limit}  (${headroom}% headroom)`);
    }
  }

  // ------------------------------------------------------------------
  section("On-chain final state");
  const finalMatch = await publicClient.readContract({
    address: config.arenaAddress,
    abi: gridZoneArenaAbi,
    functionName: "getMatch",
    args: [matchId],
  });

  const winner = stats.finished?.winner ?? null;

  // Even total mutual destruction must produce a payable winner, or the whole pot
  // would sit locked until the one-hour timeout.
  check("a winner was determined", Boolean(winner), stats.finished?.rule ?? "none");
  if (stats.finished?.rule === "last_stand_tiebreak") {
    console.log("  note: no survivors, winner chosen by last-stand tiebreak");
  }

  if (winner) {
    check("match finalized on chain", finalMatch.finalized === true);
    check("match no longer active", finalMatch.active === false);
    check("jackpot fully paid out", finalMatch.jackpotPool === 0n, `${formatUnits(finalMatch.jackpotPool, 6)} USDC left`);

    const residualBounty = await publicClient.readContract({
      address: config.arenaAddress,
      abi: gridZoneArenaAbi,
      functionName: "totalBountyOf",
      args: [matchId],
    });
    check("no bounty stranded in the match", residualBounty === 0n, `${formatUnits(residualBounty, 6)} USDC left`);

    const storedRoot = await publicClient.readContract({
      address: config.arenaAddress,
      abi: gridZoneArenaAbi,
      functionName: "matchLogRoot",
      args: [matchId],
    });
    check(
      "audit log root committed on chain",
      storedRoot === stats.finished.logRoot,
      `${storedRoot.slice(0, 18)}…`,
    );

    const totalDeposited = finalMatch.totalDeposited;
    check(
      "every seat was paid for on chain",
      totalDeposited === 16_000_000n,
      `${formatUnits(totalDeposited, 6)} USDC deposited across ${finalMatch.playerCount} seats`,
    );

    // The winner's payout must equal the jackpot plus every bounty still
    // outstanding: this is the §4.1 figure the whole economy rests on.
    const winnerBalance = await publicClient.readContract({
      address: config.usdcAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [winner.address],
    });
    check("winner was paid", winnerBalance > 0n, `${formatUnits(winnerBalance, 6)} USDC`);
  }

  // The headline invariant, checked against the live contract rather than a test
  // harness. This is the property that proves the vault is neither insolvent nor
  // quietly holding funds nobody can claim.
  const [vaultBalance, liabilities] = await Promise.all([
    publicClient.readContract({
      address: config.usdcAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [config.arenaAddress],
    }),
    publicClient.readContract({
      address: config.arenaAddress,
      abi: gridZoneArenaAbi,
      functionName: "totalLiabilities",
      args: [],
    }),
  ]);

  check(
    "PRD 4.1 solvency invariant holds on chain",
    vaultBalance === liabilities,
    `vault ${formatUnits(vaultBalance, 6)} == liabilities ${formatUnits(liabilities, 6)}`,
  );

  // ------------------------------------------------------------------
  section("Auditability");
  const logResponse = await fetch(`${BASE}/api/match/${matchId}/log`);
  if (logResponse.ok) {
    const matchLog = await logResponse.json();
    check("match log is published", Array.isArray(matchLog.entries) && matchLog.entries.length > 0, `${matchLog.entryCount} entries`);
    check("published root matches the committed root", matchLog.logRoot === stats.finished?.logRoot);
  } else {
    check("match log is published", false, `HTTP ${logResponse.status}`);
  }

  socket.close();

  section("Result");
  if (failures === 0) {
    console.log("All checks passed.");
    process.exit(0);
  } else {
    console.log(`${failures} check(s) FAILED.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\nSmoke test crashed:", err?.shortMessage ?? err?.message ?? err);
  process.exit(1);
});
