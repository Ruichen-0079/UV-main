import { describe, expect, it } from "vitest";
import { NORMALIZED_COGNITION_RESULT_VERSION } from "../../character-abi/src/index.js";
import { CHARACTER_ABI_2D_VERSION } from "../../character-abi/src/v2d.js";
import { CHARACTER_HARNESS_5I_VERSION } from "./cognition-section.js";
import {
  CHARACTER_HARNESS_5K_VERSION,
  assembleCharacterHarnessPostCognitionContext
} from "./post-cognition-assembly.js";

function cognitionSection(answer = "result") {
  return {
    kind: "COGNITION_RESULT",
    result: {
      version: NORMALIZED_COGNITION_RESULT_VERSION,
      status: "SUCCESS",
      answer
    }
  } as const;
}

function cognitionProjection(answer = "result") {
  return {
    version: CHARACTER_HARNESS_5I_VERSION,
    section: cognitionSection(answer)
  } as const;
}

function regularContext() {
  return {
    abiVersion: CHARACTER_ABI_2D_VERSION,
    sections: [
      {
        kind: "IDENTITY",
        state: "KNOWN",
        summary: "Yuvi"
      },
      {
        kind: "PERSONA",
        state: "KNOWN",
        summary: "abcdefghij"
      },
      {
        kind: "MEMORY_EVIDENCE",
        state: "KNOWN",
        summary: "z"
      }
    ]
  } as const;
}

