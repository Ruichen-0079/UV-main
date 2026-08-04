import { InMemoryEventBus } from "@companion/event-bus";
import {
  InMemoryConversationRepository,
  type Memory,
  type MemoryCandidate
} from "@companion/memory";
import { PromptBuilder } from "@companion/prompt-builder";
import {
  ProviderError,
  ProviderErrorCode,
  FallbackChatProvider,
  type ChatStreamEvent,
  createMockChatProvider,
  createMockStreamingChatProvider,
  createMockReasoningProvider,
  createMockSTTProvider,
  createMockVisionProvider
} from "@companion/providers";
import type { RuntimeEvent } from "@companion/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  RuntimeOrchestrator,
  type RuntimeMemoryPort,
  type RuntimeReplyStreamEvent
} from "./index.js";

async function collectRuntimeStream(
  stream: AsyncIterable<RuntimeReplyStreamEvent>,
  onEvent?: (event: RuntimeReplyStreamEvent) => void
): Promise<RuntimeReplyStreamEvent[]> {
  const events: RuntimeReplyStreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    onEvent?.(event);
  }
  return events;
}

describe("RuntimeOrchestrator", () => {
  it("persists each delta before yielding it and finalizes one reply lifecycle", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const conversation = new InMemoryConversationRepository();
    const order: string[] = [];
    const published: RuntimeEvent[] = [];
    const appendMessage = conversation.appendMessage.bind(conversation);
    const appendMessageContent = conversation.appendMessageContent.bind(conversation);
    const completeMessage = conversation.completeMessage.bind(conversation);
    conversation.appendMessage = async (message) => {
      order.push(`${message.role}:${message.status}:save`);
      return appendMessage(message);
    };
    conversation.appendMessageContent = async (id, delta) => {
      order.push(`assistant:stream:${delta}`);
      return appendMessageContent(id, delta);
    };
    conversation.completeMessage = async (id, metadata) => {
      order.push("assistant:completed");
      return completeMessage(id, metadata);
    };
    eventBus.subscribe("*", (event) => {
      order.push(`event:${event.type}`);
      published.push(event);
    });

    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () =>
          createMockStreamingChatProvider("native", {
            chunks: ["hel", "lo"],
            output: { model: "native-model", tokenUsage: { totalTokens: 3 } }
          })
      }
    });

    const events = await collectRuntimeStream(
      runtime.streamUserMessage(
        { sessionId: "stream-session", content: "hello" },
        { readMemory: false, writeMemory: false }
      ),
      (event) => {
        order.push(
          `yield:${event.type}:${event.type === "text-delta" ? event.text : event.content}`
        );
      }
    );
    const messages = await conversation.listRecentMessages("stream-session");
    const assistant = messages.find((message) => message.role === "assistant");

    expect(events.map((event) => event.type)).toEqual(["text-delta", "text-delta", "completed"]);
    expect(events.filter((event) => event.type === "completed")).toHaveLength(1);
    expect(assistant).toMatchObject({ content: "hello", status: "completed" });
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      messageId: assistant?.id,
      content: "hello",
      provider: "native"
    });
    expect(order.indexOf("assistant:stream:hel")).toBeLessThan(
      order.indexOf("yield:text-delta:hel")
    );
    expect(order.indexOf("assistant:stream:lo")).toBeLessThan(order.indexOf("yield:text-delta:lo"));
    expect(order).toContain("event:agent.reply");
    expect(order).toContain("event:assistant.message");
    expect(order.indexOf("assistant:completed")).toBeLessThan(order.indexOf("event:agent.reply"));
    const userEvent = published.find((event) => event.type === "user.message")!;
    const agentReply = published.find((event) => event.type === "agent.reply")!;
    const assistantMessage = published.find((event) => event.type === "assistant.message")!;
    expect(agentReply).toMatchObject({
      traceId: userEvent.traceId,
      parentId: userEvent.id,
      payload: { sessionId: "stream-session", content: "hello" }
    });
    expect(assistantMessage).toMatchObject({
      id: assistant?.id,
      traceId: userEvent.traceId,
      parentId: agentReply.id,
      payload: { sessionId: "stream-session", content: "hello" }
    });

    const rebuilt = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });
    await rebuilt.handleUserMessage(
      { sessionId: "stream-session", content: "next" },
      { readMemory: false, writeMemory: false }
    );
    expect(
      rebuilt.getLatestPromptPreview()?.sections.find((section) => section.name === "DirectContext")
        ?.content
    ).toContain("hello");
  });

  it("supports compatible non-streaming providers through the runtime stream entry", async () => {
    const conversation = new InMemoryConversationRepository();
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () => createMockChatProvider("legacy")
      }
    });

    const events = await collectRuntimeStream(
      runtime.streamUserMessage(
        { sessionId: "compatible-session", content: "hello" },
        { readMemory: false, writeMemory: false }
      )
    );
    expect(events.map((event) => event.type)).toEqual(["text-delta", "completed"]);
    expect((await conversation.listRecentMessages("compatible-session")).at(-1)).toMatchObject({
      status: "completed",
      content: events[0]?.type === "text-delta" ? events[0].text : ""
    });
  });

  it("finalizes persistence and final events before yielding completed", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const published: RuntimeEvent[] = [];
    eventBus.subscribe("*", (event) => {
      published.push(event);
    });
    const conversation = new InMemoryConversationRepository();
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () => createMockStreamingChatProvider("native", { chunks: ["done"] })
      }
    });
    const iterator = runtime
      .streamUserMessage(
        { sessionId: "completed-stop-session", content: "hello" },
        { readMemory: false, writeMemory: false }
      )
      [Symbol.asyncIterator]();
    let completion: RuntimeReplyStreamEvent | undefined;
    while (!completion || completion.type !== "completed") {
      const next = await iterator.next();
      if (next.done) {
        break;
      }
      if (next.value.type === "completed") {
        completion = next.value;
      }
    }

    expect(completion).toMatchObject({ type: "completed", content: "done" });
    expect((await conversation.listRecentMessages("completed-stop-session")).at(-1)).toMatchObject({
      status: "completed",
      content: "done"
    });
    expect(published.filter((event) => event.type === "agent.reply")).toHaveLength(1);
    expect(published.filter((event) => event.type === "assistant.message")).toHaveLength(1);
  });

  it("keeps a finalized stream completed when cancellation occurs during optional post-processing", async () => {
    const controller = new AbortController();
    let releaseMemory!: () => void;
    let memoryStarted!: () => void;
    const memoryReady = new Promise<void>((resolve) => {
      memoryStarted = resolve;
    });
    const memoryRelease = new Promise<void>((resolve) => {
      releaseMemory = resolve;
    });
    const memory = createRecordingMemory([]);
    memory.extractCandidates = async () => {
      memoryStarted();
      await memoryRelease;
      return [];
    };
    const conversation = new InMemoryConversationRepository();
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory,
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () => createMockStreamingChatProvider("native", { chunks: ["done"] })
      }
    });

    const collecting = collectRuntimeStream(
      runtime.streamUserMessage(
        { sessionId: "post-processing-cancel-session", content: "hello" },
        { signal: controller.signal, writeMemory: true }
      )
    );
    await memoryReady;
    controller.abort();
    releaseMemory();

    await expect(collecting).resolves.toEqual([
      {
        type: "text-delta",
        text: "done",
        messageId: expect.any(String),
        sessionId: "post-processing-cancel-session",
        traceId: expect.any(String)
      },
      {
        type: "completed",
        messageId: expect.any(String),
        sessionId: "post-processing-cancel-session",
        traceId: expect.any(String),
        content: "done",
        provider: "native"
      }
    ]);
    expect((await conversation.listRecentMessages("post-processing-cancel-session")).at(-1)).toMatchObject({
      content: "done",
      status: "completed"
    });
  });

  it("keeps streaming completed when optional memory and TTS post-processing fail", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const published: RuntimeEvent[] = [];
    eventBus.subscribe("*", (event) => {
      published.push(event);
    });
    const conversation = new InMemoryConversationRepository();
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: createFailingMemory(),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () => createMockStreamingChatProvider("native", { chunks: ["done"] }),
        getTTSProvider: () => ({
          name: "failing-tts",
          async healthCheck() {
            return {
              provider: "failing-tts",
              status: "unavailable" as const,
              checkedAt: new Date().toISOString()
            };
          },
          async synthesizeSpeech() {
            throw new ProviderError({
              provider: "failing-tts",
              capability: "tts",
              code: ProviderErrorCode.ProviderUnavailable,
              message: "TTS unavailable"
            });
          }
        })
      }
    });

    const events = await collectRuntimeStream(
      runtime.streamUserMessage(
        { sessionId: "optional-failure-stream-session", content: "hello" },
        { voiceOutput: true, writeMemory: true }
      )
    );
    expect(events.map((event) => event.type)).toEqual(["text-delta", "completed"]);
    expect((await conversation.listRecentMessages("optional-failure-stream-session")).at(-1)).toMatchObject({
      content: "done",
      status: "completed"
    });
    expect(published.filter((event) => event.type === "agent.reply")).toHaveLength(1);
    expect(published.filter((event) => event.type === "assistant.message")).toHaveLength(1);
  });

  it("falls back before the first output without exposing the failed provider stream", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const published: RuntimeEvent[] = [];
    eventBus.subscribe("*", (event) => {
      published.push(event);
    });
    const conversation = new InMemoryConversationRepository();
    const failing = createMockStreamingChatProvider("primary", {
      failBeforeFirst: new ProviderError({
        provider: "primary",
        capability: "chat",
        code: ProviderErrorCode.ProviderUnavailable,
        message: "primary unavailable"
      })
    });
    const backup = createMockStreamingChatProvider("backup", {
      chunks: ["ok"]
    });
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () => new FallbackChatProvider([failing, backup])
      }
    });

    const events = await collectRuntimeStream(
      runtime.streamUserMessage(
        { sessionId: "fallback-session", content: "hello" },
        { readMemory: false, writeMemory: false }
      )
    );
    expect(events.at(-1)).toMatchObject({ type: "completed", content: "ok" });
    expect(
      (await conversation.listRecentMessages("fallback-session")).filter(
        (message) => message.role === "assistant"
      )
    ).toHaveLength(1);
    expect(published.filter((event) => event.type === "agent.reply")).toHaveLength(1);
    expect(published.filter((event) => event.type === "assistant.message")).toHaveLength(1);
  });

  it("does not create an assistant message when every provider fails before output", async () => {
    const conversation = new InMemoryConversationRepository();
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () =>
          new FallbackChatProvider([
            createMockStreamingChatProvider("primary", {
              failBeforeFirst: new ProviderError({
                provider: "primary",
                capability: "chat",
                code: ProviderErrorCode.ProviderUnavailable,
                message: "primary unavailable"
              })
            }),
            createMockStreamingChatProvider("backup", {
              failBeforeFirst: new ProviderError({
                provider: "backup",
                capability: "chat",
                code: ProviderErrorCode.Timeout,
                message: "backup timeout"
              })
            })
          ])
      }
    });

    await expect(
      collectRuntimeStream(
        runtime.streamUserMessage(
          { sessionId: "all-failed-session", content: "hello" },
          { readMemory: false, writeMemory: false }
        )
      )
    ).rejects.toMatchObject({ code: ProviderErrorCode.Timeout });
    expect(
      (await conversation.listRecentMessages("all-failed-session")).filter(
        (message) => message.role === "assistant"
      )
    ).toHaveLength(0);
  });

  it("marks partial provider output as failed without publishing final reply events", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const published: RuntimeEvent[] = [];
    eventBus.subscribe("*", (event) => {
      published.push(event);
    });
    const conversation = new InMemoryConversationRepository();
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () =>
          createMockStreamingChatProvider("primary", {
            chunks: ["partial", "ignored"],
            failAfterChunks: 1,
            failAfter: new ProviderError({
              provider: "primary",
              capability: "chat",
              code: ProviderErrorCode.NetworkError,
              message: "stream interrupted"
            })
          })
      }
    });

    await expect(
      collectRuntimeStream(
        runtime.streamUserMessage(
          { sessionId: "partial-session", content: "hello" },
          { readMemory: false, writeMemory: false }
        )
      )
    ).rejects.toMatchObject({ code: ProviderErrorCode.NetworkError });
    const assistant = (await conversation.listRecentMessages("partial-session")).find(
      (message) => message.role === "assistant"
    );
    expect(assistant).toMatchObject({ content: "partial", status: "failed" });
    expect(published.filter((event) => event.type === "agent.reply")).toHaveLength(0);
    expect(published.filter((event) => event.type === "assistant.message")).toHaveLength(0);
  });

  it("marks an assistant message failed when an incremental append fails", async () => {
    const conversation = new InMemoryConversationRepository();
    const appendMessageContent = conversation.appendMessageContent.bind(conversation);
    let appendCount = 0;
    conversation.appendMessageContent = async (id, delta) => {
      appendCount += 1;
      if (appendCount === 1) {
        throw new Error("append unavailable");
      }
      return appendMessageContent(id, delta);
    };
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () => createMockStreamingChatProvider("native", { chunks: ["one", "two"] })
      }
    });

    await expect(
      collectRuntimeStream(
        runtime.streamUserMessage(
          { sessionId: "append-failed-session", content: "hello" },
          { readMemory: false, writeMemory: false }
        )
      )
    ).rejects.toMatchObject({
      name: "ConversationPersistenceError",
      operation: "assistant_stream_append"
    });
    expect((await conversation.listRecentMessages("append-failed-session")).at(-1)).toMatchObject({
      content: "one",
      status: "failed"
    });
  });

  it("stops before yielding when the streaming assistant message cannot be created", async () => {
    const conversation = new InMemoryConversationRepository();
    const appendMessage = conversation.appendMessage.bind(conversation);
    conversation.appendMessage = async (message) => {
      if (message.role === "assistant") {
        throw new Error("stream create unavailable");
      }
      return appendMessage(message);
    };
    const eventBus = new InMemoryEventBus({ development: false });
    const published: RuntimeEvent[] = [];
    eventBus.subscribe("*", (event) => {
      published.push(event);
    });
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () => createMockStreamingChatProvider("native", { chunks: ["first"] })
      }
    });

    await expect(
      collectRuntimeStream(
        runtime.streamUserMessage(
          { sessionId: "create-failed-session", content: "hello" },
          { readMemory: false, writeMemory: false }
        )
      )
    ).rejects.toMatchObject({
      name: "ConversationPersistenceError",
      operation: "assistant_stream_create"
    });
    expect(
      (await conversation.listRecentMessages("create-failed-session")).map(
        (message) => message.role
      )
    ).toEqual(["user"]);
    expect(published.filter((event) => event.type === "agent.reply")).toHaveLength(0);
    expect(published.filter((event) => event.type === "assistant.message")).toHaveLength(0);
  });

  it("does not publish final events when streaming finalization persistence fails", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const published: RuntimeEvent[] = [];
    eventBus.subscribe("*", (event) => {
      published.push(event);
    });
    const conversation = new InMemoryConversationRepository();
    conversation.completeMessage = async () => {
      throw new Error("finalize unavailable");
    };
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () => createMockStreamingChatProvider("native", { chunks: ["complete"] })
      }
    });

    await expect(
      collectRuntimeStream(
        runtime.streamUserMessage(
          { sessionId: "finalize-failed-session", content: "hello" },
          { readMemory: false, writeMemory: false }
        )
      )
    ).rejects.toMatchObject({
      name: "ConversationPersistenceError",
      operation: "assistant_stream_complete"
    });
    expect((await conversation.listRecentMessages("finalize-failed-session")).at(-1)).toMatchObject(
      {
        content: "complete",
        status: "failed"
      }
    );
    expect(published.filter((event) => event.type === "agent.reply")).toHaveLength(0);
    expect(published.filter((event) => event.type === "assistant.message")).toHaveLength(0);
  });

  it("marks streaming messages cancelled for external abort and consumer return", async () => {
    const conversation = new InMemoryConversationRepository();
    const controller = new AbortController();
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () =>
          createMockStreamingChatProvider("native", {
            chunks: ["first", "second"],
            delayMs: 5
          })
      }
    });
    const iterator = runtime
      .streamUserMessage(
        { sessionId: "abort-session", content: "hello" },
        { signal: controller.signal, readMemory: false, writeMemory: false }
      )
      [Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "text-delta", text: "first" },
      done: false
    });
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ code: ProviderErrorCode.Cancelled });
    expect((await conversation.listRecentMessages("abort-session")).at(-1)).toMatchObject({
      status: "cancelled",
      content: "first"
    });

    const earlyConversation = new InMemoryConversationRepository();
    const trackedReturn = vi.fn(
      async (): Promise<IteratorResult<ChatStreamEvent>> => ({ done: true, value: undefined })
    );
    const trackedProvider = {
      name: "tracked",
      healthCheck: async () => ({
        provider: "tracked",
        status: "healthy" as const,
        checkedAt: new Date().toISOString()
      }),
      generateReply: async () => ({ message: { role: "assistant" as const, content: "tracked" } }),
      streamReply: () => ({
        async next() {
          return { done: false as const, value: { type: "text-delta" as const, text: "first" } };
        },
        return: trackedReturn,
        [Symbol.asyncIterator]() {
          return this;
        }
      })
    };
    const earlyRuntime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createRecordingMemory([]),
      conversation: earlyConversation,
      promptBuilder: new PromptBuilder(),
      providers: { ...createMockProviders(), getChatProvider: () => trackedProvider }
    });
    const earlyIterator = earlyRuntime
      .streamUserMessage(
        { sessionId: "return-session", content: "hello" },
        { readMemory: false, writeMemory: false }
      )
      [Symbol.asyncIterator]();
    await earlyIterator.next();
    await earlyIterator.return?.();
    expect(trackedReturn).toHaveBeenCalledTimes(1);
    expect((await earlyConversation.listRecentMessages("return-session")).at(-1)).toMatchObject({
      status: "cancelled"
    });
  });

  it("checks cancellation before saving the user message", async () => {
    const controller = new AbortController();
    controller.abort();
    const conversation = new InMemoryConversationRepository();
    const published: RuntimeEvent[] = [];
    const eventBus = new InMemoryEventBus({ development: false });
    eventBus.subscribe("*", (event) => {
      published.push(event);
    });
    let providerCalls = 0;
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () => {
          providerCalls += 1;
          return createMockChatProvider("never");
        }
      }
    });

    await expect(
      collectRuntimeStream(
        runtime.streamUserMessage(
          { sessionId: "pre-cancel-session", content: "hello" },
          { signal: controller.signal }
        )
      )
    ).rejects.toMatchObject({ code: ProviderErrorCode.Cancelled });
    expect(providerCalls).toBe(0);
    expect(await conversation.listRecentMessages("pre-cancel-session")).toEqual([]);
    expect(published.filter((event) => event.type === "user.message")).toHaveLength(0);
  });

  it("keeps failed streaming text out of restored direct context and persists with memory disabled", async () => {
    const conversation = new InMemoryConversationRepository();
    const memory = createRecordingMemory([]);
    let memoryReads = 0;
    memory.retrieveRelevantMemories = async () => {
      memoryReads += 1;
      return [];
    };
    const failedRuntime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory,
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () =>
          createMockStreamingChatProvider("native", {
            chunks: ["not completed", "ignored"],
            failAfterChunks: 1,
            failAfter: new ProviderError({
              provider: "native",
              capability: "chat",
              code: ProviderErrorCode.NetworkError,
              message: "interrupted"
            })
          })
      }
    });
    await expect(
      collectRuntimeStream(
        failedRuntime.streamUserMessage(
          { sessionId: "context-session", content: "remember partial" },
          { useMemory: false }
        )
      )
    ).rejects.toBeInstanceOf(ProviderError);

    const restored = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory,
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });
    await restored.handleUserMessage(
      { sessionId: "context-session", content: "what was completed?" },
      { useMemory: false }
    );
    const directContext = restored
      .getLatestPromptPreview()
      ?.sections.find((section) => section.name === "DirectContext")?.content;
    expect(directContext).not.toContain("remember partial");
    expect(memoryReads).toBe(0);
    expect((await conversation.listRecentMessages("context-session")).length).toBe(4);
  });
  it("returns the agent reply when optional memory and TTS side effects fail", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const diagnostics: string[] = [];
    const published: RuntimeEvent[] = [];
    const conversation = new InMemoryConversationRepository();
    const persistenceOrder: string[] = [];
    const appendMessage = conversation.appendMessage.bind(conversation);
    conversation.appendMessage = async (message) => {
      persistenceOrder.push(`${message.role}:save`);
      return appendMessage(message);
    };

    eventBus.subscribe("*", (event) => {
      published.push(event);
      if (["user.message", "agent.reply", "assistant.message"].includes(event.type)) {
        persistenceOrder.push(event.type);
      }
    });
    eventBus.subscribe("runtime.error", (event) => {
      diagnostics.push(event.type);
    });
    eventBus.subscribe("provider.error", (event) => {
      diagnostics.push(event.type);
    });

    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: createFailingMemory(),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: {
        getChatProvider: () => createMockChatProvider("mock-chat"),
        getReasoningProvider: () => createMockReasoningProvider("mock-reasoning"),
        getTTSProvider: () => ({
          name: "failing-tts",
          async healthCheck() {
            return {
              provider: "failing-tts",
              status: "unavailable",
              checkedAt: new Date().toISOString()
            };
          },
          async synthesizeSpeech() {
            throw new ProviderError({
              provider: "failing-tts",
              capability: "tts",
              code: ProviderErrorCode.ProviderUnavailable,
              message: "TTS is unavailable."
            });
          }
        }),
        getSTTProvider: () => createMockSTTProvider("mock-stt"),
        getVisionProvider: () => createMockVisionProvider("mock-vision"),
        getEmbeddingProvider: () => ({
          name: "mock-embedding",
          dimensions: 3,
          async healthCheck() {
            return {
              provider: "mock-embedding",
              status: "healthy",
              checkedAt: new Date().toISOString()
            };
          },
          async embedText() {
            return [0, 0, 0];
          },
          async embedBatch(texts: string[]) {
            return texts.map(() => [0, 0, 0]);
          }
        })
      }
    });

    const reply = await runtime.handleUserMessage({
      sessionId: "test-session",
      content: "hello",
      voiceOutput: true
    });

    expect(reply.type).toBe("agent.reply");
    expect(reply.payload.content).toContain("Mock reply");
    expect(diagnostics).toContain("runtime.error");
    expect(diagnostics).toContain("provider.error");

    const messageEvents = published.filter((event) =>
      ["user.message", "agent.reply", "assistant.message"].includes(event.type)
    );
    expect(messageEvents.map((event) => event.type)).toEqual([
      "user.message",
      "agent.reply",
      "assistant.message"
    ]);
    const userMessage = messageEvents[0]!;
    const agentReply = messageEvents[1]!;
    const assistantMessage = messageEvents[2]!;
    expect(agentReply.traceId).toBe(userMessage.traceId);
    expect(assistantMessage.traceId).toBe(userMessage.traceId);
    expect(agentReply.parentId).toBe(userMessage.id);
    expect(assistantMessage.parentId).toBe(agentReply.id);
    expect(assistantMessage.payload).toMatchObject({
      sessionId: "test-session",
      content: reply.payload.content,
      provider: reply.payload.provider
    });
    expect(persistenceOrder).toEqual([
      "user:save",
      "user.message",
      "assistant:save",
      "agent.reply",
      "assistant.message"
    ]);
  });

  it("publishes no reply events when every chat provider fails", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const published: RuntimeEvent[] = [];
    eventBus.subscribe("*", (event) => {
      published.push(event);
    });
    const providers = createMockProviders();
    providers.getChatProvider = () => ({
      name: "failing-chat",
      async healthCheck() {
        return {
          provider: "failing-chat",
          status: "unavailable" as const,
          checkedAt: new Date().toISOString()
        };
      },
      async generateReply() {
        throw new ProviderError({
          provider: "failing-chat",
          capability: "chat",
          code: ProviderErrorCode.ProviderUnavailable,
          message: "Chat provider is unavailable."
        });
      }
    });

    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: createRecordingMemory([]),
      promptBuilder: new PromptBuilder(),
      providers
    });

    await expect(
      runtime.handleUserMessage({ sessionId: "failed-session", content: "hello" })
    ).rejects.toBeInstanceOf(ProviderError);
    expect(published.filter((event) => event.type === "agent.reply")).toHaveLength(0);
    expect(published.filter((event) => event.type === "assistant.message")).toHaveLength(0);
    expect(published.filter((event) => event.type === "provider.error")).toHaveLength(1);
  });

  it("publishes one assistant message when memory retrieval fails", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const published: RuntimeEvent[] = [];
    eventBus.subscribe("*", (event) => {
      published.push(event);
    });
    const memory = createRecordingMemory([]);
    memory.retrieveRelevantMemoriesWithMetadata = async () => {
      throw new Error("memory read unavailable");
    };
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory,
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });

    const reply = await runtime.handleUserMessage({
      sessionId: "read-failed-session",
      content: "hello"
    });

    expect(published.filter((event) => event.type === "assistant.message")).toHaveLength(1);
    expect(published.find((event) => event.type === "assistant.message")?.payload).toMatchObject({
      content: reply.payload.content
    });
    expect(published.filter((event) => event.type === "runtime.error")).toHaveLength(1);
  });

  it("restores direct context from the repository when a Runtime is rebuilt", async () => {
    const conversation = new InMemoryConversationRepository();
    const runtimeA = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });

    await runtimeA.handleUserMessage(
      { sessionId: "persisted-session", content: "remember this direct context" },
      { readMemory: false, writeMemory: false }
    );

    const runtimeB = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });
    await runtimeB.handleUserMessage(
      { sessionId: "persisted-session", content: "what did I say?" },
      { readMemory: false, writeMemory: false }
    );

    const restored = runtimeB
      .getLatestPromptPreview()
      ?.sections.find((section) => section.name === "DirectContext");
    expect(restored?.content).toContain("remember this direct context");

    const isolated = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createRecordingMemory([]),
      conversation,
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });
    await isolated.handleUserMessage(
      { sessionId: "other-session", content: "isolated" },
      { readMemory: false, writeMemory: false }
    );
    expect(
      isolated
        .getLatestPromptPreview()
        ?.sections.find((section) => section.name === "DirectContext")?.content
    ).not.toContain("remember this direct context");
  });

  it("blocks provider execution when the user message cannot be persisted", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const published: RuntimeEvent[] = [];
    eventBus.subscribe("*", (event) => {
      published.push(event);
    });
    let providerCalls = 0;
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: createRecordingMemory([]),
      conversation: {
        kind: "in-memory",
        async healthCheck() {
          return { status: "healthy" as const };
        },
        async ensureSession() {
          throw new Error("session store unavailable");
        },
        async appendMessage() {
          throw new Error("unreachable");
        },
        async appendMessageContent() {
          throw new Error("unreachable");
        },
        async completeMessage() {
          throw new Error("unreachable");
        },
        async failMessage() {
          throw new Error("unreachable");
        },
        async listRecentMessages() {
          return [];
        }
      },
      promptBuilder: new PromptBuilder(),
      providers: {
        ...createMockProviders(),
        getChatProvider: () => {
          providerCalls += 1;
          return createMockProviders().getChatProvider();
        }
      }
    });

    await expect(
      runtime.handleUserMessage({ sessionId: "save-failed", content: "hello" })
    ).rejects.toMatchObject({
      name: "ConversationPersistenceError",
      operation: "session_create"
    });
    expect(providerCalls).toBe(0);
    expect(published.filter((event) => event.type === "user.message")).toHaveLength(0);
    expect(published.filter((event) => event.type === "assistant.message")).toHaveLength(0);
    expect(published.find((event) => event.type === "runtime.error")?.payload).toMatchObject({
      category: "persistence",
      operation: "session_create"
    });
  });

  it("does not publish or cache an assistant message when assistant persistence fails", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const published: RuntimeEvent[] = [];
    eventBus.subscribe("*", (event) => {
      published.push(event);
    });
    let appends = 0;
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: createRecordingMemory([]),
      conversation: {
        kind: "in-memory",
        async healthCheck() {
          return { status: "healthy" as const };
        },
        async ensureSession() {},
        async appendMessage(message) {
          appends += 1;
          if (appends > 1) {
            throw new Error("assistant store unavailable");
          }
          return { ...message, sequence: 1 };
        },
        async appendMessageContent() {
          throw new Error("unreachable");
        },
        async completeMessage() {
          throw new Error("unreachable");
        },
        async failMessage() {
          throw new Error("unreachable");
        },
        async listRecentMessages() {
          return [];
        }
      },
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });

    await expect(
      runtime.handleUserMessage({
        sessionId: "assistant-save-failed",
        content: "hello"
      })
    ).rejects.toMatchObject({
      name: "ConversationPersistenceError",
      operation: "assistant_message_save"
    });
    expect(published.filter((event) => event.type === "user.message")).toHaveLength(1);
    expect(published.filter((event) => event.type === "agent.reply")).toHaveLength(0);
    expect(published.filter((event) => event.type === "assistant.message")).toHaveLength(0);
  });

  it("uses memory extractor candidates for runtime writes and skips ordinary turns", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const written: MemoryCandidate[] = [];
    const extractionInputs: string[] = [];
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: {
        async retrieveRelevantMemories() {
          return [];
        },
        scoreImportance() {
          return 0;
        },
        async extractCandidates(input) {
          extractionInputs.push(input.userMessage);
          if (input.userMessage.startsWith("记住")) {
            return [
              {
                type: "semantic",
                subtype: "path",
                content: "我的项目路径是 /home/administrator/uv-main/uv-main",
                summary: "我的项目路径是 /home/administrator/uv-main/uv-main",
                importance: 0.95,
                tags: ["path"],
                reason: "explicit-remember",
                sourceTraceId: input.sourceTraceId ?? null
              }
            ];
          }
          if (input.userMessage.startsWith("secret metadata")) {
            return [
              {
                type: "semantic",
                subtype: "fact",
                content: "apiKey=sk-super-secret should be redacted",
                summary: "authorization: Bearer secret should be redacted",
                importance: 0.2,
                tags: ["token=secret"],
                reason: "low-quality-secret-test",
                sourceTraceId: input.sourceTraceId ?? null,
                metadata: {
                  apiKey: "sk-super-secret",
                  nested: { authorization: "Bearer secret" }
                }
              }
            ];
          }
          return [];
        },
        async rememberCandidate(candidate): Promise<Memory> {
          written.push(candidate);
          return createMemory(candidate);
        },
        async rememberInteraction(): Promise<Memory> {
          throw new Error("legacy memory write should not be used");
        }
      },
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders()
    });

    await runtime.handleUserMessage({
      sessionId: "test-session",
      content: "hi"
    });
    await runtime.handleUserMessage(
      {
        sessionId: "test-session",
        content: "记住：这个不应该写入，因为 writeMemory=false"
      },
      {
        writeMemory: false
      }
    );
    const reply = await runtime.handleUserMessage({
      sessionId: "test-session",
      content: "记住：我的项目路径是 /home/administrator/uv-main/uv-main"
    });
    await runtime.handleUserMessage({
      sessionId: "test-session",
      content: "secret metadata candidate"
    });

    expect(written).toHaveLength(1);
    expect(extractionInputs).toEqual([
      "hi",
      "记住：我的项目路径是 /home/administrator/uv-main/uv-main",
      "secret metadata candidate"
    ]);
    expect(written[0]).toMatchObject({
      type: "semantic",
      subtype: "path",
      reason: "explicit-remember",
      sourceTraceId: reply.traceId
    });
    const history = runtime.getRecentMemoryCandidates(5);
    expect(history.some((candidate) => candidate.decision === "stored")).toBe(true);
    const rejected = history.find((candidate) => candidate.reason === "low-quality-secret-test");
    expect(rejected).toMatchObject({
      decision: "rejected",
      rejectedReason: "runtime-threshold:low-quality-secret-test"
    });
    expect(JSON.stringify(rejected)).not.toContain("sk-super-secret");
    expect(JSON.stringify(rejected)).not.toContain("Bearer secret");
  });

  it("injects bounded same-session DirectContext without mixing unrelated sessions", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const written: MemoryCandidate[] = [];
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: createRecordingMemory(written),
      promptBuilder: new PromptBuilder(),
      providers: createMockProviders(),
      directContext: {
        enabled: true,
        maxTurns: 1,
        maxChars: 220
      }
    });

    await runtime.handleUserMessage(
      {
        sessionId: "session-a",
        content: "First context turn with token=super-secret-value"
      },
      { writeMemory: false }
    );
    await runtime.handleUserMessage(
      {
        sessionId: "session-b",
        content: "Unrelated session content should not appear"
      },
      { writeMemory: false }
    );
    await runtime.handleUserMessage(
      {
        sessionId: "session-a",
        content: "Second context turn"
      },
      { writeMemory: false }
    );
    const secondPreview = runtime.getLatestPromptPreview();
    const directContext = secondPreview?.sections.find(
      (section) => section.name === "DirectContext"
    );
    const relevantMemory = secondPreview?.sections.find(
      (section) => section.name === "RelevantMemory"
    );

    expect(directContext?.content).toContain("First context turn");
    expect(directContext?.content).not.toContain("super-secret-value");
    expect(directContext?.content).not.toContain("Unrelated session content");
    expect(relevantMemory?.content).toBe("No relevant memory retrieved.");
    expect(secondPreview).toMatchObject({
      directContextEnabled: true,
      directContextTurnCount: 1,
      directContextTruncated: false,
      directContextSource: "session-turns"
    });
    expect(secondPreview?.directContextCharCount).toBeGreaterThan(0);
    expect(written).toHaveLength(0);

    await runtime.handleUserMessage(
      {
        sessionId: "session-a",
        content: "Third context turn"
      },
      { writeMemory: false }
    );
    const thirdPreview = runtime.getLatestPromptPreview();
    const thirdDirectContext = thirdPreview?.sections.find(
      (section) => section.name === "DirectContext"
    );
    expect(thirdDirectContext?.content).not.toContain("First context turn");
    expect(thirdDirectContext?.content).toContain("Second context turn");
    expect(thirdPreview?.directContextTruncated).toBe(true);
  });
});

