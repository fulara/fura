#!/usr/bin/env bash
set -euo pipefail

# Run Fura against the local Oh My Pi checkout, bound to this machine's
# Tailscale IPv4 address so a phone in the same tailnet can connect.
#
# Defaults are intentionally explicit and safe:
# - bind to `tailscale ip -4`, not 0.0.0.0
# - use port 4450 for the phone workflow
# - add --mobile-host as an allowed browser Origin helper
#
# Environment overrides:
#   OMP_REPO=/path/to/oh-my-pi
#   BUN_BIN=/path/to/bun
#   FURA_TOKEN=dev
#   FURA_PORT=4450
#   FURA_MOBILE_HOST=fura-mini-laptop
#   FURA_BRIDGE_DEBUG_FILE=/path/to/bridge-debug.jsonl
#   FURA_SKIP_FRONTEND_BUILD=1
#
# Any arguments passed to this script are forwarded to Fura after the local OMP
# RPC wiring and Tailscale bind arguments.

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
OMP_REPO=${OMP_REPO:-/home/aleksander/repos/oh-my-pi}
BUN_BIN=${BUN_BIN:-${HOME}/.bun/bin/bun}
FURA_TOKEN=${FURA_TOKEN:-dev}
FURA_PORT=${FURA_PORT:-4450}
FURA_MOBILE_HOST=${FURA_MOBILE_HOST:-fura-mini-laptop}
FURA_BRIDGE_DEBUG_FILE=${FURA_BRIDGE_DEBUG_FILE:-${SCRIPT_DIR}/bridge-debug.jsonl}

if ! command -v tailscale >/dev/null 2>&1; then
  echo "tailscale command not found. Install and log in to Tailscale first." >&2
  exit 1
fi

TAILSCALE_IP=$(tailscale ip -4 | awk 'NF { print; exit }')
if [[ -z "${TAILSCALE_IP}" ]]; then
  echo "No Tailscale IPv4 address found. Is Tailscale running and connected?" >&2
  exit 1
fi

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

resolved_mobile_ip=""
if command -v python >/dev/null 2>&1; then
  resolved_mobile_ip=$(python - "${FURA_MOBILE_HOST}" <<'PY' || true
import socket
import sys
try:
    print(socket.gethostbyname(sys.argv[1]))
except Exception:
    pass
PY
)
fi

if [[ -n "${resolved_mobile_ip}" && "${resolved_mobile_ip}" != "${TAILSCALE_IP}" ]]; then
  echo "Warning: FURA_MOBILE_HOST=${FURA_MOBILE_HOST} resolves to ${resolved_mobile_ip}, but this machine's Tailscale IP is ${TAILSCALE_IP}." >&2
  echo "If ${FURA_MOBILE_HOST} is not a Tailscale service forwarding to this machine, use FURA_MOBILE_HOST=$(tailscale status --json | python -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || echo "${TAILSCALE_IP}")." >&2
fi

export FURA_TOKEN
export FURA_BRIDGE_DEBUG_FILE
export PATH="$(dirname -- "${BUN_BIN}"):${PATH}"

cd "${SCRIPT_DIR}"

if [[ "${FURA_SKIP_FRONTEND_BUILD:-0}" != "1" ]]; then
  npm --prefix frontend run build
fi

cat >&2 <<EOF
Starting Fura for Tailscale mobile access:
  Bind address: ${TAILSCALE_IP}:${FURA_PORT}
  Mobile URL:   http://${FURA_MOBILE_HOST}:${FURA_PORT}/mobile.html
  Auth token:   enter FURA_TOKEN in the browser auth screen (default: dev)
EOF

exec cargo run --bin fura -- \
  --host "${TAILSCALE_IP}" \
  --port "${FURA_PORT}" \
  --mobile-host "${FURA_MOBILE_HOST}" \
  --static-dir "${SCRIPT_DIR}/frontend/dist" \
  --bridge-debug-file "${FURA_BRIDGE_DEBUG_FILE}" \
  --rpc-program "${BUN_BIN}" \
  --no-default-rpc-args \
  --rpc-arg "${OMP_REPO}/packages/coding-agent/src/cli.ts" \
  "--rpc-arg=--mode" \
  --rpc-arg "rpc" \
  "$@"
