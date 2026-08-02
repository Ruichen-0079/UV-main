# Architecture

## 项目目标

YUVI Runtime 是一个本地优先、事件驱动的 AI 伴侣运行时。它受到 Project AIRI 架构愿景启发，但本仓库是原创实现，不复制 AIRI 代码。中文用词以[统一术语表](terminology.zh-CN.md)为准。

最终目标是一个面向 Windows、macOS、Linux 的一体化桌面应用。当前阶段先构建可运行、可调试、可扩展的 runtime 基础。

核心方向：

- 运行时核心
- 协议事件
- 记忆子系统
- 提示词构建器
- 提供方抽象
- 开发期 Web 控制台
- 规划中的 Tauri 桌面模式
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
- 规划中的桌面模式必须与开发基础设施解耦。

## 核心原则

运行时是核心产品。虚拟形象、Web 控制台、终端客户端和规划中的桌面外壳都应通过同一个运行时通信。

`packages/core` 只依赖接口，不直接 import DeepSeek、xAI、Alibaba concrete class。provider-specific 代码属于 `packages/providers`。

记忆不是把原始聊天日志直接塞进 prompt。记忆必须被检索、排序、压缩、重构，然后再注入 prompt。

所有主要输入/输出都应该表示为 runtime event。

事件语义中，`agent.reply` 是运行时编排器产生的内部回复，`assistant.message` 是最终向用户发布的文本消息。主对话流当前产生 `agent.reply`；面向最终发布语义的传输层或消费者应使用或转换为 `assistant.message`。两者不是可随意互换的同义事件。

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

当前 Web 控制台需要的主要 API 端点：

- `GET /health`
- `GET /providers/status`
- `POST /v1/messages`（版本化端点）
- `POST /message`（兼容端点）
- `GET /memory/recent`
- `POST /memory`
- `GET /memory/search?q=`
- `GET /events/recent`
- `GET /debug/prompt/latest`
- `GET /ws`

### `apps/web`

Vite + React + TypeScript + Tailwind CSS 开发期 Web 控制台。它用于调试运行时，不是 Live2D 用户界面。

### `packages/protocol`

共享 runtime event 类型和 schema。所有主要 I/O 都应该通过事件表达。

### `packages/event-bus`

事件总线抽象。MVP 使用内存实现，未来可在同一接口背后接入 NATS / JetStream。

### `packages/memory`

记忆与会话持久化仓储以及记忆服务。长期记忆使用 PostgreSQL + pgvector 或内存回退实现；原始会话消息使用独立的 Conversation Repository。In-Memory 会话仓储只能在同一进程内重建 Runtime 时恢复上下文，PostgreSQL 才支持进程重启后的恢复。Core 只依赖 Conversation Repository 端口，由 Server 创建并注入具体实现；会话原始消息不等同于长期记忆。

### `packages/prompt-builder`

把系统身份、角色风格、关系上下文、相关记忆、当前情境、可用工具和用户消息组装为提供方中立的提示词。

### `packages/config`

typed runtime configuration boundary。负责 env parsing、provider selection、validation、redaction helper。它不实例化 provider client。

### `packages/providers`

提供方接口、注册表、标准化错误和厂商专用实现。DeepSeek、xAI、DashScope 的具体请求/响应处理都属于这里。

### `packages/core`

运行时编排。负责接收事件、检索记忆、构建提示词、调用提供方接口、写入重要交互和发布运行时事件。

## Provider Mapping

默认 provider：

- Chat: DeepSeek API
- Reasoning: DeepSeek API
- TTS: xAI
- Vision: xAI
- STT: Alibaba Cloud DashScope
- Embedding: configurable

密钥只应存在于本地 `.env` 或安全配置来源中，不应出现在日志、控制台、事件负载或错误响应中。

## 开发与生产模式

development mode 可以依赖：

- WSL2
- Docker Engine
- Node.js
- pnpm
- PostgreSQL + pgvector
- Redis
- NATS

规划中的桌面模式不得要求用户安装这些开发依赖。其本地存储应转向嵌入式本地存储，例如 SQLite + 向量扩展或 LanceDB。

## MVP 非目标

- 不实现完整 Live2D。
- 不实现复杂自主行为。
- 不实现多角色系统。
- 不做重型微服务拆分。

MVP 应保持小、可运行、可测试、易扩展。