function createFailingMemory(): RuntimeMemoryPort {
  return {
    async retrieveRelevantMemories() {
      return [];
    },
    scoreImportance() {
      return 1;
    },
    async rememberInteraction(): Promise<Memory> {
      throw new Error("memory database unavailable");
    }
  };
}

function createRecordingMemory(written: MemoryCandidate[]): RuntimeMemoryPort {
  return {
    async retrieveRelevantMemories() {
      return [];
    },
    async retrieveRelevantMemoriesWithMetadata() {
      return {
        query: "",
        keywords: [],
        rawCount: 0,
        count: 0,
        retrievalMode: "keyword",
        vectorEnabled: false,
        vectorUsed: false,
        queryEmbeddingGenerated: false,
        vectorResultCount: 0,
        keywordResultCount: 0,
        hybridResultCount: 0,
        fallbackUsed: false,
        retrievalScope: "user,project:yuvi-runtime",
        includedScopes: [{ scope: "user" }, { scope: "project", scopeId: "yuvi-runtime" }],
        includeArchived: false,
        includeSuperseded: false,
        includeExpired: false,
        currentTime: new Date().toISOString(),
        excludedByStatus: 0,
        excludedByTime: 0,
        excludedByScope: 0,
        rawMemories: [],
        memories: [],
        selectedMemories: []
      };
    },
    scoreImportance() {
      return 0;
    },
    async extractCandidates() {
      return [];
    },
    async rememberCandidate(candidate): Promise<Memory> {
      written.push(candidate);
      return createMemory(candidate);
    },
    async rememberInteraction(): Promise<Memory | null> {
      return null;
    }
  };
}

