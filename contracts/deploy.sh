#!/usr/bin/env bash
# Deploys MockUSDC + GridZoneArena to Monad testnet.
set -euo pipefail
cd "$(dirname "$0")"

export PATH="${PATH}:${HOME}/.foundry/bin"

set -a
# shellcheck disable=SC1091
source .env
set +a

mkdir -p deployments

forge script script/DeployGridZone.s.sol:DeployGridZone \
  --rpc-url "${MONAD_TESTNET_RPC}" \
  --broadcast \
  --slow \
  -vvv
