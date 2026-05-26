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

- `./scripts/dev.sh`: WSL/Linux development entry point. Sets `YUVI_RUNTIME_ENV_DIR` to the repo root, loads `.env` plus `.env.local`, starts Docker infra, optionally auto-runs `pnpm db:migrate` for PostgreSQL memory, starts the server, and starts the web dashboard when present.
- `./scripts/health.sh`: check Docker Compose status plus server and web health when started by `dev.sh`.
- `./scripts/stop.sh`: stop development processes and Docker Compose services.
- `scripts\start-dev.cmd`: Windows LTSC convenience wrapper that calls WSL Ubuntu.
- `pnpm dev`: run only the Fastify server in development mode. The server resolves runtime env files from `YUVI_RUNTIME_ENV_DIR` when set, otherwise it walks up to the workspace root and reads root `.env` plus `.env.local`.
- `pnpm build`: build all workspace packages.
- `pnpm check`: type-check all workspace packages.
- `pnpm test`: run package tests where present.
- `pnpm smoke`: build the repo and verify the runtime health, message, and memory endpoints in explicit mock/in-memory mode. Provider verification is the path for checking real remote APIs.
- `pnpm db:migrate`: apply PostgreSQL memory migrations using `DATABASE_URL` from `.env` or the current environment.
- `pnpm db:reset:dev`: interactively delete development Docker volumes after a strong confirmation prompt.
- `pnpm smoke:postgres`: apply migrations against the development Postgres container, then run the smoke test in `MEMORY_REPOSITORY=postgres` mode.
- `pnpm memory:embed:backfill`: embed existing PostgreSQL memories with the configured embedding provider. Use `pnpm memory:embed:backfill -- --dry-run` first, and `--force` when intentionally re-embedding existing vectors.
- `pnpm memory:index:status`: report safe pgvector/ANN index diagnostics.
- `pnpm memory:maintenance`: mark expired memories, report stale episodic memories, and audit supersession state without hard delete.

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

Embeddings are optional but recommended for semantic memory search. DashScope `text-embedding-v4` can be used through OpenAI-compatible mode:

```env
EMBEDDING_PROVIDER=openai-compatible
EMBEDDING_API_BASEURL=https://dashscope.aliyuncs.com/compatible-mode/v1
EMBEDDING_API_KEY=<DashScope API key>
EMBEDDING_MODEL=text-embedding-v4
EMBEDDING_DIMENSIONS=1536
```

Mock embeddings are non-semantic and should be used only for tests, CI, or intentional offline mode. Existing PostgreSQL memories need backfill after enabling a real embedding provider:

```bash
pnpm memory:embed:backfill -- --dry-run
pnpm memory:embed:backfill
pnpm memory:embed:backfill -- --force
```

Dashboard **Verify Embedding** is explicit and may consume provider usage. Keyword, trigram, and full-text retrieval remain important for env vars, commands, paths, ports, provider names, model names, error messages, and tags. ANN vector indexing is optional acceleration only:

```env
MEMORY_VECTOR_INDEX_ENABLED=true
MEMORY_VECTOR_INDEX_TYPE=hnsw
MEMORY_VECTOR_DISTANCE=cosine
```

If HNSW/IVFFLAT is unavailable, retrieval still works without ANN acceleration. Check status with `pnpm memory:index:status` or the Dashboard memory status panel.

Provider routing is priority-based. The default chain keeps DeepSeek first for chat/reasoning, then NVIDIA API, then a local OpenAI-compatible server, with mock only when explicitly enabled:

```env
CHAT_PROVIDER_CHAIN=deepseek,nvidia,local,mock
REASONING_PROVIDER_CHAIN=deepseek,nvidia,local,mock
EMBEDDING_PROVIDER_CHAIN=openai-compatible,nvidia,local,mock
TTS_PROVIDER_CHAIN=xai,local,mock
STT_PROVIDER_CHAIN=dashscope,local,mock
VISION_PROVIDER_CHAIN=xai,nvidia,local,mock
NVIDIA_API_BASEURL=https://integrate.api.nvidia.com/v1
LOCAL_MODEL_BASEURL=http://localhost:11434/v1
```

Fallback metadata is returned as safe attempted-provider summaries without API keys, Authorization headers, raw media, or database URLs. Developer media routes are available for STT, voice message, TTS, and vision:

- `POST /v1/audio/transcriptions`
- `POST /v1/voice/message`
- `POST /v1/tts`
- `POST /v1/vision/analyze`

These wire provider-chain fallback into the runtime, but do not implement speaker diarization, voiceprint enrollment, Tauri, or production voice/vision UX.

For development Deep Restart support from the Dashboard, run `./scripts/dev.sh` with:

```env
YUVI_DEV_SUPERVISOR=1
YUVI_AUTO_MIGRATE=1
```

The Dashboard Settings page distinguishes **Apply Now** from **Deep Restart**. Apply Now reloads supported runtime config in-process and does not run migrations. Deep Restart is dev-only, requires the dashboard token when configured, reloads root env files on restart, and runs `pnpm db:migrate` automatically only when PostgreSQL memory is active and `YUVI_AUTO_MIGRATE` is not `0`.

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
