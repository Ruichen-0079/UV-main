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
  - `DELETE /memory/:id`
  - `GET /memory/recent`
  - `GET /memory/search?q=...`

## Smoke Test

`pnpm smoke` builds the repo, starts the built server in mock/in-memory mode, then verifies:

1. Server starts.
2. `GET /health` returns `ok: true`.
3. `POST /message` returns `agent.reply`.
4. A memory record can be created.
5. Recent memories can be retrieved.
6. Memory search returns a matching record.

Manual memory management endpoint tests cover reading memory details, editing safe structured fields, rejecting invalid importance values, rejecting unsafe metadata keys, and deleting records so they no longer appear in search.

The smoke script sets:

```env
PROVIDER_ALLOW_MOCKS=true
MEMORY_REPOSITORY=in-memory
DEFAULT_EMBEDDING_PROVIDER=mock
```

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

Option B, keep the old local credentials:

```env
DATABASE_URL=postgres://companion:companion@localhost:5432/companion
```

For an intermediate old volume, you may need:

```env
DATABASE_URL=postgres://airi:airi_dev_password@localhost:5432/companion
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
