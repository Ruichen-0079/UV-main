import { describe, expect, it } from "vitest";
import type { MemoryEvent, MemoryRetrievalOutcome } from "@companion/memory";
import {
  DEFAULT_AUTHORED_INVARIANTS,
  createDefaultP8IdentityAddress,
  type P8AuthoredInvariant,
  type P8EvidenceAdapterInput,
  createP8EvidenceAdapterProjection,
  recentEvidenceReference
} from "./index.js";
import type { P8RecentConversationMessageInput } from "./adapter.js";
import {
  P8_1D_VERSION,
  applyP8Corrections,
  type P8CorrectionApplicationInput,
  type P8ExplicitCorrection
} from "./correction.js";

const SCOPE = { reference: "scope-user-a" } as const;
const ADDRESS = createDefaultP8IdentityAddress("subject-a");

function memoryEvent(overrides: Partial<MemoryEvent> = {}): MemoryEvent {
  return {
    id: "memory-1",
    kind: "fact",
    content: "The user supplied a bounded fact.",
    source: "test-memory",
    sourceRecordId: "opaque-source-record",
    scope: SCOPE.reference,
    recordedAt: "2026-08-29T00:00:00.000Z",
    metadata: {},
    ...overrides
  };
}

function retrieval(
  status: MemoryRetrievalOutcome["status"],
  events: MemoryEvent[] = []
): MemoryRetrievalOutcome {
  return {
    status,
    events,
    source: "test-memory",
    limited: false
  };
}

function recentMessage(
  overrides: Partial<P8RecentConversationMessageInput> = {}
): P8RecentConversationMessageInput {
  return {
    messageReference: "recent-message-1",
    role: "user",
    content: "A recent user message.",
    scopeReference: SCOPE,
    suppliedAt: "2026-08-29T00:01:00.000Z",
    ...overrides
  };
}

function baseProjection(
  options: {
    address?: typeof ADDRESS;
    scopeReference?: typeof SCOPE;
    authoredInvariants?: readonly P8AuthoredInvariant[];
    longTermStatus?: MemoryRetrievalOutcome["status"];
    events?: MemoryEvent[];
    interpretation?: {
      reference: string;
      meaning: string;
      domain?:
        | "BACKGROUND"
        | "COMMUNICATION_PREFERENCE"
        | "SHARED_HISTORY"
        | "RELATIONSHIP_CONTEXT";
      evidenceReferences?: readonly string[];
    };
    recentMessages?: readonly P8RecentConversationMessageInput[];
  } = {}
) {
  const scopeReference = options.scopeReference ?? SCOPE;
  const events = options.events ?? [];
  const interpretation = options.interpretation;
  const input: P8EvidenceAdapterInput = {
    address: options.address ?? ADDRESS,
    authoredInvariants: options.authoredInvariants ?? DEFAULT_AUTHORED_INVARIANTS,
    expectedScopeReference: scopeReference,
    longTerm: retrieval(options.longTermStatus ?? (events.length > 0 ? "ok" : "empty"), events),
    ...(options.recentMessages === undefined
      ? {}
      : {
          recentConversation: {
            messages: options.recentMessages,
            maxMessages: options.recentMessages.length,
            maxCharacters: 1000
          }
        }),
    ...(interpretation === undefined
      ? {}
      : {
          interpretationCandidates: [
            {
              interpretationReference: interpretation.reference,
              domain: interpretation.domain ?? "BACKGROUND",
              meaning: interpretation.meaning,
              evidenceLinks: (
                interpretation.evidenceReferences ?? events.map((event) => event.id)
              ).map((evidenceReference) => ({
                evidenceReference,
                relation: "SUPPORTS" as const,
                support: "DIRECT" as const
              }))
            }
          ]
        })
  };
  return createP8EvidenceAdapterProjection(input);
}

type CorrectionOverrides = Omit<Partial<P8ExplicitCorrection>, "replacementMeaning"> & {
  replacementMeaning?: string | undefined;
};

