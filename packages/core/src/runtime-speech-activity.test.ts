import { InMemoryEventBus } from "@companion/event-bus";
import { InMemoryConversationRepository } from "@companion/memory";
import { PromptBuilder } from "@companion/prompt-builder";
import {
  createMockAssistantContinuationProvider,
  createMockChatProvider,
  createMockProactiveDecisionProvider,
  createMockReasoningProvider,
  createMockSTTProvider,
  createMockVisionProvider
} from "@companion/providers";
import { describe, expect, it } from "vitest";
import {
  RuntimeOrchestrator,
  SpeechCaptureFenceError,
  type RuntimeCharacterPort,
  type RuntimeMemoryPort
} from "./index.js";

function memoryStub(): RuntimeMemoryPort {
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
        retrievalScope: "user",
        includedScopes: [{ scope: "user" }],
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
    async rememberCandidate() {
      throw new Error("speech activity must not write Memory");
    },
    async rememberInteraction() {
      return null;
    }
  };
}

function providers() {
  return {
    getChatProvider: () => createMockChatProvider("activity-chat"),
    getProactiveDecisionProvider: () => createMockProactiveDecisionProvider("REQUEST_TEXT"),
    getAssistantContinuationProvider: () =>
      createMockAssistantContinuationProvider("proactive hello"),
    getReasoningProvider: () => createMockReasoningProvider("activity-reasoning"),
    getTTSProvider: () => ({
      name: "activity-tts",
      async healthCheck() {
        return {
          provider: "activity-tts",
          status: "healthy" as const,
          checkedAt: new Date().toISOString()
        };
      },
      async synthesizeSpeech() {
        throw new Error("TTS must not run");
      }
    }),
    getSTTProvider: () => createMockSTTProvider("activity-stt"),
    getVisionProvider: () => createMockVisionProvider("activity-vision"),
    getEmbeddingProvider: () => ({
      name: "activity-embedding",
      dimensions: 3,
      async healthCheck() {
        return {
          provider: "activity-embedding",
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

function createRuntime(character?: RuntimeCharacterPort) {
  return new RuntimeOrchestrator({
    eventBus: new InMemoryEventBus({ development: false }),
    memory: memoryStub(),
    promptBuilder: new PromptBuilder(),
    conversation: new InMemoryConversationRepository(),
    providers: providers(),
    ...(character ? { character } : {})
  });
}

async function collect(stream: AsyncIterable<{ type: string }>) {
  const events: Array<{ type: string }> = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("Runtime live speech activity", () => {
  it("sets speechActive on VAD ACTIVE and clears it on INACTIVE", () => {
    const runtime = createRuntime();
    expect(runtime.isSpeechActive()).toBe(false);
    const active = runtime.observeSpeechActivity({
      sessionId: "s",
      captureEpoch: "epoch-live",
      active: true
    });
    expect(active.speechActive).toBe(true);
    expect(active.captureEpoch).toBe("epoch-live");
    const inactive = runtime.observeSpeechActivity({
      sessionId: "s",
      captureEpoch: "epoch-live",
      active: false
    });
    expect(inactive.speechActive).toBe(false);
    expect(runtime.isSpeechActive()).toBe(false);
  });

  it("does not resurrect speechActive after Runtime reconstruction", () => {
    const first = createRuntime();
    first.observeSpeechActivity({ sessionId: "s", captureEpoch: "epoch-a", active: true });
    expect(first.isSpeechActive()).toBe(true);
    const second = createRuntime();
    expect(second.isSpeechActive()).toBe(false);
    expect(second.getSpeechActivitySnapshot().captureEpoch).toBeNull();
  });

  it("advances activityRevision only on ACTIVE transitions, not duplicate states", () => {
    const runtime = createRuntime();
    const start = runtime.getProactiveState().activityRevision;
    runtime.observeSpeechActivity({ sessionId: "s", captureEpoch: "epoch-a", active: true });
    expect(runtime.getProactiveState().activityRevision).toBe(start + 1);
    runtime.observeSpeechActivity({ sessionId: "s", captureEpoch: "epoch-a", active: true });
    runtime.observeSpeechActivity({ sessionId: "s", captureEpoch: "epoch-a", active: true });
    expect(runtime.getProactiveState().activityRevision).toBe(start + 1);
    runtime.observeSpeechActivity({ sessionId: "s", captureEpoch: "epoch-a", active: false });
    runtime.observeSpeechActivity({ sessionId: "s", captureEpoch: "epoch-a", active: false });
    expect(runtime.getProactiveState().activityRevision).toBe(start + 1);
    runtime.observeSpeechActivity({ sessionId: "s", captureEpoch: "epoch-a", active: true });
    expect(runtime.getProactiveState().activityRevision).toBe(start + 2);
  });

  it("does not clear proactive suppression", async () => {
    const runtime = createRuntime({
      async generate() {
        return {
          decision: {
            addressing: "DIRECTED_TO_YUVI",
            reply: { disposition: "RESPOND", text: "好" },
            proactive: { action: "SUPPRESS", scope: { kind: "UNTIL_ENGAGEMENT" } }
          },
          providerMetadata: { model: "activity-character" }
        };
      },
      async generateAfterCognition() {
        throw new Error("cognition must not run");
      }
    });
    await runtime.handleUserMessage(
      { sessionId: "s", content: "安静" },
      { controlAuthority: "LOCAL_EXPLICIT_CONTROLLER", readMemory: false, writeMemory: false }
    );
    expect(runtime.getProactiveState().suppression).toEqual({ kind: "UNTIL_ENGAGEMENT" });
    runtime.observeSpeechActivity({ sessionId: "s", captureEpoch: "epoch-vad", active: true });
    expect(runtime.getProactiveState().suppression).toEqual({ kind: "UNTIL_ENGAGEMENT" });
    runtime.observeSpeechActivity({ sessionId: "s", captureEpoch: "epoch-vad", active: false });
    expect(runtime.getProactiveState().suppression).toEqual({ kind: "UNTIL_ENGAGEMENT" });
  });

  it("does not publish Character, Memory, or UserMessage from VAD", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const published: string[] = [];
    eventBus.subscribe("*", (event) => {
      published.push(event.type);
    });
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: memoryStub(),
      promptBuilder: new PromptBuilder(),
      conversation: new InMemoryConversationRepository(),
      providers: providers()
    });
    runtime.observeSpeechActivity({ sessionId: "s", captureEpoch: "epoch-obs", active: true });
    expect(published).toEqual([]);
  });

  it("stales an admitted proactive attempt when VAD becomes ACTIVE", async () => {
    let release: () => void = () => undefined;
    const continuationGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let continuationStarted: () => void = () => undefined;
    const continuationBegan = new Promise<void>((resolve) => {
      continuationStarted = resolve;
    });
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: memoryStub(),
      promptBuilder: new PromptBuilder(),
      conversation: new InMemoryConversationRepository(),
      providers: {
        ...providers(),
        getAssistantContinuationProvider: () => ({
          name: "gated-continuation",
          async generateContinuation() {
            continuationStarted();
            await continuationGate;
            return {
              message: { role: "assistant" as const, content: "stale proactive" },
              finishReason: "stop" as const
            };
          }
        })
      }
    });
    const startedRevision = runtime.getProactiveState().activityRevision;
    const pending = collect(
      runtime.streamAssistantInitiatedTurn({
        sessionId: "s",
        idempotencyKey: "stale-vad",
        readMemory: false
      })
    );
    await continuationBegan;
    runtime.observeSpeechActivity({ sessionId: "s", captureEpoch: "epoch-vad", active: true });
    expect(runtime.getProactiveState().activityRevision).toBe(startedRevision + 1);
    expect(runtime.isSpeechActive()).toBe(true);
    release();
    await expect(pending).rejects.toMatchObject({
      name: "ProactiveAdmissionError",
      reason: "stale-revision"
    });
  });

  it("rejects live activity from an obsolete capture epoch", () => {
    const runtime = createRuntime();
    runtime.observeSpeechActivity({ sessionId: "s", captureEpoch: "epoch-old", active: true });
    runtime.observeSpeechActivity({ sessionId: "s", captureEpoch: "epoch-new", active: true });
    expect(() =>
      runtime.observeSpeechActivity({ sessionId: "s", captureEpoch: "epoch-old", active: true })
    ).toThrow(SpeechCaptureFenceError);
  });
});
