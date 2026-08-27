# Developer Quickstart

[English](quickstart.md) | [简体中文](quickstart.zh-CN.md)

This is the primary Linux development path. Windows compatibility instructions are in [windows-development.md](windows-development.md).

## 1. Prerequisites

- Linux
- Node.js 22 or newer
- pnpm `9.15.4` (the repository-declared package manager)
- Docker Engine + Compose only when you want the repository development infrastructure

Check the toolchain:

```bash
node --version
pnpm --version
```

For container-backed development PostgreSQL, also check:

```bash
docker --version
docker compose version
```

## 2. Install and configure

From the repository root:

```bash
pnpm install
cp .env.example .env
```

Keep secrets in local `.env` / `.env.local`; never commit or print them. The Linux development script loads `.env` and then `.env.local`, with `.env.local` overriding duplicate keys.

The checked-in `.env.example` documents the currently supported provider, Memory, media, Live2D, and Runtime settings. Do not copy historical model or embedding assumptions from older docs when they disagree with current source/configuration.

## 3. Start YUVI

```bash
./scripts/dev.sh
```

The script installs dependencies when needed, loads root environment files, starts development infrastructure unless skipped, runs `pnpm db:migrate` automatically when PostgreSQL Memory is selected and auto-migration is enabled, then starts the server and Web UI.

Development endpoints:

```text
Runtime API: http://127.0.0.1:6121
Web UI:      http://127.0.0.1:5173
WebSocket:   ws://127.0.0.1:6121/ws
```

Check or stop the development services:

```bash
./scripts/health.sh
./scripts/stop.sh
```

For lightweight in-memory development without Docker infrastructure:

```bash
SKIP_INFRA=1 ./scripts/dev.sh
```

`SKIP_INFRA=1` is appropriate when your selected repositories and providers do not require the Compose services.

## 4. Durable PostgreSQL

The primary Linux durability boundary is a PostgreSQL database supplied externally to YUVI through `DATABASE_URL`. It may be a system service, a separately managed container, or another reachable PostgreSQL instance.

Set at least:

```env
MEMORY_REPOSITORY=postgres
DATABASE_URL=postgres://...
```

If you also want raw conversation recovery across process restarts, use the PostgreSQL conversation repository:

```env
CONVERSATION_REPOSITORY=postgres
```

Apply YUVI migrations before using durable mode:

```bash
pnpm db:migrate
```

Then start normally:

```bash
./scripts/dev.sh
```

YUVI owns its repository/migration correctness; it does not need operating-system ownership of the PostgreSQL process on Linux. See [p4-linux-first.md](p4-linux-first.md).

### Optional development Compose database

The repository Compose file is one convenient database provider:

```bash
docker compose -f infra/docker-compose.yml up -d postgres
pnpm db:migrate
```

It is development infrastructure, not the conceptual product-owned persistence architecture.

To run the repository PostgreSQL smoke path against the development container:

```bash
pnpm smoke:postgres
```

Only delete development volumes when you intentionally want to discard their data:

```bash
pnpm db:reset:dev
```

## 5. Providers and verification

Provider configuration/readiness and live provider observation are different things.

- `/health` and ordinary provider status inspection use local configuration/readiness plus cached observation; they do not perform a live provider probe.
- Explicit **Verify** actions may call the configured remote provider and may consume billable usage.
- Mock providers are for CI/tests or intentional offline development and require explicit mock configuration.

The current checked-in example uses configurable provider chains and a generic OpenAI-compatible remote Chat path. Keep provider credentials and model choices in local configuration rather than hardcoding them in application source.

## 6. Memory and embeddings

Long-term Memory and Direct Context are separate. Memory retrieval preserves `ok`, `empty`, `unavailable`, `error`, and `partial` rather than treating every failed retrieval as empty memory.

PostgreSQL retrieval combines exact/lexical signals (including trigram and full-text search) with optional vector retrieval. Embeddings augment those signals; embedding failure must leave lexical fallback usable.

Do not treat the locally validated Qwen 512-dimensional target as a production default. The Qwen MRL validation is measurement-only and 512-dimensional transformation is not implemented in production source. See [current-state.md](current-state.md#10-local-embedding-measurement).

## 7. Validation

For repository changes, use the declared pnpm version and the standard gates:

```bash
pnpm check
pnpm test
pnpm build
git diff --check
```

Linux persistence also has a dedicated CI workflow that provisions PostgreSQL + pgvector and exercises migrations plus PostgreSQL-backed Runtime behavior.

## 8. Windows compatibility

Native Windows PowerShell development remains available, but it is secondary to the Linux product-development/validation path. See [windows-development.md](windows-development.md). Windows packaged-private PostgreSQL ownership is deferred and is not required for Linux product work.