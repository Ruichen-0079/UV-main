import { describe, expect, it } from "vitest";
import type { MemoryEvent, MemoryRetrievalOutcome } from "@companion/memory";
import {
  DEFAULT_AUTHORED_INVARIANTS,
  P8_EPISTEMIC_STATES,
  createP8CorrectionRecord,
  correctionFromP8CorrectionRecord,
  parseP8CorrectionRecord,
  reconstructP8Projection,
  serializeP8CorrectionRecord,
  type P8CorrectionStoreLoadResult,
  type P8ExplicitCorrection,
  type P8IdentityAddress,
  type P8ReferencedInterpretationCandidate
} from "./index.js";

type Scope = { readonly reference: string };

const ADDRESS_A: P8IdentityAddress = {
  characterInstanceId: "character-a",
  personaProfileId: "profile-a",
  subjectScopeId: "session-a"
};
const ADDRESS_B: P8IdentityAddress = {
  characterInstanceId: "character-b",
  personaProfileId: "profile-b",
  subjectScopeId: "session-b"
};
const SCOPE_A: Scope = { reference: "evidence-scope-a" };
const SCOPE_B: Scope = { reference: "evidence-scope-b" };

function memoryEvent(id: string, scope: Scope, content: string): MemoryEvent {
  return {
    id,
    kind: "fact",
    content,
    source: "p8-1f-isolation-test",
    sourceRecordId: `opaque-${id}`,
    scope: scope.reference,
    recordedAt: "2026-08-30T00:00:00.000Z",
    metadata: {},
    assertion: { source: "user", verification: "verified" }
  };
}

function retrieval(
  events: readonly MemoryEvent[],
  status: MemoryRetrievalOutcome["status"] = events.length > 0 ? "ok" : "empty"
): MemoryRetrievalOutcome {
  return {
    status,
    events: [...events],
    source: "p8-1f-isolation-test",
    limited: status === "partial"
  };
}

function candidate(
  interpretationReference: string,
  evidenceReferences: readonly string[],
  meaning = "The shared base meaning."
): P8ReferencedInterpretationCandidate {
  return {
    interpretationReference,
    candidate: {
      domain: "BACKGROUND",
      meaning,
      evidenceLinks: evidenceReferences.map((evidenceReference) => ({
        evidenceReference,
        relation: "SUPPORTS" as const,
        support: "DIRECT" as const
      }))
    }
  };
}

function correction(
  address: P8IdentityAddress,
  scopeReference: Scope,
  correctionReference: string,
  replacementMeaning: string,
  options: {
    provenanceReference?: string;
    suppliedAt?: string;
    supersedesCorrectionReference?: string;
  } = {}
): P8ExplicitCorrection {
  return {
    correctionReference,
    address,
    scopeReference,
    target: { kind: "INTERPRETATION", interpretationReference: "shared-interpretation" },
    action: "REVISE",
    replacementMeaning,
    provenance: {
      source: "EXPLICIT_USER_CORRECTION",
      reference: options.provenanceReference ?? `explicit-${correctionReference}`,
      ...(options.suppliedAt === undefined ? {} : { suppliedAt: options.suppliedAt })
    },
    ...(options.supersedesCorrectionReference === undefined
      ? {}
      : { supersedesCorrectionReference: options.supersedesCorrectionReference })
  };
}

function correctionStore(
  corrections: readonly P8ExplicitCorrection[]
): P8CorrectionStoreLoadResult {
  return corrections.length === 0
    ? { status: "SUCCESS_WITH_NO_CORRECTIONS", corrections: [] }
    : { status: "SUCCESS_WITH_CORRECTIONS", corrections };
}

function reconstruct(
  address: P8IdentityAddress,
  scopeReference: Scope,
  eventId: string,
  store: P8CorrectionStoreLoadResult,
  options: {
    retrievalStatus?: MemoryRetrievalOutcome["status"];
    events?: readonly MemoryEvent[];
    candidates?: readonly P8ReferencedInterpretationCandidate[];
  } = {}
) {
  return reconstructP8Projection({
    address,
    authoredInvariants: DEFAULT_AUTHORED_INVARIANTS,
    expectedScopeReference: scopeReference,
    longTerm: retrieval(
      options.events ?? [memoryEvent(eventId, scopeReference, "Authorized evidence.")],
      options.retrievalStatus
    ),
    referencedInterpretationCandidates: options.candidates ?? [
      candidate("shared-interpretation", [eventId])
    ],
    correctionStore: store
  });
}

