# 记忆

记忆不是原始聊天日志注入。运行时会存储结构化记忆，检索候选记忆，对它们排序、压缩，并重构成提示词安全的上下文。完整用词见[统一术语表](terminology.zh-CN.md)。

## Categories

- `working`（工作记忆）：短期任务/会话状态，例如当前目标或活跃偏好。
- `episodic`（情景记忆）：被记住的交互和事件，以紧凑摘要而不是原始对话记录存储。
- `semantic`（语义记忆）：关于用户、AI 伴侣、项目或实体的稳定事实。
- `emotional`（情感记忆）：情绪信号，例如效价、唤醒度、反复出现的压力源和正向锚点。
- `procedural`（程序性记忆）：学到的惯例、指令、工作流，以及“我们如何做这件事”的模式。
- `relationship`（关系记忆）：用户、AI 伴侣或其他实体之间的关系信息。

## Storage

开发默认值是 `MEMORY_REPOSITORY=in-memory`，适合快速迭代，但服务器重启后会清空。持久化开发记忆使用 PostgreSQL + pgvector，需要配置 `MEMORY_REPOSITORY=postgres`、`DATABASE_URL` 并运行 migrations。Migration 位于：

```text
packages/memory/migrations/
```

核心表：

- `memories`
- `entities`
- `relations`

PostgreSQL 模式会使用 YUVI Postgres Search v2，并可选启用 pgvector retrieval。`pg_trgm` trigram、PostgreSQL 内置 `simple` full-text index、结构化 filter、tag / metadata GIN index 和 embedding metadata 会一起工作。

对于当前 Linux 上的 Qwen3-Embedding-0.6B Q8_0 本地部署，应设置 `EMBEDDING_DIMENSIONS=512`。Migration `010_embedding_mrl_512_v1.sql` 会把已有的 1024 维 Qwen 向量原地转换为前 512 维并做 L2 normalize，保留 memory identity/content/metadata 和时间字段，并按当前配置重建 512 维 cosine ANN index。该 migration 会检查目标配置，其他维度配置不会被它修改。

Embedding 是增强信号，不会替代 keyword/trigram/full-text。路径、端口、命令、provider 名称、model 名称、env var、tag 和错误信息这类精确技术匹配仍然优先。real-provider-first 模式推荐 `EMBEDDING_PROVIDER=openai-compatible`；`EMBEDDING_PROVIDER=mock` 只用于测试、CI 或显式离线模式，并会报告 `semanticEmbedding=false`，表示它只能验证检索管线，不能提供真实语义相似度。真实 provider 可能消耗 token。新写入的 memory 会在 provider 可用时生成 embedding；如果 embedding 失败，memory 仍会保存，并回退到 keyword/trigram/full-text 检索。已有 Postgres memory 可在 migration 后回填：

```bash
pnpm memory:embed:backfill
pnpm memory:embed:backfill -- --dry-run
pnpm memory:embed:backfill -- --force --limit=500
```

Migration 会为 content / summary 建立 trigram index，为 tags / metadata 建立 GIN index，并为 scope、scopeId、memoryLayer、status、type、subtype、source、sourceTraceId、timestamp 和 importance 建立辅助索引。检索会覆盖 content、summary、tags、type、subtype、scope、scopeId、memoryLayer、source/sourceTraceId 和安全 metadata 文本，可以处理中文、英文、中英混合、Windows 路径、URL、端口、`MEMORY_EXTRACTOR` 这类环境变量键，以及 `pnpm db:migrate` 这类命令。提示词预览和控制台搜索调试会显示 `retrievalMode`、`matchedBy`、`score`、rank components 和 `sourceTraceId`。

## Memory Model v2

Memory record 现在包含 scoped memory、temporal memory、supersession 和 forgetting 的基础字段：

