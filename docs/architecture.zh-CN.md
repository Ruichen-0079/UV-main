# Architecture

[English](architecture.md) | [简体中文](architecture.zh-CN.md)

## 项目目标

YUVI Runtime 是一个本地优先、事件驱动的 AI 伴侣运行时。本仓库为原创实现，受到 Project AIRI 的架构愿景启发，但不复制 AIRI 代码。中文术语以[统一术语表](terminology.zh-CN.md)为准。

产品核心是 Runtime，而不是某一个聊天 UI。Web、desktop、avatar、terminal、voice、vision 以及未来 Character 表层都应汇聚到同一套 Runtime 权威之上，而不是各自实现一套平行产品逻辑。

## 当前开发基线

YUVI 当前采用 **Linux-first** 开发与生产验证策略。

目前已经验证的 durable path 是：

```text
Linux Runtime
  -> repository ports
  -> DATABASE_URL
  -> PostgreSQL + pgvector
  -> migrations
  -> durable conversation / finalized-ingestion / Memory behavior
```

Windows 仍然是支持目标，但复杂的 Windows packaged PostgreSQL ownership machinery 已明确延后，直到产品行为稳定。架构优先保证 Runtime 语义正确，再做平台翻译；不再为了 Windows 单独扩张第二套 persistence ownership 模型。

## 核心原则

### Runtime 拥有执行权

Runtime 负责：

- effect lifecycle
- execution admission
- cancellation 与 stale-result fencing
- conversation persistence coordination
- finalized-turn handling
- provider execution
- canonical runtime publication

Transport、Dashboard、Presentation 以及未来 Character 层都不能绕过这套执行权威。

### 可靠性语义是已经获得的资产

finalized-turn lifecycle、durable ingestion、semantic idempotency、retry/reconcile、crash recovery、lifecycle sealing/draining，以及 ambiguous external side effect protection 都已经是架构资产。

结构重构只能搬移和收口这些能力，不能为了“更干净”而削弱它们。

### Memory 是证据，不是人格真相

原始会话持久化与长期 Memory 是两个不同职责。

Memory 负责 evidence record 的存储、retrieval/ranking、validity/status、retention 与 expiry。它不拥有 authoritative relationship truth，也不拥有未来 P8 persona state。未来消费者可以解释经过授权的 evidence，但不能把 Memory 偷换成隐藏的 relationship authority。

### Provider 可替换

`packages/core` 依赖 provider-facing contract，而不是厂商 SDK。厂商请求/响应转换以及具体 client 构造属于 `packages/providers`。

### 小 semantic diff 优先

当“更漂亮的抽象”和“更小的行为保持改动”冲突时，优先选择更小的 semantic diff。不要提前制造 Manager / Engine / Service 层，只为了给现有职责换名字。

## 主要数据流

普通用户回合：

```text
User input
  -> Runtime admission
  -> conversation persistence
  -> DirectContext / Memory retrieval
  -> prompt construction
  -> provider execution
  -> assistant persistence
  -> finalized-turn handling
  -> runtime publication
  -> optional presentation side effects
```

语音与视觉通过 provider-normalized input 进入同一 Runtime，不形成独立产品架构：

```text
Audio input
  -> STT provider
  -> transcript / runtime input
  -> normal Runtime flow

Image or screen input
  -> vision provider
  -> normalized perception/context
  -> Runtime flow
```

当前 P6 assistant-initiated 文本流：

```text
ProactiveDecisionProvider
  -> NO_OP
     或
  -> REQUEST_TEXT
  -> assistant continuation
  -> Runtime execution commit
  -> assistant-only proactive Runtime stream
```

P6 保留严格的 user-over-proactive priority、one-shot execution、fresh Runtime identity、cancellation fencing，并且不会创建 synthetic user event，不会获得 proactive Memory-write authority，也不会获得独立 proactive TTS/voice authority。

## 包职责

### `apps/server`

Fastify HTTP/WebSocket server 与 composition root。负责 transport、startup/shutdown、health/configuration wiring，以及 concrete repository/provider 的创建与注入。Route handler 应保持轻薄，把产品语义交给 Runtime/package boundary。

