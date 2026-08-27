# Architecture

[English](architecture.md) | [简体中文](architecture.zh-CN.md)

This document describes current YUVI boundaries. For a dated product snapshot and authority rules, see [current-state.md](current-state.md).

## Product boundary

YUVI is a local-first AI companion Runtime. The Runtime owns semantic turn orchestration; Web, Dashboard, Live2D, speech playback, and desktop surfaces are presentation or transport layers around that Runtime.

Linux is the primary development and production-validation platform. Windows compatibility remains supported, but Windows packaged-private PostgreSQL ownership is deferred platform packaging rather than the primary persistence architecture.

## Runtime shape

```text
Web / Companion presentation
        |
        v
Fastify API / SSE / WebSocket
        |
        v
RuntimeOrchestrator
  |- PromptBuilder
  |- ProviderRegistry / ProviderResolver
  |- conversation persistence
  |- semantic Memory boundary
  |- finalized-ingestion durability
  `- event bus
```

Important boundaries:

- `apps/server` owns HTTP/SSE/WebSocket transport, request validation, health/status projection, startup, and graceful shutdown.
- `packages/core` owns Runtime turn orchestration and lifecycle semantics.
- `packages/prompt-builder` assembles provider-neutral prompt sections.
- `packages/providers` owns provider interfaces, provider-chain routing, normalized failures, and vendor/gateway transports.
- `packages/memory` owns conversation/memory persistence contracts, semantic Memory evidence contracts, retrieval, and finalized-ingestion durability primitives.
- `packages/event-bus` is the event abstraction; the current Runtime implementation uses the in-memory bus.
- Web/Companion code owns presentation policy and execution surfaces. Presentation does not become semantic decision authority merely because it renders or schedules an opportunity.

## Normal user-turn flow

A normal user turn follows the user-message Runtime path:

```text
user input
  -> Runtime user turn
  -> durable/raw conversation boundary
  -> Direct Context + Memory retrieval
  -> PromptBuilder
  -> configured Chat provider chain
  -> streaming/final assistant text
  -> assistant conversation persistence + Runtime events
  -> finalized-turn memory-ingestion coordination
  -> optional presentation / TTS side effects when requested and available
```

Memory read and write controls are distinct. Direct Context is recent conversation context, not long-term Memory. Long-term Memory enters the prompt as evidence through the semantic Memory boundary.

Provider-chain execution is separate from provider diagnostics. Local readiness/status inspection does not itself prove remote provider availability and does not perform live provider I/O.

## Assistant-initiated proactive flow (P6)

Current proactive text is a separate assistant-initiated flow rather than a synthetic user turn:

```text
Companion idle/presence eligibility
  -> reducer-admitted proactive opportunity
  -> fresh presentation-layer candidate
  -> MainPage consent/admission + execution arbitration
  -> POST /v1/proactive-turns/stream
  -> Runtime assistant-initiated turn
  -> ProactiveDecisionProvider
       |- NO_OP ---------> terminal, no assistant text
       `- REQUEST_TEXT --> AssistantContinuationProvider
                            -> one validated assistant-only continuation
                            -> persistence + SSE projection
```

Current P6 invariants:

- user/lifecycle work has priority over proactive work;
- the decision capability returns exactly `NO_OP` or `REQUEST_TEXT`;
- `REQUEST_TEXT` is the only path that invokes assistant continuation generation;
- no synthetic Runtime user message is created;
- proactive text has no memory-write, TTS/voice, or tool authority;
- stale callbacks/effects are fenced and an admitted attempt is one-shot/non-replayable;
- the presentation candidate identity and the Runtime idempotency identity are fresh and separate;
- normal user Chat remains a separate provider/Runtime path.

The current presentation eligibility constants are 12 s idle delay, 30 s cooldown, 1800 ms intent TTL, and at most one attempt per idle episode, subject to visibility, online, Live2D, lifecycle, speech, transition, consent, and execution-admission gates.

## Presentation / P5

Live2D companion presentation is implemented. The Companion surface owns Lumi/Live2D presentation, speech playback queues and browser audio projection; the Main surface owns chat input/streamed text and forwards presentation work across the companion bus.

This presentation layer consumes normalized Runtime/presence truth. It does not define Persona, relationship truth, provider availability, or Memory truth.

## Persistence / P4

The primary durable Linux architecture is:

```text
YUVI
  -> repository interfaces
  -> DATABASE_URL
  -> external / system / container PostgreSQL
  -> YUVI migrations
```

YUVI owns repository correctness, migrations, finalized-turn lifecycle, durable ingestion state, idempotent semantic delivery, crash recovery, retry/reconciliation semantics, and ambiguous-side-effect protection. It does not need operating-system ownership of the PostgreSQL process on Linux.

See [p4-linux-first.md](p4-linux-first.md). Windows private-cluster/process/ACL/Credential Manager/installer ownership is deferred packaging work; closed unmerged PR #20 is historical evidence, not current architecture.

## Memory boundary

Runtime code should consume vendor-neutral `MemoryProvider` / `MemoryEvent` semantics rather than Mem0 DTOs. Memory is evidence, not an authoritative Persona, Affect, Relationship, Interest, or Commitment state database.

Retrieval preserves epistemic status: `ok`, `empty`, `unavailable`, `error`, and `partial` are distinct. Missing source timestamps remain unknown. Lexical, trigram, full-text, and optional vector retrieval can coexist; vector failure must not erase lexical fallback behavior.

## Providers / P7

Providers are replaceable capability implementations behind the registry/resolver boundary. Current capabilities include Chat, Reasoning, TTS, STT, Vision, and Embedding, with configured provider chains and fallback policy.

Two diagnostic axes must remain distinct:

- **readiness**: local/configuration state; zero provider I/O;
- **observed state**: the latest explicit verification result; live Verify may make remote and potentially billable calls.

Normal `/health` and provider status inspection do not imply a live provider probe.

## Prompt and P8 boundary

`PromptBuilder` currently has syntactic sections such as `SystemIdentity`, `CharacterStyle`, `RelationshipContext`, `CurrentAffect`, `DirectContext`, and `RelevantMemory`. The existence of a prompt section does **not** establish an authoritative producer for persistent P8 relationship/persona state.

P8 is not implemented as a persistent `RelationshipState`, affinity/trust score, `DynamicSelf`, or similar state machine. Current Memory remains evidence that a future P8 interpretation layer may use alongside stable persona rules, recent conversation, and Runtime truth.

## Explicitly non-current architecture

The following are not current core architecture:

- Windows packaged-private PostgreSQL as the product persistence gate;
- PR #20 wholesale as a required migration path;
- persistent P8 relationship/affinity/trust state;
- Live2D or proactive text described as wholly future work;
- 512-dimensional local Qwen embedding output as a production default;
- NATS as the active Runtime event bus.

Planned or experimental work must be labeled as such rather than presented as current behavior.