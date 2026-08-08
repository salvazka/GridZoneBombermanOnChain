#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d node_modules/socket.io-client ]; then
  echo "socket.io-client missing, installing…"
  npm install --no-audit --no-fund socket.io-client@4.8.1 --save-dev
fi

node --input-type=module -e '
import { io } from "socket.io-client";
console.log("socket.io-client resolved:", typeof io);
'
