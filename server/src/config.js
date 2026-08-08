import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(here, "..");
const repoRoot = resolve(serverRoot, "..");

dotenv.config({ path: resolve(serverRoot, ".env") });

const CHAIN_ID = Number(process.env.CHAIN_ID ?? 10143);

function loadDeployment() {
  const path = resolve(repoRoot, `contracts/deployments/${CHAIN_ID}.json`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(
      `No deployment found at ${path}. Run contracts/deploy.sh first, or set ARENA_ADDRESS and USDC_ADDRESS in server/.env.`,
    );
  }
}

const deployment = process.env.ARENA_ADDRESS && process.env.USDC_ADDRESS ? null : loadDeployment();

function required(name, value) {
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3001),
  clientOrigin: process.env.CLIENT_ORIGIN ?? "http://localhost:5173",

  chainId: CHAIN_ID,
  rpcUrl: process.env.MONAD_RPC_URL ?? "https://testnet-rpc.monad.xyz",
  explorerBase: process.env.EXPLORER_BASE ?? "https://testnet.monadscan.com",

  arenaAddress: (process.env.ARENA_ADDRESS ?? deployment.arena).toLowerCase(),
  usdcAddress: (process.env.USDC_ADDRESS ?? deployment.mockUsdc).toLowerCase(),

  /** Contract owner. Calls openMatch and funds the relayer pool. */
  ownerPrivateKey: required("OWNER_PRIVATE_KEY", process.env.OWNER_PRIVATE_KEY),

  /**
   * Relayer pool size. One key is bound per match so nonces never serialise
   * across matches (PRD §5.3). The PRD suggests 20-50 for a public demo; the
   * default here is 4 because each key needs a real MON balance to be useful,
   * and 4 concurrent matches is already enough to show cross-match parallelism.
   */
  relayerCount: Number(process.env.RELAYER_COUNT ?? 4),

  /** Seeds for deterministic key derivation, so restarts reuse funded wallets
   *  instead of stranding MON in throwaway addresses. */
  relayerSeed: process.env.RELAYER_SEED ?? "gridzone-relayer-pool-v1",
  botSeed: process.env.BOT_SEED ?? "gridzone-bot-pool-v1",

  /**
   * Relayer gas budget.
   *
   * Sized from measured cost, not guessed. A full 16-player match costs one
   * relayer roughly: 15 bot seats + up to 15 death settlements + 1 finalize,
   * about 31 txs. At ~250k gas and ~102 gwei that is ~0.8 MON per match. The
   * first run of this server used 0.5 MON per relayer and a relayer ran dry
   * after exactly 10 bot seats, aborting the match.
   *
   * The top-up also has to clear Monad's consensus-time reserve budget, which
   * caps in-flight gas per account at min(10 MON, balance): too small a balance
   * throttles late-game bursts even when the account is technically solvent.
   */
  relayerMinBalanceWei: BigInt(process.env.RELAYER_MIN_BALANCE_WEI ?? 1_500_000_000_000_000_000n), // 1.5 MON
  relayerTopUpWei: BigInt(process.env.RELAYER_TOPUP_WEI ?? 4_000_000_000_000_000_000n), // 4 MON

  /** USDC the relayer keeps on hand to seat demo bots via depositEntryFeeFor. */
  relayerUsdcFloat: BigInt(process.env.RELAYER_USDC_FLOAT ?? 200_000_000n), // 200 USDC

  /**
   * Ceiling gas limits, in gas units.
   *
   * These are a safety cap, not the value normally used: `gasOracle` estimates
   * against the live chain per call shape and caps the result here. Monad
   * charges `gas_limit * price` rather than gas used, so a limit set too high is
   * money straight out of the relayer's balance.
   *
   * The numbers below come from an actual settled match on Monad testnet
   * (estimate plus the oracle's 25% buffer):
   *   depositEntryFeeFor            297,007
   *   processKillReward             183,705
   *   processEnvironmentOrSelfDeath  90,912   (no ERC-20 transfer, so far cheaper)
   *   processKillBatch (2 deaths)   214,591
   *   finalizeMatch                 524,243   (sweeps 16 player slots)
   *
   * Note `receipt.gasUsed` on Monad reports the amount *charged*, which equals
   * the limit, so receipts cannot be used to tune these. Only estimation can.
   */
  gas: {
    openMatch: BigInt(process.env.GAS_OPEN_MATCH ?? 250_000n),
    depositEntryFeeFor: BigInt(process.env.GAS_DEPOSIT_FOR ?? 320_000n),
    processKillReward: BigInt(process.env.GAS_KILL ?? 230_000n),
    processEnvironmentOrSelfDeath: BigInt(process.env.GAS_DEATH ?? 130_000n),
    killBatchBase: BigInt(process.env.GAS_BATCH_BASE ?? 90_000n),
    killBatchPerEntry: BigInt(process.env.GAS_BATCH_PER_ENTRY ?? 120_000n),
    finalizeMatch: BigInt(process.env.GAS_FINALIZE ?? 600_000n),
    mint: BigInt(process.env.GAS_MINT ?? 150_000n),
    approve: BigInt(process.env.GAS_APPROVE ?? 100_000n),
    transfer: 21_000n,
  },

  paths: {
    repoRoot,
    serverRoot,
  },
};