function createMockProviders() {
  return {
    getChatProvider: () => createMockChatProvider("mock-chat"),
    getReasoningProvider: () => createMockReasoningProvider("mock-reasoning"),
    getTTSProvider: () => ({
      name: "mock-tts",
      async healthCheck() {
        return {
          provider: "mock-tts",
          status: "healthy" as const,
          checkedAt: new Date().toISOString()
        };
      },
      async synthesizeSpeech() {
        return {
          audio: new Uint8Array(),
          audioBase64: "",
          mimeType: "audio/wav",
          durationMs: 0
        };
      }
    }),
    getSTTProvider: () => createMockSTTProvider("mock-stt"),
    getVisionProvider: () => createMockVisionProvider("mock-vision"),
    getEmbeddingProvider: () => ({
      name: "mock-embedding",
      dimensions: 3,
      async healthCheck() {
        return {
          provider: "mock-embedding",
          status: "healthy" as const,
          checkedAt: new Date().toISOString()
        };
      },
      async embedText() {
        return [0, 0, 0];
      },
      async embedBatch(texts: string[]) {
        return texts.map(() => [0, 0, 0]);
      }
    })
  };
}

function createMemory(candidate: MemoryCandidate): Memory {
  const now = new Date();
  return {
    id: "memory-id",
    type: candidate.type,
    subtype: candidate.subtype ?? null,
    scope: candidate.scope ?? "user",
    scopeId: candidate.scopeId ?? null,
    memoryLayer: candidate.memoryLayer ?? "core",
    status: "active",
    content: candidate.content,
    summary: candidate.summary ?? null,
    embedding: null,
    embeddingModel: null,
    embeddingProvider: null,
    embeddingDimensions: null,
    embeddedAt: null,
    importance: candidate.importance,
    emotionValence: 0,
    emotionArousal: 0,
    source: "runtime",
    sourceTraceId: candidate.sourceTraceId ?? null,
    metadata: {},
    tags: candidate.tags,
    createdAt: now,
    updatedAt: now,
    observedAt: candidate.observedAt ? new Date(candidate.observedAt) : now,
    eventTime: null,
    validFrom: now,
    validUntil: null,
    expiresAt: null,
    lastAccessedAt: now,
    supersededAt: null,
    supersedes: [],
    supersededBy: null,
    contradicts: []
  };
}
