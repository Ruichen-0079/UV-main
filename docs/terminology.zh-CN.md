# YUVI 统一术语表

本文件是 YUVI 面向用户的中文文案、中文文档和中文代码注释的术语来源。代码标识符、API 路径、事件键、枚举值和数据库字段保持英文不变。

## 基本规则

- 首次出现可写作“中文名（English term）”，其后使用统一中文名。
- `YUVI Runtime`、`Provider`、`Trace ID`、`Session ID` 等名称及 TypeScript 标识符不改名。
- 当前仓库没有预置人格、固定角色、世界观或用户档案；默认提示词模板不构成既定 YUVI 人设。
- API 端点、路由和 TypeScript interface/port 是不同概念，必须分别表述。
- 不要为 source identifier 另造中文标识符；正文保留原始 identifier，并在需要时补充中文解释。

## 产品、表现与桌面

| English term         | 统一中文名                      | 当前说明                                                                                 |
| -------------------- | ------------------------------- | ---------------------------------------------------------------------------------------- |
| YUVI Runtime         | YUVI 运行时                     | 产品及运行时总称；简短文案可写“YUVI”。                                                   |
| AI Companion Runtime | AI 伴侣运行时                   | 产品定位：本地优先、事件驱动的 AI 伴侣运行时。                                           |
| Companion            | AI 伴侣                         | 产品关系定位，不等于具体人格。                                                           |
| Assistant            | 助手                            | 面向用户生成和发送回复的一方。                                                           |
| Agent                | 智能体                          | 具有运行、决策或调用能力的执行主体。                                                     |
| Persona              | 人格                            | 身份、性格和行为设定的集成边界；当前没有权威动态 Persona 状态机。                        |
| Relationship         | 关系                            | 关系上下文/证据的语义；当前没有权威持久化 RelationshipState。                            |
| Avatar               | 虚拟形象                        | 视觉、语音或动画表现载体。                                                               |
| Live2D               | Live2D                          | 当前 Web Companion 的可选表现能力，不写成“尚未实现”。                                    |
| Dashboard            | 控制台；强调载体时为 Web 控制台 | 当前 Web 开发与调试界面，不等于最终用户端产品界面。                                      |
| Desktop Mode         | 桌面模式                        | 当前仓库已有 Tauri shell 和 Main/Companion surface；最终打包平台与发布保证仍属延后工作。 |

## 架构与运行

| English term         | 统一中文名                            |
| -------------------- | ------------------------------------- |
| Runtime Orchestrator | 运行时编排器                          |
| Prompt Builder       | 提示词构建器                          |
| Event Bus            | 事件总线                              |
| Provider             | 能力提供方；正文可简称提供方          |
| Provider Registry    | 提供方注册表                          |
| Provider Chain       | 提供方链                              |
| Mock Provider        | 模拟提供方                            |
| Development Mode     | 开发模式                              |
| Direct Context       | 直接上下文                            |
| Prompt Preview       | 提示词预览                            |
| Proactive Turn       | 主动回合；指 assistant-initiated turn |
| Silent Attention     | 静默关注；不产生文本的表现/行为意图   |
| Trace ID             | 链路追踪 ID                           |
| Session ID           | 会话 ID                               |
| Subject User ID      | 记忆主体用户 ID                       |
| Created By User ID   | 记忆创建者用户 ID                     |
| Speaker ID           | 说话者 ID                             |

提供方链是在同一能力下按优先级排列的主用、备用提供方调用顺序。直接上下文是未经长期记忆检索重写、直接加入本轮 prompt 的近期原始对话。主动回合不是 synthetic user turn；当前 P6 的语义决策只允许 `NO_OP` 或 `REQUEST_TEXT`。

## 记忆、持久化与状态

| English term                 | 统一中文名     | 当前说明                                                    |
| ---------------------------- | -------------- | ----------------------------------------------------------- |
| Memory                       | 记忆           | 经检索和重构后进入 prompt 的结构化证据。                    |
| Memory Evidence              | 记忆证据       | 记忆提供方返回的证据，不是 Persona/Relationship 权威状态。  |
| Memory Candidate             | 候选记忆       | 抽取后、准入前的候选记录。                                  |
| Memory Extractor             | 记忆提取器     | 生成候选记忆的 rule-based 或 LLM 路径。                     |
| Memory Retrieval             | 记忆检索       | 从 memory provider/repository 获取相关证据。                |
| Memory Reconstruction        | 记忆重构       | 在 prompt 注入前进行压缩、排序、去重和边界处理。            |
| Memory Maintenance           | 记忆维护       | 过期、陈旧和 supersession 审计；不等于硬删除。              |
| Memory Admission Policy      | 记忆准入策略   | 决定候选能否进入记忆存储。                                  |
| Provenance                   | 来源信息       | 内容来源、陈述者、trace 和写入操作等溯源信息。              |
| Supersession                 | 记忆替代       | 新记录替代旧记录的关系，不表示物理覆盖或删除。              |
| Retention Policy             | 保留策略       | 记忆保留、过期和归档规则。                                  |
| Finalized Turn               | 已定稿回合     | 回复文本已完成并进入持久化/语义摄取边界的回合。             |
| Durable Ingestion Ledger     | 持久化摄取账本 | 记录 finalized-turn 语义投递状态、重试和对账信息的 ledger。 |
| Memory Ingestion Coordinator | 记忆摄取协调器 | 持有自动唤醒、轮询、lease、重试和恢复职责的组件。           |
| Vector Index                 | 向量索引       |
| ANN Index                    | 近似最近邻索引 |
| Hybrid Retrieval             | 混合检索       |
| Current Affect               | 当前情感状态   | 从当前输入推导的即时提示，不是长期情感记忆或 Persona 状态。 |

