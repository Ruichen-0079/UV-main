import { describe, expect, it } from "vitest";
import { CHARACTER_ABI_2A_VERSION } from "../../character-abi/src/index.js";
import {
  CHARACTER_HARNESS_5A_VERSION,
  assembleCharacterHarnessContext
} from "./index.js";

function context(sections: readonly unknown[]) {
  return {
    abiVersion: CHARACTER_ABI_2A_VERSION,
    sections
  };
}

describe("Character Harness 5A bounded ABI assembly", () => {
  it("preserves upstream order and applies a prefix-only section budget", () => {
    const result = assembleCharacterHarnessContext({
      context: context([
        { kind: "IDENTITY", state: "KNOWN", summary: "Yuvi" },
        { kind: "PERSONA", state: "UNKNOWN" },
        {
          kind: "RELATIONSHIP_CONTEXT",
          state: "PARTIAL",
          summary: "Grounded relationship context."
        },
        { kind: "CONTINUITY", state: "EMPTY" }
      ]),
      budget: { maxSections: 2, maxSemanticCharacters: 1000 }
    });

    expect(result.version).toBe(CHARACTER_HARNESS_5A_VERSION);
    expect(result.context.sections.map((section) => section.kind)).toEqual([
      "IDENTITY",
      "PERSONA"
    ]);
    expect(result.omittedSectionKinds).toEqual(["RELATIONSHIP_CONTEXT", "CONTINUITY"]);
  });

  it("budgets semantic strings without truncating or rewriting a section", () => {
    const result = assembleCharacterHarnessContext({
      context: context([
        {
          kind: "IDENTITY",
          state: "KNOWN",
          summary: "Yuvi",
          provenanceReferences: ["p8:id"]
        },
        { kind: "PERSONA", state: "UNKNOWN" },
        {
          kind: "RELATIONSHIP_CONTEXT",
          state: "PARTIAL",
          summary: "This relationship meaning does not fit."
        },
        { kind: "CONTINUITY", state: "EMPTY" }
      ]),
      budget: { maxSections: 10, maxSemanticCharacters: 10 }
    });

    expect(result.usedSemanticCharacters).toBe(9);
    expect(result.context.sections).toEqual([
      {
        kind: "IDENTITY",
        state: "KNOWN",
        summary: "Yuvi",
        provenanceReferences: ["p8:id"]
      },
      { kind: "PERSONA", state: "UNKNOWN" }
    ]);
    expect(result.omittedSectionKinds).toEqual(["RELATIONSHIP_CONTEXT", "CONTINUITY"]);
    expect(JSON.stringify(result)).not.toContain("This relationship meaning does not fit.");
  });

  it("does not backfill later cheap sections after the budget closes", () => {
    const result = assembleCharacterHarnessContext({
      context: context([
        { kind: "IDENTITY", state: "KNOWN", summary: "Yuvi" },
        {
          kind: "RELATIONSHIP_CONTEXT",
          state: "PARTIAL",
          summary: "This section is intentionally too expensive."
        },
        { kind: "CONTINUITY", state: "EMPTY" },
        { kind: "ATTENTION_ANCHORS", state: "UNKNOWN" }
      ]),
      budget: { maxSections: 10, maxSemanticCharacters: 4 }
    });

    expect(result.context.sections.map((section) => section.kind)).toEqual(["IDENTITY"]);
    expect(result.omittedSectionKinds).toEqual([
      "RELATIONSHIP_CONTEXT",
      "CONTINUITY",
      "ATTENTION_ANCHORS"
    ]);
  });

  it("allows a zero budget and fails closed to an empty model-facing context", () => {
    const result = assembleCharacterHarnessContext({
      context: context([
        { kind: "IDENTITY", state: "KNOWN", summary: "Yuvi" },
        { kind: "PERSONA", state: "UNKNOWN" }
      ]),
      budget: { maxSections: 0, maxSemanticCharacters: 0 }
    });

    expect(result.context.sections).toEqual([]);
    expect(result.omittedSectionKinds).toEqual(["IDENTITY", "PERSONA"]);
    expect(result.usedSemanticCharacters).toBe(0);
  });

  it("revalidates the ABI instead of trusting forged TypeScript shapes", () => {
    expect(() =>
      assembleCharacterHarnessContext({
        context: {
          abiVersion: CHARACTER_ABI_2A_VERSION,
          sections: [],
          runtimeSessionId: "must-not-cross"
        },
        budget: { maxSections: 1, maxSemanticCharacters: 100 }
      })
    ).toThrow(/unknown field: runtimeSessionId/);

    expect(() =>
      assembleCharacterHarnessContext({
        context: context([
          {
            kind: "IDENTITY",
            state: "KNOWN",
            summary: "Yuvi",
            provider: "local-provider"
          }
        ]),
        budget: { maxSections: 1, maxSemanticCharacters: 100 }
      })
    ).toThrow(/unknown field: provider/);
  });

  it("preserves epistemic absence instead of manufacturing fallback meaning", () => {
    const result = assembleCharacterHarnessContext({
      context: context([
        { kind: "IDENTITY", state: "UNAVAILABLE" },
        { kind: "PERSONA", state: "ERROR" },
        { kind: "RELATIONSHIP_CONTEXT", state: "UNKNOWN" }
      ]),
      budget: { maxSections: 3, maxSemanticCharacters: 0 }
    });

    expect(result.context.sections).toEqual([
      { kind: "IDENTITY", state: "UNAVAILABLE" },
      { kind: "PERSONA", state: "ERROR" },
      { kind: "RELATIONSHIP_CONTEXT", state: "UNKNOWN" }
    ]);
    expect(result.usedSemanticCharacters).toBe(0);
  });

  it("rejects malformed or authority-expanding budget inputs", () => {
    for (const budget of [
      { maxSections: -1, maxSemanticCharacters: 100 },
      { maxSections: 1.5, maxSemanticCharacters: 100 },
      { maxSections: 11, maxSemanticCharacters: 100 },
      { maxSections: 1, maxSemanticCharacters: -1 },
      { maxSections: 1, maxSemanticCharacters: 100_001 }
    ]) {
      expect(() =>
        assembleCharacterHarnessContext({
          context: context([]),
          budget
        })
      ).toThrow(/must be an integer between/);
    }

    expect(() =>
      assembleCharacterHarnessContext({
        context: context([]),
        budget: {
          maxSections: 1,
          maxSemanticCharacters: 100,
          providerTokenBudget: 4096
        }
      })
    ).toThrow(/unknown field: providerTokenBudget/);
  });

  it("is deterministic and returns frozen assembly envelopes", () => {
    const input = {
      context: context([
        { kind: "IDENTITY", state: "KNOWN", summary: "Yuvi" },
        {
          kind: "CURRENT_SITUATION",
          state: "PARTIAL",
          summary: "Bounded situation."
        }
      ]),
      budget: { maxSections: 2, maxSemanticCharacters: 100 }
    };

    const first = assembleCharacterHarnessContext(input);
    const second = assembleCharacterHarnessContext(input);

    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.context)).toBe(true);
    expect(Object.isFrozen(first.context.sections)).toBe(true);
    expect(Object.isFrozen(first.omittedSectionKinds)).toBe(true);
  });
});
