# YUVI 统一术语表

本文件是 YUVI 面向用户的中文文案、中文文档和中文代码注释的唯一术语来源。代码标识符、API 路径、事件键、枚举值和数据库字段保持英文不变。

## 基本规则

- 首次出现可写作“中文名（English term）”，其后使用中文名。
- `YUVI Runtime`、`Provider`、`Trace ID`、`Session ID` 等英文名称及 TypeScript 标识符不改名。
- 当前仓库没有预置人格、固定角色、世界观或用户档案；默认提示词模板不构成既定 YUVI 人设。
- API 端点、路由和 TypeScript 接口/端口是不同概念，必须分别表述。

## 产品与角色

| 英文术语 | 统一中文名 | 说明 |
| --- | --- | --- |
| YUVI Runtime | YUVI 运行时 | 产品及运行时总称；简短用户文案可写“YUVI”。 |
| AI Companion Runtime | AI 伴侣运行时 | 产品定位：**本地优先、事件驱动的 AI 伴侣运行时。** |
| Companion | AI 伴侣 | 产品关系定位，不等于具体人格。 |
| Assistant | 助手 | 面向用户生成和发送回复的一方。 |
| Agent | 智能体 | 具有运行、决策或调用能力的执行主体。 |
| Persona | 人格 | 可配置的角色身份、性格和行为设定。 |
| Avatar | 虚拟形象 | 视觉、语音或动画表现载体。 |
| Companion Name | 伴侣名称 | 不自动等同于人格。 |
| Persona ID | 人格 ID | 未来多角色或多人格配置预留字段。 |
| Voice Profile ID | 声线档案 ID | TTS 声线及参数的配置标识。 |

## 架构与运行

| 英文术语 | 统一中文名 |
| --- | --- |
| Dashboard | 控制台；强调载体时为 Web 控制台 |
| Provider | 能力提供方；后续正文与导航可简称提供方 |
| Runtime Orchestrator | 运行时编排器 |
| Event Bus | 事件总线 |
| Provider Registry | 提供方注册表 |
| Provider Chain | 提供方链 |
| Mock Provider | 模拟提供方 |
| Development Mode | 开发模式 |
| Desktop Mode | 桌面模式（规划中的 Tauri 形态） |
| Direct Context | 直接上下文 |
| Prompt Preview | 提示词预览 |
| Trace ID | 链路追踪 ID |
| Session ID | 会话 ID |
| Subject User ID | 记忆主体用户 ID |
| Created By User ID | 记忆创建者用户 ID |
| Speaker ID | 说话者 ID |

提供方链是在同一提供方能力下，按照优先级排列的主用、备用提供方调用顺序。直接上下文是未经记忆检索重写、直接加入本轮提示词的近期原始对话。控制台是当前 Web 开发与调试界面，不代表最终用户端产品界面。

## 记忆系统

| 英文术语 | 统一中文名 |
| --- | --- |
| Memory | 记忆 |
| Memory Candidate | 候选记忆 |
| Memory Extractor | 记忆提取器 |
| Memory Retrieval | 记忆检索 |
| Memory Reconstruction | 记忆重构 |
| Memory Maintenance | 记忆维护 |
| Memory Admission Policy | 记忆准入策略 |
| Memory Candidate Review | 候选记忆审核 |
| Explicit Remember Request | 显式记忆请求 |
| Correction Request | 更正请求 |
| Provenance | 来源信息 |
| Assistant-only Restatement | 仅助手复述 |
| Canonical Fingerprint | 规范化指纹 |
| Canonical Event Key | 规范化事件键 |
| Temporal Normalization | 时间规范化 |
| Supersession | 记忆替代 |
| Retention Policy | 保留策略 |
| Vector Index | 向量索引 |
| ANN Index | 近似最近邻索引 |
| Hybrid Retrieval | 混合检索 |
| Current Affect | 当前情感状态 |

来源信息包含内容来源、陈述者和写入操作等溯源信息。记忆替代不表示物理覆盖或删除旧记录。当前情感状态是即时状态，不等于长期保存的情感记忆。时间规范化把相对或模糊时间表达转换为可比较、可保存的时间信息。

### 记忆类型（`MemoryType`）

| 枚举值 | 统一中文名 |
| --- | --- |
| `working` | 工作记忆 |
| `episodic` | 情景记忆 |
| `semantic` | 语义记忆 |
| `emotional` | 情感记忆 |
| `procedural` | 程序性记忆 |
| `relationship` | 关系记忆 |

