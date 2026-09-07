#!/usr/bin/env bash
set -euo pipefail

# Mock-only launcher: isolated process session, HOME, data and build outputs.
# Never source production .env or use the production restart helper.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
exec "${PYTHON_BIN:-python3}" "${SCRIPT_DIR}/scripts/run_mock_rpc.py" "$@"
