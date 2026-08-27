# YUVI Runtime

[English](README.md) | [简体中文](README.zh-CN.md)

YUVI is a local-first, event-driven AI companion runtime. The current product is a runnable TypeScript monorepo with a Fastify runtime server, a Web Companion/Dashboard surface, memory and conversation boundaries, replaceable provider chains, and a Tauri desktop shell under active packaging work.

Current implemented capability groups include:

- normal user turns with streaming or non-streaming text replies;
- short-term Direct Context, configurable memory retrieval, legacy and Mem0 memory backends, and PostgreSQL-backed durable conversation/memory paths;
- P4 finalized-turn ingestion durability, idempotent delivery, retry/reconcile, crash recovery, and fail-closed persistence boundaries;
- P6 assistant-initiated proactive text turns with an exact `NO_OP` / `REQUEST_TEXT` decision boundary;
- P7 provider readiness/observation diagnostics, settings truth and reload behavior, plus Voice and Vision developer routes;
- Web Companion presentation with Lumi Live2D/Cubism rendering, speech playback, and capability-gated presence behavior.

Linux is the primary development and production-validation platform. Windows development compatibility remains available, but Windows packaged-private-PostgreSQL ownership and installer integration are deferred packaging work.

## Quick start

```bash
pnpm install
cp .env.example .env
./scripts/dev.sh
```

The script loads root `.env` and `.env.local`, starts the optional development infrastructure, applies PostgreSQL migrations when durable mode is selected, and starts the server and Web UI. For a lightweight in-memory run, use `SKIP_INFRA=1 ./scripts/dev.sh`. Configure a real chat provider, or explicitly enable mock mode for offline development. Durable mode requires an external, system-managed, or separately managed container PostgreSQL and a `DATABASE_URL`; run `pnpm db:migrate` before using it.

Open `http://localhost:5173`. The server listens on `http://localhost:6121` and exposes WebSocket transport at `ws://localhost:6121/ws`.

Windows users should start with [Windows development compatibility](docs/windows-development.md). WSL is not required by the product documentation; it is only one supported development environment.

## Documentation

- [Current state](docs/current-state.md) — the status authority for current, validated, experimental, planned, deferred, and historical work.
- [Architecture](docs/architecture.md)
- [Developer quickstart](docs/quickstart.md)
- [P4 Linux-first persistence baseline](docs/p4-linux-first.md)
- [Memory](docs/memory.md)
- [Providers](docs/providers.md)
- [Testing](docs/testing.md)

Use the matching [Chinese documentation](README.zh-CN.md) when preferred. Chinese terminology is defined in [docs/terminology.zh-CN.md](docs/terminology.zh-CN.md).

## Validation

```bash
pnpm check
pnpm test
pnpm build
git diff --check
```

Provider credentials, local model services, database URLs, and dashboard tokens belong in untracked local configuration. Do not commit or print them.
