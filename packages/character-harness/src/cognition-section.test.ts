import { describe, expect, it } from "vitest";
import { NORMALIZED_COGNITION_RESULT_VERSION } from "../../character-abi/src/index.js";
import {
  CHARACTER_HARNESS_5G_VERSION
} from "./cognition-request.js";
import {
  CHARACTER_HARNESS_5H_VERSION,
  createCharacterHarnessCognitionRoundTrip
} from "./cognition-result.js";
import {
  CHARACTER_HARNESS_5I_VERSION,
  createCharacterHarnessCognitionResultSection
} from "./cognition-section.js";

function roundTrip(status: "SUCCESS" | "PARTIAL" | "UNAVAILABLE" = "SUCCESS") {
  return createCharacterHarnessCognitionRoundTrip({
    request: {
      version: CHARACTER_HARNESS_5G_VERSION,
      kind: "NEED_COGNITION",
      focus: "Verify the result."
    },
    result: {
      version: NORMALIZED_COGNITION_RESULT_VERSION,
      status,
      ...(status === "SUCCESS" ? { answer: "Verified answer." } : {}),
      keyFacts: ["Fact A"],
      evidence: [
        {
          reference: "evidence:1",
          statement: "Evidence remains structured."
        }
      ],
      uncertainty: ["Bounded uncertainty."],
      caveats: ["Bounded caveat."]
    }
  });
}

describe("Character Harness 5I cognition-result section projection", () => {
  it("projects a validated 5H round-trip into a structured 2D cognition section", () => {
    const result = createCharacterHarnessCognitionResultSection(roundTrip());

    expect(result).toEqual({
      version: CHARACTER_HARNESS_5I_VERSION,
      section: {
        kind: "COGNITION_RESULT",
        result: {
          version: NORMALIZED_COGNITION_RESULT_VERSION,
          status: "SUCCESS",
          answer: "Verified answer.",
          keyFacts: ["Fact A"],
          evidence: [
            {
              reference: "evidence:1",
              statement: "Evidence remains structured."
            }
          ],
          uncertainty: ["Bounded uncertainty."],
          caveats: ["Bounded caveat."]
        }
      }
    });
    expect("state" in result.section).toBe(false);
    expect("summary" in result.section).toBe(false);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.section)).toBe(true);
    expect(Object.isFrozen(result.section.result)).toBe(true);
  });

  it.each(["PARTIAL", "UNAVAILABLE"] as const)(
    "preserves normalized cognition status %s without mapping it",
    (status) => {
      const projection = createCharacterHarnessCognitionResultSection(roundTrip(status));
      expect(projection.section.result.status).toBe(status);
    }
  );

  it("revalidates the 5H envelope instead of trusting a forged version", () => {
    expect(() =>
      createCharacterHarnessCognitionResultSection({
        ...roundTrip(),
        version: "character-harness-5h.future"
      })
    ).toThrow(/requires character-harness-5h.v1/);
  });

  it("rejects request/provider leakage at the section seam", () => {
    expect(() =>
      createCharacterHarnessCognitionResultSection({
        ...roundTrip(),
        provider: "deepinfra"
      })
    ).toThrow(/unknown field: provider/);
  });

  it("delegates result validation and rejects backend metadata", () => {
    const valid = roundTrip();
    expect(() =>
      createCharacterHarnessCognitionResultSection({
        version: CHARACTER_HARNESS_5H_VERSION,
        request: valid.request,
        result: {
          ...valid.result,
          model: "must-not-cross"
        }
      })
    ).toThrow(/unknown field: model/);
  });

  it("does not carry the cognition request into the model-facing result section", () => {
    const projection = createCharacterHarnessCognitionResultSection(roundTrip());
    expect("request" in projection.section).toBe(false);
    expect(JSON.stringify(projection.section)).not.toContain("Verify the result");
  });
});
