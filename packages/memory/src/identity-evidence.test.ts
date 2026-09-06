import { describe, expect, it } from "vitest";
import type { MemoryEvent, MemoryRetrievalOutcome } from "@companion/memory";
import { IDENTITY_EVIDENCE_SEAM_VERSION, selectIdentityEvidence } from "./index.js";

const SCOPE = "scope-identity-evidence";

let eventCounter = 0;

function evidenceEvent(overrides: Partial<MemoryEvent> = {}): MemoryEvent {
  eventCounter += 1;
  const id = overrides.id ?? `memory-identity-evidence-${eventCounter}`;
  return {
    id,
    kind: "fact",
    content: "张三今天值班。",
    source: "mem0",
    sourceRecordId: id,
    scope: SCOPE,
    metadata: {},
    ...overrides
  };
}

function retrieval(events: readonly MemoryEvent[]): MemoryRetrievalOutcome {
  return {
    status: events.length > 0 ? "ok" : "empty",
    events: [...events],
    source: "mem0",
    limited: false,
    rawCount: events.length,
    selectedCount: events.length
  };
}

describe("identity evidence read seam", () => {
  it("excludes superseded, retracted, and forgotten evidence before P8 sees it", () => {
    const original = evidenceEvent({ content: "张三现在是我们班班长。" });
    const correction = evidenceEvent({
      content: "现在是李四当班长。",
      metadata: { yuviClaimSupersedes: [original.id] }
    });
    const retracted = evidenceEvent({ metadata: { yuviMemoryStatus: "retracted" } });
    const forgotten = evidenceEvent({ metadata: { yuviMemoryStatus: "forgotten" } });
    const supersededStatus = evidenceEvent({ metadata: { yuviMemoryStatus: "superseded" } });

    const selection = selectIdentityEvidence(
      retrieval([original, correction, retracted, forgotten, supersededStatus]),
      { limit: 10 }
    );
    expect(selection.seamVersion).toBe("memory-identity-evidence.v1");
    expect(selection.status).toBe("ok");
    expect(selection.events.map((event) => event.id)).toEqual([correction.id]);
    expect(selection.excludedIneligibleCount).toBe(4);
    expect(selection.limited).toBe(false);
  });

  it("dedupes by canonical event id and caps at the requested limit", () => {
    const first = evidenceEvent();
    const duplicate = evidenceEvent({ id: first.id, content: "张三今天值班。" });
    const second = evidenceEvent();
    const third = evidenceEvent();

    const selection = selectIdentityEvidence(retrieval([first, duplicate, second, third]), {
      limit: 2
    });
    expect(selection.events.map((event) => event.id)).toEqual([first.id, second.id]);
    expect(selection.excludedIneligibleCount).toBe(0);
    expect(selection.limited).toBe(true);
  });

  it("keeps the retrieval's epistemic status verbatim", () => {
    const unavailable = selectIdentityEvidence(
      { status: "unavailable", events: [], source: "mem0", limited: false },
      { limit: 5 }
    );
    expect(unavailable.status).toBe("unavailable");
    expect(unavailable.events).toEqual([]);

    const failed = selectIdentityEvidence(
      {
        status: "error",
        events: [],
        source: "mem0",
        limited: false,
        errorCode: "MEMORY_BACKEND_ERROR"
      },
      { limit: 5 }
    );
    expect(failed.status).toBe("error");
    expect(failed.errorCode).toBe("MEMORY_BACKEND_ERROR");
  });

  it("keeps eligible correction evidence while excluding what it supersedes", () => {
    const original = evidenceEvent();
    const correction = evidenceEvent({
      metadata: { yuviClaimSupersedes: [original.id] }
    });
    const selection = selectIdentityEvidence(retrieval([original, correction]), { limit: 5 });
    expect(selection.status).toBe("ok");
    expect(selection.events.map((event) => event.id)).toEqual([correction.id]);
    expect(selection.excludedIneligibleCount).toBe(1);
  });

  it("preserves retrieval rank order and never mutates the input events", () => {
    const first = evidenceEvent({ content: "张三今天值班。" });
    const second = evidenceEvent({ content: "李四明天休息。" });
    const snapshot = JSON.stringify([first, second]);
    const selection = selectIdentityEvidence(retrieval([second, first]), { limit: 5 });
    expect(selection.events.map((event) => event.id)).toEqual([second.id, first.id]);
    expect(JSON.stringify([first, second])).toBe(snapshot);
  });

  it("rejects invalid limits", () => {
    expect(() => selectIdentityEvidence(retrieval([]), { limit: 0 })).toThrow();
    expect(() => selectIdentityEvidence(retrieval([]), { limit: 1.5 })).toThrow();
  });
});
