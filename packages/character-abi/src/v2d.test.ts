import { describe, expect, it } from "vitest";
import {
  CHARACTER_ABI_2A_VERSION,
  NORMALIZED_COGNITION_RESULT_VERSION,
  createCharacterAbiContext
} from "./index.js";
import {
  CHARACTER_ABI_2D_VERSION,
  createCharacterAbi2DContext
} from "./v2d.js";

function successResult() {
  return {
    version: NORMALIZED_COGNITION_RESULT_VERSION,
    status: "SUCCESS",
    answer: "42",
    keyFacts: ["The answer was computed by Cognition."],
    evidence: [
      {
        reference: "cognition:evidence:1",
        statement: "Authoritative normalized evidence stays structured."
      }
    ],
    uncertainty: ["None material."],
    caveats: ["Character still decides expression."]
  } as const;
}

describe("Character ABI 2D structured cognition result", () => {
  it("preserves ordinary sections and a structured cognition result without flattening", () => {
    const result = createCharacterAbi2DContext({
      abiVersion: CHARACTER_ABI_2D_VERSION,
      sections: [
        {
          kind: "IDENTITY",
          state: "KNOWN",
          summary: "Yuvi",
          provenanceReferences: ["p8:identity"]
        },
        {
          kind: "COGNITION_RESULT",
          result: successResult()
        }
      ]
    });

    expect(result).toEqual({
      abiVersion: CHARACTER_ABI_2D_VERSION,
      sections: [
        {
          kind: "IDENTITY",
          state: "KNOWN",
          summary: "Yuvi",
          provenanceReferences: ["p8:identity"]
        },
        {
          kind: "COGNITION_RESULT",
          result: successResult()
        }
      ]
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.sections)).toBe(true);
    const cognition = result.sections[1];
    expect(cognition?.kind).toBe("COGNITION_RESULT");
    if (cognition?.kind === "COGNITION_RESULT") {
      expect(Object.isFrozen(cognition)).toBe(true);
      expect(Object.isFrozen(cognition.result)).toBe(true);
      expect(cognition.result.answer).toBe("42");
      expect(cognition.result.evidence?.[0]?.statement).toContain("stays structured");
    }
  });

  it.each(["PARTIAL", "UNAVAILABLE", "CANCELLED", "UNSAFE_TO_ANSWER", "ERROR"] as const)(
    "preserves normalized cognition status %s without inventing an epistemic-state mapping",
    (status) => {
      const context = createCharacterAbi2DContext({
        abiVersion: CHARACTER_ABI_2D_VERSION,
        sections: [
          {
            kind: "COGNITION_RESULT",
            result: {
              version: NORMALIZED_COGNITION_RESULT_VERSION,
              status,
              ...(status === "PARTIAL" ? { answer: "Partial answer." } : {})
            }
          }
        ]
      });

      const section = context.sections[0];
      expect(section?.kind).toBe("COGNITION_RESULT");
      if (section?.kind === "COGNITION_RESULT") {
        expect(section.result.status).toBe(status);
        expect("state" in section).toBe(false);
        expect("summary" in section).toBe(false);
      }
    }
  );

  it("rejects legacy summary/state projection for 2D COGNITION_RESULT", () => {
    expect(() =>
      createCharacterAbi2DContext({
        abiVersion: CHARACTER_ABI_2D_VERSION,
        sections: [
          {
            kind: "COGNITION_RESULT",
            state: "KNOWN",
            summary: "Do not flatten normalized cognition."
          }
        ]
      })
    ).toThrow(/unknown field/);
  });

  it("rejects structured result payloads on ordinary sections", () => {
    expect(() =>
      createCharacterAbi2DContext({
        abiVersion: CHARACTER_ABI_2D_VERSION,
        sections: [
          {
            kind: "IDENTITY",
            state: "KNOWN",
            summary: "Yuvi",
            result: successResult()
          }
        ]
      })
    ).toThrow(/unknown field: result/);
  });

  it("carries the explicit output-language preference as semantic context", () => {
    const result = createCharacterAbi2DContext({
      abiVersion: CHARACTER_ABI_2D_VERSION,
      outputLanguage: "ZH",
      sections: []
    });

    expect(result.outputLanguage).toBe("ZH");
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("rejects unsupported output-language values at the Character ABI boundary", () => {
    expect(() =>
      createCharacterAbi2DContext({
        abiVersion: CHARACTER_ABI_2D_VERSION,
        outputLanguage: "FR",
        sections: []
      })
    ).toThrow(/outputLanguage is invalid/);
  });

  it("keeps section kinds unique across regular and cognition sections", () => {
    expect(() =>
      createCharacterAbi2DContext({
        abiVersion: CHARACTER_ABI_2D_VERSION,
        sections: [
          { kind: "COGNITION_RESULT", result: successResult() },
          { kind: "COGNITION_RESULT", result: successResult() }
        ]
      })
    ).toThrow(/section kind must be unique: COGNITION_RESULT/);
  });

  it("delegates normalized cognition validation and rejects backend leakage", () => {
    expect(() =>
      createCharacterAbi2DContext({
        abiVersion: CHARACTER_ABI_2D_VERSION,
        sections: [
          {
            kind: "COGNITION_RESULT",
            result: {
              ...successResult(),
              provider: "deepinfra"
            }
          }
        ]
      })
    ).toThrow(/unknown field: provider/);
  });

  it("does not silently treat 2A and 2D envelopes as interchangeable", () => {
    expect(() =>
      createCharacterAbi2DContext({
        abiVersion: CHARACTER_ABI_2A_VERSION,
        sections: []
      })
    ).toThrow(/Character ABI 2D version/);

    expect(() =>
      createCharacterAbiContext({
        abiVersion: CHARACTER_ABI_2A_VERSION,
        sections: [
          {
            kind: "COGNITION_RESULT",
            result: successResult()
          }
        ]
      })
    ).toThrow(/unknown field: result/);
  });
});
