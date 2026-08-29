import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUTHORED_INVARIANTS,
  createDefaultP8IdentityAddress,
  createP8Projection,
  type P8AuthoredInvariant
} from "./index.js";
import {
  P8_1B_CONTRACT_VERSION,
  P8_EVIDENCE_ACCESS_STATES,
  P8_EVIDENCE_AUTHORITY_CLASSES,
  P8_EVIDENCE_CHANNELS,
  P8_EVIDENCE_LINK_RELATIONS,
  P8_EVIDENCE_SUPPORT_LEVELS,
  createP8AuthorizedEvidence,
  createP8EvidenceAccessOutcome,
  createP8EvidenceInterpretation,
  type P8AuthorizedEvidenceInput,
  type P8EvidenceAccessStatus,
  type P8InterpretationEvidenceLinkInput
} from "./evidence.js";

function evidence(overrides: Partial<P8AuthorizedEvidenceInput> = {}) {
  return createP8AuthorizedEvidence({
    evidenceReference: "evidence-1",
    statement: "The user explicitly supplied this bounded evidence.",
    sourceClass: "VERIFIED_SUPPORTED",
    channel: "LONG_TERM_EVIDENCE",
    support: "DIRECT",
    scopeReference: { reference: "scope-user-a" },
    ...overrides
  });
}

function access(status: P8EvidenceAccessStatus, evidenceAtoms: ReturnType<typeof evidence>[] = []) {
  return createP8EvidenceAccessOutcome({ status, evidence: evidenceAtoms });
}

function interpretation(
  accessOutcome: ReturnType<typeof access>,
  meaning?: string,
  domain:
    | "BACKGROUND"
    | "COMMUNICATION_PREFERENCE"
    | "SHARED_HISTORY"
    | "RELATIONSHIP_CONTEXT" = "RELATIONSHIP_CONTEXT",
  evidenceLinks: readonly P8InterpretationEvidenceLinkInput[] = []
) {
  return createP8EvidenceInterpretation({
    domain,
    ...(meaning === undefined ? {} : { meaning }),
    access: accessOutcome,
    evidenceLinks
  });
}

function link(
  evidenceReference = "evidence-1",
  overrides: Partial<P8InterpretationEvidenceLinkInput> = {}
): P8InterpretationEvidenceLinkInput {
  return {
    evidenceReference,
    relation: "SUPPORTS",
    support: "DIRECT",
    ...overrides
  };
}

