# Developer Quickstart

This is the Linux-first development path. Windows PowerShell compatibility is documented separately in [Windows development](windows-development.md). WSL is supported but not required, and no GPU is required.

## Prerequisites

- Node.js 22 or newer;
- pnpm 9.15.4, as declared by the repository;
- a shell that can run the repository scripts;
- Docker Engine or Docker Desktop only when you choose the Compose development infrastructure.

PostgreSQL is not required for the in-memory path. Durable mode requires an external, system-managed, or separately managed container PostgreSQL reachable through `DATABASE_URL`; YUVI does not own the PostgreSQL OS process on Linux.

## 1. Install and configure

From the repository root:

```bash
pnpm install
cp .env.example .env
```

Keep credentials and local overrides in untracked `.env` and `.env.local` files. Runtime configuration is loaded from root `.env`, the process environment, then root `.env.local`; later sources override earlier ones. The development scripts load these files without printing secret values.

The checked-in example is real-provider-first. Configure the generic OpenAI-compatible Chat route and the DeepSeek Reasoning route when you want remote calls:

```env
DEFAULT_CHAT_PROVIDER=openai-compatible
OPENAI_COMPATIBLE_API_BASEURL=https://api.deepinfra.com/v1/openai
OPENAI_COMPATIBLE_API_KEY=replace-with-your-key
OPENAI_COMPATIBLE_CHAT_MODEL=replace-with-your-model

DEFAULT_REASONING_PROVIDER=deepseek
DEEPSEEK_API_KEY=replace-with-your-key
DEEPSEEK_REASONING_MODEL=replace-with-your-model
```

For intentional offline development, opt into mocks explicitly:

```env
PROVIDER_ALLOW_MOCKS=true
DEFAULT_CHAT_PROVIDER=mock
CHAT_PROVIDER_CHAIN=mock
DEFAULT_EMBEDDING_PROVIDER=mock
EMBEDDING_PROVIDER_CHAIN=mock
EMBEDDING_PROVIDER=mock
```

Mock output validates the runtime path; it is not semantic provider behavior and should not be mistaken for a live remote verification.

The current defaults also include `MEMORY_REPOSITORY=in-memory`, `CONVERSATION_REPOSITORY=in-memory`, `EVENT_BUS=in-memory`, and bounded Direct Context. `EVENT_BUS=nats` is reserved and fails clearly because NATS is not implemented.

## 2. Start the runtime

The primary entrypoint is:

```bash
./scripts/dev.sh
```

By default this starts the convenient development services from `infra/docker-compose.yml`, then the server and Web UI. Compose is only an infrastructure provider for development; it is not the product-owned PostgreSQL architecture.

For in-memory development without starting Docker infrastructure:

```bash
SKIP_INFRA=1 ./scripts/dev.sh
```

The script uses loopback defaults:

- Web UI: `http://localhost:5173`
- Server: `http://localhost:6121`
- WebSocket: `ws://localhost:6121/ws`

Use `./scripts/health.sh` to inspect local services and `./scripts/stop.sh` to stop the processes and any Compose services started by the script.

## 3. Enable durable PostgreSQL mode when needed

Use PostgreSQL when you need conversation recovery and durable memory. Set both repository selectors and a real connection string:

```env
MEMORY_REPOSITORY=postgres
CONVERSATION_REPOSITORY=postgres
DATABASE_URL=postgres://user:password@host:5432/database
```

The `DATABASE_URL` is mandatory for `MEMORY_REPOSITORY=postgres`. Apply migrations before starting or validating durable mode:

```bash
pnpm db:migrate
./scripts/dev.sh
```

If your PostgreSQL is supplied by the repository’s local Compose file, start that infrastructure first or omit `SKIP_INFRA` from `dev.sh`. If it is system-managed or supplied by another container, use `SKIP_INFRA=1` and point `DATABASE_URL` at that service. In all cases, YUVI connects through `DATABASE_URL`; it does not start, stop, adopt, or kill the database process on Linux.

PostgreSQL mode separates raw conversation persistence from long-term memory. Memory retrieval can combine exact keyword/trigram/full-text matches with optional vector retrieval. ANN indexing is an optional acceleration; it does not replace exact technical matching.

## 4. Exercise the API

Check local service health:

```bash
curl http://127.0.0.1:6121/health
```

Send a normal message:

```bash
curl -X POST http://127.0.0.1:6121/v1/messages \
  -H 'content-type: application/json' \
  -d '{"sessionId":"dev","content":"Hello YUVI","options":{"readMemory":true,"writeMemory":false}}'
```

The compatibility endpoint `POST /message` remains available. Streaming clients should use `POST /v1/messages/stream` and consume its `text/event-stream` response.

Create and search an explicit memory record:

```bash
curl -X POST http://127.0.0.1:6121/memory \
  -H 'content-type: application/json' \
  -d '{"type":"semantic","content":"The developer is testing YUVI.","source":"quickstart"}'

curl -G http://127.0.0.1:6121/memory/search \
  --data-urlencode 'q=developer' \
  --data-urlencode 'limit=5'
```

Voice, Vision, provider diagnostics, settings, events, prompt preview, and Live2D resource routes are also available for development. See [Architecture](architecture.md) and [Providers](providers.md) for the current boundaries.

## 5. Validate changes

Run the repository checks from the root:

```bash
pnpm check
pnpm test
pnpm build
git diff --check
```

`pnpm smoke` is an explicit mock/in-memory runtime smoke. `pnpm smoke:postgres` is the PostgreSQL-backed smoke and requires a reachable migrated PostgreSQL service. Do not change product source or configuration merely to make a documentation validation run pass.
