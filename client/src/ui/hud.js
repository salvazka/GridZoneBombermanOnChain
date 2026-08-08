import { formatUsdc, shortHash, colorForPlayer, cssColor } from "../lib/format.js";

/** Live match HUD: leaderboard, earnings, red zone timer and settlement feed. */
export class Hud {
  constructor() {
    this.el = {
      earnings: document.getElementById("hud-earnings"),
      ringTimer: document.getElementById("hud-ring-timer"),
      ringLabel: document.getElementById("hud-ring-label"),
      leaderboard: document.getElementById("hud-leaderboard"),
      aliveCount: document.getElementById("hud-alive-count"),
      feed: document.getElementById("hud-feed"),
      matchId: document.getElementById("hud-match-id"),
      tick: document.getElementById("hud-tick"),
    };
    this.selfId = null;
    this.feedItems = [];
  }

  setMatch(matchId, selfId) {
    this.selfId = selfId;
    this.el.matchId.textContent = `match ${matchId.slice(0, 10)}…`;
    this.el.feed.innerHTML = "";
    this.feedItems = [];
    this.el.earnings.textContent = "+$0.00";
  }

  update(snapshot) {
    const alive = snapshot.players.filter((p) => p.alive);
    this.el.aliveCount.textContent = `${alive.length}/${snapshot.players.length}`;
    this.el.tick.textContent = `tick ${snapshot.tick}`;

    const me = snapshot.players.find((p) => p.id === this.selfId);
    if (me) this.el.earnings.textContent = formatUsdc(BigInt(me.earnings), { sign: true });

    this._updateRing(snapshot);
    this._updateLeaderboard(snapshot);
  }

  _updateRing(snapshot) {
    if (snapshot.nextShrinkInMs === null) {
      this.el.ringTimer.textContent = "FINAL";
      this.el.ringTimer.classList.remove("is-urgent");
      this.el.ringLabel.textContent = "no rings left";
      return;
    }

    const seconds = Math.ceil(snapshot.nextShrinkInMs / 1000);
    this.el.ringTimer.textContent = `${seconds}s`;
    this.el.ringTimer.classList.toggle("is-urgent", seconds <= 5);

    // Before the first collapse the countdown is the grace period, not a ring.
    const inGrace = snapshot.safeRing === 1;
    this.el.ringLabel.textContent = inGrace
      ? "until first collapse"
      : `ring ${snapshot.safeRing} collapses next`;
  }

  _updateLeaderboard(snapshot) {
    const sorted = [...snapshot.players].sort((a, b) => {
      if (a.alive !== b.alive) return a.alive ? -1 : 1;
      if (b.kills !== a.kills) return b.kills - a.kills;
      return BigInt(b.earnings) > BigInt(a.earnings) ? 1 : -1;
    });

    this.el.leaderboard.innerHTML = "";
    for (const p of sorted) {
      const li = document.createElement("li");
      if (p.id === this.selfId) li.classList.add("is-you");
      if (!p.alive) li.classList.add("is-dead");

      const name = document.createElement("span");
      name.className = "lb__name";

      const swatch = document.createElement("span");
      swatch.className = "lb__swatch";
      swatch.style.background = cssColor(colorForPlayer(p.id));
      name.appendChild(swatch);
      name.appendChild(document.createTextNode(p.name));

      const kills = document.createElement("span");
      kills.className = "lb__kills";
      kills.textContent = `${p.kills}k`;

      const tag = document.createElement("span");
      tag.className = "lb__tag";
      tag.textContent = p.alive ? formatUsdc(BigInt(p.earnings)) : deathTag(p.deathCause);

      li.append(name, kills, tag);
      this.el.leaderboard.appendChild(li);
    }
  }

  /** Appends a settlement event, replacing the "sent" row when it confirms. */
  addSettlement(event) {
    if (event.kind === "settlement_sent") {
      const li = document.createElement("li");
      li.dataset.hash = event.hash;
      li.innerHTML = `<strong>${escapeHtml(event.label)}</strong> submitted
        <span class="feed__meta">${escapeHtml(shortHash(event.hash))} · awaiting receipt</span>`;
      this.el.feed.prepend(li);
      this._trimFeed();
      return;
    }

    if (event.kind === "settlement_confirmed") {
      const existing = this.el.feed.querySelector(`li[data-hash="${event.hash}"]`);
      const li = existing ?? document.createElement("li");
      li.dataset.hash = event.hash;
      li.className = "is-confirmed";
      li.innerHTML = `<strong>${escapeHtml(event.label)}</strong> settled in ${event.latencyMs}ms
        <span class="feed__meta">
          <a href="${escapeHtml(event.url)}" target="_blank" rel="noopener">${escapeHtml(shortHash(event.hash))}</a>
          · block ${escapeHtml(event.blockNumber)} · gas ${escapeHtml(event.gasUsed)}
        </span>`;
      if (!existing) this.el.feed.prepend(li);
      this._trimFeed();
      return;
    }

    if (event.kind === "settlement_failed" || event.kind === "settlement_reverted") {
      const li = document.createElement("li");
      li.className = "is-failed";
      li.innerHTML = `<strong>${escapeHtml(event.label)}</strong> failed
        <span class="feed__meta">${escapeHtml(event.error ?? "reverted on chain")}</span>`;
      this.el.feed.prepend(li);
      this._trimFeed();
    }
  }

  _trimFeed() {
    while (this.el.feed.children.length > 40) {
      this.el.feed.removeChild(this.el.feed.lastChild);
    }
  }
}

function deathTag(cause) {
  if (cause === "self") return "self-kill";
  if (cause === "environment") return "storm";
  if (cause === "pvp") return "killed";
  return "out";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