describe("P8-1B evidence interpretation semantics", () => {
  it("keeps the P8-1A default projection unchanged", () => {
    const projection = createP8Projection({
      address: createDefaultP8IdentityAddress(),
      authoredInvariants: DEFAULT_AUTHORED_INVARIANTS
    });

    expect(projection.identity.status).toBe("KNOWN");
    expect(projection.persona.status).toBe("UNKNOWN");
  });

  it("maps successful access with no relevant evidence to EMPTY", () => {
    const result = interpretation(access("SUCCESS_WITH_NO_RELEVANT_EVIDENCE"), "A history exists.");

    expect(result.status).toBe("EMPTY");
    expect(result.accessStatus).toBe("SUCCESS_WITH_NO_RELEVANT_EVIDENCE");
    expect(result.meaning).toBeUndefined();
    expect(result.provenance).toEqual([]);
  });

  it("maps unavailable access to UNAVAILABLE", () => {
    expect(interpretation(access("UNAVAILABLE"), "A history exists.").status).toBe("UNAVAILABLE");
  });

  it("maps access failure to ERROR", () => {
    expect(interpretation(access("ERROR"), "A history exists.").status).toBe("ERROR");
  });

  it("maps partial evidence access to PARTIAL without upgrading it to KNOWN", () => {
    const result = interpretation(
      access("PARTIAL", [evidence()]),
      "A history exists.",
      "RELATIONSHIP_CONTEXT",
      [link()]
    );

    expect(result.status).toBe("PARTIAL");
    expect(result.support).toBe("LIMITED");
    expect(result.status).not.toBe("KNOWN");
    expect(result.provenance.map((item) => item.reference)).toEqual(["evidence-1"]);
  });

  it("uses UNKNOWN when evidence exists but no meaning is justified", () => {
    const result = interpretation(access("SUCCESS_WITH_EVIDENCE", [evidence()]));

    expect(result.status).toBe("UNKNOWN");
    expect(result.status).not.toBe("EMPTY");
    expect(result.provenance).toEqual([]);
  });

  it("allows KNOWN only for explicit meaning with direct non-assistant support", () => {
    const result = interpretation(
      access("SUCCESS_WITH_EVIDENCE", [
        evidence({ sourceClass: "VERIFIED_SUPPORTED", support: "DIRECT" })
      ]),
      "A shared history exists.",
      "RELATIONSHIP_CONTEXT",
      [link()]
    );

    expect(result.status).toBe("KNOWN");
    expect(result.support).toBe("DIRECT");
    expect(result.meaning).toBe("A shared history exists.");
  });

  it("keeps DIRECT source and DIRECT candidate support as DIRECT", () => {
    const result = interpretation(
      access("SUCCESS_WITH_EVIDENCE", [evidence({ support: "DIRECT" })]),
      "A shared history exists.",
      "RELATIONSHIP_CONTEXT",
      [link("evidence-1", { support: "DIRECT" })]
    );

    expect(result.evidenceLinks[0]?.support).toBe("DIRECT");
    expect(result.status).toBe("KNOWN");
  });

  it("normalizes a LIMITED candidate link against a DIRECT source", () => {
    const result = interpretation(
      access("SUCCESS_WITH_EVIDENCE", [evidence({ support: "DIRECT" })]),
      "A shared history exists.",
      "RELATIONSHIP_CONTEXT",
      [link("evidence-1", { support: "LIMITED" })]
    );

    expect(result.evidenceLinks[0]?.support).toBe("LIMITED");
    expect(result.status).toBe("PARTIAL");
    expect(result.support).toBe("LIMITED");
  });

  it("normalizes a DIRECT candidate link against a LIMITED source", () => {
    const result = interpretation(
      access("SUCCESS_WITH_EVIDENCE", [evidence({ support: "LIMITED" })]),
      "A shared history exists.",
      "RELATIONSHIP_CONTEXT",
      [link("evidence-1", { support: "DIRECT" })]
    );

    expect(result.evidenceLinks[0]?.support).toBe("LIMITED");
    expect(result.status).toBe("PARTIAL");
    expect(result.support).toBe("LIMITED");
  });

  it("normalizes a DIRECT candidate link against a NON_AUTHORITATIVE source", () => {
    const result = interpretation(
      access("SUCCESS_WITH_EVIDENCE", [evidence({ support: "NON_AUTHORITATIVE" })]),
      "A shared history exists.",
      "RELATIONSHIP_CONTEXT",
      [link("evidence-1", { support: "DIRECT" })]
    );

    expect(result.evidenceLinks[0]?.support).toBe("NON_AUTHORITATIVE");
    expect(result.status).toBe("UNKNOWN");
    expect(result.support).toBe("NON_AUTHORITATIVE");
  });

  it("does not let unrelated direct evidence authorize an arbitrary meaning", () => {
    const result = interpretation(
      access("SUCCESS_WITH_EVIDENCE", [
        evidence({
          statement: "The user studies computer science."
        })
      ]),
      "We are romantically involved."
    );

    expect(result.status).toBe("UNKNOWN");
    expect(result.meaning).toBeUndefined();
    expect(result.provenance).toEqual([]);
  });

  it("maps linked LIMITED authoritative support to PARTIAL", () => {
    const result = interpretation(
      access("SUCCESS_WITH_EVIDENCE", [evidence({ sourceClass: "VERIFIED_SUPPORTED" })]),
      "A shared history exists.",
      "RELATIONSHIP_CONTEXT",
      [link("evidence-1", { support: "LIMITED" })]
    );

    expect(result.status).toBe("PARTIAL");
    expect(result.support).toBe("LIMITED");
    expect(result.meaning).toBe("A shared history exists.");
    expect(result.status).not.toBe("KNOWN");
  });

  it("requires an explicit linked supporting reference even when access has strong evidence", () => {
    const result = interpretation(
      access("SUCCESS_WITH_EVIDENCE", [evidence()]),
      "A shared history exists."
    );

    expect(result.status).toBe("UNKNOWN");
    expect(result.status).not.toBe("KNOWN");
    expect(result.provenance).toEqual([]);
  });

  it("uses only linked evidence as interpretation provenance", () => {
    const result = interpretation(
      access("SUCCESS_WITH_EVIDENCE", [
        evidence({ evidenceReference: "linked" }),
        evidence({
          evidenceReference: "unrelated",
          statement: "The user studies computer science."
        })
      ]),
      "A shared history exists.",
      "RELATIONSHIP_CONTEXT",
      [link("linked")]
    );

    expect(result.status).toBe("KNOWN");
    expect(result.provenance.map((item) => item.reference)).toEqual(["linked"]);
    expect(result.evidenceLinks.map((item) => item.evidenceReference)).toEqual(["linked"]);
  });

  it("keeps a weak pre-classified item at PARTIAL rather than KNOWN", () => {
    const result = interpretation(
      access("SUCCESS_WITH_EVIDENCE", [
        evidence({
          statement: "I love you",
          sourceClass: "WEAK_INFERRED",
          support: "LIMITED"
        })
      ]),
      "A positive relational signal may be present.",
      "RELATIONSHIP_CONTEXT",
      [link("evidence-1", { support: "LIMITED" })]
    );

    expect(result.status).toBe("PARTIAL");
    expect(result.status).not.toBe("KNOWN");
    expect(result.support).toBe("LIMITED");
  });

  it("does not let weak authority become KNOWN even when marked direct", () => {
    const result = interpretation(
      access("SUCCESS_WITH_EVIDENCE", [
        evidence({
          sourceClass: "WEAK_INFERRED",
          support: "DIRECT"
        })
      ]),
      "A shared history exists.",
      "RELATIONSHIP_CONTEXT",
      [link()]
    );

    expect(result.status).toBe("PARTIAL");
    expect(result.status).not.toBe("KNOWN");
  });

  it("does not treat assistant/model output as P8 truth", () => {
    const result = interpretation(
      access("SUCCESS_WITH_EVIDENCE", [
        evidence({
          statement: "We are extremely close.",
          sourceClass: "ASSISTANT_MODEL_GENERATED",
          support: "DIRECT"
        })
      ]),
      "We are extremely close.",
      "RELATIONSHIP_CONTEXT",
      [link()]
    );

    expect(result.status).toBe("UNKNOWN");
    expect(result.status).not.toBe("KNOWN");
    expect(result.meaning).toBeUndefined();
  });

  it("does not upgrade repeated assistant/model output", () => {
    const one = interpretation(
      access("SUCCESS_WITH_EVIDENCE", [
        evidence({
          sourceClass: "ASSISTANT_MODEL_GENERATED",
          support: "DIRECT"
        })
      ]),
      "We are extremely close."
    );
    const repeated = interpretation(
      access("SUCCESS_WITH_EVIDENCE", [
        evidence({
          sourceClass: "ASSISTANT_MODEL_GENERATED",
          support: "DIRECT"
        }),
        evidence({
          evidenceReference: "evidence-2",
          sourceClass: "ASSISTANT_MODEL_GENERATED",
          support: "DIRECT"
        })
      ]),
      "We are extremely close.",
      "RELATIONSHIP_CONTEXT",
      [link("evidence-1"), link("evidence-2")]
    );

    expect(repeated.status).toBe(one.status);
    expect(repeated.support).toBe(one.support);
    expect(repeated.meaning).toBeUndefined();
  });

  it("preserves unresolved contradiction and both provenance paths", () => {
    const first = evidence({
      evidenceReference: "evidence-a",
      contradictionReferences: ["evidence-b"]
    });
    const second = evidence({
      evidenceReference: "evidence-b",
      scopeReference: { reference: "scope-user-b" },
      contradictionReferences: ["evidence-a"]
    });
    const result = interpretation(
      access("SUCCESS_WITH_EVIDENCE", [second, first]),
      "A shared history exists.",
      "RELATIONSHIP_CONTEXT",
      [link("evidence-a"), link("evidence-b", { relation: "CONTRADICTS" })]
    );

    expect(result.status).toBe("CONFLICTING");
    expect(result.meaning).toBeUndefined();
    expect(result.conflictReferences).toEqual(["evidence-a", "evidence-b"]);
    expect(result.provenance.map((item) => item.reference)).toEqual(["evidence-a", "evidence-b"]);
    expect(result.provenance.map((item) => item.scopeReference.reference)).toEqual([
      "scope-user-a",
      "scope-user-b"
    ]);
  });

  it("ignores an unrelated contradiction in the access envelope", () => {
    const result = interpretation(
      access("SUCCESS_WITH_EVIDENCE", [
        evidence({ evidenceReference: "linked" }),
        evidence({
          evidenceReference: "unrelated-a",
          contradictionReferences: ["unrelated-b"]
        }),
        evidence({
          evidenceReference: "unrelated-b",
          contradictionReferences: ["unrelated-a"]
        })
      ]),
      "A shared history exists.",
      "RELATIONSHIP_CONTEXT",
      [link("linked")]
    );

    expect(result.status).toBe("KNOWN");
    expect(result.conflictReferences).toEqual([]);
    expect(result.provenance.map((item) => item.reference)).toEqual(["linked"]);
  });

  it("rejects unavailable access with evidence instead of discarding it", () => {
    expect(() =>
      createP8EvidenceAccessOutcome({
        status: "UNAVAILABLE",
        evidence: [evidence()]
      })
    ).toThrow("unavailable evidence access cannot contain evidence");
  });

  it("rejects error access with evidence instead of discarding it", () => {
    expect(() =>
      createP8EvidenceAccessOutcome({
        status: "ERROR",
        evidence: [evidence()]
      })
    ).toThrow("error evidence access cannot contain evidence");
  });

  it("keeps long-term evidence and recent conversation distinct", () => {
    const result = interpretation(
      access("SUCCESS_WITH_EVIDENCE", [
        evidence({
          evidenceReference: "long-term",
          channel: "LONG_TERM_EVIDENCE"
        }),
        evidence({
          evidenceReference: "recent",
          channel: "RECENT_CONVERSATION"
        })
      ]),
      "A shared history exists.",
      "RELATIONSHIP_CONTEXT",
      [link("long-term"), link("recent")]
    );

    expect(result.provenance.map((item) => item.channel)).toEqual([
      "LONG_TERM_EVIDENCE",
      "RECENT_CONVERSATION"
    ]);
  });

  it("preserves scope references without performing scope filtering", () => {
    const result = interpretation(
      access("SUCCESS_WITH_EVIDENCE", [
        evidence({
          evidenceReference: "scope-a",
          scopeReference: { reference: "global-person-a" }
        }),
        evidence({
          evidenceReference: "scope-b",
          scopeReference: { reference: "conversation-group-b" }
        })
      ]),
      "A shared history exists.",
      "RELATIONSHIP_CONTEXT",
      [link("scope-a"), link("scope-b")]
    );

    expect(result.provenance.map((item) => item.scopeReference.reference)).toEqual([
      "global-person-a",
      "conversation-group-b"
    ]);
  });

  it("keeps authored provenance restricted to P8-1A", () => {
    const evidenceProvenance = evidence().provenance;

    expect(() =>
      createP8Projection({
        address: createDefaultP8IdentityAddress(),
        authoredInvariants: [
          {
            ...DEFAULT_AUTHORED_INVARIANTS[0]!,
            provenance: evidenceProvenance
          } as unknown as P8AuthoredInvariant
        ]
      })
    ).toThrow("only accepts authored provenance");
  });

  it("keeps the vocabulary distinct and adds no scalar relationship authority", () => {
    expect(new Set(P8_EVIDENCE_CHANNELS).size).toBe(2);
    expect(new Set(P8_EVIDENCE_AUTHORITY_CLASSES).size).toBe(5);
    expect(P8_EVIDENCE_LINK_RELATIONS).toEqual(["SUPPORTS", "CONTRADICTS"]);
    expect(new Set(P8_EVIDENCE_SUPPORT_LEVELS).size).toBe(3);
    expect(P8_EVIDENCE_ACCESS_STATES).toEqual([
      "SUCCESS_WITH_EVIDENCE",
      "SUCCESS_WITH_NO_RELEVANT_EVIDENCE",
      "PARTIAL",
      "UNAVAILABLE",
      "ERROR"
    ]);

    const result = interpretation(
      access("SUCCESS_WITH_EVIDENCE", [evidence()]),
      "A history exists.",
      "RELATIONSHIP_CONTEXT",
      [link()]
    );
    for (const field of [
      "affinity",
      "trust",
      "intimacy",
      "relationshipLevel",
      "dependencyScore",
      "moodScore"
    ]) {
      expect(result).not.toHaveProperty(field);
    }
  });

  it("retains supplied time and creates no generated timestamp or identifier", () => {
    const result = interpretation(
      access("SUCCESS_WITH_EVIDENCE", [evidence({ suppliedAt: "2026-08-29T00:00:00Z" })]),
      "A history exists.",
      "RELATIONSHIP_CONTEXT",
      [link()]
    );

    expect(result.provenance[0]?.suppliedAt).toBe("2026-08-29T00:00:00Z");
    expect(result).not.toHaveProperty("createdAt");
    expect(result).not.toHaveProperty("id");
  });

  it("reconstructs deterministically from the same semantic inputs", () => {
    const first = evidence({ evidenceReference: "a" });
    const second = evidence({ evidenceReference: "b", channel: "RECENT_CONVERSATION" });
    const firstResult = interpretation(
      access("SUCCESS_WITH_EVIDENCE", [first, second]),
      "A shared history exists.",
      "RELATIONSHIP_CONTEXT",
      [link("a"), link("b")]
    );
    const secondResult = interpretation(
      access("SUCCESS_WITH_EVIDENCE", [second, first]),
      "A shared history exists.",
      "RELATIONSHIP_CONTEXT",
      [link("b"), link("a")]
    );

    expect(firstResult).toEqual(secondResult);
    expect(firstResult.interpretationVersion).toBe(P8_1B_CONTRACT_VERSION);
  });

  it("does not expose provider, model, Memory DTO, or PromptBuilder fields", () => {
    const result = interpretation(
      access("SUCCESS_WITH_EVIDENCE", [evidence()]),
      "A history exists.",
      "RELATIONSHIP_CONTEXT",
      [link()]
    );
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("provider");
    expect(serialized).not.toContain("model");
    expect(serialized).not.toContain("MemoryEvent");
    expect(serialized).not.toContain("PromptBuilder");
    expect(serialized).not.toContain("statement");
  });
});
