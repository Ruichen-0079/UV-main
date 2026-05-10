@echo off
setlocal

wsl -d Ubuntu --cd /home/administrator/uv-main/uv-main bash -lc "set -euo pipefail; export PATH=/home/administrator/.nvm/versions/node/v22.22.2/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; command -v node; node --version; command -v pnpm; pnpm --version; command -v docker; docker --version; docker compose version; docker compose -f infra/docker-compose.yml config >/dev/null; echo Environment check passed."

exit /b %ERRORLEVEL%
