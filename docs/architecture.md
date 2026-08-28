# Architecture

[English](architecture.md) | [简体中文](architecture.zh-CN.md)

## Project Goal

YUVI Runtime is a local-first, event-driven AI companion runtime. It is an original implementation inspired by the architectural ambition of Project AIRI.

The product is the runtime, not a single chat UI. Web, desktop, avatar, terminal, voice, vision, and future character surfaces should converge on the same Runtime authority instead of implementing parallel product logic.

## Current Development Baseline

YUVI is Linux-first for development and production validation.

The currently proven durable path is:

```text
Linux Runtime
  -> repository ports
  -> DATABASE_URL
  -> PostgreSQL + pgvector
  -> migrations
  -> durable conversation / finalized-ingestion / Memory behavior
```

Windows remains a supported target, but platform-specific packaged PostgreSQL ownership machinery is deferred until product behavior is stable. Architecture decisions should optimize for correct Runtime semantics first and translate to Windows later rather than expanding a second persistence ownership model.

## Core Principles

### Runtime is execution authority

Runtime owns:

- effect lifecycle
- execution admission
- cancellation and stale-result fencing
- conversation persistence coordination
- finalized-turn handling
- provider execution
- canonical runtime publication

Transport, Dashboard, Presentation, and future Character layers do not bypass this authority.

### Reliability semantics are preserved assets

Already-proven semantics such as finalized-turn lifecycle, durable ingestion, semantic idempotency, retry/reconcile, crash recovery, lifecycle sealing/draining, and protection from ambiguous external side effects are architectural assets. Structural refactors must preserve them.

### Memory is evidence, not authoritative persona state

Conversation persistence and long-term Memory are separate concerns.

Memory owns evidence records and their retrieval/ranking/validity/status/retention/expiry semantics. It does not own authoritative relationship truth or future P8 persona state. Future consumers may interpret authorized evidence, but they must not rewrite Memory into hidden relationship authority.

### Providers are replaceable

`packages/core` depends on provider-facing contracts rather than vendor SDKs. Vendor request/response translation and concrete client construction belong to `packages/providers`.

### Small semantic diffs beat premature abstraction

When a broad abstraction conflicts with a smaller behavior-preserving extraction, prefer the smaller semantic diff. Avoid Manager/Engine/Service layers that merely rename existing responsibility without proving a necessary boundary.

## Main Data Flow

Normal user turn:

```text
User input
  -> Runtime admission
  -> conversation persistence
  -> DirectContext / Memory retrieval
  -> prompt construction
  -> provider execution
  -> assistant persistence
  -> finalized-turn handling
  -> runtime publication
  -> optional presentation side effects
```

Voice and vision enter Runtime through provider-normalized inputs rather than separate product architectures:

```text
Audio input
  -> STT provider
  -> transcript / runtime input
  -> normal Runtime flow

Image or screen input
  -> vision provider
  -> normalized perception/context
  -> Runtime flow
```

Current assistant-initiated P6 text flow:

```text
ProactiveDecisionProvider
  -> NO_OP
     or
  -> REQUEST_TEXT
  -> assistant continuation
  -> Runtime execution commit
  -> assistant-only proactive Runtime stream
```

P6 preserves strict user-over-proactive priority, one-shot execution, fresh Runtime identities, cancellation fencing, no synthetic user event, no proactive Memory-write authority, and no separate proactive TTS/voice authority.

## Package Responsibilities

### `apps/server`

Fastify HTTP/WebSocket server and composition root. Owns transport, startup/shutdown, health/configuration wiring, and construction/injection of concrete repositories/providers. Route handlers should remain thin and delegate product semantics to Runtime/package boundaries.

### `apps/web`

Development Dashboard. It observes and controls Runtime behavior through supported APIs. It is not the product authority for conversation, identity, Memory, or proactive semantics.

### `packages/protocol`

Shared runtime event types and schemas. Canonical event semantics live here rather than being inferred independently by each transport or UI.

### `packages/event-bus`

Event-bus abstraction and current in-memory implementation. NATS may remain supporting/future infrastructure behind the same boundary; it is not a reason to split Runtime into microservices prematurely.

### `packages/memory`

Owns conversation repositories, durable Memory repositories/services, finalized-ingestion ledger/service, retrieval/ranking, and Memory maintenance semantics.

Important boundaries:

- raw conversation messages are not long-term Memory
- PostgreSQL supports durable recovery across process restart
- in-memory repositories are development/test fallbacks
- finalized ingestion preserves durable parent/child status and idempotency semantics
- Core consumes repository/service ports; Server wires concrete implementations

### `packages/prompt-builder`

Builds provider-neutral prompt/context structures from authorized inputs. It does not own Runtime execution, Memory persistence, or future persona/relationship authority.

### `packages/config`

Typed runtime configuration, env parsing/validation, provider selection configuration, and redaction helpers. It does not instantiate product semantics.

### `packages/providers`

Provider contracts, registry/factories, normalized errors, and vendor adapters. Current provider families include chat/reasoning, proactive decision/continuation, TTS, STT, vision, and embedding.

### `packages/core`

Owns Runtime contracts/errors and RuntimeOrchestrator execution semantics. It coordinates persistence, context retrieval, prompt construction, provider calls, cancellation, finalized-turn behavior, and runtime publication.

The package root is a public barrel; implementation modules should not become accidental second public APIs merely for test convenience.

## Runtime Contracts and Errors

Canonical Runtime contract types and errors have dedicated module seams. Consumers should preserve identity of canonical errors rather than duplicate equivalent classes.

Examples include persistence failures and assistant-turn idempotency conflicts. Server handlers may depend on `instanceof` behavior, so duplicate error definitions are not semantically equivalent.

## Persistence and Finalized Turns

The durable Runtime path protects the distinction between a successfully produced assistant reply and later optional Memory ingestion side effects.

Finalized-turn ingestion supports durable states including processing, retryable failure, reconcile-required, partial, complete, terminal failure, and skipped outcomes where applicable. Re-entry must preserve durable status instead of fabricating completion from process-local state.

Lifecycle transitions preserve admitted work across sealing/disposal. Shutdown/reload behavior waits for already-admitted operations where required and rejects new lifecycle-sensitive work once sealing has begun.

## Provider Mapping

Current default direction:

- Chat: DeepSeek
- Reasoning: DeepSeek
- TTS: xAI
- STT: Alibaba Cloud DashScope
- Vision: xAI
- Embedding: configurable

Provider failures are normalized at provider boundaries. Optional post-processing failures must not retroactively invalidate an already finalized successful reply unless the relevant Runtime contract explicitly requires failure.

## Structural Status

The large Runtime implementation has already been extracted from `packages/core/src/index.ts` into focused implementation seams. Runtime tests are being decomposed by semantic island without changing behavior:

- streaming/reply
- finalized persistence / P4
- Memory integration
- proactive / P6

R5A1 through R5A3 are complete. R5A4 and final structural closeout remain before product development resumes.

This decomposition is intentionally mechanical: duplicate small test helpers are acceptable; changing assertions, state shape, Runtime APIs, provider semantics, or production behavior is not.

## Future Boundary

Future companion work begins after structural closeout. The planned sequence starts with P8 identity/persona/relationship, then temporal/continuity/attention, Character/Cognition boundaries, capabilities, embodied presentation, and Character post-training.

Those documents are planning authority only and do not imply implementation. See [`future/README.md`](future/README.md).
