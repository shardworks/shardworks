#!/usr/bin/env bash
# start-filter-agent.sh
# ---------------------
# Launched by devcontainer "initializeCommand" on the remote Linux host.
# Starts (or restarts) filter-agent.py as a background daemon, then waits
# for the filtered socket to appear before returning.
#
# Required env var (set in devcontainer.json initializeCommand or your shell):
#   SSH_KEY_FILTER   Substring matched against key comments from ssh-add -l
#                    e.g. "github", "work", or the full comment string.
#
# The filtered socket is always written to SOCKET_PATH below.
set -euo pipefail

SOCKET_DIR="/tmp/ssh-filter"
SOCKET_PATH="$SOCKET_DIR/agent.sock"
LOG_FILE="$SOCKET_DIR/agent.log"
PID_FILE="$SOCKET_DIR/agent.pid"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_SCRIPT="$SCRIPT_DIR/filter-agent.py"

# Pre-create the directory so the Docker bind-mount source always exists
# as a directory. If we mount a socket file path and it is absent, Docker
# creates a *directory* there instead, breaking SSH_AUTH_SOCK inside the
# container.
mkdir -p "$SOCKET_DIR"

# ------------------------------------------------------------------
# Validate prerequisites
# ------------------------------------------------------------------
if [[ -z "${SSH_AUTH_SOCK:-}" ]]; then
    echo "[start-filter-agent] WARNING: SSH_AUTH_SOCK is not set." >&2
    echo "[start-filter-agent] Make sure VS Code SSH remote has agent forwarding enabled." >&2
    echo "[start-filter-agent] SSH inside the container will not work." >&2
    exit 0
fi

if [[ -z "${SSH_KEY_FILTER:-}" ]]; then
    echo "[start-filter-agent] ERROR: SSH_KEY_FILTER is not set." >&2
    echo "[start-filter-agent] Set it in your initializeCommand, e.g.:" >&2
    echo '  "initializeCommand": "SSH_KEY_FILTER='seatec@archon11-01' .devcontainer/start-filter-agent.sh"' >&2
    exit 1
fi

if ! command -v python3 &>/dev/null; then
    echo "[start-filter-agent] ERROR: python3 not found on remote host." >&2
    exit 1
fi

# ------------------------------------------------------------------
# Kill any previous instance of the filter agent for this socket
# ------------------------------------------------------------------
if [[ -f "$PID_FILE" ]]; then
    OLD_PID=$(cat "$PID_FILE")
    if kill -0 "$OLD_PID" 2>/dev/null; then
        echo "[start-filter-agent] Stopping previous instance (pid $OLD_PID)..." >&2
        kill "$OLD_PID" 2>/dev/null || true
        sleep 0.2
    fi
    rm -f "$PID_FILE"
fi

# Belt-and-suspenders: kill any stray python3 running our script
pkill -f "python3.*filter-agent\.py" 2>/dev/null || true
sleep 0.1
rm -f "$SOCKET_PATH"

# ------------------------------------------------------------------
# Launch the filter agent in the background
# ------------------------------------------------------------------
echo "[start-filter-agent] Starting filter agent (filter='${SSH_KEY_FILTER}')..." >&2
nohup python3 "$AGENT_SCRIPT" "${SSH_KEY_FILTER}" "$SOCKET_PATH" \
    >"$LOG_FILE" 2>&1 &
AGENT_PID=$!
echo "$AGENT_PID" > "$PID_FILE"
echo "[start-filter-agent] Agent pid: $AGENT_PID" >&2

# ------------------------------------------------------------------
# Wait for socket to be ready (up to 10 s)
# ------------------------------------------------------------------
for i in $(seq 1 20); do
    if [[ -S "$SOCKET_PATH" ]]; then
        echo "[start-filter-agent] Socket ready: $SOCKET_PATH" >&2
        exit 0
    fi
    sleep 0.5
done

echo "[start-filter-agent] ERROR: socket never appeared. Agent log:" >&2
cat "$LOG_FILE" >&2
exit 1
