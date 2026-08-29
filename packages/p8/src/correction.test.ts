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
  type P8AuthoredInvariantRevisionPolicy,
  type P8CorrectionTargetableInterpretation,
  type P8ExplicitCorrection
} from "./correction.js";

const SCOPE = { reference: "scope-user-a" } as const;
const ADDRESS = createDefaultP8IdentityAddress("subject-a");

type TestInterpretation = {
  reference: string;
  meaning: string;
  domain?: "BACKGROUND" | "COMMUNICATION_PREFERENCE" | "SHARED_HISTORY" | "RELATIONSHIP_CONTEXT";
  evidenceReferences?: readonly string[];
};

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
    interpretation?: TestInterpretation;
    interpretations?: readonly TestInterpretation[];
    recentMessages?: readonly P8RecentConversationMessageInput[];
  } = {}
) {
  const scopeReference = options.scopeReference ?? SCOPE;
  const events = options.events ?? [];
  const interpretation = options.interpretation;
  const interpretations =
    options.interpretations ?? (interpretation === undefined ? undefined : [interpretation]);
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
    ...(interpretations === undefined
      ? {}
      : {
          interpretationCandidates: interpretations.map((candidate) => ({
            domain: candidate.domain ?? "BACKGROUND",
            meaning: candidate.meaning,
            evidenceLinks: (candidate.evidenceReferences ?? events.map((event) => event.id)).map(
              (evidenceReference) => ({
                evidenceReference,
                relation: "SUPPORTS" as const,
                support: "DIRECT" as const
              })
            )
          }))
        })
  };
  return createP8EvidenceAdapterProjection(input);
}

type CorrectionOverrides = Omit<Partial<P8ExplicitCorrection>, "replacementMeaning"> & {
  replacementMeaning?: string | undefined;
};

function correction(overrides: CorrectionOverrides = {}): P8ExplicitCorrection {
  const { replacementMeaning: requestedReplacementMeaning, ...otherOverrides } = overrides;
  const hasReplacementMeaning = Object.prototype.hasOwnProperty.call(
    overrides,
    "replacementMeaning"
  );
  const replacementMeaning = hasReplacementMeaning
    ? requestedReplacementMeaning
    : overrides.action === "RETRACT"
      ? undefined
      : "The corrected semantic meaning.";
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
    ...(replacementMeaning === undefined ? {} : { replacementMeaning })
  } as P8ExplicitCorrection;
}

function apply(
  projection: ReturnType<typeof baseProjection>,
  corrections: readonly P8ExplicitCorrection[],
  options: {
    targetableInterpretations?: readonly P8CorrectionTargetableInterpretation[];
    authoredInvariantRevisionPolicies?: readonly P8AuthoredInvariantRevisionPolicy[];
  } = {}
) {
  return applyP8Corrections({
    baseProjection: projection,
    scopeReference: SCOPE,
    corrections,
    ...options
  });
}

function bindInterpretations(
  projection: ReturnType<typeof baseProjection>,
  references: readonly string[] = ["interpretation-1"]
): readonly P8CorrectionTargetableInterpretation[] {
  if (projection.interpretations.length !== references.length) {
    throw new Error("test interpretation binding count mismatch");
  }
  return projection.interpretations.map((interpretation, index) => ({
    interpretationReference: references[index]!,
    interpretation
  }));
}

