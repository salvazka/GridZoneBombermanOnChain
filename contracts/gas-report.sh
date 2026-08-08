#!/usr/bin/env bash
# Per-function gas for the arena. Monad charges on the gas LIMIT, so the relayer
# needs real numbers to set tight explicit limits instead of over-reserving.
set -euo pipefail
cd "$(dirname "$0")"

export PATH="${PATH}:${HOME}/.foundry/bin"

forge test --gas-report --match-contract GridZoneArenaTest --no-match-test "testFuzz" 2>/dev/null \
  | grep -E "GridZoneArena|processKill|processEnvironment|finalizeMatch|depositEntryFee|openMatch|emergencyWithdraw" \
  | grep -v "^Ran" || true
