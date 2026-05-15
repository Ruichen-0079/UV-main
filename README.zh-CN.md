# YUVI Runtime

[English](README.md) | [简体中文](README.zh-CN.md)

YUVI Runtime 是一个本地优先、事件驱动的 AI Companion Runtime。它受到 Project AIRI 架构愿景启发，但本仓库是原创实现，不复制 AIRI 代码。

项目目标是构建一个可扩展的 Companion Runtime，而不是只做一个聊天页面。当前重点包括：

- 事件驱动 runtime
- 记忆系统
- prompt builder
- provider abstraction
- 开发期 Web Dashboard
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

- `apps/server`: Fastify HTTP 和 WebSocket runtime server。
- `apps/web`: Vite + React + TypeScript + Tailwind CSS developer dashboard。
- `packages/protocol`: runtime event 类型和 schema。
- `packages/event-bus`: event bus 抽象和内存实现。
- `packages/memory`: memory repository/service。
- `packages/prompt-builder`: prompt assembly。
- `packages/providers`: provider interfaces、registry、vendor-specific provider 实现。
- `packages/core`: runtime orchestration。
- `packages/config`: typed runtime config boundary。
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

打开 Dashboard：

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
