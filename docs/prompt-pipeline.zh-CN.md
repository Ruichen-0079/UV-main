# Prompt Pipeline

提示词构建是提供方中立的，并接收结构化输入；中文术语以[统一术语表](terminology.zh-CN.md)为准：

- 伴侣名称与系统身份
- 当前用户事件
- 重构后的记忆
- 任务或模态上下文
- 运行时约束

提示词构建器不应接收原始聊天日志或提供方特定的响应对象。

## Format

提示词会被组装为结构化分段。分段名称的中文说明见术语表；它们不表示仓库已有固定人格设定：

```xml
<SystemIdentity>
You are Companion, a local-first AI companion runtime agent.
</SystemIdentity>

<CharacterStyle>
Warm, concise, attentive, and grounded.
</CharacterStyle>

<RelationshipContext>
The user prefers direct help with a calm tone.
</RelationshipContext>

<RelevantMemory>
- The user is building a modular AI companion runtime.
- The user wants provider-specific code isolated from core.
</RelevantMemory>

<CurrentSituation>
The current task is implementing the prompt builder package.
</CurrentSituation>

<Tools>
- memory.search (available): Retrieve ranked memories.
</Tools>
```

`<UserMessage>` 会作为单独的提供方中立用户消息保留。

## Example

```ts
const output = new PromptBuilder().buildPrompt({
  systemIdentity: "You are Companion, a local-first AI companion runtime agent.",
  characterStyle: "Warm, concise, and emotionally aware.",
  relationshipContext: "The user is designing a modular runtime.",
  retrievedMemories: [
    {
      content: "User asked that runtime core never import provider classes directly.",
      importance: 0.9,
      lastAccessedAt: new Date()
    }
  ],
  currentSituation: "Implementing packages/prompt-builder.",
  tools: [{ name: "memory.search", description: "Retrieve ranked memories" }],
  userMessage: "Build the prompt pipeline.",
  maxCharacters: 8000
});
```

## Memory Rule

记忆不是提示词。记忆必须先被检索、排序、压缩和重构，之后才能进入最终提示词。构建器会把检索到的记忆转换成简洁的叙事 bullet，并执行字符预算，避免过时或冗长的上下文挤占当前用户消息。