Direct Context 不等于长期记忆；原始会话消息也不等于长期记忆。Memory status、关系建议和 Mem0 返回值都必须按证据处理。

### 记忆类型（`MemoryType`）

| 枚举值         | 统一中文名 |
| -------------- | ---------- |
| `working`      | 工作记忆   |
| `episodic`     | 情景记忆   |
| `semantic`     | 语义记忆   |
| `emotional`    | 情感记忆   |
| `procedural`   | 程序性记忆 |
| `relationship` | 关系记忆   |

### 记忆状态（`MemoryStatus`）

| 枚举值       | 统一中文名 |
| ------------ | ---------- |
| `active`     | 有效       |
| `superseded` | 已被替代   |
| `archived`   | 已归档     |
| `forgotten`  | 已遗忘     |
| `expired`    | 已过期     |

## 提供方能力与状态

| 枚举值      | 统一中文名 |
| ----------- | ---------- |
| `chat`      | 对话       |
| `reasoning` | 推理       |
| `tts`       | 语音合成   |
| `stt`       | 语音转写   |
| `vision`    | 视觉理解   |
| `embedding` | 向量嵌入   |

| 代码或品牌名称    | 中文显示          |
| ----------------- | ----------------- |
| DeepSeek          | DeepSeek          |
| xAI               | xAI               |
| Alibaba DashScope | 阿里云 DashScope  |
| OpenAI-compatible | OpenAI 兼容提供方 |
| NVIDIA            | NVIDIA            |
| Local             | 本地提供方        |
| Mock              | 模拟提供方        |

| English term             | 统一中文名   | 含义                                                  |
| ------------------------ | ------------ | ----------------------------------------------------- |
| Readiness                | 本地就绪状态 | 根据本地配置和可构造路由判断；不证明远程可达。        |
| Observed                 | 远程观测状态 | 只有显式 live verification 或已缓存观测才会更新。     |
| Provider availability    | 提供方可用性 | 运行时调用或显式观测得到的状态，不与 readiness 混用。 |
| Config-only verification | 仅配置验证   | 只检查本地配置，不调用 provider。                     |
| Live verification        | 远程实时验证 | 显式调用 provider，可能产生 billable usage。          |

`GET /health` 和 `GET /providers/status` 不执行远程 provider I/O。Chat、Reasoning 和 Embedding 有显式 live verification；TTS、STT 和 Vision 的对应验证 route 是 config-only。健康状态 `healthy`、`degraded`、`unavailable` 分别译为“正常”“降级可用”“不可用”。

## API、事件与 prompt section

| 概念                      | 统一中文名 | 示例                         |
| ------------------------- | ---------- | ---------------------------- |
| HTTP/WebSocket Endpoint   | API 端点   | `POST /v1/messages`          |
| Route                     | 路由       | Fastify 路由注册             |
| TypeScript Interface/Port | 接口或端口 | `RuntimeMemoryPort`          |
| SSE                       | SSE 流     | `text/event-stream` 回复传输 |

版本化 API 端点优先用于文档；未版本化端点必须标为兼容端点或旧端点。`Port` 在架构语境中译为“端口”。

`agent.reply` 是 RuntimeOrchestrator 生成的内部回复事件；`assistant.message` 是最终向用户发布的文本消息事件。当前主对话流会发布两者，兼容 WebSocket transport 只转发 `agent.reply` 以避免重复渲染；二者不是可任意互换的同义事件。

| 事件键                  | 中文说明       |
| ----------------------- | -------------- |
| `user.message`          | 用户消息       |
| `user.voice.transcript` | 用户语音转写   |
| `assistant.message`     | 助手消息       |
| `agent.reply`           | 智能体回复     |
| `avatar.speak`          | 虚拟形象发声   |
| `memory.retrieved`      | 记忆已召回     |
| `tts.started`           | 语音合成已开始 |
| `perception.vision`     | 视觉感知       |
| `stt.completed`         | 语音转写已完成 |
| `vision.completed`      | 视觉分析已完成 |
| `provider.error`        | 提供方错误     |
| `runtime.error`         | 运行时错误     |

提示词分段：`SystemIdentity` 系统身份、`CharacterStyle` 角色风格、`RelationshipContext` 关系上下文、`CurrentTime` 当前时间、`CurrentAffect` 当前情感状态、`DirectContext` 直接上下文、`RelevantMemory` 相关记忆、`CurrentSituation` 当前情境、`Tools` 可用工具、`ProactiveInstruction` 主动指令、`UserMessage` 用户消息。`RelationshipContext` 的存在不表示 P8 relationship authority 已完成。