describe("Character Harness 5K post-cognition reserved assembly", () => {
  it("reserves cognition budget first, keeps regular prefix order, and appends cognition last", () => {
    const result = assembleCharacterHarnessPostCognitionContext({
      context: regularContext(),
      cognitionProjection: cognitionProjection("12345"),
      budget: {
        maxSections: 3,
        maxSemanticCharacters: 11
      }
    });

    expect(result).toEqual({
      version: CHARACTER_HARNESS_5K_VERSION,
      status: "ACCEPTED",
      context: {
        abiVersion: CHARACTER_ABI_2D_VERSION,
        sections: [
          {
            kind: "IDENTITY",
            state: "KNOWN",
            summary: "Yuvi"
          },
          cognitionSection("12345")
        ]
      },
      omittedSectionKinds: ["PERSONA", "MEMORY_EVIDENCE"],
      usedSemanticCharacters: 9
    });
    expect(Object.isFrozen(result)).toBe(true);
    if (result.status === "ACCEPTED") {
      expect(Object.isFrozen(result.context)).toBe(true);
      expect(result.context.sections[result.context.sections.length - 1]?.kind).toBe(
        "COGNITION_RESULT"
      );
    }
  });

  it("carries the output-language preference through Cognition re-entry", () => {
    const result = assembleCharacterHarnessPostCognitionContext({
      context: {
        ...regularContext(),
        outputLanguage: "EN"
      },
      cognitionProjection: cognitionProjection("verified"),
      budget: {
        maxSections: 4,
        maxSemanticCharacters: 100
      }
    });

    expect(result.status).toBe("ACCEPTED");
    if (result.status === "ACCEPTED") {
      expect(result.context.outputLanguage).toBe("EN");
      expect(result.context.sections.at(-1)?.kind).toBe("COGNITION_RESULT");
    }
  });

  it("reserves one section slot even when cognition has zero semantic characters", () => {
    const result = assembleCharacterHarnessPostCognitionContext({
      context: {
        abiVersion: CHARACTER_ABI_2D_VERSION,
        sections: [
          { kind: "IDENTITY", state: "KNOWN", summary: "Yuvi" },
          { kind: "PERSONA", state: "KNOWN", summary: "Calm" }
        ]
      },
      cognitionProjection: {
        version: CHARACTER_HARNESS_5I_VERSION,
        section: {
          kind: "COGNITION_RESULT",
          result: {
            version: NORMALIZED_COGNITION_RESULT_VERSION,
            status: "UNAVAILABLE"
          }
        }
      },
      budget: {
        maxSections: 2,
        maxSemanticCharacters: 4
      }
    });

    expect(result.status).toBe("ACCEPTED");
    if (result.status === "ACCEPTED") {
      expect(result.context.sections.map((section) => section.kind)).toEqual([
        "IDENTITY",
        "COGNITION_RESULT"
      ]);
      expect(result.omittedSectionKinds).toEqual(["PERSONA"]);
      expect(result.usedSemanticCharacters).toBe(4);
    }
  });

  it("fails closed when the cognition result itself cannot fit the character budget", () => {
    const result = assembleCharacterHarnessPostCognitionContext({
      context: {
        abiVersion: CHARACTER_ABI_2D_VERSION,
        sections: []
      },
      cognitionProjection: cognitionProjection("12345"),
      budget: {
        maxSections: 5,
        maxSemanticCharacters: 4
      }
    });

    expect(result).toEqual({
      version: CHARACTER_HARNESS_5K_VERSION,
      status: "COGNITION_RESULT_OVER_BUDGET",
      reason: "MANDATORY_COGNITION_RESULT_EXCEEDS_BUDGET",
      requiredSections: 1,
      availableSections: 5,
      requiredSemanticCharacters: 5,
      availableSemanticCharacters: 4
    });
    expect("context" in result).toBe(false);
  });

  it("fails closed when no section slot remains even for an empty cognition result", () => {
    const result = assembleCharacterHarnessPostCognitionContext({
      context: {
        abiVersion: CHARACTER_ABI_2D_VERSION,
        sections: []
      },
      cognitionProjection: {
        version: CHARACTER_HARNESS_5I_VERSION,
        section: {
          kind: "COGNITION_RESULT",
          result: {
            version: NORMALIZED_COGNITION_RESULT_VERSION,
            status: "UNAVAILABLE"
          }
        }
      },
      budget: {
        maxSections: 0,
        maxSemanticCharacters: 0
      }
    });

    expect(result.status).toBe("COGNITION_RESULT_OVER_BUDGET");
    if (result.status === "COGNITION_RESULT_OVER_BUDGET") {
      expect(result.requiredSections).toBe(1);
      expect(result.availableSections).toBe(0);
      expect(result.requiredSemanticCharacters).toBe(0);
    }
  });

  it("rejects a base context that already contains a cognition result", () => {
    expect(() =>
      assembleCharacterHarnessPostCognitionContext({
        context: {
          abiVersion: CHARACTER_ABI_2D_VERSION,
          sections: [cognitionSection()]
        },
        cognitionProjection: cognitionProjection(),
        budget: {
          maxSections: 2,
          maxSemanticCharacters: 100
        }
      })
    ).toThrow(/must not already contain COGNITION_RESULT/);
  });

  it("requires the 5I projection envelope and a structured cognition result section", () => {
    expect(() =>
      assembleCharacterHarnessPostCognitionContext({
        context: {
          abiVersion: CHARACTER_ABI_2D_VERSION,
          sections: []
        },
        cognitionProjection: {
          version: "character-harness-5h.v1",
          section: cognitionSection()
        },
        budget: {
          maxSections: 2,
          maxSemanticCharacters: 100
        }
      })
    ).toThrow(/requires character-harness-5i.v1/);

    expect(() =>
      assembleCharacterHarnessPostCognitionContext({
        context: {
          abiVersion: CHARACTER_ABI_2D_VERSION,
          sections: []
        },
        cognitionProjection: {
          version: CHARACTER_HARNESS_5I_VERSION,
          section: {
            kind: "IDENTITY",
            state: "KNOWN",
            summary: "Yuvi"
          }
        },
        budget: {
          maxSections: 2,
          maxSemanticCharacters: 100
        }
      })
    ).toThrow(/requires a structured COGNITION_RESULT section/);
  });

  it("rejects provider metadata and does not admit Runtime/provider policy into the seam", () => {
    expect(() =>
      assembleCharacterHarnessPostCognitionContext({
        context: {
          abiVersion: CHARACTER_ABI_2D_VERSION,
          sections: []
        },
        cognitionProjection: {
          version: CHARACTER_HARNESS_5I_VERSION,
          section: {
            kind: "COGNITION_RESULT",
            result: {
              ...cognitionSection().result,
              provider: "deepinfra"
            }
          }
        },
        budget: {
          maxSections: 2,
          maxSemanticCharacters: 100
        }
      })
    ).toThrow(/unknown field: provider/);

    expect(() =>
      assembleCharacterHarnessPostCognitionContext({
        context: {
          abiVersion: CHARACTER_ABI_2D_VERSION,
          sections: []
        },
        cognitionProjection: cognitionProjection(),
        budget: {
          maxSections: 2,
          maxSemanticCharacters: 100
        },
        model: "deepseek"
      })
    ).toThrow(/unknown field: model/);
  });

  it("counts every structured cognition semantic string before reserving regular budget", () => {
    const result = assembleCharacterHarnessPostCognitionContext({
      context: {
        abiVersion: CHARACTER_ABI_2D_VERSION,
        sections: [{ kind: "IDENTITY", state: "KNOWN", summary: "Y" }]
      },
      cognitionProjection: {
        version: CHARACTER_HARNESS_5I_VERSION,
        section: {
          kind: "COGNITION_RESULT",
          result: {
            version: NORMALIZED_COGNITION_RESULT_VERSION,
            status: "PARTIAL",
            answer: "aa",
            keyFacts: ["bbb"],
            evidence: [{ reference: "r", statement: "ssss" }],
            uncertainty: ["uu"],
            caveats: ["c"]
          }
        }
      },
      budget: {
        maxSections: 2,
        maxSemanticCharacters: 14
      }
    });

    expect(result.status).toBe("ACCEPTED");
    if (result.status === "ACCEPTED") {
      // cognition = 2 + 3 + 1 + 4 + 2 + 1 = 13; regular identity = 1
      expect(result.usedSemanticCharacters).toBe(14);
      expect(result.context.sections.map((section) => section.kind)).toEqual([
        "IDENTITY",
        "COGNITION_RESULT"
      ]);
    }
  });
});
