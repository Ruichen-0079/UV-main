# Memory

记忆不是原始聊天日志注入。运行时会存储结构化记忆，检索候选项，对它们排序、压缩，并重构成 prompt-safe 的上下文。

## Categories

- `working`: 短期任务/会话状态，例如当前目标或活跃偏好。
- `episodic`: 被记住的交互和事件，以紧凑摘要而不是原始 transcript 存储。
- `semantic`: 关于用户、companion、世界、项目或实体的稳定事实。
- `emotional`: 情绪信号，例如 valence、arousal、反复出现的压力源，以及正向锚点。
- `procedural`: 学到的惯例、指令、工作流，以及“我们如何做这件事”的模式。

## Storage

开发默认值是 `MEMORY_REPOSITORY=in-memory`，适合快速迭代，但服务器重启后会清空。持久化开发记忆使用 PostgreSQL + pgvector，需要配置 `MEMORY_REPOSITORY=postgres`、`DATABASE_URL` 并运行 migrations。Migration 位于：

```text
packages/memory/migrations/
```

核心表：

- `memories`
- `entities`
- `relations`

仓库层把向量搜索暴露为接口；在 MVP 阶段，如果未配置 embedding，则已实现基于 `ILIKE` 的文本 fallback 搜索。

PostgreSQL 模式现在使用 `pg_trgm` 改善本地关键词检索。Migration 会为 content / summary 建立 trigram index，为 tags / metadata 建立 GIN index，并为 type、subtype、source、sourceTraceId、createdAt、importance 建立辅助索引。检索会覆盖 content、summary、tags、type、subtype、source/sourceTraceId 和安全 metadata 文本，可以处理中文、英文、中英混合、Windows 路径、端口和 `pnpm db:migrate` 这类命令。Prompt Preview 和 Dashboard search debug 会显示 `retrievalMode`、`matchedBy`、`score` 和 `sourceTraceId`。

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

## Manual Management

Dashboard 的 Memory 页面是开发期手动记忆管理控制台。它可以：

- 查看 memory detail 和 debug metadata
- 创建带 type、subtype、scope、layer、status、summary、importance、source、tags 和 temporal fields 的 manual memory
- 编辑 content、summary、type、subtype、scope、layer、status、importance、emotion fields、tags、temporal fields 和安全 metadata
- archive、restore、forget 或 delete 当前 repository 中的 memory
- 按 type、subtype、source、importance 搜索和筛选 memory

手动创建的 memory 应使用 `source=dashboard` 或 `source=manual`。删除 memory 后，它不会再进入检索结果。不要把 API key、password、token、Authorization header 或其他 secret 写入 memory content 或 metadata。

Archive / restore / forget 是第一版 forgetting foundation。Archive 会让 memory 继续可被手动管理，但不会进入 prompt injection。Forget 会把 memory 标记为 `forgotten`，默认检索会排除它。

## Automatic Writes

自动写入 memory 采用保守策略。`readMemory` 控制是否检索记忆进入 prompt context，`writeMemory` 控制 runtime 是否可以在一次对话后写入新 memory。`writeMemory=false` 时 runtime 不能写入 memory。

Rule-based extractor 只会为稳定信号提出候选记忆，例如明确的 `remember` / `记住`、`from now on` / `以后`、长期偏好、provider choice、项目路径、仓库路径、启动命令、配置决策、排错结论、稳定 workflow instruction 和项目里程碑。普通问题、问候、失败回答、无法确定或缺少上下文的 assistant response 不会被自动存储。需要精确修正时，请使用 Dashboard Memory 页面手动管理。

`MEMORY_EXTRACTOR=llm` 是默认模式，在 DeepSeek Reasoning provider 已配置时会使用它，因此只会在 `writeMemory=true` 时消耗 reasoning token。LLM 只能提出候选记忆，最终仍由 `MemoryService` 负责校验、评分、去重和决定是否写入。无效 JSON 会 fail closed，Reasoning provider 不可用时会回退到 rule-based extractor。`MEMORY_EXTRACTOR=rule-based` 仍可用于确定性、无 token 消耗的抽取。

## Candidate Review

Dashboard 会把最近的 memory extraction candidates 作为开发期 debug state 展示出来。Candidate history 目前是 in-memory 且 volatile 的，服务器重启后会清空。Candidate 只是建议，不是新的持久化来源。界面会显示 extractor mode、source trace、type/subtype、preview text、summary、importance、confidence、tags、reason，以及 decision（`stored`、`rejected` 或 `candidate`）。疑似 secret 的 metadata key，例如 API key、token、password、bearer 值和 Authorization header，会被脱敏。

开发者可以在 Dashboard 中 accept、edit-and-save 或 reject 最近的 candidate。Accept 会通过正常 MemoryService 路径写成 dashboard/manual memory；如果 candidate 已经被 stored，再次 accept 不会创建重复 memory。Reject 只更新内存中的 candidate history。LLM extraction 不会绕过校验、评分或手动 memory controls。

## Prompt Safety

原始聊天日志噪声很高，容易让 companion 过度拟合无关措辞。进入提示词之前，记忆必须被压缩成简洁的重构上下文：

1. retrieve candidate memories
2. rank by relevance, recency, and importance
3. compress or use stored summaries
4. reconstruct a small prompt-ready memory block

这样可以让提示词更小，减少无关历史的意外泄漏，并让记忆更像理解，而不是 transcript replay。
