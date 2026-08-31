import {
  ProviderError,
  ProviderErrorCode,
  type ReasoningInput,
  type ReasoningOutput,
  type ReasoningProvider
} from "@companion/providers";
import { describe, expect, it, vi } from "vitest";
import {
  executeRuntimeCognitionOnce,
  type RuntimeCognitionBoundary,
  type RuntimeCognitionFailureStatus
} from "./runtime-cognition-one-shot.js";

type Result =
  | Readonly<{ status: "SUCCESS"; answer: string }>
  | Readonly<{ status: RuntimeCognitionFailureStatus }>;

function boundary(): RuntimeCognitionBoundary<Result> {
  return {
    createReasoningInput(task: unknown): ReasoningInput {
      if (
        typeof task !== "object" ||
        task === null ||
        Array.isArray(task) ||
        (task as { valid?: unknown }).valid !== true
      ) {
        throw new Error("invalid cognition task");
      }
      return {
        messages: [{ role: "user", content: "authorized problem" }]
      };
    },
    normalizeReasoningOutput(output: ReasoningOutput): Result {
      if (output.reasoning !== "" || !output.answer.trim()) {
        throw new Error("invalid normalized reasoning output");
      }
      return Object.freeze({ status: "SUCCESS", answer: output.answer });
    },
    createFailureResult(input): Result {
      return Object.freeze({ status: input.status });
    }
  };
}

function provider(options: {
  output?: ReasoningOutput;
  error?: unknown;
  calls?: Array<{ input: ReasoningInput; signal: AbortSignal | undefined }>;
} = {}): ReasoningProvider {
  return {
    name: "reasoning-one-shot",
    async healthCheck() {
      return {
        provider: "reasoning-one-shot",
        status: "healthy" as const,
        checkedAt: new Date().toISOString()
      };
    },
    async generateReasoning(input, callOptions) {
      options.calls?.push({ input, signal: callOptions?.signal });
      if (options.error !== undefined) {
        throw options.error;
      }
      return (
        options.output ?? {
          reasoning: "",
          answer: "verified answer",
          finishReason: "stop" as const
        }
      );
    }
  };
}

describe("Runtime cognition one-shot execution", () => {
  it("validates the semantic task before selecting or calling a provider", async () => {
    const getReasoningProvider = vi.fn(() => provider());

    await expect(
      executeRuntimeCognitionOnce({
        providers: { getReasoningProvider },
        boundary: boundary(),
        task: { valid: false }
      })
    ).rejects.toThrow(/invalid cognition task/);

    expect(getReasoningProvider).not.toHaveBeenCalled();
  });

  it("executes exactly one existing ReasoningProvider call and normalizes its output", async () => {
    const calls: Array<{ input: ReasoningInput; signal: AbortSignal | undefined }> = [];
    const controller = new AbortController();
    const getReasoningProvider = vi.fn(() => provider({ calls }));

    const result = await executeRuntimeCognitionOnce({
      providers: { getReasoningProvider },
      boundary: boundary(),
      task: { valid: true },
      signal: controller.signal
    });

    expect(result).toEqual({ status: "SUCCESS", answer: "verified answer" });
    expect(getReasoningProvider).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([
      {
        input: {
          messages: [{ role: "user", content: "authorized problem" }]
        },
        signal: controller.signal
      }
    ]);
  });

  it("returns CANCELLED without selecting a provider when the admitted call is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const getReasoningProvider = vi.fn(() => provider());

    await expect(
      executeRuntimeCognitionOnce({
        providers: { getReasoningProvider },
        boundary: boundary(),
        task: { valid: true },
        signal: controller.signal
      })
    ).resolves.toEqual({ status: "CANCELLED" });

    expect(getReasoningProvider).not.toHaveBeenCalled();
  });

  it("classifies provider selection and execution availability failures as UNAVAILABLE", async () => {
    for (const code of [
      ProviderErrorCode.MissingApiKey,
      ProviderErrorCode.InvalidApiKey,
      ProviderErrorCode.PermissionDenied,
      ProviderErrorCode.ModelNotFound,
      ProviderErrorCode.ProviderUnavailable
    ]) {
      const unavailable = new ProviderError({
        provider: "reasoning-one-shot",
        capability: "reasoning",
        code,
        message: "unavailable",
        retryable: false
      });

      await expect(
        executeRuntimeCognitionOnce({
          providers: {
            getReasoningProvider() {
              if (code === ProviderErrorCode.ProviderUnavailable) {
                throw unavailable;
              }
              return provider({ error: unavailable });
            }
          },
          boundary: boundary(),
          task: { valid: true }
        })
      ).resolves.toEqual({ status: "UNAVAILABLE" });
    }
  });

  it("classifies explicit provider cancellation as CANCELLED", async () => {
    await expect(
      executeRuntimeCognitionOnce({
        providers: {
          getReasoningProvider: () =>
            provider({
              error: new ProviderError({
                provider: "reasoning-one-shot",
                capability: "reasoning",
                code: ProviderErrorCode.Cancelled,
                message: "cancelled",
                retryable: false
              })
            })
        },
        boundary: boundary(),
        task: { valid: true }
      })
    ).resolves.toEqual({ status: "CANCELLED" });
  });

  it("does not retry or fallback on retryable provider failures", async () => {
    let calls = 0;
    const getReasoningProvider = vi.fn(() => ({
      ...provider(),
      async generateReasoning(): Promise<ReasoningOutput> {
        calls += 1;
        throw new ProviderError({
          provider: "reasoning-one-shot",
          capability: "reasoning",
          code: ProviderErrorCode.RateLimited,
          message: "rate limited",
          retryable: true,
          fallbackEligible: true
        });
      }
    }));

    await expect(
      executeRuntimeCognitionOnce({
        providers: { getReasoningProvider },
        boundary: boundary(),
        task: { valid: true }
      })
    ).resolves.toEqual({ status: "ERROR" });

    expect(getReasoningProvider).toHaveBeenCalledTimes(1);
    expect(calls).toBe(1);
  });

  it("reduces malformed provider output normalization to ERROR without exposing it", async () => {
    const malformed: ReasoningOutput = {
      reasoning: "raw hidden reasoning",
      answer: "provider answer",
      finishReason: "stop"
    };

    await expect(
      executeRuntimeCognitionOnce({
        providers: { getReasoningProvider: () => provider({ output: malformed }) },
        boundary: boundary(),
        task: { valid: true }
      })
    ).resolves.toEqual({ status: "ERROR" });
  });

  it("maps unexpected provider failures to ERROR", async () => {
    await expect(
      executeRuntimeCognitionOnce({
        providers: { getReasoningProvider: () => provider({ error: new Error("boom") }) },
        boundary: boundary(),
        task: { valid: true }
      })
    ).resolves.toEqual({ status: "ERROR" });
  });
});
