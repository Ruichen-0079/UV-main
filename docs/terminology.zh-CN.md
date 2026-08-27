# YUVI 统一术语表

本文件是 YUVI 中文文档与面向用户技术文案的术语基线。代码标识符、API 路径、事件键、枚举值、数据库字段和 source identifier 保持英文，不为它们另造中文标识符。

## 基本规则

- 首次出现可写“中文说明（English term）”，随后按语境使用中文说明或原英文标识符。
- `YUVI Runtime`、`RuntimeOrchestrator`、`ProviderRegistry`、`MemoryProvider`、`MemoryEvent`、`RelationshipContext` 等 source identifier 保持原样。
- “当前已实现”“已验证本地部署”“计划中”“已延后”“历史”必须明确区分。
- Prompt 中存在某个 section，不等于 Runtime 已经存在对应的权威状态 producer。
- Memory 是 evidence，不是 Persona/Relationship 的权威状态数据库。

## 产品与呈现

| English term | 中文说明 | 当前含义 |
| --- | --- | --- |
| YUVI Runtime | YUVI 运行时 | 本地优先 AI 伴侣 Runtime。 |
| AI Companion Runtime | AI 伴侣运行时 | 产品定位。 |
| Companion | AI 伴侣 | 产品关系定位，不自动等于固定 Persona。 |
| Assistant | 助手 | 生成或发布 assistant output 的角色。 |
| Persona | 人格 | P8 要解决的稳定身份/行为边界之一；当前没有可由普通对话任意漂移的权威持久 Persona state。 |
| Avatar | 虚拟形象 | Live2D 等视觉/动画呈现载体。 |
| Dashboard | 控制台；强调载体时为 Web 控制台 | 当前调试、设置与观察界面。 |
| Desktop Mode | 桌面运行形态 | 当前仓库已有 Tauri/Companion desktop surface 与 Windows packaging substrate；不表示 Windows packaging 是主产品验证路径。 |
| Companion presentation | 伴侣呈现层 | Live2D、speech playback、presence/behavior projection 等执行/呈现职责，不拥有语义事实权威。 |

## Runtime 与 turn

| English term / identifier | 中文说明 | 当前含义 |
| --- | --- | --- |
| Runtime Orchestrator / `RuntimeOrchestrator` | 运行时编排器 | 用户 turn 与 assistant-initiated turn 的语义编排核心。 |
| user turn | 用户 turn | 由真实用户输入触发的 Runtime turn。 |
| assistant-initiated turn | 助手发起的 turn | 没有 synthetic user message 的助手主动 Runtime 路径。 |
| proactive candidate | 主动候选机会 | Presentation policy 准入后产生的一次性候选；不是 Runtime idempotency identity。 |
| proactive decision | 主动决策 | P6 `ProactiveDecisionProvider` 的 `NO_OP | REQUEST_TEXT` machine-control 输出。 |
| proactive continuation | 主动续写 | 仅在 `REQUEST_TEXT` 后由 `AssistantContinuationProvider` 生成的一条 assistant-only continuation。 |
| finalized turn | 已最终确定的 turn | 已跨过 Runtime finalized-turn lifecycle 边界、可进入 durable semantic ingestion 协调的 turn。 |
| finalized-ingestion ledger | finalized-ingestion 持久账本 | 记录 finalized turn 的 durable ingestion/admission/delivery 状态，用于 crash recovery 与 idempotency。 |
| reconciliation | 对账 / reconciliation | 对不确定外部副作用进行精确状态核对；正文可保留英文以避免与普通“同步”混淆。 |
| idempotency identity | 幂等身份 | 防止同一语义 effect 被重复提交的稳定 identity。 |
| stale callback fencing | 过期回调 fencing | 通过 identity/generation 等边界阻止旧 async callback 重新产生 effect。 |
| Event Bus | 事件总线 | 当前 active Runtime 实现是 in-memory；NATS 是保留边界，不是当前 active bus。 |
| Direct Context | 直接上下文 | 同会话近期原始对话上下文；不是长期 Memory。 |

## P4 persistence / reliability

| English term | 中文说明 | 当前含义 |
| --- | --- | --- |
| durable persistence | 持久化存储 | Linux 主路径通过 repository interface + `DATABASE_URL` + PostgreSQL + YUVI migrations。 |
| ingestion ledger | 摄取账本 | finalized Memory ingestion 的持久状态，不等于 Memory 内容本身。 |
| retryable | 可重试 | 只有语义/side-effect 边界允许时才能自动或人工重试。 |
| ambiguous side effect | 不确定副作用 | 无法证明外部 effect 是否已发生的状态；必须防止盲目 replay。 |
| fail-closed | 失败关闭 | 必要持久化/Memory 语义失败时拒绝继续产生不安全 effect，而不是伪装成功。 |

