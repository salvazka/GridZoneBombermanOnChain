#!/usr/bin/env bash
# Checks the deployer is funded and the RPC is reachable before broadcasting.
set -euo pipefail
cd "$(dirname "$0")"

# Foundry lives in the user's home, which non-login shells don't pick up.
export PATH="${PATH}:${HOME}/.foundry/bin"

set -a
# shellcheck disable=SC1091
source .env
set +a

RPC="${MONAD_TESTNET_RPC}"
ADDR="$(cast wallet address --private-key "${PRIVATE_KEY}")"

echo "deployer : ${ADDR}"
echo "rpc      : ${RPC}"
echo "chain id : $(cast chain-id --rpc-url "${RPC}")"

WEI="$(cast balance "${ADDR}" --rpc-url "${RPC}")"
echo "balance  : $(cast from-wei "${WEI}") MON"

if [ "${WEI}" = "0" ]; then
  echo "ERROR: deployer has no MON. Fund it at https://testnet.monad.xyz" >&2
  exit 1
fi
