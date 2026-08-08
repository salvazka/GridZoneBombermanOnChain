# GridZone

Classic Bomberman battle royale where every elimination settles instantly in
stablecoin on Monad. 16 players, a 20×20 grid, one shrinking red zone, and a
kill-reward transfer per death.

Built from [`GridZone_PRD.md`](./GridZone_PRD.md).

## Live deployment (Monad Testnet, chain `10143`)

| Contract | Address |
| --- | --- |
| `GridZoneArena` | [`0x15A857eEe421D35Aa7397D83eaC68B3149B18D79`](https://testnet.monadscan.com/address/0x15A857eEe421D35Aa7397D83eaC68B3149B18D79) |
| `MockUSDC` | [`0x40556C6d729660aA1F24AA622Ea4BeBFdd28446a`](https://testnet.monadscan.com/address/0x40556C6d729660aA1F24AA622Ea4BeBFdd28446a) |
| Owner / deployer | `0xd10e2972d7995fF6f574dC723082682306944c8B` |

`MockUSDC` has an open faucet so anyone can fund themselves. Testnet only, no value.

## Layout

```
contracts/   Foundry project: GridZoneArena.sol, MockUSDC.sol, tests, deploy script
server/      Authoritative simulation, sharded relayer pool, settlement, Socket.io
client/      Vite + Phaser front end, lobby and in-match HUD
```

## Running it

Prerequisites: Node 20+, and Foundry only if you want to rebuild or redeploy the
contracts. On Windows, Foundry needs WSL.

```bash
npm run install:all     # installs server and client deps
npm run dev             # server on :3001, client on :5173
```

Then open <http://localhost:5173>.

In the lobby: connect a wallet (the Monad Testnet network is added for you), press
**Get Test USDC**, then **Approve & Join Match**. You need a little testnet MON for
gas — claim it at <https://testnet.monad.xyz>.

The lobby waits 10 seconds for other humans and then fills the remaining seats
with bots, each of which pays a real on-chain entry fee.

Controls: `WASD` or arrows to move, `Space` to drop a bomb.

### Running the pieces separately

```bash
npm run dev:server
npm run dev:client
```

### Configuration

`server/.env` (see `server/.env.example`) holds the owner key and relayer pool
settings. Contract addresses are read from `contracts/deployments/10143.json`, so
a redeploy needs no code change.

The owner wallet funds the relayer pool, so it needs MON. Each relayer is topped
up to 4 MON, which covers roughly five full matches.

## Contracts

```bash
cd contracts
forge test                 # 42 tests: unit, fuzz, invariant
bash preflight.sh          # check deployer balance and RPC
bash deploy.sh             # deploy and write deployments/<chainId>.json
bash verify-deploy.sh      # assert bytecode exists and read live state
node gen-abis.mjs          # regenerate ABIs for server and client
```

### Money flow

| Event | Split |
| --- | --- |
| Join | $1.00 → $0.80 head bounty + $0.20 to the match jackpot |
| PvP kill | 80% of the victim's bounty to the killer's wallet, 20% to the jackpot |
| Self-kill | 100% of the victim's bounty to the jackpot |
| Red-zone death | 100% of the victim's bounty to the jackpot |
| Match end | jackpot + all remaining bounty to the winner |

The solvency invariant, enforced by tests and re-checked against the live
contract by the smoke test:

```
usdc.balanceOf(arena) == Σ bounty + Σ jackpot + treasuryUnclaimed
```

## Verification

```bash
npm --prefix server run smoke     # plays a full match and asserts the on-chain result
npm --prefix server run status    # balances, gas price, live solvency check
```

The smoke test funds a throwaway wallet, joins, plays, and then checks that the
match finalized, the jackpot was paid out, no bounty was stranded, the committed
Merkle root matches the published log, and the solvency invariant still holds.

A passing run on Monad testnet, with 1 human and 15 bots:

```
[PASS] every seat was paid for on chain — 16 USDC deposited across 16 seats
[PASS] winner was paid — 14.08 USDC
[PASS] jackpot fully paid out — 0 USDC left
[PASS] no bounty stranded in the match — 0 USDC left
[PASS] audit log root committed on chain
[PASS] PRD 4.1 solvency invariant holds on chain
```

That $14.08 is the §4.1 arithmetic reproduced on chain: 12 self-kills sent
12 × $0.80 to the jackpot, 3 PvP kills paid 3 × $0.64 straight to killers and
3 × $0.16 to the jackpot, joins seeded 16 × $0.20, and the winner's own $0.80 came
back at finalization — $13.28 jackpot + $0.80 = $14.08.

## Notes on building for Monad

Three Monad behaviours shaped this code, and each one caused a real failure first:

**Gas is charged on the limit, not on usage.** `gas_paid = gas_limit * price`. An
over-generous limit is money out of the signer's balance, and `receipt.gasUsed`
comes back equal to the limit, so receipts cannot be used to tune limits. Both the
relayer and the browser therefore estimate against the live chain and cap the
result (`server/src/chain/gasOracle.js`). Measured limits for a settled match:

| Function | Limit in use |
| --- | --- |
| `depositEntryFee` (player) | ~285,000 |
| `depositEntryFeeFor` | 297,007 |
| `processKillReward` | 183,705 |
| `processEnvironmentOrSelfDeath` | 90,912 |
| `processKillBatch` (2 deaths) | 214,591 |
| `processKillBatch` (8 deaths) | 439,533 |
| `finalizeMatch` | 544,852 |

A no-beneficiary death costs half what a PvP kill does, because only the PvP path
performs an ERC-20 transfer. Batching is markedly cheaper per death: eight deaths
in one transaction cost 439,533 gas, against roughly 1.5M if settled individually.

**Execution is asynchronous.** Consensus validates block `n` against state from
block `n-k` (`k=3`), so a wallet funded a moment ago still looks empty to the
consensus-time balance check and its first transaction is rejected with
"Signer had insufficient balance" — even though the funding transfer has a
successful receipt. Code that funds an account waits several blocks before using
it (`waitForBlocks` in `server/src/chain/clients.js`).

**Settlement receipts cannot be sub-second.** Because execution trails consensus
by up to `k` blocks, a receipt lags inclusion by ~1.2s by design. Observed
settlement latency was 1.3s at best. The game therefore shows kills immediately
from the authoritative simulation and reconciles the on-chain confirmation when it
arrives, rather than blocking gameplay on a receipt.

## Architecture

```
Phaser client ──WebSocket── Node server ──sharded relayer keys── GridZoneArena
      │                          │
 approve + depositEntryFee   processKillReward / processEnvironmentOrSelfDeath
 (one time, before the       processKillBatch / finalizeMatch
  match; zero signatures
  once it starts)
```

Two decisions are load-bearing:

**Per-match storage.** Everything a kill transaction writes lives under
`matches[matchId]`. A single global `jackpotPool` would put every kill in every
match on the same storage slot, so Monad's optimistic parallel execution would
detect a conflict and re-run them serially — proving the opposite of the claim.

**One relayer key per match.** An EOA's nonces are strictly sequential, so a
single relayer could never have two settlements in flight regardless of chain
throughput. Keys are sharded per match so different matches genuinely proceed in
parallel; within one match, deaths from the same tick are batched instead.

### Trust model

The relayer is a trusted oracle: nothing on chain proves a kill happened. The
mitigation in scope is auditability, not trustlessness. Every match records an
append-only log, including the map seed, and `finalizeMatch` commits its Merkle
root. The full log is served at `GET /api/match/:matchId/log`, so a third party can
replay the match and check the committed root. Disputes are out of scope, but the
data to settle one exists.

Funds cannot be locked up by a crashed server: after `MATCH_TIMEOUT` (1 hour) any
player can call `emergencyWithdraw` for their own bounty, and the owner can move an
abandoned jackpot to the treasury.

## Known gaps

- Deviates from PRD §5.2's `bounty[victim] → bounty[killer]` sketch: the killer's
  80% is transferred straight out to their wallet. The §4.1 figures ($9.60
  distributed, $5.60 final jackpot, $0.80 winner remainder) only hold this way,
  and it is what makes a wallet balance visibly move per kill.
- `finalizeMatch` sweeps every remaining bounty rather than only the winner's.
  Finalizing also closes `emergencyWithdraw`, so anything left behind would be
  unrecoverable by anyone.
- A match can end with no survivors, since one blast can kill its owner and the
  last opponent together. The contract pays exactly one address, so rather than
  leaving the whole pot locked until the timeout, the win goes to the
  highest-scoring player eliminated in the final tick. The rule is recorded in the
  match log as `last_stand_tiebreak`.
- Contracts are deployed but not verified on the explorer; `forge verify-contract`
  needs an explorer API key.
- The in-match visuals have not been checked in a browser by an automated test.
  The simulation, settlement and on-chain outcome are covered by the smoke test.
- Two early matches were abandoned while debugging relayer funding, so the vault
  holds a small residue that is still fully accounted for by the solvency
  invariant. It is recoverable through `emergencyWithdraw` and
  `reclaimAbandonedJackpot` once their timeouts elapse.
- Entry fees plus a rake plus real payouts may be regulated in some
  jurisdictions. This is testnet play money; do not ship it to mainnet without
  advice.
