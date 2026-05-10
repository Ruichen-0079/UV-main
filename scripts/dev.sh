#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

nvm_node_bin="/home/administrator/.nvm/versions/node/v22.22.2/bin"
if [ -d "$nvm_node_bin" ]; then
  export PATH="$nvm_node_bin:$PATH"
fi

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required tool: $1" >&2
    exit 1
  fi
}

require_tool node
require_tool pnpm
require_tool docker

docker compose version >/dev/null

docker compose -f infra/docker-compose.yml up -d
pnpm dev
