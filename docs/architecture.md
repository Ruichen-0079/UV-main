# Architecture

[English](architecture.md) | [简体中文](architecture.zh-CN.md)

## Project Goal

YUVI Runtime is a local-first, event-driven AI companion runtime.

The runtime is the product core. Web, desktop, Live2D/VRM presentation, voice surfaces, game integrations, and future character models should consume the same runtime semantics rather than each owning their own conversation, memory, or execution logic.

The repository is an original implementation. It is intentionally organized around small semantic boundaries instead of a large assistant framework.

## Current Platform Baseline

YUVI is **Linux-first** for active development and production validation.

Primary development and reliability validation use native Linux, Node.js, pnpm, Bash lifecycle scripts, and PostgreSQL when durable state is required.

Windows remains a supported compatibility and packaging platform, but Windows-specific process ownership, installer provisioning, bundled PostgreSQL, ACL/Credential Manager integration, and similar packaging concerns are not Runtime correctness requirements.

For P4 persistence, the primary durable boundary is:

```text
Runtime / Memory
  -> repository ports
  -> DATABASE_URL
  -> PostgreSQL
  -> YUVI migrations
```

PostgreSQL may be external, system-managed, or container-managed. Runtime Core does not need to own the database process.

See [p4-linux-first.md](p4-linux-first.md).

## Core Principles

### Runtime owns execution semantics

`packages/core` owns Runtime orchestration: admission, lifecycle, provider execution, cancellation fencing, persistence ordering, finalized-turn coordination, and authoritative runtime event publication.

It should not become a vendor SDK layer, an operating-system supervisor, or a presentation engine.

### Persistence is separate from presentation

Raw conversation persistence, semantic long-term memory, and visible presentation are different responsibilities.

A successful assistant effect must obey the persistence and lifecycle semantics required by its path before presentation treats it as authoritative.

### Memory is evidence, not raw chat history

`packages/memory` owns durable memory records, retrieval/ranking, memory validity/status, conversation repositories, finalized-ingestion persistence, and PostgreSQL migrations.

Raw conversation messages are not automatically long-term semantic memory.

### Providers are replaceable

Vendor-specific network and response handling belongs in `packages/providers`.

Runtime Core consumes provider-neutral contracts. It should not directly import DeepSeek, xAI, Alibaba/DashScope, or other vendor client classes.

### Presentation reports outcomes; it does not own Runtime truth

Web, desktop, speech, avatar, gaze, and future embodied behavior render or report an already-admitted effect. They do not become an independent authority for persistence, relationship state, or capability admission.

## Main Runtime Flow

A normal user turn is conceptually:

```text
User input
  -> Runtime admission
  -> conversation persistence
  -> Direct Context + Memory retrieval
  -> PromptBuilder
  -> provider execution
  -> assistant persistence/finalization
  -> runtime events
  -> optional presentation effects
```

Optional TTS, avatar rendering, and similar presentation work must not retroactively invalidate an assistant reply that is already finalized according to the current Runtime contract.

## Current Proactive P6 Boundary

The current proactive path is deliberately narrow.

`ProactiveDecisionProvider` owns the current proactive text decision contract:

```text
NO_OP | REQUEST_TEXT
```

- `NO_OP` produces no assistant text effect.
- `REQUEST_TEXT` may continue to assistant-only text generation.
- Assistant-initiated continuation does not synthesize a user event or user conversation row.
- Proactive output does not gain semantic Memory-write authority merely because it was generated.
- Active/retained idempotency claims prevent unsafe replay.
- Cancellation and stale asynchronous results are fenced before publication/persistence.

Future generalized character/continuity agency must replace this authority atomically if that boundary changes; current Runtime must not run two competing proactive decision owners for the same effect.

## Package Responsibilities

### `apps/server`

Fastify composition root and HTTP/WebSocket transport. Owns process startup/shutdown, route wiring, configuration composition, health surfaces, and dependency construction. Route handlers should stay thin.

### `apps/web`

Developer dashboard and current companion presentation surface. It consumes Runtime/server contracts and should not duplicate Runtime semantics in UI state.

### `apps/desktop`

Tauri desktop shell and platform packaging integration. Desktop packaging concerns must remain downstream of product behavior and Runtime correctness.

### `packages/core`

Runtime orchestration and semantic execution boundary.

Responsibilities include:

- user and assistant turn orchestration;
- provider execution through interfaces;
- cancellation and lifecycle fencing;
- conversation/persistence ordering;
- finalized-turn memory ingestion coordination;
- proactive assistant-only Runtime execution;
- authoritative runtime event publication.

### `packages/memory`

Persistence and memory authority.

Responsibilities include:

- Conversation Repository implementations;
- long-term memory records and retrieval;
- memory provider/backend boundaries;
- finalized-ingestion durable parent/child state;
- retry/reconcile persistence primitives;
- PostgreSQL repositories and migrations;
- memory expiry/validity/status semantics.

### `packages/prompt-builder`

Constructs structured provider-neutral prompt context from inputs already authorized by upstream owners.

It does not own persistence, relationship truth, provider routing, or execution lifecycle.

### `packages/providers`

Provider interfaces, registry/routing, vendor adapters, normalized provider errors, and provider-specific transport behavior.

### `packages/protocol`

Shared Runtime event contracts and schemas.

### `packages/event-bus`

Runtime event-bus abstraction. The current implemented runtime mode is in-memory; future transport implementations must preserve event semantics rather than redefining them.

### `packages/config`

Typed configuration parsing, selection boundaries, validation, and secret-redaction helpers.

### `packages/desktop-supervisor`

Desktop/platform supervision and packaging substrate. It must not become a required dependency for Linux Runtime persistence correctness.

## Reliability Baseline

The following are retained reliability assets, not refactor targets:

- finalized-turn lifecycle and sealing/draining;
- durable finalized-ingestion ledger;
- semantic idempotency;
- crash/restart recovery;
- retry and exact reconciliation behavior;
- protection against ambiguous external side effects;
- correct fail-closed persistence/memory boundaries;
- cancellation and stale-effect fencing.

Structural refactors may move code or tests, but they must not weaken these semantics.

## Development Infrastructure

`infra/docker-compose.yml` provides development services such as PostgreSQL + pgvector, Redis, and NATS.

These services are development infrastructure, not evidence that the final product must be distributed as a containerized microservice stack.

PostgreSQL is currently the primary durable persistence implementation. Redis/NATS or future event infrastructure should remain behind explicit interfaces and should not be introduced merely to increase architectural abstraction.

## Future Architecture

The post-structural companion roadmap is documented under [future/README.md](future/README.md).

It separates future responsibilities including:

- P8 identity/persona/relationship interpretation;
- temporal substrate;
- continuity and attention;
- Character Model behavior;
- Cognition for complex reliable reasoning;
- a thin Character Harness;
- capability/MCP boundaries;
- embodied presentation;
- Character post-training.

Those documents define planned contracts. They are not permission to pre-implement new managers, engines, generic agent graphs, or duplicate authority before the corresponding product phase begins.

## Non-Goals

- No heavy microservice split for its own sake.
- No second owner for an existing semantic decision.
- No platform-packaging machinery in Runtime Core.
- No raw provider SDK coupling in Core.
- No treating raw chat logs as authoritative long-term memory.
- No random avatar motion presented as autonomous agency.
- No broad framework abstractions where a narrow domain seam is sufficient.

The architecture should remain explicit, testable, reversible, and small enough that product behavior—not infrastructure—drives the next design step.