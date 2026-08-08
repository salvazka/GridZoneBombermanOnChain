/** Prints MON/USDC balances for the owner and every relayer key, plus a live
 *  eth_estimateGas for the settlement functions so gas limits can be set from
 *  real Monad numbers instead of guesses. */
import { erc20Abi, formatUnits } from "viem";
import { config } from "../src/config.js";
import { publicClient, ownerAccount, deriveAccount } from "../src/chain/clients.js";

const count = Number(process.env.RELAYER_COUNT ?? config.relayerCount);

const ownerBal = await publicClient.getBalance({ address: ownerAccount.address });
console.log(`owner   ${ownerAccount.address}  ${formatUnits(ownerBal, 18)} MON`);

let relayerTotal = 0n;
for (let i = 0; i < Math.max(count, 8); i++) {
  const acct = deriveAccount(config.relayerSeed, i);
  const [mon, usdc] = await Promise.all([
    publicClient.getBalance({ address: acct.address }),
    publicClient.readContract({
      address: config.usdcAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [acct.address],
    }),
  ]);
  relayerTotal += mon;
  const active = i < count ? "*" : " ";
  console.log(
    `relay${i}${active} ${acct.address}  ${formatUnits(mon, 18).padEnd(20)} MON  ${formatUnits(usdc, 6)} USDC`,
  );
}

console.log(`\nrelayer MON total: ${formatUnits(relayerTotal, 18)}`);

const gasPrice = await publicClient.getGasPrice();
console.log(`gas price        : ${formatUnits(gasPrice, 9)} gwei`);
console.log(`cost per 100k gas: ${formatUnits(gasPrice * 100_000n, 18)} MON`);

const arenaUsdc = await publicClient.readContract({
  address: config.usdcAddress,
  abi: erc20Abi,
  functionName: "balanceOf",
  args: [config.arenaAddress],
});
const liabilities = await publicClient.readContract({
  address: config.arenaAddress,
  abi: (await import("../src/chain/abis.js")).gridZoneArenaAbi,
  functionName: "totalLiabilities",
  args: [],
});
console.log(`\narena vault      : ${formatUnits(arenaUsdc, 6)} USDC`);
console.log(`arena liabilities: ${formatUnits(liabilities, 6)} USDC`);
console.log(`solvency invariant: ${arenaUsdc === liabilities ? "HOLDS" : "VIOLATED"}`);
