# YUVI Runtime

[English](README.md) | [简体中文](README.zh-CN.md)

YUVI is a local-first, event-driven AI companion runtime. The runtime—not a particular avatar, UI, model vendor, or operating system wrapper—is the product core.

The repository is an original implementation inspired by the architectural ambition of projects such as AIRI. It is designed to support durable conversation and memory, provider-neutral reasoning and media capabilities, proactive behavior, avatar presentation, and a longer-term character/cognition architecture without coupling those concerns into one monolith.

## Current Baseline

YUVI is **Linux-first** for active development and production validation.

The primary development path is native Linux with Node.js, pnpm, Docker Engine, and the Bash lifecycle scripts. Windows support remains in the repository, including PowerShell helpers and desktop-packaging work, but Windows-specific packaged infrastructure is not a prerequisite for product development.

The current durable persistence boundary is intentionally simple:

```text
YUVI Runtime / Memory
  -> repository ports
  -> DATABASE_URL
  -> PostgreSQL
  -> packages/memory/migrations
```

PostgreSQL may be system-managed, externally managed, or provided by the development Docker Compose stack. Core runtime correctness does not depend on owning the PostgreSQL process.

Already-proven reliability semantics remain part of the baseline, including finalized-turn lifecycle handling, durable ingestion state, semantic idempotency, crash recovery, retry/reconcile behavior, cancellation fencing, and fail-closed persistence boundaries where required.

See [docs/p4-linux-first.md](docs/p4-linux-first.md) for the persistence/reliability rebaseline and [docs/future/README.md](docs/future/README.md) for the planned post-structural companion roadmap.

## Repository Layout

- `apps/server` — Fastify HTTP/WebSocket runtime server and composition root.
- `apps/web` — React/Vite developer dashboard and current companion presentation surface.
- `apps/desktop` — Tauri desktop shell and packaging integration work.
- `packages/core` — runtime orchestration and semantic execution boundaries.
- `packages/memory` — conversation persistence, long-term memory, finalized-ingestion reliability, PostgreSQL repositories, and migrations.
- `packages/prompt-builder` — structured provider-neutral prompt construction.
- `packages/providers` — provider contracts, routing, adapters, and normalized provider errors.
- `packages/protocol` — runtime event contracts and schemas.
- `packages/event-bus` — runtime event-bus abstraction; current runtime mode is in-memory.
- `packages/config` — typed runtime configuration and redaction boundaries.
- `packages/desktop-supervisor` — desktop/platform supervision code; not part of the Linux runtime correctness path.
- `infra/docker-compose.yml` — development PostgreSQL + pgvector, Redis, and NATS services.

## Quick Start — Linux

Requirements:

- Node.js 22+
- pnpm 9+
- Docker Engine + Docker Compose plugin when using development infrastructure

From the repository root:

```bash
pnpm install
cp .env.example .env
./scripts/dev.sh
```

Development URLs:

- Server: `http://localhost:6121`
- Web UI: `http://localhost:5173`
- WebSocket: `ws://localhost:6121/ws`

Check or stop the development runtime:

```bash
./scripts/health.sh
./scripts/stop.sh
```

For lightweight in-memory development without starting Docker infrastructure:

```bash
SKIP_INFRA=1 ./scripts/dev.sh
```

See [docs/quickstart.md](docs/quickstart.md) for the full development path.

## Durable PostgreSQL Mode

The fastest development mode is in-memory:

```env
MEMORY_REPOSITORY=in-memory
CONVERSATION_REPOSITORY=in-memory
```

For durable memory and conversation recovery:

```env
MEMORY_REPOSITORY=postgres
CONVERSATION_REPOSITORY=postgres
DATABASE_URL=postgres://yuvi:yuvi_dev_password@localhost:5432/yuvi
```

Start the development database and apply migrations:

```bash
docker compose -f infra/docker-compose.yml up -d postgres
pnpm db:migrate
```

