#!/usr/bin/env bash
set -euo pipefail

echo "[link-tq] Installing dependencies and building..." >&2
cd /workspace
npm install --silent
npm run build --silent

echo "[link-tq] Linking tq into PATH..." >&2
npm link -w @shardworks/tq

echo "[link-tq] Done: $(tq --version)" >&2