### `apps/web`

开发期 Dashboard。它通过受支持 API 观察和控制 Runtime。它不拥有 conversation、identity、Memory 或 proactive semantics 的产品权威。

### `packages/protocol`

共享 Runtime event 类型与 Schema。Canonical event semantics 应在这里统一，不应由每个 transport/UI 自己猜。

### `packages/event-bus`

事件总线抽象与当前内存实现。NATS 可以继续作为支持性/未来基础设施留在同一边界后，但不能成为提前把 Runtime 拆成微服务的理由。

### `packages/memory`

负责 conversation repository、durable Memory repository/service、finalized-ingestion ledger/service、retrieval/ranking 与 Memory maintenance semantics。

重要边界：

- raw conversation message 不等于 long-term Memory
- PostgreSQL 支持进程重启后的 durable recovery
- in-memory repository 是开发/测试 fallback
- finalized ingestion 保留 durable parent/child status 与 idempotency semantics
- Core 消费 repository/service port，由 Server 注入具体实现

### `packages/prompt-builder`

从经过授权的输入构造 provider-neutral prompt/context structure。它不拥有 Runtime execution、Memory persistence 或未来 persona/relationship authority。

### `packages/config`

类型化 Runtime configuration、env parsing/validation、provider selection configuration 与 redaction helper。它不实例化产品语义。

### `packages/providers`

Provider contract、registry/factory、normalized error 与厂商 adapter。当前 provider family 包括 chat/reasoning、proactive decision/continuation、TTS、STT、vision 与 embedding。

### `packages/core`

负责 Runtime contract/error 与 RuntimeOrchestrator execution semantics。它协调 persistence、context retrieval、prompt construction、provider call、cancellation、finalized-turn behavior 与 runtime publication。

Package root 是 public barrel；不能仅仅为了测试方便，就让 implementation module 意外变成第二套 public API。

## Runtime Contract 与 Error

Canonical Runtime contract type 与 error 已经有独立 module seam。消费者必须保留 canonical error identity，不能复制一份“长得一样”的 class。

例如 persistence failure 与 assistant-turn idempotency conflict。Server handler 可能依赖 `instanceof`，因此 duplicate error definition 在语义上并不等价。

## Persistence 与 Finalized Turn

Durable Runtime path 明确保留“assistant reply 已经成功”与“后续可选 Memory ingestion side effect 失败”之间的区别。

Finalized-turn ingestion 支持 durable status，包括 processing、retryable failure、reconcile-required、partial、complete、terminal failure，以及适用时的 skipped。Re-entry 必须尊重 durable status，不能从进程内状态臆造 complete。

Lifecycle transition 会保留已经 admitted 的工作。Shutdown/reload 在需要时等待既有 work drain，并在 sealing 开始后拒绝新的 lifecycle-sensitive operation。

## Provider Mapping

当前默认方向：

- Chat：DeepSeek
- Reasoning：DeepSeek
- TTS：xAI
- STT：Alibaba Cloud DashScope
- Vision：xAI
- Embedding：可配置

Provider failure 在 provider boundary 标准化。除非 Runtime contract 明确要求，否则 optional post-processing failure 不能反过来让已经 finalized 的成功 reply 失效。

## 当前结构状态

大型 Runtime implementation 已经从 `packages/core/src/index.ts` 中抽离到明确 implementation seam。Runtime 测试也正在按 semantic island 拆分：

- streaming/reply
- finalized persistence / P4
- Memory integration
- proactive / P6

R5A1、R5A2、R5A3 已完成；R5A4 与最终 structural closeout 完成后，才恢复产品开发。

这一轮拆分刻意保持机械性：允许小型 test helper 重复；不允许修改 assertion、state shape、Runtime API、provider semantics 或 production behavior。

## Future Boundary

结构收口后进入未来 companion work。规划顺序从 P8 identity/persona/relationship 开始，再到 temporal、continuity/attention、Character/Cognition boundary、capabilities、embodied presentation，以及 Character post-training。

这些文件是规划权威，不代表对应系统已经实现。入口见 [`future/README.md`](future/README.md)。
