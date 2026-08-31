import { describe, expect, it } from "vitest";
import { NORMALIZED_COGNITION_RESULT_VERSION } from "../../character-abi/src/index.js";
import { CHARACTER_HARNESS_5G_VERSION } from "../../character-harness/src/cognition-request.js";
import {
  COGNITION_6A_VERSION,
  createCognitionFailureResult,
  createCognitionReasoningInput,
  normalizeCognitionReasoningOutput
} from "./index.js";

function escalation(focus = "Verify the uncertain claim.") {
  return {
    version: CHARACTER_HARNESS_5G_VERSION,
    kind: "NEED_COGNITION",
    focus
  } as const;
}

describe("Cognition 6A boundary", () => {
  it("maps one admitted 5G escalation plus Runtime-authorized problem to a minimal ReasoningInput", () => {
    const input = createCognitionReasoningInput({
      version: COGNITION_6A_VERSION,
      escalation: escalation(),
      problem: "Determine the verified answer from the authorized task context."
    });

    expect(input).toEqual({
      messages: [
        {
          role: "user",
          content: "Determine the verified answer from the authorized task context."
        }
      ]
    });
    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen(input.messages)).toBe(true);
    expect(Object.isFrozen(input.messages[0])).toBe(true);
  });

  it("requires an explicit Runtime-authorized problem instead of treating the coarse 5G focus as a full model task", () => {
    expect(() =>
      createCognitionReasoningInput({
        version: COGNITION_6A_VERSION,
        escalation: escalation()
      })
    ).toThrow(/problem must be a non-empty string/);

    const input = createCognitionReasoningInput({
      version: COGNITION_6A_VERSION,
      escalation: escalation("Coarse focus only."),
      problem: "Narrow authorized problem."
    });
    expect(input.messages[0]?.content).toBe("Narrow authorized problem.");
    expect(JSON.stringify(input)).not.toContain("Coarse focus only.");
  });

  it("revalidates the exact 5G NEED_COGNITION envelope", () => {
    for (const invalidEscalation of [
      { version: "character-harness-5f.v1", kind: "NEED_COGNITION" },
      { version: CHARACTER_HARNESS_5G_VERSION, kind: "RESPOND" },
      {
        version: CHARACTER_HARNESS_5G_VERSION,
        kind: "NEED_COGNITION",
        focus: "x".repeat(501)
      },
      {
        version: CHARACTER_HARNESS_5G_VERSION,
        kind: "NEED_COGNITION",
        focus: "Verify.",
        toolName: "browser.search"
      }
    ]) {
      expect(() =>
        createCognitionReasoningInput({
          version: COGNITION_6A_VERSION,
          escalation: invalidEscalation,
          problem: "Authorized problem."
        })
      ).toThrow();
    }
  });

  it("keeps provider/model/tool/generation knobs outside the stable Phase 6 task boundary", () => {
    for (const extra of [
      { provider: "deepinfra" },
      { model: "reasoning-model" },
      { temperature: 0.4 },
      { effort: "high" },
      { maxTokens: 2048 },
      { toolName: "browser.search" },
      { capability: "web" },
      { traceId: "runtime-trace" }
    ]) {
      expect(() =>
        createCognitionReasoningInput({
          version: COGNITION_6A_VERSION,
          escalation: escalation(),
          problem: "Authorized problem.",
          ...extra
        })
      ).toThrow(/unknown field/);
    }
  });

  it("maps stop or omitted finish reason to SUCCESS with the authoritative answer", () => {
    for (const finishReason of [undefined, "stop"] as const) {
      const result = normalizeCognitionReasoningOutput({
        answer: "Verified answer.",
        reasoning: "",
        ...(finishReason === undefined ? {} : { finishReason })
      });

      expect(result).toEqual({
        version: NORMALIZED_COGNITION_RESULT_VERSION,
        status: "SUCCESS",
        answer: "Verified answer."
      });
      expect(Object.isFrozen(result)).toBe(true);
    }
  });

  it("maps length to PARTIAL while preserving the bounded available answer", () => {
    expect(
      normalizeCognitionReasoningOutput({
        answer: "Available partial answer.",
        reasoning: "",
        finishReason: "length"
      })
    ).toEqual({
      version: NORMALIZED_COGNITION_RESULT_VERSION,
      status: "PARTIAL",
      answer: "Available partial answer."
    });
  });

  it("maps content filtering to UNSAFE_TO_ANSWER without leaking provider text", () => {
    const result = normalizeCognitionReasoningOutput({
      answer: "Provider text that must not cross.",
      reasoning: "",
      finishReason: "content_filter",
      provider: "provider-a",
      model: "model-a"
    });

    expect(result).toEqual({
      version: NORMALIZED_COGNITION_RESULT_VERSION,
      status: "UNSAFE_TO_ANSWER"
    });
    expect(JSON.stringify(result)).not.toContain("Provider text");
  });

  it("maps unsupported tool calls and unknown termination to ERROR", () => {
    for (const finishReason of ["tool_call", "unknown"] as const) {
      expect(
        normalizeCognitionReasoningOutput({
          answer: "Do not expose this output.",
          reasoning: "",
          finishReason
        })
      ).toEqual({
        version: NORMALIZED_COGNITION_RESULT_VERSION,
        status: "ERROR"
      });
    }
  });

  it("rejects non-normalized raw reasoning before it can cross the Phase 6 boundary", () => {
    expect(() =>
      normalizeCognitionReasoningOutput({
        answer: "Safe final answer.",
        reasoning: "secret chain of thought",
        finishReason: "stop"
      })
    ).toThrow(/provider-normalized with an empty reasoning field/);

    expect(() =>
      normalizeCognitionReasoningOutput({
        answer: "Safe final answer.",
        finishReason: "stop"
      })
    ).toThrow(/provider-normalized with an empty reasoning field/);
  });

  it("never projects provider metadata into the normalized Character result", () => {
    const result = normalizeCognitionReasoningOutput({
      answer: "Safe final answer.",
      reasoning: "",
      finishReason: "stop",
      provider: "deepinfra",
      model: "some-model",
      requestId: "request-1",
      tokenUsage: { totalTokens: 100 },
      attemptedProviders: [{ provider: "a", status: "success" }],
      debug: { rawResponse: { secret: true } }
    });
    const serialized = JSON.stringify(result);

    expect(serialized).toContain("Safe final answer.");
    for (const forbidden of [
      "deepinfra",
      "some-model",
      "request-1",
      "totalTokens",
      "attemptedProviders",
      "rawResponse"
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("requires a non-empty bounded answer for successful or truncated provider output", () => {
    for (const finishReason of ["stop", "length"] as const) {
      expect(() =>
        normalizeCognitionReasoningOutput({
          answer: "   ",
          reasoning: "",
          finishReason
        })
      ).toThrow(/requires a non-empty answer/);
    }

    expect(() =>
      normalizeCognitionReasoningOutput({
        answer: "x".repeat(16_001),
        reasoning: "",
        finishReason: "stop"
      })
    ).toThrow(/16000/);
  });

  it("constructs only the bounded Runtime-classified non-success statuses", () => {
    for (const status of ["UNAVAILABLE", "CANCELLED", "ERROR"] as const) {
      const result = createCognitionFailureResult({ status });
      expect(result).toEqual({
        version: NORMALIZED_COGNITION_RESULT_VERSION,
        status
      });
      expect(Object.isFrozen(result)).toBe(true);
    }

    for (const invalid of ["SUCCESS", "PARTIAL", "UNSAFE_TO_ANSWER", "RETRY"]) {
      expect(() => createCognitionFailureResult({ status: invalid })).toThrow();
    }
    expect(() =>
      createCognitionFailureResult({ status: "ERROR", provider: "provider-a" })
    ).toThrow(/unknown field/);
  });

  it("rejects invalid phase version, invalid finish reason, and oversized Runtime problem", () => {
    expect(() =>
      createCognitionReasoningInput({
        version: "cognition-future.v1",
        escalation: escalation(),
        problem: "Authorized problem."
      })
    ).toThrow(/version must be/);

    expect(() =>
      createCognitionReasoningInput({
        version: COGNITION_6A_VERSION,
        escalation: escalation(),
        problem: "x".repeat(16_001)
      })
    ).toThrow(/16000/);

    expect(() =>
      normalizeCognitionReasoningOutput({
        answer: "Answer.",
        reasoning: "",
        finishReason: "vendor_specific"
      })
    ).toThrow(/finishReason is invalid/);
  });
});
