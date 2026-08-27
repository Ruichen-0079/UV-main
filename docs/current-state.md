# YUVI Current State

[English](current-state.md) | [简体中文](current-state.zh-CN.md)

**Status snapshot date: 2026-08-27**  
**Repository baseline: `62028e41d78383fc47f22f4afa1c1e9996d5bab1` (`origin/main` when DOC-R1 was prepared for PR)**

Status labels used here:

- **CURRENT** — implemented/tracked product behavior on the repository baseline.
- **VALIDATED LOCAL DEPLOYMENT / MEASUREMENT-ONLY** — measured outside tracked production defaults; not repository behavior by implication.
- **PLANNED** — intended future work, not implemented product truth.
- **DEFERRED** — intentionally not a current product gate.
- **HISTORICAL** — useful implementation history, not current architecture authority.

## 1. Product direction

**CURRENT:** YUVI is a local-first AI companion Runtime. Product work is centered on a shared Runtime that supports conversation, semantic Memory, provider routing, media capabilities, companion presentation, and bounded assistant-initiated behavior rather than a single chat UI.

Linux is the primary development, product-development, and production-validation platform.

## 2. Platform status

**CURRENT:** Linux is the primary platform for active product work and durable validation. Native Windows development and Windows desktop/package code remain in the repository and continue to receive compatibility coverage.

**DEFERRED:** Windows installer-owned/private PostgreSQL lifecycle, bundled PostgreSQL/pgvector, private process ownership, Windows ACL/Credential Manager ownership, and related provisioning are platform packaging work. They do not block Linux product behavior.

## 3. Runtime architecture

**CURRENT:** The main boundary is:

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

The Runtime owns semantic turn behavior. Transport and presentation code may project, admit, render, or execute work without becoming authoritative Memory/Persona/provider truth.

Normal user turns and assistant-initiated proactive turns are separate Runtime paths. See [architecture.md](architecture.md).

## 4. Persistence / P4

**CURRENT:** [p4-linux-first.md](p4-linux-first.md) is the P4 baseline.

Primary Linux durable persistence:

```text
YUVI
  -> repository interfaces
  -> DATABASE_URL
  -> external / system / container PostgreSQL
  -> YUVI migrations
```

Reliability assets that remain current include:

- finalized-turn lifecycle;
- durable finalized-ingestion ledger/state;
- idempotent semantic delivery;
- crash recovery;
- retry and exact reconciliation semantics;
- ambiguous external side-effect protection;
- fail-closed behavior where the semantic persistence/Memory boundary requires it.

YUVI does not need operating-system ownership of the PostgreSQL process on Linux.

**DEFERRED / HISTORICAL:** PR #20 (`P4-2D2`) is closed and unmerged. Do not present it as current main architecture or resume it wholesale.

## 5. Presentation / P5

**CURRENT:** Live2D companion presentation is implemented rather than future-only. The Web Companion surface integrates Lumi/Live2D lifecycle, normalized presence/capability projection, behavior policy, speech playback queues, browser audio/analyser behavior, and presentation state. The Main surface owns chat input/streamed text and sends presentation work across the companion bus.

Presentation/execution responsibilities stay separate from semantic decision authority. Live2D state does not define Persona, relationship truth, Memory truth, or remote provider availability.

## 6. Proactive / P6

**CURRENT / FROZEN:** P6 proactive text uses a two-stage provider flow:

1. `ProactiveDecisionProvider` returns exactly `NO_OP` or `REQUEST_TEXT`.
2. `AssistantContinuationProvider` runs only after `REQUEST_TEXT` and may produce one assistant-only continuation.

Tracked/example provider configuration and the merged live acceptance path use a generic OpenAI-compatible remote gateway with:

- decision: `meta-llama/Llama-3.3-70B-Instruct-Turbo`;
- assistant continuation and normal Chat model: `deepseek-ai/DeepSeek-V4-Flash-0731`;
- explicit `deepseek-v4` assistant-continuation format for the second call.

Important frozen semantics:

- `NO_OP` produces no proactive assistant output;
- `REQUEST_TEXT` may produce exactly one assistant-only proactive continuation;
- no synthetic user message;
- no proactive Memory-write authority;
- no proactive TTS/voice/tool authority;
- strict user/lifecycle priority over proactive execution;
- stale async callback/effect fencing;
- one-shot/non-replayable attempt behavior;
- fresh presentation candidate identity and separate fresh Runtime idempotency identity;
- normal user Chat remains separate.

Presentation eligibility remains bounded by 12 s idle delay, 30 s cooldown, 1800 ms intent TTL, at most one attempt per idle episode, and visibility/online/Live2D/lifecycle/speech/transition gates. MainPage consent/admission and execution arbitration remain additional gates.

## 7. Providers / P7

**CURRENT:** Provider architecture supports capability-specific interfaces and configured chains/fallback for Chat, Reasoning, TTS, STT, Vision, and Embedding. Implemented P7 areas include provider contract hardening, Chat streaming, fallback/error policy, cancellation propagation, batch STT, TTS, Vision, runtime settings state, provider diagnostics, explicit Verify, and Dashboard projections.

Two axes are intentionally separate:

- **provider readiness** = local configuration/constructability; zero provider I/O;
- **provider observed state** = cached result from explicit verification; live verification may perform remote and potentially billable calls.

Normal `/health` and provider status inspection do not perform live provider verification.

Settings distinguish unsaved/draft state, saved/effective configuration, and active Runtime state. **Save Only** must not be described as already applied Runtime state; **Save & Apply** / explicit apply-reload behavior is a separate action.

## 8. Memory

**CURRENT:** The Runtime-facing conceptual boundary is evidence-oriented and vendor-neutral.

Read path:

