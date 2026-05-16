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
import { describe, expect, it } from "vitest";
import { RuntimeOrchestrator, type RuntimeMemoryPort } from "./index.js";

describe("RuntimeOrchestrator", () => {
  it("returns the agent reply when optional memory and TTS side effects fail", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const diagnostics: string[] = [];

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
    content: candidate.content,
    summary: candidate.summary ?? null,
    embedding: null,
    importance: candidate.importance,
    emotionValence: 0,
    emotionArousal: 0,
    source: "runtime",
    sourceTraceId: candidate.sourceTraceId ?? null,
    metadata: {},
    tags: candidate.tags,
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now
  };
}
