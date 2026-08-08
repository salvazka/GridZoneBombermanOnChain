import "./styles.css";
import Phaser from "phaser";
import { Wallet } from "./lib/wallet.js";
import { Net, fetchJson } from "./lib/net.js";
import { ArenaScene } from "./game/ArenaScene.js";
import { Hud } from "./ui/hud.js";
import { Toasts } from "./ui/toasts.js";
import { InputController } from "./input.js";
import { formatUsdc, formatMon, shortAddress, shortHash } from "./lib/format.js";

const el = (id) => document.getElementById(id);

const ui = {
  lobby: el("lobby"),
  game: el("game"),
  results: el("results"),

  netPill: el("net-pill"),
  netLabel: el("net-label"),
  contractLabel: el("contract-label"),

  disconnected: el("wallet-disconnected"),
  connected: el("wallet-connected"),
  btnConnect: el("btn-connect"),
  connectHint: el("connect-hint"),
  addrLabel: el("addr-label"),
  usdcLabel: el("usdc-label"),
  monLabel: el("mon-label"),
  btnFaucet: el("btn-faucet"),
  btnJoin: el("btn-join"),
  joinStatus: el("join-status"),

  queuePanel: el("queue-panel"),
  queueSeated: el("queue-seated"),
  queueCap: el("queue-cap"),
  queueMeta: el("queue-meta"),
  queueList: el("queue-list"),
  queueChain: el("queue-chain"),

  resultsWinner: el("results-winner"),
  resultsGrid: el("results-grid"),
  resultsRoot: el("results-root"),
  resultsLog: el("results-log"),
  btnAgain: el("btn-again"),
};

const state = {
  appConfig: null,
  wallet: null,
  net: null,
  hud: new Hud(),
  toasts: new Toasts(),
  input: null,
  phaser: null,
  scene: null,
  matchId: null,
  playerName: null,
  countdownTimer: null,
  joining: false,
};

// ---------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------

function showScreen(name) {
  for (const [key, node] of Object.entries({ lobby: ui.lobby, game: ui.game, results: ui.results })) {
    node.classList.toggle("is-hidden", key !== name);
  }
}

function setStatus(message, kind = "") {
  ui.joinStatus.textContent = message;
  ui.joinStatus.className = `status${kind ? ` is-${kind}` : ""}`;
}

function setNet(label, kind) {
  ui.netLabel.textContent = label;
  ui.netPill.className = `net-pill${kind ? ` is-${kind}` : ""}`;
}

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------

/** Cosmetic-only: plays the bomb-throw arm pose the instant the local player
 *  presses the key, instead of waiting ~33ms+ for the server snapshot that
 *  confirms the bomb actually exists. The server remains authoritative for
 *  whether the bomb was really placed (e.g. at max bomb count, this animation
 *  still plays once but the server simply won't spawn a bomb). */
function wireBombAnimation() {
  window.addEventListener("keydown", (event) => {
    if (event.code !== "Space" || event.repeat) return;
    if (!state.net?.socketId || !state.scene) return;
    state.scene.playBombThrow?.(state.net.socketId);
  });
}

async function boot() {
  try {
    state.appConfig = await fetchJson("/api/config");
  } catch (err) {
    setNet("Server offline", "bad");
    ui.connectHint.textContent =
      "Cannot reach the GridZone server on port 3001. Start it with: npm run dev:server";
    ui.btnConnect.disabled = true;
    return;
  }

  const cfg = state.appConfig;
  ui.queueCap.textContent = String(cfg.lobbySize);
  ui.contractLabel.textContent = `arena ${shortAddress(cfg.arenaAddress)} · usdc ${shortAddress(cfg.usdcAddress)}`;
  setNet(`Monad Testnet · ${cfg.chainId}`, "ok");

  state.wallet = new Wallet(cfg);
  state.net = new Net();
  state.input = new InputController(state.net);
  state.input.attach();

  wireSocket();
  wireButtons();
  wireBombAnimation();
  watchWalletProvider();
  updateWalletAvailability();

  await state.net.ready();
}

/**
 * Never disable Connect solely because an extension was not ready during page
 * load. MetaMask injects asynchronously in some browsers, and a click should
 * always get one more chance to discover it.
 */
