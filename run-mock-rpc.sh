#!/usr/bin/env bash
set -euo pipefail

# Run Fura against the checked-in mock OMP RPC fixture. This is the fastest
# end-to-end smoke target because it does not require an installed OMP binary
# or a local OMP checkout.
#
# Environment overrides:
#   FURA_TOKEN=dev
#   FURA_PORT=38737
#   FURA_SKIP_FRONTEND_BUILD=1
#
# Extra arguments are forwarded to Fura after the mock RPC wiring, e.g.:
#   ./run-mock-rpc.sh --bind 127.0.0.1:38888 --log-frames

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PORT=${FURA_PORT:-38737}
export FURA_TOKEN=${FURA_TOKEN:-dev}

cd "${SCRIPT_DIR}"

if [[ "${FURA_SKIP_FRONTEND_BUILD:-0}" != "1" ]]; then
  npm --prefix frontend run build
fi

exec cargo run --bin fura -- \
  --bind "127.0.0.1:${PORT}" \
  --static-dir "${SCRIPT_DIR}/frontend/dist" \
  --rpc-program node \
  --no-default-rpc-args \
  --rpc-arg "${SCRIPT_DIR}/fixtures/mock-omp-rpc.mjs" \
  "$@"
