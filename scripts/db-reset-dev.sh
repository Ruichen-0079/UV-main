#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

cat <<'EOF'
WARNING: this deletes development Docker volumes for this repo.

It removes the PostgreSQL, Redis, and NATS development data created by
infra/docker-compose.yml. Do not run this if you need local development data.

To continue, type exactly: RESET DEV DB
EOF

read -r confirmation

if [ "$confirmation" != "RESET DEV DB" ]; then
  echo "Cancelled. No volumes were deleted."
  exit 1
fi

docker compose -f infra/docker-compose.yml down -v
echo "Development Docker volumes have been removed."