function updateWalletAvailability() {
  const provider = state.wallet?.refreshProvider();
  ui.btnConnect.disabled = false;

  if (provider) {
    ui.connectHint.textContent = provider.isMetaMask
      ? "MetaMask detected. Click Connect Wallet to continue."
      : "EVM wallet detected. Click Connect Wallet to continue.";
    return;
  }

  ui.connectHint.innerHTML =
    'Looking for MetaMask… You can still click Connect Wallet to retry, or <a href="https://metamask.io" target="_blank" rel="noopener" style="color:var(--cyan)">install MetaMask</a>.';
}

function watchWalletProvider() {
  const refresh = () => updateWalletAvailability();

  // MetaMask emits ethereum#initialized when it injects after page load. The
  // EIP-6963 event covers browsers with multiple wallet extensions.
  window.addEventListener("ethereum#initialized", refresh);
  window.addEventListener("eip6963:announceProvider", refresh);

  // Some extensions do not emit either event consistently, so poll briefly
  // while they finish their startup. The button remains enabled throughout.
  for (const delay of [250, 1_000, 3_000]) {
    window.setTimeout(refresh, delay);
  }
}

function wireButtons() {
  ui.btnConnect.addEventListener("click", async () => {
    ui.btnConnect.disabled = true;
    try {
      const address = await state.wallet.connect();
      state.playerName = `Player-${address.slice(2, 6).toUpperCase()}`;
      ui.disconnected.classList.add("is-hidden");
      ui.connected.classList.remove("is-hidden");
      ui.addrLabel.textContent = shortAddress(address);
      await refreshBalances();

      state.wallet.onAccountsChanged(() => window.location.reload());
      state.wallet.onChainChanged(() => window.location.reload());
    } catch (err) {
      setNet("Wallet error", "bad");
      ui.connectHint.textContent = friendlyError(err);
      ui.btnConnect.disabled = false;
    }
  });

  ui.btnFaucet.addEventListener("click", async () => {
    ui.btnFaucet.disabled = true;
    setStatus("Minting 100 test USDC…", "busy");
    try {
      const { hash } = await state.wallet.faucet();
      setStatus(`Faucet confirmed · ${shortHash(hash)}`, "ok");
      await refreshBalances();
    } catch (err) {
      setStatus(friendlyError(err), "error");
    } finally {
      ui.btnFaucet.disabled = false;
    }
  });

  ui.btnJoin.addEventListener("click", joinMatch);

  ui.btnAgain.addEventListener("click", () => {
    state.matchId = null;
    state.toasts.clear();
    ui.queuePanel.classList.add("is-hidden");
    setStatus("");
    ui.btnJoin.disabled = false;
    showScreen("lobby");
    refreshBalances();
  });
}

async function refreshBalances() {
  try {
    const { usdc, mon } = await state.wallet.readBalances();
    ui.usdcLabel.textContent = formatUsdc(usdc);
    ui.monLabel.textContent = `${formatMon(mon)} MON`;

    const entryFee = BigInt(state.appConfig.entryFee);
    if (usdc < entryFee) {
      ui.btnJoin.disabled = true;
      setStatus("You need at least $1.00 USDC. Use Get Test USDC first.", "");
    } else if (mon === 0n) {
      ui.btnJoin.disabled = true;
      setStatus("You need testnet MON for gas. Claim it at testnet.monad.xyz", "error");
    } else if (!state.joining) {
      ui.btnJoin.disabled = false;
      setStatus("");
    }
  } catch (err) {
    setStatus(`Could not read balances: ${friendlyError(err)}`, "error");
  }
}

// ---------------------------------------------------------------------
// Join flow
// ---------------------------------------------------------------------

async function joinMatch() {
  if (state.joining) return;
  state.joining = true;
  ui.btnJoin.disabled = true;
  ui.btnFaucet.disabled = true;

  try {
    setStatus("Reserving a seat…", "busy");
    const socketId = await state.net.ready();

    const join = await fetchJson("/api/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: state.wallet.address, socketId }),
    });

    state.matchId = join.matchId;
    renderLobby(join.lobby);
    ui.queuePanel.classList.remove("is-hidden");

    const entryFee = BigInt(join.entryFee);

    setStatus("Approving USDC (one time)…", "busy");
    const approval = await state.wallet.approveIfNeeded(entryFee);
    if (approval) setStatus(`Approved · ${shortHash(approval.hash)}. Paying entry fee…`, "busy");
    else setStatus("Already approved. Paying entry fee…", "busy");

    const deposit = await state.wallet.depositEntryFee(join.matchId);
    setStatus(`Entry fee paid · ${shortHash(deposit.hash)}. Taking your seat…`, "busy");

    const result = await state.net.confirmSeat({
      matchId: join.matchId,
      address: state.wallet.address,
      name: state.playerName,
    });

    if (!result.ok) throw new Error(result.reason ?? "Server rejected the seat");

    setStatus("Seated. Waiting for the match to start…", "ok");
    await refreshBalances();
  } catch (err) {
    setStatus(friendlyError(err), "error");
    ui.btnJoin.disabled = false;
  } finally {
    state.joining = false;
    ui.btnFaucet.disabled = false;
  }
}

