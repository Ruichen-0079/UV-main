import { describe, expect, it, vi } from "vitest";
import { MemoryService } from "./service.js";
import { InMemoryMemoryRepository } from "./repository.js";
import type { MemoryBackend } from "./backend.js";
import { detectExplicitForgetRequest, detectExplicitRememberRequest } from "./intent.js";

function createMockBackend(overrides: Partial<MemoryBackend> = {}): MemoryBackend {
  return {
    kind: "mem0",
    health: async () => ({ status: "healthy", backend: "mem0" }),
    add: vi.fn(async () => ({ memoryId: "m1", operation: "created" as const })),
    search: vi.fn(async () => [
      {
        id: "m1",
        content: "User prefers short replies",
        scope: "s",
        metadata: { secret: "nope" },
        score: 0.91
      }
    ]),
    get: async () => null,
    list: async () => ({ items: [] }),
    update: async () => ({
      id: "m1",
      content: "x",
      scope: "s",
      metadata: {}
    }),
    delete: vi.fn(async () => undefined),
    history: async () => [],
    ...overrides
  };
}

describe("MemoryService mem0 mode", () => {
  it("searches mem0 and maps prompt-safe memories", async () => {
    const backend = createMockBackend();
    const service = new MemoryService(
      new InMemoryMemoryRepository(),
      undefined,
      undefined,
      undefined,
      { enabled: false },
      { kind: "mem0", mem0: backend, searchTimeoutMs: 600 }
    );
    expect(service.isMem0Backend()).toBe(true);
    const result = await service.retrieveRelevantMemoriesWithMetadata({
      text: "reply style",
      subjectUserId: "user-a",
      personaId: "alice",
      limit: 8
    });
    expect(backend.search).toHaveBeenCalledOnce();
    expect(result.count).toBe(1);
    expect(result.memories[0]?.displayText).toBe("User prefers short replies");
    expect(result.memories[0]?.displayText).not.toContain("secret");
    expect(result.selectedMemories[0]?.metadata).toEqual({});
  });

  it("does not search when identity is incomplete", async () => {
    const backend = createMockBackend();
    const service = new MemoryService(
      new InMemoryMemoryRepository(),
      undefined,
      undefined,
      undefined,
      { enabled: false },
      { kind: "mem0", mem0: backend }
    );
    const result = await service.retrieveRelevantMemoriesWithMetadata({
      text: "reply style",
      subjectUserId: "user-a"
    });
    expect(backend.search).not.toHaveBeenCalled();
    expect(result.fallbackReason).toBe("MEMORY_SCOPE_MISSING");
  });

  it("does not run legacy extraction or processCandidate storage in mem0 mode", async () => {
    const backend = createMockBackend();
    const service = new MemoryService(
      new InMemoryMemoryRepository(),
      undefined,
      undefined,
      undefined,
      { enabled: false },
      { kind: "mem0", mem0: backend }
    );
    const candidates = await service.extractCandidates({
      userMessage: "I like tea",
      assistantMessage: "Noted"
    });
    expect(candidates).toEqual([]);
    const processed = await service.processCandidateForStorage({
      type: "semantic",
      content: "tea",
      importance: 0.9,
      confidence: 0.9,
      reason: "test",
      tags: []
    });
    expect(processed.decision).toBe("rejected");
    expect(processed.rejectedReason).toContain("mem0");
  });

  it("writes conversation turns with infer=true once", async () => {
    const backend = createMockBackend();
    const service = new MemoryService(
      new InMemoryMemoryRepository(),
      undefined,
      undefined,
      undefined,
      { enabled: false },
      { kind: "mem0", mem0: backend, writeTimeoutMs: 5000 }
    );
    const result = await service.storeConversationTurn({
      userMessage: "I usually drink coffee in the morning.",
      assistantMessage: "Got it.",
      subjectUserId: "user-a",
      personaId: "alice",
      sessionId: "conv-1",
      traceId: "t1"
    });
    expect(result.ok).toBe(true);
    expect(backend.add).toHaveBeenCalledOnce();
    const call = vi.mocked(backend.add).mock.calls[0]![0];
    expect(call.infer).toBe(true);
    expect(call.messages?.length).toBe(2);
    expect(call.metadata?.userId).toBe("user-a");
    expect(call.metadata?.characterId).toBe("alice");
    expect(call.metadata?.schemaVersion).toBe(1);
  });

  it("writes explicit remember with infer=false", async () => {
    expect(detectExplicitRememberRequest("请记住：我喜欢蓝色")).toBe(true);
    const backend = createMockBackend();
    const service = new MemoryService(
      new InMemoryMemoryRepository(),
      undefined,
      undefined,
      undefined,
      { enabled: false },
      { kind: "mem0", mem0: backend }
    );
    const result = await service.storeConversationTurn({
      userMessage: "请记住：我喜欢蓝色",
      assistantMessage: "好的，记住了。",
      subjectUserId: "u",
      personaId: "p"
    });
    expect(result.ok).toBe(true);
    const call = vi.mocked(backend.add).mock.calls[0]![0];
    expect(call.infer).toBe(false);
    expect(call.content).toContain("蓝色");
    expect(call.metadata?.explicit).toBe(true);
    expect(call.metadata?.memoryType).toBe("explicit");
  });

  it("forgets only within scope", async () => {
    expect(detectExplicitForgetRequest("忘记我喜欢红色")).toBe(true);
    const backend = createMockBackend({
      search: vi.fn(async () => [
        {
          id: "red-1",
          content: "我喜欢红色",
          scope: "s",
          metadata: {},
          score: 0.95
        },
        {
          id: "unrelated",
          content: "平时更喜欢简短回复",
          scope: "s",
          metadata: {},
          score: 0.5
        }
      ]),
      delete: vi.fn(async () => undefined)
    });
    const service = new MemoryService(
      new InMemoryMemoryRepository(),
      undefined,
      undefined,
      undefined,
      { enabled: false },
      { kind: "mem0", mem0: backend }
    );
    const result = await service.forgetExplicitMemory({
      userMessage: "忘记我喜欢红色",
      subjectUserId: "u",
      personaId: "p"
    });
    expect(result.deleted).toBe(1);
    expect(result.memoryIds).toEqual(["red-1"]);
    expect(result.notFound).toBe(false);
    expect(backend.delete).toHaveBeenCalledOnce();
  });

  it("search timeout/offline degrades to empty without throw", async () => {
    const backend = createMockBackend({
      search: vi.fn(async () => {
        throw new Error("Sidecar offline");
      })
    });
    const service = new MemoryService(
      new InMemoryMemoryRepository(),
      undefined,
      undefined,
      undefined,
      { enabled: false },
      { kind: "mem0", mem0: backend }
    );
    const result = await service.retrieveRelevantMemoriesWithMetadata({
      text: "hello",
      subjectUserId: "u",
      personaId: "p"
    });
    expect(result.count).toBe(0);
    expect(result.fallbackUsed).toBe(true);
  });
});
