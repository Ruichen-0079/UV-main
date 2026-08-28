# YUVI Runtime

[English](README.md) | [简体中文](README.zh-CN.md)

YUVI Runtime 是一个本地优先、事件驱动的 AI 伴侣运行时。项目受到 Project AIRI 的架构愿景启发，但本仓库为原创实现，不复制 AIRI 代码。中文术语以[统一术语表](docs/terminology.zh-CN.md)为准。

YUVI 的目标不是做一个聊天页面，而是构建一个长期可演进的伴侣运行时：在稳定的 Runtime 边界后承载对话、记忆、主动行为、提供方认知、语音/视觉、虚拟形象呈现，以及后续的身份、关系与连续性系统。

## 当前状态

项目当前处于 **结构债务收口阶段**。P4 的可靠性资产与第一版可用 P6 主动文本行为已经建立，现在正在把大文件、大测试闭包拆到清晰的语义边界中，同时严格保持行为不变。

目前已经确定并保留的能力包括：

- RuntimeOrchestrator 已从包入口中抽离，Runtime contract 与 canonical error 也有独立边界。
- 会话持久化与 finalized-turn ingestion 已具备 durable lifecycle、幂等、retry/reconcile、崩溃恢复和 fail-closed 语义。
- P6 主动文本支持严格的 `NO_OP` / `REQUEST_TEXT` 控制、assistant-only turn、取消竞态隔离、one-shot 幂等、fresh effect identity，并且不会伪造用户消息，也不会获得主动记忆写入权限。
- Dashboard、Settings、Chat 与 Core 大型职责已经按小步结构重构拆分，没有借重构改变产品行为。
- Core Runtime 测试正在按语义岛机械拆分。R5A1、R5A2、R5A3 已完成；R5A4 与最终 structural closeout 完成后，结构债务阶段结束。

结构收口后的下一项产品工作是 **P8：Who is Yuvi / identity / persona / relationship**。P8 必须基于可追溯证据解释身份与关系，而不是把隐式推断直接当作权威角色状态。后续伴侣架构见 [`docs/future/`](docs/future/)。

## 开发基线

YUVI 当前采用 **Linux-first** 开发与生产验证策略。

主要开发环境假设：

- Linux host
- Node.js + pnpm
- Docker Engine / Docker Compose
- PostgreSQL + pgvector 作为当前已经验证的 durable persistence 主路径

Windows 仍然是支持目标和后续打包/翻译目标，但不再继续扩张复杂的 Windows 专用 PostgreSQL ownership/packaging 机制。产品行为稳定之前，平台特殊工程不能反过来主导 Runtime 架构。

Linux 快速启动：

```bash
pnpm install
cp .env.example .env
./scripts/dev.sh
```

开发地址：

- Server: `http://localhost:6121`
- Web UI: `http://localhost:5173`
- WebSocket: `ws://localhost:6121/ws`

健康检查与停止：

```bash
./scripts/health.sh
./scripts/stop.sh
```

Windows 脚本仍保留，用于需要时的兼容开发：

```powershell
.\scripts\dev.ps1
.\scripts\health.ps1
.\scripts\stop.ps1
```

平台细节见 [`docs/quickstart.zh-CN.md`](docs/quickstart.zh-CN.md) 与 [`docs/windows-development.md`](docs/windows-development.md)。

## 仓库结构

- `apps/server`：Fastify HTTP/WebSocket Runtime server 与 composition root。
- `apps/web`：开发期 Dashboard，用于观察、调试和控制 Runtime。
- `packages/protocol`：运行时事件类型和 Schema。
- `packages/event-bus`：事件总线抽象与内存实现。
- `packages/memory`：会话持久化、长期记忆、finalized-ingestion ledger、检索与维护边界。
- `packages/prompt-builder`：提供方中立的提示词构建。
- `packages/providers`：提供方接口、注册表、标准化错误与厂商适配。
- `packages/core`：Runtime contract、canonical error、编排与行为集成。
- `packages/config`：类型化运行时配置与敏感信息脱敏边界。
- `docs/future`：结构收口后的伴侣架构规划，以 P8 为起点。

## Runtime 核心原则

### Runtime 拥有执行权

Runtime 负责 effect lifecycle、执行准入、取消、持久化协调、provider 执行与 canonical publication。UI、Presentation 以及未来 Character 系统都不能绕过 Runtime 直接获得这些权限。

### Memory 是证据，不是隐藏的人格真相