function renderLobby(lobby) {
  if (!lobby) return;
  ui.queueSeated.textContent = String(lobby.seated);
  ui.queueCap.textContent = String(lobby.capacity);

  ui.queueList.innerHTML = "";
  for (const p of lobby.players ?? []) {
    const li = document.createElement("li");
    li.textContent = `${p.name} · ${shortAddress(p.address)}`;
    ui.queueList.appendChild(li);
  }

  ui.queueChain.textContent = `relayer ${shortAddress(lobby.relayer)}${
    lobby.openTxHash ? ` · openMatch ${shortHash(lobby.openTxHash)}` : ""
  }`;

  if (state.countdownTimer) {
    clearInterval(state.countdownTimer);
    state.countdownTimer = null;
  }

  if (lobby.countdownAt) {
    const render = () => {
      const remaining = Math.max(0, lobby.countdownAt - Date.now());
      const seconds = Math.ceil(remaining / 1000);
      ui.queueMeta.textContent =
        remaining > 0
          ? `Starting in ${seconds}s · empty seats fill with bots`
          : "Filling remaining seats with bots…";
      if (remaining <= 0 && state.countdownTimer) {
        clearInterval(state.countdownTimer);
        state.countdownTimer = null;
      }
    };
    render();
    state.countdownTimer = setInterval(render, 250);
  } else {
    ui.queueMeta.textContent = `Waiting for players… ${lobby.seated}/${lobby.capacity} seated`;
  }
}

// ---------------------------------------------------------------------
// Match
// ---------------------------------------------------------------------

function wireSocket() {
  const net = state.net;

  net.on("lobby:update", renderLobby);

  net.on("lobby:seating_bots", ({ count }) => {
    ui.queueMeta.textContent = `Seating ${count} bot${count === 1 ? "" : "s"} on chain…`;
  });

  net.on("match:starting", ({ matchId, map, inMs }) => {
    state.matchId = matchId;
    // The game screen must be visible before Phaser is created or resized:
    // Phaser's Scale Manager measures the parent element's box on creation,
    // and a display:none ancestor measures as 0x0. Creating the canvas first
    // and showing the screen after leaves a Phaser instance permanently sized
    // to nothing, so the match plays out with no visible canvas at all.
    showScreen("game");
    startPhaser(map);
    state.hud.setMatch(matchId, net.socketId);
    if (inMs > 0) state.toasts.show(`Match starts in ${Math.ceil(inMs / 1000)}s`, "storm");
  });

  net.on("match:started", () => {
    state.input.enable();
    state.toasts.show("GO!", "storm");
  });

  net.on("match:state", (snapshot) => {
    state.scene?.setSnapshot(snapshot);
    state.hud.update(snapshot);
  });

  net.on("match:map_update", (payload) => {
    state.scene?.applyMapUpdate(payload);
    if (payload.ring !== undefined) {
      state.toasts.show(`Ring ${payload.ring} collapsed`, "storm");
    }
  });

  net.on("match:deaths", (deaths) => {
    for (const death of deaths) announceDeath(death, net.socketId);
  });

  net.on("chain:settlement", (event) => {
    state.hud.addSettlement(event);
    if (event.kind === "settlement_confirmed" && event.death?.killer?.id === net.socketId) {
      // The toast fires only once the chain confirms, so the number shown is
      // money that has actually moved, not an optimistic guess.
      state.toasts.show(`+$0.64 USDC settled in ${event.latencyMs}ms`, "reward");
    }
  });

  net.on("match:finished", (payload) => {
    state.input.disable();
    showResults(payload, net.socketId);
  });

  net.on("disconnect", () => {
    state.input.disable();
    setNet("Disconnected", "bad");
  });

  net.on("connect", () => {
    setNet(`Monad Testnet · ${state.appConfig?.chainId ?? ""}`, "ok");
  });
}

