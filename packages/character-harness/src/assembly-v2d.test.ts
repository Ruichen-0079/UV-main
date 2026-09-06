import { describe, expect, it } from "vitest";
import { NORMALIZED_COGNITION_RESULT_VERSION } from "../../character-abi/src/index.js";
import { CHARACTER_ABI_2D_VERSION } from "../../character-abi/src/v2d.js";
import {
  CHARACTER_HARNESS_5J_VERSION,
  assembleCharacterHarness2DContext
} from "./assembly-v2d.js";

function cognitionSection() {
  return {
    kind: "COGNITION_RESULT",
    result: {
      version: NORMALIZED_COGNITION_RESULT_VERSION,
      status: "SUCCESS",
      answer: "Answer",
      keyFacts: ["Fact"],
      evidence: [{ reference: "r", statement: "Evidence" }],
      uncertainty: ["Maybe"],
      caveats: ["Caveat"]
    }
  } as const;
}

describe("Character Harness 5J ABI 2D bounded assembly", () => {
  it("counts ordinary and structured cognition semantic strings without flattening", () => {
    const result = assembleCharacterHarness2DContext({
      context: {
        abiVersion: CHARACTER_ABI_2D_VERSION,
        sections: [
          {
            kind: "IDENTITY",
            state: "KNOWN",
            summary: "Yuvi",
            provenanceReferences: ["p8:id"]
          },
          cognitionSection()
        ]
      },
      budget: {
        maxSections: 2,
        maxSemanticCharacters: 39
      }
    });

    expect(result).toEqual({
      version: CHARACTER_HARNESS_5J_VERSION,
      context: {
        abiVersion: CHARACTER_ABI_2D_VERSION,
        sections: [
          {
            kind: "IDENTITY",
            state: "KNOWN",
            summary: "Yuvi",
            provenanceReferences: ["p8:id"]
          },
          cognitionSection()
        ]
      },
      omittedSectionKinds: [],
      usedSemanticCharacters: 39
    });
  });

  it("measures cognition answer, facts, evidence, uncertainty, and caveats only", () => {
    const result = assembleCharacterHarness2DContext({
      context: {
        abiVersion: CHARACTER_ABI_2D_VERSION,
        sections: [cognitionSection()]
      },
      budget: {
        maxSections: 1,
        maxSemanticCharacters: 30
      }
    });

    expect(result.usedSemanticCharacters).toBe(30);
    expect(result.context.sections).toHaveLength(1);
    const section = result.context.sections[0];
    expect(section?.kind).toBe("COGNITION_RESULT");
    if (section?.kind === "COGNITION_RESULT") {
      expect(section.result.answer).toBe("Answer");
      expect(section.result.evidence?.[0]?.statement).toBe("Evidence");
    }
  });

  it("omits the whole cognition section rather than truncating it", () => {
    const result = assembleCharacterHarness2DContext({
      context: {
        abiVersion: CHARACTER_ABI_2D_VERSION,
        sections: [cognitionSection()]
      },
      budget: {
        maxSections: 1,
        maxSemanticCharacters: 29
      }
    });

    expect(result.context.sections).toEqual([]);
    expect(result.omittedSectionKinds).toEqual(["COGNITION_RESULT"]);
    expect(result.usedSemanticCharacters).toBe(0);
  });

  it("preserves prefix-only no-backfill behavior after an oversized cognition section", () => {
    const result = assembleCharacterHarness2DContext({
      context: {
        abiVersion: CHARACTER_ABI_2D_VERSION,
        sections: [
          { kind: "IDENTITY", state: "KNOWN", summary: "Yuvi" },
          cognitionSection(),
          { kind: "PERSONA", state: "KNOWN", summary: "x" }
        ]
      },
      budget: {
        maxSections: 3,
        maxSemanticCharacters: 10
      }
    });

    expect(result.context.sections).toEqual([
      { kind: "IDENTITY", state: "KNOWN", summary: "Yuvi" }
    ]);
    expect(result.omittedSectionKinds).toEqual(["COGNITION_RESULT", "PERSONA"]);
    expect(result.usedSemanticCharacters).toBe(4);
  });

  it("does not assign content weights or count ABI enum/version labels as semantic characters", () => {
    const result = assembleCharacterHarness2DContext({
      context: {
        abiVersion: CHARACTER_ABI_2D_VERSION,
        sections: [
          {
            kind: "COGNITION_RESULT",
            result: {
              version: NORMALIZED_COGNITION_RESULT_VERSION,
              status: "UNAVAILABLE"
            }
          }
        ]
      },
      budget: {
        maxSections: 1,
        maxSemanticCharacters: 0
      }
    });

    expect(result.context.sections).toHaveLength(1);
    expect(result.usedSemanticCharacters).toBe(0);
  });

  it("preserves output-language context while applying the existing section budget", () => {
    const result = assembleCharacterHarness2DContext({
      context: {
        abiVersion: CHARACTER_ABI_2D_VERSION,
        outputLanguage: "JA",
        sections: [{ kind: "IDENTITY", state: "KNOWN", summary: "Yuvi" }]
      },
      budget: {
        maxSections: 1,
        maxSemanticCharacters: 4
      }
    });

    expect(result.context.outputLanguage).toBe("JA");
    expect(result.context.sections).toEqual([
      { kind: "IDENTITY", state: "KNOWN", summary: "Yuvi" }
    ]);
  });

  it("rejects legacy 2A contexts rather than silently upgrading them", () => {
    expect(() =>
      assembleCharacterHarness2DContext({
        context: {
          abiVersion: "character-abi-2a.v1",
          sections: []
        },
        budget: {
          maxSections: 0,
          maxSemanticCharacters: 0
        }
      })
    ).toThrow(/Character ABI 2D version/);
  });

  it("returns frozen bounded assembly output", () => {
    const result = assembleCharacterHarness2DContext({
      context: {
        abiVersion: CHARACTER_ABI_2D_VERSION,
        sections: [cognitionSection()]
      },
      budget: {
        maxSections: 1,
        maxSemanticCharacters: 30
      }
    });

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.context)).toBe(true);
    expect(Object.isFrozen(result.context.sections)).toBe(true);
    expect(Object.isFrozen(result.omittedSectionKinds)).toBe(true);
  });
});
