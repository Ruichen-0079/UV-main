# YUVI 当前状态

[English](current-state.md) | [简体中文](current-state.zh-CN.md)

**Status snapshot date: 2026-08-27**

**Repository baseline: `62028e41d78383fc47f22f4afa1c1e9996d5bab1`（DOC-R1 准备开 PR 时的 `origin/main`）**

本文使用以下状态标签：

- **CURRENT** — 已在该 repository baseline 的源码/测试/配置中实现或跟踪的产品行为。
- **VALIDATED LOCAL DEPLOYMENT / MEASUREMENT-ONLY** — 在 tracked production default 之外完成的本地验证；不能因此推导为仓库默认行为。
- **PLANNED** — 未来方向，尚不是已实现产品事实。
- **DEFERRED** — 明确延后，不是当前产品 gate。
- **HISTORICAL** — 有价值的实现历史，不是当前 architecture authority。

## 1. 产品方向

**CURRENT：** YUVI 是本地优先的 AI 伴侣运行时。产品围绕共享 Runtime 构建 conversation、semantic Memory、Provider routing、media capability、Companion presentation 与有边界的 assistant-initiated behavior，而不是只做一个聊天页面。

Linux 是主要开发平台、产品开发平台和生产验证平台。

## 2. 平台状态

**CURRENT：** Linux 是当前 active product work 与 durable validation 的主平台。Native Windows development、Windows desktop/package 代码仍保留在仓库中，并继续作为兼容性路径接受覆盖。

**DEFERRED：** Windows installer-owned/private PostgreSQL lifecycle、bundled PostgreSQL/pgvector、private process ownership、Windows ACL/Credential Manager ownership 与相关 provisioning 属于平台打包工作，不阻塞 Linux 产品行为。

## 3. Runtime 架构

**CURRENT：** 当前主要边界是：

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

Runtime 负责 turn 的语义行为。Transport/presentation 代码可以投影、准入、呈现或执行工作，但不会因此成为 Memory、Persona 或 Provider truth 的权威来源。

普通 user turn 与 assistant-initiated proactive turn 是分离的 Runtime path。详见 [architecture.zh-CN.md](architecture.zh-CN.md)。

## 4. Persistence / P4

**CURRENT：** [p4-linux-first.md](p4-linux-first.md) 是当前 P4 baseline。

Linux 的主要 durable persistence：

```text
YUVI
  -> repository interfaces
  -> DATABASE_URL
  -> external / system / container PostgreSQL
  -> YUVI migrations
```

当前必须保留的 reliability assets 包括：

- finalized-turn lifecycle；
- durable finalized-ingestion ledger/state；
- idempotent semantic delivery；
- crash recovery；
- retry 与 exact reconciliation semantics；
- ambiguous external side-effect protection；
- 在 semantic persistence/Memory boundary 要求时的 fail-closed behavior。

Linux 上 YUVI 不需要拥有 PostgreSQL 操作系统进程。

**DEFERRED / HISTORICAL：** PR #20（`P4-2D2`）已关闭且未合并。不得把它写成 current main architecture，也不得整体恢复。

## 5. Presentation / P5

**CURRENT：** Live2D companion presentation 已实现，不再是 future-only。Web Companion surface 集成 Lumi/Live2D lifecycle、规范化 presence/capability projection、behavior policy、speech playback queue、browser audio/analyser behavior 与 presentation state。Main surface 负责 chat input/streamed text，并通过 companion bus 发送 presentation work。

Presentation/execution responsibility 与 semantic decision authority 保持分离。Live2D state 不定义 Persona truth、relationship truth、Memory truth 或远端 Provider availability。

## 6. Proactive / P6

**CURRENT / FROZEN：** P6 proactive text 使用两阶段 Provider flow：

1. `ProactiveDecisionProvider` 只能返回 `NO_OP` 或 `REQUEST_TEXT`。
2. 只有 `REQUEST_TEXT` 后才运行 `AssistantContinuationProvider`，并且至多产生一条 assistant-only continuation。

当前 tracked/example provider 配置以及已合并的 live acceptance path 使用 generic OpenAI-compatible remote gateway：

