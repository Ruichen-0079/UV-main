# Memory

Memory is not raw chat log injection. The runtime stores structured memories, retrieves candidates, ranks them, compresses them, and reconstructs prompt-safe context.

## Categories

- `working`: short-lived task/session state, such as the current goal or active preference.
- `episodic`: remembered interactions and events, stored as compact summaries rather than raw transcripts.
- `semantic`: stable facts about the user, companion, world, projects, or entities.
- `emotional`: affective signals such as valence, arousal, recurring stressors, and positive anchors.
- `procedural`: learned routines, instructions, workflows, and “how we do this” patterns.

## Storage

Development defaults to `MEMORY_REPOSITORY=in-memory`, which is useful for quick iteration but resets when the server restarts. Durable development memory uses PostgreSQL with pgvector after `MEMORY_REPOSITORY=postgres`, `DATABASE_URL`, and migrations are configured. Migrations live in:

```text
packages/memory/migrations/
```

Core tables:

- `memories`
- `entities`
- `relations`

The repository exposes vector search as an interface, but embeddings are intentionally not required yet. PostgreSQL mode uses YUVI Postgres Search v2 before embeddings: `pg_trgm` is enabled by migration, content and summary have trigram indexes, tags and metadata use GIN indexes, and structured fields such as scope, scopeId, memoryLayer, status, type, subtype, source, sourceTraceId, timestamps, and importance have supporting indexes for filtering and ranking. A built-in PostgreSQL full-text expression index using the `simple` config complements keyword and trigram matching.

Search covers content, summary, tags, type, subtype, scope, scopeId, memoryLayer, source/sourceTraceId, and safe metadata text. This supports Chinese, English, mixed Chinese/English queries such as `YUVI Runtime 是什么项目`, local paths like `C:\Users\...`, ports such as `6121`, URLs such as `ws://127.0.0.1:6121`, env keys such as `MEMORY_EXTRACTOR`, and commands such as `pnpm db:migrate`. Prompt Preview and memory search debug metadata can report `retrievalMode`, `matchedBy`, `score`, rank components, type/subtype/source/importance, and `sourceTraceId`.

## Memory Model v2

Memory records now carry the foundation for scoped and temporal memory:

- `scope`: `user`, `project`, `agent`, `plugin`, or `session`
- `scopeId`: optional scope identifier such as `yuvi-runtime`
- `memoryLayer`: `core`, `recall`, `archival`, or `working`
- `status`: `active`, `superseded`, `archived`, `forgotten`, or `expired`
- temporal fields: `observedAt`, `eventTime`, `validFrom`, `validUntil`, `expiresAt`, `lastAccessedAt`, `supersededAt`
- lightweight relation fields: `supersedes`, `supersededBy`, and `contradicts`

Default prompt retrieval only uses `active` memories whose validity window currently applies. `forgotten`, `expired`, and `superseded` memories are excluded by default. `archived` memories remain available for manual inspection but are not injected into prompts unless a future debug/history mode opts into them.

The default scope is `user`. YUVI project memories can be inferred as `scope=project` and `scopeId=yuvi-runtime`. `working` memories map to the `working` layer; stable semantic preferences and project facts map to `core`; episodic milestones and troubleshooting records map to `recall`.

## Read Pipeline v2

Prompt assembly now combines short-term Direct Context with long-term RelevantMemory. They are separate on purpose:

- `DirectContext` is bounded recent same-session context. It improves conversational continuity for recent turns, immediate confirmations, current task intent, and recent errors. It is not persisted by default.
- `RelevantMemory` is durable long-term memory retrieved from `MemoryService`, filtered by scope/status/time and ranked before prompt injection.

Default Direct Context settings are `DIRECT_CONTEXT_ENABLED=true`, `DIRECT_CONTEXT_MAX_TURNS=6`, and `DIRECT_CONTEXT_MAX_CHARS=6000`. The runtime trims oldest turns first, does not use LLM summarization, and redacts secret-like values before prompt injection.

Long-term prompt retrieval remains scope-aware, status-aware, and time-aware:

- Default prompt reads include `user` and `project:yuvi-runtime`; current-session reads also include `session:<sessionId>`.
- `agent` and `plugin` scopes are only included when the request supplies matching context.
- Unrelated project, plugin, or agent memories are filtered out before prompt injection.
- `forgotten`, `expired`, `superseded`, and `archived` memories are excluded from prompt injection by default.
- `includeArchived`, `includeSuperseded`, and `includeExpired` are manual/debug search options, not normal prompt defaults.
- `expiresAt`, `validUntil`, and future `validFrom` values are respected during retrieval.
- `lastAccessedAt` is updated when a memory is selected, so future ranking can use access recency.

