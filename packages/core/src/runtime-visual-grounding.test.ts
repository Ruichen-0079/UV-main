import { InMemoryEventBus } from "@companion/event-bus";
import { PromptBuilder } from "@companion/prompt-builder";
import type { RuntimeEvent } from "@companion/protocol";
import {
  ProviderErrorCode,
  createMockChatProvider,
  createMockProactiveDecisionProvider,
  createMockReasoningProvider,
  createMockSTTProvider,
  createMockVisionProvider,
  type ProviderResolver,
  type TTSInput
} from "@companion/providers";
import { describe, expect, it, vi } from "vitest";
import {
  RuntimeOrchestrator,
  type RuntimeCharacterPort,
  type RuntimeCharacterTurnResult,
  type RuntimeMemoryPort,
  type RuntimeReplyStreamEvent
} from "./index.js";

function decisionFixture(
  reply: RuntimeCharacterTurnResult["decision"]["reply"]
): RuntimeCharacterTurnResult {
  return Object.freeze({
    decision: {
      addressing: "DIRECTED_TO_YUVI",
      reply,
      proactive: { action: "KEEP" }
    },
    providerMetadata: { model: "character-test-chat-model" },
    // Mirrors the real adapter: a NEED_COGNITION pass hands Runtime the
    // Character-owned escalation request and bounded problem statement.
    ...(reply.disposition === "NEED_COGNITION"
      ? {
          cognitionHandoff: Object.freeze({
            request: Object.freeze({
              version: "character-harness-5g.v1",
              kind: "NEED_COGNITION",
              focus: reply.focus ?? "verification"
            }),
            problem: `Character focus:\n${reply.focus ?? "verification"}`
          })
        }
      : {})
  });
}

function memoryStub() {
  const extractCandidates = vi.fn(async () => []);
  const memory: RuntimeMemoryPort = {
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
    extractCandidates,
    async rememberCandidate() {
      throw new Error("rememberCandidate must not run in this suite");
    },
    async rememberInteraction() {
      return null;
    }
  };
  return { memory, extractCandidates };
}

