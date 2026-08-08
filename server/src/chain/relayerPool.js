import { erc20Abi } from "viem";
import { config } from "../config.js";
import { publicClient, ownerClient, ownerAccount, deriveAccount, walletFor, waitForBlocks } from "./clients.js";
import { mapLimit, withRetry } from "../util/async.js";
import { log } from "../logger.js";

/** Max simultaneous RPC calls. Kept low because the public Monad testnet
 *  endpoint rate-limits well before this becomes a throughput bottleneck. */
const RPC_CONCURRENCY = 4;

/**
 * A pool of relayer EOAs, one bound per match.
 *
 * Why a pool at all: a single relayer cannot settle two kills concurrently no
 * matter how fast the chain is, because an EOA's nonces are strictly sequential.
 * Late-game Bomberman produces bursts of deaths, so one key would serialise the
 * whole demo and make Monad look slow for reasons that have nothing to do with
 * Monad. Sharding one key per match (PRD §5.3) is what turns the per-match
 * storage isolation in the contract into observable parallelism.
 *
 * Each relayer owns its own nonce counter and a promise chain, so signing order
 * is deterministic per key while different keys proceed independently.
 */
class Relayer {
  constructor(index, account) {
    this.index = index;
    this.account = account;
    this.address = account.address;
    this.wallet = walletFor(account);
    this.nextNonce = null;
    this.tail = Promise.resolve();
    this.assignedMatches = 0;
    this.sent = 0;
    this.failed = 0;
  }

  get busy() {
    return this.assignedMatches;
  }

  async syncNonce() {
    // "pending" so queued-but-unmined txs are counted; otherwise a burst would
    // reuse a nonce that is already in the mempool.
    this.nextNonce = await publicClient.getTransactionCount({
      address: this.address,
      blockTag: "pending",
    });
  }

  /**
   * Serialises one contract write onto this relayer's chain.
   * @returns {Promise<{hash: string, receipt: object}>}
   */
  send({ label, address, abi, functionName, args, gas }) {
    const run = async () => {
      if (this.nextNonce === null) await this.syncNonce();

      const nonce = this.nextNonce;
      this.nextNonce = nonce + 1;

      try {
        const hash = await this.wallet.writeContract({
          address,
          abi,
          functionName,
          args,
          // Explicit gas: on Monad the signer pays for the limit, not for usage.
          gas,
          nonce,
        });
        this.sent++;
        return { hash, label, nonce };
      } catch (err) {
        this.failed++;
        // A rejected tx never consumed its nonce, so the local counter is now
        // ahead of the chain. Resync rather than leaving every later tx stuck.
        this.nextNonce = null;
        throw err;
      }
    };

    const result = this.tail.then(run, run);
    // Keep the chain alive after a failure, otherwise one bad tx wedges the key.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export class RelayerPool {
  constructor() {
    /** @type {Relayer[]} */
    this.relayers = [];
    this.ready = false;
  }

  async init() {
    for (let i = 0; i < config.relayerCount; i++) {
      this.relayers.push(new Relayer(i, deriveAccount(config.relayerSeed, i)));
    }

    log.info(`relayer pool: ${this.relayers.length} keys`);
    await this._fundGas();
    await this._fundUsdc();
    await mapLimit(this.relayers, RPC_CONCURRENCY, (r) => withRetry(() => r.syncNonce(), { label: "syncNonce" }));

    this.ready = true;
  }

  /**
   * Top up relayers with MON for gas. These transfers all originate from the
   * owner, so they are inherently sequential and are awaited in order.
   */
  async _fundGas() {
    const balances = await mapLimit(this.relayers, RPC_CONCURRENCY, (r) =>
      withRetry(() => publicClient.getBalance({ address: r.address }), { label: `balance ${r.address}` }),
    );

    const unreadable = balances.filter((b) => b.status !== "fulfilled");
    if (unreadable.length > 0) {
      throw new Error(`Could not read balance for ${unreadable.length} relayer(s): ${unreadable[0].reason?.message}`);
    }

    const needy = this.relayers.filter((_, i) => balances[i].value < config.relayerMinBalanceWei);
    if (needy.length === 0) {
      log.info("relayer gas: all funded");
      return;
    }

    const ownerBalance = await publicClient.getBalance({ address: ownerAccount.address });
    const total = config.relayerTopUpWei * BigInt(needy.length);
    if (ownerBalance < total) {
      throw new Error(
        `Owner ${ownerAccount.address} has ${ownerBalance} wei but needs ${total} to fund ${needy.length} relayers. Get testnet MON at https://testnet.monad.xyz`,
      );
    }

    log.info(`relayer gas: funding ${needy.length} key(s) with ${config.relayerTopUpWei} wei each`);

    let nonce = await publicClient.getTransactionCount({
      address: ownerAccount.address,
      blockTag: "pending",
    });

    const hashes = [];
    for (const r of needy) {
      const hash = await ownerClient.sendTransaction({
        to: r.address,
        value: config.relayerTopUpWei,
        // A plain MON transfer is always 21000. Hardcoding avoids an
        // eth_estimateGas round trip whose result we would pay for in full.
        gas: config.gas.transfer,
        nonce: nonce++,
      });
      hashes.push(hash);
    }

    await mapLimit(hashes, RPC_CONCURRENCY, (hash) =>
      publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 }),
    );

