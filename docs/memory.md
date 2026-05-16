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

The repository exposes vector search as an interface, but text fallback search with `ILIKE` is implemented for the MVP when embeddings are not configured.

## Manual Management

The Dashboard Memory page is a development console for manual memory management. It can:

- view memory details and debug metadata
- create manual memories with type, subtype, summary, importance, source, and tags
- edit content, summary, type, subtype, importance, emotion fields, tags, and safe metadata
- delete memories from the active repository
- search and filter memories by type, subtype, source, and importance

Manual memories should use `source=dashboard` or `source=manual`. Deleted memories are removed from retrieval results. Do not store API keys, passwords, tokens, Authorization headers, or other secrets in memory metadata or content.

## Prompt Safety

Raw chat logs are noisy and can overfit the companion to irrelevant phrasing. Before prompt injection, memory must be compressed into concise reconstructed context:

1. retrieve candidate memories
2. rank by relevance, recency, and importance
3. compress or use stored summaries
4. reconstruct a small prompt-ready memory block

This keeps prompts smaller, reduces accidental leakage of irrelevant history, and makes memory feel like understanding rather than transcript replay.
