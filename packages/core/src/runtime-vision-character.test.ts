import { InMemoryEventBus } from "@companion/event-bus";
import { InMemoryConversationRepository, type Memory } from "@companion/memory";
import { PromptBuilder } from "@companion/prompt-builder";
import type { AgentReplyEvent } from "@companion/protocol";
import {
  ProviderError,
  ProviderErrorCode,
  createMockChatProvider,
  type VisionOutput
} from "@companion/providers";
import { describe, expect, it, vi } from "vitest";
import {
  normalizeRuntimeVisionEvidence,
  RuntimeOrchestrator
} from "./index.js";
import type {
  HandleImageTurnInput,
  RuntimeCharacterPort,
  RuntimeMemoryPort,
  RuntimeVisionEvidence
} from "./index.js";

function createRecordingMemory(): RuntimeMemoryPort & {
  stores: unknown[];
  interactions: unknown[];
} {
  const stores: unknown[] = [];
  const interactions: unknown[] = [];
  return {
    stores,
    interactions,
    async retrieveRelevantMemories() {
      return [];
    },
    scoreImportance() {
      return 0;
    },
    async extractCandidates() {
      return [];
    },
    async rememberCandidate(candidate): Promise<Memory> {
      return {
        id: "memory-id",
        type: candidate.type,
        content: candidate.content,
        summary: null,
        importance: 0,
        tags: [],
        reason: "test",
        source: "test",
        status: "active",
        createdAt: new Date().toISOString()
      } as unknown as Memory;
    },
    async rememberInteraction(input) {
      interactions.push(input);
      return null;
    },
    async storeConversationTurn(input) {
      stores.push(input);
      return {
        status: "complete",
        ok: true,
        attemptedCount: 1,
        writtenCount: 1,
        rejectedCount: 0,
        deduplicatedCount: 0,
        skippedCount: 0
      };
    }
  };
}

function visionResult(overrides: Partial<VisionOutput> = {}): VisionOutput {
  return {
    text: "A cat sitting on a windowsill.",
    objects: ["cat", "window"],
    sceneSummary: "A calm indoor scene with a cat by the window.",
    confidence: 0.9,
    model: "mock",
    latencyMs: 0,
    ...overrides
  };
}

