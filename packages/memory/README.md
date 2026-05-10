# @companion/memory

Memory repository and service layer.

Responsibilities:

- Store and retrieve companion memories.
- Keep memory separate from raw chat logs.
- Rank, compress, and reconstruct memories before prompt injection.
- Provide a future PostgreSQL + pgvector repository behind stable interfaces.

The MVP includes:

- `PostgresMemoryRepository` for PostgreSQL + pgvector.
- `InMemoryMemoryRepository` for local development and tests.
- `MemoryService` for storing compressed interaction memories and retrieving prompt-ready memory summaries.
- `MemoryScorer` placeholder for importance scoring.
- `MemoryRetriever` placeholder for retrieval/ranking orchestration.

SQL migrations live in `migrations/`.