原始会话持久化与长期记忆是两个不同层级。Memory 负责证据记录的存储、可用性、检索/排序、validity/status、retention 与 expiry。未来 P8 可以解释被授权的 Memory evidence，但 Memory 本身不是 relationship/persona 的权威状态。

### Provider 可替换

`packages/core` 依赖 provider contract，而不是厂商 SDK。DeepSeek、xAI、DashScope 等请求/响应适配属于 `packages/providers`。

### 可靠性语义是资产

结构重构不得削弱已经证明的 finalized-turn lifecycle、durable ingestion、semantic idempotency、retry/reconcile、崩溃恢复、cancellation fencing，以及 ambiguous external side effect protection。

### 小语义 diff 优先

如果“更漂亮的架构”和“更小的行为保持改动”发生冲突，优先选择更小的 semantic diff。结构清理不能偷偷变成产品重设计。

## 主要 Runtime 流程

普通用户回合：

```text
User input
  -> Runtime admission / persistence
  -> context + Memory retrieval
  -> prompt construction
  -> provider execution
  -> assistant persistence / finalized-turn handling
  -> runtime publication
  -> optional presentation side effects
```

当前 P6 assistant-initiated 主动文本：

```text
ProactiveDecisionProvider
  -> NO_OP
     或
  -> REQUEST_TEXT
  -> assistant continuation
  -> Runtime execution commit
  -> assistant-only proactive stream
```

这条主动路径不会创建 synthetic user message，不会获得 Memory 写入权限，也不会获得独立的 TTS/voice 权限。

## Provider Mapping

当前默认方向：

- Chat：DeepSeek
- Reasoning：DeepSeek
- TTS：xAI
- STT：Alibaba Cloud DashScope
- Vision：xAI
- Embedding：可配置 OpenAI-compatible / provider chain

Provider routing 支持优先级与 fallback。`packages/core` 不应直接 import DeepSeek、xAI 或 Alibaba concrete client。

示例：

```env
CHAT_PROVIDER_CHAIN=deepseek,nvidia,local,mock
REASONING_PROVIDER_CHAIN=deepseek,nvidia,local,mock
EMBEDDING_PROVIDER_CHAIN=openai-compatible,nvidia,local,mock
TTS_PROVIDER_CHAIN=xai,local,mock
STT_PROVIDER_CHAIN=dashscope,local,mock
VISION_PROVIDER_CHAIN=xai,nvidia,local,mock
```

密钥只允许存在于本地环境或安全配置来源中，不得提交到仓库，也不得泄漏到日志、事件或错误负载。

## 持久化

开发时可以使用 in-memory persistence，但 durable validation 使用 PostgreSQL：

```env
MEMORY_REPOSITORY=postgres
DATABASE_URL=postgres://yuvi:yuvi_dev_password@localhost:5432/yuvi
```

启动开发基础设施并执行 migration：

```bash
docker compose -f infra/docker-compose.yml up -d
pnpm db:migrate
pnpm smoke:postgres
```

PostgreSQL 目前承载已经证明的 durable Runtime 路径。Redis 与 NATS 仍是支持性/未来基础设施，不是把 Runtime 提前拆成重型微服务的理由。

## 常用命令

```bash
pnpm install
pnpm check
pnpm test
pnpm build
pnpm db:migrate
pnpm smoke
pnpm smoke:postgres
pnpm memory:index:status
pnpm memory:maintenance
```

常用脚本：

- `./scripts/dev.sh`：主要 Linux 开发入口。
- `./scripts/health.sh`：开发环境状态/健康检查。
- `./scripts/stop.sh`：停止本地开发服务。
- `pnpm db:migrate`：执行 PostgreSQL memory migration。
- `pnpm db:reset:dev`：带确认保护的开发数据库重置。
- `pnpm memory:embed:backfill`：为已有 PostgreSQL memories 补 embedding。
- `pnpm memory:index:status`：检查 pgvector/ANN index 状态。
- `pnpm memory:maintenance`：审计 expiry、staleness 与 supersession 维护状态。

## 路线图边界

当前顺序：

```text
R5A4 proactive test-island extraction
  -> structural final closeout
  -> P8 identity / persona / relationship
  -> temporal substrate
  -> continuity and attention
  -> Character ABI / Character Harness
  -> Cognition and capabilities
  -> embodied presentation / agency
  -> Character post-training
```

`docs/future/` 是未来规划权威，不代表其中系统已经实现。入口见 [`docs/future/README.md`](docs/future/README.md)。
