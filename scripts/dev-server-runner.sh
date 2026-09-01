#!/usr/bin/env bash
set -euo pipefail

repo_root="${YUVI_RUNTIME_ENV_DIR:-.}"
server_port="${SERVER_PORT:-6121}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo-root)
      if [ "$#" -lt 2 ]; then
        echo "--repo-root requires a value" >&2
        exit 2
      fi
      repo_root="$2"
      shift 2
      ;;
    --server-port)
      if [ "$#" -lt 2 ]; then
        echo "--server-port requires a value" >&2
        exit 2
      fi
      server_port="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

cd "$repo_root"
export YUVI_RUNTIME_ENV_DIR="$repo_root"
export SERVER_PORT="$server_port"
exec pnpm exec tsx --conditions development apps/server/src/index.ts