### 记忆细分类型（`MemorySubtype`）

| 枚举值 | 统一中文名 |
| --- | --- |
| `preference` | 偏好 |
| `fact` | 事实 |
| `project` | 项目 |
| `workflow` | 工作流 |
| `event` | 事件 |
| `milestone` | 里程碑 |
| `provider-choice` | 提供方选择 |
| `path` | 路径 |
| `repo` | 仓库 |
| `command` | 命令 |
| `troubleshooting` | 排障 |
| `config` | 配置 |
| `identity` | 身份 |
| `project-fact` | 项目事实 |
| `config-decision` | 配置决策 |
| `emotional-state` | 情感状态 |
| `emotional-pattern` | 情感模式 |
| `health-note` | 健康备注 |
| `schedule` | 日程 |
| `test` | 测试 |
| `emotion` | 情绪 |
| `relationship` | 关系 |

### 记忆层级（`MemoryLayer`）与状态（`MemoryStatus`）

| 层级枚举值 | 统一中文名 | 状态枚举值 | 统一中文名 |
| --- | --- | --- | --- |
| `core` | 核心层 | `active` | 有效 |
| `recall` | 召回层 | `superseded` | 已被替代 |
| `archival` | 归档层 | `archived` | 已归档 |
| `working` | 工作层 | `forgotten` | 已遗忘 |
|  |  | `expired` | 已过期 |

界面必须标示“类型”和“层级”两个维度，例如“类型：工作记忆；层级：工作层”。

## 提供方能力与品牌显示

| 枚举值 | 统一中文名 |
| --- | --- |
| `chat` | 对话 |
| `reasoning` | 推理 |
| `tts` | 语音合成 |
| `stt` | 语音转写 |
| `vision` | 视觉理解 |
| `embedding` | 向量嵌入 |

| 代码或品牌名称 | 中文显示 |
| --- | --- |
| DeepSeek | DeepSeek |
| xAI | xAI |
| Alibaba DashScope | 阿里云 DashScope |
| OpenAI-compatible | OpenAI 兼容提供方 |
| NVIDIA | NVIDIA |
| Local | 本地提供方 |
| Mock | 模拟提供方 |

提供方健康状态：`healthy` 为“正常”，`degraded` 为“降级可用”，`unavailable` 为“不可用”。

## API、路由与代码边界

| 概念 | 统一中文名 | 示例 |
| --- | --- | --- |
| HTTP/WebSocket Endpoint | API 端点 | `POST /v1/messages` |
| Route | 路由 | Fastify 路由注册 |
| TypeScript Interface/Port | 接口或端口 | `RuntimeMemoryPort` |

版本化 API 端点优先用于文档；未版本化端点必须标为兼容端点或旧端点。`Port` 在架构语境中译为“端口”。核心代码标识符的中文说明见本规范 v1.0 的第十二节；其英文标识符保持不变。

## 事件与提示词分段

`agent.reply` 是运行时编排器生成的内部回复事件，承载已生成但尚未由传输层发布的回复；`assistant.message` 是最终对用户发布的文本消息事件。当前运行时主对话流发布 `agent.reply`，当外部消费者需要最终发布语义时应使用或转换为 `assistant.message`；二者不是可任意互换的同义事件。

| 事件键 | 中文说明 |
| --- | --- |
| `user.message` | 用户消息 |
| `user.voice.transcript` | 用户语音转写 |
| `assistant.message` | 助手消息 |
| `agent.reply` | 智能体回复 |
| `avatar.speak` | 虚拟形象发声 |
| `memory.retrieved` | 记忆已召回 |
| `tts.started` | 语音合成已开始 |
| `perception.vision` | 视觉感知 |
| `stt.completed` | 语音转写已完成 |
| `vision.completed` | 视觉分析已完成 |
| `provider.error` | 提供方错误 |
| `runtime.error` | 运行时错误 |

提示词分段：`SystemIdentity` 系统身份、`CharacterStyle` 角色风格、`RelationshipContext` 关系上下文、`CurrentTime` 当前时间、`CurrentAffect` 当前情感状态、`DirectContext` 直接上下文、`RelevantMemory` 相关记忆、`CurrentSituation` 当前情境、`Tools` 可用工具、`UserMessage` 用户消息。
