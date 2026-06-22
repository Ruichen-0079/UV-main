# Windows Development

YUVI Runtime supports a Windows-first development loop with PowerShell and Docker Desktop.
Linux and Bash scripts remain supported for WSL/Linux developers.

## Requirements

- Windows 11
- Git for Windows
- Node.js 22 or newer
- pnpm 9 or newer
- Docker Desktop with the Docker Engine running
- PowerShell 7 recommended; Windows PowerShell 5.1 is supported by the scripts

The recommended checkout path is:

```powershell
C:\Dev\UV-main
```

## Environment Files

Runtime env files are loaded from the repository root only:

```text
.env
process environment
.env.local
```

Later sources override earlier sources, so `.env.local` wins over shell variables and `.env`.
Set `YUVI_RUNTIME_ENV_DIR` only when you intentionally want another directory to contain the
runtime `.env` and `.env.local` files.

`apps/server/.env` and `apps/server/.env.local` are legacy paths. The runtime warns when the old
local file exists at the default root but does not load it.

Never commit `.env`, `.env.local`, API keys, tokens, Authorization headers, passwords, or database
secrets.

## Start

From the repository root:

```powershell
pnpm install --frozen-lockfile
.\scripts\dev.ps1
```

Useful options:

```powershell
.\scripts\dev.ps1 -SkipInfra
.\scripts\dev.ps1 -SkipMigrate
.\scripts\dev.ps1 -Supervisor
.\scripts\dev.ps1 -WebHost 127.0.0.1
.\scripts\dev.ps1 -WebPort 5173
.\scripts\dev.ps1 -ServerPort 6121
```

`dev.ps1` checks `node`, `pnpm`, `docker`, and `docker compose`, starts:

```powershell
docker compose -f infra/docker-compose.yml up -d
```

It waits for PostgreSQL health, runs `pnpm db:migrate` when `MEMORY_REPOSITORY=postgres`, then starts
the server and web dashboard.

The web dashboard binds to `127.0.0.1` by default. To expose it intentionally:

```powershell
$env:YUVI_WEB_HOST = "0.0.0.0"
.\scripts\dev.ps1 -WebHost 0.0.0.0
```

The scripts do not modify Windows Firewall.

## State And Logs

Runtime state is stored in:

```text
%LOCALAPPDATA%\YUVI\Runtime
```

Files:

```text
server.pid
web.pid
server.log
web.log
restart-request.json
```

The `.pid` files are JSON metadata files, not raw process IDs. `stop.ps1` and `health.ps1` validate
the process start time, command marker, repository root, state directory, and role before treating a
process as owned by this checkout.

## Deep Restart

Run supervisor mode when testing Dashboard Deep Restart:

```powershell
.\scripts\dev.ps1 -Supervisor
```

When the server exits with code `42` or writes `restart-request.json`, the supervisor reloads root
`.env` plus `.env.local`, optionally runs `pnpm db:migrate` for PostgreSQL memory, and restarts the
server.

## Stop And Health

Stop server and web process trees:

```powershell
.\scripts\stop.ps1
```

Stop server, web, and Docker infrastructure:

```powershell
.\scripts\stop.ps1 -Infra
```

Check Docker Engine, PostgreSQL, Redis, NATS, server `/health`, web, and PID files:

```powershell
.\scripts\health.ps1
```

## PostgreSQL Memory

For PostgreSQL memory, set these in root `.env.local` or `.env`:

```env
MEMORY_REPOSITORY=postgres
DATABASE_URL=postgres://yuvi:yuvi_dev_password@localhost:5432/yuvi
```

Then run:

```powershell
docker compose -f .\infra\docker-compose.yml up -d
pnpm db:migrate
```

The compose file uses named Docker volumes:

```text
companion-postgres-data
companion-redis-data
companion-nats-data
```

It does not bind-mount Windows folders for database storage.
Its PostgreSQL, Redis, and NATS ports are bound to `127.0.0.1` only for local development.

## UTF-8 Notes

Keep text files UTF-8. The PowerShell scripts read env files as UTF-8 and do not rewrite source files
with system ANSI encoding. On Windows PowerShell 5.1, keep commands in the provided scripts or use
PowerShell 7 when editing files interactively.

## Linux And Bash

The Bash scripts are still supported:

```bash
./scripts/dev.sh
./scripts/health.sh
./scripts/stop.sh
```

Windows-first development does not remove the Linux path.
