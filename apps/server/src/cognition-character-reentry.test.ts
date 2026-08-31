import { describe, expect, it } from "vitest";
import { createServerPostCognitionCharacterRequest } from "./cognition-character-reentry.js";

function roundTrip(answer = "supported") {
  return {
    version: "character-harness-5h.v1",
    request: {
      version: "character-harness-5g.v1",
      kind: "NEED_COGNITION",
      focus: "verify claim"
    },
    result: {
      version: "character-cognition-result.v1",
      status: "SUCCESS",
      answer
    }
  } as const;
}

function baseContext() {
  return {
    abiVersion: "character-abi-2d.v1",
    sections: [
      {
        kind: "IDENTITY",
        state: "KNOWN",
        summary: "Yuvi"
      },
      {
        kind: "PERSONA",
        state: "KNOWN",
        summary: "Calm"
      }
    ]
  } as const;
}

describe("Server 6T post-cognition Character request composition", () => {
  it("composes 5I -> accepted 5K -> 5L without reinterpreting the Cognition result", () => {
    const result = createServerPostCognitionCharacterRequest({
      roundTrip: roundTrip("The claim is supported."),
      context: baseContext(),
      budget: {
        maxSections: 3,
        maxSemanticCharacters: 100
      }
    });

    expect(result).toEqual({
      version: "character-harness-5l.v1",
      kind: "CHARACTER_GENERATION",
      context: {
        abiVersion: "character-abi-2d.v1",
        sections: [
          {
            kind: "IDENTITY",
            state: "KNOWN",
            summary: "Yuvi"
          },
          {
            kind: "PERSONA",
            state: "KNOWN",
            summary: "Calm"
          },
          {
            kind: "COGNITION_RESULT",
            result: {
              version: "character-cognition-result.v1",
              status: "SUCCESS",
              answer: "The claim is supported."
            }
          }
        ]
      }
    });
    expect(Object.isFrozen(result)).toBe(true);
    if ("context" in result) {
      expect(Object.isFrozen(result.context)).toBe(true);
    }
  });

  it("returns the existing 5K over-budget rejection unchanged instead of dropping Cognition", () => {
    const result = createServerPostCognitionCharacterRequest({
      roundTrip: roundTrip("too large"),
      context: baseContext(),
      budget: {
        maxSections: 3,
        maxSemanticCharacters: 2
      }
    });

    expect(result).toEqual({
      version: "character-harness-5k.v1",
      status: "COGNITION_RESULT_OVER_BUDGET",
      reason: "MANDATORY_COGNITION_RESULT_EXCEEDS_BUDGET",
      requiredSections: 1,
      availableSections: 3,
      requiredSemanticCharacters: 9,
      availableSemanticCharacters: 2
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("CHARACTER_GENERATION");
  });

  it("fails closed on malformed 5H round-trips before producing an adapter request", () => {
    expect(() =>
      createServerPostCognitionCharacterRequest({
        roundTrip: { ...roundTrip(), toolName: "read_text_file" },
        context: baseContext(),
        budget: {
          maxSections: 3,
          maxSemanticCharacters: 100
        }
      })
    ).toThrow(/unknown field/);
  });

  it("delegates duplicate Cognition-result protection and budget validation to Harness", () => {
    expect(() =>
      createServerPostCognitionCharacterRequest({
        roundTrip: roundTrip(),
        context: {
          abiVersion: "character-abi-2d.v1",
          sections: [
            {
              kind: "COGNITION_RESULT",
              result: {
                version: "character-cognition-result.v1",
                status: "SUCCESS",
                answer: "already present"
              }
            }
          ]
        },
        budget: {
          maxSections: 3,
          maxSemanticCharacters: 100
        }
      })
    ).toThrow(/must not already contain COGNITION_RESULT/);

    expect(() =>
      createServerPostCognitionCharacterRequest({
        roundTrip: roundTrip(),
        context: baseContext(),
        budget: {
          maxSections: 999,
          maxSemanticCharacters: 100
        }
      })
    ).toThrow(/integer between/);
  });

  it("does not introduce provider, model, MCP, execution, or Runtime-state fields", () => {
    const result = createServerPostCognitionCharacterRequest({
      roundTrip: roundTrip(),
      context: baseContext(),
      budget: {
        maxSections: 3,
        maxSemanticCharacters: 100
      }
    });
    const serialized = JSON.stringify(result);

    for (const forbidden of [
      "provider",
      "model",
      "toolName",
      "mcp",
      "temperature",
      "maxTokens",
      "capabilityRoundsUsed",
      "runtimeAuthorizedPath"
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