Ranking combines keyword relevance, type/subtype priority, memory layer priority, importance, recency, access recency, source quality, and scope match quality. Core active memories in the current project/user scope are favored; low-importance verbose runtime episodic summaries, archival records, and unrelated scoped records are down-ranked or excluded.

Prompt Preview exposes explainable debug fields such as `retrievalScope`, `includedScopes`, `includeArchived`, `includeSuperseded`, `includeExpired`, `excludedByStatus`, `excludedByTime`, `excludedByScope`, `currentTime`, and per-memory `matchedBy`, `score`, optional rank components (`keywordScore`, `tagScore`, `trigramScore`, `fullTextScore`, `scopeScore`, `importanceScore`, `recencyScore`), `scope`, `memoryLayer`, `status`, temporal fields, and `excludedReason`.

PromptBuilder also injects a `CurrentTime` section containing the current ISO timestamp, timezone, and local date. RelevantMemory bullets may include compact hints such as `[project:yuvi-runtime][core][active]` so the model can reason about scope and freshness without receiving verbose metadata.

Prompt Preview reports Direct Context budget metadata: `directContextEnabled`, `directContextTurnCount`, `directContextCharCount`, `directContextTruncated`, and `directContextSource`. The prompt sections remain distinct:

```text
<CurrentTime>
...
</CurrentTime>

<DirectContext>
...
</DirectContext>

<RelevantMemory>
...
</RelevantMemory>
```

Graph reasoning over `supersedes`, `supersededBy`, and `contradicts` is future work. Automatic expiry and retention scheduling are also future work; forgetting is status-based for now.

## Manual Management

The Dashboard Memory page is a development console for manual memory management. It can:

- view memory details and debug metadata
- create manual memories with type, subtype, scope, layer, status, summary, importance, source, tags, and temporal fields
- edit content, summary, type, subtype, scope, layer, status, importance, emotion fields, tags, temporal fields, and safe metadata
- archive, restore, forget, or delete memories from the active repository
- search and filter memories by type, subtype, source, scope, scopeId, memory layer, status, importance, and opt-in archived/superseded/expired history

Manual memories should use `source=dashboard` or `source=manual`. Deleted memories are removed from retrieval results. Do not store API keys, passwords, tokens, Authorization headers, or other secrets in memory metadata or content.

Archive/restore/forget are the first forgetting foundation. Archive keeps a memory visible for manual management but excludes it from prompt injection. Forget marks a memory as `forgotten`, which excludes it from normal retrieval.

## Automatic Writes

Automatic memory writes are conservative. `readMemory` controls retrieval for prompt context, while `writeMemory` controls whether the runtime may write new memories after a turn. When `writeMemory=false`, the runtime must not write memory.

The rule-based extractor only proposes memories for durable signals such as explicit `remember` / `记住`, `from now on` / `以后`, long-term preferences, provider choices, project paths, repository paths, startup commands, configuration decisions, troubleshooting conclusions, stable workflow instructions, and project milestones. Ordinary questions, greetings, failed answers, and uncertain assistant responses are not stored automatically. Use the Dashboard Memory page for explicit manual corrections.

`MEMORY_EXTRACTOR=llm` is the default and uses the configured DeepSeek Reasoning provider when available, so it consumes reasoning tokens only when `writeMemory=true`. The LLM can only propose candidates; `MemoryService` validates, scores, deduplicates, and decides what to store. Invalid JSON fails closed, and unavailable reasoning providers fall back to the rule-based extractor. `MEMORY_EXTRACTOR=rule-based` remains available for deterministic no-token extraction.

## Candidate Review

The Dashboard exposes recent memory extraction candidates as development-only debug state. Candidate history is currently in-memory and volatile; it resets when the server restarts. Candidates are suggestions, not a separate source of truth. They show the extractor mode, source trace, type/subtype, preview text, summary, importance, confidence, tags, reason, and decision (`stored`, `rejected`, or `candidate`). Suspicious metadata keys such as API keys, tokens, passwords, bearer values, and Authorization headers are redacted.

From the Dashboard, a developer can accept, edit-and-save, or reject a recent candidate. Accepting a candidate writes it through the normal memory service path as a dashboard/manual memory; accepting an already stored candidate does not create a duplicate. Rejecting a candidate only updates the in-memory candidate history. LLM extraction never bypasses validation, scoring, or manual memory controls.

## Prompt Safety

Raw chat logs are noisy and can overfit the companion to irrelevant phrasing. Before prompt injection, memory must be compressed into concise reconstructed context:

1. retrieve candidate memories
2. rank by relevance, recency, and importance
3. compress or use stored summaries
4. reconstruct a small prompt-ready memory block

This keeps prompts smaller, reduces accidental leakage of irrelevant history, and makes memory feel like understanding rather than transcript replay.
