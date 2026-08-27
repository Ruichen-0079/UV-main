# YUVI 当前状态

状态快照日期：2026-08-27
仓库基线：`d19d36bfc373e68255302258e57b0af5c7a72efa`

本文档是本次文档 rebaseline 的当前状态权威。当前源码和测试，以及更新的显式基线文档，优先于历史阶段说明。规划中的工作不是当前架构。本机测量部署不会自动成为仓库默认值。Git history 和旧 pull request 是证据，不是当前架构。

本文使用以下状态词：

- **CURRENT**——当前基线已实现，并由源码/测试支持。
- **VALIDATED LOCAL DEPLOYMENT**——在仓库追踪配置之外观察到的本机部署事实。
- **EXPERIMENTAL / MEASURED**——不会改变仓库默认值的实验或测量证据。
- **PLANNED**——未来意图，不代表当前实现。
- **DEFERRED**——明确延后的工作，尤其是平台打包工作。
- **HISTORICAL**——来自旧 branch/PR 的证据，不是当前设计要求。

## 1. 产品方向

YUVI 是本地优先、事件驱动的 AI 伴侣运行时。当前仓库是一个可运行的 TypeScript monorepo，包含 Fastify runtime server、Web Dashboard/Main/Companion surface、可配置的 provider chain、memory 与 conversation 边界，以及 Tauri desktop shell。Runtime 是产品边界；avatar 与 media surface 是表现/执行客户端。

## 2. 平台状态

**CURRENT：** Linux 是主要开发和生产验证平台。持久化通过 `DATABASE_URL` 连接外部、系统管理或独立管理的容器 PostgreSQL。在 Linux 上，runtime 正确性不要求 YUVI 拥有 PostgreSQL OS 进程。

**CURRENT：** Windows 开发兼容路径通过 PowerShell helper 和 Docker 开发路径存在。Windows 不是当前主要生产验证平台。

**DEFERRED：** Windows 打包私有 PostgreSQL 所有权、安装器 provisioning、私有数据库生命周期集成，以及相关平台进程/ACL 工作。不要整体恢复 PR #20。

**CURRENT：** 仓库已有 Tauri shell 和桌面 surface。最终打包平台所有权和发布就绪度仍属于打包工作，不应因此重定义 Linux runtime。

## 3. Runtime 架构

当前边界如下：

```text
Web Dashboard / Main / Companion
  -> Fastify HTTP + SSE + WebSocket
  -> RuntimeOrchestrator
       -> Conversation Repository
       -> Memory provider/backend 与 P4 finalized-ingestion ledger
       -> PromptBuilder
       -> ProviderRegistry / fallback chains
       -> in-memory Event Bus
  -> 可选 TTS、STT、Vision 和 Live2D 表现
```

普通用户回合和助手主动回合是分开的 runtime path。`agent.reply` 是内部生成的 reply event；`assistant.message` 是最终面向用户的文本 event。原始会话日志不是长期记忆，Mem0 evidence 也不是权威 Persona/Relationship 状态。

## 4. 持久化 / P4

**CURRENT：** P4 Linux-first 行为包括已定稿回合 lifecycle、持久化 finalized-ingestion ledger、幂等语义投递、崩溃恢复、retry/reconcile、歧义外部副作用保护和必要的 fail-closed 边界。

**CURRENT：** 持久化模式需要 `MEMORY_REPOSITORY=postgres`、有效的 `DATABASE_URL`、可访问的 PostgreSQL 和成功的 `pnpm db:migrate`。PostgreSQL 可以由系统服务、独立服务或开发 Compose 提供。在 Linux 上，YUVI 不拥有数据库进程。

**CURRENT：** `MemoryIngestionCoordinator` 是 wake/poll recovery、lease/version fencing、retry budget 和 reconcile 的自动投递 owner。最终文本会在完成的 reply event 对外暴露前先持久化。

**DEFERRED / HISTORICAL：** PR #20 的 Windows packaged supervisor/schema-bootstrap 架构不是当前 main 架构。未来若恢复 Windows 打包，仍需单独重新评估其历史 Mem0 fail-closed 问题。

详细 P4 权威见 [P4 Linux-first rebaseline](p4-linux-first.md)。

## 5. 表现 / Companion 行为

**CURRENT：** `apps/web` 提供 Dashboard、Main 和 Companion surface。Lumi Live2D/Cubism 渲染、presence projection、语音播放、Web Audio analysis、Tauri window 协调和 capability gate 都已有实现。资源缺失或媒体能力不可用时，可以只让表现层不可用，不改变 runtime 语义。

**CURRENT：** Web Companion behavior policy 仲裁 attention、gaze、reaction 和 proactive request 等表现意图。显式用户活动/控制的优先级高于 ambient/proactive 行为。

**PLANNED / DEFERRED：** 最终跨平台打包 UX 保证、更多 avatar 格式（如 VRM）以及未来 game-agent/perception 集成。不要把当前 Live2D 实现写成纯未来工作。

## 6. 主动 / P6

**CURRENT：** P6 助手主动文本回合通过两阶段路径实现：

1. 只返回 `NO_OP` 或 `REQUEST_TEXT` 的 decision-only provider call；
2. 只有 `REQUEST_TEXT` 才允许一次 prose continuation call，并产生一条 assistant-only continuation。

语义边界是：

- `NO_OP` 不产生 assistant message；
- `REQUEST_TEXT` 产生一条 assistant-only continuation；
- 不制造 synthetic user event；
- 没有 proactive memory-write authority；
- 没有 proactive TTS 或 tool authority；
- 显式用户活动/控制优先于 proactive work；
- stale、cancelled、duplicate 或已经 claim 的尝试不会重放；
- 普通 Chat 仍是独立的 normal user-message path。

