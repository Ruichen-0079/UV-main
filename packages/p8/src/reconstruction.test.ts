import { describe, expect, it } from "vitest";
import type { MemoryEvent, MemoryRetrievalOutcome } from "@companion/memory";
import {
  DEFAULT_AUTHORED_INVARIANTS,
  P8_1E_VERSION,
  P8_RECONSTRUCTION_VERSIONS,
  createDefaultP8IdentityAddress,
  reconstructP8Projection,
  type P8CorrectionStoreLoadResult,
  type P8ExplicitCorrection,
  type P8ReferencedInterpretationCandidate,
  type P8ReconstructionInput,
  type P8ReconstructionOutcome
} from "./index.js";

const ADDRESS = createDefaultP8IdentityAddress("subject-a");
const SCOPE = { reference: "scope-a" } as const;

function memoryEvent(id = "memory-1"): MemoryEvent {
  return {
    id,
    kind: "fact",
    content: "The user supplied the original meaning.",
    source: "test-memory",
    sourceRecordId: "opaque-source-record",
    scope: SCOPE.reference,
    recordedAt: "2026-08-30T00:00:00.000Z",
    metadata: {},
    assertion: { source: "user", verification: "verified" }
  };
}

function retrieval(
  status: MemoryRetrievalOutcome["status"],
  events: MemoryEvent[] = []
): MemoryRetrievalOutcome {
  return { status, events, source: "test-memory", limited: false };
}

function candidate(
  interpretationReference: string,
  meaning?: string
): P8ReferencedInterpretationCandidate {
  return {
    interpretationReference,
    candidate: {
      domain: "BACKGROUND",
      ...(meaning === undefined ? {} : { meaning }),
      ...(meaning === undefined
        ? {}
        : {
            evidenceLinks: [
              {
                evidenceReference: "memory-1",
                relation: "SUPPORTS",
                support: "DIRECT"
              }
            ]
          })
    }
  };
}

function correction(
  overrides: {
    correctionReference?: string;
    interpretationReference?: string;
    action?: "REVISE" | "RETRACT";
    replacementMeaning?: string;
    supersedesCorrectionReference?: string;
    provenanceReference?: string;
    suppliedAt?: string;
  } = {}
): P8ExplicitCorrection {
  const action = overrides.action ?? "REVISE";
  return {
    correctionReference: overrides.correctionReference ?? "correction-a",
    address: ADDRESS,
    scopeReference: SCOPE,
    target: {
      kind: "INTERPRETATION",
      interpretationReference: overrides.interpretationReference ?? "ref-a"
    },
    action,
    ...(action === "REVISE"
      ? { replacementMeaning: overrides.replacementMeaning ?? "Meaning two." }
      : {}),
    provenance: {
      source: "EXPLICIT_USER_CORRECTION",
      reference: overrides.provenanceReference ?? "source-a",
      ...(overrides.suppliedAt === undefined ? {} : { suppliedAt: overrides.suppliedAt })
    },
    ...(overrides.supersedesCorrectionReference === undefined
      ? {}
      : { supersedesCorrectionReference: overrides.supersedesCorrectionReference })
  };
}

function input(
  overrides: {
    longTerm?: MemoryRetrievalOutcome;
    candidates?: readonly P8ReferencedInterpretationCandidate[];
    correctionStore?: P8CorrectionStoreLoadResult;
  } = {}
): P8ReconstructionInput {
  const events = overrides.longTerm?.events ?? [memoryEvent()];
  return {
    address: ADDRESS,
    authoredInvariants: DEFAULT_AUTHORED_INVARIANTS,
    expectedScopeReference: SCOPE,
    longTerm: overrides.longTerm ?? retrieval("ok", events),
    referencedInterpretationCandidates: overrides.candidates ?? [
      candidate("ref-a", "Meaning one.")
    ],
    correctionStore: overrides.correctionStore ?? {
      status: "SUCCESS_WITH_NO_CORRECTIONS",
      corrections: []
    }
  };
}

function reconstructed(outcome: P8ReconstructionOutcome) {
  if (outcome.status !== "RECONSTRUCTED") {
    throw new Error(`Expected reconstructed outcome, got ${outcome.status}.`);
  }
  return outcome;
}

function correctionStore(
  corrections: readonly P8ExplicitCorrection[]
): P8CorrectionStoreLoadResult {
  return { status: "SUCCESS_WITH_CORRECTIONS", corrections };
}

