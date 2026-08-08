import { config } from "../config.js";
import { publicClient, txUrl } from "./clients.js";
import { gridZoneArenaAbi } from "./abis.js";
import { gasOracle } from "./gasOracle.js";
import { withRetry } from "../util/async.js";
import { log } from "../logger.js";
import { DEATH } from "../game/constants.js";

/**
 * Routes simulation events to the right contract function and reports back.
 *
 * The mapping is the death taxonomy from PRD §3.3, and getting it wrong is a
 * money bug rather than a cosmetic one:
 *   PvP kill        -> processKillReward           80% to the killer, 20% to jackpot
 *   self-kill       -> processEnvironmentOrSelfDeath(selfInflicted: true)   100% jackpot
 *   red-zone death  -> processEnvironmentOrSelfDeath(selfInflicted: false)  100% jackpot
 *
 * `processKillReward` reverts on `killer == victim`, so a self-kill misrouted
 * here fails loudly instead of silently paying someone for their own death.
 */
export class Settlement {
  /**
   * @param {object} opts
   * @param {import('./relayerPool.js').RelayerPool} opts.pool
   * @param {(event: object) => void} opts.onEvent  UI/telemetry sink
   */
  constructor({ relayer, matchId, onEvent }) {
    this.relayer = relayer;
    this.matchId = matchId;
    this.onEvent = onEvent ?? (() => {});
    this.pending = new Set();
  }

  /** Settles all deaths from one simulation tick. */
  async settleDeaths(deaths) {
    if (deaths.length === 0) return;

    // One death is the common case; a single call keeps latency lowest, which is
    // what the sub-second settlement metric is actually measuring.
    if (deaths.length === 1) {
      await this._settleSingle(deaths[0]);
      return;
    }

    // Several deaths in the same tick: batch them so the burst does not queue up
    // behind this relayer's sequential nonce (PRD §5.3 fallback).
    await this._settleBatch(deaths);
  }

  async _settleSingle(death) {
    const victim = death.victim.address;

    if (death.cause === DEATH.PVP && death.killer) {
      await this._submit({
        label: "kill",
        functionName: "processKillReward",
        args: [this.matchId, death.killer.address, victim],
        fallbackGas: config.gas.processKillReward,
        death,
      });
      return;
    }

    await this._submit({
      label: death.cause === DEATH.SELF ? "self-kill" : "env-death",
      functionName: "processEnvironmentOrSelfDeath",
      args: [this.matchId, victim, death.cause === DEATH.SELF],
      fallbackGas: config.gas.processEnvironmentOrSelfDeath,
      death,
    });
  }

  async _settleBatch(deaths) {
    // The contract treats killer == victim or the zero address as "no
    // beneficiary", which is exactly how self-kills and red-zone deaths encode.
    const killers = deaths.map((d) =>
      d.cause === DEATH.PVP && d.killer ? d.killer.address : "0x0000000000000000000000000000000000000000",
    );
    const victims = deaths.map((d) => d.victim.address);

    await this._submit({
      label: `batch(${deaths.length})`,
      functionName: "processKillBatch",
      args: [this.matchId, killers, victims],
      gasKey: `processKillBatch:${deaths.length}`,
      fallbackGas: config.gas.killBatchBase + config.gas.killBatchPerEntry * BigInt(deaths.length),
      deaths,
    });
  }

  async finalize(winnerAddress, logRoot) {
    return this._submit({
      label: "finalize",
      functionName: "finalizeMatch",
      args: [this.matchId, winnerAddress, logRoot],
      fallbackGas: config.gas.finalizeMatch,
    });
  }

  async openMatchBounty(playerAddress) {
    return this._submit({
      label: "seat-bot",
      functionName: "depositEntryFeeFor",
      args: [this.matchId, playerAddress],
      fallbackGas: config.gas.depositEntryFeeFor,
    });
  }

  async _submit({ label, functionName, args, gasKey, fallbackGas, death, deaths }) {
    const started = Date.now();
    let hash;

    // Estimate against the live chain rather than trusting a hardcoded limit:
    // the relayer pays for the limit, not for what it uses.
    const gas = await gasOracle.limitFor(
      gasKey ?? functionName,
      {
        account: this.relayer.account,
        address: config.arenaAddress,
        abi: gridZoneArenaAbi,
        functionName,
        args,
      },
      fallbackGas,
    );

    try {
      // Retry submission failures. The public RPC drops requests under load, and
      // an unsent settlement means a player never gets paid. This is safe to
      // retry because it only covers the window before a hash exists: if the
      // send returned, the transaction is tracked below instead and is never
      // resubmitted, so there is no risk of settling the same death twice.
      const res = await withRetry(
        () =>
          this.relayer.send({
            label,
            address: config.arenaAddress,
            abi: gridZoneArenaAbi,
            functionName,
            args,
            gas,
          }),
        { attempts: 3, delayMs: 500, label: `settle ${label}` },
      );
      hash = res.hash;
    } catch (err) {
      const message = err?.shortMessage ?? err?.message ?? String(err);
      log.error(`settle ${label} failed: ${message}`);
      this.onEvent({ kind: "settlement_failed", label, functionName, error: message, death, deaths });
      return null;
    }

    this.onEvent({
      kind: "settlement_sent",
      label,
      functionName,
      hash,
      url: txUrl(hash),
      relayer: this.relayer.address,
      death,
      deaths,
    });

    const tracked = (async () => {
      try {
        const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
        const ms = Date.now() - started;

        if (receipt.status !== "success") {
          log.error(`settle ${label} reverted: ${hash}`);
          this.onEvent({ kind: "settlement_reverted", label, hash, url: txUrl(hash), death, deaths });
          return;
        }

        // Note: on Monad `gasUsed` comes back equal to the limit, because the
        // limit is what was charged. It is therefore useless for tuning; the
        // gas oracle's estimate is the number that matters.
        log.chain(
          `${label} ok in ${ms}ms  block=${receipt.blockNumber}  gasCharged=${receipt.gasUsed}  ${hash.slice(0, 12)}…`,
        );

        this.onEvent({
          kind: "settlement_confirmed",
          label,
          functionName,
          hash,
          url: txUrl(hash),
          latencyMs: ms,
          blockNumber: receipt.blockNumber.toString(),
          gasUsed: receipt.gasUsed.toString(),
          gasLimit: gas.toString(),
          relayer: this.relayer.address,
          death,
          deaths,
        });
      } catch (err) {
        log.error(`settle ${label} receipt error: ${err?.shortMessage ?? err?.message}`);
      } finally {
        this.pending.delete(tracked);
      }
    })();

    this.pending.add(tracked);
    return hash;
  }

  /** Lets the caller wait for outstanding receipts before finalizing. */
  async drain() {
    await Promise.allSettled([...this.pending]);
  }
}
