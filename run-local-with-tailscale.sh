#!/usr/bin/env bash
set -euo pipefail

# Run Fura against the local Oh My Pi checkout with two listeners:
# - local HTTP for laptop development:  http://<FURA_LOCAL_BIND>/
# - remote HTTPS for phone development: https://<FURA_REMOTE_HOST>:<FURA_REMOTE_PORT>/mobile.html
#
# Required configuration is loaded from .env next to this script, or from
# FURA_ENV_FILE. Missing required values fail closed before anything starts.
# Extra arguments are forwarded to Fura after the local OMP RPC wiring and
# dual-listener arguments.

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./fura-env.sh
source "${SCRIPT_DIR}/fura-env.sh"
load_fura_env "${SCRIPT_DIR}"

require_env \
  OMP_REPO \
  BUN_BIN \
  FURA_TOKEN \
  FURA_LOCAL_BIND \
  FURA_REMOTE_PORT \
  FURA_REMOTE_HOST \
  FURA_TLS_CERT \
  FURA_TLS_KEY \
  FURA_BRIDGE_DEBUG_FILE \
  FURA_EVENT_DEBUG_FILE
require_executable BUN_BIN
require_directory OMP_REPO
require_directory FURA_DIR
require_readable FURA_TLS_CERT
require_readable FURA_TLS_KEY

if [[ ! -d "${OMP_REPO}/packages/coding-agent" ]]; then
  echo "OMP checkout is missing packages/coding-agent: ${OMP_REPO}" >&2
  exit 1
fi

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

if ! (cd "${OMP_REPO}/packages/coding-agent" && PATH="$(dirname -- "${BUN_BIN}"):${PATH}" "${BUN_BIN}" src/cli.ts --version >/dev/null); then
  echo "OMP CLI/native preflight failed. Rebuild the native addon for this checkout." >&2
  echo "Run: env RUSTUP_TOOLCHAIN=nightly-2026-04-29 bun run build:native" >&2
  echo "from: ${OMP_REPO}" >&2
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
export FURA_EVENT_DEBUG_FILE
export PATH="$(dirname -- "${BUN_BIN}"):${PATH}"

textile_redmine_args=()
if [[ -n "${FURA_TEXTILE_REDMINE_ROOT_URL:-}" ]]; then
  textile_redmine_args=(--textile-redmine-root-url "${FURA_TEXTILE_REDMINE_ROOT_URL}")
fi

cd "${FURA_DIR}"

if [[ "${FURA_SKIP_FRONTEND_BUILD:-0}" != "1" ]]; then
  if command -v npm >/dev/null 2>&1; then
    npm --prefix frontend run build
  else
    "${BUN_BIN}" run --cwd frontend build
  fi
fi

cat >&2 <<EOF
Starting Fura for local + Tailscale development:
  Local URL:        http://${FURA_LOCAL_BIND}/
  Remote bind:      ${REMOTE_BIND}
  Remote URL:       https://${FURA_REMOTE_HOST}:${FURA_REMOTE_PORT}/mobile.html
  Remote Origin:    https://${FURA_REMOTE_HOST}:${FURA_REMOTE_PORT}
  TLS cert:         ${FURA_TLS_CERT}
  TLS policy:       startup refuses expired certs or certs with less than 5 days left
  TLS key:          ${FURA_TLS_KEY}
  Auth token:       FURA_TOKEN from env file
  Event debug log:   ${FURA_EVENT_DEBUG_FILE}
EOF

exec cargo run --bin fura -- \
  --bind "${FURA_LOCAL_BIND}" \
  --remote-bind "${REMOTE_BIND}" \
  --remote-host "${FURA_REMOTE_HOST}" \
  --tls-cert "${FURA_TLS_CERT}" \
  --tls-key "${FURA_TLS_KEY}" \
  --static-dir "${FURA_DIR}/frontend/dist" \
  --bridge-debug-file "${FURA_BRIDGE_DEBUG_FILE}" \
  --event-debug-file "${FURA_EVENT_DEBUG_FILE}" \
  "${textile_redmine_args[@]}" \
  --rpc-program "${BUN_BIN}" \
  --no-default-rpc-args \
  --rpc-arg "${OMP_REPO}/packages/coding-agent/src/cli.ts" \
  "--rpc-arg=--mode" \
  --rpc-arg "rpc-ui" \
  "$@"