describe("P8-1E versioned reconstruction", () => {
  it("exposes the complete reconstruction version manifest", () => {
    expect(P8_1E_VERSION).toBe("p8-1e.v1");
    expect(P8_RECONSTRUCTION_VERSIONS).toEqual({
      p8ProjectionVersion: "p8-1a.v1",
      p8InterpretationVersion: "p8-1b.v1",
      p8AdapterVersion: "p8-1c.v1",
      p8CorrectionVersion: "p8-1d.v1",
      p8ReconstructionVersion: "p8-1e.v1"
    });
  });

  it("reconstructs the base projection unchanged when correction history is empty", () => {
    const original = input();
    const result = reconstructed(reconstructP8Projection(original));

    expect(result.projection.baseProjectionVersion).toBe("p8-1c.v1");
    expect(result.projection.interpretations[0]).toEqual(
      expect.objectContaining({ meaning: "Meaning one.", status: "KNOWN" })
    );
    expect(result.projection.targetableInterpretations?.[0]?.interpretationReference).toBe("ref-a");
    expect(result.projection.correctionAudits).toEqual([]);
  });

  it("persists the stable reference across fresh reconstruction objects for REVISE", () => {
    const reconstructionInput = input({
      correctionStore: correctionStore([correction({ replacementMeaning: "Meaning two." })])
    });
    const first = reconstructed(reconstructP8Projection(reconstructionInput));
    const second = reconstructed(reconstructP8Projection(reconstructionInput));

    expect(first.projection.interpretations[0]).toMatchObject({
      meaning: "Meaning two.",
      status: "KNOWN"
    });
    expect(first.projection.correctionAudits[0]).toMatchObject({
      previousMeaning: "Meaning one.",
      replacementMeaning: "Meaning two."
    });
    expect(first.projection.targetableInterpretations?.[0]?.interpretationReference).toBe("ref-a");
    expect(first.projection.targetableInterpretations?.[0]?.interpretation).not.toBe(
      second.projection.targetableInterpretations?.[0]?.interpretation
    );
    expect(first).toEqual(second);
  });

  it("persists RETRACT without restoring old meaning or inferring its opposite", () => {
    const result = reconstructed(
      reconstructP8Projection(
        input({ correctionStore: correctionStore([correction({ action: "RETRACT" })]) })
      )
    );

    expect(result.projection.interpretations[0]).toMatchObject({
      status: "UNKNOWN",
      accessStatus: "SUCCESS_WITH_EVIDENCE"
    });
    expect(result.projection.interpretations[0]).not.toHaveProperty("meaning");
    expect(result.projection.correctionAudits[0]).toMatchObject({
      previousMeaning: "Meaning one.",
      currentStatus: "UNKNOWN"
    });
  });

  it("reconstructs explicit lineage deterministically regardless of correction row order", () => {
    const first = correction({
      correctionReference: "correction-a",
      replacementMeaning: "Meaning one correction.",
      provenanceReference: "source-a"
    });
    const second = correction({
      correctionReference: "correction-b",
      replacementMeaning: "Meaning two correction.",
      supersedesCorrectionReference: "correction-a",
      provenanceReference: "source-b"
    });

    const forward = reconstructed(
      reconstructP8Projection(input({ correctionStore: correctionStore([first, second]) }))
    );
    const reversed = reconstructed(
      reconstructP8Projection(input({ correctionStore: correctionStore([second, first]) }))
    );

    expect(forward).toEqual(reversed);
    expect(forward.projection.interpretations[0]?.meaning).toBe("Meaning two correction.");
  });

  it("keeps equal corrections without lineage CONFLICTING after reconstruction", () => {
    const result = reconstructed(
      reconstructP8Projection(
        input({
          correctionStore: correctionStore([
            correction({
              correctionReference: "correction-a",
              replacementMeaning: "Meaning A.",
              provenanceReference: "source-a"
            }),
            correction({
              correctionReference: "correction-b",
              replacementMeaning: "Meaning B.",
              provenanceReference: "source-b"
            })
          ])
        })
      )
    );

    expect(result.projection.interpretations[0]?.status).toBe("CONFLICTING");
    expect(result.projection.correctionAudits).toHaveLength(2);
    expect(
      result.projection.correctionAudits.every((audit) => audit.currentStatus === "CONFLICTING")
    ).toBe(true);
    expect(result.projection.supersededReferences).toEqual([]);
  });

  it("rebinds identical candidate meanings by their explicit references", () => {
    const result = reconstructed(
      reconstructP8Projection(
        input({
          candidates: [
            candidate("ref-a", "Shared meaning."),
            candidate("ref-b", "Shared meaning.")
          ],
          correctionStore: correctionStore([
            correction({
              interpretationReference: "ref-a",
              replacementMeaning: "Only A changed."
            })
          ])
        })
      )
    );

    expect(result.projection.interpretations[0]?.meaning).toBe("Only A changed.");
    expect(result.projection.interpretations[1]?.meaning).toBe("Shared meaning.");
    expect(
      result.projection.targetableInterpretations?.map((item) => item.interpretationReference)
    ).toEqual(["ref-a", "ref-b"]);
  });

  it("fails closed for missing or duplicate referenced candidates", () => {
    expect(() =>
      reconstructP8Projection(
        input({
          correctionStore: correctionStore([correction({ interpretationReference: "ref-missing" })])
        })
      )
    ).toThrow("target interpretation is not present");

    expect(() =>
      reconstructP8Projection(input({ candidates: [candidate("ref-a"), candidate("ref-a")] }))
    ).toThrow("referenced interpretationReference must be unique");
  });

  it("keeps Memory UNAVAILABLE distinct while applying durable correction authority", () => {
    const result = reconstructed(
      reconstructP8Projection(
        input({
          longTerm: retrieval("unavailable"),
          candidates: [candidate("ref-a")],
          correctionStore: correctionStore([
            correction({ replacementMeaning: "Known from correction." })
          ])
        })
      )
    );

    expect(result.projection.longTermEvidence.accessStatus).toBe("UNAVAILABLE");
    expect(result.projection.interpretations[0]).toMatchObject({
      accessStatus: "UNAVAILABLE",
      meaning: "Known from correction.",
      status: "KNOWN"
    });
  });

  it("keeps Memory EMPTY distinct from successful empty correction history", () => {
    const result = reconstructed(
      reconstructP8Projection(
        input({
          longTerm: retrieval("empty"),
          candidates: [candidate("ref-a")],
          correctionStore: correctionStore([
            correction({ replacementMeaning: "Meaning from correction." })
          ])
        })
      )
    );

    expect(result.projection.longTermEvidence.accessStatus).toBe(
      "SUCCESS_WITH_NO_RELEVANT_EVIDENCE"
    );
    expect(result.projection.longTermEvidence.status).toBe("EMPTY");
    expect(result.projection.interpretations[0]).toMatchObject({
      accessStatus: "SUCCESS_WITH_NO_RELEVANT_EVIDENCE",
      meaning: "Meaning from correction.",
      status: "KNOWN"
    });
  });

  it.each([
    ["UNAVAILABLE", "UNAVAILABLE"],
    ["ERROR", "ERROR"]
  ] as const)(
    "does not expose an uncorrected projection when the correction store is %s",
    (status, expected) => {
      const outcome = reconstructP8Projection(input({ correctionStore: { status } }));

      expect(outcome.status).toBe(expected);
      expect(outcome).not.toHaveProperty("projection");
      expect(outcome.versions.p8ReconstructionVersion).toBe("p8-1e.v1");
    }
  );

  it("rejects inconsistent successful correction-store statuses instead of treating them as empty", () => {
    const populatedStatusWithoutRows = reconstructP8Projection(
      input({ correctionStore: { status: "SUCCESS_WITH_CORRECTIONS", corrections: [] } })
    );
    const emptyStatusWithRows = reconstructP8Projection(
      input({
        correctionStore: {
          status: "SUCCESS_WITH_NO_CORRECTIONS",
          corrections: [correction()]
        }
      })
    );

    expect(populatedStatusWithoutRows).toMatchObject({ status: "ERROR" });
    expect(emptyStatusWithRows).toMatchObject({ status: "ERROR" });
    expect(populatedStatusWithoutRows).not.toHaveProperty("projection");
    expect(emptyStatusWithRows).not.toHaveProperty("projection");
  });

  it("keeps bounded recent conversation separate and excludes raw inputs from the projection", () => {
    const result = reconstructed(
      reconstructP8Projection(
        input({
          candidates: [],
          correctionStore: { status: "SUCCESS_WITH_NO_CORRECTIONS", corrections: [] }
        })
      )
    );
    const withRecent = reconstructed(
      reconstructP8Projection({
        ...input({ candidates: [] }),
        recentConversation: {
          messages: [
            {
              messageReference: "recent-1",
              role: "user",
              content: "A bounded recent message.",
              scopeReference: SCOPE
            }
          ],
          maxMessages: 1,
          maxCharacters: 100
        }
      })
    );

    expect(result.projection.recentConversation).toBeUndefined();
    expect(withRecent.projection.recentConversation).toMatchObject({
      accessStatus: "SUCCESS_WITH_EVIDENCE",
      status: "UNKNOWN",
      evidenceCount: 1
    });
    expect(JSON.stringify(withRecent.projection)).not.toContain("A bounded recent message.");
    expect(JSON.stringify(withRecent.projection)).not.toContain("MemoryEvent");
  });

  it("is deterministic and persists no database or semantic timestamp", () => {
    const reconstructionInput = input({
      correctionStore: correctionStore([correction({ suppliedAt: "2026-08-30T00:00:00.000Z" })])
    });
    const first = reconstructed(reconstructP8Projection(reconstructionInput));
    const second = reconstructed(reconstructP8Projection(reconstructionInput));

    expect(first).toEqual(second);
    expect(JSON.stringify(first)).not.toContain("storedAt");
    expect(JSON.stringify(first)).not.toContain("rowId");
  });
});