- decision：`meta-llama/Llama-3.3-70B-Instruct-Turbo`；
- assistant continuation 与 normal Chat model：`deepseek-ai/DeepSeek-V4-Flash-0731`；
- second call 显式使用 `deepseek-v4` assistant-continuation format。

冻结语义：

- `NO_OP` 不产生 proactive assistant output；
- `REQUEST_TEXT` 至多产生一条 assistant-only proactive continuation；
- 不创建 synthetic user message；
- proactive 没有 Memory-write authority；
- proactive 没有 TTS/voice/tool authority；
- user/lifecycle execution 严格优先于 proactive；
- stale async callback/effect 被 fencing；
- attempt 是 one-shot/non-replayable；
- presentation candidate identity 新鲜，并与独立的新 Runtime idempotency identity 分离；
- normal user Chat 保持独立。

Presentation eligibility 当前仍受 idle 12 秒、cooldown 30 秒、intent TTL 1800 ms、每 idle episode 最多一次 attempt，以及 visibility/online/Live2D/lifecycle/speech/transition gate 约束。MainPage consent/admission 与 execution arbitration 还是额外 gate。

## 7. Provider / P7

**CURRENT：** Provider architecture 支持 capability-specific interface，并为 Chat、Reasoning、TTS、STT、Vision、Embedding 提供可配置 chain/fallback。已实现 P7 范围包括 provider contract hardening、Chat streaming、fallback/error policy、cancellation propagation、batch STT、TTS、Vision、runtime settings state、provider diagnostics、显式 Verify 与 Dashboard projection。

必须区分两个轴：

- **provider readiness** = 本地配置/可构造状态；零 provider I/O；
- **provider observed state** = 显式 verification 的缓存观察结果；live verification 可能进行远端、甚至计费调用。

普通 `/health` 与 provider status inspection 不执行 live provider verification。

Settings 必须区分 unsaved draft、saved/effective configuration 与 active Runtime state。**Save Only** 不得描述为已经应用到 Runtime；**Save & Apply** / 显式 apply-reload 是另一条动作边界。

## 8. Memory

**CURRENT：** Runtime-facing Memory boundary 以 evidence 为核心，并保持 vendor-neutral。

Read path：

```text
Mem0 / other backend
  -> MemoryBackend
  -> MemoryProvider
  -> MemoryRetrievalOutcome
  -> MemoryEvent[]
  -> MemoryContextBuilder
  -> PromptBuilder
```

Write path：

```text
Conversation
  -> MemoryIngestionPolicy / finalized-ingestion coordination
  -> MemoryWriteEventInput
  -> MemoryProvider.writeEvent() / idempotent delivery
  -> Memory backend
```

当前 invariants：

- Runtime 不应直接依赖 Mem0 vendor DTO；
- `MemoryEvent` 保留 provenance 与 evidence semantics；
- source 缺失的 timestamp 保持 unknown；
- normal facts 以 user-grounded evidence 为基础；
- ordinary assistant text 是 context，不是默认 fact authority；
- 显式“remember”是用户 claim/request，不等于自动验证为客观真相；
- assistant-only relationship/affect prose 不能成为 authoritative state；
- 不允许 assistant-derived self-reinforcing Memory/state loop；
- retrieval status 有语义差异：`ok`、`empty`、`unavailable`、`error`、`partial` 不可合并；
- `unavailable`/`error` 不等于 amnesia；
- lexical、trigram、full-text 与 optional vector retrieval 共存；
- exact technical term 仍是强 signal；
- embedding 增强 lexical retrieval，而不是替代；
- embedding failure 保留 lexical fallback；
- identity/scope isolation 是 correctness 的一部分。

Memory 是 evidence，不是 Persona database。

## 9. P8 状态

**PLANNED / NOT IMPLEMENTED：** P8 回答“YUVI 是谁？”以及“关系/背景上下文是什么？”。它与 P6（“现在应该做什么？”）和 P5（“如何执行/呈现？”）分离。

不得把 persistent `RelationshipState`、affinity/trust scoring、`DynamicSelf`、`GroundedClaimCompiler` 或类似历史设计草图写成 current architecture。

当前设计方向更接近：

