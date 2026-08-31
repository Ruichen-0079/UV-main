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
});
