# Mem0 Memory Foundation and Runtime Contract

Status: **P3 runtime-ready migration**. Mem0 is now reachable through the
vendor-neutral semantic memory boundary; the existing Legacy provider remains
an explicit fallback. This document describes the contract, not a second
storage implementation.

## 1. Boundaries

`MemoryBackend` is the storage-level contract in
`packages/memory/src/backend.ts`. It owns `health`, `add`, `search`, `get`,
`list`, `update`, `delete`, and `history` for a concrete store. The two
implementations are `LegacyMemoryBackend` and `Mem0MemoryBackend`.

`MemoryProvider` is the Runtime-facing semantic contract in
`packages/memory/src/provider.ts`:

- `retrieveRelevant()` returns a `MemoryRetrievalOutcome` with an epistemic
  status (`ok`, `empty`, `unavailable`, `error`, or `partial`).
- `getEvent()` requires a scope and fails closed on cross-scope reads.
- `writeEvent()` accepts one semantic `MemoryWriteEventInput` and does not
  expose vendor DTOs or administrative storage operations.

`MemoryEvent` is canonical evidence. It keeps a stable opaque identity and
provenance (`id`, `source`, `sourceRecordId`, scope, timestamps, and source
links). Mem0 records map to `id=mem0:<memoryId>`, `source=mem0`, and the raw
Mem0 UUID as `sourceRecordId`; the scope is enforced separately and never
becomes part of the ID. `createdAt` is `recordedAt`, never `occurredAt`.
Absent timestamps stay absent.

`MemoryContextBuilder` in `packages/core/src/memory-context.ts` is the
compatibility bridge to the existing PromptBuilder. It retains canonical
events for diagnostics and projects prompt-safe `{content, displayText}`
objects with a provenance ID. It does not retrieve, rank, change the prompt
wording, or redefine the existing prompt limits and token budget.

## 2. Canonical read/write flows

```text
READ
Mem0 → MemoryBackend → Mem0MemoryProvider
     → MemoryRetrievalOutcome → MemoryEvent[]
     → MemoryContextBuilder → PromptBuilder

WRITE
Conversation → MemoryIngestionPolicy → MemoryWriteEventInput
            → MemoryProvider.writeEvent() → Mem0MemoryProvider
            → MemoryBackend → Mem0
```

`MemoryIngestionPolicy` is the factual/user-claim boundary. Normal completed
conversation turns create only user-grounded factual events, each dispatched
through `writeEvent()` with `infer=false`; assistant prose is context, not a
default fact source. Explicit remember creates one `user_claim` event with
`assertion.source=user` and `verification=unverified`. It is evidence of a
claim, not verified truth. Assistant-only relationship or affect prose is
rejected. A normal turn never performs both a provider write and a legacy
`infer=true` write.

Evidence must not be promoted directly to authoritative Relationship, Affect,
Persona, Interest, or Commitment state. Metadata such as `trust` or
`closeness` remains non-authoritative. A future state path is
`MemoryProvider → MemoryEvent[] → RuntimeStateEnvelope →
GroundedClaimCompiler`; it is deliberately not implemented in P3.

## 3. Status and fallback semantics

- `ok`: relevant evidence was retrieved.
- `empty`: this query selected no relevant evidence; it is not a confirmed
  statement that the database contains no memory.
- `partial`: usable evidence exists but the provider reports a bounded or
  incomplete result.
- `unavailable` / `error`: the provider could not complete normally; neither
  means amnesia.

Core preserves provider status when it falls back to the legacy repository.
For example, `provider=unavailable`, `fallbackUsed=true`, and `final=ok` is a
valid diagnostic state when fallback produced prompt memories. Fallback
success does not claim that provider health was restored. Current-turn and
DirectContext echoes are dropped deterministically with explicit reasons from
prompt selection, while the canonical events remain available for diagnostics.

Observability may expose only safe fields: status, counts, bounded query
length, stable event IDs, source, drop reasons, and aggregate provenance
flags. It must not expose full memory/query text, raw metadata, credentials,
database URLs, authorization headers, tokens, API keys, or secrets.

## 4. Legacy compatibility and persistence

When no semantic provider is configured, Core uses the existing Legacy memory
retrieval path and marks it as a fallback. Existing prompt wording, memory
limits, token budgets, scope behavior, and DirectContext behavior remain
unchanged. Existing Mem0 records remain readable; P3 adds no event store and
requires no database or pgvector migration.

Dialogue-level forget remains a scoped search/delete operation. It is not an
administrator delete, repair, rollback, or audit mechanism.

## 5. Sidecar and storage implementation

Path: `services/memory-mem0/`. The sidecar is Python 3.11, FastAPI, Mem0 OSS
(`mem0ai==0.1.107`), Ollama embeddings, and PostgreSQL/pgvector.

```text
YUVI Runtime :6121
  └─ MemoryProvider
      └─ Mem0MemoryProvider
          └─ Mem0MemoryBackend (HTTP adapter)
              └─ sidecar :6131
                  ├─ Mem0 OSS (Python)
                  ├─ Ollama embedder :11434
                  └─ PostgreSQL + pgvector
```

The fixed embedding model is `yuvi-embedding:0.6b` (1024 dimensions,
`num_ctx=2048`) and the collection is
`yuvi_mem0_qwen3_1024_v1`. These storage details are implementation choices;
they do not change the Runtime semantic contract.

When `MEM0_LLM_MODEL` / `MEM0_LLM_API_KEY` are unset, the sidecar still
supports `infer=false` semantic writes, search, and CRUD. `infer=true` is an
explicit sidecar capability and returns `MEMORY_LLM_NOT_CONFIGURED`; the
normal YUVI conversation path does not depend on it.

Runtime configuration remains additive:

```env
MEMORY_BACKEND=mem0
MEM0_BASE_URL=http://127.0.0.1:6131
MEMORY_SUBJECT_USER_ID=local-user
MEMORY_PERSONA_ID=lumi
```

No chat-provider credentials are copied into the sidecar. `MEM0_LLM_*` is an
independent configuration surface.
