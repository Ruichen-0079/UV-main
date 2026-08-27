# YUVI Runtime

[English](README.md) | [简体中文](README.zh-CN.md)

YUVI 是一个本地优先的 AI 伴侣运行时（AI Companion Runtime）。当前产品把事件驱动 Runtime、持久化会话与记忆边界、能力提供方路由、媒体能力、Live2D 伴侣呈现，以及有边界的助手主动行为组合在同一套运行时中。

Linux 是当前主要的开发平台、产品开发平台和生产验证平台。Windows 开发兼容仍然保留；打包内置 PostgreSQL、私有数据库进程所有权和安装器级数据库生命周期属于延后的 Windows 平台打包工作，不是当前产品主门槛。

## 当前已实现

- Fastify HTTP、SSE 与 WebSocket Runtime API。
- 流式用户 Chat、会话持久化，以及 finalized turn 记忆摄取可靠性。
- 面向 Runtime 的 vendor-neutral Memory evidence；可通过 Mem0/legacy adapter，并支持词法、trigram、full-text 与可选 vector 混合检索。
- Provider chain、fallback policy、诊断、运行时设置、显式 Provider Verify，以及取消边界。
- STT、TTS、Vision 与 voice-message 路由。
- Web/控制台，以及带语音播放、presence/behavior projection 的 Live2D 伴侣呈现界面。
- P6 助手发起的主动文本：有边界的 eligibility、显式 admission、`NO_OP | REQUEST_TEXT` 决策，以及每次已准入尝试至多一条 assistant-only continuation。

P8 的人格/关系产品语义目前**没有**实现为权威持久状态。

## Linux 快速启动

仓库在 `package.json` 中声明 pnpm `9.15.4`。

```bash
pnpm install
cp .env.example .env
./scripts/dev.sh
```

开发地址：

- Runtime API：`http://127.0.0.1:6121`
- Web UI：`http://127.0.0.1:5173`
- WebSocket：`ws://127.0.0.1:6121/ws`

如果只做 in-memory 轻量开发，可以跳过 Docker infrastructure：

```bash
SKIP_INFRA=1 ./scripts/dev.sh
```

需要 PostgreSQL 持久化开发或生产验证时，可以使用系统服务、外部管理服务或容器提供 PostgreSQL，再配置并迁移 YUVI：

```env
MEMORY_REPOSITORY=postgres
DATABASE_URL=postgres://...
```

```bash
pnpm db:migrate
./scripts/dev.sh
```

`infra/docker-compose.yml` 只是方便的开发期 PostgreSQL 提供方式；在 Linux 产品架构中，YUVI 不需要拥有 PostgreSQL 操作系统进程。

## 当前文档

- [当前状态](docs/current-state.zh-CN.md) — 精简的当前产品事实地图与文档权威规则。
- [架构](docs/architecture.zh-CN.md) — 当前 Runtime 边界与 turn flow。
- [快速开始](docs/quickstart.zh-CN.md) — Linux-first 环境与持久 PostgreSQL 路径。
- [P4 Linux-first baseline](docs/p4-linux-first.md) — 当前 persistence/reliability 权威基线。
- [记忆](docs/memory.zh-CN.md) — 子系统细节；若旧 phase 文本冲突，以当前源码、测试和 `current-state` 为准。
- [Provider](docs/providers.zh-CN.md) — Provider contract 与 diagnostics。
- [测试](docs/testing.zh-CN.md) — 测试与 CI 指南。
- [Windows 开发](docs/windows-development.md) — 次要兼容开发流程。
- [统一术语表](docs/terminology.zh-CN.md) — 中文技术术语规则。

历史 PR 与 phase plan 可以作为实现历史证据，但不会自动成为当前架构。