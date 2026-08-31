import { type ReasoningOutput, type ReasoningProvider } from "@companion/providers";
import { describe, expect, it, vi } from "vitest";
import {
  executeRuntimeCognitionOnce,
  type RuntimeCognitionBoundary,
  type RuntimeCognitionFailureStatus
} from "./runtime-cognition-one-shot.js";

type Result =
  | Readonly<{ status: "SUCCESS"; answer: string }>
  | Readonly<{ status: RuntimeCognitionFailureStatus }>;

const boundary: RuntimeCognitionBoundary<Result> = {
  createReasoningInput() {
    return { messages: [{ role: "user", content: "authorized problem" }] };
  },
  normalizeReasoningOutput(output) {
    return Object.freeze({ status: "SUCCESS", answer: output.answer });
  },
  createFailureResult(input) {
    return Object.freeze({ status: input.status });
  }
};

describe("Runtime cognition cancellation fence", () => {
  it("discards a provider result when cancellation becomes visible before normalization", async () => {
    const controller = new AbortController();
    const normalize = vi.spyOn(boundary, "normalizeReasoningOutput");
    const reasoningProvider: ReasoningProvider = {
      name: "cancel-before-normalize",
      async healthCheck() {
        return {
          provider: "cancel-before-normalize",
          status: "healthy" as const,
          checkedAt: new Date().toISOString()
        };
      },
      async generateReasoning(): Promise<ReasoningOutput> {
        controller.abort();
        return {
          reasoning: "",
          answer: "must be discarded",
          finishReason: "stop"
        };
      }
    };

    await expect(
      executeRuntimeCognitionOnce({
        providers: { getReasoningProvider: () => reasoningProvider },
        boundary,
        task: { valid: true },
        signal: controller.signal
      })
    ).resolves.toEqual({ status: "CANCELLED" });

    expect(normalize).not.toHaveBeenCalled();
  });
});
