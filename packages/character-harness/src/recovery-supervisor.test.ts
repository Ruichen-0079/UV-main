import { describe, expect, it } from "vitest";
import {
  interpretCharacterHarnessOutput,
  superviseCharacterHarnessGeneration
} from "./index.js";
import {
  decideCharacterHarnessRecovery
} from "./recovery.js";
import {
  CHARACTER_HARNESS_5F_VERSION,
  createCharacterHarnessRecoverySupervisorRequest,
  interpretCharacterHarnessRecoverySupervisorOutput
} from "./recovery-supervisor.js";

function unknownEscalation(characterRetriesUsed = 0, retryAllowed = true) {
  const failure = superviseCharacterHarnessGeneration({
    interpretation: interpretCharacterHarnessOutput({
      disposition: "RESPOND",
      text: "Candidate."
    }),
    finishReason: "unknown",
    maxResponseCharacters: 8000
  });

  return decideCharacterHarnessRecovery({
    failure,
    characterRetriesUsed,
    retryAllowed
  });
}

function request(
  characterRetriesUsed = 0,
  retryAllowed = true,
  cognitionAvailable = true
) {
  return createCharacterHarnessRecoverySupervisorRequest({
    escalation: unknownEscalation(characterRetriesUsed, retryAllowed),
    characterRetriesUsed,
    retryAllowed,
    cognitionAvailable
  });
}

function interpret(
  output: unknown,
  characterRetriesUsed = 0,
  retryAllowed = true,
  cognitionAvailable = true
) {
  return interpretCharacterHarnessRecoverySupervisorOutput({
    request: request(characterRetriesUsed, retryAllowed, cognitionAvailable),
    output
  });
}

