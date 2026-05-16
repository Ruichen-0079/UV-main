# Developer Quickstart

本指南帮助你在 Windows LTSC + WSL2 环境中运行 AI Companion Runtime。本项目目标是构建一个事件驱动、本地优先、可扩展的 Companion Runtime，并逐步支持 memory、prompt builder、provider abstraction、developer dashboard、future Tauri desktop app、future Live2D / VRM / voice / vision integration。

推荐仓库路径：

```text
~/uv-main
```

Windows 原路径参考：

```text
C:\Users\Administrator.DESKTOP-NPU6DHJ\Desktop\uv-main
```

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

推荐的开发路径是 WSL-first：在 Ubuntu WSL 的 repo root 中运行 Node、pnpm 和 Docker 命令。Windows LTSC 主机上的 `.cmd` 文件只作为便利入口，它们会转入 WSL 执行，不要求 Windows host 安装 git、Docker、Node.js、pnpm 或 Docker Desktop。

开发期使用 WSL2 + Docker Engine 的原因：

- Windows LTSC 上 Docker Desktop 可能不可用或不稳定。
- WSL filesystem 中的 dependency install 和 file watcher 通常更可靠。
- Node.js、pnpm、Docker、docker compose 都在 Ubuntu 中运行，排错边界更清晰。
- future production desktop mode 不会依赖 WSL、Docker、Node.js、pnpm、PostgreSQL、Redis 或 NATS。

## 2. Environment Setup

复制示例 env 文件到本地 `.env`：

```bash
cp .env.example .env
```

PowerShell:

```powershell
Copy-Item .env.example .env
```

`.env.example` 只保存占位配置和空 secret。`.env` 是敏感本地状态，只能保存在本机，不要打印、提交或粘贴其中的 API key、Authorization header、token 或 password。

Dashboard Settings 保存的本地覆盖配置会写入 `.env.local`，不会修改已提交的 `.env.example`，也不会直接显示原始 API key。开发脚本会先加载 `.env`，再加载 `.env.local`，因此 `.env.local` 会在重启后覆盖 `.env`。

Settings 页面会显示配置分层：

- Base `.env`：基础本地配置文件。
- Local override `.env.local`：Dashboard 写入的本地覆盖文件。
- Effective value：`.env`、当前环境变量和 `.env.local` 合并后的安全值。
- Active runtime value：当前运行中的 provider / memory 状态。

`.env.local` 不会自动同步回 `.env`。这是有意的安全边界，用来降低误提交 secret 的风险。保存后如果 active runtime 仍旧显示旧 provider 或 mock mode，请点击 **Apply Now / Reload Runtime Config**，或者重启开发服务器。

复制后在 `.env` 中填写 MVP 必需值。DeepSeek 和数据库是当前 MVP 必需项。不要把真实 key 写入 `.env.example`：

```env
DATABASE_URL=postgres://yuvi:yuvi_dev_password@localhost:5432/yuvi
DEEPSEEK_API_BASEURL=https://api.deepseek.com
DEEPSEEK_API_KEY=
DEEPSEEK_CHAT_MODEL=
DEEPSEEK_REASONING_MODEL=
```

可选的 xAI TTS 和 Vision 变量。Voice/Vision 页面实现前可以留空：

```env
XAI_API_BASEURL=https://api.x.ai/v1
XAI_API_KEY=
XAI_TTS_MODEL=
XAI_TTS_VOICE=
XAI_VISION_MODEL=
```

可选的 Alibaba DashScope STT 变量。Voice 页面实现前可以留空：

```env
DASHSCOPE_API_BASEURL=
DASHSCOPE_API_KEY=
DASHSCOPE_STT_MODEL=
```

如果本地开发时没有真实 optional provider key，保留：

```env
NODE_ENV=development
PROVIDER_ALLOW_MOCKS=true
DEFAULT_EMBEDDING_PROVIDER=mock
```

默认开发记忆模式是：

```env
MEMORY_REPOSITORY=in-memory
```

`in-memory` 适合快速开发和测试，服务器重启后数据会丢失。要启用 PostgreSQL 持久化记忆，需要同时设置：

```env
MEMORY_REPOSITORY=postgres
DATABASE_URL=postgres://yuvi:yuvi_dev_password@localhost:5432/yuvi
```

启用 PostgreSQL 记忆前必须先运行 migration。

如果你手动启动服务，启动前请把 `.env` 和 `.env.local` 加载进 shell；使用 `./scripts/dev.sh` 时脚本会自动加载。

