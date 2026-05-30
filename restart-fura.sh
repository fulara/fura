#!/usr/bin/env bash
set -euo pipefail

# Restart a Fura launcher in the background and detach from the terminal.
#
# Defaults:
#   launcher: ./run-local-omp.sh
#   pid file: ./.fura-restart.pid
#   log file: ./.fura-restart.log
#
# Usage:
#   ./restart-fura.sh
#   ./restart-fura.sh run-local-with-tailscale.sh
#   ./restart-fura.sh --dry-run run-mock-rpc.sh -- --bind 127.0.0.1:38888
#
# Environment overrides:
#   FURA_RESTART_LAUNCHER=/path/to/launcher.sh
#   FURA_RESTART_PID_FILE=/path/to/.fura-restart.pid
#   FURA_RESTART_LOG_FILE=/path/to/.fura-restart.log

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
DEFAULT_LAUNCHER="${SCRIPT_DIR}/run-local-omp.sh"
PID_FILE=${FURA_RESTART_PID_FILE:-${SCRIPT_DIR}/.fura-restart.pid}
LOG_FILE=${FURA_RESTART_LOG_FILE:-${SCRIPT_DIR}/.fura-restart.log}
DRY_RUN=0
LAUNCHER=${FURA_RESTART_LAUNCHER:-}
FORWARD_ARGS=()
FORWARD_ARG_COUNT=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --)
      shift
      FORWARD_ARGS=("$@")
      FORWARD_ARG_COUNT=$#
      break
      ;;
    *)
      if [[ -z "${LAUNCHER}" ]]; then
        LAUNCHER=$1
      else
        FORWARD_ARGS+=("$1")
        FORWARD_ARG_COUNT=$((FORWARD_ARG_COUNT + 1))
      fi
      shift
      ;;
  esac
done

if [[ -z "${LAUNCHER}" ]]; then
  LAUNCHER=${DEFAULT_LAUNCHER}
elif [[ "${LAUNCHER}" != /* ]]; then
  LAUNCHER="${SCRIPT_DIR}/${LAUNCHER#./}"
fi

if [[ ! -x "${LAUNCHER}" ]]; then
  echo "Launcher is not executable: ${LAUNCHER}" >&2
  exit 1
fi

declare -a RESTART_PIDS=()

add_pid() {
  local pid=$1
  [[ -n "${pid}" ]] || return 0
  [[ "${pid}" =~ ^[0-9]+$ ]] || return 0
  [[ "${pid}" -eq $$ ]] && return 0
  for existing in "${RESTART_PIDS[@]:-}"; do
    [[ "${existing}" == "${pid}" ]] && return 0
  done
  RESTART_PIDS+=("${pid}")
}

if [[ -r "${PID_FILE}" ]]; then
  read -r prior_pid < "${PID_FILE}" || true
  if [[ -n "${prior_pid:-}" ]] && kill -0 "${prior_pid}" 2>/dev/null; then
    add_pid "${prior_pid}"
  fi
fi

while read -r pid cmd; do
  [[ -n "${pid:-}" && -n "${cmd:-}" ]] || continue
  if [[ "${cmd}" == *"${SCRIPT_DIR}/target/debug/fura"* || "${cmd}" == *"${SCRIPT_DIR}/target/release/fura"* || "${cmd}" == target/debug/fura* || "${cmd}" == target/release/fura* ]]; then
    add_pid "${pid}"
  fi
done < <(ps -axo pid=,command=)

if (( DRY_RUN )); then
  echo "Launcher: ${LAUNCHER}"
  echo "PID file: ${PID_FILE}"
  echo "Log file: ${LOG_FILE}"
  if (( ${#RESTART_PIDS[@]} )); then
    printf 'Would stop PIDs:%s\n' " ${RESTART_PIDS[*]}"
  else
    echo "Would stop PIDs: none"
  fi
  if (( ${#FORWARD_ARGS[@]} )); then
    printf 'Would start: %q' "${LAUNCHER}"
    for arg in "${FORWARD_ARGS[@]}"; do
      printf ' %q' "${arg}"
    done
    printf '\n'
  else
    printf 'Would start: %q\n' "${LAUNCHER}"
  fi
  exit 0
fi

if (( ${#RESTART_PIDS[@]} )); then
  kill "${RESTART_PIDS[@]}" 2>/dev/null || true
  deadline=$((SECONDS + 5))
  while (( SECONDS < deadline )); do
    still_running=0
    for pid in "${RESTART_PIDS[@]}"; do
      if kill -0 "${pid}" 2>/dev/null; then
        still_running=1
        break
      fi
    done
    (( still_running == 0 )) && break
    sleep 0.2
  done

  stubborn=()
  for pid in "${RESTART_PIDS[@]}"; do
    if kill -0 "${pid}" 2>/dev/null; then
      stubborn+=("${pid}")
    fi
  done
  if (( ${#stubborn[@]} )); then
    kill -9 "${stubborn[@]}" 2>/dev/null || true
  fi
fi

mkdir -p -- "$(dirname -- "${PID_FILE}")" "$(dirname -- "${LOG_FILE}")"
rm -f -- "${PID_FILE}"

if (( FORWARD_ARG_COUNT > 0 )); then
  nohup "${LAUNCHER}" "${FORWARD_ARGS[@]}" >>"${LOG_FILE}" 2>&1 < /dev/null &
else
  nohup "${LAUNCHER}" >>"${LOG_FILE}" 2>&1 < /dev/null &
fi
launcher_pid=$!
disown "${launcher_pid}" 2>/dev/null || true
printf '%s\n' "${launcher_pid}" > "${PID_FILE}"

echo "Started detached launcher PID ${launcher_pid}."
echo "Launcher: ${LAUNCHER}"
echo "Log: ${LOG_FILE}"
echo "PID file: ${PID_FILE}"
