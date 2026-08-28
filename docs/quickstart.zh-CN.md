# Developer Quickstart

[English](quickstart.md) | [简体中文](quickstart.zh-CN.md)

本指南描述 YUVI Runtime 当前的 **Linux-first** 开发路径。

Linux 是主要开发平台，也是当前持久化/可靠性验证的主要平台。Windows PowerShell helper 继续保留用于兼容性，但 WSL/Windows 专用基础设施不再是正常产品开发的 authority。

## 1. 前置要求

必需：

- Node.js 22+
- pnpm 9+
- Git

需要 PostgreSQL-backed development 时还需要：

- Docker Engine
- Docker Compose plugin

检查本机工具：

```bash
node --version
pnpm --version
git --version
docker --version
docker compose version
```

如果只使用 in-memory 模式，可以不启动 Docker。

## 2. 获取仓库并安装依赖

推荐在正常的 Linux filesystem 中 checkout：

```bash
git clone https://github.com/Ruichen-0079/UV-main.git
cd UV-main
pnpm install
```

复制环境变量模板：

```bash
cp .env.example .env
```

`.env` 和 `.env.local` 是本地敏感状态。不要提交或打印真实 API key、Authorization header、token、password 或私有数据库 URL。

Runtime env 优先级：

```text
.env
-> process environment
-> .env.local
```

开发脚本会自动加载仓库根目录的 runtime env。

## 3. 选择持久化模式

### 轻量 in-memory 模式

适合快速 UI / Runtime 开发：

```env
MEMORY_REPOSITORY=in-memory
CONVERSATION_REPOSITORY=in-memory
```

不启动 Docker infra：

```bash
SKIP_INFRA=1 ./scripts/dev.sh
```

In-memory conversation 可以在同一进程内重建 Runtime 实例时恢复，但不具备跨进程重启的 durability。

### Durable PostgreSQL 模式

需要持久记忆与会话恢复时：

```env
MEMORY_REPOSITORY=postgres
CONVERSATION_REPOSITORY=postgres
DATABASE_URL=postgres://yuvi:yuvi_dev_password@localhost:5432/yuvi
```

启动开发 PostgreSQL：

```bash
docker compose -f infra/docker-compose.yml up -d postgres
```

应用 migration：

```bash
pnpm db:migrate
```

当前正常 durable architecture 是：

```text
YUVI Runtime / Memory
  -> repository ports
  -> DATABASE_URL
  -> PostgreSQL
  -> packages/memory/migrations
```

PostgreSQL 可以由系统服务、外部实例或容器提供。YUVI Core 不要求自己拥有 PostgreSQL 进程。

`./scripts/dev.sh` 在选择 PostgreSQL memory 却缺少 `DATABASE_URL` 时会 fail closed。除非显式设置 `YUVI_AUTO_MIGRATE=0`，PostgreSQL 模式下它还会在 Runtime 启动前执行 migration。

当前持久化/可靠性基线见 [p4-linux-first.md](p4-linux-first.md)。

## 4. 配置 Provider

正常开发采用 real-provider-first。只需要在 `.env` / `.env.local` 中配置当前要用的能力。

现有 provider boundary 包括：

- chat
- reasoning
- embedding
- TTS
- STT
- vision
- proactive decision
- assistant continuation

Mock provider 用于测试、CI 或显式离线开发，需要时应明确开启。

厂商专用实现属于 `packages/providers`；Runtime Core 只消费 provider-neutral interface。

当前变量、routing、provider verification 与厂商细节见 [providers.md](providers.md)。

## 5. 启动开发环境

主要 Linux 入口：

```bash
./scripts/dev.sh
```

脚本会：

- 把仓库根目录设置为 `YUVI_RUNTIME_ENV_DIR`；
- 加载 `.env` 和 `.env.local`，不打印 secret；
- 在需要时安装依赖；
- 除非 `SKIP_INFRA=1`，否则启动 Docker development infra；
- 校验 durable PostgreSQL 配置；
- 按规则执行 migration；
- 启动 server 与 web 开发进程。

开发地址：

```text
Server:    http://localhost:6121
Web UI:    http://localhost:5173
WebSocket: ws://localhost:6121/ws
```

检查状态：

```bash
./scripts/health.sh
```

停止开发环境：

```bash
./scripts/stop.sh
```

`pnpm dev` 是更窄的命令，只启动 Fastify server package 的开发模式。

## 6. 基本 Runtime 检查

Health：

```bash
curl http://127.0.0.1:6121/health
```

通过兼容端点发送普通消息：

```bash
curl -X POST http://127.0.0.1:6121/message \
  -H 'content-type: application/json' \
  -d '{"sessionId":"dev","text":"Hello YUVI","options":{"useMemory":true,"voiceOutput":false}}'
```

当兼容 API 和 versioned API 同时存在时，以当前 versioned Runtime contract 为主。测试更新的行为时优先参考 Dashboard、当前源码和测试。

## 7. 验证仓库

提交或 review PR 前：

```bash
pnpm check
pnpm test
pnpm build
```

普通 smoke：

```bash
pnpm smoke
```

PostgreSQL-backed smoke：

```bash
pnpm smoke:postgres
```

常用 Memory 维护命令：

```bash
pnpm memory:index:status
pnpm memory:maintenance
pnpm memory:embed:backfill -- --dry-run
```

专用 Linux persistence CI 会 provision PostgreSQL + pgvector，并验证 migration、focused memory/core/server tests、migration re-entry 和 PostgreSQL-backed Runtime smoke。

## 8. 重置开发数据库

只有在确认本地开发数据可以丢弃时才使用 guarded reset：

```bash
pnpm db:reset:dev
```

这是 destructive 操作。

手动删除 Docker volumes 只作为高级 fallback：

```bash
docker compose -f infra/docker-compose.yml down -v
```

修改 Compose 中的 PostgreSQL 用户名或密码不会重写已经初始化的 volume。

## 9. Windows 兼容

Windows 继续支持，但不再是当前主开发基线。

PowerShell helper：

```powershell
.\scripts\dev.ps1
.\scripts\health.ps1
.\scripts\stop.ps1
```

Windows 专用 installer、进程 ownership、bundled database、ACL 和 packaging concern 属于 Windows platform layer，不应成为 Linux Runtime correctness 的前置条件。

平台细节见 [windows-development.md](windows-development.md)。

## 10. 下一步阅读

- [Architecture](architecture.zh-CN.md)
- [P4 Linux-first persistence baseline](p4-linux-first.md)
- [Memory](memory.md)
- [Providers](providers.md)
- [Testing](testing.md)
- [Dashboard](dashboard.md)
- [Future companion roadmap](future/README.md)

如果文档和实现发生冲突，以当前仓库行为、测试、migration 和 CI evidence 为准；应该更新过期文档，而不是保留已经失效的平台假设。