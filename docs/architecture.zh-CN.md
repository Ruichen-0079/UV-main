# Architecture

[English](architecture.md) | [简体中文](architecture.zh-CN.md)

## 项目目标

YUVI Runtime 是一个本地优先、事件驱动的 AI 伴侣运行时。

核心产品是 Runtime 本身。Web、Desktop、Live2D/VRM、语音界面、游戏集成以及未来 Character Model，都应该消费同一套 Runtime 语义，而不是分别拥有自己的会话、记忆和执行逻辑。

本仓库是原创实现。架构目标不是搭一个庞大的通用 assistant framework，而是保留清晰、窄小、可验证的语义边界。

中文术语以 [统一术语表](terminology.zh-CN.md) 为准。

## 当前平台基线

YUVI 当前采用 **Linux-first**。

原生 Linux 是主要开发平台，也是当前生产行为、持久化和可靠性验证的主要平台。主路径使用 Node.js、pnpm、Bash lifecycle scripts，并在需要 durable state 时接 PostgreSQL。

Windows 继续作为兼容与 packaging 平台存在，但 Windows 专用的进程 ownership、installer provisioning、bundled PostgreSQL、ACL/Credential Manager 等不属于 Runtime correctness requirement。

P4 当前主要 durable boundary：

```text
Runtime / Memory
  -> repository ports
  -> DATABASE_URL
  -> PostgreSQL
  -> YUVI migrations
```

PostgreSQL 可以来自外部实例、系统服务或容器。Runtime Core 不需要拥有数据库进程。

持久化重基线见 [p4-linux-first.md](p4-linux-first.md)。

## 核心原则

### Runtime 拥有执行语义

`packages/core` 负责 Runtime 编排：admission、lifecycle、provider execution、cancellation fencing、persistence ordering、finalized-turn coordination 和 authoritative runtime event publication。

它不应该变成 vendor SDK layer、操作系统 supervisor 或 presentation engine。

### 持久化与呈现分离

原始会话持久化、semantic long-term memory 和可见 presentation 是三个不同职责。

一个 assistant effect 在被 presentation 当作权威结果前，必须先满足当前路径要求的 persistence / lifecycle semantics。

### Memory 是证据，不是原始聊天日志

`packages/memory` 拥有 durable memory record、retrieval/ranking、memory validity/status、Conversation Repository、finalized-ingestion persistence 和 PostgreSQL migration。

原始 conversation message 不会自动成为长期 semantic memory。

### Provider 可替换

厂商专用网络请求和 response handling 属于 `packages/providers`。

Runtime Core 只消费 provider-neutral contract，不直接 import DeepSeek、xAI、Alibaba/DashScope 等厂商 client concrete class。

### Presentation 负责呈现结果，不拥有 Runtime truth

Web、Desktop、speech、avatar、gaze 和未来 embodied behavior 负责渲染或汇报已被 admission 的 effect。它们不单独拥有 persistence、relationship truth 或 capability admission authority。

## 主 Runtime 数据流

普通用户回合概念上是：

```text
User input
  -> Runtime admission
  -> conversation persistence
  -> Direct Context + Memory retrieval
  -> PromptBuilder
  -> provider execution
  -> assistant persistence/finalization
  -> runtime events
  -> optional presentation effects
```

可选 TTS、avatar rendering 等 presentation side effect，不应该反过来让已经按 Runtime contract finalized 的 assistant reply 失效。

## 当前 P6 主动行为边界

当前 proactive path 有意保持很窄。

`ProactiveDecisionProvider` 是当前 proactive text decision 的语义 authority：

```text
NO_OP | REQUEST_TEXT
```

- `NO_OP` 不产生 assistant text effect。
- `REQUEST_TEXT` 才允许进入 assistant-only continuation。
- assistant-initiated continuation 不制造 synthetic user event 或 user conversation row。
- proactive output 不因为是主动生成就获得 semantic Memory-write authority。
- active/retained idempotency claim 防止不安全 replay。
- cancellation 和 stale async result 在 persistence/publication 前被 fencing。

如果未来 Character / Continuity 扩展为更广泛的 proactive authority，必须通过明确的 atomic migration 替换当前 authority；同一个 effect 不能同时由两个 proactive decision owner 决定。

