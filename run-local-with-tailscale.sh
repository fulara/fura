#!/usr/bin/env bash
set -euo pipefail

# Run Fura against the local Oh My Pi checkout with two listeners:
# - local HTTP for laptop development:  http://127.0.0.1:3737/
# - remote HTTPS for phone development: https://<remote-host>:4450/mobile.html
#
# Defaults are explicit and split by purpose:
# - local listener stays on 127.0.0.1:3737
# - remote listener binds to `tailscale ip -4`:4450
# - remote host defaults to the user's configured Tailscale DNS name
# - TLS cert/key default to ./.cert/<remote-host>.crt and .key
#
# Environment overrides:
#   OMP_REPO=/path/to/oh-my-pi
#   BUN_BIN=/path/to/bun
#   FURA_TOKEN=dev
#   FURA_LOCAL_BIND=127.0.0.1:3737
#   FURA_REMOTE_PORT=4450
#   FURA_REMOTE_HOST=serwer-mini.caracal-porgy.ts.net
#   FURA_TLS_CERT=./.cert/<remote-host>.crt
#   FURA_TLS_KEY=./.cert/<remote-host>.key
#   FURA_SKIP_FRONTEND_BUILD=1
#
# Any arguments passed to this script are forwarded to Fura after the local OMP
# RPC wiring and dual-listener arguments.

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
OMP_REPO=${OMP_REPO:-/home/aleksander/repos/oh-my-pi}
BUN_BIN=${BUN_BIN:-${HOME}/.bun/bin/bun}
FURA_TOKEN=${FURA_TOKEN:-dev}
FURA_LOCAL_BIND=${FURA_LOCAL_BIND:-127.0.0.1:3737}
FURA_REMOTE_PORT=${FURA_REMOTE_PORT:-4450}
FURA_REMOTE_HOST=${FURA_REMOTE_HOST:-serwer-mini.caracal-porgy.ts.net}
FURA_TLS_CERT=${FURA_TLS_CERT:-${SCRIPT_DIR}/.cert/${FURA_REMOTE_HOST}.crt}
FURA_TLS_KEY=${FURA_TLS_KEY:-${SCRIPT_DIR}/.cert/${FURA_REMOTE_HOST}.key}
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
REMOTE_BIND="${TAILSCALE_IP}:${FURA_REMOTE_PORT}"

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

if [[ ! -r "${FURA_TLS_CERT}" ]]; then
  echo "TLS cert not readable at: ${FURA_TLS_CERT}" >&2
  echo "Generate it first, e.g.: sudo tailscale cert ${FURA_REMOTE_HOST}" >&2
  exit 1
fi

if [[ ! -r "${FURA_TLS_KEY}" ]]; then
  echo "TLS key not readable at: ${FURA_TLS_KEY}" >&2
  echo "If it was created with sudo, fix ownership/permissions or reissue it for the current user." >&2
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

resolved_remote_ip=""
if command -v python >/dev/null 2>&1; then
  resolved_remote_ip=$(python - "${FURA_REMOTE_HOST}" <<'PY' || true
import socket
import sys
try:
    print(socket.gethostbyname(sys.argv[1]))
except Exception:
    pass
PY
)
fi

if [[ -n "${resolved_remote_ip}" && "${resolved_remote_ip}" != "${TAILSCALE_IP}" ]]; then
  echo "Warning: FURA_REMOTE_HOST=${FURA_REMOTE_HOST} resolves to ${resolved_remote_ip}, but this machine's Tailscale IP is ${TAILSCALE_IP}." >&2
  echo "HTTPS clients must open the exact remote host from the certificate, and that host should route back to this machine." >&2
fi

export FURA_TOKEN
export FURA_BRIDGE_DEBUG_FILE
export PATH="$(dirname -- "${BUN_BIN}"):${PATH}"

cd "${SCRIPT_DIR}"

if [[ "${FURA_SKIP_FRONTEND_BUILD:-0}" != "1" ]]; then
  npm --prefix frontend run build
fi

cat >&2 <<EOF
Starting Fura for local + Tailscale development:
  Local URL:        http://${FURA_LOCAL_BIND}/
  Remote bind:      ${REMOTE_BIND}
  Remote URL:       https://${FURA_REMOTE_HOST}:${FURA_REMOTE_PORT}/mobile.html
  Remote Origin:    https://${FURA_REMOTE_HOST}:${FURA_REMOTE_PORT}
  TLS cert:         ${FURA_TLS_CERT}
  TLS key:          ${FURA_TLS_KEY}
  Auth token:       enter FURA_TOKEN in the browser auth screen (default: dev)
EOF

exec cargo run --bin fura -- \
  --bind "${FURA_LOCAL_BIND}" \
  --remote-bind "${REMOTE_BIND}" \
  --remote-host "${FURA_REMOTE_HOST}" \
  --tls-cert "${FURA_TLS_CERT}" \
  --tls-key "${FURA_TLS_KEY}" \
  --static-dir "${SCRIPT_DIR}/frontend/dist" \
  --bridge-debug-file "${FURA_BRIDGE_DEBUG_FILE}" \
  --rpc-program "${BUN_BIN}" \
  --no-default-rpc-args \
  --rpc-arg "${OMP_REPO}/packages/coding-agent/src/cli.ts" \
  "--rpc-arg=--mode" \
  --rpc-arg "rpc" \
  "$@"