function announceDeath(death, selfId) {
  const isMe = death.victim.id === selfId;
  const iKilled = death.killer?.id === selfId;

  if (iKilled) {
    state.toasts.show(`You killed ${death.victim.name}!`, "reward");
    return;
  }
  if (isMe) {
    if (death.cause === "self") state.toasts.show("You blew yourself up. Bounty to jackpot.", "death");
    else if (death.cause === "environment") state.toasts.show("The storm got you.", "death");
    else state.toasts.show(`${death.killer?.name ?? "Someone"} killed you.`, "death");
    return;
  }

  // Third-party deaths are announced too, so the three settlement paths from the
  // death taxonomy are visible to a spectator rather than hidden in the logs.
  if (death.cause === "environment") {
    state.toasts.show(`${death.victim.name} was caught in the storm.`, "storm");
  } else if (death.cause === "self") {
    state.toasts.show(`${death.victim.name} blew themselves up.`, "storm");
  } else if (death.killer) {
    state.toasts.show(`${death.killer.name} eliminated ${death.victim.name}.`, "");
  }
}

function startPhaser(map) {
  const apply = () => {
    state.scene.setSelfId(state.net.socketId);
    state.scene.setMap(map);
  };

  if (!state.phaser) {
    const scene = new ArenaScene();
    state.scene = scene;
    state.phaser = new Phaser.Game({
      type: Phaser.AUTO,
      parent: "phaser-root",
      width: 720,
      height: 720,
      backgroundColor: "#0c0518",
      scene: [scene],
      scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
      render: { pixelArt: false, antialias: true },
    });

    // Phaser wires up a scene's event emitter asynchronously after the Game
    // is constructed: `scene.events` does not exist yet on this same tick, so
    // `scene.events.once(...)` crashed with "Cannot read properties of
    // undefined (reading 'once')" whenever match:starting arrived fast enough
    // to hit this branch before Phaser's boot had run. Retrying on the next
    // animation frame until events exists sidesteps depending on any specific
    // Phaser lifecycle event to know it's "ready enough" to subscribe to.
    const waitForEvents = () => {
      if (scene.events) {
        if (scene.sys?.isActive()) apply();
        else scene.events.once("create", apply);
      } else {
        requestAnimationFrame(waitForEvents);
      }
    };
    waitForEvents();
    return;
  }

  // The scene may not have run create() yet on the very first match.
  if (state.scene.sys?.isActive()) apply();
  else state.scene.events?.once("create", apply);
}

function showResults(payload, selfId) {
  const winner = payload.winner;
  const iWon = winner?.id === selfId;

  ui.resultsWinner.textContent = winner
    ? iWon
      ? `YOU WIN — ${winner.kills} kills`
      : `${winner.name} wins with ${winner.kills} kills`
    : "No survivors";

  ui.resultsGrid.innerHTML = "";
  const rows = [
    ["Winner", winner ? shortAddress(winner.address) : "—"],
    ["Kills", winner ? String(winner.kills) : "0"],
    ["Payout", "jackpot + remaining bounty"],
    ["Settled on", `Monad ${state.appConfig.chainId}`],
  ];
  for (const [label, value] of rows) {
    const wrap = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    wrap.append(dt, dd);
    ui.resultsGrid.appendChild(wrap);
  }

  ui.resultsRoot.textContent = `log root ${payload.logRoot}`;
  ui.resultsLog.href = `/api/match/${payload.matchId}/log`;

  setTimeout(() => showScreen("results"), 1600);
}

// ---------------------------------------------------------------------

function friendlyError(err) {
  const raw = err?.shortMessage ?? err?.details ?? err?.message ?? String(err);
  if (/User rejected|denied transaction|4001/i.test(raw)) return "You rejected the request in your wallet.";
  if (/insufficient funds/i.test(raw)) return "Not enough MON for gas. Claim some at testnet.monad.xyz";
  if (/LobbyFull/i.test(raw)) return "That lobby just filled up. Try joining again.";
  if (/AlreadyJoined/i.test(raw)) return "This wallet already paid into the match.";
  return raw.split("\n")[0].slice(0, 200);
}

boot();
