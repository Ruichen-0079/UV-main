# YUVI Runtime

[English](README.md) | [简体中文](README.zh-CN.md)

YUVI is a local-first AI companion Runtime. It combines an event-driven Runtime, durable conversation and memory boundaries, provider routing, media capabilities, Live2D companion presentation, and bounded assistant-initiated proactive behavior.

Linux is the primary development, product-development, and production-validation platform. Windows development remains supported for compatibility, while packaged/private PostgreSQL ownership and installer-specific database lifecycle work are deferred platform packaging concerns.

## Implemented today

- Fastify HTTP, SSE, and WebSocket Runtime APIs.
- Streaming user Chat with conversation persistence and finalized-turn ingestion reliability.
- Vendor-neutral semantic Memory evidence with Mem0/legacy adapters and lexical, trigram, full-text, and optional vector retrieval.
- Provider chains, fallback policy, diagnostics, runtime settings, explicit provider Verify, and cancellation boundaries.
- STT, TTS, Vision, and voice-message routes.
- Web/Dashboard surfaces plus a Live2D companion presentation surface with speech playback and presence/behavior projection.
- P6 assistant-initiated proactive text: bounded eligibility, explicit admission, `NO_OP | REQUEST_TEXT` decision, and at most one assistant-only continuation per admitted attempt.

P8 persona/relationship product semantics are **not implemented** as authoritative persistent state.

## Linux quick start

YUVI declares pnpm `9.15.4` in `package.json`.

```bash
pnpm install
cp .env.example .env
./scripts/dev.sh
```

Development URLs:

- Runtime API: `http://127.0.0.1:6121`
- Web UI: `http://127.0.0.1:5173`
- WebSocket: `ws://127.0.0.1:6121/ws`

For lightweight in-memory development without Docker infrastructure:

```bash
SKIP_INFRA=1 ./scripts/dev.sh
```

For durable PostgreSQL-backed development or validation, provide PostgreSQL through a system service, an externally managed service, or a container, then configure and migrate YUVI:

```env
MEMORY_REPOSITORY=postgres
DATABASE_URL=postgres://...
```

```bash
pnpm db:migrate
./scripts/dev.sh
```

`infra/docker-compose.yml` is a convenient development PostgreSQL provider; YUVI does not conceptually own the PostgreSQL process on Linux.

## Current documentation

- [Current state](docs/current-state.md) — concise factual product map and authority rules.
- [Architecture](docs/architecture.md) — current Runtime boundaries and turn flows.
- [Quickstart](docs/quickstart.md) — Linux-first setup and durable PostgreSQL path.
- [P4 Linux-first baseline](docs/p4-linux-first.md) — current persistence/reliability authority.
- [Memory](docs/memory.md) — subsystem details; current source and `current-state.md` take precedence where older phase text conflicts.
- [Providers](docs/providers.md) — provider contracts and diagnostics.
- [Testing](docs/testing.md) — test and CI guidance.
- [Windows development](docs/windows-development.md) — secondary compatibility workflow.

Historical PRs and phase plans are useful implementation history, not automatically current architecture.