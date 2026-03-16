#!/usr/bin/env python3
"""
SSH Agent Filter Proxy
======================
Listens on a new Unix socket and proxies to the upstream SSH_AUTH_SOCK,
but only exposes keys whose comment contains FILTER_STR (case-insensitive).

Usage:
    python3 filter-agent.py <filter-string> [socket-path]

Arguments:
    filter-string   Substring to match against key comments (from ssh-add -l).
                    e.g. "github" matches "git@github.com" or "my-github-key"
    socket-path     Where to create the filtered socket.
                    Default: /tmp/filtered-ssh-agent.sock

Environment:
    SSH_AUTH_SOCK   Upstream agent socket set by SSH agent forwarding.
"""

import hashlib
import os
import signal
import socket
import struct
import sys
import threading

# ---------------------------------------------------------------------------
# SSH agent protocol constants
# ---------------------------------------------------------------------------
SSH2_AGENTC_REQUEST_IDENTITIES = 11
SSH2_AGENT_IDENTITIES_ANSWER   = 12
SSH2_AGENTC_SIGN_REQUEST       = 13
SSH_AGENT_FAILURE              = 5


# ---------------------------------------------------------------------------
# Wire helpers
# ---------------------------------------------------------------------------

def recv_exact(sock: socket.socket, n: int) -> bytes | None:
    """Read exactly n bytes; return None on EOF."""
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


def read_message(sock: socket.socket) -> bytes | None:
    """Read one length-prefixed agent message."""
    hdr = recv_exact(sock, 4)
    if hdr is None:
        return None
    (length,) = struct.unpack(">I", hdr)
    return recv_exact(sock, length)


def send_message(sock: socket.socket, data: bytes) -> None:
    sock.sendall(struct.pack(">I", len(data)) + data)


def parse_string(data: bytes, offset: int) -> tuple[bytes, int]:
    """Parse a uint32-prefixed byte string; return (value, new_offset)."""
    (length,) = struct.unpack(">I", data[offset : offset + 4])
    value = data[offset + 4 : offset + 4 + length]
    return value, offset + 4 + length


# ---------------------------------------------------------------------------
# Identity response manipulation
# ---------------------------------------------------------------------------

def parse_identities_answer(data: bytes) -> list[tuple[bytes, str]] | None:
    """Return [(key_blob, comment), ...] from SSH2_AGENT_IDENTITIES_ANSWER."""
    if not data or data[0] != SSH2_AGENT_IDENTITIES_ANSWER:
        return None
    (count,) = struct.unpack(">I", data[1:5])
    offset = 5
    keys = []
    for _ in range(count):
        key_blob, offset = parse_string(data, offset)
        raw_comment, offset = parse_string(data, offset)
        keys.append((key_blob, raw_comment.decode("utf-8", errors="replace")))
    return keys


def build_identities_answer(keys: list[tuple[bytes, str]]) -> bytes:
    """Serialise [(key_blob, comment), ...] as SSH2_AGENT_IDENTITIES_ANSWER."""
    parts: list[bytes] = [bytes([SSH2_AGENT_IDENTITIES_ANSWER])]
    parts.append(struct.pack(">I", len(keys)))
    for key_blob, comment in keys:
        comment_bytes = comment.encode("utf-8")
        parts.append(struct.pack(">I", len(key_blob)) + key_blob)
        parts.append(struct.pack(">I", len(comment_bytes)) + comment_bytes)
    return b"".join(parts)


# ---------------------------------------------------------------------------
# Per-connection proxy handler
# ---------------------------------------------------------------------------

def handle_client(
    client_sock: socket.socket,
    upstream_path: str,
    filter_str: str,
) -> None:
    """
    Proxy one client connection.

    Maintains a per-connection set of allowed key blobs which is populated
    on the first SSH2_AGENTC_REQUEST_IDENTITIES exchange and consulted on
    every subsequent SSH2_AGENTC_SIGN_REQUEST.
    """
    upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        upstream.connect(upstream_path)
    except OSError as exc:
        print(f"[filter-agent] cannot connect to upstream {upstream_path}: {exc}",
              file=sys.stderr)
        client_sock.close()
        return

    allowed_blobs: set[bytes] = set()

    try:
        while True:
            msg = read_message(client_sock)
            if msg is None:
                break

            msg_type = msg[0]

            # ----------------------------------------------------------------
            # LIST IDENTITIES — filter the response
            # ----------------------------------------------------------------
            if msg_type == SSH2_AGENTC_REQUEST_IDENTITIES:
                send_message(upstream, msg)
                resp = read_message(upstream)
                if resp and resp[0] == SSH2_AGENT_IDENTITIES_ANSWER:
                    all_keys = parse_identities_answer(resp) or []
                    filtered = [
                        (blob, comment)
                        for blob, comment in all_keys
                        if filter_str.lower() in comment.lower()
                    ]
                    # Refresh allowed set for this connection
                    allowed_blobs.clear()
                    allowed_blobs.update(blob for blob, _ in filtered)

                    if not filtered:
                        print(
                            f"[filter-agent] WARNING: no keys matched '{filter_str}'. "
                            f"Available comments: {[c for _, c in all_keys]}",
                            file=sys.stderr,
                        )

                    send_message(client_sock, build_identities_answer(filtered))
                else:
                    # Unexpected response — pass through unchanged
                    if resp:
                        send_message(client_sock, resp)

            # ----------------------------------------------------------------
            # SIGN REQUEST — block unless the key is in the allowed set
            # ----------------------------------------------------------------
            elif msg_type == SSH2_AGENTC_SIGN_REQUEST:
                key_blob, _ = parse_string(msg, 1)
                if key_blob in allowed_blobs:
                    send_message(upstream, msg)
                    resp = read_message(upstream)
                    if resp:
                        send_message(client_sock, resp)
                else:
                    # Silently reject — the client will try the next key
                    send_message(client_sock, bytes([SSH_AGENT_FAILURE]))

            # ----------------------------------------------------------------
            # Everything else — pass through transparently
            # ----------------------------------------------------------------
            else:
                send_message(upstream, msg)
                resp = read_message(upstream)
                if resp:
                    send_message(client_sock, resp)

    finally:
        client_sock.close()
        upstream.close()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    if len(sys.argv) < 2:
        print(
            f"Usage: {sys.argv[0]} <key-comment-filter> [socket-path]",
            file=sys.stderr,
        )
        sys.exit(1)

    filter_str  = sys.argv[1]
    socket_path = sys.argv[2] if len(sys.argv) > 2 else "/tmp/filtered-ssh-agent.sock"
    upstream    = os.environ.get("SSH_AUTH_SOCK", "")

    if not upstream:
        print("[filter-agent] SSH_AUTH_SOCK is not set — cannot start proxy.",
              file=sys.stderr)
        sys.exit(1)

    # Remove stale socket
    try:
        os.unlink(socket_path)
    except FileNotFoundError:
        pass

    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(socket_path)
    os.chmod(socket_path, 0o600)
    server.listen(10)

    print(f"[filter-agent] Listening on {socket_path}", file=sys.stderr)
    print(f"[filter-agent] Upstream:     {upstream}", file=sys.stderr)
    print(f"[filter-agent] Key filter:   '{filter_str}'", file=sys.stderr)

    def _shutdown(sig, _frame):
        server.close()
        try:
            os.unlink(socket_path)
        except OSError:
            pass
        sys.exit(0)

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    while True:
        try:
            client_sock, _ = server.accept()
        except OSError:
            break
        threading.Thread(
            target=handle_client,
            args=(client_sock, upstream, filter_str),
            daemon=True,
        ).start()


if __name__ == "__main__":
    main()
