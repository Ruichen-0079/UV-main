import { describe, expect, it } from "vitest";
import {
  interpretCharacterHarnessOutput,
  superviseCharacterHarnessGeneration,
  superviseCharacterHarnessRepetition
} from "./index.js";
import {
  CHARACTER_HARNESS_5E_VERSION,
  decideCharacterHarnessRecovery
} from "./recovery.js";

function generationFailure(
  finishReason: "length" | "content_filter" | "tool_call" | "unknown" | "stop",
  proposal: unknown = { disposition: "RESPOND", text: "Candidate." },
  maxResponseCharacters = 8000
) {
  return superviseCharacterHarnessGeneration({
    interpretation: interpretCharacterHarnessOutput(proposal),
    finishReason,
    maxResponseCharacters
  });
}

function repetitionFailure() {
  const generation = superviseCharacterHarnessGeneration({
    interpretation: interpretCharacterHarnessOutput({
      disposition: "RESPOND",
      text: "abcdabcdabcd"
    }),
    finishReason: "stop",
    maxResponseCharacters: 8000
  });
  return superviseCharacterHarnessRepetition({
    generation,
    ngramCharacters: 4,
    maxOccurrences: 2
  });
}

function decide(failure: unknown, characterRetriesUsed = 0, retryAllowed = true) {
  return decideCharacterHarnessRecovery({
    failure,
    characterRetriesUsed,
    retryAllowed
  });
}

describe("Character Harness 5E deterministic recovery", () => {
  it.each([
    ["truncated", () => generationFailure("length"), "LENGTH_TERMINATION"],
    ["unsupported tool call", () => generationFailure("tool_call"), "TOOL_CALL_TERMINATION"],
    [
      "over budget",
      () => generationFailure("stop", { disposition: "RESPOND", text: "too long" }, 3),
      "RESPONSE_CHARACTER_BUDGET_EXCEEDED"
    ],
    ["malformed", () => generationFailure("stop", { disposition: "REQUEST_TOOL" }), "INVALID_CHARACTER_PROPOSAL"],
    ["exact repetition", () => repetitionFailure(), "EXACT_CHARACTER_NGRAM_REPETITION"]
  ] as const)("proposes one simple retry for %s", (_label, failure, trigger) => {
    expect(decide(failure())).toEqual({
      version: CHARACTER_HARNESS_5E_VERSION,
      disposition: "RETRY_CHARACTER_GENERATION",
      trigger,
      reason: "SIMPLE_RECOVERY"
    });
  });

  it("fails instead of proposing a second Character retry", () => {
    expect(decide(generationFailure("length"), 1, true)).toEqual({
      version: CHARACTER_HARNESS_5E_VERSION,
      disposition: "FAIL_CHARACTER_OUTPUT",
      trigger: "LENGTH_TERMINATION",
      reason: "RETRY_BUDGET_EXHAUSTED"
    });

    expect(decide(generationFailure("length"), 7, true).disposition).toBe(
      "FAIL_CHARACTER_OUTPUT"
    );
  });

  it("respects Runtime retry admission without executing recovery", () => {
    expect(decide(generationFailure("length"), 0, false)).toEqual({
      version: CHARACTER_HARNESS_5E_VERSION,
      disposition: "FAIL_CHARACTER_OUTPUT",
      trigger: "LENGTH_TERMINATION",
      reason: "RETRY_NOT_ADMITTED"
    });
  });

  it("treats content filtering as deterministic non-retryable failure", () => {
    expect(decide(generationFailure("content_filter"))).toEqual({
      version: CHARACTER_HARNESS_5E_VERSION,
      disposition: "FAIL_CHARACTER_OUTPUT",
      trigger: "CONTENT_FILTER_TERMINATION",
      reason: "NON_RETRYABLE_FAILURE"
    });
  });

  it("escalates only ambiguous unknown termination to the optional recovery supervisor", () => {
    expect(decide(generationFailure("unknown"))).toEqual({
      version: CHARACTER_HARNESS_5E_VERSION,
      disposition: "ESCALATE_RECOVERY_SUPERVISOR",
      trigger: "UNKNOWN_FINISH_REASON",
      reason: "AMBIGUOUS_GENERATION_FAILURE"
    });
  });

  it("does not accept normal Character dispositions as recovery failures", () => {
    const accepted = superviseCharacterHarnessGeneration({
      interpretation: interpretCharacterHarnessOutput({ disposition: "SILENCE" }),
      finishReason: "stop",
      maxResponseCharacters: 8000
    });

    expect(() => decide(accepted)).toThrow(/requires a rejected 5C or 5D outcome/);
  });

  it("rejects forged failure status/reason pairs and provider metadata", () => {
    expect(() =>
      decide({
        version: "character-harness-5c.v1",
        status: "TRUNCATED",
        reason: "INVALID_CHARACTER_PROPOSAL"
      })
    ).toThrow(/TRUNCATED recovery reason must be LENGTH_TERMINATION/);

    expect(() =>
      decide({
        version: "character-harness-5c.v1",
        status: "TRUNCATED",
        reason: "LENGTH_TERMINATION",
        provider: "must-not-cross"
      })
    ).toThrow(/unknown field: provider/);
  });

  it("rejects invalid Runtime recovery context", () => {
    const failure = generationFailure("length");

    for (const characterRetriesUsed of [-1, 0.5, Number.POSITIVE_INFINITY]) {
      expect(() => decide(failure, characterRetriesUsed, true)).toThrow(
        /characterRetriesUsed must be a non-negative safe integer/
      );
    }

    expect(() =>
      decideCharacterHarnessRecovery({
        failure,
        characterRetriesUsed: 0,
        retryAllowed: "yes"
      })
    ).toThrow(/retryAllowed must be a boolean/);
  });

  it("returns frozen bounded decisions without raw failed Character text", () => {
    const rawText = "abcdabcdabcd";
    const result = decide(repetitionFailure());

    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(rawText);
  });
});
