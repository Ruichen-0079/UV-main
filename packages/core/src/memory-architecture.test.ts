import {
  MemoryIngestionPolicy,
  Mem0MemoryProvider,
  type MemoryBackend,
  type MemoryEvent,
  type Memory,
  type MemoryProvider,
  type MemoryRecord,
  type MemoryRetrievalOutcome,
  type MemorySearchResult
} from "@companion/memory";
import { InMemoryEventBus } from "@companion/event-bus";
import { PromptBuilder } from "@companion/prompt-builder";
import {
  createMockChatProvider,
  createMockReasoningProvider,
  createMockSTTProvider,
  createMockTTSProvider,
  createMockVisionProvider,
  MockEmbeddingProvider
} from "@companion/providers";
import { describe, expect, it, vi } from "vitest";
import { MemoryContextBuilder, RuntimeOrchestrator, type RuntimeMemoryPort } from "./index.js";

const scope = "yuvi:v1:user:user-a:character:alice";

function record(
  overrides: Omit<Partial<MemoryRecord>, "score"> & { score?: number } = {}
): MemorySearchResult {
  return {
    id: "record-1",
    content: "User prefers short replies.",
    scope,
    metadata: {},
    createdAt: "2025-01-02T03:04:05.000Z",
    ...overrides,
    score: overrides.score ?? 0.9
  };
}

function backend(searchResult: MemorySearchResult[] = [record()]): MemoryBackend {
  return {
    kind: "mem0",
    health: vi.fn(async () => ({ status: "healthy", backend: "mem0" })),
    add: vi.fn(async () => ({ memoryId: "written", operation: "created" as const })),
    search: vi.fn(async () => searchResult),
    get: vi.fn(async () => null),
    list: vi.fn(async () => ({ items: [], total: 0 })),
    update: vi.fn(async () => record()),
    delete: vi.fn(async () => undefined),
    history: vi.fn(async () => [])
  } as MemoryBackend;
}

function event(overrides: Partial<MemoryEvent> = {}): MemoryEvent {
  return {
    id: "mem0:test",
    kind: "fact",
    content: "User likes tea",
    source: "mem0",
    sourceRecordId: "test",
    metadata: {},
    ...overrides
  };
}

function outcome(
  status: MemoryRetrievalOutcome["status"],
  events: MemoryEvent[] = [],
  errorCode?: string
): MemoryRetrievalOutcome {
  return {
    status,
    events,
    source: "mem0",
    limited: false,
    ...(errorCode ? { errorCode } : {})
  };
}

function createProviders() {
  return {
    getChatProvider: () => createMockChatProvider("architecture-chat"),
    getReasoningProvider: () => createMockReasoningProvider("architecture-reasoning"),
    getTTSProvider: () => createMockTTSProvider("architecture-tts"),
    getSTTProvider: () => createMockSTTProvider("architecture-stt"),
    getVisionProvider: () => createMockVisionProvider("architecture-vision"),
    getEmbeddingProvider: () => new MockEmbeddingProvider(3)
  };
}

function createMemory(provider: MemoryProvider, legacyMemories: Memory[] = []): RuntimeMemoryPort {
  return {
    getMemoryProvider: () => provider,
    retrieveRelevantMemories: vi.fn(async () => legacyMemories),
    scoreImportance: () => 0,
    rememberInteraction: vi.fn(async () => null)
  };
}

