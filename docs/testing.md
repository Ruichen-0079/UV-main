# Testing

The MVP verification path uses TypeScript, Vitest, and a lightweight smoke script. Tests do not require real provider API keys.

## Commands

```bash
pnpm check
pnpm build
pnpm test
pnpm smoke
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
docker compose -f infra/docker-compose.yml up -d postgres
```

2. Apply migrations from `packages/memory/migrations`.
3. Run the server with `MEMORY_REPOSITORY=postgres` and a valid `DATABASE_URL`.
4. Use `POST /memory` and `GET /memory/recent`.
