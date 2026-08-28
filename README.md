# YUVI Runtime

[English](README.md) | [简体中文](README.zh-CN.md)

YUVI Runtime is a local-first, event-driven AI companion runtime. The repository is an original implementation inspired by the architectural ambition of Project AIRI, but it does not copy AIRI code.

The product goal is not a chatbot page. YUVI is being built as a durable companion runtime that can support conversation, memory, proactive behavior, provider-backed cognition, voice/vision, avatar presentation, and later identity/relationship/continuity systems behind stable runtime boundaries.

## Current Status

YUVI is currently in a structural-debt paydown phase after the P4 reliability work and the first useful P6 proactive-text implementation.

Already established:

- Runtime orchestration is separated from the package barrel and canonical runtime contracts/errors have dedicated seams.
- Conversation persistence and finalized-turn ingestion preserve durable lifecycle, idempotency, retry/reconcile, crash-recovery, and fail-closed semantics.
- P6 proactive text supports assistant-only turns, strict `NO_OP` / `REQUEST_TEXT` control, cancellation fencing, one-shot idempotency, fresh effect identities, and no synthetic user message or proactive memory-write authority.
- Dashboard presentation, Settings, Chat, and large Core runtime responsibilities have been decomposed without redesigning behavior.
- Core Runtime tests are being split mechanically by semantic island. R5A1, R5A2, and R5A3 are complete; R5A4 and final structural closeout remain before product work resumes.

After structural closeout, the next product phase is P8: explicit identity/persona/relationship behavior grounded in evidence rather than inferred as hidden authoritative state. The broader companion roadmap is documented under [`docs/future/`](docs/future/).

## Development Baseline

YUVI is **Linux-first** for development and production validation.

Primary development assumptions:

- Linux host
- Node.js + pnpm
- Docker Engine / Docker Compose for development PostgreSQL and supporting infrastructure
- PostgreSQL + pgvector as the durable persistence path currently validated in production-like runtime tests

Windows remains a supported translation/packaging target, but Windows-specific packaged PostgreSQL ownership machinery is intentionally deferred until product behavior is stable. Do not expand platform-specific infrastructure at the expense of Runtime semantics.

Quick start on Linux:

```bash
pnpm install
cp .env.example .env
./scripts/dev.sh
```

Development URLs:

- Server: `http://localhost:6121`
- Web UI: `http://localhost:5173`
- WebSocket: `ws://localhost:6121/ws`

Health and shutdown:

```bash
./scripts/health.sh
./scripts/stop.sh
```

Windows development scripts remain available where useful:

```powershell
.\scripts\dev.ps1
.\scripts\health.ps1
.\scripts\stop.ps1
```

See [`docs/quickstart.md`](docs/quickstart.md) and [`docs/windows-development.md`](docs/windows-development.md) for platform-specific setup details.

## Repository Structure

- `apps/server`: Fastify HTTP/WebSocket runtime server and composition root.
- `apps/web`: development dashboard for observing and controlling Runtime behavior.
- `packages/protocol`: runtime event types and schemas.
- `packages/event-bus`: event-bus abstraction and in-memory implementation.
- `packages/memory`: conversation persistence, durable memory, finalized-ingestion ledger, retrieval, and maintenance boundaries.
- `packages/prompt-builder`: provider-neutral prompt assembly.
- `packages/providers`: provider interfaces, registry, normalized errors, and vendor adapters.
- `packages/core`: Runtime contracts, errors, orchestration, and behavioral integration.
- `packages/config`: typed runtime configuration and redaction boundary.
- `docs/future`: planned post-structural companion architecture, beginning with P8.

## Runtime Principles

### Runtime owns execution

Runtime owns effect lifecycle, execution admission, cancellation, persistence coordination, provider execution, and canonical publication. Presentation layers and future character systems must not bypass it.

### Memory is evidence, not hidden persona truth

Conversation persistence and long-term memory are distinct. Memory owns evidence record storage, eligibility, ranking, validity/status, retention, and expiry. Future P8 logic may interpret authorized evidence, but Memory itself is not authoritative relationship/persona state.

