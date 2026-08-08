#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
cd /mnt/d/Project/Monad/contracts
forge test
