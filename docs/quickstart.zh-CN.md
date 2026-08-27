# 开发者快速启动

这是 Linux-first 开发路径。Windows PowerShell 兼容路径单独记录在 [Windows 开发](windows-development.md)。WSL 受支持但不是必需项，也不要求 GPU。

## 前置条件

- Node.js 22 或更新版本；
- 仓库声明的 pnpm 9.15.4；
- 能运行仓库脚本的 shell；
- 只有选择 Compose 开发基础设施时才需要 Docker Engine 或 Docker Desktop。

内存模式不需要 PostgreSQL。持久化模式需要一个可通过 `DATABASE_URL` 访问的外部、系统管理或独立管理的容器 PostgreSQL；在 Linux 上，YUVI 不拥有 PostgreSQL OS 进程。

## 1. 安装与配置

在仓库根目录运行：

```bash
pnpm install
cp .env.example .env
```

把 credential 和本地覆盖配置放在未跟踪的 `.env`、`.env.local` 中。Runtime 会依次加载根目录 `.env`、进程环境变量和根目录 `.env.local`；后者覆盖前者。开发脚本会加载这些文件，但不会打印 secret。

仓库示例采用 real-provider-first。需要远程调用时配置通用 OpenAI-compatible Chat 路径和 DeepSeek Reasoning 路径：

```env
DEFAULT_CHAT_PROVIDER=openai-compatible
OPENAI_COMPATIBLE_API_BASEURL=https://api.deepinfra.com/v1/openai
OPENAI_COMPATIBLE_API_KEY=replace-with-your-key
OPENAI_COMPATIBLE_CHAT_MODEL=replace-with-your-model

DEFAULT_REASONING_PROVIDER=deepseek
DEEPSEEK_API_KEY=replace-with-your-key
DEEPSEEK_REASONING_MODEL=replace-with-your-model
```

需要显式离线开发时开启 mock：

```env
PROVIDER_ALLOW_MOCKS=true
DEFAULT_CHAT_PROVIDER=mock
CHAT_PROVIDER_CHAIN=mock
DEFAULT_EMBEDDING_PROVIDER=mock
EMBEDDING_PROVIDER_CHAIN=mock
EMBEDDING_PROVIDER=mock
```

Mock 输出只能验证 runtime 路径，不代表真实语义提供方行为，也不能被当作远程 live verification。

当前默认值还包括 `MEMORY_REPOSITORY=in-memory`、`CONVERSATION_REPOSITORY=in-memory`、`EVENT_BUS=in-memory` 和有边界的 Direct Context。`EVENT_BUS=nats` 是保留值，因为 NATS 当前未实现，选择它会明确失败。

## 2. 启动 runtime

主要入口是：

```bash
./scripts/dev.sh
```

默认会启动 `infra/docker-compose.yml` 提供的便利开发服务，然后启动 server 和 Web UI。Compose 只是开发期基础设施提供方，不是产品拥有的 PostgreSQL 架构。

只进行内存模式开发而不启动 Docker 基础设施时：

```bash
SKIP_INFRA=1 ./scripts/dev.sh
```

脚本默认使用 loopback：

- Web UI：`http://localhost:5173`
- Server：`http://localhost:6121`
- WebSocket：`ws://localhost:6121/ws`

使用 `./scripts/health.sh` 查看本地服务，使用 `./scripts/stop.sh` 停止脚本启动的进程和 Compose 服务。

## 3. 按需启用持久化 PostgreSQL 模式

需要跨重启恢复会话和持久化记忆时使用 PostgreSQL。设置两个 repository selector 和真实连接串：

```env
MEMORY_REPOSITORY=postgres
CONVERSATION_REPOSITORY=postgres
DATABASE_URL=postgres://user:password@host:5432/database
```

`MEMORY_REPOSITORY=postgres` 时必须有 `DATABASE_URL`。启动或验证持久化模式前先运行 migration：

```bash
pnpm db:migrate
./scripts/dev.sh
```

如果 PostgreSQL 由仓库的本地 Compose 文件提供，请先启动基础设施，或不要给 `dev.sh` 设置 `SKIP_INFRA`。如果 PostgreSQL 由系统服务或其他容器提供，则使用 `SKIP_INFRA=1` 并让 `DATABASE_URL` 指向该服务。无论哪种方式，YUVI 都只通过 `DATABASE_URL` 连接；在 Linux 上不会启动、停止、接管或杀死数据库进程。

PostgreSQL 模式会把原始会话持久化与长期记忆分开。记忆检索可以把 keyword/trigram/full-text 精确匹配与可选向量检索结合；ANN index 只是加速手段，不能替代精确技术匹配。

## 4. 调用 API

检查本地服务健康状态：

```bash
curl http://127.0.0.1:6121/health
```

发送普通消息：

```bash
curl -X POST http://127.0.0.1:6121/v1/messages \
  -H 'content-type: application/json' \
  -d '{"sessionId":"dev","content":"Hello YUVI","options":{"readMemory":true,"writeMemory":false}}'
```

兼容端点 `POST /message` 仍可使用。流式客户端应使用 `POST /v1/messages/stream`，并消费其 `text/event-stream` 响应。

创建并搜索显式 memory record：

```bash
curl -X POST http://127.0.0.1:6121/memory \
  -H 'content-type: application/json' \
  -d '{"type":"semantic","content":"The developer is testing YUVI.","source":"quickstart"}'

curl -G http://127.0.0.1:6121/memory/search \
  --data-urlencode 'q=developer' \
  --data-urlencode 'limit=5'
```

Voice、Vision、提供方诊断、设置、事件、prompt preview 和 Live2D resource route 也可用于开发。当前边界见[架构](architecture.zh-CN.md)和 [Providers](providers.zh-CN.md)。

## 5. 验证改动

在仓库根目录运行：

```bash
pnpm check
pnpm test
pnpm build
git diff --check
```

`pnpm smoke` 是显式 mock/in-memory runtime smoke。`pnpm smoke:postgres` 是 PostgreSQL smoke，需要可访问且已迁移的 PostgreSQL 服务。不要为了让文档验证通过而修改产品源码或配置。
