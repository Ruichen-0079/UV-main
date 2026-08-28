# YUVI Runtime

[English](README.md) | [简体中文](README.zh-CN.md)

YUVI 是一个本地优先、事件驱动的 AI 伴侣运行时。核心产品是 Runtime 本身，而不是某个特定虚拟形象、前端、模型厂商或操作系统外壳。

本仓库是原创实现，受到 AIRI 等项目的架构愿景启发。目标是在不过度耦合的前提下，逐步承载持久会话与记忆、提供方中立的推理与媒体能力、主动行为、虚拟形象呈现，以及后续 Character / Cognition 架构。

中文术语以 [统一术语表](docs/terminology.zh-CN.md) 为准。

## 当前基线

YUVI 当前采用 **Linux-first**：Linux 是主要开发平台，也是当前生产级行为与持久化可靠性的主要验证平台。

主开发路径是原生 Linux + Node.js + pnpm + Docker Engine + Bash 生命周期脚本。仓库仍保留 Windows PowerShell 辅助脚本、桌面打包和兼容性代码，但 Windows 专用打包基础设施不再是产品开发的前置条件。

当前 durable persistence 边界保持简单：

```text
YUVI Runtime / Memory
  -> repository ports
  -> DATABASE_URL
  -> PostgreSQL
  -> packages/memory/migrations
```

PostgreSQL 可以来自系统服务、外部托管实例，也可以来自开发期 Docker Compose。Core Runtime 的正确性不依赖 YUVI 自己拥有、启动、停止或终止 PostgreSQL 进程。

已经证明的可靠性语义继续作为基线保留，包括：

- finalized-turn 生命周期；
- durable ingestion 状态；
- semantic idempotency；
- crash recovery；
- retry / reconcile；
- cancellation fencing；
- 在要求 fail-closed 的持久化边界正确失败。

持久化/可靠性重基线见 [docs/p4-linux-first.md](docs/p4-linux-first.md)。结构收口之后的长期 Companion 路线见 [docs/future/README.md](docs/future/README.md)。

## 仓库结构

- `apps/server` — Fastify HTTP/WebSocket Runtime server 与 composition root。
- `apps/web` — React/Vite 开发控制台和当前 Companion 呈现层。
- `apps/desktop` — Tauri 桌面外壳及打包集成。
- `packages/core` — Runtime 编排与语义执行边界。
- `packages/memory` — 会话持久化、长期记忆、finalized-ingestion 可靠性、PostgreSQL repository 与 migrations。
- `packages/prompt-builder` — 结构化、提供方中立的 prompt 构建。
- `packages/providers` — provider contract、routing、adapter 和统一错误。
- `packages/protocol` — Runtime event contract 与 schema。
- `packages/event-bus` — Runtime event-bus 抽象；当前运行模式为 in-memory。
- `packages/config` — 类型化 Runtime 配置与脱敏边界。
- `packages/desktop-supervisor` — 桌面/平台 supervision 代码；它不是 Linux Runtime 正确性路径的一部分。
- `infra/docker-compose.yml` — 开发期 PostgreSQL + pgvector、Redis、NATS。

## 快速启动 — Linux

要求：

- Node.js 22+
- pnpm 9+
- 使用开发基础设施时需要 Docker Engine + Docker Compose plugin

在仓库根目录：

```bash
pnpm install
cp .env.example .env
./scripts/dev.sh
```

开发地址：

- Server: `http://localhost:6121`
- Web UI: `http://localhost:5173`
- WebSocket: `ws://localhost:6121/ws`

检查或停止开发环境：

```bash
./scripts/health.sh
./scripts/stop.sh
```

如果只做 in-memory 轻量开发，不需要启动 Docker infra：

```bash
SKIP_INFRA=1 ./scripts/dev.sh
```

完整流程见 [docs/quickstart.zh-CN.md](docs/quickstart.zh-CN.md)。

## Durable PostgreSQL 模式

最快的开发模式是内存仓储：

```env
MEMORY_REPOSITORY=in-memory
CONVERSATION_REPOSITORY=in-memory
```

需要跨重启的持久记忆和会话恢复时：

```env
MEMORY_REPOSITORY=postgres
CONVERSATION_REPOSITORY=postgres
DATABASE_URL=postgres://yuvi:yuvi_dev_password@localhost:5432/yuvi
```

启动开发数据库并应用 migration：

```bash
docker compose -f infra/docker-compose.yml up -d postgres
pnpm db:migrate
```

