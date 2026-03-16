#!/usr/bin/env bash
set -euo pipefail

echo "[link-conductor] Linking conductor into PATH..." >&2
cd /workspace
npm link -w @shardworks/conductor

echo "[link-conductor] Done: $(which conductor)" >&2
