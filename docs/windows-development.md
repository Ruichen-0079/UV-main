# Windows Development

Windows development compatibility exists, but Linux is the primary YUVI product-development and production-validation platform.

Windows packaged-private PostgreSQL ownership is deferred platform packaging. It is not the current product persistence gate, and closed unmerged PR #20 must not be resumed wholesale as current architecture.

This page documents the native PowerShell development path that still exists on current main.

## Requirements

- Windows 11
- Git for Windows
- Node.js 22 or newer
- pnpm `9.15.4`
- A working Docker Engine + Compose only when using `infra/docker-compose.yml`; Docker Desktop is one Windows development option, not a YUVI product requirement
- PowerShell 7 recommended; the scripts also support Windows PowerShell 5.1

A simple checkout location is:

```powershell
C:\Dev\UV-main
```

## Environment files

Runtime environment files live at the repository root:

```text
.env
process environment
.env.local
```

Later sources override earlier sources, so `.env.local` wins over process environment and `.env`. `apps/server/.env.local` is a legacy path and is not loaded by the current development script.

Never commit or print `.env`, `.env.local`, API keys, tokens, Authorization headers, passwords, or database credentials.

## Start

From the repository root:

```powershell
pnpm install --frozen-lockfile
.\scripts\dev.ps1
```

Current supported switches include:

```powershell
.\scripts\dev.ps1 -SkipInfra
.\scripts\dev.ps1 -SkipMigrate
.\scripts\dev.ps1 -Supervisor
.\scripts\dev.ps1 -WebHost 127.0.0.1
.\scripts\dev.ps1 -WebPort 5173
.\scripts\dev.ps1 -ServerPort 6121
```

Without `-SkipInfra`, the script uses the repository Compose development infrastructure, waits for PostgreSQL health, and runs `pnpm db:migrate` when `MEMORY_REPOSITORY=postgres` unless migration is explicitly skipped.

The Web UI binds to loopback by default. Expose it to a LAN only intentionally.

## State, logs, stop, and health

The native Windows development scripts store process metadata and logs under:

```text
%LOCALAPPDATA%\YUVI\Runtime
```

The PID metadata is ownership-aware rather than a bare PID. The stop/health scripts validate process identity before treating a process as owned by the checkout.

```powershell
.\scripts\health.ps1
.\scripts\stop.ps1
```

To also stop the repository Compose infrastructure:

```powershell
.\scripts\stop.ps1 -Infra
```

## Development supervisor

For the existing development Deep Restart path:

```powershell
.\scripts\dev.ps1 -Supervisor
```

The supervisor reloads root `.env` / `.env.local` around a requested development restart and can run migrations when PostgreSQL Memory is selected. This is development orchestration, not ownership of an external PostgreSQL process.

## PostgreSQL on Windows development

The same repository boundary applies to durable development:

```env
MEMORY_REPOSITORY=postgres
DATABASE_URL=postgres://...
```

```powershell
pnpm db:migrate
```

A reachable PostgreSQL instance is sufficient. The repository Compose stack is a convenience for development; the core persistence contract is `DATABASE_URL` plus YUVI migrations.

## Deferred Windows packaging

Current main contains historical/compatibility substrate for Windows desktop and private PostgreSQL lifecycle work, and CI still exercises Windows packaging. That code does not redefine the Linux-first product persistence model.

Deferred packaging concerns include bundled PostgreSQL, private cluster ownership, PID/process authority, Windows ACL and Credential Manager ownership, installer provisioning, private `DATABASE_URL` synthesis, and bundled pgvector resources.

PR #20 (`P4-2D2`) was closed without merge and is explicitly deferred. If Windows packaging is revisited, requirements should be re-derived from current main and current product needs; do not merge or reconstruct PR #20 wholesale.

For the primary product-development path, use [quickstart.md](quickstart.md) and [p4-linux-first.md](p4-linux-first.md).