describe("Character Harness 5F optional recovery supervisor contract", () => {
  it("constructs a bounded request only from a 5E ambiguity escalation", () => {
    const result = request();

    expect(result).toEqual({
      version: CHARACTER_HARNESS_5F_VERSION,
      escalation: {
        version: "character-harness-5e.v1",
        disposition: "ESCALATE_RECOVERY_SUPERVISOR",
        trigger: "UNKNOWN_FINISH_REASON",
        reason: "AMBIGUOUS_GENERATION_FAILURE"
      },
      characterRetriesUsed: 0,
      retryAllowed: true,
      cognitionAvailable: true
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.escalation)).toBe(true);
  });

  it("rejects ordinary deterministic recovery decisions", () => {
    const failure = superviseCharacterHarnessGeneration({
      interpretation: interpretCharacterHarnessOutput({
        disposition: "RESPOND",
        text: "Candidate."
      }),
      finishReason: "length",
      maxResponseCharacters: 8000
    });
    const deterministic = decideCharacterHarnessRecovery({
      failure,
      characterRetriesUsed: 0,
      retryAllowed: true
    });

    expect(() =>
      createCharacterHarnessRecoverySupervisorRequest({
        escalation: deterministic,
        characterRetriesUsed: 0,
        retryAllowed: true,
        cognitionAvailable: true
      })
    ).toThrow(/requires a 5E ambiguity escalation/);
  });

  it.each([
    "RETRY_CHARACTER_GENERATION",
    "FALLBACK_TO_COGNITION",
    "FAIL_CHARACTER_OUTPUT"
  ] as const)("accepts bounded supervisor proposal %s when admitted", (disposition) => {
    expect(interpret({ disposition })).toEqual({
      version: CHARACTER_HARNESS_5F_VERSION,
      status: "ACCEPTED",
      proposal: { disposition }
    });
  });

  it("does not let the intelligent supervisor bypass Runtime retry admission", () => {
    expect(interpret({ disposition: "RETRY_CHARACTER_GENERATION" }, 0, false, true)).toEqual({
      version: CHARACTER_HARNESS_5F_VERSION,
      status: "NOT_ADMITTED",
      reason: "RETRY_NOT_ADMITTED"
    });
  });

  it("does not let the intelligent supervisor bypass the one-retry ceiling", () => {
    expect(interpret({ disposition: "RETRY_CHARACTER_GENERATION" }, 1, true, true)).toEqual({
      version: CHARACTER_HARNESS_5F_VERSION,
      status: "NOT_ADMITTED",
      reason: "RETRY_BUDGET_EXHAUSTED"
    });

    expect(interpret({ disposition: "RETRY_CHARACTER_GENERATION" }, 8, true, true).status).toBe(
      "NOT_ADMITTED"
    );
  });

  it("does not let the supervisor invent cognition availability", () => {
    expect(interpret({ disposition: "FALLBACK_TO_COGNITION" }, 0, true, false)).toEqual({
      version: CHARACTER_HARNESS_5F_VERSION,
      status: "NOT_ADMITTED",
      reason: "COGNITION_NOT_AVAILABLE"
    });
  });

  it("keeps FAIL_CHARACTER_OUTPUT available even when recovery paths are unavailable", () => {
    expect(interpret({ disposition: "FAIL_CHARACTER_OUTPUT" }, 4, false, false)).toEqual({
      version: CHARACTER_HARNESS_5F_VERSION,
      status: "ACCEPTED",
      proposal: { disposition: "FAIL_CHARACTER_OUTPUT" }
    });
  });

  it("collapses provider/model/tool/rationale leakage to a bounded malformed result", () => {
    for (const output of [
      { disposition: "RETRY_CHARACTER_GENERATION", provider: "deepinfra" },
      { disposition: "RETRY_CHARACTER_GENERATION", model: "must-not-cross" },
      { disposition: "FALLBACK_TO_COGNITION", toolName: "search" },
      { disposition: "FAIL_CHARACTER_OUTPUT", rationale: "hidden reasoning" },
      { disposition: "REQUEST_CAPABILITY" }
    ]) {
      expect(interpret(output)).toEqual({
        version: CHARACTER_HARNESS_5F_VERSION,
        status: "MALFORMED",
        reason: "INVALID_RECOVERY_SUPERVISOR_PROPOSAL"
      });
    }
  });

  it("rejects raw Character/provider context on the supervisor request seam", () => {
    const escalation = unknownEscalation();

    for (const extra of [
      { characterText: "raw answer" },
      { userPrompt: "raw user prompt" },
      { provider: "deepinfra" },
      { model: "zai-org/GLM-5.3-Flash" },
      { toolName: "browser" }
    ]) {
      expect(() =>
        createCharacterHarnessRecoverySupervisorRequest({
          escalation,
          characterRetriesUsed: 0,
          retryAllowed: true,
          cognitionAvailable: true,
          ...extra
        })
      ).toThrow(/unknown field/);
    }
  });

  it("revalidates forged request envelopes before accepting supervisor output", () => {
    expect(() =>
      interpretCharacterHarnessRecoverySupervisorOutput({
        request: {
          ...request(),
          version: "character-harness-5f.future"
        },
        output: { disposition: "FAIL_CHARACTER_OUTPUT" }
      })
    ).toThrow(/request version must be character-harness-5f.v1/);
  });

  it("rejects invalid Runtime facts at request construction", () => {
    const escalation = unknownEscalation();

    for (const characterRetriesUsed of [-1, 0.5, Number.POSITIVE_INFINITY]) {
      expect(() =>
        createCharacterHarnessRecoverySupervisorRequest({
          escalation,
          characterRetriesUsed,
          retryAllowed: true,
          cognitionAvailable: true
        })
      ).toThrow(/characterRetriesUsed must be a non-negative safe integer/);
    }

    expect(() =>
      createCharacterHarnessRecoverySupervisorRequest({
        escalation,
        characterRetriesUsed: 0,
        retryAllowed: "yes",
        cognitionAvailable: true
      })
    ).toThrow(/retryAllowed must be a boolean/);
  });

  it("returns frozen accepted and rejected interpretations", () => {
    const accepted = interpret({ disposition: "FAIL_CHARACTER_OUTPUT" });
    const rejected = interpret({ disposition: "RETRY_CHARACTER_GENERATION" }, 1, true, true);

    expect(Object.isFrozen(accepted)).toBe(true);
    expect(Object.isFrozen(rejected)).toBe(true);
    if (accepted.status === "ACCEPTED") {
      expect(Object.isFrozen(accepted.proposal)).toBe(true);
    }
  });
});
