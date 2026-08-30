import { describe, expect, it } from "vitest";
import {
  interpretCharacterHarnessOutput,
  superviseCharacterHarnessGeneration,
  superviseCharacterHarnessRepetition
} from "./index.js";
import {
  createCharacterHarnessCognitionRequest
} from "./cognition-request.js";
import {
  CHARACTER_HARNESS_5H_VERSION,
  createCharacterHarnessCognitionRoundTrip
} from "./cognition-result.js";

function request(focus?: string) {
  const generation = superviseCharacterHarnessGeneration({
    interpretation: interpretCharacterHarnessOutput({
      disposition: "NEED_COGNITION",
      ...(focus === undefined ? {} : { focus })
    }),
    finishReason: "stop",
    maxResponseCharacters: 8000
  });
  const supervised = superviseCharacterHarnessRepetition({
    generation,
    ngramCharacters: 4,
    maxOccurrences: 2
  });

  return createCharacterHarnessCognitionRequest({ generation: supervised });
}

describe("Character Harness 5H normalized cognition round-trip", () => {
  it("preserves a validated structured SUCCESS result without summarizing it", () => {
    const cognitionRequest = request("Verify the claim and return evidence.");
    const normalizedResult = {
      version: "character-cognition-result.v1",
      status: "SUCCESS",
      answer: "The claim is supported by the available evidence.",
      keyFacts: ["Fact A", "Fact B"],
      evidence: [
        { reference: "evidence:1", statement: "Supporting statement one." },
        { reference: "evidence:2", statement: "Supporting statement two." }
      ],
      uncertainty: ["One source is indirect."],
      caveats: ["The result may become stale."]
    } as const;

    expect(
      createCharacterHarnessCognitionRoundTrip({
        request: cognitionRequest,
        result: normalizedResult
      })
    ).toEqual({
      version: CHARACTER_HARNESS_5H_VERSION,
      request: cognitionRequest,
      result: normalizedResult
    });
  });

  it.each(["PARTIAL", "UNAVAILABLE", "CANCELLED", "UNSAFE_TO_ANSWER", "ERROR"] as const)(
    "preserves normalized non-success status %s without inventing an answer",
    (status) => {
      const result = createCharacterHarnessCognitionRoundTrip({
        request: request(),
        result: {
          version: "character-cognition-result.v1",
          status
        }
      });

      expect(result.result).toEqual({
        version: "character-cognition-result.v1",
        status
      });
      expect("answer" in result.result).toBe(false);
    }
  );

  it("uses the Character ABI validator rather than accepting raw cognition backend output", () => {
    for (const extra of [
      { provider: "deepinfra" },
      { model: "deepseek-v4-pro" },
      { rawChainOfThought: "hidden reasoning" },
      { toolTrace: [{ tool: "search" }] },
      { requestCapability: "browser" }
    ]) {
      expect(() =>
        createCharacterHarnessCognitionRoundTrip({
          request: request(),
          result: {
            version: "character-cognition-result.v1",
            status: "SUCCESS",
            answer: "Bounded answer.",
            ...extra
          }
        })
      ).toThrow(/unknown field/);
    }
  });

  it("preserves normalized result invariants instead of weakening them", () => {
    expect(() =>
      createCharacterHarnessCognitionRoundTrip({
        request: request(),
        result: {
          version: "character-cognition-result.v1",
          status: "SUCCESS"
        }
      })
    ).toThrow(/requires a non-empty answer/);
  });

  it("revalidates the 5G request and rejects Runtime/provider/tool leakage", () => {
    for (const forgedRequest of [
      { ...request(), version: "character-harness-5g.future" },
      { ...request(), kind: "REQUEST_CAPABILITY" },
      { ...request(), provider: "deepinfra" },
      { ...request(), model: "cognition-deep" },
      { ...request(), toolName: "search" },
      { ...request(), runtimeId: "must-not-cross" }
    ]) {
      expect(() =>
        createCharacterHarnessCognitionRoundTrip({
          request: forgedRequest,
          result: {
            version: "character-cognition-result.v1",
            status: "SUCCESS",
            answer: "Bounded answer."
          }
        })
      ).toThrow();
    }
  });

  it("rejects extra fields on the round-trip envelope", () => {
    expect(() =>
      createCharacterHarnessCognitionRoundTrip({
        request: request(),
        result: {
          version: "character-cognition-result.v1",
          status: "SUCCESS",
          answer: "Bounded answer."
        },
        provider: "must-not-cross"
      })
    ).toThrow(/unknown field: provider/);
  });

  it("returns a frozen envelope with already-frozen normalized content", () => {
    const result = createCharacterHarnessCognitionRoundTrip({
      request: request("Need verification."),
      result: {
        version: "character-cognition-result.v1",
        status: "SUCCESS",
        answer: "Verified answer.",
        keyFacts: ["Fact"]
      }
    });

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.request)).toBe(true);
    expect(Object.isFrozen(result.result)).toBe(true);
    expect(Object.isFrozen(result.result.keyFacts)).toBe(true);
  });
});
