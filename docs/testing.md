# Testing

The MVP verification path uses TypeScript, Vitest, and a lightweight smoke script. Tests do not require real provider API keys.

## Commands

```bash
pnpm check
pnpm build
pnpm test
pnpm smoke
pnpm db:migrate
```

On this Windows machine, use `pnpm.cmd` if PowerShell blocks the `pnpm.ps1` shim:

```powershell
pnpm.cmd check
pnpm.cmd build
pnpm.cmd test
pnpm.cmd smoke
```

## What Is Covered

- TypeScript project references build successfully.
- Event bus can publish, subscribe, wildcard-match, and unsubscribe.
- Event bus isolates subscriber failures so one listener does not break another.
- Prompt builder respects a configured character budget.
- Provider registry can initialize mock providers without real keys.
- Provider errors normalize to shared `ProviderError` codes.
- Raw provider responses are omitted by default and require `PROVIDER_INCLUDE_RAW_RESPONSES=true`.
- Runtime orchestration returns a reply even when optional post-reply memory/TTS side effects fail.
- Memory repository can create and retrieve records.
- Server handles:
  - `GET /health`
  - `POST /message`
  - `POST /memory`
  - `GET /memory/:id`
  - `PATCH /memory/:id`
  - `POST /memory/:id/archive`
  - `POST /memory/:id/restore`
  - `POST /memory/:id/forget`
  - `DELETE /memory/:id`
  - `GET /memory/recent`
  - `GET /memory/search?q=...`
  - `POST /memory/search`

## Smoke Test

`pnpm smoke` builds the repo, starts the built server in mock/in-memory mode, then verifies:

1. Server starts.
2. `GET /health` returns `ok: true`.
3. `POST /message` returns `agent.reply`.
4. A memory record can be created.
5. Recent memories can be retrieved.
6. Memory search returns a matching record through both GET and JSON POST.

Manual memory management endpoint tests cover reading memory details, editing safe structured fields, rejecting invalid importance values, rejecting unsafe metadata keys, archiving/restoring/forgetting records, and deleting records so they no longer appear in search.

Memory read pipeline tests cover scope-aware, status-aware, and time-aware retrieval. Active scoped memories are eligible for prompt context, while forgotten, expired, superseded, archived, future-valid, and unrelated project/plugin memories are excluded by default. Manual search can opt into archived, superseded, or expired records for debugging. Prompt Preview tests assert `CurrentTime`, retrieval scope metadata, exclusion counters, retrieval mode, matched fields, scores, rank components where available, and safe per-memory debug details.

Direct Context tests cover same-session recent-turn injection, unrelated-session isolation, oldest-turn trimming by turn/character budget, separation from `RelevantMemory`, and redaction of secret-like strings. Direct Context is short-term prompt context only; it does not create long-term memories unless the normal `writeMemory` extraction path independently accepts a candidate.

The smoke script sets:

```env
PROVIDER_ALLOW_MOCKS=true
MEMORY_REPOSITORY=in-memory
MEMORY_EXTRACTOR=llm
EVENT_BUS=in-memory
DIRECT_CONTEXT_ENABLED=true
DIRECT_CONTEXT_MAX_TURNS=6
DIRECT_CONTEXT_MAX_CHARS=6000
DEFAULT_EMBEDDING_PROVIDER=mock
```

`MEMORY_EXTRACTOR=llm` is the default, but smoke tests without real DeepSeek Reasoning credentials fall back safely to rule-based extraction and do not require tokens. Set `MEMORY_EXTRACTOR=rule-based` when you need deterministic no-token extractor behavior.

Normal development/runtime is real-provider-first (`PROVIDER_ALLOW_MOCKS=false`). Tests and CI explicitly set `PROVIDER_ALLOW_MOCKS=true` and `DEFAULT_EMBEDDING_PROVIDER=mock` so they never require real API keys. Mock embeddings report `semanticEmbedding=false`; they validate the pipeline but do not provide real semantic similarity.

Embedding verification is explicit. `POST /providers/verify/embedding` and the Dashboard **Verify Embedding** button call the active embedding provider with a small test string, may consume provider usage, and return only safe provider/model/dimension/latency metadata. Default tests use mock embedding or stubbed HTTP responses. A dimension mismatch returns `ok=false` with expected and actual dimensions, and raw vectors/API keys are never returned.

`EVENT_BUS=nats` is reserved for future support and is expected to fail clearly until the NATS runtime adapter is implemented. For lightweight local smoke checks that do not need Docker infrastructure, start development with:

```bash
SKIP_INFRA=1 ./scripts/dev.sh
```

If `DASHBOARD_DEV_TOKEN` is configured, sensitive development endpoints require the `X-YUVI-Dev-Token` header. Default tests leave it unset so local development remains frictionless.

Memory Maintenance Scheduler v1 is disabled by default in tests:

```env
MEMORY_MAINTENANCE_ENABLED=false
MEMORY_MAINTENANCE_RUN_ON_STARTUP=false
MEMORY_MAINTENANCE_INTERVAL_MINUTES=0
MEMORY_MAINTENANCE_LIMIT=500
```

Scheduler-specific tests enable it explicitly and assert startup runs, interval runs, status reporting, bounded limits, no hard delete, and Fastify `onClose` timer cleanup. The scheduler only calls Memory Maintenance v1, so it marks expired/stale state and audits supersession inconsistencies; it does not purge memories.

