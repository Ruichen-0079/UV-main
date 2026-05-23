# Developer Quickstart

This guide gets the MVP runtime running locally with WSL/Linux scripts, Docker development infra, in-memory memory by default, and mock optional providers when real keys are not configured.

## 1. Prerequisites

- Node.js 22 or newer
- pnpm 9 or newer
- Docker, or WSL2 with Docker Engine
- Docker development infra through `infra/docker-compose.yml`

Check local tools:

```bash
node --version
pnpm --version
docker --version
docker compose version
```

On Windows PowerShell, use `pnpm.cmd` if `pnpm` is blocked by execution policy.

## 2. Environment Setup

Copy the example env file:

```bash
cp .env.example .env
```

PowerShell:

```powershell
Copy-Item .env.example .env
```

Development defaults to in-memory memory:

```env
MEMORY_REPOSITORY=in-memory
MEMORY_EXTRACTOR=llm
EVENT_BUS=in-memory
DIRECT_CONTEXT_ENABLED=true
DIRECT_CONTEXT_MAX_TURNS=6
DIRECT_CONTEXT_MAX_CHARS=6000
```

`EVENT_BUS=in-memory` is the only implemented event bus runtime mode today. `EVENT_BUS=nats` is a reserved future boundary and will fail clearly until NATS integration is implemented.

`MEMORY_EXTRACTOR=llm` is the default and uses DeepSeek Reasoning to propose memory candidates when configured. It consumes reasoning tokens only on turns where `writeMemory=true`, and candidates are still validated/scored by `MemoryService` before storage. If DeepSeek Reasoning is not configured, YUVI falls back safely to `rule-based`. Use `MEMORY_EXTRACTOR=rule-based` for deterministic no-token extraction.

Direct Context is enabled by default. It injects bounded recent same-session turns into a separate `<DirectContext>` prompt section for conversational continuity. It is not long-term memory and is trimmed by `DIRECT_CONTEXT_MAX_TURNS` and `DIRECT_CONTEXT_MAX_CHARS`.

Fill DeepSeek values when you want real provider calls:

```env
DEEPSEEK_API_BASEURL=https://api.deepseek.com
DEEPSEEK_API_KEY=replace-with-your-key
DEEPSEEK_CHAT_MODEL=replace-with-chat-model
DEEPSEEK_REASONING_MODEL=replace-with-reasoning-model
```

Optional xAI values for TTS and Vision:

```env
XAI_API_BASEURL=https://api.x.ai/v1
XAI_API_KEY=replace-with-your-key
XAI_TTS_MODEL=replace-with-tts-model
XAI_TTS_VOICE=replace-with-voice
XAI_VISION_MODEL=replace-with-vision-model
```

Optional Alibaba DashScope values for STT:

```env
DASHSCOPE_API_BASEURL=https://dashscope.aliyuncs.com/api/v1
DASHSCOPE_API_KEY=replace-with-your-key
DASHSCOPE_STT_MODEL=replace-with-stt-model
```

Optional local Dashboard/API development guard:

```env
DASHBOARD_DEV_TOKEN=replace-with-local-dev-token
```

When set, sensitive development endpoints such as runtime settings updates and provider verification require the `X-YUVI-Dev-Token` header. The token is never returned by the API and should not be logged.

Normal development/runtime is real-provider-first. Use explicit mock mode only for CI, tests, or intentional offline work:

```env
NODE_ENV=development
PROVIDER_ALLOW_MOCKS=true
DEFAULT_EMBEDDING_PROVIDER=mock
```

Keep `SERVER_HOST=127.0.0.1` for local development. If you intentionally set `SERVER_HOST=0.0.0.0`, the server prints a warning because the development API may be reachable from the local network.

`./scripts/dev.sh` loads `.env` automatically and does not print secret values. If you start the server without the scripts, load `.env` into your shell first.

Bash or WSL:

```bash
set -a
source .env
set +a
```

PowerShell:

```powershell
Get-Content .env |
  Where-Object { $_ -match '^\s*[^#][^=]+=' } |
  ForEach-Object {
    $name, $value = $_ -split '=', 2
    Set-Item -Path "Env:$name" -Value $value
  }
```

## 3. Start Infrastructure

From the repo root:

```bash
docker compose -f infra/docker-compose.yml up -d
```

Check containers:

```bash
docker compose -f infra/docker-compose.yml ps
```

This starts PostgreSQL with pgvector, Redis, and NATS with JetStream enabled.

## 4. Optional PostgreSQL Memory Mode