Bash 或 WSL：

```bash
set -a
source .env
[ -f .env.local ] && source .env.local
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

## 2.1 Dashboard Settings 与 Apply Now

Dashboard 的 Settings 页面用于开发期配置 provider、模型和 memory mode：

- **Save Settings** 会把允许的配置写入 `.env.local`。
- **Apply Now / Reload Runtime Config** 会重新加载 `.env` 和 `.env.local`，并重建运行中的 provider registry。
- DeepSeek API key、xAI API key、DashScope API key 和 embedding key 只会以固定长度脱敏形式显示，例如 `••••••••••••abcd`。
- `/health` 和 `/providers/status` 不会自动消耗 provider token。
- Chat/Reasoning 的 provider 配置可以热加载；保存 DeepSeek key 后点击 **Apply Now**，Chat 就可以从 mock fallback 切换到真实 DeepSeek provider。
- `MEMORY_REPOSITORY`、`SERVER_HOST`、`SERVER_PORT`、`EVENT_BUS` 这类运行边界仍需要重启服务器。切换到 `MEMORY_REPOSITORY=postgres` 后，还需要确认 `DATABASE_URL` 已配置并运行 `pnpm db:migrate`。

如果 Settings 显示 DeepSeek 已配置，但 Chat 仍然是 mock mode，点击 **Apply Now / Reload Runtime Config** 或重启开发服务器。

## 3. Development Infrastructure

`infra/docker-compose.yml` 是 development-only infrastructure，面向 WSL/Linux 中的 Docker Engine，不要求 Docker Desktop。它会启动：

- PostgreSQL + pgvector: `companion-postgres`
- Redis: `companion-redis`
- NATS + JetStream: `companion-nats`

开发数据库连接示例：

```env
DATABASE_URL=postgres://yuvi:yuvi_dev_password@localhost:5432/yuvi
REDIS_URL=redis://localhost:6379
NATS_URL=nats://localhost:4222
```

启动 infra：

```bash
docker compose -f infra/docker-compose.yml up -d
```

停止 infra：

```bash
docker compose -f infra/docker-compose.yml down
```

检查容器状态：

```bash
docker compose -f infra/docker-compose.yml ps
```

查看所有服务日志：

```bash
docker compose -f infra/docker-compose.yml logs -f
```

查看单个服务日志：

```bash
docker compose -f infra/docker-compose.yml logs -f postgres
docker compose -f infra/docker-compose.yml logs -f redis
docker compose -f infra/docker-compose.yml logs -f nats
```

推荐使用安全的开发数据库重置脚本：

```bash
pnpm db:reset:dev
```

重置 development volumes 的手动方式：

```bash
docker compose -f infra/docker-compose.yml down -v
docker compose -f infra/docker-compose.yml up -d
```

警告：`pnpm db:reset:dev` 和 `down -v` 都会删除 development 数据库、Redis 数据和 NATS JetStream 数据。只在你确定可以丢弃本地开发数据时使用。

## 4. Run Migrations

PostgreSQL memory mode 使用内置 migration runner：

```bash
pnpm db:migrate
```

验证 PostgreSQL memory smoke：

```bash
pnpm smoke:postgres
```

手动应用 SQL 文件仅作为高级排错方式：

```bash
docker compose -f infra/docker-compose.yml exec -T postgres \
  psql -U yuvi -d yuvi < packages/memory/migrations/001_init_memory.sql
```

验证 memory table 存在：

```bash
docker compose -f infra/docker-compose.yml exec postgres \
  psql -U yuvi -d yuvi -c "\dt"