```text
Mem0 / other backend
  -> MemoryBackend
  -> MemoryProvider
  -> MemoryRetrievalOutcome
  -> MemoryEvent[]
  -> MemoryContextBuilder
  -> PromptBuilder
```

Write path:

```text
Conversation
  -> MemoryIngestionPolicy / finalized-ingestion coordination
  -> MemoryWriteEventInput
  -> MemoryProvider.writeEvent() / idempotent delivery
  -> Memory backend
```

Current invariants:

- Runtime should not depend directly on Mem0 vendor DTOs;
- `MemoryEvent` preserves provenance and evidence semantics;
- absent source timestamps remain unknown;
- normal facts are user-grounded evidence;
- ordinary assistant text is context, not default fact authority;
- an explicit “remember” request is a user claim/request, not automatic verification of truth;
- assistant-only relationship/affect prose must not become authoritative state;
- no assistant-derived self-reinforcing Memory/state loop;
- retrieval status matters: `ok`, `empty`, `unavailable`, `error`, `partial` are distinct;
- unavailable/error does not mean amnesia;
- lexical, trigram, full-text, and optional vector retrieval coexist;
- exact technical terms remain strong signals;
- embeddings augment lexical retrieval rather than replace it;
- embedding failure preserves lexical fallback;
- identity/scope isolation is part of correctness.

Memory is evidence, not a Persona database.

## 9. P8 status

**PLANNED / NOT IMPLEMENTED:** P8 answers “Who is YUVI?” and “What is the relationship/background context?” It is distinct from P6 (“what should YUVI do now?”) and P5 (“how is that action presented/executed?”).

Do not treat persistent `RelationshipState`, affinity/trust scoring, `DynamicSelf`, `GroundedClaimCompiler`, or similar historical design sketches as current architecture.

Current design direction favors:

```text
Stable Persona Rules
+ selected real Memory evidence
+ recent conversation
+ Runtime truth
-> model interpretation
```

Principles: evidence over derived state; broad invariants over enumerated behavioral rules; Memory is evidence rather than authoritative Persona/Relationship state; stable persona must not drift from ordinary conversation; model self-report is not Runtime authority; explicit user controls outrank persona preference; intimacy/dependency/relationship state cannot be invented without evidence.

`PromptBuilder` already has syntactic `RelationshipContext` and `CurrentAffect` sections. Their existence does not imply an authoritative P8 persistent-state producer exists.

## 10. Local embedding measurement

**VALIDATED LOCAL DEPLOYMENT / MEASUREMENT-ONLY. This is not a tracked production default.**

A recent Linux validation used:

- model: `Qwen3-Embedding-0.6B-Q8_0.gguf`;
- runtime: llama.cpp `b10621` / `0.3.0-dev`;
- CPU-only Linux;
- OpenAI-compatible `/v1/embeddings` endpoint;
- `OpenAICompatibleEmbeddingProvider -> local llama-server -> MemoryService -> PostgreSQL hybrid retrieval`;
- native model output dimension: **1024**;
- production source delta for the validation: **none**.

Measured dimensions were 1024, 768, 512, and 256 using Qwen MRL prefix truncation followed by L2 normalization. The frozen evaluation contained 120 memories, 48 manually frozen queries, and 8 categories.

**MEASUREMENT RESULT:** 512 was selected as the future target because production-hybrid Recall@5 matched 1024 in that evaluation, MRR was competitive/slightly better, and no important scope/stale regression appeared. 256 showed meaningful regression in shared-history/ranking behavior.

**CURRENT:** the validated local path remains native 1024 output. 512-dimensional output transformation is **not implemented in production source**.

**PLANNED:** a future implementation is classified as `MINIMAL_PROVIDER_MRL_TRANSFORM`. Lower output dimensions do not reduce transformer inference cost in this llama.cpp path; expected benefits are vector storage, index footprint, and vector-search footprint/latency.

No personal machine paths belong in repository documentation.

## 11. Structural debt paydown

**CURRENT / IN PROGRESS:** behavior-preserving structural decomposition is running separately from product semantics. On this baseline, Web dashboard presentation primitives, shared date formatting, `EventTable`, and `EventsPage` have already been extracted into dedicated modules.

Further decomposition of large Web/Core files may continue. Proposed future file/module names are not stable product architecture and should not be documented as contracts.

Structural debt work must preserve P4/P5/P6/P7 semantics rather than use refactoring as a product redesign vehicle.

## 12. Explicit non-current architecture

The following claims are explicitly non-current unless a future source change makes them true:

- Windows-first or WSL-required product development;
- Docker Desktop as a YUVI product requirement;
- Windows private/bundled PostgreSQL as the primary persistence architecture or product gate;
- PR #20 as current main architecture;
- Live2D or proactive assistant behavior as wholly unimplemented future work;
- persistent P8 `RelationshipState`, affinity/trust state, `DynamicSelf`, or similar authority as implemented;
- 512-dimensional Qwen embedding output as a production default;
- DashScope 1536-dimensional embeddings as the only/current embedding architecture;
- ordinary health/status inspection as a live provider verification call;
- NATS as the active Runtime event bus.

## 13. Documentation authority

Current source and tests plus newer explicit baseline documents are the authority for current product behavior.

Old PRs, phase plans, and historical docs are evidence of history, not current architecture.

Experimental/local measurements are not repository defaults unless tracked product configuration/source implements them.

Planned and deferred work must be labeled explicitly.

When documents disagree, use this precedence:

1. current source + tests on `origin/main`;
2. newer explicit baseline documents such as this snapshot and [p4-linux-first.md](p4-linux-first.md);
3. merged PR evidence;
4. older documents;
5. old branches / unmerged PRs;
6. chat history.