function correction(overrides: CorrectionOverrides = {}): P8ExplicitCorrection {
  const { replacementMeaning: requestedReplacementMeaning, ...otherOverrides } = overrides;
  return {
    correctionReference: "correction-1",
    address: ADDRESS,
    scopeReference: SCOPE,
    target: {
      kind: "INTERPRETATION",
      interpretationReference: "interpretation-1"
    },
    action: "REVISE",
    provenance: {
      source: "EXPLICIT_USER_CORRECTION",
      reference: "user-correction-source-1",
      suppliedAt: "2026-08-29T00:02:00.000Z"
    },
    ...otherOverrides,
    ...(overrides.action === "RETRACT"
      ? {}
      : { replacementMeaning: requestedReplacementMeaning ?? "The corrected semantic meaning." })
  } as P8ExplicitCorrection;
}

function apply(
  projection: ReturnType<typeof baseProjection>,
  corrections: readonly P8ExplicitCorrection[]
) {
  return applyP8Corrections({
    baseProjection: projection,
    scopeReference: SCOPE,
    corrections
  });
}

function interpretationBase(
  overrides: Partial<Parameters<typeof memoryEvent>[0]> = {},
  interpretationOverrides: {
    reference?: string;
    meaning?: string;
    domain?: "BACKGROUND" | "COMMUNICATION_PREFERENCE" | "SHARED_HISTORY" | "RELATIONSHIP_CONTEXT";
    evidenceReferences?: readonly string[];
  } = {}
) {
  const event = memoryEvent({
    assertion: { source: "user", verification: "verified" },
    ...overrides
  });
  return baseProjection({
    events: [event],
    interpretation: {
      reference: "interpretation-1",
      meaning: "The original semantic meaning.",
      ...interpretationOverrides
    }
  });
}

