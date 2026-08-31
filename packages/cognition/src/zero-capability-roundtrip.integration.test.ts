import { describe, expect, it, vi } from "vitest";
import {
  ProviderError,
  ProviderErrorCode,
  type ReasoningOutput,
  type ReasoningProvider
} from "../../providers/src/index.js";
import { executeRuntimeCognitionOnce } from "../../core/src/runtime-cognition-one-shot.js";
import {
  CHARACTER_HARNESS_5G_VERSION,
  type CharacterHarnessCognitionRequest
} from "../../character-harness/src/cognition-request.js";
import {
  CHARACTER_HARNESS_5H_VERSION,
  createCharacterHarnessCognitionRoundTrip
} from "../../character-harness/src/cognition-result.js";
import {
  COGNITION_6A_VERSION,
  createCognitionFailureResult,
  createCognitionReasoningInput,
  normalizeCognitionReasoningOutput
} from "./index.js";

const request: CharacterHarnessCognitionRequest = Object.freeze({
  version: CHARACTER_HARNESS_5G_VERSION,
  kind: "NEED_COGNITION",
  focus: "Verify the uncertain claim."
});

const boundary = Object.freeze({
  createReasoningInput: createCognitionReasoningInput,
  normalizeReasoningOutput: normalizeCognitionReasoningOutput,
  createFailureResult: createCognitionFailureResult
});

function task(escalation: unknown = request) {
  return Object.freeze({
    version: COGNITION_6A_VERSION,
    escalation,
    problem: "Determine the verified answer from the Runtime-authorized task context."
  });
}

function reasoningProvider(output: ReasoningOutput): ReasoningProvider {
  return {
    name: "phase-6c-reasoning",
    async healthCheck() {
      return {
        provider: "phase-6c-reasoning",
        status: "healthy" as const,
        checkedAt: new Date().toISOString()
      };
    },
    async generateReasoning() {
      return output;
    }
  };
}

describe("Phase 6C zero-capability cognition round-trip", () => {
  it("closes 5G -> 6A -> 6B -> 6A -> 5H with one reasoning call", async () => {
    const generateReasoning = vi.fn(async () => ({
      reasoning: "",
      answer: "Verified answer.",
      finishReason: "stop" as const,
      provider: "must-not-cross",
      model: "must-not-cross-model",
      requestId: "must-not-cross-request"
    }));
    const provider: ReasoningProvider = {
      ...reasoningProvider({ reasoning: "", answer: "unused", finishReason: "stop" }),
      generateReasoning
    };

    const result = await executeRuntimeCognitionOnce({
      providers: { getReasoningProvider: () => provider },
      boundary,
      task: task()
    });
    const roundTrip = createCharacterHarnessCognitionRoundTrip({ request, result });

    expect(generateReasoning).toHaveBeenCalledTimes(1);
    expect(roundTrip).toEqual({
      version: CHARACTER_HARNESS_5H_VERSION,
      request,
      result: {
        version: "character-cognition-result.v1",
        status: "SUCCESS",
        answer: "Verified answer."
      }
    });
    const serialized = JSON.stringify(roundTrip);
    expect(serialized).not.toContain("must-not-cross");
    expect(serialized).not.toContain("provider");
    expect(serialized).not.toContain("requestId");
  });

  it("carries Runtime provider unavailability through 6A into a valid 5H result", async () => {
    const result = await executeRuntimeCognitionOnce({
      providers: {
        getReasoningProvider() {
          throw new ProviderError({
            provider: "missing-reasoning",
            capability: "reasoning",
            code: ProviderErrorCode.ProviderUnavailable,
            message: "reasoning unavailable",
            retryable: false
          });
        }
      },
      boundary,
      task: task()
    });

    expect(createCharacterHarnessCognitionRoundTrip({ request, result })).toEqual({
      version: CHARACTER_HARNESS_5H_VERSION,
      request,
      result: {
        version: "character-cognition-result.v1",
        status: "UNAVAILABLE"
      }
    });
  });

  it("reduces malformed provider output to ERROR before 5H without exposing raw reasoning", async () => {
    const provider = reasoningProvider({
      reasoning: "raw chain of thought must not cross",
      answer: "unsafe boundary output",
      finishReason: "stop"
    });

    const result = await executeRuntimeCognitionOnce({
      providers: { getReasoningProvider: () => provider },
      boundary,
      task: task()
    });
    const roundTrip = createCharacterHarnessCognitionRoundTrip({ request, result });

    expect(roundTrip.result).toEqual({
      version: "character-cognition-result.v1",
      status: "ERROR"
    });
    expect(JSON.stringify(roundTrip)).not.toContain("chain of thought");
    expect(JSON.stringify(roundTrip)).not.toContain("unsafe boundary output");
  });

  it("fails closed on an invalid 5G escalation before Runtime selects a provider", async () => {
    const getReasoningProvider = vi.fn(() =>
      reasoningProvider({ reasoning: "", answer: "must not run", finishReason: "stop" })
    );

    await expect(
      executeRuntimeCognitionOnce({
        providers: { getReasoningProvider },
        boundary,
        task: task({
          version: "character-harness-future.v1",
          kind: "NEED_COGNITION"
        })
      })
    ).rejects.toThrow(/requires a Character Harness 5G NEED_COGNITION request/);

    expect(getReasoningProvider).not.toHaveBeenCalled();
  });
});
