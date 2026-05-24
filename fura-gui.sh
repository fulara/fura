#!/usr/bin/env bash
set -euo pipefail

# Open the Fura native desktop window. Connects to an already-running fura
# server; does not start one. Required configuration is loaded from .env next to
# this script, or from FURA_ENV_FILE.

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./fura-env.sh
source "${SCRIPT_DIR}/fura-env.sh"
load_fura_env "${SCRIPT_DIR}"

require_env FURA_TOKEN FURA_HOST FURA_PORT
require_directory FURA_DIR

cd "${FURA_DIR}"

if [[ "${FURA_SKIP_BUILD:-0}" != "1" ]]; then
  cargo build --release --bin gui
fi

exec cargo run --release --bin gui -- \
  --host "${FURA_HOST}" \
  --port "${FURA_PORT}" \
  --token "${FURA_TOKEN}" \
  "$@"