function createHarness(input: {
  visionImpl?: (visionInput: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>;
  characterImpl?: RuntimeCharacterPort["generate"];
  withPresentation?: boolean;
}) {
  const eventBus = new InMemoryEventBus({ development: false });
  const published: { type: string; event: unknown }[] = [];
  const innerPublish = eventBus.publish.bind(eventBus);
  eventBus.publish = (async (event: never) => {
    published.push({ type: (event as { type: string }).type, event });
    return innerPublish(event as never);
  }) as typeof eventBus.publish;

  const memory = createRecordingMemory();
  const visionCalls: unknown[] = [];
  const visionProvider = {
    name: "test-vision",
    async healthCheck() {
      return {
        provider: "test-vision",
        status: "healthy" as const,
        checkedAt: new Date().toISOString()
      };
    },
    async analyzeImage(visionInput: unknown, options?: { signal?: AbortSignal }) {
      visionCalls.push({ visionInput, signal: options?.signal });
      if (input.visionImpl) {
        return input.visionImpl(visionInput, options) as Promise<VisionOutput>;
      }
      return visionResult();
    }
  };

  const characterCalls: { vision: RuntimeVisionEvidence | undefined; userMessage: string }[] = [];
  const character: RuntimeCharacterPort = {
    async generate(generateInput) {
      characterCalls.push({
        vision: generateInput.vision ? { ...generateInput.vision } : undefined,
        userMessage: generateInput.userMessage
      });
      if (input.characterImpl) {
        return input.characterImpl(generateInput);
      }
      return {
        content: "I see a cat by the window.",
        providerMetadata: { model: "mock-chat" }
      };
    }
  };

  const presentationCalls: AgentReplyEvent[] = [];
  const runtime = new RuntimeOrchestrator({
    eventBus,
    memory,
    promptBuilder: new PromptBuilder(),
    providers: {
      getChatProvider: () => createMockChatProvider("mock-chat"),
      getTTSProvider: () => {
        throw new Error("tts must not be used by image turn");
      },
      getSTTProvider: () => {
        throw new Error("stt must not be used by image turn");
      },
      getVisionProvider: () => visionProvider,
      getEmbeddingProvider: () => {
        throw new Error("embedding must not be used by image turn");
      }
    } as never,
    conversation: new InMemoryConversationRepository(),
    character,
    ...(input.withPresentation
      ? {
          embodiedPresentation: {
            propose: (reply: AgentReplyEvent) => {
              presentationCalls.push(reply);
              return null;
            },
            present: () => {
              throw new Error("present must not be called when propose returns null");
            }
          }
        }
      : {})
  });

  return { runtime, eventBus, published, memory, visionCalls, characterCalls, presentationCalls };
}

function imageInput(overrides: Partial<HandleImageTurnInput> = {}): HandleImageTurnInput {
  return {
    sessionId: "session-image-1",
    traceId: "trace-image-1",
    imageBase64: "AQID",
    mimeType: "image/png",
    ...overrides
  };
}

describe("Vision image -> Character (Runtime-owned)", () => {
  it("normalizes vision output and hands bounded evidence to Character", async () => {
    const { runtime, characterCalls } = createHarness({});
    const result = await runtime.handleImageTurn(imageInput());

    expect(result.vision.type).toBe("perception.vision");
    expect(result.vision.traceId).toBe("trace-image-1");
    expect(result.vision.payload.sessionId).toBe("session-image-1");
    expect(result.reply.traceId).toBe("trace-image-1");
    expect(result.reply.payload.sessionId).toBe("session-image-1");
    expect(result.assistantMessage.payload.sessionId).toBe("session-image-1");
    expect(result.reply.payload.content).toBe("I see a cat by the window.");

    expect(characterCalls).toHaveLength(1);
    const evidence = characterCalls[0]?.vision;
    expect(evidence).toBeDefined();
    expect(evidence?.text).toBe("A cat sitting on a windowsill.");
    expect([...(evidence?.objects ?? [])]).toEqual(["cat", "window"]);
    expect(evidence?.sceneSummary).toBe("A calm indoor scene with a cat by the window.");
    expect(evidence?.confidence).toBe(0.9);
    expect(evidence?.status).toBe("AVAILABLE");
    expect(evidence?.lowConfidence).toBe(false);
    // Stable contract: no provider wire details.
    expect(evidence ? Object.keys(evidence).sort() : []).toEqual(
      ["confidence", "lowConfidence", "objects", "sceneSummary", "status", "text"].sort()
    );
    expect(JSON.stringify(evidence)).not.toContain("test-vision");
    expect(JSON.stringify(evidence)).not.toContain("mock");
  });

  it("supports Character SILENCE as an empty bounded decision", async () => {
    const { runtime } = createHarness({
      characterImpl: async () => ({ content: "", providerMetadata: { model: "mock-chat" } })
    });
    const result = await runtime.handleImageTurn(imageInput({ traceId: "trace-silence" }));
    expect(result.reply.payload.content).toBe("");
    expect(result.assistantMessage.payload.content).toBe("");
    expect(result.reply.traceId).toBe("trace-silence");
  });

  it("routes Character NEED_COGNITION through the existing bounded cognition callback", async () => {
    const executeCognition = vi.fn(async () => ({
      version: "character-cognition-result.v1",
      status: "SUCCESS",
      answer: "The normalized answer."
    }));
    const { runtime } = createHarness({
      characterImpl: async (generateInput) => {
        const roundTrip = await generateInput.executeCognition(
          { kind: "NEED_COGNITION" },
          `image problem: ${generateInput.userMessage}`
        );
        expect(roundTrip).toMatchObject({ status: "SUCCESS" });
        return { content: "After cognition: a cat.", providerMetadata: { model: "mock-chat" } };
      }
    });
    // Wire the bounded cognition executor the same way production does.
    (runtime as unknown as { options: { characterCognition: unknown } }).options.characterCognition =
      executeCognition;
    const result = await runtime.handleImageTurn(imageInput({ traceId: "trace-cognition" }));
    expect(result.reply.payload.content).toBe("After cognition: a cat.");
    expect(executeCognition).toHaveBeenCalledTimes(1);
  });

  it("represents empty observations without manufacturing facts", async () => {
    const { runtime, characterCalls } = createHarness({
      visionImpl: async () => ({ text: "   ", objects: [], model: "mock" })
    });
    const result = await runtime.handleImageTurn(imageInput({ traceId: "trace-empty" }));
    const evidence = characterCalls[0]?.vision;
    expect(evidence?.text).toBe("");
    expect(evidence?.objects).toEqual([]);
    expect(evidence?.sceneSummary).toBeUndefined();
    expect(evidence?.status).toBe("EMPTY");
    expect(evidence?.lowConfidence).toBe(false);
    expect(result.vision.payload.text).toBe("");
  });

  it("marks low-confidence evidence with a bounded representation", async () => {
    const { runtime, characterCalls } = createHarness({
      visionImpl: async () =>
        visionResult({ text: "maybe a cat", objects: [], confidence: 0.1 })
    });
    await runtime.handleImageTurn(imageInput({ traceId: "trace-low" }));
    const evidence = characterCalls[0]?.vision;
    expect(evidence?.status).toBe("LOW_CONFIDENCE");
    expect(evidence?.lowConfidence).toBe(true);
    expect(evidence?.confidence).toBe(0.1);
    expect(evidence?.text).toBe("maybe a cat");
  });

  it("preserves a useful sceneSummary for Character", async () => {
    const { runtime, characterCalls } = createHarness({
      visionImpl: async () =>
        visionResult({
          text: "",
          objects: [],
          sceneSummary: "Sunlit kitchen with two people talking.",
          confidence: 0.8
        })
    });
    await runtime.handleImageTurn(imageInput({ traceId: "trace-scene" }));
    const evidence = characterCalls[0]?.vision;
    expect(evidence?.sceneSummary).toBe("Sunlit kitchen with two people talking.");
    expect(evidence?.status).toBe("AVAILABLE");
  });

  it("fails safe on malformed provider results without inventing content", async () => {
    const { runtime, characterCalls } = createHarness({
      visionImpl: async () =>
        ({
          text: 123,
          objects: "not-an-array",
          sceneSummary: { raw: "wire" },
          confidence: "high",
          provider: "test-vision",
          rawResponse: { http: "payload" }
        }) as unknown as VisionOutput
    });
    const result = await runtime.handleImageTurn(imageInput({ traceId: "trace-malformed" }));
    const evidence = characterCalls[0]?.vision;
    expect(evidence?.text).toBe("");
    expect(evidence?.objects).toEqual([]);
    expect(evidence?.sceneSummary).toBeUndefined();
    expect(evidence?.confidence).toBeUndefined();
    expect(evidence?.status).toBe("UNAVAILABLE");
    expect(evidence?.lowConfidence).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain("rawResponse");
    expect(JSON.stringify(evidence)).not.toContain("http");
    expect(result.reply.traceId).toBe("trace-malformed");
  });

  it("aborts before the vision call when the caller already cancelled", async () => {
    const visionImpl = vi.fn(async () => visionResult());
    const characterImpl = vi.fn(async () => ({
      content: "must not run",
      providerMetadata: { model: "mock-chat" }
    }));
    const { runtime } = createHarness({ visionImpl, characterImpl });
    const controller = new AbortController();
    controller.abort();
    await expect(
      runtime.handleImageTurn(imageInput({ traceId: "trace-aborted" }), {
        signal: controller.signal
      })
    ).rejects.toMatchObject({ code: ProviderErrorCode.Cancelled });
    expect(visionImpl).not.toHaveBeenCalled();
    expect(characterImpl).not.toHaveBeenCalled();
  });

  it("discards a stale vision result when cancellation wins before Character", async () => {
    let releaseVision!: (value: VisionOutput) => void;
    const pending = new Promise<VisionOutput>((resolve) => {
      releaseVision = resolve;
    });
    const characterImpl = vi.fn(async () => ({
      content: "stale must not publish",
      providerMetadata: { model: "mock-chat" }
    }));
    const { runtime, published } = createHarness({
      visionImpl: async () => pending,
      characterImpl
    });
    const controller = new AbortController();
    const turn = runtime.handleImageTurn(imageInput({ traceId: "trace-stale" }), {
      signal: controller.signal
    });
    controller.abort();
    releaseVision(visionResult({ text: "late scene" }));
    await expect(turn).rejects.toMatchObject({ code: ProviderErrorCode.Cancelled });
    expect(characterImpl).not.toHaveBeenCalled();
    // Stale late scene must not reach Character or the user-visible reply stream.
    expect(published.filter((item) => item.type === "agent.reply")).toHaveLength(0);
    expect(published.filter((item) => item.type === "assistant.message")).toHaveLength(0);
  });

  it("surfaces provider failure without invoking Character", async () => {
    const failure = new ProviderError({
      provider: "test-vision",
      capability: "vision",
      code: ProviderErrorCode.ProviderUnavailable,
      message: "vision down",
      retryable: false
    });
    const characterImpl = vi.fn(async () => ({
      content: "must not run",
      providerMetadata: { model: "mock-chat" }
    }));
    const { runtime, published } = createHarness({
      visionImpl: async () => {
        throw failure;
      },
      characterImpl
    });
    await expect(
      runtime.handleImageTurn(imageInput({ traceId: "trace-failure" }))
    ).rejects.toBe(failure);
    expect(characterImpl).not.toHaveBeenCalled();
    expect(published.some((item) => item.type === "provider.error")).toBe(true);
  });

  it("preserves Runtime trace/session ownership across the full chain", async () => {
    const { runtime } = createHarness({});
    const result = await runtime.handleImageTurn(
      imageInput({ sessionId: "session-owned", traceId: "trace-owned", parentId: "parent-1" })
    );
    expect(result.vision.traceId).toBe("trace-owned");
    expect(result.vision.parentId).toBe("parent-1");
    expect(result.evidence).toBeDefined();
    expect(result.reply.traceId).toBe("trace-owned");
    expect(result.reply.parentId).toBe(result.vision.id);
    expect(result.assistantMessage.traceId).toBe("trace-owned");
    expect(result.assistantMessage.parentId).toBe(result.reply.id);
    expect(result.vision.payload.sessionId).toBe("session-owned");
    expect(result.reply.payload.sessionId).toBe("session-owned");
  });

  it("keeps Presentation behind the Character decision and writes no durable Memory truth", async () => {
    const { runtime, memory, published, presentationCalls } = createHarness({
      withPresentation: true
    });
    const result = await runtime.handleImageTurn(imageInput({ traceId: "trace-authority" }));
    // Presentation only sees the Character reply, never raw vision/provider output.
    expect(presentationCalls).toHaveLength(1);
    expect(presentationCalls[0]?.id).toBe(result.reply.id);
    for (const call of presentationCalls) {
      expect(JSON.stringify(call)).not.toContain("windowsill");
    }
    // No direct provider -> Presentation path.
    expect(published.filter((item) => item.type === "perception.vision")).toHaveLength(1);
    expect(
      published.filter((item) => item.type === "runtime.embodied.presentation.request").length
    ).toBeLessThanOrEqual(1);
    // Vision evidence is transient: no durable Memory truth is written by the image turn.
    expect(memory.stores).toHaveLength(0);
    expect(memory.interactions).toHaveLength(0);
  });

  it("bounds raw normalization without provider leakage", async () => {
    const evidence = normalizeRuntimeVisionEvidence({
      text: `  ${"x".repeat(5000)}  `,
      objects: ["  cat  ", "", 123, "y".repeat(500)],
      sceneSummary: `  ${"s".repeat(5000)}  `,
      confidence: 0.95,
      provider: "must-not-leak",
      rawResponse: { status: 200 }
    });
    expect(evidence.text).toHaveLength(2000);
    expect(evidence.objects).toHaveLength(2);
    expect(evidence.objects[0]).toBe("cat");
    expect(evidence.objects[1]?.length).toBeLessThanOrEqual(100);
    expect(evidence.sceneSummary?.length).toBeLessThanOrEqual(2000);
    expect(evidence.status).toBe("AVAILABLE");
    expect(Object.keys(evidence)).not.toContain("provider");
    expect(Object.keys(evidence)).not.toContain("rawResponse");
  });
});