function reconstructedProjection(outcome: ReturnType<typeof reconstructP8Projection>) {
  if (outcome.status !== "RECONSTRUCTED") {
    throw new Error(`Expected RECONSTRUCTED, got ${outcome.status}.`);
  }
  return outcome.projection;
}

function sameAddress(left: P8IdentityAddress, right: P8IdentityAddress): boolean {
  return (
    left.characterInstanceId === right.characterInstanceId &&
    left.personaProfileId === right.personaProfileId &&
    left.subjectScopeId === right.subjectScopeId
  );
}

/** Small durable-store stand-in: records cross a serialization/restart boundary. */
class RestartableCorrectionStore {
  constructor(private readonly serializedRecords: readonly string[] = []) {}

  append(correctionInput: P8ExplicitCorrection): RestartableCorrectionStore {
    const record = createP8CorrectionRecord(correctionInput);
    return new RestartableCorrectionStore([
      ...this.serializedRecords,
      serializeP8CorrectionRecord(record)
    ]);
  }

  restart(): RestartableCorrectionStore {
    return new RestartableCorrectionStore([...this.serializedRecords]);
  }

  load(address: P8IdentityAddress, scopeReference: Scope): P8CorrectionStoreLoadResult {
    const corrections = this.serializedRecords
      .map((serialized) => {
        const parsed = parseP8CorrectionRecord(JSON.parse(serialized) as unknown);
        return correctionFromP8CorrectionRecord(parsed);
      })
      .filter(
        (correctionInput) =>
          sameAddress(correctionInput.address, address) &&
          correctionInput.scopeReference.reference === scopeReference.reference
      );
    return correctionStore(corrections);
  }
}

