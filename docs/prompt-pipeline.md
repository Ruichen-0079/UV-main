# Prompt Pipeline

Prompt building is provider-neutral and receives structured inputs:

- companion identity
- current user event
- reconstructed memories
- task or modality context
- runtime constraints

The prompt builder should not receive raw chat logs or provider-specific response objects.

## Format

Prompts are assembled into structured sections:

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

`<UserMessage>` is kept as a separate provider-neutral user message.

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

Memory is not prompt. Memory must be retrieved, ranked, compressed, and reconstructed before entering the final prompt. The builder converts retrieved memories into concise narrative bullets and enforces a character budget so stale or verbose context does not crowd out the current user message.
