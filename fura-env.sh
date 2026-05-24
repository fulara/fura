#!/usr/bin/env bash

load_fura_env() {
  local script_dir=$1
  local env_file=${FURA_ENV_FILE:-${script_dir}/.env}

  if [[ ! -f "${env_file}" ]]; then
    echo "Required env file not found: ${env_file}" >&2
    echo "Create it or set FURA_ENV_FILE=/path/to/env before running this script." >&2
    exit 1
  fi

  set -a
  # shellcheck source=/dev/null
  source "${env_file}"
  set +a
}

require_env() {
  local missing=()
  local name
  for name in "$@"; do
    if [[ -z "${!name:-}" ]]; then
      missing+=("${name}")
    fi
  done

  if (( ${#missing[@]} > 0 )); then
    printf 'Missing required environment variable(s): %s\n' "${missing[*]}" >&2
    printf 'Set them in .env or in FURA_ENV_FILE before running this script.\n' >&2
    exit 1
  fi
}

require_directory() {
  local name=$1
  local value=${!name:-}
  if [[ ! -d "${value}" ]]; then
    printf '%s is not a directory: %s\n' "${name}" "${value}" >&2
    exit 1
  fi
}

require_executable() {
  local name=$1
  local value=${!name:-}
  if [[ ! -x "${value}" ]]; then
    printf '%s is not executable: %s\n' "${name}" "${value}" >&2
    exit 1
  fi
}

require_readable() {
  local name=$1
  local value=${!name:-}
  if [[ ! -r "${value}" ]]; then
    printf '%s is not readable: %s\n' "${name}" "${value}" >&2
    exit 1
  fi
}
