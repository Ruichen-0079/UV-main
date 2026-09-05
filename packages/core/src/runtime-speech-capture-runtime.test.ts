import { InMemoryEventBus } from "@companion/event-bus";
import { InMemoryConversationRepository } from "@companion/memory";
import { PromptBuilder } from "@companion/prompt-builder";
import { createEvent } from "@companion/protocol";
import type { RuntimeEvent } from "@companion/protocol";
import {
  createMockAssistantContinuationProvider,
  createMockChatProvider,
  createMockProactiveDecisionProvider,
  createMockReasoningProvider,
  createMockSTTProvider,
  createMockVisionProvider,
  type ProviderResolver,
  type STTOutput
} from "@companion/providers";
import { describe, expect, it } from "vitest";
import {
  ProactiveAdmissionError,
  RuntimeOrchestrator,
  SpeechCaptureFenceError,
  type RuntimeCharacterPort,
  type RuntimeCharacterTurnResult,
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
      throw new Error("speech capture tests must not write Memory");
    },
    async rememberInteraction() {
      return null;
    }
  };
}

function providers(stt?: STTOutput): ProviderResolver {
  return {
    getChatProvider: () => createMockChatProvider("capture-chat"),
    getProactiveDecisionProvider: () => createMockProactiveDecisionProvider("REQUEST_TEXT"),
    getAssistantContinuationProvider: () =>
      createMockAssistantContinuationProvider("proactive hello"),
    getReasoningProvider: () => createMockReasoningProvider("capture-reasoning"),
    getTTSProvider: () => ({
      name: "capture-tts",
      async healthCheck() {
        return {
          provider: "capture-tts",
          status: "healthy" as const,
          checkedAt: new Date().toISOString()
        };
      },
      async synthesizeSpeech() {
        throw new Error("TTS must not run");
      }
    }),
    getSTTProvider: () =>
      stt
        ? {
            name: "capture-stt",
            async healthCheck() {
              return {
                provider: "capture-stt",
                status: "healthy" as const,
                checkedAt: new Date().toISOString()
              };
            },
            async transcribeAudio() {
              return stt;
            }
          }
        : createMockSTTProvider("capture-stt"),
    getVisionProvider: () => createMockVisionProvider("capture-vision"),
    getEmbeddingProvider: () => ({
      name: "capture-embedding",
      dimensions: 3,
      async healthCheck() {
        return {
          provider: "capture-embedding",
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

function characterPort(): RuntimeCharacterPort {
  const result: RuntimeCharacterTurnResult = {
    decision: {
      addressing: "DIRECTED_TO_YUVI",
      reply: { disposition: "RESPOND", text: "好" },
      proactive: { action: "KEEP" }
    },
    providerMetadata: { model: "capture-character" }
  };
  return {
    async generate() {
      return result;
    },
    async generateAfterCognition() {
      throw new Error("cognition must not run");
    }
  };
}

function createRuntime(stt?: STTOutput): RuntimeOrchestrator {
  return new RuntimeOrchestrator({
    eventBus: new InMemoryEventBus({ development: false }),
    memory: memoryStub(),
    promptBuilder: new PromptBuilder(),
    conversation: new InMemoryConversationRepository(),
    providers: providers(stt),
    character: characterPort()
  });
}

async function collect(stream: AsyncIterable<{ type: string }>): Promise<Array<{ type: string }>> {
  const events: Array<{ type: string }> = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("Runtime finalized capture lifecycle", () => {
  it("keeps explicit PTT as an admitted interaction after a fenced observation", async () => {
    const runtime = createRuntime();
    const observation = runtime.admitFinalizedSpeechObservation(
      {
        text: "几点了",
        language: "zh",
        observationId: "obs-ptt",
        segments: [{ segmentId: "seg-ptt", text: "几点了", speakerClusterId: "0" }]
      },
      { sessionId: "voice", captureEpoch: "epoch-ptt" }
    );
    const reply = await runtime.handleUserMessage(
      createEvent("user.voice.transcript", {
        sessionId: "voice",
        content: observation.text,
        language: observation.language
      }),
      { controlAuthority: "LOCAL_EXPLICIT_CONTROLLER", readMemory: false, writeMemory: false }
    );
    expect(reply?.payload.content).toBe("好");
  });

  it("does not turn a finalized observation into a UserMessage", async () => {
    const eventBus = new InMemoryEventBus({ development: false });
    const published: RuntimeEvent[] = [];
    eventBus.subscribe("*", (event) => {
      published.push(event);
    });
    const runtime = new RuntimeOrchestrator({
      eventBus,
      memory: memoryStub(),
      promptBuilder: new PromptBuilder(),
      conversation: new InMemoryConversationRepository(),
      providers: providers({
        text: "ambient",
        observationId: "obs-ambient",
        segments: [{ segmentId: "seg-ambient", text: "ambient", speakerClusterId: "1" }]
      })
    });
    const observation = await runtime.transcribeSpeechAudio({
      sessionId: "obs",
      audioBase64: "AQID",
      captureEpoch: "epoch-ambient"
    });
    expect(observation.text).toBe("ambient");
    expect(observation.captureEpoch).toBe("epoch-ambient");
    expect(published.some((event) => event.type === "user.message")).toBe(false);
    expect(published.some((event) => event.type === "user.voice.transcript")).toBe(false);
  });

  it("advances activityRevision on accepted capture without clearing suppression", async () => {
    const engaged = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: memoryStub(),
      promptBuilder: new PromptBuilder(),
      conversation: new InMemoryConversationRepository(),
      providers: providers(),
      character: {
        async generate() {
          return {
            decision: {
              addressing: "DIRECTED_TO_YUVI" as const,
              reply: { disposition: "RESPOND" as const, text: "好" },
              proactive: {
                action: "SUPPRESS" as const,
                scope: { kind: "UNTIL_ENGAGEMENT" as const }
              }
            },
            providerMetadata: { model: "capture-character" }
          };
        },
        async generateAfterCognition() {
          throw new Error("cognition must not run");
        }
      }
    });
    await engaged.handleUserMessage(
      { sessionId: "eng", content: "安静直到我再找你" },
      { controlAuthority: "LOCAL_EXPLICIT_CONTROLLER", readMemory: false, writeMemory: false }
    );
    expect(engaged.getProactiveState().suppression).toEqual({ kind: "UNTIL_ENGAGEMENT" });
    const revision = engaged.getProactiveState().activityRevision;
    engaged.admitFinalizedSpeechObservation(
      {
        text: "tv noise",
        segments: [{ segmentId: "seg-tv", text: "tv noise", speakerClusterId: "unk" }]
      },
      { sessionId: "eng", captureEpoch: "epoch-tv" }
    );
    expect(engaged.getProactiveState().activityRevision).toBe(revision + 1);
    expect(engaged.getProactiveState().suppression).toEqual({ kind: "UNTIL_ENGAGEMENT" });
  });

  it("does not treat speech capture as explicit resume", async () => {
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: memoryStub(),
      promptBuilder: new PromptBuilder(),
      conversation: new InMemoryConversationRepository(),
      providers: providers(),
      character: {
        async generate() {
          return {
            decision: {
              addressing: "DIRECTED_TO_YUVI" as const,
              reply: { disposition: "RESPOND" as const, text: "好" },
              proactive: {
                action: "SUPPRESS" as const,
                scope: { kind: "UNTIL_EXPLICIT_RESUME" as const }
              }
            },
            providerMetadata: { model: "capture-character" }
          };
        },
        async generateAfterCognition() {
          throw new Error("cognition must not run");
        }
      }
    });
    await runtime.handleUserMessage(
      { sessionId: "r", content: "别再主动说话" },
      { controlAuthority: "LOCAL_EXPLICIT_CONTROLLER", readMemory: false, writeMemory: false }
    );
    runtime.admitFinalizedSpeechObservation(
      { text: "noise", segments: [{ segmentId: "seg-r", text: "noise" }] },
      { sessionId: "r", captureEpoch: "epoch-r" }
    );
    expect(runtime.getProactiveState().suppression).toEqual({ kind: "UNTIL_EXPLICIT_RESUME" });
  });

  it("stales an in-flight proactive attempt when a newer capture advances revision", async () => {
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
        idempotencyKey: "stale-capture",
        readMemory: false
      })
    );
    await continuationBegan;
    runtime.admitFinalizedSpeechObservation(
      { text: "new capture", segments: [{ segmentId: "seg-new", text: "new capture" }] },
      { sessionId: "s", captureEpoch: "epoch-new" }
    );
    expect(runtime.getProactiveState().activityRevision).toBe(startedRevision + 1);
    release();
    await expect(pending).rejects.toMatchObject({
      name: "ProactiveAdmissionError",
      reason: "stale-revision"
    });
    expect(ProactiveAdmissionError).toBeDefined();
  });

  it("keeps speaker clusters unresolved after fencing", () => {
    const runtime = createRuntime();
    const observation = runtime.admitFinalizedSpeechObservation(
      {
        text: "two speakers",
        segments: [
          { segmentId: "seg-0", text: "a", speakerClusterId: "0" },
          { segmentId: "seg-1", text: "b", speakerClusterId: "1" }
        ]
      },
      { sessionId: "s", captureEpoch: "epoch-diar" }
    );
    expect(observation.segments?.map((segment) => segment.speakerClusterId)).toEqual(["0", "1"]);
    expect(JSON.stringify(observation)).not.toMatch(/personId|voiceProfileId/);
  });

  it("throws on a duplicate Runtime claim of the same epoch and segment", () => {
    const runtime = createRuntime();
    const first = {
      text: "hello",
      segments: [{ segmentId: "seg-dup", text: "hello" }]
    };
    runtime.admitFinalizedSpeechObservation(first, { sessionId: "s", captureEpoch: "epoch-dup" });
    expect(() =>
      runtime.admitFinalizedSpeechObservation(first, { sessionId: "s", captureEpoch: "epoch-dup" })
    ).toThrow(SpeechCaptureFenceError);
  });
});