The development default is in-memory memory. To switch to PostgreSQL memory, set:

```env
MEMORY_REPOSITORY=postgres
DATABASE_URL=postgres://yuvi:yuvi_dev_password@localhost:5432/yuvi
```

Then apply the SQL migration:

Bash or WSL:

```bash
pnpm db:migrate
```

Migrations enable Postgres Search v2 and optional pgvector retrieval for long-term memory: `pg_trgm` trigram indexes, structured filters, tag/metadata indexes, a built-in full-text index, embedding metadata columns, and pgvector storage. In-memory mode remains simpler and resets on restart; Postgres mode persists memory and improves retrieval for mixed Chinese/English text, commands, paths, URLs, ports, env keys, provider names, and semantic matches.

Embeddings are optional. Real-provider-first configuration uses:

```env
EMBEDDING_PROVIDER=openai-compatible
EMBEDDING_DIMENSIONS=1536
```

Mock embeddings remain available for explicit offline/test mode with `PROVIDER_ALLOW_MOCKS=true` and `EMBEDDING_PROVIDER=mock`; they report `semanticEmbedding=false` because they do not provide real semantic similarity. Real OpenAI-compatible embeddings may consume provider tokens. Keyword/trigram/full-text search remains important for exact technical queries, so paths, ports, commands, env vars, provider names, and error messages can still outrank vague vector matches. Existing Postgres memories can be embedded after migrations:

```bash
pnpm memory:embed:backfill
```

Verify the memory table exists:

```bash
docker compose -f infra/docker-compose.yml exec postgres \
  psql -U yuvi -d yuvi -c "\dt"
```

Run a Postgres-backed smoke test:

```bash
pnpm smoke:postgres
```

Reset development database volumes only when you intentionally want to delete local development data. Prefer the guarded helper:

```bash
pnpm db:reset:dev
```

Warning: this deletes the development PostgreSQL data volume.

Advanced/manual reset:

```bash
docker compose -f infra/docker-compose.yml down -v
```

Changing `POSTGRES_USER` or `POSTGRES_PASSWORD` in `infra/docker-compose.yml` only affects a brand-new database volume. Existing Postgres volumes keep the role and password they were initialized with.

## 5. Start Development Services

Install dependencies if needed:

```bash
pnpm install
```

Start the server and web dashboard:

```bash
./scripts/dev.sh
```

For lightweight in-memory development without starting Docker infrastructure:

```bash
SKIP_INFRA=1 ./scripts/dev.sh
```

`dev.sh` still loads `.env` first and `.env.local` second, and it does not print secret values.

Windows LTSC wrapper:

```cmd
scripts\start-dev.cmd
```

Development URLs:

```text
Server: http://localhost:6121
Web UI: http://localhost:5173
WebSocket: ws://localhost:6121/ws
```

Check or stop services:

```bash
./scripts/health.sh
./scripts/stop.sh
```

## 6. Test Health Endpoint

```bash
curl http://127.0.0.1:6121/health
```

Expected shape:

```json
{
  "ok": true
}
```

`ok` depends on server, database, and chat provider status. Optional providers can report `unavailable`.

## 7. Test Message Endpoint

```bash
curl -X POST http://127.0.0.1:6121/message \
  -H "content-type: application/json" \
  -d '{"sessionId":"dev","text":"Hello companion runtime","options":{"useMemory":true,"voiceOutput":false}}'
```

PowerShell:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:6121/message `
  -ContentType "application/json" `
  -Body '{"sessionId":"dev","text":"Hello companion runtime","options":{"useMemory":true,"voiceOutput":false}}'
```

With mocks enabled, the reply starts with `Mock reply:` when real provider keys are unavailable.

## 8. Test Memory Endpoint

Create a memory:

```bash
curl -X POST http://127.0.0.1:6121/memory \
  -H "content-type: application/json" \
  -d '{"type":"semantic","content":"The developer is testing the quickstart.","source":"quickstart","tags":["dev"]}'
```

Read recent memories:

```bash
curl "http://127.0.0.1:6121/memory/recent?limit=5"
```

Search memory:

```bash
curl "http://127.0.0.1:6121/memory/search?q=developer&limit=5"
```

For Unicode queries, prefer URL encoding or the JSON POST endpoint:

```bash
curl -G "http://127.0.0.1:6121/memory/search" --data-urlencode "q=模型供应商偏好"
curl -X POST "http://127.0.0.1:6121/memory/search" \
  -H "content-type: application/json" \
  -d '{"q":"模型供应商偏好","limit":10}'
