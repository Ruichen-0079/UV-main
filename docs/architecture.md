# Current Architecture

This document describes the implementation boundaries on the current main baseline. Read [Current state](current-state.md) first for status classifications and deferred work.

## Authority and status rules

Current source and tests, together with newer explicit baseline documents, outrank historical phase notes. A document describing future work must label it planned or deferred. A measured local deployment is not automatically a repository default. Git history and old pull requests are evidence about how the system arrived here, not current architecture.

## Product boundary

YUVI is a local-first, event-driven AI companion runtime. The runtime owns turn orchestration, prompt construction, provider selection, persistence boundaries, memory retrieval, and runtime events. Web, Companion, and future desktop surfaces are presentation and control clients of the runtime.

There is no authoritative P8 Persona/Relationship state machine in the current product. Prompt sections such as `RelationshipContext` and fields such as `personaId` are supported integration/context boundaries; they must not be read as proof that persistent `RelationshipState` or `DynamicSelf` exists.

## Runtime boundaries

```text
Web Dashboard / Main / Companion surfaces
  -> Fastify HTTP, SSE, and WebSocket boundary
  -> RuntimeOrchestrator
       -> conversation persistence
       -> memory retrieval and finalized-ingestion durability
       -> PromptBuilder
       -> ProviderRegistry / provider chains
       -> Event Bus
  -> optional media and avatar presentation
```

### Web and Companion presentation

`apps/web` contains the development Dashboard plus Main and Companion surfaces. The Companion surface owns Lumi Live2D/Cubism rendering, speech playback, and Web Audio presentation. The main surface owns chat input and streamed text. A small Companion Bus coordinates the split surfaces. Live2D and voice presentation are capability-gated: a missing model, media provider, or connection can make the capability unavailable without changing runtime turn semantics.

The Tauri shell in `apps/desktop` hosts the main and Companion windows and contains desktop service/supervisor integration. That shell is implemented enough for development and packaging work, but its final packaged platform ownership and release guarantees are not the Linux runtime architecture.

### Fastify server/API boundary

`apps/server` owns HTTP routes, SSE framing, WebSocket transport, health/status responses, startup, reload, and shutdown. Routes remain thin and delegate turn behavior to the core. Current route groups include:

- `/health`, `/providers/status`, provider verification, and runtime settings;
- `/message`, `/v1/messages`, and `/v1/messages/stream` for normal user turns;
- `/v1/proactive-turns/stream` for assistant-initiated text turns;
- memory, event, prompt-debug, Voice, Vision, TTS, STT, and Live2D resource routes;
- `/ws` for runtime event transport and Dashboard event observation.

`GET /health` and `GET /providers/status` inspect local configuration and cached observations; they do not perform remote provider verification. Explicit verification routes are documented in [Providers](providers.md).

### `RuntimeOrchestrator`

`packages/core` is the runtime application boundary. It handles normal user turns, assistant-initiated turns, audio transcripts, vision input, memory context, prompt previews, provider calls, event publication, conversation persistence, and lifecycle sealing/draining. It depends on ports/interfaces rather than vendor SDKs.

### `PromptBuilder`

`packages/prompt-builder` builds bounded, provider-neutral prompt sections. Current sections include `SystemIdentity`, `CharacterStyle`, `RelationshipContext`, `CurrentTime`, `CurrentAffect`, `DirectContext`, `RelevantMemory`, `CurrentSituation`, `Tools`, `ProactiveInstruction`, and `UserMessage` where applicable. Normal user prompts include a user message; assistant-initiated prompts use `ProactiveInstruction` and do not manufacture a user message.

`CurrentAffect` is an immediate, high-confidence hint derived from current input. `RelationshipContext` is an available prompt slot, not an authoritative relationship database.

### `ProviderRegistry`

`packages/providers` owns provider interfaces, normalized errors, provider construction, fallback chains, readiness status, explicit live observations, and provider-specific transports. Current capabilities are Chat, Reasoning, TTS, STT, Vision, and Embedding. Supported implementations include the generic OpenAI-compatible route, DeepSeek, NVIDIA, Local, xAI, Alibaba DashScope, GPT-SoVITS, and explicit Mock routes where mocks are allowed.