Windows private PostgreSQL process ownership、ACL、Credential Manager、installer provisioning 等属于 deferred platform packaging，不称为当前主 persistence architecture。

## Provider

| English term / source state | 中文说明 | 当前含义 |
| --- | --- | --- |
| Provider | 能力提供方；正文可简称 Provider | Chat/Reasoning/TTS/STT/Vision/Embedding 的可替换实现。 |
| Provider Chain | Provider 链 | 同一 capability 下按优先级排列的 route。 |
| Provider readiness / `ready` / `not_ready` | Provider 本地就绪状态 | 只表示本地配置/构造是否就绪；零 provider I/O，不证明远端可达。 |
| Provider observed state / `unknown` / `available` / `degraded` / `unavailable` | Provider 观察状态 | 最近一次显式 verification 的缓存结果。 |
| Provider Verify | Provider 显式验证 | 明确发起 live verification；可能产生远端或计费调用。 |
| config-only inspection | 仅配置检查 | 不执行 Provider 网络 I/O。 |
| fallback | 备用 route 切换 | 受当前 provider error/effect policy 约束，不等于所有错误都可 replay。 |
| cancellation boundary | 取消边界 | `AbortSignal` 等 caller-owned cancellation 在 Runtime/server/provider transport 之间传播的边界。 |

普通 `/health` 和 provider status inspection 不称为“live health probe”；它们不会因为读取状态而主动执行远端 verification。

## Memory

| English term / identifier | 中文说明 | 当前含义 |
| --- | --- | --- |
| Memory | 记忆 | 可检索的历史 evidence，不是 Persona database。 |
| `MemoryBackend` | Memory storage contract | 物理/backend 存储边界。 |
| `MemoryProvider` | Runtime-facing semantic Memory boundary | Runtime-facing vendor-neutral 读写语义。 |
| `MemoryEvent` | Memory evidence object | 保留 provenance、scope、timestamp/unknown 等证据语义。 |
| `MemoryRetrievalOutcome` | Memory retrieval outcome | 同时携带 events 和 `ok/empty/unavailable/error/partial` 状态。 |
| provenance | 来源信息 | evidence 的来源、记录 identity、turn link、参与者等。 |
| Hybrid Retrieval | 混合检索 | lexical/trigram/full-text 与 optional vector signal 共存。 |
| explicit remember request | 显式记忆请求 | 用户要求记录某项 claim；表示“用户这样说/要求记住”，不自动变成已验证客观真相。 |
| correction | 更正 evidence | 用户提供的新 evidence，可影响旧 evidence 的使用，但不通过 assistant prose 自我强化。 |

正常 assistant text 是上下文，不是默认 fact authority。assistant-only relationship/affect prose 不能自动成为权威 Persona/Relationship state。

## Prompt / P8

以下名称是当前 PromptBuilder 的 source section identifier，保持英文：

`SystemIdentity`, `CharacterStyle`, `RelationshipContext`, `CurrentTime`, `CurrentAffect`, `DirectContext`, `RelevantMemory`, `CurrentSituation`, `Tools`, `ProactiveInstruction`, `UserMessage`。

其中：

- `RelationshipContext` 是现有 prompt 语法槽位，不代表 persistent P8 `RelationshipState` 已实现；没有权威 producer 时可为空/默认说明。
- `CurrentAffect` 是即时、低权威的当前上下文表达，不等于长期情感关系 state。
- `ProactiveInstruction` 属于 assistant-initiated P6 决策/续写 prompt，不是 synthetic `UserMessage`。
- P8 当前应理解为未来的 Persona/relationship interpretation 工作；不得把 `RelationshipState`、affinity/trust score、`DynamicSelf` 等历史设计草图写成当前实现。

## API 与事件

API 路径和事件 key 保持 source spelling，例如：

- `POST /v1/messages/stream`
- `POST /v1/proactive-turns/stream`
- `POST /v1/audio/transcriptions`
- `POST /v1/voice/message`
- `POST /v1/tts`
- `POST /v1/vision/analyze`
- `user.message`
- `agent.reply`
- `assistant.message`
- `avatar.speak`
- `provider.error`

不要把不同 source identifier 仅因为中文含义接近就视为同一个协议语义。