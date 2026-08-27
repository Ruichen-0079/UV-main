# 当前架构

本文描述当前 main 基线上的实现边界。请先阅读[当前状态](current-state.zh-CN.md)，了解当前、已验证、实验、规划、延后和历史工作的分类。

## 权威与状态规则

当前源码和测试，以及更新的显式基线文档，优先于历史阶段说明。描述未来工作的文档必须明确标注“规划中”或“延后”。本机测量部署不会自动成为仓库默认值。Git history 和旧 pull request 只能说明系统如何演变，不能直接当作当前架构。

## 产品边界

YUVI 是本地优先、事件驱动的 AI 伴侣运行时。运行时负责回合编排、提示词构建、提供方选择、持久化边界、记忆检索和运行时事件。Web、Companion 以及未来的桌面 surface 都是运行时的表现和控制客户端。

当前产品没有权威的 P8 Persona/Relationship 状态机。`RelationshipContext` 等 prompt section 以及 `personaId` 等字段是已支持的集成/上下文边界；不能据此声称持久化 `RelationshipState` 或 `DynamicSelf` 已存在。

## 运行时边界

```text
Web Dashboard / Main / Companion surface
  -> Fastify HTTP、SSE 和 WebSocket 边界
  -> RuntimeOrchestrator
       -> 会话持久化
       -> 记忆检索与已定稿摄取持久性
       -> PromptBuilder
       -> ProviderRegistry / 提供方链
       -> Event Bus
  -> 可选媒体与虚拟形象表现层
```

### Web 与 Companion 表现层

`apps/web` 包含开发期 Dashboard，以及 Main 和 Companion surface。Companion surface 负责 Lumi Live2D/Cubism 渲染、语音播放和 Web Audio 表现。Main surface 负责聊天输入和流式文本。小型 Companion Bus 用于协调分离的 surface。Live2D 和语音表现受 capability gate 约束；模型、媒体提供方或连接不可用时，可以只让对应能力不可用，而不改变运行时回合语义。

`apps/desktop` 中的 Tauri shell 承载 Main 和 Companion 两个窗口，并包含桌面服务/监督集成。该 shell 已有开发和打包所需的实现，但最终的打包平台所有权和发布保证不是 Linux runtime 架构。

### Fastify server/API 边界

`apps/server` 负责 HTTP route、SSE framing、WebSocket transport、health/status 响应、启动、重载和关闭。Route 保持轻薄，把回合行为交给 core。当前 route 分组包括：

- `/health`、`/providers/status`、提供方验证和 runtime settings；
- 普通用户回合的 `/message`、`/v1/messages` 和 `/v1/messages/stream`；
- 助手主动文本回合的 `/v1/proactive-turns/stream`；
- memory、event、prompt-debug、Voice、Vision、TTS、STT 和 Live2D resource route；
- runtime event transport 与 Dashboard 事件观测使用的 `/ws`。

`GET /health` 和 `GET /providers/status` 只检查本地配置与缓存的观测结果，不执行远程提供方验证。显式验证 route 见[Providers](providers.zh-CN.md)。

### `RuntimeOrchestrator`

`packages/core` 是 runtime application boundary。它负责普通用户回合、助手主动回合、音频转写、视觉输入、记忆上下文、prompt preview、提供方调用、事件发布、会话持久化和 lifecycle sealing/draining。它依赖 port/interface，不直接依赖厂商 SDK。

### `PromptBuilder`

`packages/prompt-builder` 构建有边界的、提供方中立的 prompt section。当前 section 包括适用时的 `SystemIdentity`、`CharacterStyle`、`RelationshipContext`、`CurrentTime`、`CurrentAffect`、`DirectContext`、`RelevantMemory`、`CurrentSituation`、`Tools`、`ProactiveInstruction` 和 `UserMessage`。普通用户 prompt 含有用户消息；助手主动 prompt 使用 `ProactiveInstruction`，不会制造用户消息。

`CurrentAffect` 是从当前输入推导出的即时高置信度提示。`RelationshipContext` 是可用的 prompt 插槽，不是权威关系数据库。

### `ProviderRegistry`

`packages/providers` 负责提供方接口、标准化错误、提供方构造、fallback chain、readiness 状态、显式 live observation 和厂商 transport。当前能力包括 Chat、Reasoning、TTS、STT、Vision 和 Embedding。支持的实现包括通用 OpenAI-compatible 路径、DeepSeek、NVIDIA、Local、xAI、阿里云 DashScope、GPT-SoVITS，以及在允许 mock 时使用的显式 Mock 路径。