describe("P8-1F adversarial identity and durability closure", () => {
  it("keeps multi-session and multi-character corrections isolated after restart", () => {
    const beforeRestart = new RestartableCorrectionStore()
      // The same correction reference is valid in separate addressed scopes.
      .append(
        correction(ADDRESS_A, SCOPE_A, "shared-correction", "Session A correction.", {
          provenanceReference: "user-session-a"
        })
      )
      .append(
        correction(ADDRESS_B, SCOPE_B, "shared-correction", "Session B correction.", {
          provenanceReference: "user-session-b"
        })
      );
    const afterRestart = beforeRestart.restart();

    const projectionA = reconstructedProjection(
      reconstruct(ADDRESS_A, SCOPE_A, "evidence-a", afterRestart.load(ADDRESS_A, SCOPE_A))
    );
    const projectionB = reconstructedProjection(
      reconstruct(ADDRESS_B, SCOPE_B, "evidence-b", afterRestart.load(ADDRESS_B, SCOPE_B))
    );

    expect(projectionA).toMatchObject({
      address: ADDRESS_A,
      scopeReference: SCOPE_A,
      interpretations: [{ meaning: "Session A correction.", status: "KNOWN" }]
    });
    expect(projectionB).toMatchObject({
      address: ADDRESS_B,
      scopeReference: SCOPE_B,
      interpretations: [{ meaning: "Session B correction.", status: "KNOWN" }]
    });
    expect(JSON.stringify(projectionA)).not.toContain("Session B correction.");
    expect(JSON.stringify(projectionB)).not.toContain("Session A correction.");
  });

  it("uses explicit correction lineage instead of timestamps as the only supersession authority", () => {
    const timestampNewer = correction(
      ADDRESS_A,
      SCOPE_A,
      "correction-newer",
      "Timestamp-newer meaning.",
      { suppliedAt: "2030-01-01T00:00:00.000Z" }
    );
    const lineageWinner = correction(
      ADDRESS_A,
      SCOPE_A,
      "correction-lineage-winner",
      "Explicit lineage winner.",
      {
        suppliedAt: "2020-01-01T00:00:00.000Z",
        supersedesCorrectionReference: "correction-newer"
      }
    );

    const forward = reconstructedProjection(
      reconstruct(
        ADDRESS_A,
        SCOPE_A,
        "evidence-lineage",
        correctionStore([timestampNewer, lineageWinner])
      )
    );
    const reversed = reconstructedProjection(
      reconstruct(
        ADDRESS_A,
        SCOPE_A,
        "evidence-lineage",
        correctionStore([lineageWinner, timestampNewer])
      )
    );

    expect(forward).toEqual(reversed);
    expect(forward.interpretations[0]).toMatchObject({
      meaning: "Explicit lineage winner.",
      status: "KNOWN"
    });
    expect(forward.supersededReferences).toHaveLength(2);
    expect(forward.supersededReferences).toEqual(
      expect.arrayContaining([
        {
          kind: "CORRECTION",
          reference: "correction-newer",
          supersededByCorrectionReference: "correction-lineage-winner"
        }
      ])
    );
  });

  it("keeps the complete epistemic state vocabulary observable without collapsing access failures", () => {
    const known = reconstructedProjection(
      reconstruct(
        ADDRESS_A,
        SCOPE_A,
        "known-evidence",
        correctionStore([correction(ADDRESS_A, SCOPE_A, "known-correction", "Known meaning.")])
      )
    );
    const empty = reconstructedProjection(
      reconstruct(ADDRESS_A, SCOPE_A, "empty-evidence", correctionStore([]), {
        retrievalStatus: "empty",
        events: [],
        candidates: []
      })
    );
    const partial = reconstructedProjection(
      reconstruct(ADDRESS_A, SCOPE_A, "partial-evidence", correctionStore([]), {
        retrievalStatus: "partial"
      })
    );
    const unknown = reconstructedProjection(
      reconstruct(ADDRESS_A, SCOPE_A, "unknown-evidence", correctionStore([]), {
        candidates: [
          {
            interpretationReference: "shared-interpretation",
            candidate: { domain: "BACKGROUND" }
          }
        ]
      })
    );
    const conflicting = reconstructedProjection(
      reconstruct(ADDRESS_A, SCOPE_A, "supporting-evidence", correctionStore([]), {
        events: [
          memoryEvent("supporting-evidence", SCOPE_A, "Support."),
          memoryEvent("contradicting-evidence", SCOPE_A, "Contradiction.")
        ],
        candidates: [
          {
            interpretationReference: "shared-interpretation",
            candidate: {
              domain: "BACKGROUND",
              meaning: "A contested meaning.",
              evidenceLinks: [
                {
                  evidenceReference: "supporting-evidence",
                  relation: "SUPPORTS",
                  support: "DIRECT"
                },
                {
                  evidenceReference: "contradicting-evidence",
                  relation: "CONTRADICTS",
                  support: "DIRECT"
                }
              ]
            }
          }
        ]
      })
    );
    const unavailable = reconstruct(ADDRESS_A, SCOPE_A, "unavailable-evidence", {
      status: "UNAVAILABLE"
    });
    const error = reconstruct(ADDRESS_A, SCOPE_A, "error-evidence", { status: "ERROR" });

    expect(empty.longTermEvidence).toMatchObject({
      accessStatus: "SUCCESS_WITH_NO_RELEVANT_EVIDENCE",
      status: "EMPTY"
    });
    expect(partial.longTermEvidence).toMatchObject({
      accessStatus: "PARTIAL",
      status: "PARTIAL"
    });
    expect(unknown.longTermEvidence).toMatchObject({
      accessStatus: "SUCCESS_WITH_EVIDENCE",
      status: "UNKNOWN"
    });
    expect(known.interpretations[0]?.status).toBe("KNOWN");
    expect(conflicting.interpretations[0]?.status).toBe("CONFLICTING");
    expect(unavailable.status).toBe("UNAVAILABLE");
    expect(error.status).toBe("ERROR");

    const observed = new Set([
      known.interpretations[0]?.status,
      empty.longTermEvidence.status,
      partial.longTermEvidence.status,
      unknown.longTermEvidence.status,
      conflicting.interpretations[0]?.status,
      unavailable.status,
      error.status
    ]);
    expect(observed).toEqual(new Set(P8_EPISTEMIC_STATES));
  });
});
