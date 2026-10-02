#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node demo/server.js &
demo_server_pid=$!
trap 'kill "$demo_server_pid" 2>/dev/null || true; wait "$demo_server_pid" 2>/dev/null || true' EXIT
sleep 0.3
vhs demo/demo.tape
