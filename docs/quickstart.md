# Developer Quickstart

[English](quickstart.md) | [简体中文](quickstart.zh-CN.md)

This guide describes the current **Linux-first** development path for YUVI Runtime.

Linux is the primary development and persistence-validation platform. Windows PowerShell helpers remain supported for compatibility, but WSL/Windows-specific infrastructure is no longer the authority for normal product development.

## 1. Prerequisites

Required:

- Node.js 22+
- pnpm 9+
- Git

For PostgreSQL-backed development:

- Docker Engine
- Docker Compose plugin

Check the local toolchain:

```bash
node --version
pnpm --version
git --version
docker --version
docker compose version
```

Docker is optional when working entirely in in-memory mode.

## 2. Clone and install

From a normal Linux filesystem checkout:

```bash
git clone https://github.com/Ruichen-0079/UV-main.git
cd UV-main
pnpm install
```

Copy the environment template:

```bash
cp .env.example .env
```

`.env` and `.env.local` are local sensitive state. Do not commit or print real API keys, authorization headers, tokens, passwords, or private database URLs.

Runtime env precedence is:

```text
.env
-> process environment
-> .env.local
```

The development scripts load the root runtime env automatically.

## 3. Choose persistence mode

### Lightweight in-memory mode

For fast UI/runtime development:

```env
MEMORY_REPOSITORY=in-memory
CONVERSATION_REPOSITORY=in-memory
```

Run without Docker infrastructure:

```bash
SKIP_INFRA=1 ./scripts/dev.sh
```

In-memory conversation state survives rebuilding a Runtime instance only while the process remains alive. It is not restart-durable.

### Durable PostgreSQL mode

For durable memory and conversation recovery:

```env
MEMORY_REPOSITORY=postgres
CONVERSATION_REPOSITORY=postgres
DATABASE_URL=postgres://yuvi:yuvi_dev_password@localhost:5432/yuvi
```

Start the development PostgreSQL service:

```bash
docker compose -f infra/docker-compose.yml up -d postgres
```

Apply migrations:

```bash
pnpm db:migrate
```

The normal durable architecture is:

```text
YUVI Runtime / Memory
  -> repository ports
  -> DATABASE_URL
  -> PostgreSQL
  -> packages/memory/migrations
```

PostgreSQL can be system-managed, externally managed, or container-managed. YUVI Core does not require ownership of the PostgreSQL process.

`./scripts/dev.sh` fails closed when PostgreSQL memory is selected without `DATABASE_URL`. Unless `YUVI_AUTO_MIGRATE=0` is set, it also runs migrations before starting the runtime in PostgreSQL mode.

See [p4-linux-first.md](p4-linux-first.md) for the current persistence/reliability baseline.

## 4. Configure providers

Normal development is real-provider-first. Configure only the capabilities you need in `.env` / `.env.local`.

Current provider boundaries include:

- chat
- reasoning
- embeddings
- TTS
- STT
- vision
- proactive decision
- assistant continuation

Mock providers are for tests, CI, or intentional offline development and should be enabled explicitly when needed.

Provider-specific implementation belongs in `packages/providers`; Runtime Core consumes provider-neutral interfaces.

See [providers.md](providers.md) for the current variables, routing, verification behavior, and provider-specific notes.

## 5. Start development

Primary Linux entry point:

```bash
./scripts/dev.sh
```

The script:

- sets the repository as `YUVI_RUNTIME_ENV_DIR`;
- loads `.env` and `.env.local` without printing secrets;
- installs dependencies when needed;
- starts Docker development infrastructure unless `SKIP_INFRA=1`;
- validates durable PostgreSQL configuration;
- runs migrations when required;
- starts the server and web development processes.

Development URLs:

```text
Server:    http://localhost:6121
Web UI:    http://localhost:5173
WebSocket: ws://localhost:6121/ws
```

Check health:

```bash
./scripts/health.sh
```

Stop the development environment:

```bash
./scripts/stop.sh
```

`pnpm dev` is a narrower command: it starts only the Fastify server package in development mode.

## 6. Basic runtime checks

Health:

```bash
curl http://127.0.0.1:6121/health
```

Send a normal message through the compatibility endpoint:

```bash
curl -X POST http://127.0.0.1:6121/message \
  -H 'content-type: application/json' \
  -d '{"sessionId":"dev","text":"Hello YUVI","options":{"useMemory":true,"voiceOutput":false}}'
```

The versioned runtime endpoints remain authoritative where both compatibility and versioned routes exist. Use the Dashboard or current API docs/source when testing newer behavior.

## 7. Validate the repository

Before opening or reviewing a PR:

```bash
pnpm check
pnpm test
pnpm build
```

Standard smoke test:

```bash
pnpm smoke
```

PostgreSQL-backed smoke:

```bash
pnpm smoke:postgres
```

Useful memory maintenance commands:

```bash
pnpm memory:index:status
pnpm memory:maintenance
pnpm memory:embed:backfill -- --dry-run
```

The dedicated Linux persistence CI path provisions PostgreSQL + pgvector and validates migrations, focused memory/core/server behavior, migration re-entry, and a PostgreSQL-backed runtime smoke.

## 8. Development database reset

Use the guarded reset helper only when local development data may be destroyed:

```bash
pnpm db:reset:dev
```

This is destructive.

Manual Docker-volume removal is an advanced fallback:

```bash
docker compose -f infra/docker-compose.yml down -v
```

Changing PostgreSQL usernames or passwords in Compose does not rewrite an existing initialized volume.

## 9. Windows compatibility

Windows is supported, but it is no longer the primary development baseline.

PowerShell helpers remain available:

```powershell
.\scripts\dev.ps1
.\scripts\health.ps1
.\scripts\stop.ps1
```

Windows-specific installer, process-ownership, bundled-database, ACL, and packaging concerns belong to the Windows platform layer and must not become prerequisites for Linux Runtime correctness.

See [windows-development.md](windows-development.md) for platform-specific details.

## 10. Where to read next

- [Architecture](architecture.md)
- [P4 Linux-first persistence baseline](p4-linux-first.md)
- [Memory](memory.md)
- [Providers](providers.md)
- [Testing](testing.md)
- [Dashboard](dashboard.md)
- [Future companion roadmap](future/README.md)

When documentation and implementation disagree, current repository behavior, tests, migrations, and CI evidence take precedence; update the documentation rather than preserving a stale platform assumption.