function applyToInterpretations(
  projection: ReturnType<typeof baseProjection>,
  corrections: readonly P8ExplicitCorrection[],
  references?: readonly string[],
  options: { authoredInvariantRevisionPolicies?: readonly P8AuthoredInvariantRevisionPolicy[] } = {}
) {
  return apply(projection, corrections, {
    targetableInterpretations: bindInterpretations(projection, references),
    ...options
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

function twoInterpretationBase(sameMeaning = false) {
  const firstEvent = memoryEvent({ id: "memory-a", content: "The first bounded fact." });
  const secondEvent = memoryEvent({ id: "memory-b", content: "The second bounded fact." });
  return baseProjection({
    events: [firstEvent, secondEvent],
    interpretations: [
      {
        reference: "candidate-a",
        meaning: sameMeaning ? "The shared semantic meaning." : "The first semantic meaning.",
        evidenceReferences: [firstEvent.id]
      },
      {
        reference: "candidate-b",
        meaning: sameMeaning ? "The shared semantic meaning." : "The second semantic meaning.",
        evidenceReferences: [secondEvent.id]
      }
    ]
  });
}

describe("P8-1D explicit correction semantics", () => {
  it("revises an interpretation with explicit user authority", () => {
    const result = applyToInterpretations(interpretationBase(), [correction()]);

    expect(result.correctionVersion).toBe(P8_1D_VERSION);
    expect(result.interpretations[0]).toMatchObject({
      status: "KNOWN",
      support: "DIRECT",
      meaning: "The corrected semantic meaning.",
      evidenceLinks: [],
      provenance: []
    });
    expect(result.interpretations[0]).not.toHaveProperty("interpretationReference");
    expect(result.targetableInterpretations?.[0]?.interpretationReference).toBe("interpretation-1");
  });

  it("preserves audit references while hiding superseded meaning from current output", () => {
    const result = applyToInterpretations(interpretationBase(), [
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
    const result = applyToInterpretations(interpretationBase(), [
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
    const result = applyToInterpretations(
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
    const result = applyToInterpretations(interpretationBase(), [correction()]);

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
    const result = applyToInterpretations(
      projection,
      [correction({ replacementMeaning: "The relationship is not romantic." })],
      ["interpretation-1"]
    );

    expect(result.interpretations[0]?.meaning).toBe("The relationship is not romantic.");
    expect(result.provenance.some((reference) => reference.source === "evidence")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("affinity");
  });

  it("rejects non-explicit correction authority instead of downgrading it", () => {
    expect(() =>
      applyToInterpretations(interpretationBase(), [
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
      applyToInterpretations(interpretationBase(), [
        correction({ scopeReference: { reference: "scope-user-b" } })
      ])
    ).toThrow("scope is not authorized");
  });

  it("isolates correction by character instance and persona profile", () => {
    const otherAddress = {
      characterInstanceId: "character-b",
      personaProfileId: "profile-b",
      subjectScopeId: "subject-a"
    } as const;
    expect(() =>
      applyToInterpretations(interpretationBase(), [correction({ address: otherAddress })])
    ).toThrow("address is not authorized");
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
          domain: "BACKGROUND",
          meaning: "Same text meaning.",
          evidenceLinks: [
            { evidenceReference: "memory-a", relation: "SUPPORTS", support: "DIRECT" }
          ]
        },
        {
          domain: "BACKGROUND",
          meaning: "Same text meaning.",
          evidenceLinks: [
            { evidenceReference: "memory-b", relation: "SUPPORTS", support: "DIRECT" }
          ]
        }
      ]
    });
    const result = applyToInterpretations(
      projection,
      [
        correction({
          target: { kind: "INTERPRETATION", interpretationReference: "interpretation-a" }
        })
      ],
      ["interpretation-a", "interpretation-b"]
    );

    expect(
      result.targetableInterpretations?.find(
        (item) => item.interpretationReference === "interpretation-a"
      )?.interpretation
    )?.toMatchObject({
      meaning: "The corrected semantic meaning.",
      status: "KNOWN"
    });
    expect(
      result.targetableInterpretations?.find(
        (item) => item.interpretationReference === "interpretation-b"
      )?.interpretation
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
      ],
      {
        authoredInvariantRevisionPolicies: [
          {
            invariantTarget: "persona",
            invariantKey: "persona.user-boundary",
            policy: "USER_REVISABLE"
          }
        ]
      }
    );

    expect(result.persona.invariants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "persona.user-boundary",
          statement: "The corrected semantic meaning."
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
      ],
      {
        authoredInvariantRevisionPolicies: [
          {
            invariantTarget: "persona",
            invariantKey: "persona.user-boundary",
            policy: "USER_REVISABLE"
          }
        ]
      }
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
      const result = applyToInterpretations(projection, [correction()]);
      const expectedStatus =
        status === "empty" ? "SUCCESS_WITH_NO_RELEVANT_EVIDENCE" : status.toUpperCase();

      expect(result.longTermEvidence.accessStatus).toBe(expectedStatus);
      expect(result.interpretations[0]?.accessStatus).toBe(expectedStatus);
      expect(result.interpretations[0]?.meaning).toBe("The corrected semantic meaning.");
    }
  });

  it("resolves explicit correction lineage deterministically", () => {
    const result = applyToInterpretations(interpretationBase(), [
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
    const result = applyToInterpretations(interpretationBase(), [
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
    const forward = applyToInterpretations(interpretationBase(), [first, second]);
    const reversed = applyToInterpretations(interpretationBase(), [second, first]);

    expect(forward).toEqual(reversed);
    expect(forward.interpretations[0]?.status).toBe("CONFLICTING");
  });

  it("reconstructs identically without generated time or random identifiers", () => {
    const input = [
      correction({ provenance: { source: "EXPLICIT_USER_CORRECTION", reference: "source-a" } })
    ];
    const first = applyToInterpretations(interpretationBase(), input);
    const second = applyToInterpretations(interpretationBase(), input);

    expect(first).toEqual(second);
    expect(first.correctionProvenance[0]?.suppliedAt).toBeUndefined();
  });

  it("preserves current Memory access state and adds no relationship scalar or prompt contract", () => {
    const result = applyToInterpretations(interpretationBase(), [correction()]);
    const serialized = JSON.stringify(result);

    expect(result.longTermEvidence.accessStatus).toBe("SUCCESS_WITH_EVIDENCE");
    expect(result).not.toHaveProperty("prompt");
    expect(result).not.toHaveProperty("relationshipLevel");
    expect(result).not.toHaveProperty("affinity");
    expect(serialized).not.toContain("PromptBuilder");
  });

  it("returns an immutable correction result", () => {
    const result = applyToInterpretations(interpretationBase(), [correction()]);

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.interpretations)).toBe(true);
    expect(Object.isFrozen(result.targetableInterpretations)).toBe(true);
    expect(Object.isFrozen(result.correctionAudits)).toBe(true);
    expect(Object.isFrozen(result.correctionProvenance)).toBe(true);
  });

  it("requires an explicit P8-1D binding for an interpretation correction target", () => {
    expect(() => apply(interpretationBase(), [correction()])).toThrow(
      "target interpretation is not present"
    );
  });

  it("treats a subset of targetable bindings as an overlay without corrections", () => {
    const projection = twoInterpretationBase();
    const first = projection.interpretations[0]!;

    const result = apply(projection, [], {
      targetableInterpretations: [{ interpretationReference: "ref-a", interpretation: first }]
    });

    expect(result.interpretations).toHaveLength(2);
    expect(result.interpretations).toEqual(projection.interpretations);
    expect(result.interpretations[0]).toEqual(first);
    expect(result.interpretations[1]).toEqual(projection.interpretations[1]);
  });

  it("corrects a bound interpretation while preserving every unbound base interpretation", () => {
    const projection = twoInterpretationBase();
    const first = projection.interpretations[0]!;
    const second = projection.interpretations[1]!;

    const result = apply(
      projection,
      [
        correction({
          target: { kind: "INTERPRETATION", interpretationReference: "ref-a" }
        })
      ],
      {
        targetableInterpretations: [{ interpretationReference: "ref-a", interpretation: first }]
      }
    );

    expect(result.interpretations).toHaveLength(2);
    expect(result.interpretations[0]).toMatchObject({
      meaning: "The corrected semantic meaning.",
      status: "KNOWN"
    });
    expect(result.interpretations[1]).toEqual(second);
  });

  it("uses the stable binding reference rather than similar interpretation text", () => {
    const projection = twoInterpretationBase(true);
    const first = projection.interpretations[0]!;
    const second = projection.interpretations[1]!;

    const result = apply(
      projection,
      [
        correction({
          target: { kind: "INTERPRETATION", interpretationReference: "ref-a" }
        })
      ],
      {
        targetableInterpretations: [{ interpretationReference: "ref-a", interpretation: first }]
      }
    );

    expect(result.interpretations[0]?.meaning).toBe("The corrected semantic meaning.");
    expect(result.interpretations[1]).toEqual(second);
  });

  it("rejects a foreign interpretation binding", () => {
    const projection = interpretationBase();
    const foreignProjection = interpretationBase({ id: "memory-foreign" });

    expect(() =>
      apply(projection, [], {
        targetableInterpretations: [
          {
            interpretationReference: "ref-foreign",
            interpretation: foreignProjection.interpretations[0]!
          }
        ]
      })
    ).toThrow("exactly one existing base interpretation");
  });

  it("rejects a modified clone of a base interpretation binding", () => {
    const projection = interpretationBase();
    const modifiedClone = {
      ...projection.interpretations[0]!,
      meaning: "A modified clone must not replace the base meaning."
    };

    expect(() =>
      apply(projection, [], {
        targetableInterpretations: [
          { interpretationReference: "ref-clone", interpretation: modifiedClone }
        ]
      })
    ).toThrow("exactly one existing base interpretation");
  });

  it("rejects aliases that bind one base interpretation to multiple references", () => {
    const projection = twoInterpretationBase();
    const first = projection.interpretations[0]!;

    expect(() =>
      apply(projection, [], {
        targetableInterpretations: [
          { interpretationReference: "ref-a", interpretation: first },
          { interpretationReference: "ref-alias", interpretation: first }
        ]
      })
    ).toThrow("cannot alias one base interpretation");
  });

  it("rejects a correction targeting an unbound interpretation reference", () => {
    const projection = twoInterpretationBase();

    expect(() =>
      apply(
        projection,
        [
          correction({
            target: { kind: "INTERPRETATION", interpretationReference: "ref-unbound" }
          })
        ],
        {
          targetableInterpretations: [
            { interpretationReference: "ref-a", interpretation: projection.interpretations[0]! }
          ]
        }
      )
    ).toThrow("target interpretation is not present");
  });

  it("preserves the existing pass-through when no bindings or corrections are supplied", () => {
    const projection = twoInterpretationBase();
    const result = apply(projection, []);

    expect(result.interpretations).toEqual(projection.interpretations);
    expect(result).not.toHaveProperty("targetableInterpretations");
  });

  it("rejects a correction-lineage cycle in either direction", () => {
    const first = correction({
      correctionReference: "correction-1",
      supersedesCorrectionReference: "correction-2"
    });
    const second = correction({
      correctionReference: "correction-2",
      supersedesCorrectionReference: "correction-1",
      provenance: { source: "EXPLICIT_USER_CORRECTION", reference: "source-2" }
    });

    expect(() => applyToInterpretations(interpretationBase(), [first, second])).toThrow(
      "lineage cannot contain a cycle"
    );
  });

  it("rejects correction self-supersession", () => {
    expect(() =>
      applyToInterpretations(interpretationBase(), [
        correction({ supersedesCorrectionReference: "correction-1" })
      ])
    ).toThrow("lineage cannot contain a cycle");
  });

  it("rejects a superseded correction reference that is not supplied", () => {
    expect(() =>
      applyToInterpretations(interpretationBase(), [
        correction({ supersedesCorrectionReference: "correction-missing" })
      ])
    ).toThrow("references unavailable correction");
  });

  it("rejects correction lineage that crosses semantic targets", () => {
    const revisable: P8AuthoredInvariant = {
      key: "persona.user-boundary",
      target: "persona",
      statement: "The user controls this authored boundary.",
      provenance: { source: "authored", reference: "test/revisable-cross-target" }
    };
    const projection = baseProjection({
      authoredInvariants: [...DEFAULT_AUTHORED_INVARIANTS, revisable],
      events: [memoryEvent()],
      interpretation: {
        reference: "interpretation-1",
        meaning: "The original semantic meaning."
      }
    });

    expect(() =>
      applyToInterpretations(
        projection,
        [
          correction({ correctionReference: "correction-1" }),
          correction({
            correctionReference: "correction-2",
            target: {
              kind: "AUTHORED_INVARIANT",
              invariantTarget: "persona",
              invariantKey: "persona.user-boundary"
            },
            supersedesCorrectionReference: "correction-1",
            provenance: { source: "EXPLICIT_USER_CORRECTION", reference: "source-2" }
          })
        ],
        undefined,
        {
          authoredInvariantRevisionPolicies: [
            {
              invariantTarget: "persona",
              invariantKey: "persona.user-boundary",
              policy: "USER_REVISABLE"
            }
          ]
        }
      )
    ).toThrow("same semantic target");
  });

  it.each([
    ["different payload", "Meaning A.", "Meaning B."],
    ["identical payload", "Meaning A.", "Meaning A."]
  ] as const)(
    "rejects duplicate correction references with %s",
    (_case, firstMeaning, secondMeaning) => {
      expect(() =>
        applyToInterpretations(interpretationBase(), [
          correction({ correctionReference: "duplicate", replacementMeaning: firstMeaning }),
          correction({
            correctionReference: "duplicate",
            replacementMeaning: secondMeaning,
            provenance: { source: "EXPLICIT_USER_CORRECTION", reference: "source-2" }
          })
        ])
      ).toThrow("correction reference must be unique");
    }
  );

  it("rejects duplicate P8-1D interpretation target bindings", () => {
    const projection = interpretationBase();
    const binding = bindInterpretations(projection)[0]!;

    expect(() =>
      apply(projection, [], {
        targetableInterpretations: [binding, binding]
      })
    ).toThrow("interpretation target binding must be unique");
  });

  it("rejects unknown interpretation and authored-invariant targets", () => {
    const projection = interpretationBase();

    expect(() =>
      applyToInterpretations(projection, [
        correction({
          target: { kind: "INTERPRETATION", interpretationReference: "interpretation-missing" }
        })
      ])
    ).toThrow("target interpretation is not present");

    expect(() =>
      apply(projection, [
        correction({
          target: {
            kind: "AUTHORED_INVARIANT",
            invariantTarget: "persona",
            invariantKey: "persona.missing"
          }
        })
      ])
    ).toThrow("target authored invariant is not present");
  });

  it.each([
    "ASSISTANT_MODEL_GENERATED",
    "SYSTEM_INFERRED",
    "WEAK_INFERRED",
    "MEMORY_CORRECTION_EVENT"
  ] as const)("rejects non-explicit correction authority %s", (source) => {
    expect(() =>
      applyToInterpretations(interpretationBase(), [
        correction({
          provenance: { source, reference: `spoof-${source}` }
        })
      ])
    ).toThrow("explicit user correction authority");
  });

  it("rejects malformed REVISE and RETRACT actions without normalizing them", () => {
    expect(() =>
      applyToInterpretations(interpretationBase(), [
        correction({ action: "REVISE", replacementMeaning: undefined })
      ])
    ).toThrow("correction.replacementMeaning");

    expect(() =>
      applyToInterpretations(interpretationBase(), [
        correction({ action: "RETRACT", replacementMeaning: "must be absent" })
      ])
    ).toThrow("cannot supply a replacement meaning");
  });

  it("does not manufacture supersession provenance for a conflict without a winner", () => {
    const result = applyToInterpretations(interpretationBase(), [
      correction({ correctionReference: "correction-a", replacementMeaning: "Meaning A." }),
      correction({
        correctionReference: "correction-b",
        replacementMeaning: "Meaning B.",
        provenance: { source: "EXPLICIT_USER_CORRECTION", reference: "source-b" }
      })
    ]);

    expect(result.interpretations[0]?.status).toBe("CONFLICTING");
    expect(result.correctionAudits.every((audit) => audit.currentStatus === "CONFLICTING")).toBe(
      true
    );
    expect(
      result.correctionAudits.every((audit) => audit.supersededByCorrectionReference === undefined)
    ).toBe(true);
    expect(result.supersededReferences).toEqual([]);
  });

  it("deeply freezes P8-1D bindings, projections, provenance, audits, and policies", () => {
    const revisable: P8AuthoredInvariant = {
      key: "persona.user-boundary",
      target: "persona",
      statement: "The user controls this authored boundary.",
      provenance: { source: "authored", reference: "test/revisable-freeze" }
    };
    const result = applyToInterpretations(
      baseProjection({
        authoredInvariants: [...DEFAULT_AUTHORED_INVARIANTS, revisable],
        events: [memoryEvent()],
        interpretation: {
          reference: "interpretation-1",
          meaning: "The original semantic meaning."
        }
      }),
      [correction({ supersededEvidenceReferences: ["memory-1"] })],
      ["interpretation-1"],
      {
        authoredInvariantRevisionPolicies: [
          {
            invariantTarget: "persona",
            invariantKey: "persona.user-boundary",
            policy: "USER_REVISABLE"
          }
        ]
      }
    );

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.address)).toBe(true);
    expect(Object.isFrozen(result.scopeReference)).toBe(true);
    expect(Object.isFrozen(result.longTermEvidence)).toBe(true);
    expect(Object.isFrozen(result.longTermEvidence.provenance)).toBe(true);
    expect(Object.isFrozen(result.identity)).toBe(true);
    expect(Object.isFrozen(result.identity.invariants)).toBe(true);
    expect(Object.isFrozen(result.identity.invariants[0])).toBe(true);
    expect(Object.isFrozen(result.identity.invariants[0]?.provenance)).toBe(true);
    expect(Object.isFrozen(result.persona.invariants)).toBe(true);
    expect(Object.isFrozen(result.targetableInterpretations)).toBe(true);
    expect(Object.isFrozen(result.targetableInterpretations?.[0])).toBe(true);
    expect(Object.isFrozen(result.targetableInterpretations?.[0]?.interpretation)).toBe(true);
    expect(
      Object.isFrozen(result.targetableInterpretations?.[0]?.interpretation.evidenceLinks)
    ).toBe(true);
    expect(
      Object.isFrozen(result.targetableInterpretations?.[0]?.interpretation.evidenceLinks[0])
    ).toBe(true);
    expect(Object.isFrozen(result.targetableInterpretations?.[0]?.interpretation.provenance)).toBe(
      true
    );
    expect(
      Object.isFrozen(result.targetableInterpretations?.[0]?.interpretation.provenance[0])
    ).toBe(true);
    expect(
      Object.isFrozen(
        result.targetableInterpretations?.[0]?.interpretation.provenance[0]?.scopeReference
      )
    ).toBe(true);
    expect(
      Object.isFrozen(
        result.targetableInterpretations?.[0]?.interpretation.provenance[0]?.contradictionReferences
      )
    ).toBe(true);
    expect(Object.isFrozen(result.correctionProvenance[0])).toBe(true);
    expect(Object.isFrozen(result.correctionProvenance[0]?.address)).toBe(true);
    expect(Object.isFrozen(result.correctionProvenance[0]?.scopeReference)).toBe(true);
    expect(Object.isFrozen(result.correctionAudits[0])).toBe(true);
    expect(Object.isFrozen(result.correctionAudits[0]?.target)).toBe(true);
    expect(Object.isFrozen(result.correctionAudits[0]?.provenance)).toBe(true);
    expect(Object.isFrozen(result.correctionAudits[0]?.previousEvidenceReferences)).toBe(true);
    expect(Object.isFrozen(result.supersededReferences[0])).toBe(true);
    expect(Object.isFrozen(result.authoredInvariantRevisionPolicies)).toBe(true);
    expect(Object.isFrozen(result.authoredInvariantRevisionPolicies[0])).toBe(true);
  });
});
