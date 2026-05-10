# Prompt Pipeline

提示词构建是提供商中立的，并接收结构化输入：

- companion identity
- current user event
- reconstructed memories
- task or modality context
- runtime constraints

提示词构建器不应该接收原始聊天日志或提供商特定的响应对象。

## Format

提示词会被组装为结构化 section：

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

`<UserMessage>` 会作为单独的提供商中立 user message 保留。

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
