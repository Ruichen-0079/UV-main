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
        retrievalErrorCode: "OPERATION_TIMEOUT"
      }
    });
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
      }
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
});
