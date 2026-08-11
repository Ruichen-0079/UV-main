import { describe, expect, it } from "vitest";
import type {
  MemoryEvent,
  MemoryProvider,
  MemoryRetrievalOutcome,
  MemoryWriteEventInput
} from "./provider.js";

function event(overrides: Partial<MemoryEvent> = {}): MemoryEvent {
  return {
    id: "opaque-event-1",
    kind: "fact",
    content: "The user prefers short replies.",
    source: "test-provider",
    sourceRecordId: "record-1",
    metadata: {},
    ...overrides
  };
}

describe("canonical memory contracts", () => {
  it("preserves canonical identity independently of retrieval order", () => {
    const first = event({ id: "opaque-a", sourceRecordId: "record-a" });
    const second = event({ id: "opaque-b", sourceRecordId: "record-b" });
    const reordered = [second, first];

    expect(first.id).toBe("opaque-a");
    expect(first.sourceRecordId).toBe("record-a");
    expect(reordered.map((item) => item.id)).toEqual(["opaque-b", "opaque-a"]);
    expect(reordered.map((item) => item.sourceRecordId)).toEqual(["record-b", "record-a"]);
  });

  it("allows timestamps to remain unknown without fabrication", () => {
    const value = event();

    expect(value.observedAt).toBeUndefined();
    expect(value.occurredAt).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(value, "observedAt")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(value, "occurredAt")).toBe(false);
  });

  it("represents a user claim as unverified evidence", () => {
    const value = event({
      kind: "user_claim",
      content: "The user said they have known YUVI for three years.",
      assertion: { source: "user", verification: "unverified" }
    });

    expect(value.kind).toBe("user_claim");
    expect(value.assertion).toEqual({ source: "user", verification: "unverified" });
    expect(value).not.toHaveProperty("trust");
    expect(value).not.toHaveProperty("relationshipState");
  });

  it.each([
    ["ok", [event()]],
    ["empty", []],
    ["unavailable", []],
    ["error", []],
    ["partial", [event()]]
  ] as const)("represents retrieval status %s without changing event identity", (status, events) => {
    const outcome: MemoryRetrievalOutcome = {
      status,
      events: [...events],
      source: "test-provider",
      limited: false
    };

    expect(outcome.status).toBe(status);
    expect(outcome.events).toEqual(events);
    expect(outcome.source).toBe("test-provider");
  });

  it("allows a successful limited result without reclassifying it as partial", () => {
    const outcome: MemoryRetrievalOutcome = {
      status: "ok",
      events: [event()],
      source: "test-provider",
      limited: true,
      limitReason: "provider top-k limit",
      rawCount: 8,
      selectedCount: 1
    };

    expect(outcome.status).toBe("ok");
    expect(outcome.limited).toBe(true);
    expect(outcome.limitReason).toBe("provider top-k limit");
  });

  it("keeps the provider interface vendor-neutral", async () => {
    const write: MemoryWriteEventInput = {
      kind: "episodic",
      content: "A reminder request was accepted.",
      source: "test-provider",
      scope: "scope-a",
      metadata: { schemaVersion: 1 }
    };
    const provider: MemoryProvider = {
      retrieveRelevant: async () => ({
        status: "empty",
        events: [],
        source: "test-provider",
        limited: false
      }),
      getEvent: async () => null,
      writeEvent: async () => ({ status: "rejected", errorCode: "NOT_IMPLEMENTED" })
    };

    expect(await provider.retrieveRelevant({ text: "reminder", scope: "scope-a" })).toMatchObject({
      status: "empty",
      events: []
    });
    expect(await provider.getEvent({ id: "opaque-event-1", scope: "scope-a" })).toBeNull();
    expect(await provider.writeEvent(write)).toEqual({
      status: "rejected",
      errorCode: "NOT_IMPLEMENTED"
    });
  });

  it("does not require authoritative Runtime state fields", () => {
    const value = event({ metadata: { sourceMessageId: "message-1" } });
    const keys = Object.keys(value);

    expect(keys).not.toContain("trust");
    expect(keys).not.toContain("closeness");
    expect(keys).not.toContain("forgiveness");
    expect(keys).not.toContain("currentAffect");
    expect(keys).not.toContain("personaMutation");
    expect(keys).not.toContain("interestScore");
    expect(keys).not.toContain("commitmentStatus");
  });
});
