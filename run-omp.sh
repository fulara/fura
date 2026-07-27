#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./fura-env.sh
source "${SCRIPT_DIR}/fura-env.sh"
load_fura_env "${SCRIPT_DIR}"
use_omp_submodule "${SCRIPT_DIR}"
require_env BUN_BIN
require_executable BUN_BIN

exec "${BUN_BIN}" "${OMP_REPO}/packages/coding-agent/src/cli.ts" "$@"