function providersStub(ttsInputs?: TTSInput[]): ProviderResolver {
  const chat = createMockChatProvider("character-test-chat");
  return {
    getChatProvider: () => chat,
    getProactiveDecisionProvider: () => createMockProactiveDecisionProvider("NO_OP"),
    getReasoningProvider: () => createMockReasoningProvider("character-test-reasoning"),
    getTTSProvider: () => ({
      name: "character-test-tts",
      async healthCheck() {
        return {
          provider: "character-test-tts",
          status: "healthy" as const,
          checkedAt: new Date().toISOString()
        };
      },
      async synthesizeSpeech(input: TTSInput) {
        if (ttsInputs) {
          ttsInputs.push(input);
          return {
            audio: new Uint8Array([1, 2, 3]),
            audioBase64: "AQID",
            mimeType: "audio/wav",
            model: "character-test-tts"
          };
        }
        throw new Error("TTS must not run for this turn");
      }
    }),
    getSTTProvider: () => createMockSTTProvider("character-test-stt"),
    getVisionProvider: () => createMockVisionProvider("character-test-vision"),
    getEmbeddingProvider: () => ({
      name: "character-test-embedding",
      dimensions: 3,
      async healthCheck() {
        return {
          provider: "character-test-embedding",
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

function setup(generate: RuntimeCharacterPort["generate"]) {
  const captureScreen = vi.fn(async (_signal: AbortSignal) => new Uint8Array([1, 2, 3]));
  const analyzeImage = vi.fn(async () => ({ text: "VISIBLE_ERROR " + "x".repeat(5000) }));
  const eventBus = new InMemoryEventBus({ development: false });
  const published: RuntimeEvent[] = [];
  eventBus.subscribe("*", (event) => {
    published.push(event);
  });
  const { memory, extractCandidates } = memoryStub();
  const runtime = new RuntimeOrchestrator({
    eventBus,
    memory,
    promptBuilder: new PromptBuilder(),
    captureScreen,
    providers: {
      ...providersStub(),
      getVisionProvider: () => ({
        name: "vision",
        analyzeImage,
        healthCheck: async () => ({ provider: "vision", status: "healthy", checkedAt: "" })
      })
    },
    character: { generate, generateAfterCognition: generate }
  });
  return { runtime, captureScreen, analyzeImage, extractCandidates, published };
}
const respond = () =>
  decisionFixture({ disposition: "RESPOND", text: "YUVI original-turn answer" });
async function collect(runtime: RuntimeOrchestrator, signal?: AbortSignal) {
  const events: RuntimeReplyStreamEvent[] = [];
  for await (const event of runtime.streamUserMessage(
    { sessionId: "original", content: "What error is on screen?" },
    { signal, writeMemory: true }
  ))
    events.push(event);
  return events;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("on-demand visual grounding in the original Runtime turn", () => {
  it("does no capture or Vision call when unnecessary", async () => {
    const s = setup(async () => respond());
    await collect(s.runtime);
    expect(s.captureScreen).not.toHaveBeenCalled();
    expect(s.analyzeImage).not.toHaveBeenCalled();
  });
  it("captures once, calls routed Vision once, bounds evidence and resumes the same turn without Memory", async () => {
    let evidence: unknown;
    const s = setup(async (input) => {
      expect(input.userMessage).toBe("What error is on screen?");
      evidence = await input.requestVisualEvidence!({ need: "Read the error dialog" });
      return respond();
    });
    const events = await collect(s.runtime);
    expect(s.captureScreen).toHaveBeenCalledTimes(1);
    expect(s.analyzeImage).toHaveBeenCalledTimes(1);
    expect(evidence).toEqual({
      status: "AVAILABLE",
      observations: expect.stringMatching(/^VISIBLE_ERROR/)
    });
    expect(JSON.stringify(evidence).length).toBeLessThan(4100);
    expect(s.analyzeImage.mock.calls[0]).toEqual([
      expect.objectContaining({
        image: new Uint8Array([1, 2, 3]),
        prompt: expect.stringContaining("Read the error dialog")
      }),
      expect.objectContaining({ allowFallback: false })
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      sessionId: "original",
      content: "YUVI original-turn answer"
    });
    expect(s.extractCandidates).not.toHaveBeenCalled();
    expect(JSON.stringify(s.published)).not.toContain("VISIBLE_ERROR");
  });
  it.each(["capture", "provider", "empty"])(
    "returns honest unavailability for %s failure",
    async (failure) => {
      let evidence: unknown;
      const s = setup(async (input) => {
        evidence = await input.requestVisualEvidence!({ need: "Read screen" });
        return respond();
      });
      if (failure === "capture") s.captureScreen.mockRejectedValueOnce(new Error("private path"));
      if (failure === "provider")
        s.analyzeImage.mockRejectedValueOnce(new Error("private provider details"));
      if (failure === "empty") s.analyzeImage.mockResolvedValueOnce({ text: "" });
      await collect(s.runtime);
      expect(evidence).toMatchObject({ status: "UNAVAILABLE" });
      expect(JSON.stringify(evidence)).not.toContain("private");
      expect(s.analyzeImage).toHaveBeenCalledTimes(failure === "capture" ? 0 : 1);
    }
  );
  it("rejects a second semantic request without recapturing", async () => {
    const s = setup(async (input) => {
      await input.requestVisualEvidence!({ need: "Read screen" });
      await input.requestVisualEvidence!({ need: "Again" });
      return respond();
    });
    await expect(collect(s.runtime)).rejects.toThrow("Only one");
    expect(s.captureScreen).toHaveBeenCalledTimes(1);
  });
  it.each(["capture", "provider"])(
    "fences cancellation during %s even if the dependency ignores abort",
    async (stage) => {
      const entered = deferred<void>();
      const release = deferred<void>();
      const controller = new AbortController();
      let resumed = false;
      const s = setup(async (input) => {
        await input.requestVisualEvidence!({ need: "Read screen" });
        resumed = true;
        return respond();
      });
      if (stage === "capture")
        s.captureScreen.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          return new Uint8Array([1]);
        });
      else
        s.analyzeImage.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          return { text: "stale" };
        });
      const pending = collect(s.runtime, controller.signal);
      await entered.promise;
      controller.abort();
      release.resolve();
      await expect(pending).rejects.toMatchObject({ code: ProviderErrorCode.Cancelled });
      expect(resumed).toBe(false);
      if (stage === "capture") expect(s.analyzeImage).not.toHaveBeenCalled();
      expect(s.published.some((event) => event.type === "agent.reply")).toBe(false);
    }
  );
  it("fences old evidence when a newer turn starts", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    let turns = 0;
    const s = setup(async (input) => {
      if (++turns === 1) await input.requestVisualEvidence!({ need: "Read screen" });
      return respond();
    });
    s.analyzeImage.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return { text: "stale" };
    });
    const pending = collect(s.runtime);
    await entered.promise;
    await collect(s.runtime);
    release.resolve();
    await expect(pending).rejects.toMatchObject({ code: ProviderErrorCode.Cancelled });
    expect(s.published.filter((event) => event.type === "agent.reply")).toHaveLength(1);
  });
});

it("times out an abort-ignoring Vision call and resumes honestly", async () => {
  vi.useFakeTimers();
  try {
    const entered = deferred<void>();
    let evidence: unknown;
    const s = setup(async (input) => {
      evidence = await input.requestVisualEvidence!({ need: "Read screen" });
      return respond();
    });
    s.analyzeImage.mockImplementationOnce(async () => {
      entered.resolve();
      return new Promise(() => {});
    });
    const pending = collect(s.runtime);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(45_000);
    await pending;
    expect(evidence).toMatchObject({ status: "UNAVAILABLE" });
    expect(s.captureScreen).toHaveBeenCalledTimes(1);
    expect(s.analyzeImage).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it("keeps non-streaming grounded turns out of automatic Memory too", async () => {
  const s = setup(async (input) => {
    await input.requestVisualEvidence!({ need: "Read screen" });
    return respond();
  });
  const reply = await s.runtime.handleUserMessage(
    { sessionId: "original", content: "Read screen" },
    { writeMemory: true }
  );
  expect(reply?.payload.content).toBe("YUVI original-turn answer");
  expect(s.extractCandidates).not.toHaveBeenCalled();
});
