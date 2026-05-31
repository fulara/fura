#!/usr/bin/env bash
set -euo pipefail

# Run Fura against the local Oh My Pi checkout instead of the preinstalled `omp`.
# Required configuration is loaded from .env next to this script, or from
# FURA_ENV_FILE. Missing required values fail closed before anything starts.
# Extra arguments are forwarded to Fura after the local OMP RPC wiring.

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./fura-env.sh
source "${SCRIPT_DIR}/fura-env.sh"
load_fura_env "${SCRIPT_DIR}"

require_env \
  OMP_REPO \
  BUN_BIN \
  FURA_TOKEN \
  FURA_LOCAL_BIND \
  FURA_BRIDGE_DEBUG_FILE \
  FURA_EVENT_DEBUG_FILE
require_executable BUN_BIN
require_directory OMP_REPO
require_directory FURA_DIR

if [[ ! -d "${OMP_REPO}/packages/coding-agent" ]]; then
  echo "OMP checkout is missing packages/coding-agent: ${OMP_REPO}" >&2
  exit 1
fi

native_platform=$("${BUN_BIN}" -e 'process.stdout.write(`${process.platform}-${process.arch}`);')
shopt -s nullglob
native_addons=("${OMP_REPO}"/packages/natives/native/pi_natives."${native_platform}"*.node)
shopt -u nullglob
if (( ${#native_addons[@]} == 0 )); then
  echo "OMP native addon is not built for ${native_platform}." >&2
  echo "Run: PATH=\"$(dirname -- "${BUN_BIN}"):\$PATH\" bun run build" >&2
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
export FURA_EVENT_DEBUG_FILE
export PATH="$(dirname -- "${BUN_BIN}"):${PATH}"

cd "${FURA_DIR}"

if [[ "${FURA_SKIP_FRONTEND_BUILD:-0}" != "1" ]]; then
  if command -v npm >/dev/null 2>&1; then
    npm --prefix frontend run build
  else
    "${BUN_BIN}" run --cwd frontend build
  fi
fi

exec cargo run --bin fura -- \
  --bind "${FURA_LOCAL_BIND}" \
  --static-dir "${FURA_DIR}/frontend/dist" \
  --bridge-debug-file "${FURA_BRIDGE_DEBUG_FILE}" \
  --event-debug-file "${FURA_EVENT_DEBUG_FILE}" \
  --rpc-program "${BUN_BIN}" \
  --no-default-rpc-args \
  --rpc-arg "${OMP_REPO}/packages/coding-agent/src/cli.ts" \
  "--rpc-arg=--mode" \
  --rpc-arg "rpc-ui" \
  "$@"
