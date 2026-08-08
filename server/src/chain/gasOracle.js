import { publicClient } from "./clients.js";
import { log } from "../logger.js";

/**
 * Picks gas limits from live `eth_estimateGas` rather than hardcoded guesses.
 *
 * This matters much more on Monad than on Ethereum. Monad charges
 * `gas_limit * price`, so the limit *is* the price: a limit set 2x too high
 * doubles the relayer's cost, and `receipt.gasUsed` is no help for tuning
 * because it reports the amount charged (i.e. the limit) rather than the amount
 * actually consumed. Estimating against the real chain is the only way to get
 * honest numbers, since Monad also reprices cold state access well above
 * Ethereum, making local `forge` measurements systematically low.
 *
 * Estimates are cached per call shape. Gas for a given code path is effectively
 * constant across matches, and re-estimating before every settlement would add
 * an RPC round trip to the latency the demo is trying to showcase.
 */
export class GasOracle {
  /**
   * @param {object} opts
   * @param {number} opts.bufferPct headroom added on top of the estimate
   */
  constructor({ bufferPct = 25 } = {}) {
    this.bufferPct = BigInt(bufferPct);
    /** @type {Map<string, bigint>} */
    this.cache = new Map();
    /** @type {Map<string, Promise<bigint>>} */
    this.inFlight = new Map();
  }

  /**
   * @param {string} key      cache key, usually the function name
   * @param {object} call     { account, address, abi, functionName, args }
   * @param {bigint} fallback used when estimation is unavailable
   */
  limitFor(key, call, fallback) {
    const cached = this.cache.get(key);
    if (cached !== undefined) return Promise.resolve(cached);

    // Memoise the in-flight promise, not just the settled value. Seating a lobby
    // fires 15 settlements at once, and caching only the result let all 15 race
    // past the empty cache: 15 redundant estimateGas calls that each returned a
    // slightly different number, so sibling transactions used different limits.
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const promise = this._estimate(key, call, fallback).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  async _estimate(key, call, fallback) {
    try {
      const estimate = await publicClient.estimateContractGas(call);
      const limit = estimate + (estimate * this.bufferPct) / 100n;

      // Never let an estimate exceed the configured ceiling: a bad estimate
      // should not be able to drain a relayer in one transaction.
      const capped = limit > fallback ? fallback : limit;

      this.cache.set(key, capped);
      log.chain(
        `gas ${key}: estimated ${estimate}, using ${capped} (+${this.bufferPct}% buffer, cap ${fallback})`,
      );
      return capped;
    } catch (err) {
      // Estimation can fail transiently, or because the call really would
      // revert. Either way the fallback keeps the game moving, and a revert
      // surfaces in the settlement feed.
      log.warn(`gas ${key}: estimate failed (${err?.shortMessage ?? err?.message}), using ${fallback}`);
      this.cache.set(key, fallback);
      return fallback;
    }
  }

  snapshot() {
    return Object.fromEntries([...this.cache].map(([k, v]) => [k, v.toString()]));
  }
}

export const gasOracle = new GasOracle({ bufferPct: Number(process.env.GAS_BUFFER_PCT ?? 25) });
