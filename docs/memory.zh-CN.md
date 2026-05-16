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

## Manual Management

Dashboard 的 Memory 页面是开发期手动记忆管理控制台。它可以：

- 查看 memory detail 和 debug metadata
- 创建带 type、subtype、summary、importance、source、tags 的 manual memory
- 编辑 content、summary、type、subtype、importance、emotion fields、tags 和安全 metadata
- 从当前 repository 删除 memory
- 按 type、subtype、source、importance 搜索和筛选 memory

手动创建的 memory 应使用 `source=dashboard` 或 `source=manual`。删除 memory 后，它不会再进入检索结果。不要把 API key、password、token、Authorization header 或其他 secret 写入 memory content 或 metadata。

## Prompt Safety

原始聊天日志噪声很高，容易让 companion 过度拟合无关措辞。进入提示词之前，记忆必须被压缩成简洁的重构上下文：

1. retrieve candidate memories
2. rank by relevance, recency, and importance
3. compress or use stored summaries
4. reconstruct a small prompt-ready memory block

这样可以让提示词更小，减少无关历史的意外泄漏，并让记忆更像理解，而不是 transcript replay。