```

如果 `MEMORY_REPOSITORY=postgres` 但没有 `DATABASE_URL`，服务器会拒绝启动并提示需要 `DATABASE_URL`。如果忘记运行 migration，memory table 或 pgvector extension 相关操作会失败。

## 4.1 YUVI Memory Core and future external backends

YUVI 拥有自己的 MemoryService 和 MemoryBackend / MemoryRepository 边界。当前 Phase 1 目标是保证记忆读写开关、来源追踪、类型/子类型、检索排序和 prompt 注入的正确性。

未来可以把外部系统作为 adapter 接入，而不是让它们成为 core dependency：

- Mem0 可以作为 `Mem0MemoryBackend` 接入，用于实验外部长期记忆服务。
- Graphiti 可以作为 `GraphitiMemoryBackend` 的参考方向，用于研究 temporal graph memory。
- Letta 只作为 architecture reference，不作为 YUVI Runtime core dependency。

当前不要把 raw chat logs 直接塞进 prompt。记忆必须经过检索、排序、压缩和重构后再进入 `RelevantMemory`。

## 5. Start Server

如果还没安装依赖：

```bash
pnpm install
```

启动服务器：

```bash
SERVER_PORT=6121 pnpm dev
```

PowerShell:

```powershell
pnpm.cmd dev
```

默认开发 URL：

```text
Server: http://localhost:6121
Web UI: http://localhost:5173
WebSocket: ws://localhost:6121/ws
```

## Developer Scripts

推荐用脚本启动和停止本地开发环境。脚本不会打印 `.env` 内容，也不会提交 secret。

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

这些 wrapper 会检查 `wsl` 和 Ubuntu，然后进入 WSL 执行 shell 脚本。预期 WSL 路径是：

```text
~/uv-main
```

如果当前 repo 位于 `~/uv-main/uv-main`，wrapper 也会自动识别。Windows 源路径参考为 `C:\Users\Administrator.DESKTOP-NPU6DHJ\Desktop\uv-main`。

`./scripts/dev.sh` 会检查 Node.js、pnpm、Docker、docker compose、`.env` 和 `.env.example`，在存在 `infra/docker-compose.yml` 时启动 PostgreSQL + pgvector 和 Redis。如果缺少 `node_modules`，它会执行 `pnpm install`。它会启动已有的 `apps/server`，并在未来 `apps/web` 存在时启动 Web dev server。

当前 Dashboard 已由 `apps/web` 提供。启动后打开：

```text
http://localhost:5173
```

Dashboard 页面作用：

- Overview：查看 server、database、provider、WebSocket、recent events、recent memories。
- Chat：发送文本消息，查看 reply 和 traceId。
- Memory：查看、搜索、筛选、创建、编辑和删除 manual memory；可调试 type、subtype、importance、tags、sourceTraceId 和 metadata。
- Providers：查看 DeepSeek、xAI、DashScope、Embedding provider 状态。
- Events：查看 recent runtime events，按 event type 过滤。
- Prompt Preview：查看 latest prompt sections，仅 development mode。
- Voice：未来 voice/STT/TTS 调试页，目前是占位。
- Vision：未来 vision 调试页，目前是占位。
- Settings：查看开发期 URL 和 secret safety 提示。

自动记忆写入是保守的：`readMemory` 控制检索，`writeMemory` 控制自动写入。普通聊天、问候、一次性问题或 assistant 明确表示缺少上下文的失败回答不会自动写入。明确说“记住”、长期偏好、provider choice、项目路径、启动命令、配置决策、排错结论和项目里程碑更适合自动写入；需要精确编辑时使用 Dashboard 的 Memory 页面。

## 6. Test Health Endpoint

```bash
curl http://localhost:6121/health
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
curl -X POST http://localhost:6121/message \
  -H "content-type: application/json" \
  -d '{"sessionId":"dev","content":"Hello companion runtime"}'
```

PowerShell:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri http://localhost:6121/message `
  -ContentType "application/json" `
  -Body '{"sessionId":"dev","content":"Hello companion runtime"}'
```

启用 mock 时，如果真实 provider key 不可用，回复会以 `Mock reply:` 开头。

## 8. Test Memory Endpoint

创建一条记忆：

```bash
curl -X POST http://localhost:6121/memory \
  -H "content-type: application/json" \
  -d '{"type":"semantic","content":"The developer is testing the quickstart.","source":"quickstart","tags":["dev"]}'
```

读取最近记忆：

```bash
curl "http://localhost:6121/memory/recent?limit=5"
```

PowerShell:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri http://localhost:6121/memory `
  -ContentType "application/json" `
  -Body '{"type":"semantic","content":"The developer is testing the quickstart.","source":"quickstart","tags":["dev"]}'

Invoke-RestMethod "http://localhost:6121/memory/recent?limit=5"
```

## 9. Common Errors

### WSL 未安装

症状：

- `scripts\check-env.cmd` 提示未找到 `wsl`。
- Windows 无法执行 WSL 命令。

修复：

```cmd
wsl --install
```

安装后重启 Windows，再运行：

```cmd
wsl -l -v
```

### Ubuntu 未安装

症状：

- `scripts\check-env.cmd` 提示未找到可用的 Ubuntu 发行版。

修复：

