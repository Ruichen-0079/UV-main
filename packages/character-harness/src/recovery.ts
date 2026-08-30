import type {
  CharacterHarnessGenerationSupervision,
  CharacterHarnessRepetitionSupervision
} from "./index.js";

export const CHARACTER_HARNESS_5E_VERSION = "character-harness-5e.v1" as const;

const GENERATION_FAILURE_REASONS = {
  TRUNCATED: "LENGTH_TERMINATION",
  CONTENT_FILTERED: "CONTENT_FILTER_TERMINATION",
  UNSUPPORTED_TOOL_CALL: "TOOL_CALL_TERMINATION",
  UNKNOWN_TERMINATION: "UNKNOWN_FINISH_REASON",
  OVER_BUDGET: "RESPONSE_CHARACTER_BUDGET_EXCEEDED",
  MALFORMED: "INVALID_CHARACTER_PROPOSAL"
} as const;

type GenerationFailure = Exclude<
  CharacterHarnessGenerationSupervision,
  { status: "ACCEPTED" }
>;
type RepetitionFailure = Exclude<
  CharacterHarnessRepetitionSupervision,
  { status: "ACCEPTED" }
>;

export type CharacterHarnessRecoveryTrigger =
  | GenerationFailure["reason"]
  | RepetitionFailure["reason"];

export type CharacterHarnessRecoveryDecision = Readonly<
  | {
      version: typeof CHARACTER_HARNESS_5E_VERSION;
      disposition: "RETRY_CHARACTER_GENERATION";
      trigger: CharacterHarnessRecoveryTrigger;
      reason: "SIMPLE_RECOVERY";
    }
  | {
      version: typeof CHARACTER_HARNESS_5E_VERSION;
      disposition: "ESCALATE_RECOVERY_SUPERVISOR";
      trigger: "UNKNOWN_FINISH_REASON";
      reason: "AMBIGUOUS_GENERATION_FAILURE";
    }
  | {
      version: typeof CHARACTER_HARNESS_5E_VERSION;
      disposition: "FAIL_CHARACTER_OUTPUT";
      trigger: CharacterHarnessRecoveryTrigger;
      reason:
        | "NON_RETRYABLE_FAILURE"
        | "RETRY_BUDGET_EXHAUSTED"
        | "RETRY_NOT_ADMITTED";
    }
>;

type UnknownObject = Record<string, unknown> & {
  failure?: unknown;
  characterRetriesUsed?: unknown;
  retryAllowed?: unknown;
  version?: unknown;
  status?: unknown;
  reason?: unknown;
  ngramCharacters?: unknown;
  observedOccurrences?: unknown;
};

/**
 * Select a bounded semantic recovery disposition for already-supervised
 * Character generation failures.
 *
 * This function never retries, invokes a provider, calls cognition, or publishes
 * output. Runtime supplies retry admission and the number of retries already
 * executed. The deterministic policy proposes at most one simple Character
 * retry. Ambiguous unknown termination is reserved for an optional intelligent
 * recovery supervisor rather than putting a model on the normal path.
 */
export function decideCharacterHarnessRecovery(input: unknown): CharacterHarnessRecoveryDecision {
  const value = expectObject(input, "Character Harness recovery input");
  assertAllowedKeys(
    value,
    ["failure", "characterRetriesUsed", "retryAllowed"],
    "Character Harness recovery input"
  );

  const trigger = normalizeRecoveryTrigger(value.failure);
  const characterRetriesUsed = nonNegativeSafeInteger(
    value.characterRetriesUsed,
    "Character Harness characterRetriesUsed"
  );
  if (typeof value.retryAllowed !== "boolean") {
    throw new Error("Character Harness retryAllowed must be a boolean.");
  }

  if (trigger === "UNKNOWN_FINISH_REASON") {
    return Object.freeze({
      version: CHARACTER_HARNESS_5E_VERSION,
      disposition: "ESCALATE_RECOVERY_SUPERVISOR",
      trigger,
      reason: "AMBIGUOUS_GENERATION_FAILURE"
    });
  }

  if (trigger === "CONTENT_FILTER_TERMINATION") {
    return failedRecovery(trigger, "NON_RETRYABLE_FAILURE");
  }

  if (!value.retryAllowed) {
    return failedRecovery(trigger, "RETRY_NOT_ADMITTED");
  }

  if (characterRetriesUsed >= 1) {
    return failedRecovery(trigger, "RETRY_BUDGET_EXHAUSTED");
  }

  return Object.freeze({
    version: CHARACTER_HARNESS_5E_VERSION,
    disposition: "RETRY_CHARACTER_GENERATION",
    trigger,
    reason: "SIMPLE_RECOVERY"
  });
}

function normalizeRecoveryTrigger(input: unknown): CharacterHarnessRecoveryTrigger {
  const value = expectObject(input, "Character Harness recovery failure");

  if (value.version === "character-harness-5c.v1") {
    assertAllowedKeys(
      value,
      ["version", "status", "reason"],
      "Character Harness 5C recovery failure"
    );

    if (typeof value.status !== "string" || !(value.status in GENERATION_FAILURE_REASONS)) {
      throw new Error("Character Harness recovery requires a rejected 5C or 5D outcome.");
    }

    const status = value.status as keyof typeof GENERATION_FAILURE_REASONS;
    const expectedReason = GENERATION_FAILURE_REASONS[status];
    if (value.reason !== expectedReason) {
      throw new Error(`Character Harness ${status} recovery reason must be ${expectedReason}.`);
    }
    return expectedReason;
  }

  if (value.version === "character-harness-5d.v1") {
    assertAllowedKeys(
      value,
      ["version", "status", "reason", "ngramCharacters", "observedOccurrences"],
      "Character Harness 5D recovery failure"
    );
    if (
      value.status !== "REPETITION_DETECTED" ||
      value.reason !== "EXACT_CHARACTER_NGRAM_REPETITION"
    ) {
      throw new Error("Character Harness recovery requires a rejected 5C or 5D outcome.");
    }
    safeIntegerAtLeast(value.ngramCharacters, "Character Harness recovery ngramCharacters", 2);
    safeIntegerAtLeast(
      value.observedOccurrences,
      "Character Harness recovery observedOccurrences",
      2
    );
    return "EXACT_CHARACTER_NGRAM_REPETITION";
  }

  throw new Error("Character Harness recovery requires a rejected 5C or 5D outcome.");
}

function failedRecovery(
  trigger: CharacterHarnessRecoveryTrigger,
  reason:
    | "NON_RETRYABLE_FAILURE"
    | "RETRY_BUDGET_EXHAUSTED"
    | "RETRY_NOT_ADMITTED"
): CharacterHarnessRecoveryDecision {
  return Object.freeze({
    version: CHARACTER_HARNESS_5E_VERSION,
    disposition: "FAIL_CHARACTER_OUTPUT",
    trigger,
    reason
  });
}

function safeIntegerAtLeast(input: unknown, field: string, minimum: number): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < minimum) {
    throw new Error(`${field} must be a safe integer greater than or equal to ${minimum}.`);
  }
  return input;
}

function nonNegativeSafeInteger(input: unknown, field: string): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) {
    throw new Error(`${field} must be a non-negative safe integer.`);
  }
  return input;
}

function expectObject(input: unknown, field: string): UnknownObject {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error(`${field} must be an object.`);
  }
  return input as UnknownObject;
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  field: string
): void {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${field} contains unknown field: ${unknown.sort().join(", ")}.`);
  }
}