The checked-in environment example uses a generic OpenAI-compatible DeepInfra Chat route, with DeepSeek as the Reasoning default. Provider selection remains configuration-driven; credentials in a developer machine are not repository behavior. Ordinary Chat uses the normal `/chat/completions` transport. P6 uses separate narrow OpenAI-compatible capabilities for decision-only control and assistant continuation.

### Conversation persistence

Conversation persistence is separate from long-term memory. It stores raw user and assistant messages, streaming status, session identity, and finalization metadata. In-memory persistence supports same-process runtime reconstruction only. PostgreSQL conversation persistence supports recovery after process restart when `CONVERSATION_REPOSITORY=postgres`, `DATABASE_URL` is configured, and migrations have run.

Raw conversation records are not automatically long-term memory and are not dumped wholesale into prompts. Direct Context is a bounded recent same-session view; Relevant Memory is retrieved, ranked, compressed, and reconstructed before prompt injection.

### Finalized-ingestion durability

P4 protects the boundary after a reply has been finalized. The runtime persists the final assistant text before exposing the completed reply, admits durable finalized-turn work when the configured semantic memory path requests it, and uses the finalized-ingestion ledger plus `MemoryIngestionCoordinator` for idempotent delivery, lease/version fencing, retry, reconciliation, and crash recovery. Ambiguous external effects remain protected by fail-closed and reconciliation rules. See [P4 Linux-first persistence](p4-linux-first.md).

### Semantic memory provider/backend

`packages/memory` exposes memory repositories, retrieval, extraction, admission, maintenance, and provider-neutral memory events. The runtime can select the legacy backend or the Mem0 backend through `MEMORY_BACKEND`. PostgreSQL with pgvector supports durable hybrid retrieval; keyword, trigram, full-text, metadata, and structured filtering remain important even when embeddings are enabled. Mem0 records are evidence returned through a provider contract, not authoritative Persona or Relationship state.

### Event bus

The server currently constructs an in-memory event bus. Runtime events include `user.message`, `user.voice.transcript`, `agent.reply`, `assistant.message`, `memory.retrieved`, `avatar.speak`, `provider.error`, and `runtime.error`, plus media lifecycle events. `EVENT_BUS=nats` is a reserved future boundary and is not implemented.

## Normal user-turn flow

```text
user input
  -> user.message / user.voice.transcript
  -> persist the user message when a Conversation Repository is configured
  -> restore bounded Direct Context
  -> retrieve Relevant Memory when read is enabled
  -> PromptBuilder
  -> configured Chat provider chain
  -> persist and finalize the assistant message
  -> agent.reply, then assistant.message
  -> optional memory processing and TTS side effects
```

Streaming deltas are persisted before they are yielded. The final text is persisted before reply events are exposed. Memory extraction/storage and TTS are post-processing boundaries and must not retract an already finalized assistant reply. Explicit memory and persistence failures keep their required fail-closed behavior at their own semantic boundary.

## Assistant-initiated proactive flow

```text
eligible client request with idempotency key
  -> existing-session context and optional memory retrieval
  -> assistant-initiated PromptBuilder input
  -> decision provider: exactly NO_OP or REQUEST_TEXT
       NO_OP        -> terminal result, no assistant message
       REQUEST_TEXT -> one continuation call -> one assistant-only message
```

P6 is implemented, but it is deliberately narrow:

- the first stage decides exactly `NO_OP` or `REQUEST_TEXT`;
- only `REQUEST_TEXT` permits prose generation;
- `NO_OP` produces no assistant message;
- `REQUEST_TEXT` produces one assistant-only continuation and no synthetic user event;
- proactive turns have no memory-write authority, TTS authority, or tool authority;
- explicit user activity/control outranks proactive work;
- idempotency claims, cancellation, and stale-request fences prevent replay;
- ordinary Chat remains a separate normal user-message path.

The browser-side behavior policy may admit or suppress a proactive request based on consent, current presence, and user activity. That policy is presentation/control arbitration; it does not replace the runtime’s semantic decision stage.

## Presentation and media

Voice input, TTS, Vision, and Live2D are implemented integration paths with provider/capability checks. Their availability is configuration- and environment-dependent. They are not evidence that the deferred P8 relationship authority or a final packaged production distribution has been implemented.
