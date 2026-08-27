# Windows development compatibility

Windows development compatibility exists. Linux-first product work and Linux production validation are authoritative for the current runtime. Windows is not the current primary production-validation platform.

Private/bundled PostgreSQL ownership, installer provisioning, and the packaged Windows database lifecycle are deferred platform-packaging work. PR #20 is historical/deferred and must not be resumed wholesale from this document.

This page preserves the supported Windows development helper path; it does not redefine the Linux runtime architecture.

## Requirements

- Windows 11 or a supported Windows installation;
- Git for Windows;
- Node.js 22 or newer;
- pnpm 9.15.4;
- Docker Desktop with its Docker Engine running when using Compose infrastructure;
- PowerShell 7 recommended; Windows PowerShell 5.1 is supported by the provided scripts.

WSL is optional. You can use the PowerShell helper directly, or use the Linux-first Bash path described in [Developer quickstart](quickstart.md).

## Environment files

Runtime environment files are read from the repository root in this order:

```text
.env
process environment
.env.local
```

Later sources override earlier sources. Settings written by Dashboard are kept in root `.env.local`; `apps/server/.env.local` is a legacy path and is not loaded. Never commit `.env`, `.env.local`, API keys, tokens, Authorization headers, passwords, or database secrets.

## Start the Windows-compatible development loop

From the repository root:

```powershell
pnpm install --frozen-lockfile
Copy-Item .env.example .env
.\scripts\dev.ps1
```

Useful supported options:

```powershell
.\scripts\dev.ps1 -SkipInfra
.\scripts\dev.ps1 -SkipMigrate
.\scripts\dev.ps1 -Supervisor
.\scripts\dev.ps1 -WebHost 127.0.0.1
.\scripts\dev.ps1 -WebPort 5173
.\scripts\dev.ps1 -ServerPort 6121
```

The helper checks Node, pnpm, Docker, and Docker Compose when infrastructure is enabled; loads root `.env` and `.env.local`; optionally starts `infra/docker-compose.yml`; runs `pnpm db:migrate` when `MEMORY_REPOSITORY=postgres` unless `-SkipMigrate` is supplied; and starts the server and Web UI. `-SkipInfra` is appropriate when using in-memory mode or an independently managed database.

The default local addresses are:

- Server: `http://127.0.0.1:6121`
- Web UI: `http://127.0.0.1:5173`
- WebSocket: `ws://127.0.0.1:6121/ws`

Use the supported helpers to inspect or stop the development processes:

```powershell
.\scripts\health.ps1
.\scripts\stop.ps1
.\scripts\stop.ps1 -Infra
```

The scripts keep ownership metadata and logs under `%LOCALAPPDATA%\YUVI\Runtime` by default. They validate process identity before stopping a process and do not modify Windows Firewall.

## PostgreSQL development mode

The Windows Compose PostgreSQL service is a convenient development provider, not the current product-owned database architecture. For durable conversation or memory mode:

```env
MEMORY_REPOSITORY=postgres
CONVERSATION_REPOSITORY=postgres
DATABASE_URL=postgres://user:password@host:5432/database
```

Run migrations before use:

```powershell
pnpm db:migrate
```

An external/system/other-container PostgreSQL is also valid. The deferred Windows packaged path may eventually synthesize a private database configuration, but current Linux-first docs must not treat that as implemented product behavior.

## Deep Restart and local settings

Use supervisor mode when testing the Dashboard Deep Restart workflow:

```powershell
.\scripts\dev.ps1 -Supervisor
```

The Dashboard distinguishes configuration that can be applied in-process from settings that require a server restart. Provider settings and live verification are separate concepts: status inspection is local/configuration-based, while explicit Chat, Reasoning, and Embedding verification can call a provider. TTS, STT, and Vision verification routes are configuration-only.

## Linux-first reference

For current persistence boundaries, external PostgreSQL ownership, finalized-turn durability, and platform status, read [Current state](current-state.md), [Architecture](architecture.md), and [P4 Linux-first persistence](p4-linux-first.md).
