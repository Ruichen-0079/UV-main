# YUVI Runtime

[English](README.md) | [简体中文](README.zh-CN.md)

YUVI Runtime 是一个本地优先、事件驱动的 AI 伴侣运行时。它受到 Project AIRI 架构愿景启发，但本仓库是原创实现，不复制 AIRI 代码。术语以[统一术语表](docs/terminology.zh-CN.md)为准。

项目目标是构建一个可扩展的 Companion Runtime，而不是只做一个聊天页面。当前重点包括：

- 事件驱动 runtime
- 记忆系统
- prompt builder
- provider abstraction
- 开发期 Web 控制台
- 未来 Tauri desktop app
- 未来 Live2D / VRM / voice / vision 集成
- 最终面向 Windows、macOS、Linux 的一体化桌面应用

## 当前开发环境

当前推荐开发环境是：

- Windows LTSC host
- WSL2 Ubuntu
- Docker Engine inside WSL
- Node.js / pnpm inside WSL

推荐仓库路径：

```text
~/uv-main
```

如果当前仓库位于 `~/uv-main/uv-main`，现有脚本也会识别。

Windows 原路径参考：

```text
C:\Users\Administrator.DESKTOP-NPU6DHJ\Desktop\uv-main
```

开发期使用 WSL2 + Docker Engine，是为了避免 Windows LTSC 上 Docker Desktop、PowerShell execution policy、文件监听、依赖安装性能等问题。生产桌面模式不会依赖 WSL、Docker、Node.js、pnpm、PostgreSQL、Redis 或 NATS。

## 仓库结构

- `apps/server`: Fastify HTTP 和 WebSocket 运行时服务器。
- `apps/web`: Vite + React + TypeScript + Tailwind CSS 开发期 Web 控制台。
- `packages/protocol`: 运行时事件类型和 Schema。
- `packages/event-bus`: 事件总线抽象和内存实现。
- `packages/memory`: 记忆仓储和记忆服务。
- `packages/prompt-builder`: 提示词构建。
- `packages/providers`: 提供方接口、注册表和厂商专用实现。
- `packages/core`: 运行时编排。
- `packages/config`: 类型化运行时配置边界。
- `infra/docker-compose.yml`: development-only PostgreSQL + pgvector、Redis、NATS。

## 快速启动

复制 `.env.example`：

```bash
cp .env.example .env
```

启动开发环境：

```bash
./scripts/dev.sh
```

Windows host convenience wrapper：

```cmd
scripts\start-dev.cmd
```

打开控制台：

```text
http://localhost:5173
```

停止开发环境：

```bash
./scripts/stop.sh
```

Windows host convenience wrapper：

```cmd
scripts\stop-dev.cmd
```

## 常用命令

```bash
pnpm install
pnpm check
pnpm build
pnpm test
docker compose -f infra/docker-compose.yml up -d
docker compose -f infra/docker-compose.yml down
./scripts/health.sh
```

更多说明见 [docs/quickstart.zh-CN.md](docs/quickstart.zh-CN.md)。
