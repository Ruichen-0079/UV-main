import { describe, expect, it } from "vitest";
import {
  CHARACTER_HARNESS_5H_VERSION,
  createCharacterHarnessCognitionRoundTrip
} from "@companion/character-harness/cognition-result";
import {
  CHARACTER_HARNESS_5K_VERSION
} from "@companion/character-harness/post-cognition-assembly";
import {
  CHARACTER_HARNESS_5L_VERSION
} from "@companion/character-harness/adapter-request";
import {
  createServerPostCapabilityCharacterRequest
} from "./cognition-post-capability-character-request.js";

function createRoundTrip(answer = "The capability evidence supports the claim.") {
  return createCharacterHarnessCognitionRoundTrip({
    request: {
      version: "character-harness-5g.v1",
      kind: "NEED_COGNITION",
      focus: "Verify the claim with the admitted capability."
    },
    result: {
      status: "SUCCESS",
      answer,
      keyFacts: ["Evidence was read through the admitted capability."],
      evidence: [
        {
          reference: "capability-observation:1",
          statement: "The authorized evidence supports the claim."
        }
      ],
      uncertainty: [],
      caveats: []
    }
  });
}

function createBaseContext() {
  return {
    abiVersion: "character-abi-2d.v1",
    sections: [
      {
        kind: "IDENTITY",
        state: "KNOWN",
        summary: "Yuvi"
      },
      {
        kind: "CURRENT_SITUATION",
        state: "KNOWN",
        summary: "Answering the current user turn."
      }
    ]
  };
}

describe("Server 6T post-capability Character request composition", () => {
  it("composes 5H -> 5I -> 5K -> 5L while preserving regular order and appending cognition last", () => {
    const outcome = createServerPostCapabilityCharacterRequest({
      roundTrip: createRoundTrip(),
      context: createBaseContext(),
      budget: {
        maxSections: 3,
        maxSemanticCharacters: 2_000
      }
    });

    expect(outcome).toMatchObject({
      version: CHARACTER_HARNESS_5L_VERSION,
      kind: "CHARACTER_GENERATION",
      context: {
        abiVersion: "character-abi-2d.v1"
      }
    });

    if (!("kind" in outcome) || outcome.kind !== "CHARACTER_GENERATION") {
      throw new Error("Expected a 5L Character generation request.");
    }

    expect(outcome.context.sections.map((section) => section.kind)).toEqual([
      "IDENTITY",
      "CURRENT_SITUATION",
      "COGNITION_RESULT"
    ]);
    const cognition = outcome.context.sections[2];
    expect(cognition).toMatchObject({
      kind: "COGNITION_RESULT",
      result: {
        status: "SUCCESS",
        answer: "The capability evidence supports the claim."
      }
    });
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(Object.isFrozen(outcome.context)).toBe(true);
  });

  it("returns the existing 5K over-budget rejection unchanged instead of fabricating a generation request", () => {
    const outcome = createServerPostCapabilityCharacterRequest({
      roundTrip: createRoundTrip("A result that cannot fit."),
      context: createBaseContext(),
      budget: {
        maxSections: 0,
        maxSemanticCharacters: 0
      }
    });

    expect(outcome).toEqual({
      version: CHARACTER_HARNESS_5K_VERSION,
      status: "COGNITION_RESULT_OVER_BUDGET",
      reason: "MANDATORY_COGNITION_RESULT_EXCEEDS_BUDGET",
      requiredSections: 1,
      availableSections: 0,
      requiredSemanticCharacters: expect.any(Number),
      availableSemanticCharacters: 0
    });
    expect("kind" in outcome).toBe(false);
    expect(Object.isFrozen(outcome)).toBe(true);
  });

  it("fails closed when the base context already contains a cognition result", () => {
    expect(() =>
      createServerPostCapabilityCharacterRequest({
        roundTrip: createRoundTrip(),
        context: {
          abiVersion: "character-abi-2d.v1",
          sections: [
            {
              kind: "COGNITION_RESULT",
              result: {
                status: "SUCCESS",
                answer: "stale result"
              }
            }
          ]
        },
        budget: {
          maxSections: 2,
          maxSemanticCharacters: 2_000
        }
      })
    ).toThrow(/must not already contain COGNITION_RESULT/);
  });

  it("revalidates the 5H round-trip before any projection", () => {
    expect(() =>
      createServerPostCapabilityCharacterRequest({
        roundTrip: {
          version: CHARACTER_HARNESS_5H_VERSION,
          request: {
            version: "character-harness-5g.v1",
            kind: "NEED_COGNITION",
            focus: "Verify the claim."
          },
          result: {
            status: "SUCCESS",
            answer: "answer"
          },
          toolName: "read_text_file"
        },
        context: createBaseContext(),
        budget: {
          maxSections: 3,
          maxSemanticCharacters: 2_000
        }
      })
    ).toThrow(/unknown field/);
  });

  it("does not add provider, MCP, capability, prompt, or model execution metadata", () => {
    const outcome = createServerPostCapabilityCharacterRequest({
      roundTrip: createRoundTrip(),
      context: createBaseContext(),
      budget: {
        maxSections: 3,
        maxSemanticCharacters: 2_000
      }
    });

    const serialized = JSON.stringify(outcome);
    for (const forbidden of [
      "read_text_file",
      "mcpServer",
      "provider",
      "model",
      "temperature",
      "promptTemplate",
      "toolName"
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