    // A receipt is not enough: consensus validates against a k-block-lagged
    // state, so a just-funded relayer's first tx would be rejected for
    // insufficient balance. Let the lagged view catch up before using the keys.
    await waitForBlocks(5);
    log.info("relayer gas: funded");
  }

  /**
   * Give each relayer a MockUSDC float and an allowance, so it can seat demo
   * bots through depositEntryFeeFor. Bots must hold a real bounty or the
   * conservation invariant breaks during a bot-filled lobby (PRD §9.3).
   *
   * MockUSDC.mint is permissionless on testnet, so each relayer funds itself.
   * That is 2 txs per key, once, and they run in parallel across keys.
   */
  async _fundUsdc() {
    // Bounded concurrency throughout: issuing one request per key at once is
    // enough to get rate-limited by the public RPC, and a dropped setup tx here
    // silently breaks bot seating later.
    const state = await mapLimit(this.relayers, RPC_CONCURRENCY, async (r) =>
      withRetry(
        async () => {
          const [balance, allowance] = await Promise.all([
            publicClient.readContract({
              address: config.usdcAddress,
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [r.address],
            }),
            publicClient.readContract({
              address: config.usdcAddress,
              abi: erc20Abi,
              functionName: "allowance",
              args: [r.address, config.arenaAddress],
            }),
          ]);
          return { balance, allowance };
        },
        { label: `usdc state ${r.address}` },
      ),
    );

    const jobs = [];
    for (let i = 0; i < this.relayers.length; i++) {
      if (state[i].status !== "fulfilled") {
        log.warn(`relayer usdc: could not read state for ${this.relayers[i].address}`);
        continue;
      }
      const r = this.relayers[i];
      const { balance, allowance } = state[i].value;

      if (balance < config.relayerUsdcFloat) {
        jobs.push({
          relayer: r,
          label: "usdc.mint",
          abi: mintAbi,
          functionName: "mint",
          args: [r.address, config.relayerUsdcFloat],
          gas: config.gas.mint,
        });
      }
      if (allowance < config.relayerUsdcFloat) {
        jobs.push({
          relayer: r,
          label: "usdc.approve",
          abi: erc20Abi,
          functionName: "approve",
          args: [config.arenaAddress, 2n ** 255n],
          gas: config.gas.approve,
        });
      }
    }

    if (jobs.length === 0) {
      log.info("relayer usdc: all funded and approved");
      return;
    }

    log.info(`relayer usdc: ${jobs.length} setup tx(s) across ${this.relayers.length} keys`);

    const results = await mapLimit(jobs, RPC_CONCURRENCY, async (job) =>
      withRetry(
        async () => {
          const { hash } = await job.relayer.send({
            label: job.label,
            address: config.usdcAddress,
            abi: job.abi,
            functionName: job.functionName,
            args: job.args,
            gas: job.gas,
          });
          const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
          if (receipt.status !== "success") throw new Error(`${job.label} reverted`);
          return hash;
        },
        { label: `${job.label} ${job.relayer.address}`, attempts: 3 },
      ),
    );

    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length > 0) {
      // Loud rather than a warning: a relayer without USDC cannot seat bots, so
      // any match it is assigned would start short-handed.
      log.error(`relayer usdc: ${failed.length} setup tx(s) still failing after retries`);
      log.error(`  first error: ${failed[0].reason?.shortMessage ?? failed[0].reason?.message}`);
    }

    await this._assertUsdcReady();
  }

  /** Verifies the end state rather than trusting the tx results. */
  async _assertUsdcReady() {
    const checks = await mapLimit(this.relayers, RPC_CONCURRENCY, async (r) => {
      const [balance, allowance] = await Promise.all([
        publicClient.readContract({
          address: config.usdcAddress,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [r.address],
        }),
        publicClient.readContract({
          address: config.usdcAddress,
          abi: erc20Abi,
          functionName: "allowance",
          args: [r.address, config.arenaAddress],
        }),
      ]);
      return { address: r.address, balance, allowance };
    });

    const notReady = checks.filter(
      (c) =>
        c.status !== "fulfilled" ||
        c.value.balance < config.relayerUsdcFloat ||
        c.value.allowance < config.relayerUsdcFloat,
    );

    if (notReady.length > 0) {
      log.warn(`relayer usdc: ${notReady.length}/${this.relayers.length} key(s) not fully provisioned`);
    } else {
      log.info(`relayer usdc: ${this.relayers.length}/${this.relayers.length} keys funded and approved`);
    }
  }

  /**
   * Tops a single relayer back up if it has drifted below the floor.
   *
   * Called before a match starts. Checking only at boot is not enough: a relayer
   * that has already settled a few matches can fall below the floor mid-session
   * and then fail partway through seating a lobby, which strands the match.
   */
  async ensureFunded(relayer) {
    const balance = await publicClient.getBalance({ address: relayer.address });
    if (balance >= config.relayerMinBalanceWei) return true;

    const ownerBalance = await publicClient.getBalance({ address: ownerAccount.address });
    if (ownerBalance < config.relayerTopUpWei) {
      log.error(
        `owner ${ownerAccount.address} cannot top up relayer ${relayer.address}: ` +
          `has ${ownerBalance} wei, needs ${config.relayerTopUpWei}. Fund it at https://testnet.monad.xyz`,
      );
      return false;
    }

    log.info(`relayer ${relayer.address.slice(0, 10)}… low (${balance} wei), topping up`);

    const nonce = await publicClient.getTransactionCount({
      address: ownerAccount.address,
      blockTag: "pending",
    });
    const hash = await ownerClient.sendTransaction({
      to: relayer.address,
      value: config.relayerTopUpWei,
      gas: config.gas.transfer,
      nonce,
    });
    await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });

    // Consensus needs to see the top-up before this key's next tx, or that tx
    // is rejected for insufficient balance against the lagged state.
    await waitForBlocks(5);
    return true;
  }

  /** Least-loaded key, so concurrent matches land on distinct relayers. */
  acquire() {
    if (!this.ready) throw new Error("relayer pool not initialised");
    let best = this.relayers[0];
    for (const r of this.relayers) if (r.busy < best.busy) best = r;
    best.assignedMatches++;
    return best;
  }

  release(relayer) {
    if (relayer) relayer.assignedMatches = Math.max(0, relayer.assignedMatches - 1);
  }

  stats() {
    return this.relayers.map((r) => ({
      index: r.index,
      address: r.address,
      activeMatches: r.assignedMatches,
      sent: r.sent,
      failed: r.failed,
    }));
  }
}

/** MockUSDC.mint is not part of the standard ERC-20 ABI viem ships. */
const mintAbi = [
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
];

export const relayerPool = new RelayerPool();
