import { describe, expect, it } from "vitest";
import {
  CHARACTER_ABI_2A_VERSION,
  NORMALIZED_COGNITION_RESULT_VERSION,
  createCharacterAbiContext,
  createCharacterProposal,
  createNormalizedCognitionResult
} from "./index.js";

describe("Character ABI 2A meaning contract", () => {
  it("keeps ABI sections optional and preserves missing/unknown meaning without fabrication", () => {
    const empty = createCharacterAbiContext({
      abiVersion: CHARACTER_ABI_2A_VERSION,
      sections: []
    });
    const unknown = createCharacterAbiContext({
      abiVersion: CHARACTER_ABI_2A_VERSION,
      sections: [{ kind: "RELATIONSHIP_CONTEXT", state: "UNKNOWN" }]
    });

    expect(empty.sections).toEqual([]);
    expect(unknown.sections[0]).toEqual({
      kind: "RELATIONSHIP_CONTEXT",
      state: "UNKNOWN"
    });
  });

  it.each(["UNKNOWN", "EMPTY", "UNAVAILABLE", "ERROR"] as const)(
    "rejects invented summary for %s sections",
    (state) => {
      expect(() =>
        createCharacterAbiContext({
          abiVersion: CHARACTER_ABI_2A_VERSION,
          sections: [{ kind: "MEMORY_EVIDENCE", state, summary: "Invented certainty." }]
        })
      ).toThrow(/cannot invent a summary/);
    }
  );

  it("requires explicit meaning for KNOWN and permits bounded PARTIAL/CONFLICTING meaning", () => {
    expect(() =>
      createCharacterAbiContext({
        abiVersion: CHARACTER_ABI_2A_VERSION,
        sections: [{ kind: "IDENTITY", state: "KNOWN" }]
      })
    ).toThrow(/KNOWN section IDENTITY requires a summary/);

    expect(
      createCharacterAbiContext({
        abiVersion: CHARACTER_ABI_2A_VERSION,
        sections: [
          {
            kind: "RELATIONSHIP_CONTEXT",
            state: "PARTIAL",
            summary: "Some grounded context is available.",
            provenanceReferences: ["opaque:p8:relationship:1"]
          },
          {
            kind: "TEMPORAL_CONTEXT",
            state: "CONFLICTING",
            summary: "Authorized sources disagree about the relevant date."
          }
        ]
      }).sections
    ).toHaveLength(2);
  });

  it("rejects duplicate semantic section ownership and backend/runtime leakage", () => {
    expect(() =>
      createCharacterAbiContext({
        abiVersion: CHARACTER_ABI_2A_VERSION,
        sections: [
          { kind: "PERSONA", state: "KNOWN", summary: "First." },
          { kind: "PERSONA", state: "KNOWN", summary: "Second." }
        ]
      })
    ).toThrow(/section kind must be unique/);

    expect(() =>
      createCharacterAbiContext({
        abiVersion: CHARACTER_ABI_2A_VERSION,
        sections: [
          {
            kind: "MEMORY_EVIDENCE",
            state: "KNOWN",
            summary: "Authorized evidence meaning.",
            provider: "mem0",
            databaseRowId: 42
          }
        ]
      })
    ).toThrow(/unknown field/);
  });

  it("treats RESPOND, SILENCE, TERMINATE, and NEED_COGNITION as first-class proposals", () => {
    expect(
      createCharacterProposal({
        disposition: "RESPOND",
        text: "Natural character response.",
        presentation: { intent: "soft-smile" }
      })
    ).toEqual({
      disposition: "RESPOND",
      text: "Natural character response.",
      presentation: { intent: "soft-smile" }
    });
    expect(createCharacterProposal({ disposition: "SILENCE" })).toEqual({
      disposition: "SILENCE"
    });
    expect(createCharacterProposal({ disposition: "TERMINATE" })).toEqual({
      disposition: "TERMINATE"
    });
    expect(
      createCharacterProposal({
        disposition: "NEED_COGNITION",
        focus: "The answer needs reliable repository analysis."
      })
    ).toEqual({
      disposition: "NEED_COGNITION",
      focus: "The answer needs reliable repository analysis."
    });
  });

  it("keeps direct Character-to-capability execution non-executable", () => {
    expect(() =>
      createCharacterProposal({
        disposition: "REQUEST_CAPABILITY",
        capability: "shell"
      })
    ).toThrow(/disposition is invalid/);

    expect(() =>
      createCharacterProposal({
        disposition: "NEED_COGNITION",
        focus: "Needs external verification.",
        toolName: "browser.search"
      })
    ).toThrow(/unknown field: toolName/);
  });

  it("does not let silence or termination smuggle user-visible text", () => {
    expect(() =>
      createCharacterProposal({ disposition: "SILENCE", text: "Actually speak." })
    ).toThrow(/unknown field: text/);
    expect(() =>
      createCharacterProposal({ disposition: "TERMINATE", text: "One more thing." })
    ).toThrow(/unknown field: text/);
  });

  it("requires a non-empty bounded response for RESPOND", () => {
    expect(() => createCharacterProposal({ disposition: "RESPOND" })).toThrow(
      /response text must be a non-empty string/
    );
    expect(() => createCharacterProposal({ disposition: "RESPOND", text: "" })).toThrow(
      /response text must be a non-empty string/
    );
  });

  it("represents normalized cognition meaning without provider or reasoning internals", () => {
    const result = createNormalizedCognitionResult({
      version: NORMALIZED_COGNITION_RESULT_VERSION,
      status: "SUCCESS",
      answer: "The normalized business answer.",
      keyFacts: ["Fact A", "Fact B"],
      evidence: [
        {
          reference: "evidence:public:1",
          statement: "Bounded evidence statement."
        }
      ],
      uncertainty: ["One source remains incomplete."],
      caveats: ["Do not infer beyond the supplied evidence."]
    });

    expect(result).toMatchObject({
      status: "SUCCESS",
      answer: "The normalized business answer."
    });
    expect(JSON.stringify(result)).not.toContain("provider");
    expect(JSON.stringify(result)).not.toContain("reasoning");
    expect(JSON.stringify(result)).not.toContain("toolTrace");
  });

  it("fails closed on raw cognition backend, tool trace, and chain-of-thought fields", () => {
    const base = {
      version: NORMALIZED_COGNITION_RESULT_VERSION,
      status: "SUCCESS",
      answer: "Safe normalized answer."
    } as const;

    expect(() => createNormalizedCognitionResult({ ...base, provider: "deepseek" })).toThrow(
      /unknown field: provider/
    );
    expect(() => createNormalizedCognitionResult({ ...base, toolTrace: ["shell"] })).toThrow(
      /unknown field: toolTrace/
    );
    expect(() =>
      createNormalizedCognitionResult({ ...base, rawChainOfThought: "hidden reasoning" })
    ).toThrow(/unknown field: rawChainOfThought/);
  });

  it("requires an authoritative answer for cognition SUCCESS but preserves non-success states", () => {
    expect(() =>
      createNormalizedCognitionResult({
        version: NORMALIZED_COGNITION_RESULT_VERSION,
        status: "SUCCESS"
      })
    ).toThrow(/requires a non-empty answer/);

    for (const status of [
      "PARTIAL",
      "UNAVAILABLE",
      "CANCELLED",
      "UNSAFE_TO_ANSWER",
      "ERROR"
    ] as const) {
      expect(
        createNormalizedCognitionResult({
          version: NORMALIZED_COGNITION_RESULT_VERSION,
          status
        }).status
      ).toBe(status);
    }
  });

  it("is invariant to replaceable backends once their normalized meaning is equivalent", () => {
    const fromBackendA = createNormalizedCognitionResult({
      version: NORMALIZED_COGNITION_RESULT_VERSION,
      status: "SUCCESS",
      answer: "Equivalent normalized answer.",
      keyFacts: ["Same semantic fact."]
    });
    const fromBackendB = createNormalizedCognitionResult({
      version: NORMALIZED_COGNITION_RESULT_VERSION,
      status: "SUCCESS",
      answer: "Equivalent normalized answer.",
      keyFacts: ["Same semantic fact."]
    });

    expect(fromBackendA).toEqual(fromBackendB);
  });

  it("returns immutable semantic envelopes", () => {
    const context = createCharacterAbiContext({
      abiVersion: CHARACTER_ABI_2A_VERSION,
      sections: [
        {
          kind: "IDENTITY",
          state: "KNOWN",
          summary: "Yuvi",
          provenanceReferences: ["authored:character-name"]
        }
      ]
    });
    const result = createNormalizedCognitionResult({
      version: NORMALIZED_COGNITION_RESULT_VERSION,
      status: "SUCCESS",
      answer: "Stable answer.",
      keyFacts: ["Stable fact."]
    });

    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.sections)).toBe(true);
    expect(Object.isFrozen(context.sections[0])).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.keyFacts)).toBe(true);
  });
});
