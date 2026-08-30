import { describe, expect, it } from "vitest";
import {
  CHARACTER_HARNESS_5B_VERSION,
  CHARACTER_HARNESS_5C_VERSION,
  interpretCharacterHarnessOutput,
  superviseCharacterHarnessGeneration
} from "./index.js";

function accepted(proposal: unknown) {
  return interpretCharacterHarnessOutput(proposal);
}

describe("Character Harness 5C generation supervision", () => {
  it("accepts a normalized stop completion within the response budget", () => {
    const result = superviseCharacterHarnessGeneration({
      interpretation: accepted({ disposition: "RESPOND", text: "Hello." }),
      finishReason: "stop",
      maxResponseCharacters: 100
    });

    expect(result).toEqual({
      version: CHARACTER_HARNESS_5C_VERSION,
      status: "ACCEPTED",
      proposal: { disposition: "RESPOND", text: "Hello." }
    });
  });

  it("fails closed on normalized length termination without publishing a partial proposal", () => {
    const result = superviseCharacterHarnessGeneration({
      interpretation: accepted({
        disposition: "RESPOND",
        text: "This prefix must not become a publishable reply."
      }),
      finishReason: "length",
      maxResponseCharacters: 1000
    });

    expect(result).toEqual({
      version: CHARACTER_HARNESS_5C_VERSION,
      status: "TRUNCATED",
      reason: "LENGTH_TERMINATION"
    });
    expect(JSON.stringify(result)).not.toContain("This prefix must not become a publishable reply.");
  });

  it.each([
    ["content_filter", "CONTENT_FILTERED", "CONTENT_FILTER_TERMINATION"],
    ["tool_call", "UNSUPPORTED_TOOL_CALL", "TOOL_CALL_TERMINATION"],
    ["unknown", "UNKNOWN_TERMINATION", "UNKNOWN_FINISH_REASON"],
    [undefined, "UNKNOWN_TERMINATION", "UNKNOWN_FINISH_REASON"],
    ["provider-specific-max-tokens", "UNKNOWN_TERMINATION", "UNKNOWN_FINISH_REASON"]
  ] as const)(
    "maps non-publishable finish reason %s to bounded supervision",
    (finishReason, status, reason) => {
      expect(
        superviseCharacterHarnessGeneration({
          interpretation: accepted({ disposition: "RESPOND", text: "Candidate." }),
          finishReason,
          maxResponseCharacters: 100
        })
      ).toEqual({
        version: CHARACTER_HARNESS_5C_VERSION,
        status,
        reason
      });
    }
  );

  it("preserves malformed proposal diagnosis after a clean stop", () => {
    const malformed = interpretCharacterHarnessOutput({
      disposition: "REQUEST_CAPABILITY",
      capability: "shell"
    });
    const result = superviseCharacterHarnessGeneration({
      interpretation: malformed,
      finishReason: "stop",
      maxResponseCharacters: 100
    });

    expect(result).toEqual({
      version: CHARACTER_HARNESS_5C_VERSION,
      status: "MALFORMED",
      reason: "INVALID_CHARACTER_PROPOSAL"
    });
  });

  it("rejects an over-budget response instead of truncating or rewriting it", () => {
    const text = "123456";
    const result = superviseCharacterHarnessGeneration({
      interpretation: accepted({ disposition: "RESPOND", text }),
      finishReason: "stop",
      maxResponseCharacters: 5
    });

    expect(result).toEqual({
      version: CHARACTER_HARNESS_5C_VERSION,
      status: "OVER_BUDGET",
      reason: "RESPONSE_CHARACTER_BUDGET_EXCEEDED"
    });
    expect(JSON.stringify(result)).not.toContain(text);
  });

  it.each(["SILENCE", "TERMINATE"] as const)(
    "does not invent a text budget for %s",
    (disposition) => {
      const result = superviseCharacterHarnessGeneration({
        interpretation: accepted({ disposition }),
        finishReason: "stop",
        maxResponseCharacters: 0
      });

      expect(result.status).toBe("ACCEPTED");
      if (result.status === "ACCEPTED") {
        expect(result.proposal.disposition).toBe(disposition);
      }
    }
  );

  it("accepts NEED_COGNITION as semantic escalation but does not execute it", () => {
    const result = superviseCharacterHarnessGeneration({
      interpretation: accepted({
        disposition: "NEED_COGNITION",
        focus: "Needs grounded verification."
      }),
      finishReason: "stop",
      maxResponseCharacters: 0
    });

    expect(result).toEqual({
      version: CHARACTER_HARNESS_5C_VERSION,
      status: "ACCEPTED",
      proposal: {
        disposition: "NEED_COGNITION",
        focus: "Needs grounded verification."
      }
    });
  });

  it("revalidates 5B interpretation envelopes before supervising them", () => {
    expect(() =>
      superviseCharacterHarnessGeneration({
        interpretation: {
          version: CHARACTER_HARNESS_5B_VERSION,
          status: "ACCEPTED",
          proposal: { disposition: "RESPOND", text: "Hello." },
          provider: "must-not-cross"
        },
        finishReason: "stop",
        maxResponseCharacters: 100
      })
    ).toThrow(/unknown field: provider/);
  });

  it("rejects authority-expanding supervision fields and invalid budgets", () => {
    expect(() =>
      superviseCharacterHarnessGeneration({
        interpretation: accepted({ disposition: "SILENCE" }),
        finishReason: "stop",
        maxResponseCharacters: 0,
        retryProvider: "another-model"
      })
    ).toThrow(/unknown field: retryProvider/);

    for (const maxResponseCharacters of [-1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() =>
        superviseCharacterHarnessGeneration({
          interpretation: accepted({ disposition: "SILENCE" }),
          finishReason: "stop",
          maxResponseCharacters
        })
      ).toThrow(/non-negative safe integer/);
    }
  });

  it("returns frozen supervision envelopes and never echoes provider-specific termination text", () => {
    const result = superviseCharacterHarnessGeneration({
      interpretation: accepted({ disposition: "RESPOND", text: "Candidate." }),
      finishReason: "vendor-private-stop-reason",
      maxResponseCharacters: 100
    });

    expect(Object.isFrozen(result)).toBe(true);
    expect(result).toEqual({
      version: CHARACTER_HARNESS_5C_VERSION,
      status: "UNKNOWN_TERMINATION",
      reason: "UNKNOWN_FINISH_REASON"
    });
    expect(JSON.stringify(result)).not.toContain("vendor-private-stop-reason");
  });
});
