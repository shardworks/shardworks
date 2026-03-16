#!/usr/bin/env bash
set -euo pipefail

echo "[link-work] Installing dependencies and building..." >&2
cd /workspace
npm install --silent
npm run build --silent

echo "[link-work] Linking work into PATH..." >&2
npm link -w @shardworks/work

echo "[link-work] Done: $(work --version)" >&2
