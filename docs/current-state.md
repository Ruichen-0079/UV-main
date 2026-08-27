# YUVI Current State

Status snapshot date: 2026-08-27
Repository baseline: `d19d36bfc373e68255302258e57b0af5c7a72efa`

This is the current-state authority for the documentation rebaseline. Current source/tests and newer explicit baseline documents outrank historical phase notes. Planned work is not current architecture. A measured local deployment is not automatically a repository default. Git history and old pull requests are evidence, not current architecture.

## 1. Product direction

YUVI is a local-first, event-driven AI companion runtime. The current repository is a runnable TypeScript monorepo with a Fastify runtime server, Web Dashboard/Main/Companion surfaces, configurable provider chains, memory and conversation boundaries, and a Tauri desktop shell. The runtime is the product boundary; avatar and media surfaces are presentation/execution clients.

Status vocabulary used here:

- **CURRENT** — implemented in the repository baseline and supported by source/tests.
- **VALIDATED LOCAL DEPLOYMENT** — observed outside tracked product configuration.
- **EXPERIMENTAL / MEASURED** — evidence or a probe that does not change the repository default.
- **PLANNED** — intended future work with no current implementation claim.
- **DEFERRED** — deliberately postponed, especially platform packaging work.
- **HISTORICAL** — useful evidence from an older branch/PR, not a current design requirement.

## 2. Platform status

**CURRENT:** Linux is the primary development and production-validation platform. Durable persistence connects through `DATABASE_URL` to external, system-managed, or separately managed container PostgreSQL. Linux runtime correctness does not require YUVI to own the PostgreSQL OS process.

**CURRENT:** Windows development compatibility exists through the PowerShell helpers and Docker development path. Windows is not the current primary production-validation platform.

**DEFERRED:** Windows packaged-private-PostgreSQL ownership, installer provisioning, private database lifecycle integration, and related platform-specific process/ACL work. Do not resume PR #20 wholesale.

**CURRENT:** The Tauri shell and desktop surfaces exist in the repository. Final packaged platform ownership and release readiness remain packaging work, not a reason to redefine the Linux runtime.

## 3. Runtime architecture

The current boundary is:

```text
Web Dashboard / Main / Companion
  -> Fastify HTTP + SSE + WebSocket
  -> RuntimeOrchestrator
       -> Conversation Repository
       -> Memory provider/backend and P4 finalized-ingestion ledger
       -> PromptBuilder
       -> ProviderRegistry / fallback chains
       -> in-memory Event Bus
  -> optional TTS, STT, Vision, and Live2D presentation
```

Normal user turns and assistant-initiated proactive turns are separate runtime paths. `agent.reply` is the internal generated reply event; `assistant.message` is the final user-facing text event. Raw conversation logs are not long-term memory, and Mem0 evidence is not authoritative Persona/Relationship state.

## 4. Persistence / P4

**CURRENT:** P4 Linux-first behavior includes the finalized-turn lifecycle, durable finalized-ingestion ledger, idempotent semantic delivery, crash recovery, retry/reconcile behavior, ambiguous-external-effect protection, and required fail-closed boundaries.

**CURRENT:** Durable mode requires `MEMORY_REPOSITORY=postgres`, a valid `DATABASE_URL`, reachable PostgreSQL, and successful `pnpm db:migrate`. The PostgreSQL service may be system-managed, separately managed, or supplied by development Compose. YUVI does not own that database process on Linux.

**CURRENT:** `MemoryIngestionCoordinator` is the automatic delivery owner for wake/poll recovery, leases/version fencing, retry budget, and reconciliation. Final text is persisted before completed reply events are exposed.

**DEFERRED / HISTORICAL:** PR #20’s packaged Windows supervisor/schema-bootstrap architecture is not current main architecture. Any future Windows packaging resumption must separately re-evaluate its historical Mem0 fail-closed finding.

See [P4 Linux-first rebaseline](p4-linux-first.md) for the detailed P4 authority.

## 5. Presentation / companion behavior

**CURRENT:** `apps/web` provides Dashboard, Main, and Companion surfaces. Lumi Live2D/Cubism rendering, presence projection, speech playback, Web Audio analysis, Tauri window coordination, and capability gates are implemented paths. Missing assets or unavailable media capabilities can leave presentation unavailable without changing runtime semantics.

**CURRENT:** The Web Companion behavior policy arbitrates presentation intents such as attention, gaze, reaction, and proactive requests. Explicit user activity/control has higher authority than ambient/proactive behavior.

**PLANNED / DEFERRED:** Final cross-platform packaged UX guarantees, additional avatar formats such as VRM, and future game-agent/perception integrations. Do not rewrite the current Live2D implementation as future-only work.

## 6. Proactive / P6

**CURRENT:** P6 assistant-initiated proactive text turns are implemented through a two-stage path:

1. a decision-only provider call returns exactly `NO_OP` or `REQUEST_TEXT`;
2. only `REQUEST_TEXT` permits one prose continuation call and one assistant-only continuation.

The semantic boundary is:

- `NO_OP` produces no assistant message;
- `REQUEST_TEXT` produces one assistant-only continuation;
- no synthetic user event;
- no proactive memory-write authority;
- no proactive TTS or tool authority;
- explicit user activity/control outranks proactive work;
- stale, cancelled, duplicate, or already-claimed attempts do not replay;
- ordinary Chat remains a separate normal user-message path.

