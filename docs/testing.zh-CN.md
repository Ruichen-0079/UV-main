# Testing

MVP 验证路径使用 TypeScript、Vitest 和轻量 smoke script。测试不需要真实 provider API key。

## Commands

```bash
pnpm check
pnpm build
pnpm test
pnpm smoke
```

在这台 Windows 机器上，如果 PowerShell 阻止 `pnpm.ps1` shim，请使用 `pnpm.cmd`：

```powershell
pnpm.cmd check
pnpm.cmd build
pnpm.cmd test
pnpm.cmd smoke
```

## What Is Covered

- TypeScript project reference 可以成功构建。
- 事件总线可以 publish、subscribe、wildcard-match 和 unsubscribe。
- 事件总线会隔离 subscriber failure，避免一个 listener 破坏另一个 listener。
- 提示词构建器会遵守配置的字符预算。
- 提供商注册表可以在没有真实 key 时初始化 mock provider。
- Provider error 会标准化为共享的 `ProviderError` code。
- 原始 provider response 默认省略，并且需要 `PROVIDER_INCLUDE_RAW_RESPONSES=true`。
- 即使可选的 reply 后记忆/TTS 副作用失败，运行时编排也会返回 reply。
- 记忆仓库可以创建和检索记录。
- 服务器处理：
  - `GET /health`
  - `POST /message`
  - `POST /memory`
  - `GET /memory/recent`

## Smoke Test

`pnpm smoke` 会构建仓库，以 mock/in-memory 模式启动构建后的服务器，然后验证：

1. Server starts.
2. `GET /health` returns `ok: true`.
3. `POST /message` returns `agent.reply`.
4. A memory record can be created.
5. Recent memories can be retrieved.

Smoke script 会设置：

```env
PROVIDER_ALLOW_MOCKS=true
MEMORY_REPOSITORY=memory
DEFAULT_EMBEDDING_PROVIDER=mock
```

## Real Provider Tests

真实 provider 调用刻意不放进默认测试套件。之后可以添加可选 integration tests，并在相关 env var 缺失时跳过。

Required examples:

- DeepSeek: `DEEPSEEK_API_KEY`, `DEEPSEEK_CHAT_MODEL`
- xAI TTS/Vision: `XAI_API_KEY`, `XAI_TTS_MODEL`, `XAI_VISION_MODEL`
- DashScope STT: `DASHSCOPE_API_KEY`, `DASHSCOPE_STT_MODEL`

## Database Verification

默认测试使用 in-memory memory storage。手动验证 PostgreSQL：

1. Start infra:

```bash
docker compose -f infra/docker-compose.yml up -d postgres
```

2. Apply migrations from `packages/memory/migrations`.
3. Run the server without `MEMORY_REPOSITORY=memory`.
4. Use `POST /memory` and `GET /memory/recent`.