- `scope`: `user`、`project`、`agent`、`plugin`、`session`
- `scopeId`: 可选 scope 标识，例如 `yuvi-runtime`
- `memoryLayer`: `core`、`recall`、`archival`、`working`
- `status`: `active`、`superseded`、`archived`、`forgotten`、`expired`
- temporal fields: `observedAt`、`eventTime`、`validFrom`、`validUntil`、`expiresAt`、`lastAccessedAt`、`supersededAt`
- lightweight relation fields: `supersedes`、`supersededBy`、`contradicts`

默认 prompt retrieval 只使用当前有效窗口内的 `active` memories。`forgotten`、`expired`、`superseded` 默认不会进入 prompt。`archived` memories 可在手动管理中查看，但默认不会注入 prompt。

默认 scope 是 `user`。如果内容明显属于 YUVI 项目，可以推断为 `scope=project`、`scopeId=yuvi-runtime`。`working` memory 映射到 `working` layer；稳定的 semantic preference 和 project fact 映射到 `core`；episodic milestone 和 troubleshooting 记录映射到 `recall`。

## Read Pipeline v2

Prompt assembly 现在会组合短期 Direct Context 和长期 RelevantMemory，但二者保持分离：

- `DirectContext` 是有边界的同会话近期上下文，用于最近对话、即时确认、当前任务意图和近期错误。它不是长期记忆；原始会话持久化由独立的 Conversation Repository 负责。
- `RelevantMemory` 是从 `MemoryService` 检索出的长期记忆，会先经过 scope/status/time 过滤和 ranking，再进入 prompt。

Direct Context 默认配置为 `DIRECT_CONTEXT_ENABLED=true`、`DIRECT_CONTEXT_MAX_TURNS=6`、`DIRECT_CONTEXT_MAX_CHARS=6000`。Runtime 会优先裁剪最旧 turn，不使用 LLM summarization，并在注入 prompt 前脱敏疑似 secret 的值。

长期 prompt retrieval 仍然是 scope-aware、status-aware、time-aware 的：

- 默认 prompt 读取 `user` 和 `project:yuvi-runtime`；当前会话有 `sessionId` 时也读取 `session:<sessionId>`。
- `agent` 和 `plugin` scope 只有在请求提供对应上下文时才会参与。
- 无关 project、plugin 或 agent memory 会在 prompt injection 前被排除。
- `forgotten`、`expired`、`superseded` 和 `archived` 默认不会进入 prompt。
- `includeArchived`、`includeSuperseded`、`includeExpired` 是手动/调试搜索选项，不是正常 prompt 默认行为。
- `expiresAt`、`validUntil` 和未来的 `validFrom` 会影响检索结果。
- 被选中的 memory 会更新 `lastAccessedAt`，后续 ranking 可以使用访问新近度。

Ranking 会综合 keyword relevance、type/subtype priority、memoryLayer priority、importance、recency、access recency、source quality 和 scope match quality。当前 user/project scope 中的 active core memory 优先；低价值 verbose runtime episodic summary、archival record 和无关 scope record 会被降权或排除。

Prompt Preview 会显示可解释的 debug metadata，包括 `retrievalScope`、`includedScopes`、`includeArchived`、`includeSuperseded`、`includeExpired`、`excludedByStatus`、`excludedByTime`、`excludedByScope`、`currentTime`，以及每条 memory 的 `matchedBy`、`score`、rank components、`scope`、`memoryLayer`、`status`、temporal fields 和 `excludedReason`。

PromptBuilder 会继续注入 `CurrentTime` section，包含当前 ISO timestamp、timezone 和 local date。RelevantMemory bullet 会使用紧凑 hint，例如 `[project:yuvi-runtime][core][active]`，帮助模型理解 scope 和 freshness，但不会把冗长 metadata 倒进 prompt。

Prompt Preview 会显示 Direct Context budget metadata：`directContextEnabled`、`directContextTurnCount`、`directContextCharCount`、`directContextTruncated`、`directContextSource`。Prompt section 保持分离：

