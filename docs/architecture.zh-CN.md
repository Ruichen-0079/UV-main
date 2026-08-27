# Architecture

[English](architecture.md) | [简体中文](architecture.zh-CN.md)

本文描述当前 YUVI 的架构边界。带日期的产品事实快照与文档权威规则见 [current-state.zh-CN.md](current-state.zh-CN.md)。中文技术术语遵循 [terminology.zh-CN.md](terminology.zh-CN.md)。

## 产品边界

YUVI 是本地优先的 AI 伴侣运行时。Runtime 负责 turn 的语义编排；Web、控制台、Live2D、语音播放和桌面界面属于围绕 Runtime 的呈现或 transport 层。

Linux 是主要开发平台和生产验证平台。Windows 兼容仍然支持，但 Windows packaged-private PostgreSQL ownership 属于延后的平台打包工作，不是当前 persistence 主架构。

## Runtime 结构

```text
Web / Companion presentation
        |
        v
Fastify API / SSE / WebSocket
        |
        v
RuntimeOrchestrator
  |- PromptBuilder
  |- ProviderRegistry / ProviderResolver
  |- conversation persistence
  |- semantic Memory boundary
  |- finalized-ingestion durability
  `- event bus
```

主要边界：

- `apps/server` 负责 HTTP/SSE/WebSocket transport、请求校验、health/status projection、启动与优雅关闭。
- `packages/core` 负责 Runtime turn orchestration 和 lifecycle semantics。
- `packages/prompt-builder` 负责组装 provider-neutral prompt sections。
- `packages/providers` 负责 provider interfaces、provider-chain routing、标准化失败与厂商/网关 transport。
- `packages/memory` 负责 conversation/Memory persistence contract、semantic Memory evidence contract、retrieval 与 finalized-ingestion durability primitives。
- `packages/event-bus` 是事件抽象；当前 Runtime 使用 in-memory event bus。
- Web/Companion 代码负责 presentation policy 与 execution surface。一个界面能够呈现或调度机会，并不会因此获得语义决策权威。

## 普通用户 turn

普通用户 turn 走用户消息 Runtime 路径：

```text
user input
  -> Runtime user turn
  -> durable/raw conversation boundary
  -> Direct Context + Memory retrieval
  -> PromptBuilder
  -> configured Chat provider chain
  -> streaming/final assistant text
  -> assistant conversation persistence + Runtime events
  -> finalized-turn memory-ingestion coordination
  -> requested/available 时的 optional presentation / TTS side effects
```

Memory read 与 write 控制相互独立。Direct Context 是近期对话上下文，不是长期 Memory。长期 Memory 通过 semantic Memory boundary 以 evidence 形式进入 prompt。

Provider-chain execution 与 provider diagnostics 也是两个边界。本地 readiness/status 检查本身不证明远端 Provider 可达，也不会执行 live provider I/O。

## 助手发起的主动 flow（P6）

当前 proactive text 是独立的 assistant-initiated flow，不是 synthetic user turn：

```text
Companion idle/presence eligibility
  -> reducer-admitted proactive opportunity
  -> fresh presentation-layer candidate
  -> MainPage consent/admission + execution arbitration
  -> POST /v1/proactive-turns/stream
  -> Runtime assistant-initiated turn
  -> ProactiveDecisionProvider
       |- NO_OP ---------> terminal, no assistant text
       `- REQUEST_TEXT --> AssistantContinuationProvider
                            -> one validated assistant-only continuation
                            -> persistence + SSE projection
```

当前 P6 不变量：

- user/lifecycle work 的优先级高于 proactive work；
- decision capability 只能返回 `NO_OP` 或 `REQUEST_TEXT`；
- 只有 `REQUEST_TEXT` 才会调用 assistant continuation generation；
- 不创建 synthetic Runtime user message；
- proactive text 没有 memory-write、TTS/voice 或 tool authority；
- stale callback/effect 被 fencing，已准入 attempt 是 one-shot/non-replayable；
- presentation candidate identity 与 Runtime idempotency identity 新鲜且彼此分离；
- 普通用户 Chat 保持独立的 provider/Runtime 路径。

当前 presentation eligibility 常量是：idle 12 秒、cooldown 30 秒、intent TTL 1800 ms、每个 idle episode 最多一次 attempt；同时受 visibility、online、Live2D、lifecycle、speech、transition、consent 与 execution admission gate 约束。

## 呈现 / P5

Live2D 伴侣呈现已经实现。Companion surface 负责 Lumi/Live2D 呈现、speech playback queue 与 browser audio projection；Main surface 负责 chat input/streamed text，并通过 companion bus 转发呈现工作。

呈现层消费规范化后的 Runtime/presence truth；它不定义 Persona truth、relationship truth、provider availability 或 Memory truth。

## 持久化 / P4

Linux 的主要 durable architecture 是：

```text
YUVI
  -> repository interfaces
  -> DATABASE_URL
  -> external / system / container PostgreSQL
  -> YUVI migrations
```

YUVI 负责 repository correctness、migration、finalized-turn lifecycle、durable ingestion state、idempotent semantic delivery、crash recovery、retry/reconciliation semantics 与 ambiguous-side-effect protection。在 Linux 上，YUVI 不需要拥有 PostgreSQL 的操作系统进程。

详见 [p4-linux-first.md](p4-linux-first.md)。Windows private cluster/process/ACL/Credential Manager/installer ownership 是 deferred packaging；已关闭且未合并的 PR #20 是历史证据，不是当前架构。

## Memory boundary

Runtime 应消费 vendor-neutral `MemoryProvider` / `MemoryEvent` semantics，而不是直接依赖 Mem0 DTO。Memory 是 evidence，不是权威 Persona、Affect、Relationship、Interest 或 Commitment state database。

Retrieval 保留 epistemic status：`ok`、`empty`、`unavailable`、`error`、`partial` 不能混为一谈。来源缺失的 timestamp 保持 unknown。词法、trigram、full-text 与可选 vector retrieval 可以共存；vector failure 不能破坏 lexical fallback。

## Provider / P7

Provider 是 registry/resolver 边界后的可替换能力实现。当前能力包括 Chat、Reasoning、TTS、STT、Vision 与 Embedding，并支持配置化 provider chain 与 fallback policy。

必须区分两个诊断轴：

- **readiness**：本地配置/构造就绪状态；零 provider I/O；
- **observed state**：最近一次显式 verification 观察结果；live Verify 可能产生远端、甚至计费的调用。

普通 `/health` 与 provider status inspection 不等于 live provider probe。

## Prompt 与 P8 边界

`PromptBuilder` 当前确实存在 `SystemIdentity`、`CharacterStyle`、`RelationshipContext`、`CurrentAffect`、`DirectContext`、`RelevantMemory` 等语法 section。section 存在并**不**意味着已经存在 P8 的权威持久 Persona/Relationship producer。

P8 尚未实现为 persistent `RelationshipState`、affinity/trust score、`DynamicSelf` 或类似 state machine。当前 Memory 仍然只是 evidence；未来 P8 可以结合 stable persona rules、真实选取的 Memory evidence、近期对话和 Runtime truth 做模型解释。

## 明确不是当前架构的内容

以下内容不是当前 core architecture：

- 把 Windows packaged-private PostgreSQL 当作产品 persistence gate；
- 把 PR #20 整体当作必须恢复的 migration path；
- persistent P8 relationship/affinity/trust state；
- 把 Live2D 或 proactive text 整体描述为 future work；
- 把 512 维本地 Qwen embedding output 写成 production default；
- 把 NATS 写成当前 active Runtime event bus。

planned 或 experimental 工作必须明确标记，不能写成当前行为。