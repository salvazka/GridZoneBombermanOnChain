#!/usr/bin/env bash
# Confirms the deployed contracts actually exist on chain and are wired up.
set -euo pipefail
cd "$(dirname "$0")"

export PATH="${PATH}:${HOME}/.foundry/bin"

set -a
# shellcheck disable=SC1091
source .env
set +a

RPC="${MONAD_TESTNET_RPC}"
# node rather than jq: node is already a project dependency, jq may not be installed.
read_addr() { node -e "process.stdout.write(require('./deployments/10143.json').$1)"; }
ARENA="$(read_addr arena)"
USDC="$(read_addr mockUsdc)"
DEPLOYER="$(read_addr deployer)"

echo "arena : ${ARENA}"
echo "usdc  : ${USDC}"

for pair in "arena:${ARENA}" "usdc:${USDC}"; do
  name="${pair%%:*}"; addr="${pair#*:}"
  code="$(cast code "${addr}" --rpc-url "${RPC}")"
  if [ "${code}" = "0x" ] || [ -z "${code}" ]; then
    echo "FAIL: ${name} at ${addr} has no bytecode" >&2
    exit 1
  fi
  echo "ok    : ${name} has ${#code} bytes of bytecode hex"
done

echo
echo "-- arena wiring --"
echo "usdc()            : $(cast call "${ARENA}" 'usdc()(address)' --rpc-url "${RPC}")"
echo "owner()           : $(cast call "${ARENA}" 'owner()(address)' --rpc-url "${RPC}")"
echo "ENTRY_FEE()       : $(cast call "${ARENA}" 'ENTRY_FEE()(uint256)' --rpc-url "${RPC}")"
echo "MAX_PLAYERS()     : $(cast call "${ARENA}" 'MAX_PLAYERS()(uint256)' --rpc-url "${RPC}")"
echo "houseFeeBps()     : $(cast call "${ARENA}" 'houseFeeBps()(uint256)' --rpc-url "${RPC}")"
echo "matchCount()      : $(cast call "${ARENA}" 'matchCount()(uint256)' --rpc-url "${RPC}")"
echo "totalLiabilities(): $(cast call "${ARENA}" 'totalLiabilities()(uint256)' --rpc-url "${RPC}")"

echo
echo "-- token --"
echo "symbol()          : $(cast call "${USDC}" 'symbol()(string)' --rpc-url "${RPC}")"
echo "decimals()        : $(cast call "${USDC}" 'decimals()(uint8)' --rpc-url "${RPC}")"
echo "deployer balance  : $(cast call "${USDC}" 'balanceOf(address)(uint256)' "${DEPLOYER}" --rpc-url "${RPC}")"