The public stream is `POST /v1/proactive-turns/stream` and requires an idempotency key. Browser consent/presence admission can suppress a request before runtime execution; it does not change the frozen runtime semantic decision.

## 7. Providers / P7

**CURRENT:** ProviderRegistry supports configurable Chat, Reasoning, TTS, STT, Vision, and Embedding capabilities with fallback chains, normalized errors, safe status metadata, and cancellation-aware transports. The checked-in environment example selects a generic OpenAI-compatible DeepInfra Chat route and DeepSeek Reasoning, while provider selection remains configuration-driven.

**CURRENT:** Provider diagnostics and settings truth are implemented. `GET /providers/status` and `GET /health` do not perform remote provider I/O. Readiness means local configuration/constructibility; observed availability comes from an explicit live observation. Chat, Reasoning, and Embedding have explicit live verification. TTS, STT, and Vision verification is configuration-only. Actual Voice and Vision developer routes are implemented and call their configured provider paths when used.

**CURRENT:** `Apply Now`/runtime reload can update supported provider configuration in-process; settings that alter restart-bound runtime infrastructure remain restart-required. Secrets are redacted and belong only in local configuration.

## 8. Memory

**CURRENT:** Conversation persistence, Direct Context, and long-term memory are separate. Memory retrieval is bounded and reconstructed before prompt injection. Legacy memory and Mem0 are selectable backends; PostgreSQL + pgvector supports durable hybrid retrieval, while keyword/trigram/full-text and structured metadata filtering remain important for exact technical queries.

**CURRENT:** Memory extraction can use the configured Reasoning provider or rule-based fallback. Candidate validation, admission, deduplication, supersession/correction metadata, retention, and maintenance are memory responsibilities.

**CURRENT:** Mem0 evidence is provider-returned semantic memory evidence. It is not a Persona/Relationship authority, and normal model prose does not mutate stable persona state.

## 9. P8 status

**NOT COMPLETE / DEFERRED:** P8 Persona/Relationship product implementation is not complete. The current boundary is:

- P8 is intended to own identity and relationship background/context;
- P6 owns the current semantic decision about whether/how to act;
- P5 owns presentation/execution rendering;
- Memory is evidence, not authoritative Persona/Relationship state;
- stable persona must not drift merely because ordinary conversation produced model prose;
- model self-report is not runtime/state authority;
- explicit user controls outrank persona preference.

Do not document persistent `RelationshipState`, `DynamicSelf`, or equivalent state machinery as current production architecture unless source later implements it.

## 10. Local embedding measurement status

**VALIDATED LOCAL DEPLOYMENT / MEASUREMENT-ONLY:** A Linux CPU-only local loopback deployment used `Qwen3-Embedding-0.6B-Q8_0.gguf` with llama.cpp `b10621 / 0.3.0-dev`, an OpenAI-compatible `/v1/embeddings` endpoint, YUVI’s existing `OpenAICompatibleEmbeddingProvider`, `MemoryService`, and PostgreSQL hybrid retrieval. The native runtime output was 1024 dimensions. No production source delta was made.

Using Qwen MRL-compatible prefix truncation followed by L2 normalization, the P8-0B golden set contained 120 memories, 48 manually frozen queries, and 8 categories. Production-hybrid Recall@5 measured:

| Dimensions | Recall@5 |
| ---------: | -------: |
|       1024 |   0.8750 |
|        768 |   0.8750 |
|        512 |   0.8750 |
|        256 |   0.8750 |

The selected future production target is **512**, classified as **B. `MINIMAL_PROVIDER_MRL_TRANSFORM`**. **512 is not implemented in production. Production remains native 1024.** Lower dimensions do not reduce current transformer inference cost; the expected benefit is storage, index, and vector-search footprint. 256 was rejected because important shared-history/ranking behavior regressed despite the aggregate score.

The tracked repository configuration remains dimension-configurable and its generic example retains 1536 as a placeholder for providers that use it. That configuration fact does not turn the local measurement into a repository default or make 512 current.

## 11. Structural debt paydown

**CURRENT:** Behavior-preserving structural debt paydown is underway. PR #63 extracted shared Dashboard presentation primitives and PR #64 extracted shared date formatting; neither intentionally changed product semantics.

`packages/core/src/index.ts` and `apps/web/src/App.tsx` remain structural debt targets. Temporary file layout must not be treated as a product architecture guarantee, and planned future filenames are not completed architecture.

## 12. What is explicitly NOT current architecture

- Windows-first or recommended-Windows development as the primary product path.
- WSL as a mandatory product prerequisite.
- Docker Desktop as the only expected environment.
- YUVI owning a private PostgreSQL process as the Linux persistence path.
- PR #20 packaged PostgreSQL/supervisor work as a prerequisite for product development.
- `RelationshipState`, `DynamicSelf`, or Mem0 as authoritative P8 Persona/Relationship state.
- 512-dimensional MRL production support; it is a future provider transform.
- NATS as the current event bus implementation.
- Raw chat logs being long-term memory.
- Provider readiness being proof of remote availability.
- Historical phase notes or old PR descriptions overriding current source/tests.
