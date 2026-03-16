#!/usr/bin/env bash
set -euo pipefail

echo "[link-worker] Linking worker into PATH..." >&2
cd /workspace
npm link -w @shardworks/worker

echo "[link-worker] Done: $(which worker)" >&2
