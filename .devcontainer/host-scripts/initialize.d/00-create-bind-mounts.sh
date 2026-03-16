#!/usr/bin/env bash
# Pre-create host-side targets for bind mounts defined in devcontainer.json.
# If a bind mount source path doesn't exist, Docker creates a *directory*
# there — breaking mounts that expect a file (e.g. ~/.claude.json).
set -euo pipefail

mkdir -p "$HOME/.claude"
mkdir -p "$HOME/.config/gh"
touch "$HOME/.claude.json"
mkdir -p /tmp/ssh-filter

echo "[create-bind-mounts] Done." >&2
