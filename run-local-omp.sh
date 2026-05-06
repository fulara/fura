#!/usr/bin/env bash
set -euo pipefail

# Run Fura against the local Oh My Pi checkout instead of the preinstalled `omp`.
#
# Environment overrides:
#   OMP_REPO=/path/to/oh-my-pi
#   BUN_BIN=/path/to/bun
#   FURA_TOKEN=dev
#   FURA_BRIDGE_DEBUG_FILE=/path/to/bridge-debug.jsonl
#   FURA_SKIP_FRONTEND_BUILD=1
#
# Any arguments passed to this script are forwarded to Fura after the local OMP
# RPC wiring arguments, e.g.:
#   ./run-local-omp.sh --bind 127.0.0.1:3738 --log-frames

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
OMP_REPO=${OMP_REPO:-/home/aleksander/repos/oh-my-pi}
BUN_BIN=${BUN_BIN:-${HOME}/.bun/bin/bun}
FURA_TOKEN=${FURA_TOKEN:-dev}
FURA_BRIDGE_DEBUG_FILE=${FURA_BRIDGE_DEBUG_FILE:-${SCRIPT_DIR}/bridge-debug.jsonl}

if [[ ! -x "${BUN_BIN}" ]]; then
  echo "Bun not found or not executable at: ${BUN_BIN}" >&2
  echo "Set BUN_BIN=/path/to/bun or install Bun." >&2
  exit 1
fi

if [[ ! -d "${OMP_REPO}/packages/coding-agent" ]]; then
  echo "OMP checkout not found at: ${OMP_REPO}" >&2
  echo "Set OMP_REPO=/path/to/oh-my-pi." >&2
  exit 1
fi

shopt -s nullglob
native_addons=("${OMP_REPO}"/packages/natives/native/pi_natives.linux-x64*.node)
shopt -u nullglob
if (( ${#native_addons[@]} == 0 )); then
  echo "OMP native addon is not built." >&2
  echo "Run: PATH=\"${HOME}/.bun/bin:\$PATH\" bun run build" >&2
  echo "from: ${OMP_REPO}/packages/natives" >&2
  exit 1
fi

export FURA_TOKEN
export FURA_BRIDGE_DEBUG_FILE
export PATH="$(dirname -- "${BUN_BIN}"):${PATH}"

cd "${SCRIPT_DIR}"

if [[ "${FURA_SKIP_FRONTEND_BUILD:-0}" != "1" ]]; then
  npm --prefix frontend run build
fi

exec cargo run --bin fura -- \
  --static-dir "${SCRIPT_DIR}/frontend/dist" \
  --bridge-debug-file "${FURA_BRIDGE_DEBUG_FILE}" \
  --rpc-program "${BUN_BIN}" \
  --no-default-rpc-args \
  --rpc-arg "${OMP_REPO}/packages/coding-agent/src/cli.ts" \
  "--rpc-arg=--mode" \
  --rpc-arg "rpc" \
  "--rpc-arg=--no-lsp" \
  "$@"
