#!/usr/bin/env bash
set -euo pipefail

# Start the Fura bridge server. The server is browser/client agnostic — connect
# with a browser or fura-gui. Required configuration is loaded from .env next to
# this script, or from FURA_ENV_FILE. Extra arguments are forwarded to Fura.

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./fura-env.sh
source "${SCRIPT_DIR}/fura-env.sh"
load_fura_env "${SCRIPT_DIR}"

require_env FURA_TOKEN FURA_PORT
require_directory FURA_DIR
export FURA_TOKEN

cd "${FURA_DIR}"

if [[ "${FURA_SKIP_BUILD:-0}" != "1" ]]; then
  npm --prefix frontend run build
  cargo build --release
fi

exec cargo run --release -- \
  --static-dir "${FURA_DIR}/frontend/dist" \
  --port "${FURA_PORT}" \
  "$@"
