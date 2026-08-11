import type { MemoryEvent, MemoryRetrievalOutcome } from "@companion/memory";
import { PromptBuilder } from "@companion/prompt-builder";
import { describe, expect, it } from "vitest";
import { MemoryContextBuilder } from "./memory-context.js";

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

describe("MemoryContextBuilder", () => {
  it("converts a canonical event to a PromptBuilder-compatible memory", () => {
    const context = new MemoryContextBuilder().build([event()]);

    expect(context.events).toEqual([event()]);
    expect(context.promptMemories).toEqual([
      {
        content: "User likes tea",
        displayText: "User likes tea",
        provenanceId: "mem0:test",
        source: "mem0",
        sourceRecordId: "test"
      }
    ]);
  });

  it("preserves stable provenance without using rank or array position", () => {
    const context = new MemoryContextBuilder().build([
      event({ id: "mem0:a", sourceRecordId: "a" }),
      event({ id: "mem0:b", sourceRecordId: "b", content: "User likes coffee" })
    ]);

    expect(context.promptMemories.map((memory) => memory.provenanceId)).toEqual([
      "mem0:a",
      "mem0:b"
    ]);
    expect(context.promptMemories.map((memory) => memory.sourceRecordId)).toEqual(["a", "b"]);
    expect(context.promptMemories[0]).not.toHaveProperty("rank");
    expect(context.promptMemories[0]).not.toHaveProperty("promptPosition");
  });

  it("returns an empty context for empty input", () => {
    expect(new MemoryContextBuilder().build([])).toEqual({
      events: [],
      promptMemories: [],
      diagnostics: { selectedCount: 0, droppedCount: 0 }
    });
  });

  it("does not leak authoritative-looking metadata into prompt objects", () => {
    const context = new MemoryContextBuilder().build([
      event({ metadata: { trust: "high", closeness: "high", relationshipState: "close" } })
    ]);
    const promptMemory = context.promptMemories[0];

    expect(promptMemory).not.toHaveProperty("metadata");
    expect(promptMemory).not.toHaveProperty("trust");
    expect(promptMemory).not.toHaveProperty("closeness");
    expect(promptMemory).not.toHaveProperty("relationshipState");
  });

  it("preserves retrieval status for future status-aware wiring", () => {
    const outcome: MemoryRetrievalOutcome = {
      status: "unavailable",
      events: [],
      source: "mem0",
      limited: false,
      errorCode: "OPERATION_TIMEOUT"
    };

    expect(new MemoryContextBuilder().build(outcome)).toEqual({
      events: [],
      promptMemories: [],
      diagnostics: {
        selectedCount: 0,
        droppedCount: 0,
        retrievalStatus: "unavailable",
        retrievalErrorCode: "OPERATION_TIMEOUT",
        providerSource: "mem0",
        rawCount: 0,
        eventCount: 0,
        limited: false,
        eventIds: [],
        metadataPresent: false,
        sourceTurnLinkCount: 0,
        conversationLinked: false,
        participantsCount: 0
      }
    });
  });

  it("preserves empty status without inventing an absence claim", () => {
    const context = new MemoryContextBuilder().build({
      status: "empty",
      events: [],
      source: "mem0",
      limited: false,
      rawCount: 0
    });

    expect(context.promptMemories).toEqual([]);
    expect(context.diagnostics).toMatchObject({
      retrievalStatus: "empty",
      providerSource: "mem0",
      rawCount: 0,
      eventCount: 0
    });
    expect(JSON.stringify(context.diagnostics)).not.toContain("no memory");
  });

  it("drops malformed evidence deterministically and reports why", () => {
    const context = new MemoryContextBuilder().build([
      event({ id: "", content: "missing id" }),
      event({ source: "", content: "missing source" }),
      event({ sourceRecordId: "", content: "missing record id" }),
      event({ content: "   " }),
      event({ id: "mem0:valid", sourceRecordId: "valid", content: "valid" })
    ]);

    expect(context.diagnostics).toEqual({
      selectedCount: 1,
      droppedCount: 4,
      droppedReasons: {
        "missing-id": 1,
        "missing-source": 1,
        "missing-record-id": 1,
        "empty-content": 1
      },
      dropped: [
        { id: "mem0:test", reason: "missing-source" },
        { id: "mem0:test", reason: "missing-record-id", source: "mem0" },
        { id: "mem0:test", reason: "empty-content", source: "mem0" }
      ]
    });
    expect(context.events.map((item) => item.id)).toEqual(["mem0:valid"]);
  });

  it("feeds the existing PromptBuilder without changing its memory wording contract", () => {
    const context = new MemoryContextBuilder().build([event()]);
    const output = new PromptBuilder().buildPrompt({
      systemIdentity: "You are YUVI.",
      retrievedMemories: context.promptMemories,
      userMessage: "What do I like?"
    });
    const relevantMemory = output.sections.find((section) => section.name === "RelevantMemory");

    expect(relevantMemory?.content).toContain("- User likes tea");
    expect(relevantMemory?.content).not.toContain("mem0:");
    expect(relevantMemory?.content).not.toContain("trust");
  });

  it("drops a current-turn exact echo but retains canonical evidence", () => {
    const canonical = event({ id: "mem0:echo", content: "用户喜欢蓝色" });
    const context = new MemoryContextBuilder().build(
      {
        status: "ok",
        events: [canonical],
        source: "mem0",
        limited: false,
        rawCount: 1
      },
      { currentTurnText: "我喜欢蓝色" }
    );

    expect(context.events).toEqual([canonical]);
    expect(context.promptMemories).toEqual([]);
    expect(context.diagnostics.dropped).toEqual([
      { id: "mem0:echo", reason: "current_turn_echo", source: "mem0" }
    ]);
  });

  it("uses conservative containment for current-turn echoes", () => {
    const context = new MemoryContextBuilder().build(
      {
        status: "ok",
        events: [event({ id: "mem0:contain", content: "我喜欢蓝色" })],
        source: "mem0",
        limited: false
      },
      { currentTurnText: "我今天明确说过我喜欢蓝色" }
    );

    expect(context.promptMemories).toEqual([]);
    expect(context.events).toHaveLength(1);
  });

  it("keeps unrelated memories and drops direct-context echoes", () => {
    const context = new MemoryContextBuilder().build(
      {
        status: "ok",
        events: [
          event({ id: "mem0:old", content: "用户去年去了海南" }),
          event({ id: "mem0:direct", content: "我喜欢茶" })
        ],
        source: "mem0",
        limited: false
      },
      { directContextText: "Previous turn\nUser: 我喜欢茶\nAssistant: 好的" }
    );

    expect(context.promptMemories.map((memory) => memory.provenanceId)).toEqual(["mem0:old"]);
    expect(context.diagnostics.dropped).toEqual([
      { id: "mem0:direct", reason: "direct_context_echo", source: "mem0" }
    ]);
  });

  it("drops duplicate memory content by stable event id, not array rank", () => {
    const context = new MemoryContextBuilder().build({
      status: "ok",
      events: [
        event({ id: "mem0:first", content: "User likes tea" }),
        event({ id: "mem0:second", content: "User likes tea" })
      ],
      source: "mem0",
      limited: false
    });

    expect(context.events.map((item) => item.id)).toEqual(["mem0:first", "mem0:second"]);
    expect(context.promptMemories.map((item) => item.provenanceId)).toEqual(["mem0:first"]);
    expect(context.diagnostics.dropped).toEqual([
      { id: "mem0:second", reason: "duplicate_memory", source: "mem0" }
    ]);
  });

  it("preserves partial status while selecting available events", () => {
    const context = new MemoryContextBuilder().build({
      status: "partial",
      events: [event({ id: "mem0:partial" })],
      source: "mem0",
      limited: true,
      limitReason: "provider-partial",
      rawCount: 3,
      errorCode: "PARTIAL_RESULT"
    });

    expect(context.promptMemories).toHaveLength(1);
    expect(context.diagnostics).toMatchObject({
      retrievalStatus: "partial",
      retrievalErrorCode: "PARTIAL_RESULT",
      providerSource: "mem0",
      rawCount: 3,
      eventCount: 1,
      limited: true,
      eventIds: ["mem0:partial"]
    });
  });

  it("does not serialize memory content or secret metadata in diagnostics", () => {
    const context = new MemoryContextBuilder().build({
      status: "ok",
      events: [
        event({
          id: "mem0:secret",
          content: "private fact should not be logged",
          metadata: { apiKey: "sk-secret", DATABASE_URL: "postgres://secret" }
        })
      ],
      source: "mem0",
      limited: false
    });

    const serialized = JSON.stringify(context.diagnostics);
    expect(serialized).not.toContain("private fact");
    expect(serialized).not.toContain("sk-secret");
    expect(serialized).not.toContain("postgres://secret");
    expect(serialized).toContain("mem0:secret");
  });
});