公开 stream 是 `POST /v1/proactive-turns/stream`，要求 idempotency key。浏览器侧的 consent/presence admission 可以在 runtime 执行前抑制请求，但不会改变冻结的 runtime 语义决策。

## 7. 提供方 / P7

**CURRENT：** ProviderRegistry 支持可配置的 Chat、Reasoning、TTS、STT、Vision 和 Embedding 能力，包含 fallback chain、标准化错误、安全状态元数据和支持取消的 transport。仓库环境示例选择通用 OpenAI-compatible DeepInfra Chat 路径和 DeepSeek Reasoning；具体选择仍由配置决定。

**CURRENT：** Provider diagnostics 和 settings truth 已实现。`GET /providers/status` 与 `GET /health` 不执行远程 provider I/O。Readiness 表示本地配置/可构造性；observed availability 来自显式 live observation。Chat、Reasoning 和 Embedding 支持显式 live verification；TTS、STT 和 Vision 的验证是 config-only。Voice 和 Vision 的开发 route 已实现，实际调用时会使用已配置的 provider path。

**CURRENT：** `Apply Now`/runtime reload 可以在进程内更新支持的 provider 配置；改变 restart-bound runtime infrastructure 的设置仍需重启。Secret 只应存在于本地配置，并会被脱敏。

## 8. Memory

**CURRENT：** Conversation persistence、Direct Context 和长期 memory 分离。Memory retrieval 有边界，并在注入 prompt 前重构。Legacy memory 和 Mem0 是可选择的 backend；PostgreSQL + pgvector 支持持久化 hybrid retrieval，同时 keyword/trigram/full-text 与 structured metadata filter 对精确技术查询仍然重要。

**CURRENT：** Memory extraction 可以使用配置的 Reasoning provider 或 rule-based fallback。候选验证、准入、去重、supersession/correction metadata、retention 和 maintenance 属于 memory 责任。

**CURRENT：** Mem0 evidence 是 provider 返回的语义记忆证据，不是 Persona/Relationship authority；普通模型 prose 不会自动修改稳定 persona state。

## 9. P8 状态

**未完成 / 延后：** P8 Persona/Relationship 产品实现尚未完成。当前边界是：

- P8 计划负责 identity 和 relationship background/context；
- P6 负责当前是否以及如何行动的语义决策；
- P5 负责 presentation/execution rendering；
- Memory 是 evidence，不是权威 Persona/Relationship state；
- 稳定 persona 不应仅因普通对话产生了 model prose 就漂移；
- model self-report 不是 runtime/state authority；
- 显式用户控制优先于 persona preference。

除非未来源码真正实现，否则不要把持久化 `RelationshipState`、`DynamicSelf` 或同类状态机制写成当前 production architecture。

## 10. 本机 embedding 测量状态

**VALIDATED LOCAL DEPLOYMENT / MEASUREMENT-ONLY：** 一次 Linux CPU-only 本机 loopback 部署使用 `Qwen3-Embedding-0.6B-Q8_0.gguf`、llama.cpp `b10621 / 0.3.0-dev`、OpenAI-compatible `/v1/embeddings` endpoint、YUVI 现有的 `OpenAICompatibleEmbeddingProvider`、`MemoryService` 和 PostgreSQL hybrid retrieval。Runtime 原生输出维度为 1024。没有生产源码改动。

使用 Qwen MRL-compatible 的 prefix truncation 再进行 L2 normalization，P8-0B golden set 包含 120 条 memory、48 个手工冻结 query 和 8 个 category。Production-hybrid Recall@5 测量如下：

| 维度 | Recall@5 |
| ---: | -------: |
| 1024 |   0.8750 |
|  768 |   0.8750 |
|  512 |   0.8750 |
|  256 |   0.8750 |

选定的未来 production target 是 **512**，分类为 **B. `MINIMAL_PROVIDER_MRL_TRANSFORM`**。**512 尚未在生产实现。当前 production 仍为原生 1024。** 降低维度不会降低当前 transformer inference cost；预期收益是 storage、index 和 vector-search footprint。尽管聚合分数相同，256 因重要的 shared-history/ranking 行为回退而被拒绝。

仓库追踪的 provider 配置仍然支持可配置维度，通用 `.env.example` 仍保留 1536 placeholder 以适配使用该维度的 provider。这一配置事实不会把本机测量变成仓库默认值，也不会让 512 成为当前实现。

## 11. Structural debt paydown

**CURRENT：** 行为保持不变的 structural debt paydown 正在进行。PR #63 提取了共享 Dashboard presentation primitives，PR #64 提取了共享 date formatting；两者都没有有意改变产品语义。

`packages/core/src/index.ts` 和 `apps/web/src/App.tsx` 仍是 structural debt targets。临时文件布局不能被当作产品架构保证，规划中的未来文件名也不是已完成架构。

## 12. 明确不属于当前架构的内容

- Windows-first 或推荐 Windows 作为主要产品路径。
- 把 WSL 当作产品必需条件。
- 把 Docker Desktop 当作唯一预期环境。
- 把 YUVI 拥有私有 PostgreSQL 进程写成 Linux 持久化路径。
- 把 PR #20 packaged PostgreSQL/supervisor 工作写成产品开发前置条件。
- 把 `RelationshipState`、`DynamicSelf` 或 Mem0 写成权威 P8 Persona/Relationship state。
- 512 维 MRL production support；它是未来 provider transform。
- 把 NATS 写成当前事件总线实现。
- 把原始聊天日志写成长时记忆。
- 把 provider readiness 写成远程可用性证明。
- 让历史阶段说明或旧 PR 描述覆盖当前源码/测试。
