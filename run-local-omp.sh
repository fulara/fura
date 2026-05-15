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

required_bun=$("${BUN_BIN}" -e 'const pkg = await Bun.file(Bun.argv[1]).json(); const raw = String(pkg.packageManager ?? pkg.engines?.bun ?? ""); const match = raw.match(/[0-9]+(?:\.[0-9]+){1,2}/); if (match) process.stdout.write(match[0]);' "${OMP_REPO}/package.json")
current_bun=$("${BUN_BIN}" --version)
if [[ -n "${required_bun}" ]]; then
  if ! "${BUN_BIN}" -e 'process.exit(Bun.semver.order(Bun.argv[1], Bun.argv[2]) < 0 ? 1 : 0);' "${current_bun}" "${required_bun}"; then
    echo "Bun at ${BUN_BIN} is too old for this OMP checkout." >&2
    echo "Found Bun ${current_bun}; OMP requires Bun >= ${required_bun}." >&2
    echo "Run: ${BUN_BIN} upgrade" >&2
    exit 1
  fi
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
