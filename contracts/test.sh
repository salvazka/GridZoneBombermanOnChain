#!/usr/bin/env bash
# Full contract test suite: unit, fuzz and invariant.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="${PATH}:${HOME}/.foundry/bin"

forge test --summary 2>&1 | grep -Ev "^\s*$" | tail -30
