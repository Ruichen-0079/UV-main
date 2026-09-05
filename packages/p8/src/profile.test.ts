import { describe, expect, it } from "vitest";
import type { MemoryEvent, MemoryRetrievalOutcome } from "@companion/memory";
import {
  DEFAULT_AUTHORED_INVARIANTS,
  P8_PROFILE_VERSION,
  createDefaultP8IdentityAddress,
  reconstructP8MainProfile,
  reconstructP8Projection,
  type P8ExplicitCorrection,
  type P8IdentityAddress,
  type P8ReferencedInterpretationCandidate,
  type P8ReconstructionInput,
  type P8ReconstructionOutcome
} from "./index.js";

const ADDRESS = createDefaultP8IdentityAddress("subject-main-profile");
const SCOPE = { reference: "scope-main-profile" } as const;

function memoryEvent(
  overrides: Partial<MemoryEvent> = {}
): MemoryEvent {
  return {
    id: "memory-main-1",
    kind: "fact",
    content: "The user supplied stable main-profile evidence.",
    source: "main-profile-memory",
    sourceRecordId: "opaque-record",
    scope: SCOPE.reference,
    recordedAt: "2026-08-30T00:00:00.000Z",
    metadata: {},
    assertion: { source: "user", verification: "verified" },
    ...overrides
  };
}

function retrieval(events: readonly MemoryEvent[]): MemoryRetrievalOutcome {
  return {
    status: events.length > 0 ? "ok" : "empty",
    events: [...events],
    source: "main-profile-test",
    limited: false
  };
}

function referencedCandidate(
  interpretationReference: string,
  overrides: {
    domain?: P8ReferencedInterpretationCandidate["candidate"]["domain"];
    meaning?: string;
    evidenceReferences?: readonly string[];
  } = {}
): P8ReferencedInterpretationCandidate {
  return {
    interpretationReference,
    candidate: {
      domain: overrides.domain ?? "RELATIONSHIP_CONTEXT",
      ...(overrides.meaning === undefined ? {} : { meaning: overrides.meaning }),
      ...(overrides.evidenceReferences === undefined
        ? {}
        : {
            evidenceLinks: overrides.evidenceReferences.map((evidenceReference) => ({
              evidenceReference,
              relation: "SUPPORTS" as const,
              support: "DIRECT" as const
            }))
          })
    }
  };
}

function correction(
  overrides: Partial<P8ExplicitCorrection> & {
    interpretationReference?: string;
  } = {}
): P8ExplicitCorrection {
  const { interpretationReference, target, ...rest } = overrides;
  const resolvedTarget =
    target ??
    ({
      kind: "INTERPRETATION",
      interpretationReference: interpretationReference ?? "ref-main-a"
    } as const);
  return {
    correctionReference: "correction-main-1",
    address: ADDRESS,
    scopeReference: SCOPE,
    action: "REVISE",
    replacementMeaning: "Explicit corrected main-profile meaning.",
    provenance: {
      source: "EXPLICIT_USER_CORRECTION",
      reference: "explicit-user-main-1"
    },
    ...rest,
    target: resolvedTarget
  } as P8ExplicitCorrection;
}

function mainProfile(
  overrides: {
    address?: P8IdentityAddress;
    longTerm?: MemoryRetrievalOutcome;
    recentConversation?: P8ReconstructionInput["recentConversation"];
    candidates?: readonly P8ReferencedInterpretationCandidate[];
    corrections?: readonly P8ExplicitCorrection[];
    scopeReference?: { reference: string };
  } = {}
): P8ReconstructionOutcome {
  return reconstructP8MainProfile({
    address: overrides.address ?? ADDRESS,
    authoredInvariants: DEFAULT_AUTHORED_INVARIANTS,
    expectedScopeReference: overrides.scopeReference ?? SCOPE,
    longTerm: overrides.longTerm ?? retrieval([]),
    ...(overrides.recentConversation === undefined
      ? {}
      : { recentConversation: overrides.recentConversation }),
    ...(overrides.candidates === undefined
      ? {}
      : { referencedInterpretationCandidates: overrides.candidates }),
    correctionStore:
      overrides.corrections === undefined || overrides.corrections.length === 0
        ? { status: "SUCCESS_WITH_NO_CORRECTIONS", corrections: [] }
        : { status: "SUCCESS_WITH_CORRECTIONS", corrections: overrides.corrections }
  });
}