### Providers are replaceable

`packages/core` depends on provider-facing contracts, not vendor SDKs. Vendor request/response translation belongs in `packages/providers`.

### Reliability semantics are assets

Structural work must preserve already-proven guarantees such as finalized-turn lifecycle, durable ingestion, semantic idempotency, retry/reconcile behavior, crash recovery, cancellation fencing, and protection from ambiguous external side effects.

### Prefer smaller semantic diffs

When a cleaner abstraction conflicts with a smaller behavior-preserving change, prefer the smaller semantic diff. Structural cleanup must not quietly become product redesign.

## Main Runtime Flows

Normal user turn:

```text
User input
  -> Runtime admission / persistence
  -> context + Memory retrieval
  -> prompt construction
  -> provider execution
  -> assistant persistence / finalized-turn handling
  -> runtime publication
  -> optional presentation side effects
```

Current P6 assistant-initiated text turn:

```text
ProactiveDecisionProvider
  -> NO_OP
     or
  -> REQUEST_TEXT
  -> assistant continuation
  -> Runtime execution commit
  -> assistant-only proactive stream
```

The proactive path does not synthesize a user message, does not gain memory-write authority, and does not gain separate TTS/voice authority.

## Provider Mapping

The current default provider direction is:

- Chat: DeepSeek
- Reasoning: DeepSeek
- TTS: xAI
- STT: Alibaba Cloud DashScope
- Vision: xAI
- Embedding: configurable OpenAI-compatible / provider chain

Provider routing is configurable and fallback-aware. `packages/core` must not import concrete DeepSeek, xAI, or Alibaba clients directly.

Example configuration:

```env
CHAT_PROVIDER_CHAIN=deepseek,nvidia,local,mock
REASONING_PROVIDER_CHAIN=deepseek,nvidia,local,mock
EMBEDDING_PROVIDER_CHAIN=openai-compatible,nvidia,local,mock
TTS_PROVIDER_CHAIN=xai,local,mock
STT_PROVIDER_CHAIN=dashscope,local,mock
VISION_PROVIDER_CHAIN=xai,nvidia,local,mock
```

Secrets belong only in local environment/configuration sources and must not be committed or emitted into logs, events, or error payloads.

## Persistence

Development can run with in-memory persistence, but durable validation uses PostgreSQL:

```env
MEMORY_REPOSITORY=postgres
DATABASE_URL=postgres://yuvi:yuvi_dev_password@localhost:5432/yuvi
```

Start development infrastructure and apply migrations:

```bash
docker compose -f infra/docker-compose.yml up -d
pnpm db:migrate
pnpm smoke:postgres
```

PostgreSQL currently carries the proven durable Runtime path. Redis and NATS remain supporting/future infrastructure rather than reasons to split the Runtime into heavy microservices.

## Common Commands

```bash
pnpm install
pnpm check
pnpm test
pnpm build
pnpm db:migrate
pnpm smoke
pnpm smoke:postgres
pnpm memory:index:status
pnpm memory:maintenance
```

Useful scripts:

- `./scripts/dev.sh`: primary Linux development entry point.
- `./scripts/health.sh`: development health/status checks.
- `./scripts/stop.sh`: stop local development services.
- `pnpm db:migrate`: apply PostgreSQL memory migrations.
- `pnpm db:reset:dev`: guarded development database reset.
- `pnpm memory:embed:backfill`: backfill embeddings for existing PostgreSQL memories.
- `pnpm memory:index:status`: inspect pgvector/ANN index status.
- `pnpm memory:maintenance`: audit expiry/staleness/supersession maintenance state.

## Roadmap Boundary

The implementation roadmap is intentionally staged.

Current order:

```text
R5A4 proactive test-island extraction
  -> structural final closeout
  -> P8 identity / persona / relationship
  -> temporal substrate
  -> continuity and attention
  -> Character ABI / Character Harness
  -> Cognition and capabilities
  -> embodied presentation / agency
  -> Character post-training
```

Future documents are planning authority only; they do not imply those systems are implemented. See [`docs/future/README.md`](docs/future/README.md).
