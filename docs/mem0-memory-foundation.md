# Mem0 Memory Foundation (M0 + M1)

Status: **foundation only**. Formal chat read/write and Prompt injection are **not** wired.

## 1. Existing YUVI Memory (Legacy)

### Responsibilities

| Layer | Role |
|-------|------|
| `MemoryService` | extraction, admission, correction, retrieval orchestration, embeddings attach |
| `MemoryRepository` | in-memory or PostgreSQL CRUD + search |
| `MemoryRetriever` / `MemoryScorer` | ranking |
| Prompt Builder | formats retrieved memories for chat |
| Core runtime | `useMemory` / `readMemory` / `writeMemory` gates |

### Write path (legacy)

```text
message turn
→ extractCandidates (rule/LLM)
→ processCandidateForStorage (admission, dedupe, correction)
→ repository.createMemory (+ optional embedding)
```

### Read path (legacy)

```text
chat request (readMemory=true)
→ retrieveRelevantMemories / WithMetadata
→ rank/filter
→ Prompt Builder
→ chat provider
```

### useMemory behaviour

- Request options: `useMemory`, or split `readMemory` / `writeMemory`.
- Default when omitted: enabled (`true`).
- `useMemory=false` disables **both** read and write unless split flags override.
- Tests assert read-only / write-only splits in `apps/server`.

### Storage

- Dev default: `MEMORY_REPOSITORY=in-memory` (lost on restart).
- Durable: PostgreSQL `memories` table + optional pgvector on the same table (often 1536-d OpenAI-compatible embeddings).
- **Not** the Mem0 collection `yuvi_mem0_qwen3_1024_v1`.

### What stays / what Mem0 owns later

| Keep in YUVI | Later via Mem0 backend |
|--------------|------------------------|
| Admission policy, explicit remember, correction UX | Vector store + fact extraction (`infer`) |
| Prompt formatting & token budget | search/add/update/delete/history storage ops |
| useMemory gates, telemetry | embedding via Ollama for Mem0 path |

## 2. New MemoryBackend contract

TypeScript interface in `packages/memory/src/backend.ts`:

- `health`, `add`, `search`, `get`, `list`, `update`, `delete`, `history`

Implementations:

- `LegacyMemoryBackend` — wraps existing `MemoryRepository`
- `Mem0MemoryBackend` — HTTP client to sidecar `:6131`
- factory `createMemoryBackend({ kind })` — **default `legacy`**

## 3. Scope encoding

```text
yuvi:v1:user:{encodeURIComponent(userId)}:character:{encodeURIComponent(characterId)}
```

- Stable for same inputs
- Isolates user×character
- Used as Mem0 `user_id` only (no agent_id/run_id joint keys)
- `conversationId` stays metadata so long-term recall survives new conversations

## 4. Sidecar

Path: `services/memory-mem0/`

Stack: **Python 3.11 only** (formal baseline), FastAPI, Mem0 OSS (`mem0ai==0.1.107`), Ollama embedder, pgvector.

See `services/memory-mem0/README.md`.

### Embedding

- Model: **`yuvi-embedding:0.6b` only** (Ollama)
  - Same weights as `qwen3-embedding:0.6b`
  - Modelfile sets **`num_ctx 2048`** (lower VRAM vs base CONTEXT≈16384 / ~3.8 GB)
- Dimensions: **1024 only**
- Config fails fast on mismatch
- Live check: short zh/en/ja texts produced **bitwise-equal** vectors vs base model → same space

### Collection

- Name: `yuvi_mem0_qwen3_1024_v1` (**reused** after space verification)
- HNSW: on
- DiskANN: off
- Does not reuse YUVI `memories.embedding` rows
- If a future embedder is **not** space-compatible, create a **new** collection name — never mix

## 5. Runtime env (additive)

```env
MEMORY_BACKEND=mem0
MEM0_BASE_URL=http://127.0.0.1:6131
MEM0_RUNTIME_TIMEOUT_MS=600
MEM0_RUNTIME_HEALTH_TIMEOUT_MS=1000
# Explicit local single-user scope (required when request omits IDs)
MEMORY_SUBJECT_USER_ID=local-user
MEMORY_PERSONA_ID=lumi
```

Set `MEMORY_BACKEND=legacy` to keep the previous repository path.

## 6. Live chat integration (M2)

On `feat/mem0-live-integration` with `MEMORY_BACKEND=mem0`:

- **Scope**: `yuvi:v1:user:{userId}:character:{characterId}` from request and/or
  `MEMORY_SUBJECT_USER_ID` / `MEMORY_PERSONA_ID`. No silent `default-user` /
  `default-persona`. Missing IDs → skip search/add/delete, log
  `MEMORY_SCOPE_MISSING`, chat continues.
- **Read**: before chat provider call, `Mem0Backend.search` (600ms timeout, topK 8 → prompt max 5, ~600 tokens) via existing Prompt Builder. Failures → empty memory, chat continues.
- **Write routing** (exactly one path per completed turn):
  - `normal` → async `add(infer=true)` once
  - `explicit_remember` → async `add(infer=false)` fact only (never dual infer=true)
  - `explicit_forget` → search+delete in current scope only; no add / no Legacy
  - `cancelled_or_failed` → no write
- **Forget**: content-overlap gate (vector score near-zero must not block exact hits).
- **Legacy skip**: extractCandidates / processCandidate / repository LTM write / embedding path disabled for Mem0 mode.
- **No shadow dual-write**, no migration, no outbox in v1.
- Runtime boot does **not** require Sidecar healthy.

## 7. Memory LLM capability mode

When `MEM0_LLM_MODEL` / `MEM0_LLM_API_KEY` are unset:

- Sidecar starts with embedder + vector store
- No placeholder / forged API keys
- `infer=false` CRUD/search works
- `infer=true` → `MEMORY_LLM_NOT_CONFIGURED` (`retryable=false`)
- Health: `status=degraded`, `components.memoryLlm=not_configured`, `capabilities.infer=false`

History (mem0ai 0.1.107): normalized `MemoryHistoryEntry` list from SQLite history;
missing id or wrong scope → empty list (no undefined envelope).

## 8. Local data / teardown

- PG data: whatever host PostgreSQL uses for Mem0 connection string
- Collection name identifies Mem0 tables created by Mem0/pgvector driver
- Do not `DROP` YUVI legacy tables when rotating Mem0 collections
