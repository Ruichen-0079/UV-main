# Memory

记忆不是原始聊天日志注入。运行时会存储结构化记忆，检索候选项，对它们排序、压缩，并重构成 prompt-safe 的上下文。

## Categories

- `working`: 短期任务/会话状态，例如当前目标或活跃偏好。
- `episodic`: 被记住的交互和事件，以紧凑摘要而不是原始 transcript 存储。
- `semantic`: 关于用户、companion、世界、项目或实体的稳定事实。
- `emotional`: 情绪信号，例如 valence、arousal、反复出现的压力源，以及正向锚点。
- `procedural`: 学到的惯例、指令、工作流，以及“我们如何做这件事”的模式。

## Storage

持久记忆存储使用 PostgreSQL + pgvector。Migration 位于：

```text
packages/memory/migrations/
```

核心表：

- `memories`
- `entities`
- `relations`

仓库层把向量搜索暴露为接口；在 MVP 阶段，如果未配置 embedding，则已实现基于 `ILIKE` 的文本 fallback 搜索。

## Prompt Safety

原始聊天日志噪声很高，容易让 companion 过度拟合无关措辞。进入提示词之前，记忆必须被压缩成简洁的重构上下文：

1. retrieve candidate memories
2. rank by relevance, recency, and importance
3. compress or use stored summaries
4. reconstruct a small prompt-ready memory block

这样可以让提示词更小，减少无关历史的意外泄漏，并让记忆更像理解，而不是 transcript replay。