`./scripts/dev.sh` 在 PostgreSQL durable 模式缺少 `DATABASE_URL` 时会拒绝启动。除非显式设置 `YUVI_AUTO_MIGRATE=0`，当 PostgreSQL memory 激活时，开发脚本会在 Runtime 启动前执行 migration。

常用持久化验证：

```bash
pnpm smoke:postgres
pnpm memory:index:status
pnpm memory:maintenance
```

配置真实 embedding provider 后，可以对已有 memory 做回填：

```bash
pnpm memory:embed:backfill -- --dry-run
pnpm memory:embed:backfill
```

## Provider

Provider routing 由配置决定。当前仓库已经存在 chat、reasoning、embedding、TTS、STT、vision、proactive decision 和 assistant continuation 等能力边界。

正常 Runtime 路径是 real-provider-first。Mock provider 只用于测试、CI 或显式离线开发，并在需要时显式开启。

厂商专用代码属于 `packages/providers`；`packages/core` 不应直接依赖厂商 SDK concrete class。

详细配置和验证见 [docs/providers.md](docs/providers.md)。

## Runtime 语义

主对话路径大致是：

```text
input
  -> Runtime admission / persistence
  -> Direct Context + Memory retrieval
  -> prompt construction
  -> provider execution
  -> persisted assistant result
  -> runtime events
  -> optional presentation effects
```

长期记忆不等于原始聊天记录。Conversation persistence 和 semantic memory 是两个独立职责。

当前 P6 主动行为也保持严格边界：proactive decision contract 只决定 `NO_OP` 或 `REQUEST_TEXT`；assistant-initiated continuation 是 assistant-only，不制造 synthetic user turn，并且同一个 active/retained idempotency claim 不允许重放。

未来的 identity/persona/relationship、continuity、Character/Cognition、capability、temporal、embodiment 和 post-training 设计位于 [docs/future](docs/future/README.md)。除非仓库中已有对应实现，否则这些文档描述的是未来 contract，不代表当前 Runtime 已经具备这些行为。

## 验证

仓库主验证：

```bash
pnpm check
pnpm test
pnpm build
```

Smoke：

```bash
pnpm smoke
pnpm smoke:postgres
```

CI 中包含 PostgreSQL + pgvector 的 Linux persistence 验证。Windows CI 继续承担兼容性和打包回归检查，但 Linux 是当前产品开发与持久化验证的主要平台。

## 常用脚本

- `./scripts/dev.sh` — 主要 Linux 开发入口；加载根目录 `.env` / `.env.local`，按需启动 Docker infra，在 durable PostgreSQL 模式下按规则执行 migration，然后启动 server/web。
- `./scripts/health.sh` — 检查开发进程与基础设施健康状态。
- `./scripts/stop.sh` — 停止 Linux 开发进程及按脚本管理的开发基础设施。
- `pnpm dev` — 只启动 Fastify server package 的开发模式。
- `pnpm check` — host-safety 检查 + TypeScript 检查。
- `pnpm test` — workspace tests + host-environment safety tests。
- `pnpm build` — 准备 Cubism 资源并构建 TypeScript project graph。
- `pnpm db:migrate` — 应用 PostgreSQL migration。
- `pnpm db:reset:dev` — 带强确认的开发数据 destructive reset。

## Windows

Windows 是支持的兼容/打包平台，但不是当前主开发 authority。

PowerShell helper 仍可使用：

```powershell
.\scripts\dev.ps1
.\scripts\health.ps1
.\scripts\stop.ps1
```

不要从 Windows packaging machinery 反推 Linux Runtime 的产品要求。平台专用的进程 ownership、installer provisioning、bundled PostgreSQL、ACL/Credential Manager 等属于 Windows packaging layer。

Windows 细节见 [docs/windows-development.md](docs/windows-development.md)。

## 文档入口

- [开发快速开始](docs/quickstart.zh-CN.md)
- [架构说明](docs/architecture.zh-CN.md)
- [P4 Linux-first 持久化基线](docs/p4-linux-first.md)
- [Memory](docs/memory.md)
- [Providers](docs/providers.md)
- [Testing](docs/testing.md)
- [Dashboard](docs/dashboard.md)
- [Future Companion Roadmap](docs/future/README.md)

Secret 只应存在于本地 `.env` / `.env.local` 或其他安全配置来源。不要提交或打印 API key、Authorization header、token、password，开发示例中的占位数据库凭据除外。