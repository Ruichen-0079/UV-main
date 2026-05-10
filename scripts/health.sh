#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

docker compose -f infra/docker-compose.yml ps

if command -v curl >/dev/null 2>&1; then
  curl --fail --silent --show-error http://127.0.0.1:3000/health
  echo
else
  echo "Missing required tool: curl" >&2
  exit 1
fi
