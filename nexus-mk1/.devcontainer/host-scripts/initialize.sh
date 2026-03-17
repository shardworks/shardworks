#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for script in "$SCRIPT_DIR/initialize.d/"*.sh; do
    [ -f "$script" ] || continue
    echo "[initialize] Running $(basename "$script")..." >&2
    bash "$script"
done
