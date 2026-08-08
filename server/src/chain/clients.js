import { createPublicClient, createWalletClient, defineChain, http, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "../config.js";

/** Monad testnet. Defined locally rather than imported so the RPC URL and
 *  explorer stay configurable from a single place. */
export const monadTestnet = defineChain({
  id: config.chainId,
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [config.rpcUrl] } },
  blockExplorers: { default: { name: "MonadScan", url: config.explorerBase } },
  testnet: true,
});

/** Shared transport settings. The public testnet RPC rate-limits, so transient
 *  HTTP failures are expected and must be retried rather than surfaced as game
 *  errors. */
const transport = () =>
  http(config.rpcUrl, {
    retryCount: 4,
    retryDelay: 400,
    timeout: 30_000,
  });

export const publicClient = createPublicClient({
  chain: monadTestnet,
  transport: transport(),
});

export const ownerAccount = privateKeyToAccount(
  config.ownerPrivateKey.startsWith("0x") ? config.ownerPrivateKey : `0x${config.ownerPrivateKey}`,
);

export const ownerClient = createWalletClient({
  account: ownerAccount,
  chain: monadTestnet,
  transport: transport(),
});

/** Deterministic key derivation from a seed string. Restarting the server must
 *  reuse the same wallets, otherwise every restart abandons the MON already sent
 *  to the previous batch of relayers. */
export function deriveAccount(seed, index) {
  return privateKeyToAccount(keccak256(toHex(`${seed}:${index}`)));
}

export function walletFor(account) {
  return createWalletClient({ account, chain: monadTestnet, transport: transport() });
}

export function txUrl(hash) {
  return `${config.explorerBase}/tx/${hash}`;
}

/**
 * Waits for `count` new blocks.
 *
 * Needed after funding a fresh account. Monad executes asynchronously:
 * consensus validates block `n` against the state after block `n-k` (k=3), so a
 * wallet that was funded a moment ago still looks empty to the consensus-time
 * balance check. Its first transaction is then rejected outright with
 * "Signer had insufficient balance", even though the funding transfer has a
 * successful receipt and `eth_getBalance` reports the new balance.
 */
export async function waitForBlocks(count = 5) {
  const start = await publicClient.getBlockNumber();
  const target = start + BigInt(count);
  // Blocks are sub-second, so polling at 250ms adds negligible delay.
  for (let i = 0; i < 240; i++) {
    const current = await publicClient.getBlockNumber();
    if (current >= target) return current;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${count} blocks after ${start}`);
}
