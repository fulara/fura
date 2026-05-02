#!/usr/bin/env bash
set -euo pipefail

# Open the Fura native desktop window.
# Connects to an already-running fura server; does not start one. The token is
# a bootstrap token used by the frontend to create an HttpOnly browser auth session.
#
# Environment overrides:
#   FURA_TOKEN=dev          bootstrap token for the browser auth session
#   FURA_HOST=127.0.0.1
#   FURA_PORT=3737
#   FURA_SKIP_BUILD=1       skip cargo rebuild

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
HOST=${FURA_HOST:-127.0.0.1}
PORT=${FURA_PORT:-3737}

if [[ -z "${FURA_TOKEN:-}" ]]; then
  echo "FURA_TOKEN is not set. Set it to match the token your fura server was started with." >&2
  exit 1
fi

cd "${SCRIPT_DIR}"

if [[ "${FURA_SKIP_BUILD:-0}" != "1" ]]; then
  cargo build --release --bin gui
fi

exec cargo run --release --bin gui -- \
  --host "${HOST}" \
  --port "${PORT}" \
  --token "${FURA_TOKEN}" \
  "$@"
