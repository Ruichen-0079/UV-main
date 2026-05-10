# Architecture

## Project Goal

AI Companion Runtime 是一个事件驱动、本地优先的 companion 运行时。

它受到 Project AIRI 架构愿景的启发，但本仓库是原创实现。目标不是做一个简单聊天机器人，而是构建一个运行时基础，用来支持记忆、提示词构建、提供商抽象、语音、视觉、Avatar 展示，以及未来的游戏 agent 行为。

## Core Principle

运行时是核心产品。

Avatar 渲染只是表现层。Live2D、VRM、游戏角色、终端客户端或 Web UI 都应该与同一个运行时通信。

提供商是可替换的。运行时编排依赖小接口，包括提供商解析接口，而不是 vendor SDK。

记忆不是原始聊天日志。记忆必须以结构化记录存储，在进入提示词之前经过检索、排序、压缩和重构。

## Main Data Flow

```text
User input
  -> runtime event
  -> memory retrieval
  -> prompt builder
  -> DeepSeek chat/reasoning
  -> agent.reply event
  -> optional xAI TTS
  -> avatar.speak / avatar output
```

语音和视觉也进入同一个事件模型：

```text
Audio input
  -> Alibaba DashScope STT
  -> user.voice.transcript
  -> normal reply flow

Image or screen input
  -> xAI vision
  -> perception.vision
  -> runtime context
```

## Package Responsibilities

### `apps/server`

Fastify 运行时服务器。负责 HTTP routes、WebSocket transport、健康检查、启动和优雅关闭。Handler 应该保持轻薄，并委托给 `packages/core`。

### `packages/protocol`

共享的运行时事件类型和 schema。所有运行时输入和输出都应该表示为事件。

### `packages/event-bus`

事件总线抽象。MVP 使用带通配符订阅的内存实现。之后可以在同一接口背后加入 NATS。

### `packages/memory`

记忆仓库和记忆服务层。使用 PostgreSQL + pgvector 做持久记忆，并提供内存开发 fallback。负责记忆类别、检索、评分占位逻辑，以及 prompt-safe 重构。

### `packages/prompt-builder`

从身份、角色风格、关系上下文、检索到的记忆、当前情境、工具和用户消息构建结构化、提供商中立的提示词。

### `packages/config`

运行时配置边界。负责把 environment-shaped input 解析为 typed config、表达 provider selection、验证启用 provider 所需字段，并提供安全 redaction helper。它不实例化 provider client，也不 import DeepSeek、xAI 或 Alibaba 具体实现。

### `packages/providers`

提供商接口、注册表、标准化错误，以及具体提供商实现。Vendor-specific 的请求/响应处理都留在这里。

### `packages/core`

运行时编排。接收事件、检索记忆、构建提示词、调用提供商接口、存储重要交互，并发出运行时事件。

## Provider Mapping

默认提供商选择：

- Chat: DeepSeek API
- Reasoning: DeepSeek API
- TTS: xAI
- Vision: xAI
- STT: Alibaba Cloud DashScope
- Embedding: configurable

`packages/core` 绝不能直接 import DeepSeek、xAI 或 Alibaba class。提供商相关构造属于 `packages/providers`，其中 factory map 会把配置的提供商名称绑定到具体实现。

提供商失败会被标准化为 `provider.error` 事件。非关键副作用，例如回复后的记忆持久化和可选 TTS 输出，不应该阻止已经生成的 agent reply 被返回。

## Future Modules

计划中的模块和集成：

- Live2D / VRM frontend
- autonomous loop
- screen perception
- Minecraft/game agent
- emotion engine
- procedural memory
- NATS event bus implementation

这些模块应该通过 protocol 和事件总线集成，而不是绕过运行时核心。

## Non-Goals For MVP

- 暂不做完整 Live2D 集成。
- 暂不做复杂自主行为。
- 暂不做多角色系统。
- 暂不做重型微服务拆分。

MVP 应该保持小、可运行、易扩展。
