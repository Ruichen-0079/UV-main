# Developer Quickstart

本指南帮助你在本地运行 MVP 运行时，包含 PostgreSQL + pgvector、Redis、内存事件总线，以及在未配置真实 key 时使用的 mock optional providers。

## 1. Prerequisites

- Node.js 22 或更新版本
- pnpm 9 或更新版本
- Docker，或带 Docker Engine 的 WSL2
- 通过 `infra/docker-compose.yml` 启动 PostgreSQL + pgvector

检查本地工具：

```bash
node --version
pnpm --version
docker --version
docker compose version
```

在 Windows PowerShell 上，如果 `pnpm` 被 execution policy 阻止，请使用 `pnpm.cmd`。

推荐的开发路径是 WSL-first：在 Ubuntu WSL 的 repo root 中运行 Node、pnpm 和 Docker 命令。Windows LTSC 主机上的 `.cmd` 文件只作为便利入口，它们会转入 WSL 执行，不要求 Windows host 安装 git、Docker、Node.js 或 pnpm。

## 2. Environment Setup

复制示例 env 文件：

```bash
cp .env.example .env
```

PowerShell:

```powershell
Copy-Item .env.example .env
```

`.env` 是敏感本地状态。不要打印、提交或粘贴其中的 API key、Authorization header、token 或 password。文档和示例只能使用 placeholder。

填写 MVP 必需值：

```env
DATABASE_URL=postgres://companion:companion@localhost:5432/companion
DEEPSEEK_API_BASEURL=https://api.deepseek.com
DEEPSEEK_API_KEY=replace-with-your-key
DEEPSEEK_CHAT_MODEL=replace-with-chat-model
DEEPSEEK_REASONING_MODEL=replace-with-reasoning-model
```

可选的 xAI TTS 和 Vision 变量：

```env
XAI_API_BASEURL=https://api.x.ai/v1
XAI_API_KEY=replace-with-your-key
XAI_TTS_MODEL=replace-with-tts-model
XAI_TTS_VOICE=replace-with-voice
XAI_VISION_MODEL=replace-with-vision-model
```

可选的 Alibaba DashScope STT 变量：

```env
DASHSCOPE_API_BASEURL=https://dashscope.aliyuncs.com/api/v1
DASHSCOPE_API_KEY=replace-with-your-key
DASHSCOPE_STT_MODEL=replace-with-stt-model
```

如果本地开发时没有真实 optional provider key，保留：

```env
NODE_ENV=development
PROVIDER_ALLOW_MOCKS=true
DEFAULT_EMBEDDING_PROVIDER=mock
```

服务器当前直接读取 `process.env`；启动前请把 `.env` 加载进 shell。

Bash 或 WSL：

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

在 repo root 运行：

```bash
docker compose -f infra/docker-compose.yml up -d
```

检查容器：

```bash
docker compose -f infra/docker-compose.yml ps
```

NATS 已准备好但当前可选。也要启动它时运行：

```bash
docker compose -f infra/docker-compose.yml --profile nats up -d
```

## 4. Run Migrations

目前还没有 migration runner script。请直接应用 SQL 文件。

Bash 或 WSL：

```bash
docker compose -f infra/docker-compose.yml exec -T postgres \
  psql -U companion -d companion < packages/memory/migrations/001_init_memory.sql
```

PowerShell:

```powershell
Get-Content packages/memory/migrations/001_init_memory.sql |
  docker compose -f infra/docker-compose.yml exec -T postgres psql -U companion -d companion
```

验证 memory table 存在：

```bash
docker compose -f infra/docker-compose.yml exec postgres \
  psql -U companion -d companion -c "\dt"
```

## 5. Start Server

如果还没安装依赖：

```bash
pnpm install
```

启动服务器：

```bash
pnpm dev
```

PowerShell:

```powershell
pnpm.cmd dev
```

默认 URL：

```text
http://127.0.0.1:3000
```

## Developer Scripts

WSL / Linux:

```bash
./scripts/dev.sh
./scripts/health.sh
./scripts/stop.sh
```

Windows host convenience wrappers:

```cmd
scripts\check-env.cmd
scripts\start-dev.cmd
scripts\stop-dev.cmd
```

这些 wrapper 会使用：