## Real Provider Tests

Real provider calls are intentionally not part of the default test suite. Add optional integration tests later and skip them unless the relevant env vars are present.

Required examples:

- DeepSeek: `DEEPSEEK_API_KEY`, `DEEPSEEK_CHAT_MODEL`
- xAI TTS/Vision: `XAI_API_KEY`, `XAI_TTS_MODEL`, `XAI_VISION_MODEL`
- DashScope STT: `DASHSCOPE_API_KEY`, `DASHSCOPE_STT_MODEL`

## Database Verification

Default tests use in-memory memory storage. To verify PostgreSQL manually:

1. Start infra:

```bash
docker compose -f infra/docker-compose.yml up -d
```

2. Apply migrations:

```bash
pnpm db:migrate
```

3. Run the smoke test in Postgres mode:

```bash
pnpm smoke:postgres
```

4. Or run the server with `MEMORY_REPOSITORY=postgres` and a valid `DATABASE_URL`, then use `POST /memory`, `GET /memory/recent`, and `GET /memory/search?q=...`.

Postgres memory search uses hybrid retrieval. Migrations enable `pg_trgm`, trigram search, built-in full-text search with the PostgreSQL `simple` config, pgvector storage, embedding metadata columns, and indexes for content, summary, tags, type/subtype, scope/scopeId, memoryLayer, status, source/sourceTraceId, temporal fields, createdAt, importance, metadata, and embedding metadata. Mixed Chinese/English queries, paths, URLs, ports, env keys, provider names, and commands remain keyword/trigram-first so exact technical matches outrank vague vector matches.

Embedding retrieval is optional. `EMBEDDING_PROVIDER=openai-compatible` is the real-provider-first mode when configured. `EMBEDDING_PROVIDER=mock` is reserved for deterministic local/CI/offline behavior and reports `semanticEmbedding=false`. Real OpenAI-compatible embedding providers may consume tokens. If embedding generation fails, writes still succeed without vectors and retrieval falls back to keyword/trigram/full-text search. Existing Postgres memories can be backfilled after `pnpm db:migrate`:

DashScope `text-embedding-v4` can be tested through OpenAI-compatible mode:

```env
EMBEDDING_PROVIDER=openai-compatible
EMBEDDING_API_BASEURL=https://dashscope.aliyuncs.com/compatible-mode/v1
EMBEDDING_API_KEY=<DashScope API key>
EMBEDDING_MODEL=text-embedding-v4
EMBEDDING_DIMENSIONS=1536
```

```bash
pnpm memory:embed:backfill
pnpm memory:embed:backfill -- --dry-run
pnpm memory:embed:backfill -- --limit 100
pnpm memory:embed:backfill -- --force
```

Backfill skips already embedded memories by default. `--force` re-embeds them, `--dry-run` reports what would happen without writes, and `--scope`, `--scopeId`, and `--status` bound the scanned set. The script summarizes scanned/skipped/embedded/failed rows and fails clearly on provider unavailability or vector dimension mismatch without printing secrets.

Graph reasoning over supersession/contradiction fields and retention purge scheduling are intentionally not part of the default tests yet. They are future work on top of the status and temporal fields.

To reset development database volumes, prefer the guarded helper:

```bash
pnpm db:reset:dev
```

Warning: this deletes development PostgreSQL data.

Advanced/manual reset:

```bash
docker compose -f infra/docker-compose.yml down -v
```

Changing `POSTGRES_USER` or `POSTGRES_PASSWORD` in `infra/docker-compose.yml` does not change an existing Postgres data volume. PostgreSQL roles are initialized only when the volume is first created.

The server registers a shutdown hook that calls the active memory repository `close()` method. In PostgreSQL memory mode this closes the underlying pg pool; in-memory mode is unaffected.

## Troubleshooting Old Dev Volumes

### Role "yuvi" Does Not Exist

Symptoms:

- `Role "yuvi" does not exist`
- `password authentication failed for user "yuvi"`
- `pnpm db:migrate` fails against a container that otherwise starts normally

Cause:

The Docker volume was initialized before the current `yuvi/yuvi_dev_password` development credentials. The old volume may still contain previous `airi/airi_dev_password` or `companion/companion` credentials.

Option A, reset development volumes:

```bash
pnpm db:reset:dev
docker compose -f infra/docker-compose.yml up -d
pnpm db:migrate
```

This deletes development database data.

Option B, keep the old local credentials by setting `DATABASE_URL` to the exact user, password, and
database name that originally initialized your local Docker volume.

Older local volumes may have used `companion/companion` or `airi/airi_dev_password`, but those are
not current defaults. Fresh development environments should use:

```env
DATABASE_URL=postgres://yuvi:yuvi_dev_password@localhost:5432/yuvi
```

Option C, manually create the current role in the existing dev database:

```bash
docker exec -it companion-postgres psql -U companion -d companion
```

Then run SQL equivalent to:

```sql
create role yuvi with login password 'yuvi_dev_password';
create database yuvi owner yuvi;
grant all privileges on database yuvi to yuvi;
grant all privileges on all tables in schema public to yuvi;
grant all privileges on all sequences in schema public to yuvi;
```
