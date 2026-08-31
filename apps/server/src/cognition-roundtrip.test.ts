import {
  CHARACTER_HARNESS_5G_VERSION,
  type CharacterHarnessCognitionRequest
} from "@companion/character-harness/cognition-request";
import { CHARACTER_HARNESS_5H_VERSION } from "@companion/character-harness/cognition-result";
import type { ReasoningProvider } from "@companion/providers";
import { describe, expect, it, vi } from "vitest";
import { executeServerCognitionRoundTrip } from "./cognition-roundtrip.js";

const request: CharacterHarnessCognitionRequest = Object.freeze({
  version: CHARACTER_HARNESS_5G_VERSION,
  kind: "NEED_COGNITION",
  focus: "Verify the uncertain claim."
});

function provider(answer: string, generateReasoning = vi.fn()): ReasoningProvider {
  generateReasoning.mockResolvedValue({
    reasoning: "",
    answer,
    finishReason: "stop" as const
  });

  return {
    name: `server-cognition-${answer}`,
    async healthCheck() {
      return {
        provider: `server-cognition-${answer}`,
        status: "healthy" as const,
        checkedAt: new Date().toISOString()
      };
    },
    generateReasoning
  };
}

describe("server cognition round-trip", () => {
  it("composes the existing Runtime, Cognition 6A, and Harness 5H seams", async () => {
    const generateReasoning = vi.fn();
    const reasoningProvider = provider("Verified answer.", generateReasoning);

    const result = await executeServerCognitionRoundTrip({
      providers: { getReasoningProvider: () => reasoningProvider },
      request,
      problem: "Determine the verified answer from the authorized task context."
    });

    expect(generateReasoning).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      version: CHARACTER_HARNESS_5H_VERSION,
      request,
      result: {
        version: "character-cognition-result.v1",
        status: "SUCCESS",
        answer: "Verified answer."
      }
    });
  });

  it("uses the provider resolver supplied to each invocation without stale capture", async () => {
    const firstCall = vi.fn();
    const secondCall = vi.fn();

    const first = await executeServerCognitionRoundTrip({
      providers: { getReasoningProvider: () => provider("first", firstCall) },
      request,
      problem: "First authorized task."
    });
    const second = await executeServerCognitionRoundTrip({
      providers: { getReasoningProvider: () => provider("second", secondCall) },
      request,
      problem: "Second authorized task."
    });

    expect(first.result).toMatchObject({ status: "SUCCESS", answer: "first" });
    expect(second.result).toMatchObject({ status: "SUCCESS", answer: "second" });
    expect(firstCall).toHaveBeenCalledTimes(1);
    expect(secondCall).toHaveBeenCalledTimes(1);
  });

  it("fails closed on an invalid 5G request before selecting a provider", async () => {
    const getReasoningProvider = vi.fn(() => provider("must not run"));
    const invalidRequest = {
      version: "character-harness-future.v1",
      kind: "NEED_COGNITION"
    } as unknown as CharacterHarnessCognitionRequest;

    await expect(
      executeServerCognitionRoundTrip({
        providers: { getReasoningProvider },
        request: invalidRequest,
        problem: "This must fail before provider selection."
      })
    ).rejects.toThrow(/requires a Character Harness 5G NEED_COGNITION request/);

    expect(getReasoningProvider).not.toHaveBeenCalled();
  });
});