```text
Stable Persona Rules
+ selected real Memory evidence
+ recent conversation
+ Runtime truth
-> model interpretation
```

原则：evidence over derived state；broad invariants over enumerated behavioral rules；Memory 是 evidence，不是 authoritative Persona/Relationship state；stable persona 不应被普通对话漂移；model self-report 不是 Runtime authority；显式用户控制高于 persona preference；没有 evidence 时不能发明 intimacy/dependency/relationship state。

`PromptBuilder` 已经存在语法上的 `RelationshipContext` 与 `CurrentAffect` section，但这不代表 P8 authoritative persistent-state producer 已经存在。

## 10. 本地 embedding 测量

**VALIDATED LOCAL DEPLOYMENT / MEASUREMENT-ONLY。不是 tracked production default。**

近期 Linux validation 使用：

- model：`Qwen3-Embedding-0.6B-Q8_0.gguf`；
- runtime：llama.cpp `b10621` / `0.3.0-dev`；
- CPU-only Linux；
- OpenAI-compatible `/v1/embeddings` endpoint；
- `OpenAICompatibleEmbeddingProvider -> local llama-server -> MemoryService -> PostgreSQL hybrid retrieval`；
- native model output dimension：**1024**；
- validation 的 production source delta：**none**。

测量维度为 1024、768、512、256；Qwen MRL mechanism 是 prefix truncate 后 L2 normalize。Frozen evaluation 使用 120 条 memories、48 条 manually frozen queries、8 个 categories。

**MEASUREMENT RESULT：** 512 被选为 future target，因为该 evaluation 中 production-hybrid Recall@5 与 1024 持平、MRR 有竞争力/略好，并且没有重要 scope/stale regression；256 在 shared-history/ranking behavior 上出现有意义退化。

**CURRENT：** 当前 validated local path 仍使用 native 1024 output。512-dimensional output transform **尚未在 production source 实现**。

**PLANNED：** future implementation classification 为 `MINIMAL_PROVIDER_MRL_TRANSFORM`。在当前 llama.cpp path 中，降低 output dimension 不降低 transformer inference cost；主要收益是 vector storage、index footprint 与 vector-search footprint/latency。

仓库文档不得写入个人机器 absolute model path。

## 11. Structural debt paydown

**CURRENT / IN PROGRESS：** 行为保持型 structural decomposition 与产品语义修改分离进行。在本 baseline 上，Web dashboard presentation primitive、shared `formatDate`、`EventTable` 与 `EventsPage` 已经抽离到独立 module。

后续仍可能继续拆分较大的 Web/Core 文件。提议中的 future file/module name 不是稳定 product architecture，不应写成 contract。

Structural debt work 必须保持 P4/P5/P6/P7 semantics，不能借 refactor 重新设计产品。

## 12. 明确不是当前架构的内容

除非未来源码变化使其成为事实，以下说法明确不是 current：

- Windows-first 或 WSL-required product development；
- Docker Desktop 是 YUVI 产品 requirement；
- Windows private/bundled PostgreSQL 是 primary persistence architecture 或 product gate；
- PR #20 是 current main architecture；
- Live2D 或 proactive assistant behavior 仍整体未实现；
- persistent P8 `RelationshipState`、affinity/trust state、`DynamicSelf` 或类似 authority 已实现；
- 512-dimensional Qwen embedding output 是 production default；
- DashScope 1536-dimensional embedding 是唯一/当前 embedding architecture；
- 普通 health/status inspection 会执行 live provider verification；
- NATS 是 active Runtime event bus。

## 13. 文档权威

当前 `origin/main` 的源码和测试，加上更新的显式 baseline 文档，是 current product behavior 的权威来源。

旧 PR、phase plan 与历史文档是历史证据，不是 current architecture。

Experimental/local measurement 除非已经由 tracked product configuration/source 实现，否则不是 repository default。

Planned 与 deferred work 必须显式标记。

文档发生冲突时使用以下 precedence：

1. current source + tests on `origin/main`；
2. 更新的显式 baseline 文档，例如本 snapshot 与 [p4-linux-first.md](p4-linux-first.md)；
3. merged PR evidence；
4. older documents；
5. old branches / unmerged PRs；
6. chat history。