仓库中的环境示例使用通用 OpenAI-compatible DeepInfra Chat 路径，DeepSeek 作为 Reasoning 默认提供方。提供方选择仍由配置决定；开发机上的 credential 不是仓库行为。普通 Chat 使用常规 `/chat/completions` transport。P6 通过两个窄的 OpenAI-compatible 能力分别处理只返回控制标签的决策和助手续写。

### 会话持久化

会话持久化与长期记忆分离。它保存原始用户/助手消息、streaming 状态、会话身份和定稿元数据。In-memory 只支持同一进程内的 runtime 重建。配置 `CONVERSATION_REPOSITORY=postgres`、`DATABASE_URL` 并完成 migration 后，PostgreSQL 会支持进程重启后的会话恢复。

原始会话记录不会自动变成长时记忆，也不会整体倾倒进 prompt。Direct Context 是有边界的同会话近期视图；Relevant Memory 会先检索、排序、压缩和重构，再注入 prompt。

### 已定稿摄取持久性

P4 保护回复定稿之后的边界。Runtime 会先持久化最终助手文本，再向外暴露完成的 reply；在配置的语义记忆路径要求时，写入持久化的 finalized-turn 工作，并由 finalized-ingestion ledger 与 `MemoryIngestionCoordinator` 负责幂等投递、lease/version fencing、重试、对账和崩溃恢复。对于不确定的外部副作用，仍使用 fail-closed 与 reconcile 规则保护。详见 [P4 Linux-first 持久化](p4-linux-first.md)。

### 语义记忆提供方/后端

`packages/memory` 提供记忆 repository、检索、抽取、准入、维护和提供方中立的 memory event。Runtime 可通过 `MEMORY_BACKEND` 选择 Legacy 或 Mem0 backend。PostgreSQL + pgvector 支持持久化 hybrid retrieval；即使启用 embedding，keyword、trigram、full-text、metadata 和 structured filter 仍然重要。Mem0 返回的记录是通过 provider contract 暴露的证据，不是权威 Persona 或 Relationship 状态。

### 事件总线

Server 当前构造 in-memory event bus。Runtime event 包括 `user.message`、`user.voice.transcript`、`agent.reply`、`assistant.message`、`memory.retrieved`、`avatar.speak`、`provider.error` 和 `runtime.error`，以及媒体生命周期事件。`EVENT_BUS=nats` 是未来保留边界，当前未实现。

## 普通用户回合流程

```text
用户输入
  -> user.message / user.voice.transcript
  -> 配置了 Conversation Repository 时持久化用户消息
  -> 恢复有边界的 Direct Context
  -> read enabled 时检索 Relevant Memory
  -> PromptBuilder
  -> 配置的 Chat provider chain
  -> 持久化并定稿 assistant message
  -> agent.reply，然后 assistant.message
  -> 可选 memory 后处理和 TTS side effect
```

Streaming delta 会先持久化再 yield。最终文本会先持久化，再对外发布 reply event。Memory extraction/storage 和 TTS 是后处理边界，不能撤回已经定稿的 assistant reply。显式 memory 与持久化失败仍在各自语义边界保持必要的 fail-closed 行为。

## 助手主动回合流程

```text
带 idempotency key 的合资格客户端请求
  -> 已有 session 的上下文与可选记忆检索
  -> assistant-initiated PromptBuilder 输入
  -> decision provider：只允许 NO_OP 或 REQUEST_TEXT
       NO_OP        -> terminal result，不产生 assistant message
       REQUEST_TEXT -> 一次续写调用 -> 一条 assistant-only message
```

P6 已实现，但边界保持窄化：

- 第一阶段只决定 `NO_OP` 或 `REQUEST_TEXT`；
- 只有 `REQUEST_TEXT` 才允许生成 prose；
- `NO_OP` 不产生 assistant message；
- `REQUEST_TEXT` 只产生一条 assistant-only continuation，不制造 synthetic user event；
- 主动回合没有 memory-write、TTS 或 tool authority；
- 显式用户活动/控制优先于 proactive work；
- idempotency claim、取消和 stale-request fence 防止重放；
- 普通 Chat 仍是独立的 normal user-message path。

浏览器侧 behavior policy 会结合 consent、当前 presence 和用户活动来允许或抑制 proactive request。该策略是表现/控制仲裁，不替代 runtime 的语义决策阶段。

## 表现层与媒体

Voice 输入、TTS、Vision 和 Live2D 都是已实现的集成路径，但受 provider/capability 配置和运行环境影响。它们不表示延后的 P8 relationship authority 或最终打包生产发行版已经完成。
