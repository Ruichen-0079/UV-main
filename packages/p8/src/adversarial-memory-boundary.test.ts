import { describe, expect, it } from "vitest";
import type { MemoryEvent, MemoryRetrievalOutcome } from "@companion/memory";
import {
  DEFAULT_AUTHORED_INVARIANTS,
  createDefaultP8IdentityAddress,
  reconstructP8Projection,
  type P8ReferencedInterpretationCandidate
} from "./index.js";

const ADDRESS = createDefaultP8IdentityAddress("subject-p8-1f-memory-boundary");
const SCOPE = { reference: "scope-p8-1f-memory-boundary" } as const;

function event(overrides: Partial<MemoryEvent> = {}): MemoryEvent {
  return {
    id: "memory-boundary-evidence",
    kind: "fact",
    content: "Memory-authorized evidence.",
    source: "memory-boundary-test",
    sourceRecordId: "opaque-provider-record",
    scope: SCOPE.reference,
    recordedAt: "2026-08-30T00:00:00.000Z",
    metadata: {},
    assertion: { source: "user", verification: "verified" },
    ...overrides
  };
}

function retrieval(memoryEvent: MemoryEvent): MemoryRetrievalOutcome {
  return {
    status: "ok",
    events: [memoryEvent],
    source: "memory-boundary-test",
    limited: false
  };
}

function candidate(evidenceReference: string): P8ReferencedInterpretationCandidate {
  return {
    interpretationReference: "memory-boundary-interpretation",
    candidate: {
      domain: "BACKGROUND",
      meaning: "The authorized semantic meaning.",
      evidenceLinks: [
        {
          evidenceReference,
          relation: "SUPPORTS",
          support: "DIRECT"
        }
      ]
    }
  };
}

function reconstruct(memoryEvent: MemoryEvent) {
  const outcome = reconstructP8Projection({
    address: ADDRESS,
    authoredInvariants: DEFAULT_AUTHORED_INVARIANTS,
    expectedScopeReference: SCOPE,
    longTerm: retrieval(memoryEvent),
    referencedInterpretationCandidates: [candidate(memoryEvent.id)],
    correctionStore: {
      status: "SUCCESS_WITH_NO_CORRECTIONS",
      corrections: []
    }
  });

  if (outcome.status !== "RECONSTRUCTED") {
    throw new Error(`Expected RECONSTRUCTED, got ${outcome.status}.`);
  }
  return outcome.projection;
}

describe("P8-1F Memory ownership closure", () => {
  it("does not turn MemoryEvent kind=correction into P8 explicit correction authority", () => {
    const projection = reconstruct(
      event({
        id: "memory-kind-correction",
        kind: "correction",
        content: "A Memory provider classified this evidence as a correction."
      })
    );

    expect(projection.interpretations[0]).toMatchObject({
      status: "KNOWN",
      support: "DIRECT",
      meaning: "The authorized semantic meaning."
    });
    expect(projection.correctionAudits).toEqual([]);
    expect(projection.correctionProvenance).toEqual([]);
    expect(projection.supersededReferences).toEqual([]);
  });

  it("does not invent a second TTL or staleness policy after Memory authorizes evidence", () => {
    const oldAuthorized = reconstruct(
      event({
        id: "old-authorized-evidence",
        recordedAt: "2000-01-01T00:00:00.000Z"
      })
    );
    const recentAuthorized = reconstruct(
      event({
        id: "recent-authorized-evidence",
        recordedAt: "2026-08-30T00:00:00.000Z"
      })
    );

    expect(oldAuthorized.interpretations[0]).toMatchObject({
      status: "KNOWN",
      support: "DIRECT",
      meaning: "The authorized semantic meaning."
    });
    expect(recentAuthorized.interpretations[0]).toMatchObject({
      status: "KNOWN",
      support: "DIRECT",
      meaning: "The authorized semantic meaning."
    });
    expect({
      status: oldAuthorized.interpretations[0]?.status,
      support: oldAuthorized.interpretations[0]?.support,
      meaning: oldAuthorized.interpretations[0]?.meaning
    }).toEqual({
      status: recentAuthorized.interpretations[0]?.status,
      support: recentAuthorized.interpretations[0]?.support,
      meaning: recentAuthorized.interpretations[0]?.meaning
    });
  });
});