`./scripts/dev.sh` refuses to start durable PostgreSQL mode without `DATABASE_URL`. Unless `YUVI_AUTO_MIGRATE=0` is set, the development script also applies migrations before starting the runtime when PostgreSQL memory is active.

Useful persistence checks:

```bash
pnpm smoke:postgres
pnpm memory:index:status
pnpm memory:maintenance
```

Existing memories can be embedded after a real embedding provider is configured:

```bash
pnpm memory:embed:backfill -- --dry-run
pnpm memory:embed:backfill
```

## Providers

Provider routing is configuration-driven. The repository currently supports provider boundaries for chat, reasoning, embeddings, TTS, STT, vision, proactive decisions, and assistant continuations.

The normal runtime path is real-provider-first. Mock providers are for tests, CI, or intentional offline development and must be enabled explicitly where required.

Provider-specific code belongs in `packages/providers`; `packages/core` should not depend directly on vendor SDK classes.

See [docs/providers.md](docs/providers.md) for provider configuration and verification.

## Runtime Semantics

The main runtime path is roughly:

```text
input
  -> Runtime admission / persistence
  -> direct context + memory retrieval
  -> prompt construction
  -> provider execution
  -> persisted assistant result
  -> runtime events
  -> optional presentation effects
```

Long-term memory is not raw chat history. Raw conversation persistence and semantic memory are separate concerns.

The current proactive P6 path is also deliberately bounded: the proactive decision contract chooses `NO_OP` or `REQUEST_TEXT`; assistant-initiated continuation is assistant-only, non-replayable under the same active claim, and does not invent a synthetic user turn.

Future identity/persona/relationship, continuity, character/cognition, capability, temporal, embodiment, and post-training work is documented under [docs/future](docs/future/README.md) and is not current runtime behavior unless implemented elsewhere in the repository.

## Validation

Primary repository validation:

```bash
pnpm check
pnpm test
pnpm build
```

Useful smoke paths:

```bash
pnpm smoke
pnpm smoke:postgres
```

CI includes Linux persistence validation with PostgreSQL + pgvector. Windows validation remains useful for compatibility and packaging regressions, but Linux is the primary product-development and persistence-validation platform.

## Common Scripts

- `./scripts/dev.sh` — primary Linux development entry point; loads root `.env` and `.env.local`, optionally starts Docker infrastructure, runs PostgreSQL migrations when required, and starts server/web development processes.
- `./scripts/health.sh` — reports development process and infrastructure health.
- `./scripts/stop.sh` — stops Linux development processes and associated development infrastructure as configured.
- `pnpm dev` — starts only the Fastify server package in development mode.
- `pnpm check` — host-safety checks plus TypeScript validation.
- `pnpm test` — workspace tests plus host-environment safety tests.
- `pnpm build` — prepares Cubism assets and builds the TypeScript project graph.
- `pnpm db:migrate` — applies PostgreSQL migrations.
- `pnpm db:reset:dev` — guarded destructive reset of development volumes.

## Windows

Windows is a supported compatibility and packaging platform, not the primary development authority.

PowerShell helpers remain available:

```powershell
.\scripts\dev.ps1
.\scripts\health.ps1
.\scripts\stop.ps1
```

Do not infer Linux runtime requirements from Windows packaging machinery. Platform-specific process ownership, installer provisioning, bundled PostgreSQL, ACL/Credential Manager integration, and similar concerns belong to the Windows packaging layer.

See [docs/windows-development.md](docs/windows-development.md) for Windows-specific details.

## Documentation

- [Developer Quickstart](docs/quickstart.md)
- [Architecture](docs/architecture.md)
- [P4 Linux-first persistence baseline](docs/p4-linux-first.md)
- [Memory](docs/memory.md)
- [Providers](docs/providers.md)
- [Testing](docs/testing.md)
- [Dashboard](docs/dashboard.md)
- [Future companion roadmap](docs/future/README.md)

Secrets belong only in local configuration such as `.env` / `.env.local` or another secure configuration source. Do not commit or print API keys, authorization headers, tokens, passwords, or database credentials beyond development placeholders.