describe("Runtime-ready memory architecture", () => {
  it("maps backend records through Mem0MemoryProvider into prompt compatibility", async () => {
    const provider = new Mem0MemoryProvider(backend());
    const retrieved = await provider.retrieveRelevant({ text: "reply style", scope });
    const context = new MemoryContextBuilder().build(retrieved);
    const prompt = new PromptBuilder().buildPrompt({
      systemIdentity: "You are YUVI.",
      retrievedMemories: context.promptMemories,
      userMessage: "How should you reply?"
    });
    const relevantMemory = prompt.sections.find((section) => section.name === "RelevantMemory");

    expect(retrieved.status).toBe("ok");
    expect(context.events[0]).toMatchObject({
      id: "mem0:record-1",
      source: "mem0",
      sourceRecordId: "record-1",
      recordedAt: "2025-01-02T03:04:05.000Z"
    });
    expect(context.events[0]?.occurredAt).toBeUndefined();
    expect(context.promptMemories).toMatchObject([
      {
        content: "User prefers short replies.",
        displayText: "User prefers short replies.",
        provenanceId: "mem0:record-1",
        source: "mem0",
        sourceRecordId: "record-1"
      }
    ]);
    expect(relevantMemory?.content).toContain("User prefers short replies.");
    expect(relevantMemory?.content).not.toContain("mem0:record-1");
  });

  it("keeps an empty provider outcome empty without claiming database absence", () => {
    const context = new MemoryContextBuilder().build(outcome("empty"));

    expect(context.events).toEqual([]);
    expect(context.promptMemories).toEqual([]);
    expect(context.diagnostics).toMatchObject({
      retrievalStatus: "empty",
      selectedCount: 0,
      droppedCount: 0
    });
    expect(JSON.stringify(context.diagnostics)).not.toContain("no memory");
  });

  it("preserves provider unavailability while reporting a successful legacy fallback", async () => {
    const provider: MemoryProvider = {
      retrieveRelevant: vi.fn(async () => outcome("unavailable", [], "OPERATION_TIMEOUT")),
      getEvent: vi.fn(async () => null),
      writeEvent: vi.fn(async () => ({ status: "rejected" as const }))
    };
    const legacyMemory: Memory = {
      id: "legacy:fallback",
      type: "semantic",
      subtype: "fact",
      scope: "user",
      scopeId: null,
      memoryLayer: "core",
      status: "active",
      content: "Legacy fallback memory",
      summary: null,
      embedding: null,
      embeddingModel: null,
      embeddingProvider: null,
      embeddingDimensions: null,
      embeddedAt: null,
      importance: 0.8,
      emotionValence: 0,
      emotionArousal: 0,
      source: "legacy",
      sourceTraceId: null,
      metadata: {},
      tags: [],
      createdAt: new Date("2025-01-01T00:00:00.000Z"),
      updatedAt: new Date("2025-01-01T00:00:00.000Z"),
      observedAt: new Date("2025-01-01T00:00:00.000Z"),
      eventTime: null,
      validFrom: new Date("2025-01-01T00:00:00.000Z"),
      validUntil: null,
      expiresAt: null,
      lastAccessedAt: new Date("2025-01-01T00:00:00.000Z"),
      supersededAt: null,
      supersedes: [],
      supersededBy: null,
      contradicts: []
    };
    const runtime = new RuntimeOrchestrator({
      eventBus: new InMemoryEventBus({ development: false }),
      memory: createMemory(provider, [legacyMemory]),
      promptBuilder: new PromptBuilder(),
      providers: createProviders()
    });

    await runtime.handleUserMessage(
      { sessionId: "architecture-fallback", content: "Continue without semantic memory." },
      { readMemory: true, writeMemory: false }
    );

    expect(runtime.getLatestPromptPreview()).toMatchObject({
      memoryProviderStatus: "unavailable",
      memoryProviderErrorCode: "OPERATION_TIMEOUT",
      memoryFallbackUsed: true,
      memoryFallbackSource: "legacy",
      memoryFinalStatus: "ok"
    });
  });

  it("retains canonical echo evidence while dropping only its prompt projection", () => {
    const canonical = event({ id: "mem0:echo", content: "用户喜欢蓝色" });
    const context = new MemoryContextBuilder().build(outcome("ok", [canonical]), {
      currentTurnText: "我喜欢蓝色"
    });
    const authoritativeMetadata = new MemoryContextBuilder().build([
      event({
        id: "mem0:metadata",
        metadata: { trust: "high", closeness: "high", relationshipState: "close" }
      })
    ]);

    expect(context.events).toEqual([canonical]);
    expect(context.promptMemories).toEqual([]);
    expect(context.diagnostics.dropped).toEqual([
      { id: "mem0:echo", reason: "current_turn_echo", source: "mem0" }
    ]);
    expect(authoritativeMetadata.promptMemories[0]).not.toHaveProperty("metadata");
    expect(authoritativeMetadata.promptMemories[0]).not.toHaveProperty("trust");
    expect(authoritativeMetadata.promptMemories[0]).not.toHaveProperty("relationshipState");
  });

  it("writes explicit user claims and rejects assistant-only relationship prose", async () => {
    const claim = await new MemoryIngestionPolicy().ingest({
      userMessage: "Please remember I prefer tea.",
      assistantMessage: "Understood.",
      scope,
      userMessageId: "user-turn-1"
    });
    const assistantOnlyExtractor = {
      extractCandidates: vi.fn(async () => [
        {
          type: "relationship" as const,
          content: "I trust you more now.",
          importance: 0.9,
          tags: [],
          reason: "assistant interpretation",
          originRole: "assistant" as const
        }
      ])
    };
    const rejected = await new MemoryIngestionPolicy(
      assistantOnlyExtractor as unknown as ConstructorParameters<typeof MemoryIngestionPolicy>[0]
    ).ingest({
      userMessage: "Tell me a joke.",
      assistantMessage: "I trust you more now.",
      scope
    });

    expect(claim.events).toMatchObject([
      {
        kind: "user_claim",
        scope,
        content: "User claims: I prefer tea.",
        assertion: { source: "user", verification: "unverified" },
        sourceTurnIds: ["user-turn-1"]
      }
    ]);
    expect(rejected.events).toEqual([]);
  });
});