```text
wsl -d Ubuntu --cd /home/administrator/uv-main/uv-main ...
```

当前 dashboard 尚未实现，`apps/web` 还不存在。Dashboard 的未来范围记录在 `docs/dashboard.zh-CN.md`。

## 6. Test Health Endpoint

```bash
curl http://127.0.0.1:3000/health
```

期望结构：

```json
{
  "ok": true
}
```

`ok` 取决于 server、database 和 chat provider 状态。Optional providers 可以报告 `unavailable`。

## 7. Test Message Endpoint

```bash
curl -X POST http://127.0.0.1:3000/message \
  -H "content-type: application/json" \
  -d '{"sessionId":"dev","content":"Hello companion runtime"}'
```

PowerShell:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:3000/message `
  -ContentType "application/json" `
  -Body '{"sessionId":"dev","content":"Hello companion runtime"}'
```

启用 mock 时，如果真实 provider key 不可用，回复会以 `Mock reply:` 开头。

## 8. Test Memory Endpoint

创建一条记忆：

```bash
curl -X POST http://127.0.0.1:3000/memory \
  -H "content-type: application/json" \
  -d '{"type":"semantic","content":"The developer is testing the quickstart.","source":"quickstart","tags":["dev"]}'
```

读取最近记忆：

```bash
curl "http://127.0.0.1:3000/memory/recent?limit=5"
```

PowerShell:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:3000/memory `
  -ContentType "application/json" `
  -Body '{"type":"semantic","content":"The developer is testing the quickstart.","source":"quickstart","tags":["dev"]}'

Invoke-RestMethod "http://127.0.0.1:3000/memory/recent?limit=5"
```

## 9. Common Errors

### Missing API Key

症状：

- `MISSING_API_KEY`
- startup 或 health check 提示 provider config 不完整

修复：

```env
DEEPSEEK_API_KEY=your-real-key
PROVIDER_ALLOW_MOCKS=true
```

开发时使用 mock，或为 production-like 运行提供真实 key。

### Database Connection Failed

症状：

- `/health` 报告 database unhealthy
- server log 出现 connection error

修复：

```bash
docker compose -f infra/docker-compose.yml ps
docker compose -f infra/docker-compose.yml up -d postgres
```

确认 `DATABASE_URL` 匹配：

```env
DATABASE_URL=postgres://companion:companion@localhost:5432/companion
```

### Provider Unavailable

症状：

- optional TTS、STT、Vision 或 Embedding health 为 `unavailable`
- `PROVIDER_UNAVAILABLE`

修复：

- 对 optional providers 来说，这在 MVP development 中是可接受的。
- 本地工作设置 `PROVIDER_ALLOW_MOCKS=true`。
- 需要真实调用时，填写对应 provider 的 API key 和 model 变量。

### Model Not Found

症状：

- `MODEL_NOT_FOUND`

修复：

检查 model env vars：

```env
DEEPSEEK_CHAT_MODEL=...
DEEPSEEK_REASONING_MODEL=...
XAI_TTS_MODEL=...
XAI_VISION_MODEL=...
DASHSCOPE_STT_MODEL=...
```

不要在 source file 中硬编码 model name。

### Invalid Key

症状：

- `INVALID_API_KEY`
- provider 返回 HTTP 401

修复：

- 重新检查 `.env` 中的 key。
- 确认编辑 `.env` 后已经重新加载 shell。
- 确认 key 属于 `DEFAULT_*_PROVIDER` 配置的 provider。

### Docker Not Running

症状：

- `Cannot connect to the Docker daemon`
- compose command 失败

修复：

启动 Docker Desktop，或在 WSL2 中启动 Docker Engine：

```bash
sudo service docker start
docker ps
```

## 10. Notes For Windows LTSC Users

- 优先使用 WSL2 + Ubuntu + Docker Engine。
- 如果你的 Windows LTSC 版本不受支持，避免依赖 Docker Desktop。
- 为了更好的 file watcher 和 dependency install 性能，请把项目文件放在 WSL filesystem 中，例如 `~/src/ai-companion-runtime`。
- 尽可能在 WSL 中运行 `pnpm install`、`pnpm dev` 和 Docker command。
- 如果从 PowerShell 工作，当 `pnpm.ps1` shim 被阻止时使用 `pnpm.cmd`。
