#!/usr/bin/env bash
set -euo pipefail

git config --global user.name "Seatec Agent"
git config --global user.email "seatec@dogoodstuff.net"

# Configure SSH commit signing using the forwarded SSH agent key
mkdir -p ~/.ssh && chmod 700 ~/.ssh
SSH_PUBLIC_KEY=$(ssh-add -L 2>/dev/null | grep -i seatec | head -1)
if [ -n "$SSH_PUBLIC_KEY" ]; then
    echo "$SSH_PUBLIC_KEY" > ~/.ssh/signing_key.pub
    git config --global gpg.format ssh
    git config --global user.signingkey ~/.ssh/signing_key.pub
    git config --global commit.gpgsign true
    git config --global tag.gpgsign true
    echo "[git-config] SSH signing configured." >&2
else
    echo "[git-config] WARNING: No seatec SSH key found in agent, commit signing not configured." >&2
fi
