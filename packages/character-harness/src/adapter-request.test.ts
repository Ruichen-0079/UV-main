import { describe, expect, it } from "vitest";
import { NORMALIZED_COGNITION_RESULT_VERSION } from "../../character-abi/src/index.js";
import { CHARACTER_ABI_2D_VERSION } from "../../character-abi/src/v2d.js";
import {
  CHARACTER_HARNESS_5J_VERSION,
  assembleCharacterHarness2DContext
} from "./assembly-v2d.js";
import { CHARACTER_HARNESS_5I_VERSION } from "./cognition-section.js";
import {
  assembleCharacterHarnessPostCognitionContext
} from "./post-cognition-assembly.js";
import {
  CHARACTER_HARNESS_5L_VERSION,
  createCharacterHarnessAdapterRequest
} from "./adapter-request.js";

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
        state: "PARTIAL",
        summary: "Grounded persona context.",
        provenanceReferences: ["p8:persona"]
      }
    ]
  } as const;
}

function cognitionProjection() {
  return {
    version: CHARACTER_HARNESS_5I_VERSION,
    section: {
      kind: "COGNITION_RESULT",
      result: {
        version: NORMALIZED_COGNITION_RESULT_VERSION,
        status: "SUCCESS",
        answer: "Verified cognition result.",
        keyFacts: ["Fact one."],
        evidence: [
          {
            reference: "evidence:1",
            statement: "Bounded evidence."
          }
        ]
      }
    }
  } as const;
}

describe("Character Harness 5L adapter request seam", () => {
  it("accepts a real 5J bounded assembly and strips Harness diagnostics", () => {
    const assembly = assembleCharacterHarness2DContext({
      context: regularContext(),
      budget: {
        maxSections: 10,
        maxSemanticCharacters: 1000
      }
    });

    const request = createCharacterHarnessAdapterRequest({ assembly });

    expect(request).toEqual({
      version: CHARACTER_HARNESS_5L_VERSION,
      kind: "CHARACTER_GENERATION",
      context: assembly.context
    });
    expect("omittedSectionKinds" in request).toBe(false);
    expect("usedSemanticCharacters" in request).toBe(false);
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.context)).toBe(true);
  });

  it("accepts a real successful 5K post-cognition assembly and preserves structured cognition", () => {
    const assembly = assembleCharacterHarnessPostCognitionContext({
      context: regularContext(),
      cognitionProjection: cognitionProjection(),
      budget: {
        maxSections: 10,
        maxSemanticCharacters: 1000
      }
    });

    expect(assembly.status).toBe("ACCEPTED");
    if (assembly.status !== "ACCEPTED") {
      throw new Error("expected accepted 5K fixture");
    }

    const request = createCharacterHarnessAdapterRequest({ assembly });
    const cognition = request.context.sections.find(
      (section) => section.kind === "COGNITION_RESULT"
    );

    expect(request.kind).toBe("CHARACTER_GENERATION");
    expect(cognition?.kind).toBe("COGNITION_RESULT");
    if (cognition?.kind === "COGNITION_RESULT") {
      expect(cognition.result.answer).toBe("Verified cognition result.");
      expect(cognition.result.evidence?.[0]?.reference).toBe("evidence:1");
    }
  });

  it("rejects a non-accepted 5K assembly rather than manufacturing a Character request", () => {
    const rejected = assembleCharacterHarnessPostCognitionContext({
      context: {
        abiVersion: CHARACTER_ABI_2D_VERSION,
        sections: []
      },
      cognitionProjection: cognitionProjection(),
      budget: {
        maxSections: 0,
        maxSemanticCharacters: 0
      }
    });

    expect(rejected.status).toBe("COGNITION_RESULT_OVER_BUDGET");
    expect(() => createCharacterHarnessAdapterRequest({ assembly: rejected })).toThrow();
  });

  it("rejects raw ABI context and unsupported assembly versions", () => {
    expect(() =>
      createCharacterHarnessAdapterRequest({
        assembly: regularContext()
      })
    ).toThrow(/requires a 5J or accepted 5K assembly/);

    expect(() =>
      createCharacterHarnessAdapterRequest({
        assembly: {
          version: "character-harness-future.v1",
          context: regularContext(),
          omittedSectionKinds: [],
          usedSemanticCharacters: 0
        }
      })
    ).toThrow(/requires a 5J or accepted 5K assembly/);
  });

  it("fails closed when a claimed 5J semantic-character total does not match its context", () => {
    const real = assembleCharacterHarness2DContext({
      context: regularContext(),
      budget: {
        maxSections: 10,
        maxSemanticCharacters: 1000
      }
    });

    expect(() =>
      createCharacterHarnessAdapterRequest({
        assembly: {
          ...real,
          usedSemanticCharacters: real.usedSemanticCharacters + 1
        }
      })
    ).toThrow(/does not match the bounded context/);
  });

  it("fails closed on malformed omitted-section diagnostics", () => {
    expect(() =>
      createCharacterHarnessAdapterRequest({
        assembly: {
          version: CHARACTER_HARNESS_5J_VERSION,
          context: {
            abiVersion: CHARACTER_ABI_2D_VERSION,
            sections: []
          },
          omittedSectionKinds: ["PERSONA", "PERSONA"],
          usedSemanticCharacters: 0
        }
      })
    ).toThrow(/must be unique/);

    expect(() =>
      createCharacterHarnessAdapterRequest({
        assembly: {
          version: CHARACTER_HARNESS_5J_VERSION,
          context: {
            abiVersion: CHARACTER_ABI_2D_VERSION,
            sections: []
          },
          omittedSectionKinds: ["PROVIDER_INTERNAL"],
          usedSemanticCharacters: 0
        }
      })
    ).toThrow(/invalid kind/);
  });

  it("keeps provider/model/generation knobs outside the stable request", () => {
    const assembly = assembleCharacterHarness2DContext({
      context: regularContext(),
      budget: {
        maxSections: 10,
        maxSemanticCharacters: 1000
      }
    });

    for (const extra of [
      { model: "character-checkpoint" },
      { provider: "deepinfra" },
      { temperature: 0.7 },
      { maxTokens: 512 },
      { promptTemplate: "vendor-format" }
    ]) {
      expect(() =>
        createCharacterHarnessAdapterRequest({
          assembly,
          ...extra
        })
      ).toThrow(/unknown field/);
    }

    const request = createCharacterHarnessAdapterRequest({ assembly });
    const serialized = JSON.stringify(request);
    for (const forbidden of [
      "model",
      "provider",
      "temperature",
      "maxTokens",
      "promptTemplate",
      "traceId",
      "sessionId"
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