describe("P8-1D explicit correction semantics", () => {
  it("revises an interpretation with explicit user authority", () => {
    const result = apply(interpretationBase(), [correction()]);

    expect(result.correctionVersion).toBe(P8_1D_VERSION);
    expect(result.interpretations[0]).toMatchObject({
      interpretationReference: "interpretation-1",
      status: "KNOWN",
      support: "DIRECT",
      meaning: "The corrected semantic meaning.",
      evidenceLinks: [],
      provenance: []
    });
  });

  it("preserves audit references while hiding superseded meaning from current output", () => {
    const result = apply(interpretationBase(), [
      correction({
        supersededEvidenceReferences: ["memory-1"]
      })
    ]);
    const audit = result.correctionAudits[0]!;

    expect(audit).toMatchObject({
      previousStatus: "KNOWN",
      previousMeaning: "The original semantic meaning.",
      previousEvidenceReferences: ["memory-1"],
      replacementMeaning: "The corrected semantic meaning.",
      currentStatus: "KNOWN"
    });
    expect(result.supersededReferences).toEqual(
      expect.arrayContaining([
        {
          kind: "INTERPRETATION",
          reference: "interpretation-1",
          supersededByCorrectionReference: "correction-1"
        },
        {
          kind: "EVIDENCE",
          reference: "memory-1",
          supersededByCorrectionReference: "correction-1"
        }
      ])
    );
    expect(result.interpretations[0]?.meaning).not.toBe("The original semantic meaning.");
    expect(result.interpretations[0]?.evidenceLinks).toEqual([]);
  });

  it("retracts an interpretation without inventing its opposite", () => {
    const result = apply(interpretationBase(), [
      correction({
        action: "RETRACT",
        replacementMeaning: undefined
      })
    ]);

    expect(result.interpretations[0]).toMatchObject({
      status: "UNKNOWN",
      support: "NON_AUTHORITATIVE",
      evidenceLinks: [],
      provenance: []
    });
    expect(result.interpretations[0]?.meaning).toBeUndefined();
    expect(result.interpretations[0]?.status).not.toBe("KNOWN");
    expect(result.correctionAudits[0]?.currentStatus).toBe("UNKNOWN");
  });

  it("removes a weak interpretation on explicit retraction", () => {
    const result = apply(
      interpretationBase({ assertion: { source: "user", verification: "unverified" } }),
      [correction({ action: "RETRACT", replacementMeaning: undefined })]
    );

    expect(result.correctionAudits[0]?.previousStatus).toBe("PARTIAL");
    expect(result.interpretations[0]).toMatchObject({
      status: "UNKNOWN",
      support: "NON_AUTHORITATIVE"
    });
  });

  it("lets explicit correction outrank old direct evidence", () => {
    const result = apply(interpretationBase(), [correction()]);

    expect(result.interpretations[0]?.meaning).toBe("The corrected semantic meaning.");
    expect(result.interpretations[0]?.status).toBe("KNOWN");
    expect(result.correctionAudits[0]?.previousEvidenceReferences).toEqual(["memory-1"]);
  });

  it("does not let repeated assistant output restore superseded meaning", () => {
    const assistantRestatement = memoryEvent({
      id: "assistant-restatement",
      content: "The original semantic meaning.",
      assertion: { source: "assistant", verification: "verified" }
    });
    const projection = baseProjection({
      events: [
        memoryEvent({ assertion: { source: "user", verification: "verified" } }),
        assistantRestatement
      ],
      interpretation: {
        reference: "interpretation-1",
        meaning: "The original semantic meaning.",
        evidenceReferences: ["memory-1", "assistant-restatement"]
      }
    });
    const result = apply(projection, [
      correction({ replacementMeaning: "The relationship is not romantic." })
    ]);

    expect(result.interpretations[0]?.meaning).toBe("The relationship is not romantic.");
    expect(result.provenance.some((reference) => reference.source === "evidence")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("affinity");
  });

  it("rejects non-explicit correction authority instead of downgrading it", () => {
    expect(() =>
      apply(interpretationBase(), [
        correction({
          provenance: {
            source: "ASSISTANT_MODEL_GENERATED",
            reference: "assistant-correction"
          }
        } as unknown as Partial<P8ExplicitCorrection>)
      ])
    ).toThrow("explicit user correction authority");
  });

  it("does not treat an ordinary recent user message as correction authority", () => {
    const projection = baseProjection({
      recentMessages: [recentMessage({ content: "I love you" })]
    });
    const result = apply(projection, []);

    expect(result.correctionProvenance).toEqual([]);
    expect(result.correctionAudits).toEqual([]);
    expect(result.interpretations).toEqual([]);
    expect(result.recentConversation?.status).toBe("UNKNOWN");
  });

  it("does not grant authority to a Memory correction kind alone", () => {
    const projection = baseProjection({
      events: [
        memoryEvent({
          kind: "correction",
          assertion: { source: "user", verification: "unverified" }
        })
      ]
    });
    const result = apply(projection, []);

    expect(result.correctionProvenance).toEqual([]);
    expect(result.correctionAudits).toEqual([]);
    expect(result.longTermEvidence.status).toBe("UNKNOWN");
  });

  it("fails closed for a scope mismatch", () => {
    expect(() =>
      apply(interpretationBase(), [correction({ scopeReference: { reference: "scope-user-b" } })])
    ).toThrow("scope is not authorized");
  });

  it("isolates correction by character instance and persona profile", () => {
    const otherAddress = {
      characterInstanceId: "character-b",
      personaProfileId: "profile-b",
      subjectScopeId: "subject-a"
    } as const;
    expect(() => apply(interpretationBase(), [correction({ address: otherAddress })])).toThrow(
      "address is not authorized"
    );
  });

  it("targets same-text interpretations by stable reference, never by text", () => {
    const first = memoryEvent({ id: "memory-a" });
    const second = memoryEvent({
      id: "memory-b",
      assertion: { source: "user", verification: "verified" }
    });
    const projection = createP8EvidenceAdapterProjection({
      address: ADDRESS,
      authoredInvariants: DEFAULT_AUTHORED_INVARIANTS,
      expectedScopeReference: SCOPE,
      longTerm: retrieval("ok", [first, second]),
      interpretationCandidates: [
        {
          interpretationReference: "interpretation-a",
          domain: "BACKGROUND",
          meaning: "Same text meaning.",
          evidenceLinks: [
            { evidenceReference: "memory-a", relation: "SUPPORTS", support: "DIRECT" }
          ]
        },
        {
          interpretationReference: "interpretation-b",
          domain: "BACKGROUND",
          meaning: "Same text meaning.",
          evidenceLinks: [
            { evidenceReference: "memory-b", relation: "SUPPORTS", support: "DIRECT" }
          ]
        }
      ]
    });
    const result = apply(projection, [
      correction({
        target: { kind: "INTERPRETATION", interpretationReference: "interpretation-a" }
      })
    ]);

    expect(
      result.interpretations.find((item) => item.interpretationReference === "interpretation-a")
    )?.toMatchObject({
      meaning: "The corrected semantic meaning.",
      status: "KNOWN"
    });
    expect(
      result.interpretations.find((item) => item.interpretationReference === "interpretation-b")
    )?.toMatchObject({
      meaning: "Same text meaning.",
      status: "KNOWN"
    });
  });

  it("rejects correction of the fixed default character identity invariant", () => {
    const projection = baseProjection();
    expect(() =>
      apply(projection, [
        correction({
          target: {
            kind: "AUTHORED_INVARIANT",
            invariantTarget: "identity",
            invariantKey: "character.name"
          }
        })
      ])
    ).toThrow("not user-revisable");
  });

  it("revises an explicitly user-revisable authored invariant", () => {
    const revisable: P8AuthoredInvariant = {
      key: "persona.user-boundary",
      target: "persona",
      statement: "The user controls this authored boundary.",
      revisability: "USER_REVISABLE",
      provenance: { source: "authored", reference: "test/revisable" }
    };
    const result = apply(
      baseProjection({ authoredInvariants: [...DEFAULT_AUTHORED_INVARIANTS, revisable] }),
      [
        correction({
          target: {
            kind: "AUTHORED_INVARIANT",
            invariantTarget: "persona",
            invariantKey: "persona.user-boundary"
          }
        })
      ]
    );

    expect(result.persona.invariants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "persona.user-boundary",
          statement: "The corrected semantic meaning.",
          revisability: "USER_REVISABLE"
        })
      ])
    );
    expect(result.correctionAudits[0]?.previousMeaning).toBe(
      "The user controls this authored boundary."
    );
  });

  it("retracts a user-revisable authored invariant without an opposite", () => {
    const revisable: P8AuthoredInvariant = {
      key: "persona.user-boundary",
      target: "persona",
      statement: "The user controls this authored boundary.",
      revisability: "USER_REVISABLE",
      provenance: { source: "authored", reference: "test/revisable" }
    };
    const result = apply(
      baseProjection({ authoredInvariants: [...DEFAULT_AUTHORED_INVARIANTS, revisable] }),
      [
        correction({
          action: "RETRACT",
          replacementMeaning: undefined,
          target: {
            kind: "AUTHORED_INVARIANT",
            invariantTarget: "persona",
            invariantKey: "persona.user-boundary"
          }
        })
      ]
    );

    expect(result.persona.invariants).toEqual([]);
    expect(result.correctionAudits[0]?.currentStatus).toBe("UNKNOWN");
  });

  it("preserves EMPTY, UNAVAILABLE, and ERROR access status during correction", () => {
    for (const status of ["empty", "unavailable", "error"] as const) {
      const projection = baseProjection({
        longTermStatus: status,
        interpretation: {
          reference: "interpretation-1",
          meaning: "The original semantic meaning.",
          evidenceReferences: []
        }
      });
      const result = apply(projection, [correction()]);
      const expectedStatus =
        status === "empty" ? "SUCCESS_WITH_NO_RELEVANT_EVIDENCE" : status.toUpperCase();

      expect(result.longTermEvidence.accessStatus).toBe(expectedStatus);
      expect(result.interpretations[0]?.accessStatus).toBe(expectedStatus);
      expect(result.interpretations[0]?.meaning).toBe("The corrected semantic meaning.");
    }
  });

  it("resolves explicit correction lineage deterministically", () => {
    const result = apply(interpretationBase(), [
      correction({
        correctionReference: "correction-1",
        replacementMeaning: "First correction."
      }),
      correction({
        correctionReference: "correction-2",
        replacementMeaning: "Second correction.",
        supersedesCorrectionReference: "correction-1",
        provenance: {
          source: "EXPLICIT_USER_CORRECTION",
          reference: "user-correction-source-2"
        }
      })
    ]);

    expect(result.interpretations[0]?.meaning).toBe("Second correction.");
    expect(result.interpretations[0]?.status).toBe("KNOWN");
    expect(
      result.correctionAudits.find((audit) => audit.correctionReference === "correction-1")
    )?.toMatchObject({
      supersededByCorrectionReference: "correction-2"
    });
  });

  it("keeps incompatible equal-authority corrections CONFLICTING", () => {
    const result = apply(interpretationBase(), [
      correction({ correctionReference: "correction-a", replacementMeaning: "Meaning A." }),
      correction({
        correctionReference: "correction-b",
        replacementMeaning: "Meaning B.",
        provenance: { source: "EXPLICIT_USER_CORRECTION", reference: "source-b" }
      })
    ]);

    expect(result.interpretations[0]).toMatchObject({
      status: "CONFLICTING",
      support: "NON_AUTHORITATIVE",
      evidenceLinks: []
    });
    expect(result.interpretations[0]?.meaning).toBeUndefined();
    expect(result.correctionAudits.every((audit) => audit.currentStatus === "CONFLICTING")).toBe(
      true
    );
  });

  it("does not use timestamps or input order to resolve equal-authority conflict", () => {
    const first = correction({
      correctionReference: "correction-a",
      replacementMeaning: "Meaning A.",
      provenance: {
        source: "EXPLICIT_USER_CORRECTION",
        reference: "source-a",
        suppliedAt: "2099-01-01"
      }
    });
    const second = correction({
      correctionReference: "correction-b",
      replacementMeaning: "Meaning B.",
      provenance: {
        source: "EXPLICIT_USER_CORRECTION",
        reference: "source-b",
        suppliedAt: "2000-01-01"
      }
    });
    const forward = apply(interpretationBase(), [first, second]);
    const reversed = apply(interpretationBase(), [second, first]);

    expect(forward).toEqual(reversed);
    expect(forward.interpretations[0]?.status).toBe("CONFLICTING");
  });

  it("reconstructs identically without generated time or random identifiers", () => {
    const input = [
      correction({ provenance: { source: "EXPLICIT_USER_CORRECTION", reference: "source-a" } })
    ];
    const first = apply(interpretationBase(), input);
    const second = apply(interpretationBase(), input);

    expect(first).toEqual(second);
    expect(first.correctionProvenance[0]?.suppliedAt).toBeUndefined();
  });

  it("preserves current Memory access state and adds no relationship scalar or prompt contract", () => {
    const result = apply(interpretationBase(), [correction()]);
    const serialized = JSON.stringify(result);

    expect(result.longTermEvidence.accessStatus).toBe("SUCCESS_WITH_EVIDENCE");
    expect(result).not.toHaveProperty("prompt");
    expect(result).not.toHaveProperty("relationshipLevel");
    expect(result).not.toHaveProperty("affinity");
    expect(serialized).not.toContain("PromptBuilder");
  });

  it("returns an immutable correction result", () => {
    const result = apply(interpretationBase(), [correction()]);

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.interpretations)).toBe(true);
    expect(Object.isFrozen(result.correctionAudits)).toBe(true);
    expect(Object.isFrozen(result.correctionProvenance)).toBe(true);
  });
});
