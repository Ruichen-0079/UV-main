# AI Companion Runtime

[English](README.md) | [简体中文](README.zh-CN.md)

一个本地优先、事件驱动的 AI Companion 运行时，灵感来自 Project AIRI 的架构目标，但不复制 AIRI 代码。

这个仓库从一个小而可运行的 TypeScript monorepo 开始：

- `apps/server`: Fastify HTTP 和 WebSocket 运行时服务器。
- `packages/protocol`: 事件类型和 schema。
- `packages/event-bus`: 事件总线抽象和内存实现。
- `packages/memory`: 记忆仓库/记忆服务接口，以及 MVP 阶段的内存实现。
- `packages/prompt-builder`: 动态提示词组装。
- `packages/providers`: 提供商接口、提供商注册表、标准化错误，以及用于开发的本地 echo 提供商。
- `packages/core`: 运行时编排器和 agent loop 边界。

## Getting Started

```bash
pnpm install
pnpm dev
```

服务器默认运行在 `http://127.0.0.1:3000`。

## Scripts

- `pnpm dev`: 以开发模式运行 Fastify 服务器。
- `pnpm build`: 构建所有 workspace package。
- `pnpm check`: 对所有 workspace package 执行类型检查。
- `pnpm test`: 运行已配置的 package 测试。

## Infrastructure

```bash
docker compose -f infra/docker-compose.yml up -d
```

这会启动带 pgvector 的 PostgreSQL、Redis，以及为未来事件总线工作准备的 NATS。