function reconstructed(outcome: P8ReconstructionOutcome) {
  if (outcome.status !== "RECONSTRUCTED") {
    throw new Error(`Expected RECONSTRUCTED, got ${outcome.status}.`);
  }
  return outcome.projection;
}

describe("P8 main-profile landing", () => {
  it("exposes a versioned bounded profile landing", () => {
    expect(P8_PROFILE_VERSION).toBe("p8-profile.v1");
  });

  it("does not turn a recent romantic message into romantic relationship truth", () => {
    const recentMessage = {
      messageReference: "recent-love",
      role: "user" as const,
      content: "I love you, let's be romantic partners.",
      scopeReference: SCOPE
    };
    const outcome = mainProfile({
      longTerm: retrieval([]),
      recentConversation: {
        messages: [recentMessage],
        maxMessages: 1,
        maxCharacters: 200
      },
      candidates: [
        referencedCandidate("ref-main-romantic", {
          meaning: "The user and Yuvi are romantic partners.",
          evidenceReferences: ["recent-conversation:recent-love"]
        })
      ]
    });
    const interpretation = reconstructed(outcome).interpretations[0];

    expect(interpretation).toMatchObject({
      domain: "RELATIONSHIP_CONTEXT",
      status: "PARTIAL",
      support: "LIMITED"
    });
    expect(interpretation?.status).not.toBe("KNOWN");
  });

  it("does not upgrade an unsupported relationship claim", () => {
    const outcome = mainProfile({
      longTerm: retrieval([memoryEvent()]),
      candidates: [
        referencedCandidate("ref-main-unsupported", {
          meaning: "Unsupported relationship claim."
        })
      ]
    });
    const interpretation = reconstructed(outcome).interpretations[0];

    expect(interpretation?.status).not.toBe("KNOWN");
    expect(interpretation?.meaning).toBeUndefined();
    expect(reconstructed(outcome).interpretations[0]?.provenance).toEqual([]);
  });

  it("lets an allowed explicit correction cover prior interpretation", () => {
    const outcome = mainProfile({
      longTerm: retrieval([memoryEvent()]),
      candidates: [
        referencedCandidate("ref-main-a", {
          meaning: "Old relationship meaning.",
          evidenceReferences: ["memory-main-1"]
        })
      ],
      corrections: [correction({ interpretationReference: "ref-main-a" })]
    });
    const projection = reconstructed(outcome);

    expect(projection.interpretations[0]).toMatchObject({
      status: "KNOWN",
      meaning: "Explicit corrected main-profile meaning."
    });
    expect(projection.correctionAudits).toHaveLength(1);
    expect(projection.correctionAudits[0]?.previousMeaning).toBe("Old relationship meaning.");
  });

  it("keeps correction scope errors from touching other persona/user/character profiles", () => {
    const foreign = correction({
      correctionReference: "correction-foreign",
      address: { ...ADDRESS, personaProfileId: "other-persona" }
    });
    expect(() => mainProfile({ corrections: [foreign] })).toThrow(/not authorized/);

    const foreignScope = correction({
      correctionReference: "correction-foreign-scope",
      scopeReference: { reference: "scope-other" }
    });
    expect(() => mainProfile({ corrections: [foreignScope] })).toThrow(/not authorized/);
  });

  it("prevents superseded evidence from re-entering as KNOWN via another interpretation", () => {
    const shared = memoryEvent({ id: "memory-shared" });
    const candidates = [
      referencedCandidate("ref-main-a", {
        meaning: "Meaning A via shared evidence.",
        evidenceReferences: ["memory-shared"]
      }),
      referencedCandidate("ref-main-b", {
        meaning: "Meaning B via shared evidence.",
        evidenceReferences: ["memory-shared"]
      })
    ];
    const superseding: P8ExplicitCorrection = {
      correctionReference: "correction-supersede",
      address: ADDRESS,
      scopeReference: SCOPE,
      target: { kind: "INTERPRETATION", interpretationReference: "ref-main-a" },
      action: "REVISE",
      replacementMeaning: "Corrected meaning A.",
      provenance: { source: "EXPLICIT_USER_CORRECTION", reference: "user-supersede" },
      supersededEvidenceReferences: ["memory-shared"]
    };

    const base = reconstructP8Projection({
      address: ADDRESS,
      authoredInvariants: DEFAULT_AUTHORED_INVARIANTS,
      expectedScopeReference: SCOPE,
      longTerm: retrieval([shared]),
      referencedInterpretationCandidates: candidates,
      correctionStore: { status: "SUCCESS_WITH_CORRECTIONS", corrections: [superseding] }
    });
    const baseOther = reconstructed(base).interpretations.find(
      (_, index) => candidates[index]?.interpretationReference === "ref-main-b"
    );
    // Base seam records supersession but leaves the sibling KNOWN (the gap).
    expect(baseOther?.status).toBe("KNOWN");

    const landed = reconstructed(
      mainProfile({
        longTerm: retrieval([shared]),
        candidates,
        corrections: [superseding]
      })
    );
    const landedByRef = new Map(
      landed.targetableInterpretations?.map((binding) => [
        binding.interpretationReference,
        binding.interpretation
      ]) ?? []
    );
    const landedOther = landedByRef.get("ref-main-b");

    expect(landedOther?.status).toBe("PARTIAL");
    expect(landedOther?.support).toBe("LIMITED");
    expect(landedOther?.status).not.toBe("KNOWN");
    // Provenance is retained for audit, not dropped.
    expect(landedOther?.provenance.map((item) => item.reference)).toContain("memory-shared");
    // Corrected target itself still lands the explicit meaning.
    expect(landedByRef.get("ref-main-a")).toMatchObject({
      status: "KNOWN",
      meaning: "Corrected meaning A."
    });
    expect(landed.supersededReferences).toContainEqual({
      kind: "EVIDENCE",
      reference: "memory-shared",
      supersededByCorrectionReference: "correction-supersede"
    });
  });

  it("does not treat conflicted corrections as active supersession", () => {
    const shared = memoryEvent({ id: "memory-shared-conflict" });
    const candidates = [
      referencedCandidate("ref-main-a", {
        meaning: "Meaning A.",
        evidenceReferences: ["memory-shared-conflict"]
      }),
      referencedCandidate("ref-main-b", {
        meaning: "Meaning B.",
        evidenceReferences: ["memory-shared-conflict"]
      })
    ];
    const first: P8ExplicitCorrection = {
      correctionReference: "correction-a",
      address: ADDRESS,
      scopeReference: SCOPE,
      target: { kind: "INTERPRETATION", interpretationReference: "ref-main-a" },
      action: "REVISE",
      replacementMeaning: "Meaning A1.",
      provenance: { source: "EXPLICIT_USER_CORRECTION", reference: "user-a" },
      supersededEvidenceReferences: ["memory-shared-conflict"]
    };
    const second: P8ExplicitCorrection = {
      correctionReference: "correction-b",
      address: ADDRESS,
      scopeReference: SCOPE,
      target: { kind: "INTERPRETATION", interpretationReference: "ref-main-a" },
      action: "REVISE",
      replacementMeaning: "Meaning A2.",
      provenance: { source: "EXPLICIT_USER_CORRECTION", reference: "user-b" },
      supersededEvidenceReferences: ["memory-shared-conflict"]
    };
    const projection = reconstructed(
      mainProfile({
        longTerm: retrieval([shared]),
        candidates,
        corrections: [first, second]
      })
    );
    const byRef = new Map(
      projection.targetableInterpretations?.map((binding) => [
        binding.interpretationReference,
        binding.interpretation
      ]) ?? []
    );

    expect(byRef.get("ref-main-a")?.status).toBe("CONFLICTING");
    // No winner, so sibling keeps its evidence-grounded KNOWN.
    expect(byRef.get("ref-main-b")?.status).toBe("KNOWN");
  });

  it("keeps authored invariants above ordinary Memory evidence", () => {
    const impostor = memoryEvent({
      id: "memory-impostor",
      content: "character.name is Bob."
    });
    const projection = reconstructed(
      mainProfile({
        longTerm: retrieval([impostor]),
        candidates: [
          referencedCandidate("ref-main-background", {
            domain: "BACKGROUND",
            meaning: "A background meaning.",
            evidenceReferences: ["memory-impostor"]
          })
        ]
      })
    );

    expect(projection.identity.invariants.map((invariant) => invariant.statement)).toContain(
      "Yuvi"
    );
    expect(projection.identity.status).toBe("KNOWN");
    expect(JSON.stringify(projection.identity)).not.toContain("Bob");
  });

  it("does not grant P8 authority to Memory correction kind alone", () => {
    const projection = reconstructed(
      mainProfile({
        longTerm: retrieval([
          memoryEvent({ id: "memory-kind-correction", kind: "correction" })
        ]),
        candidates: [
          referencedCandidate("ref-main-a", {
            domain: "BACKGROUND",
            meaning: "A background meaning.",
            evidenceReferences: ["memory-kind-correction"]
          })
        ]
      })
    );

    expect(projection.correctionAudits).toEqual([]);
    expect(projection.correctionProvenance).toEqual([]);
  });

  it("retains provenance and never masquerades PARTIAL/UNKNOWN as confirmed truth", () => {
    const projection = reconstructed(
      mainProfile({
        longTerm: retrieval([memoryEvent()]),
        candidates: [
          referencedCandidate("ref-main-a", {
            meaning: "Grounded meaning.",
            evidenceReferences: ["memory-main-1"]
          })
        ]
      })
    );
    const interpretation = projection.interpretations[0];

    expect(interpretation?.status).toBe("KNOWN");
    expect(interpretation?.provenance[0]).toMatchObject({
      source: "evidence",
      reference: "memory-main-1",
      channel: "LONG_TERM_EVIDENCE"
    });
    expect(interpretation?.provenance[0]?.scopeReference.reference).toBe(SCOPE.reference);
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain("opaque-record");
    expect(serialized).not.toContain("providerPayload");
  });

  it("introduces no affinity/intimacy/mood scalars", () => {
    const projection = reconstructed(
      mainProfile({
        longTerm: retrieval([memoryEvent()]),
        candidates: [
          referencedCandidate("ref-main-a", {
            meaning: "A qualitative relationship interpretation.",
            evidenceReferences: ["memory-main-1"]
          })
        ]
      })
    );
    const serialized = JSON.stringify(projection);

    expect(serialized).not.toMatch(/affinity|intimacy|relationshipLevel|mood/i);
    for (const forbidden of [
      "affinity",
      "intimacyScore",
      "relationshipLevel",
      "mood",
      "trustScore"
    ]) {
      expect(projection).not.toHaveProperty(forbidden);
    }
    expect(projection.interpretations[0]).not.toHaveProperty("affinity");
  });

  it("keeps UNAVAILABLE fail-closed instead of an empty or unknown profile", () => {
    const outcome = mainProfile({
      corrections: [],
      longTerm: retrieval([]),
      candidates: []
    });
    expect(outcome.status).toBe("RECONSTRUCTED");

    const unavailable = reconstructP8MainProfile({
      address: ADDRESS,
      authoredInvariants: DEFAULT_AUTHORED_INVARIANTS,
      expectedScopeReference: SCOPE,
      longTerm: retrieval([memoryEvent()]),
      referencedInterpretationCandidates: [
        referencedCandidate("ref-main-a", { meaning: "A meaning." })
      ],
      correctionStore: { status: "UNAVAILABLE" }
    });

    expect(unavailable.status).toBe("UNAVAILABLE");
    if (unavailable.status === "RECONSTRUCTED") {
      throw new Error("UNAVAILABLE must not reconstruct a projection.");
    }
    expect(unavailable.correctionStoreStatus).toBe("UNAVAILABLE");
  });

  it("keeps ERROR fail-closed and distinct from UNAVAILABLE and EMPTY", () => {
    const errored = reconstructP8MainProfile({
      address: ADDRESS,
      authoredInvariants: DEFAULT_AUTHORED_INVARIANTS,
      expectedScopeReference: SCOPE,
      longTerm: retrieval([memoryEvent()]),
      referencedInterpretationCandidates: [
        referencedCandidate("ref-main-a", { meaning: "A meaning." })
      ],
      correctionStore: { status: "ERROR" }
    });

    expect(errored.status).toBe("ERROR");
    if (errored.status === "RECONSTRUCTED") {
      throw new Error("ERROR must not reconstruct a projection.");
    }
    expect(errored.correctionStoreStatus).toBe("ERROR");
  });

  it("stops a lineage-defeated correction from superseding shared evidence", () => {
    const shared = memoryEvent({ id: "memory-shared-lineage" });
    const first: P8ExplicitCorrection = {
      correctionReference: "correction-lineage-a",
      address: ADDRESS,
      scopeReference: SCOPE,
      target: { kind: "INTERPRETATION", interpretationReference: "ref-main-a" },
      action: "REVISE",
      replacementMeaning: "Meaning from defeated correction.",
      provenance: { source: "EXPLICIT_USER_CORRECTION", reference: "user-lineage-a" },
      supersededEvidenceReferences: ["memory-shared-lineage"]
    };
    const second: P8ExplicitCorrection = {
      correctionReference: "correction-lineage-b",
      address: ADDRESS,
      scopeReference: SCOPE,
      target: { kind: "INTERPRETATION", interpretationReference: "ref-main-a" },
      action: "REVISE",
      replacementMeaning: "Meaning from lineage winner.",
      provenance: { source: "EXPLICIT_USER_CORRECTION", reference: "user-lineage-b" },
      supersedesCorrectionReference: "correction-lineage-a"
    };
    const projection = reconstructed(
      mainProfile({
        longTerm: retrieval([shared]),
        candidates: [
          referencedCandidate("ref-main-a", {
            meaning: "Meaning A.",
            evidenceReferences: ["memory-shared-lineage"]
          }),
          referencedCandidate("ref-main-b", {
            meaning: "Meaning B via shared evidence.",
            evidenceReferences: ["memory-shared-lineage"]
          })
        ],
        corrections: [first, second]
      })
    );
    const byRef = new Map(
      projection.targetableInterpretations?.map((binding) => [
        binding.interpretationReference,
        binding.interpretation
      ]) ?? []
    );

    const defeatedAudit = projection.correctionAudits.find(
      (audit) => audit.correctionReference === "correction-lineage-a"
    );
    expect(defeatedAudit?.supersededByCorrectionReference).toBe("correction-lineage-b");
    // The defeated correction's evidence supersession is not active, so the
    // sibling interpretation keeps its evidence-grounded KNOWN status.
    expect(byRef.get("ref-main-b")?.status).toBe("KNOWN");
    expect(byRef.get("ref-main-a")).toMatchObject({
      status: "KNOWN",
      meaning: "Meaning from lineage winner."
    });
  });

  it("is deterministic and deeply frozen", () => {
    const input = {
      longTerm: retrieval([memoryEvent()]),
      candidates: [
        referencedCandidate("ref-main-a", {
          meaning: "Grounded meaning.",
          evidenceReferences: ["memory-main-1"]
        })
      ]
    };
    const first = reconstructed(mainProfile(input));
    const second = reconstructed(mainProfile(input));

    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.interpretations)).toBe(true);
  });
});
