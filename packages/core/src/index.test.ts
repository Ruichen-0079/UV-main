import { InMemoryEventBus } from "@companion/event-bus";
import type { Memory, MemoryCandidate } from "@companion/memory";
import { PromptBuilder } from "@companion/prompt-builder";
import {
  ProviderError,
  ProviderErrorCode,
  createMockChatProvider,
  createMockReasoningProvider,
  createMockSTTProvider,
  createMockVisionProvider
} from "@companion/providers";
import type { RuntimeEvent } from "@companion/protocol";
import { describe, expect, it } from "vitest";
import { RuntimeOrchestrator, type RuntimeMemoryPort } from "./index.js";

describe("RuntimeOrchestrator", () => {
  it("returns the agent reply when optional memory and TTS side effects fail", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const diagnostics: string[] = [];
    const published: RuntimeEvent[] = [];

    eventBus.subscribe("*", (event) => {
      published.push(event);
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
