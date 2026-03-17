#!/usr/bin/env bash
set -euo pipefail

HOST="${DOLT_HOST:-dolt}"
PORT="${DOLT_PORT:-3306}"

echo "[init-dolt] Creating shardworks database on ${HOST}:${PORT}..." >&2

mysql -h "$HOST" -P "$PORT" -u root \
  -e "CREATE DATABASE IF NOT EXISTS shardworks;"

echo "[init-dolt] Done." >&2
