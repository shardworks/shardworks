# Shardworks

An ongoing exploration into orchestrating fleets of agentic AIs — understanding how multiple autonomous AI agents can be coordinated, directed, and composed to accomplish complex tasks at scale.

## Prerequisites

- **VS Code** with the [Dev Containers](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers) extension (or a compatible devcontainer client)
- **Docker** on the host machine
- **SSH agent** running on the host with at least one key whose comment contains `seatec` — used for Git commit signing and SSH auth inside the container
- **Python 3** on the host — required by the SSH filter agent
- **Claude account** — credentials are mounted from `~/.claude` on the host

## Getting started

Clone the repo and open it in VS Code. When prompted, reopen in the Dev Container. The container will build and configure itself automatically.

## Devcontainer

The devcontainer runs as a Docker Compose service (`devcontainer_shardworks`) built from `.devcontainer/Dockerfile`, based on `mcr.microsoft.com/devcontainers/base:jammy`.

### Bind mounts

The following host paths are mounted into the container:

| Host | Container | Purpose |
|------|-----------|---------|
| `/tmp/ssh-filter` | `/tmp/ssh-filter` | Filtered SSH agent socket |
| `~/.claude` | `/home/vscode/.claude` | Claude credentials & config |
| `~/.claude.json` | `/home/vscode/.claude.json` | Claude settings |
| `~/.config/gh` | `/home/vscode/.config/gh` | GitHub CLI auth |

All host-side mount targets are pre-created by `initialize.d/00-create-bind-mounts.sh` before the container starts, preventing Docker from creating directories in place of expected files.

### SSH agent filtering

The container only has access to SSH keys whose comment matches `seatec`. This is enforced by a filter proxy (`scripts/filter-agent.py`) that runs on the host and exposes a filtered socket at `/tmp/ssh-filter/agent.sock`. The container's `SSH_AUTH_SOCK` points to this socket.

This prevents unrelated SSH keys (e.g. personal keys) from being exposed inside the container.

### Lifecycle scripts

The devcontainer uses three lifecycle hooks, each backed by a runner script that iterates a `.d/` directory in alphabetical order. To add a step, drop a `.sh` file into the relevant directory.

#### `initializeCommand` — runs on the **host** before the container starts

Runner: `.devcontainer/host-scripts/initialize.sh`
Scripts: `.devcontainer/host-scripts/initialize.d/`

| Script | What it does |
|--------|--------------|
| `00-create-bind-mounts.sh` | Pre-creates host-side bind mount targets |
| `10-start-filter-agent.sh` | Starts (or restarts) the SSH filter proxy daemon |

#### `postCreateCommand` — runs **inside the container** after it is created

Runner: `/usr/local/bin/post-create` (installed from `rootfs/`)
Scripts: `/usr/local/bin/post-create.d/`
Log: `.devcontainer/logs/post-create.log`

| Script | What it does |
|--------|--------------|
| `00-install-pandoc.sh` | Downloads and installs Pandoc |
| `10-git-config.sh` | Configures Git identity and SSH commit signing |

#### `postAttachCommand` — runs **inside the container** each time you attach

Runner: `/usr/local/bin/post-attach` (installed from `rootfs/`)
Scripts: `/usr/local/bin/post-attach.d/`
Log: `.devcontainer/logs/post-attach.log`

| Script | What it does |
|--------|--------------|
| `00-chown-workspace.sh` | Ensures `/workspace` is owned by `vscode` |

### Extending the lifecycle

Scripts are run in alphabetical order. Use numeric prefixes to control ordering (e.g. `05-`, `10-`, `20-`), but any `.sh` filename works.

- **Host-side steps** (need host tools, run before container exists): add to `host-scripts/initialize.d/`
- **One-time container setup** (installs, config): add to `rootfs/usr/local/bin/post-create.d/`
- **Per-attach steps** (environment prep, ownership fixes): add to `rootfs/usr/local/bin/post-attach.d/`