## 包职责

### `apps/server`

Fastify composition root 与 HTTP/WebSocket transport。负责 process startup/shutdown、route wiring、configuration composition、health surface 和 dependency construction。Handler 应保持轻薄。

### `apps/web`

开发控制台与当前 Companion presentation surface。它消费 Runtime/server contract，不应在 UI state 中复制 Runtime 语义。

### `apps/desktop`

Tauri desktop shell 与 platform packaging integration。Desktop packaging concern 应位于产品行为和 Runtime correctness 的下游。

### `packages/core`

Runtime 编排与 semantic execution boundary。

主要职责：

- 用户/assistant turn orchestration；
- 通过 interface 执行 provider；
- cancellation 与 lifecycle fencing；
- conversation/persistence ordering；
- finalized-turn memory ingestion coordination；
- proactive assistant-only Runtime execution；
- authoritative runtime event publication。

### `packages/memory`

Persistence 与 Memory authority。

主要职责：

- Conversation Repository implementation；
- long-term memory record 与 retrieval；
- Memory provider/backend boundary；
- finalized-ingestion durable parent/child state；
- retry/reconcile persistence primitive；
- PostgreSQL repository 与 migration；
- memory expiry/validity/status semantics。

### `packages/prompt-builder`

把上游已经授权的输入组装为结构化、provider-neutral prompt context。

它不拥有 persistence、relationship truth、provider routing 或 execution lifecycle。

### `packages/providers`

Provider interface、registry/routing、vendor adapter、normalized provider error 和厂商专用 transport behavior。

### `packages/protocol`

共享 Runtime event contract 与 schema。

### `packages/event-bus`

Runtime event-bus 抽象。当前已经实现的运行模式是 in-memory；未来 transport implementation 必须保留 event semantics，而不是重新定义它们。

### `packages/config`

类型化配置 parsing、selection boundary、validation 与 secret redaction helper。

### `packages/desktop-supervisor`

Desktop/platform supervision 与 packaging substrate。它不能成为 Linux Runtime persistence correctness 的必需依赖。

## 可靠性基线

以下内容是已经证明的 reliability asset，不是结构重构时应删掉或削弱的对象：

- finalized-turn lifecycle 与 sealing/draining；
- durable finalized-ingestion ledger；
- semantic idempotency；
- crash/restart recovery；
- retry 与 exact reconciliation；
- ambiguous external side effect protection；
- 正确的 fail-closed persistence/memory boundary；
- cancellation 与 stale-effect fencing。

结构重构可以移动代码或测试，但不能改变这些语义。

## 开发基础设施

`infra/docker-compose.yml` 提供 PostgreSQL + pgvector、Redis、NATS 等开发服务。

这些是 development infrastructure，不代表最终产品必须以 containerized microservice stack 形式交付。

PostgreSQL 是当前主要 durable persistence implementation。Redis/NATS 或未来 event infrastructure 都应留在明确 interface 后面，不能仅为了“架构更完整”而提前引入额外 abstraction。

## Future Architecture

结构收口后的 Companion roadmap 位于 [future/README.md](future/README.md)。

它把未来职责拆成：

- P8 identity/persona/relationship interpretation；
- temporal substrate；
- continuity and attention；
- Character Model behavior；
- Cognition complex reliable reasoning；
- thin Character Harness；
- capability/MCP boundary；
- embodied presentation；
- Character post-training。

这些文档描述 planned contract。它们不是提前创建新 Manager、Engine、generic agent graph 或 duplicate authority 的许可；只有进入对应 product phase 后才实现。

## 非目标

- 不为了形式做重型微服务拆分。
- 不为同一个 semantic decision 创建第二个 owner。
- 不把 platform-packaging machinery 塞进 Runtime Core。
- 不让 Core 直接耦合 raw provider SDK。
- 不把 raw chat log 当作 authoritative long-term memory。
- 不把随机 avatar motion 伪装成 autonomous agency。
- 当 narrow domain seam 足够时，不创建 broad generic framework。

架构应保持 explicit、testable、reversible，并且足够小，让下一步设计由产品行为推动，而不是由基础设施推动。