```text
<CurrentTime>
...
</CurrentTime>

<DirectContext>
...
</DirectContext>

<RelevantMemory>
...
</RelevantMemory>
```

`supersedes`、`supersededBy`、`contradicts` 的 graph reasoning 是未来工作。自动 expiry / retention scheduler 也是未来工作；当前 forgetting 主要基于 status 字段。

## Manual Management

控制台的记忆页面是开发期手动记忆管理界面。它可以：

- 查看 memory detail 和 debug metadata
- 创建带 type、subtype、scope、layer、status、summary、importance、source、tags 和 temporal fields 的 manual memory
- 编辑 content、summary、type、subtype、scope、layer、status、importance、emotion fields、tags、temporal fields 和安全 metadata
- archive、restore、forget 或 delete 当前 repository 中的 memory
- 按 type、subtype、source、scope、scopeId、memoryLayer、status、importance 搜索和筛选 memory，并可显式包含 archived / superseded / expired 历史记录

手动创建的 memory 应使用 `source=dashboard` 或 `source=manual`。删除 memory 后，它不会再进入检索结果。不要把 API key、password、token、Authorization header 或其他 secret 写入 memory content 或 metadata。

Archive / restore / forget 是第一版 forgetting foundation。Archive 会让 memory 继续可被手动管理，但不会进入 prompt injection。Forget 会把 memory 标记为 `forgotten`，默认检索会排除它。

## Automatic Writes

自动写入 memory 采用保守策略。`readMemory` 控制是否检索记忆进入 prompt context，`writeMemory` 控制 runtime 是否可以在一次对话后写入新 memory。`writeMemory=false` 时 runtime 不能写入 memory。

基于规则的记忆提取器只会为稳定信号提出候选记忆，例如明确的 `remember` / `记住`、`from now on` / `以后`、长期偏好、提供方选择、项目路径、仓库路径、启动命令、配置决策、排障结论、稳定工作流指令和项目里程碑。普通问题、问候、失败回答、无法确定或缺少上下文的助手回复不会被自动存储。需要精确修正时，请使用控制台的记忆页面手动管理。

`MEMORY_EXTRACTOR=llm` 是默认模式，在 DeepSeek Reasoning provider 已配置时会使用它，因此只会在 `writeMemory=true` 时消耗 reasoning token。LLM 只能提出候选记忆，最终仍由 `MemoryService` 负责校验、评分、去重和决定是否写入。无效 JSON 会 fail closed，Reasoning provider 不可用时会回退到 rule-based extractor。`MEMORY_EXTRACTOR=rule-based` 仍可用于确定性、无 token 消耗的抽取。

## 候选记忆审核

控制台会把最近的候选记忆作为开发期调试状态展示出来。候选记忆历史当前仅在内存中保存，服务器重启后会清空。候选记忆只是建议，不是新的持久化来源。界面会显示提取器模式、来源链路、类型/细分类型、预览文本、摘要、重要性、置信度、标签、理由，以及决策（`stored`、`rejected` 或 `candidate`）。疑似密钥的元数据键会被脱敏。

开发者可以在控制台中接受、编辑并保存或拒绝最近的候选记忆。接受会通过正常 `MemoryService` 路径写成 `dashboard`/`manual` 记忆；如果候选记忆已被 `stored`，再次接受不会创建重复记忆。拒绝只更新内存中的候选记忆历史。LLM 提取不会绕过校验、评分或手动记忆控制。

## Prompt Safety

原始聊天日志噪声很高，容易让 companion 过度拟合无关措辞。进入提示词之前，记忆必须被压缩成简洁的重构上下文：

1. retrieve candidate memories
2. rank by relevance, recency, and importance
3. compress or use stored summaries
4. reconstruct a small prompt-ready memory block

这样可以让提示词更小，减少无关历史的意外泄漏，并让记忆更像理解，而不是 transcript replay。
