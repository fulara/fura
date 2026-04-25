#!/usr/bin/env bash
set -euo pipefail

# Start the Fura bridge server.
# The server is browser/client agnostic — connect with a browser or fura-gui.
#
# Environment overrides:
#   FURA_TOKEN=dev          (default: random UUID logged on startup)
#   FURA_PORT=3737
#   FURA_SKIP_BUILD=1       skip frontend + cargo rebuild
#
# Extra arguments are forwarded to the fura binary, e.g.:
#   ./fura.sh --log-frames
#   ./fura.sh --rpc-program node --no-default-rpc-args --rpc-arg fixtures/mock-omp-rpc.mjs

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PORT=${FURA_PORT:-3737}

cd "${SCRIPT_DIR}"

if [[ "${FURA_SKIP_BUILD:-0}" != "1" ]]; then
  npm --prefix frontend run build
  cargo build --release
fi

exec cargo run --release -- \
  --static-dir "${SCRIPT_DIR}/frontend/dist" \
  --port "${PORT}" \
  "$@"