```cmd
wsl --install -d Ubuntu
wsl -l -v
```

### Docker 未启动

症状：

- `Cannot connect to the Docker daemon`
- `docker compose` command 失败

修复：

在 WSL2 Ubuntu 中启动 Docker Engine：

```bash
sudo service docker start
docker ps
```

### pnpm 未安装

症状：

- `pnpm: command not found`
- `scripts/dev.sh` 提示缺少 `pnpm`

修复：

确认 Node.js 和 pnpm 在 WSL 中可用：

```bash
node --version
pnpm --version
```

如果 Windows PowerShell 阻止 `pnpm.ps1`，不要在 Windows host 中排查太久，优先进入 WSL repo root 运行命令。

### `.env` 缺失

症状：

- `scripts/dev.sh` 提示未找到 `.env`
- provider 或 database config 不完整

修复：

```bash
cp .env.example .env
```

然后填写 DeepSeek 和数据库配置。不要提交 `.env`。

### DeepSeek key 无效

症状：

- `MISSING_API_KEY`
- `INVALID_API_KEY`
- provider 返回 HTTP 401
- startup 或 health check 提示 provider config 不完整

修复：

```env
DEEPSEEK_API_KEY=your-real-key
PROVIDER_ALLOW_MOCKS=true
```

开发时可以使用 mock，或为 production-like 运行提供真实 key。确认 `DEEPSEEK_API_KEY` 属于 `DEFAULT_CHAT_PROVIDER` / `DEFAULT_REASONING_PROVIDER` 配置的 provider。

### 数据库连接失败

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
DATABASE_URL=postgres://yuvi:yuvi_dev_password@localhost:5432/yuvi
```

如果之前使用过旧 development volume，确认是否需要重置本地开发数据：

```bash
pnpm db:reset:dev
docker compose -f infra/docker-compose.yml up -d
pnpm db:migrate
pnpm smoke:postgres
```

警告：`pnpm db:reset:dev` 会删除 development database data。`docker compose -f infra/docker-compose.yml down -v` 只作为高级手动重置方式使用。

如果已有 Docker volume 是用旧的 `airi` 或 `companion` 凭据初始化的，仅修改 `infra/docker-compose.yml` 不会更新既有 volume。出现 `Role "yuvi" does not exist` 或 `password authentication failed for user "yuvi"` 时，请重置 development DB volumes，或临时使用旧 volume 对应的 `DATABASE_URL` 排错。

### 端口被占用

症状：

- server 无法监听 `6121`
- web 无法监听 `5173`
- Docker 无法绑定 `5432`、`6379`、`4222` 或 `8222`

修复：

先停止本项目开发环境：

```bash
./scripts/stop.sh
```

再检查 Docker 状态：

```bash
docker compose -f infra/docker-compose.yml ps
```

如果仍被占用，关闭占用端口的其它进程，或调整对应 env var，例如 `SERVER_PORT` / `WEB_PORT`。

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

## 10. Dashboard Settings

Dashboard 的 `Settings` 页面可以写入本地 development 配置到 `.env.local`。

- `.env.local` 是本地状态，不要提交。
- `./scripts/dev.sh` 会先加载 `.env`，再加载 `.env.local`，因此 `.env.local` 会在重启后覆盖 `.env` 中的同名变量。
- Dashboard 不会返回完整 API key，也不会返回 Authorization header 或 raw `.env`。
- Dashboard 只显示固定长度的 masked API key，例如 `••••••••••••abcd`。
- 保存后返回 `restartRequired=true` 时，需要重启 server 才会生效。
- `MEMORY_REPOSITORY=in-memory` 是默认开发模式，server 重启后数据会丢失。
- `MEMORY_REPOSITORY=postgres` 需要 `DATABASE_URL`，并先运行：

```bash
pnpm db:migrate
```

Dashboard 当前不会热切换 memory backend；切换 memory repository 只是写入配置，重启后生效。

## 11. Notes For Windows LTSC Users

- 优先使用 WSL2 + Ubuntu + Docker Engine。
- 如果你的 Windows LTSC 版本不受支持，避免依赖 Docker Desktop。
- 为了更好的 file watcher 和 dependency install 性能，请把项目文件放在 WSL filesystem 中，例如 `~/uv-main`。
- 尽可能在 WSL 中运行 `pnpm install`、`pnpm dev` 和 Docker command。
- 如果从 PowerShell 工作，当 `pnpm.ps1` shim 被阻止时使用 `pnpm.cmd`。
