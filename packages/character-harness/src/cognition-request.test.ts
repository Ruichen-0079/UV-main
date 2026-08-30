import { describe, expect, it } from "vitest";
import {
  interpretCharacterHarnessOutput,
  superviseCharacterHarnessGeneration,
  superviseCharacterHarnessRepetition
} from "./index.js";
import {
  CHARACTER_HARNESS_5G_VERSION,
  createCharacterHarnessCognitionRequest
} from "./cognition-request.js";

function supervised(proposal: unknown) {
  const generation = superviseCharacterHarnessGeneration({
    interpretation: interpretCharacterHarnessOutput(proposal),
    finishReason: "stop",
    maxResponseCharacters: 8000
  });

  return superviseCharacterHarnessRepetition({
    generation,
    ngramCharacters: 4,
    maxOccurrences: 2
  });
}

describe("Character Harness 5G cognition request seam", () => {
  it("translates a supervised NEED_COGNITION proposal with focus", () => {
    expect(
      createCharacterHarnessCognitionRequest({
        generation: supervised({
          disposition: "NEED_COGNITION",
          focus: "Verify the current factual claim."
        })
      })
    ).toEqual({
      version: CHARACTER_HARNESS_5G_VERSION,
      kind: "NEED_COGNITION",
      focus: "Verify the current factual claim."
    });
  });

  it("preserves a coarse NEED_COGNITION request without inventing focus", () => {
    expect(
      createCharacterHarnessCognitionRequest({
        generation: supervised({ disposition: "NEED_COGNITION" })
      })
    ).toEqual({
      version: CHARACTER_HARNESS_5G_VERSION,
      kind: "NEED_COGNITION"
    });
  });

  it.each([
    { disposition: "RESPOND", text: "Normal answer." },
    { disposition: "SILENCE" },
    { disposition: "TERMINATE" }
  ])("rejects non-cognition Character disposition %#", (proposal) => {
    expect(() =>
      createCharacterHarnessCognitionRequest({ generation: supervised(proposal) })
    ).toThrow(/requires NEED_COGNITION/);
  });

  it("requires the fully supervised 5D envelope rather than an earlier generation stage", () => {
    const generation = superviseCharacterHarnessGeneration({
      interpretation: interpretCharacterHarnessOutput({ disposition: "NEED_COGNITION" }),
      finishReason: "stop",
      maxResponseCharacters: 8000
    });

    expect(() =>
      createCharacterHarnessCognitionRequest({ generation })
    ).toThrow(/requires an accepted 5D generation/);
  });

  it("revalidates the Character proposal and rejects capability/provider leakage", () => {
    for (const proposal of [
      { disposition: "NEED_COGNITION", toolName: "search" },
      { disposition: "NEED_COGNITION", provider: "deepinfra" },
      { disposition: "NEED_COGNITION", model: "cognition-deep" },
      { disposition: "REQUEST_CAPABILITY", capability: "search" }
    ]) {
      expect(() =>
        createCharacterHarnessCognitionRequest({
          generation: {
            version: "character-harness-5d.v1",
            status: "ACCEPTED",
            proposal
          }
        })
      ).toThrow();
    }
  });

  it("rejects Runtime/provider/model/tool/user-context fields at the request seam", () => {
    const generation = supervised({ disposition: "NEED_COGNITION" });

    for (const extra of [
      { runtimeId: "must-not-cross" },
      { provider: "deepinfra" },
      { model: "deepseek-v4-pro" },
      { toolName: "search" },
      { userPrompt: "raw user prompt" },
      { memory: { raw: true } }
    ]) {
      expect(() =>
        createCharacterHarnessCognitionRequest({ generation, ...extra })
      ).toThrow(/unknown field/);
    }
  });

  it("returns a frozen semantic request", () => {
    const result = createCharacterHarnessCognitionRequest({
      generation: supervised({ disposition: "NEED_COGNITION", focus: "Need reasoning." })
    });

    expect(Object.isFrozen(result)).toBe(true);
  });
});