```

PowerShell:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:6121/memory `
  -ContentType "application/json" `
  -Body '{"type":"semantic","content":"The developer is testing the quickstart.","source":"quickstart","tags":["dev"]}'

Invoke-RestMethod "http://127.0.0.1:6121/memory/recent?limit=5"
```

## 9. Smoke Test

```bash
pnpm smoke
```

The smoke script builds the repo, starts the built server in explicit mock/in-memory mode (`PROVIDER_ALLOW_MOCKS=true`, `EMBEDDING_PROVIDER=mock`), and verifies `GET /health`, `POST /message`, `POST /memory`, `GET /memory/recent`, `GET /memory/search?q=...`, and `POST /memory/search`.

For PostgreSQL memory mode, start Docker infra and run:

```bash
pnpm smoke:postgres
```

## 10. Common Errors

### Missing API Key

Symptoms:

- `MISSING_API_KEY`
- startup or health check says provider config is incomplete

Fix:

```env
DEEPSEEK_API_KEY=your-real-key
PROVIDER_ALLOW_MOCKS=true
```

Use mocks for development, or provide real keys for production-like runs.

### Database Connection Failed

Symptoms:

- `/health` reports database unhealthy
- server logs connection errors

Fix:

```bash
docker compose -f infra/docker-compose.yml ps
docker compose -f infra/docker-compose.yml up -d postgres
```

Confirm `DATABASE_URL` matches:

```env
DATABASE_URL=postgres://yuvi:yuvi_dev_password@localhost:5432/yuvi
```

### Role "yuvi" Does Not Exist

Symptoms:

- `Role "yuvi" does not exist`
- `password authentication failed for user "yuvi"`
- `pnpm db:migrate` fails even though `infra/docker-compose.yml` contains `POSTGRES_USER=yuvi`

Cause:

PostgreSQL initializes roles only when the Docker data volume is created. If the existing volume was created by an older compose file, it may still contain previous `airi/airi_dev_password` or `companion/companion` credentials. Changing `POSTGRES_USER` later does not rewrite an existing volume.

Option A, reset development data and recreate the volume with current credentials:

```bash
pnpm db:reset:dev
docker compose -f infra/docker-compose.yml up -d
pnpm db:migrate
```

Warning: resetting volumes deletes development database data.

Option B, keep using the old local volume credentials by setting `DATABASE_URL` to the exact
user, password, and database name that originally initialized your local Docker volume.

Older local volumes may have used `companion/companion` or `airi/airi_dev_password`, but those are
not current defaults. Fresh development environments should use:

```env
DATABASE_URL=postgres://yuvi:yuvi_dev_password@localhost:5432/yuvi
```

Option C, manually create the current role inside the existing development database:

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

### Provider Unavailable

Symptoms:

- optional TTS, STT, Vision, or Embedding health is `unavailable`
- `PROVIDER_UNAVAILABLE`

Fix:

- For optional providers, this is acceptable in MVP development.
- Fill the provider-specific API key and model variables when you need real calls.
- Use `PROVIDER_ALLOW_MOCKS=true` only for explicit test/CI/offline mock mode.

### Model Not Found

Symptoms:

- `MODEL_NOT_FOUND`

Fix:

Check model env vars:

```env
DEEPSEEK_CHAT_MODEL=...
DEEPSEEK_REASONING_MODEL=...
XAI_TTS_MODEL=...
XAI_VISION_MODEL=...
DASHSCOPE_STT_MODEL=...
```

Do not hardcode model names in source files.

### Invalid Key

Symptoms:

- `INVALID_API_KEY`
- HTTP 401 from provider

Fix:

- Recheck the key value in `.env`.
- Make sure the shell was reloaded after editing `.env`.
- Confirm the key belongs to the provider configured by `DEFAULT_*_PROVIDER`.

### Docker Not Running

Symptoms:

- `Cannot connect to the Docker daemon`
- compose commands fail

Fix:

Start Docker Desktop, or start Docker Engine inside WSL2:

```bash
sudo service docker start
docker ps
```

## 10. Notes For Windows LTSC Users

- Prefer WSL2 + Ubuntu + Docker Engine.
- Avoid relying on Docker Desktop if your Windows LTSC version is unsupported.
- Keep project files inside the WSL filesystem, for example `~/src/ai-companion-runtime`, for better file watcher and dependency install performance.
- Run `pnpm install`, `./scripts/dev.sh`, and Docker commands inside WSL when possible.
- If working from PowerShell, use `pnpm.cmd` when the `pnpm.ps1` shim is blocked.
