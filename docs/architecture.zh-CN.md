# Architecture

## 项目目标

AI Companion Runtime 是一个事件驱动、本地优先的 companion runtime。它受到 Project AIRI 架构愿景启发，但本仓库是原创实现，不复制 AIRI 代码。

最终目标是一个面向 Windows、macOS、Linux 的一体化桌面应用。当前阶段先构建可运行、可调试、可扩展的 runtime 基础。

核心方向：

- runtime core
- protocol event
- memory subsystem
- prompt builder
- provider abstraction
- developer dashboard
- future Tauri desktop app
- future Live2D / VRM / voice / vision integration

## 当前开发环境

当前推荐使用：

- Windows LTSC host
- WSL2 Ubuntu
- Docker Engine inside WSL
- Node.js / pnpm inside WSL

推荐仓库路径：

```text
~/uv-main
```

Windows 原路径参考：

```text
C:\Users\Administrator.DESKTOP-NPU6DHJ\Desktop\uv-main
```

开发期使用 WSL2 + Docker Engine 的原因：

- Windows LTSC 上 Docker Desktop 可能不可用或不稳定。
- WSL filesystem 中安装依赖和运行 watcher 通常更快。
- Node.js、pnpm、Docker、docker compose 可以统一在 Ubuntu 中运行。
- Windows PowerShell execution policy 不会影响 WSL 内 pnpm。
- 生产 desktop mode 必须与开发 infra 解耦。

## 核心原则

运行时是核心产品。Avatar、Dashboard、terminal client、future desktop shell 都应该通过同一个 runtime 通信。

`packages/core` 只依赖接口，不直接 import DeepSeek、xAI、Alibaba concrete class。provider-specific 代码属于 `packages/providers`。

记忆不是把原始聊天日志直接塞进 prompt。记忆必须被检索、排序、压缩、重构，然后再注入 prompt。

所有主要输入/输出都应该表示为 runtime event。

HTTP 和 WebSocket handler 应保持轻薄，业务逻辑属于 `packages/core` 或 service。

## 数据流

```text
User input
  -> runtime event
  -> memory retrieval
  -> prompt builder
  -> provider interface
  -> agent.reply event
  -> optional TTS / avatar output
```

语音和视觉也进入事件模型：

```text
Audio input
  -> Alibaba Cloud DashScope STT
  -> user.voice.transcript
  -> normal reply flow

Image or screen input
  -> xAI Vision
  -> perception.vision
  -> runtime context
```

## 包职责

### `apps/server`

Fastify HTTP/WebSocket runtime server。负责 route、transport、health、startup/shutdown。Handler 应保持轻薄。

当前 Dashboard 需要的主要 endpoint：

- `GET /health`
- `GET /providers/status`
- `POST /message`
- `GET /memory/recent`
- `POST /memory`
- `GET /memory/search?q=`
- `GET /events/recent`
- `GET /debug/prompt/latest`
- `GET /ws`

### `apps/web`

Vite + React + TypeScript + Tailwind CSS developer dashboard。它用于调试 runtime，不是 Live2D UI。

### `packages/protocol`

共享 runtime event 类型和 schema。所有主要 I/O 都应该通过事件表达。

### `packages/event-bus`

event bus 抽象。MVP 使用 in-memory implementation，未来可在同一接口背后接入 NATS / JetStream。

### `packages/memory`

memory repository 和 service。开发期使用 PostgreSQL + pgvector 或 in-memory fallback。负责 memory 类型、检索、评分、prompt-safe reconstruction。

### `packages/prompt-builder`

把 identity、character style、relationship context、retrieved memories、current situation、tools、user message 组装为 provider-neutral prompt。

### `packages/config`

typed runtime configuration boundary。负责 env parsing、provider selection、validation、redaction helper。它不实例化 provider client。

### `packages/providers`

provider interfaces、registry、normalized errors、vendor-specific implementation。DeepSeek、xAI、DashScope 具体请求/响应处理都属于这里。

### `packages/core`

runtime orchestration。负责接收事件、检索记忆、构建 prompt、调用 provider interface、写入重要交互、发布 runtime event。

## Provider Mapping

默认 provider：

- Chat: DeepSeek API
- Reasoning: DeepSeek API
- TTS: xAI
- Vision: xAI
- STT: Alibaba Cloud DashScope
- Embedding: configurable

secret 只应存在于本地 `.env` 或安全配置来源中，不应出现在日志、Dashboard、event payload 或错误响应中。

## 开发与生产模式

development mode 可以依赖：

- WSL2
- Docker Engine
- Node.js
- pnpm
- PostgreSQL + pgvector
- Redis
- NATS

future production desktop mode 不得要求用户安装这些开发依赖。生产桌面模式应转向 embedded local store，例如 SQLite + vector extension 或 LanceDB。

## MVP 非目标

- 不实现完整 Live2D。
- 不实现复杂自主行为。
- 不实现多角色系统。
- 不做重型微服务拆分。

MVP 应保持小、可运行、可测试、易扩展。
