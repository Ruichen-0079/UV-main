# YUVI Runtime

[English](README.md) | [简体中文](README.zh-CN.md)

YUVI Runtime is a local-first, event-driven AI Companion Runtime inspired by Project AIRI architecture goals, without copying AIRI code.

This repository starts as a small runnable TypeScript monorepo:

- `apps/server`: Fastify HTTP and WebSocket runtime server.
- `packages/protocol`: event types and schemas.
- `packages/event-bus`: event bus abstraction and in-memory implementation.
- `packages/memory`: memory repository/service interfaces and MVP in-memory implementation.
- `packages/prompt-builder`: dynamic prompt assembly.
- `packages/providers`: provider interfaces, registry, normalized errors, and local echo provider for development.
- `packages/core`: runtime orchestrator and agent loop boundary.

## Getting Started

The recommended development environment is Windows LTSC + WSL2 Ubuntu with Docker Engine running inside WSL.

```bash
pnpm install
cp .env.example .env
./scripts/dev.sh
```

Development URLs:

- Server: `http://localhost:6121`
- Web UI: `http://localhost:5173`
- WebSocket: `ws://localhost:6121/ws`

On Windows LTSC, use the wrapper from the repository root:

```cmd
scripts\start-dev.cmd
```

Check and stop the WSL development services:

```bash
./scripts/health.sh
./scripts/stop.sh
```

## Scripts

- `./scripts/dev.sh`: WSL/Linux development entry point. Loads `.env`, starts Docker infra, starts the server, and starts the web dashboard when present.
- `./scripts/health.sh`: check Docker Compose status plus server and web health when started by `dev.sh`.
- `./scripts/stop.sh`: stop development processes and Docker Compose services.
- `scripts\start-dev.cmd`: Windows LTSC convenience wrapper that calls WSL Ubuntu.
- `pnpm dev`: run only the Fastify server in development mode.
- `pnpm build`: build all workspace packages.
- `pnpm check`: type-check all workspace packages.
- `pnpm test`: run package tests where present.
- `pnpm smoke`: build the repo and verify the runtime health, message, and memory endpoints in mock/in-memory mode.
- `pnpm db:migrate`: apply PostgreSQL memory migrations using `DATABASE_URL` from `.env` or the current environment.
- `pnpm db:reset:dev`: interactively delete development Docker volumes after a strong confirmation prompt.
- `pnpm smoke:postgres`: apply migrations against the development Postgres container, then run the smoke test in `MEMORY_REPOSITORY=postgres` mode.

## Infrastructure

```bash
docker compose -f infra/docker-compose.yml up -d
```

This starts PostgreSQL with pgvector, Redis, and NATS for future event bus work.

Development memory defaults to in-memory storage:

```env
MEMORY_REPOSITORY=in-memory
```

To switch memory to PostgreSQL, set:

```env
MEMORY_REPOSITORY=postgres
DATABASE_URL=postgres://yuvi:yuvi_dev_password@localhost:5432/yuvi
```

Then start infra and apply the migrations in `packages/memory/migrations` before using memory endpoints. `.env` is local sensitive state and must not be committed or printed.

```bash
pnpm db:migrate
```

To verify Postgres memory mode against the development container:

```bash
docker compose -f infra/docker-compose.yml up -d
pnpm db:migrate
pnpm smoke:postgres
```

To reset development database volumes, prefer the guarded helper:

```bash
pnpm db:reset:dev
```

This asks for an exact confirmation phrase and then deletes development database data.

Advanced/manual reset:

```bash
docker compose -f infra/docker-compose.yml down -v
```

If an old Docker volume was initialized with earlier `airi` or `companion` credentials, changing `infra/docker-compose.yml` will not update that existing volume. Run `pnpm db:reset:dev`, then `docker compose -f infra/docker-compose.yml up -d`, `pnpm db:migrate`, and `pnpm smoke:postgres` to recreate fresh development data with `yuvi / yuvi_dev_password / yuvi`.
