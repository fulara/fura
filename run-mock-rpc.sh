#!/usr/bin/env bash
set -euo pipefail

# Run Fura against the checked-in mock OMP RPC fixture. Required configuration is
# loaded from .env next to this script, or from FURA_ENV_FILE.
# Extra arguments are forwarded to Fura after the mock RPC wiring.

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./fura-env.sh
source "${SCRIPT_DIR}/fura-env.sh"
load_fura_env "${SCRIPT_DIR}"

require_env FURA_TOKEN FURA_PORT
require_directory FURA_DIR
export FURA_TOKEN

cd "${FURA_DIR}"

if [[ "${FURA_SKIP_FRONTEND_BUILD:-0}" != "1" ]]; then
  npm --prefix frontend run build
fi

exec cargo run --bin fura -- \
  --bind "127.0.0.1:${FURA_PORT}" \
  --static-dir "${FURA_DIR}/frontend/dist" \
  --rpc-program node \
  --no-default-rpc-args \
  --rpc-arg "${FURA_DIR}/fixtures/mock-omp-rpc.mjs" \
  "$@"
