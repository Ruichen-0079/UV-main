import { InMemoryEventBus } from "@companion/event-bus";
import { InMemoryConversationRepository } from "@companion/memory";
import { PromptBuilder } from "@companion/prompt-builder";
import {
  createMockChatProvider,
  createMockReasoningProvider,
  createMockSTTProvider,
  createMockTTSProvider,
  createMockVisionProvider,
  MockEmbeddingProvider
} from "@companion/providers";
import { describe, expect, it } from "vitest";
import { RuntimeOrchestrator, type RuntimeMemoryPort } from "./index.js";

function createProviders() {
  return {
    getChatProvider: () => createMockChatProvider("vnext-chat"),
    getReasoningProvider: () => createMockReasoningProvider("vnext-reasoning"),
    getTTSProvider: () => createMockTTSProvider("vnext-tts"),
    getSTTProvider: () => createMockSTTProvider("vnext-stt"),
    getVisionProvider: () => createMockVisionProvider("vnext-vision"),
    getEmbeddingProvider: () => new MockEmbeddingProvider(3)
  };
}

function createMemory(): RuntimeMemoryPort {
  return {
    retrieveRelevantMemories: async () => [],
    scoreImportance: () => 0,
    rememberInteraction: async () => null
  };
}

describe("Runtime Memory vNext vertical slice", () => {
  it("injects L1 recent episodes after DirectContext rolls off the training turn", async () => {
    const conversation = new InMemoryConversationRepository();
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createMemory(),
      promptBuilder: new PromptBuilder(),
      providers: createProviders(),
      conversation,
      directContext: { enabled: true, maxTurns: 1, maxChars: 6000 }
    });

    await runtime.handleUserMessage(
      {
        sessionId: "vnext-train",
        content: "下午把训练脚本改到 6121 端口，继续跑训练。"
      },
      { readMemory: true, writeMemory: false }
    );
    await runtime.handleUserMessage(
      { sessionId: "vnext-train", content: "今天先聊点别的。" },
      { readMemory: true, writeMemory: false }
    );
    await runtime.handleUserMessage(
      { sessionId: "vnext-train", content: "昨天那个训练怎么样了？" },
      { readMemory: true, writeMemory: false }
    );

    const preview = runtime.getLatestPromptPreview();
    const direct =
      preview?.sections.find((section) => section.name === "DirectContext")?.content ?? "";
    const episodic =
      preview?.sections.find((section) => section.name === "RecentEpisodicMemory")?.content ?? "";

    expect(direct).not.toContain("训练脚本改到 6121");
    expect(episodic).toContain("6121");
    expect(preview?.sections.some((section) => section.name === "RecentEpisodicMemory")).toBe(true);
    expect(preview?.recentEpisodicCount).toBeGreaterThan(0);
  });

  it("reports elapsed time from the previous interaction, not the current user turn", async () => {
    const conversation = new InMemoryConversationRepository();
    const prior = new Date(Date.now() - 16 * 60 * 60 * 1000).toISOString();
    await conversation.appendMessage({
      id: "gap-old-user",
      sessionId: "vnext-gap",
      traceId: "trace-old-user",
      parentMessageId: null,
      role: "user",
      content: "昨天那个训练开始了。",
      status: "completed",
      createdAt: prior,
      completedAt: prior,
      metadata: {}
    });
    await conversation.appendMessage({
      id: "gap-old-assistant",
      sessionId: "vnext-gap",
      traceId: "trace-old-assistant",
      parentMessageId: "gap-old-user",
      role: "assistant",
      content: "好，先记着。",
      status: "completed",
      createdAt: prior,
      completedAt: prior,
      metadata: {}
    });

    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createMemory(),
      promptBuilder: new PromptBuilder(),
      providers: createProviders(),
      conversation
    });

    await runtime.handleUserMessage(
      { sessionId: "vnext-gap", content: "我回来了" },
      { readMemory: true, writeMemory: false }
    );

    const preview = runtime.getLatestPromptPreview();
    const currentTime =
      preview?.sections.find((section) => section.name === "CurrentTime")?.content ?? "";
    expect(preview?.temporalAgeBand).not.toBe("just-now");
    expect(currentTime).not.toMatch(/Elapsed since last interaction: less than 2 minutes/);
    expect(currentTime).toMatch(/hours-ago|yesterday|this-week|hours/);
  });

  it("activates structured compression only after the Runtime prompt budget is exceeded", async () => {
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createMemory(),
      promptBuilder: new PromptBuilder(),
      providers: createProviders(),
      conversation: new InMemoryConversationRepository(),
      directContext: { enabled: true, maxTurns: 6, maxChars: 20_000 },
      memoryContextCompression: "auto"
    });

    for (let index = 0; index < 6; index += 1) {
      await runtime.handleUserMessage(
        {
          sessionId: "vnext-compression",
          content: `Older ordinary conversation detail ${"context ".repeat(180)}${String.fromCharCode(97 + index)}`
        },
        { readMemory: true, writeMemory: false }
      );
    }

    const preview = runtime.getLatestPromptPreview();
    const direct = preview?.sections.find((section) => section.name === "DirectContext")?.content;
    expect(preview?.contextCompression?.mode).toBe("auto");
    expect(preview?.contextCompression?.attempted).toBe(true);
    expect(preview?.contextCompression?.triggered).toBe(true);
    expect(preview?.contextCompression?.budgetCompliant).toBe(true);
    expect(preview?.estimatedTokens).toBeLessThanOrEqual(3_000);
    expect(direct).toContain("Older ordinary conversation detail");
  });
});
