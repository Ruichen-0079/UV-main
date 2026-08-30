import {
  CHARACTER_HARNESS_5E_VERSION,
  type CharacterHarnessRecoveryDecision
} from "./recovery.js";

export const CHARACTER_HARNESS_5F_VERSION = "character-harness-5f.v1" as const;

type RecoverySupervisorEscalation = Extract<
  CharacterHarnessRecoveryDecision,
  { disposition: "ESCALATE_RECOVERY_SUPERVISOR" }
>;

export type CharacterHarnessRecoverySupervisorRequest = Readonly<{
  version: typeof CHARACTER_HARNESS_5F_VERSION;
  escalation: RecoverySupervisorEscalation;
  characterRetriesUsed: number;
  retryAllowed: boolean;
  cognitionAvailable: boolean;
}>;

export type CharacterHarnessRecoverySupervisorProposal = Readonly<{
  disposition:
    | "RETRY_CHARACTER_GENERATION"
    | "FALLBACK_TO_COGNITION"
    | "FAIL_CHARACTER_OUTPUT";
}>;

export type CharacterHarnessRecoverySupervisorInterpretation = Readonly<
  | {
      version: typeof CHARACTER_HARNESS_5F_VERSION;
      status: "ACCEPTED";
      proposal: CharacterHarnessRecoverySupervisorProposal;
    }
  | {
      version: typeof CHARACTER_HARNESS_5F_VERSION;
      status: "MALFORMED";
      reason: "INVALID_RECOVERY_SUPERVISOR_PROPOSAL";
    }
  | {
      version: typeof CHARACTER_HARNESS_5F_VERSION;
      status: "NOT_ADMITTED";
      reason: "RETRY_NOT_ADMITTED" | "COGNITION_NOT_AVAILABLE";
    }
>;

type UnknownObject = Record<string, unknown> & {
  escalation?: unknown;
  characterRetriesUsed?: unknown;
  retryAllowed?: unknown;
  cognitionAvailable?: unknown;
  version?: unknown;
  disposition?: unknown;
  trigger?: unknown;
  reason?: unknown;
  request?: unknown;
  output?: unknown;
};

/**
 * Construct the bounded diagnostic request that may be sent to an optional
 * intelligent recovery supervisor.
 *
 * This seam consumes only a 5E ambiguity escalation plus Runtime admission
 * facts. It deliberately excludes Character text, user context, provider/model
 * identifiers, tool names, Memory, and raw provider diagnostics so the
 * supervisor cannot become a second Character or Runtime.
 */
export function createCharacterHarnessRecoverySupervisorRequest(
  input: unknown
): CharacterHarnessRecoverySupervisorRequest {
  const value = expectObject(input, "Character Harness recovery supervisor request input");
  assertAllowedKeys(
    value,
    ["escalation", "characterRetriesUsed", "retryAllowed", "cognitionAvailable"],
    "Character Harness recovery supervisor request input"
  );

  const escalation = normalizeEscalation(value.escalation);
  const characterRetriesUsed = nonNegativeSafeInteger(
    value.characterRetriesUsed,
    "Character Harness recovery supervisor characterRetriesUsed"
  );
  const retryAllowed = expectBoolean(
    value.retryAllowed,
    "Character Harness recovery supervisor retryAllowed"
  );
  const cognitionAvailable = expectBoolean(
    value.cognitionAvailable,
    "Character Harness recovery supervisor cognitionAvailable"
  );

  return Object.freeze({
    version: CHARACTER_HARNESS_5F_VERSION,
    escalation,
    characterRetriesUsed,
    retryAllowed,
    cognitionAvailable
  });
}

/**
 * Interpret an adapter-decoded intelligent supervisor proposal without
 * executing it. The supervisor may only propose retry, cognition fallback, or
 * failure. Runtime admission facts still fence retry and cognition fallback.
 */
export function interpretCharacterHarnessRecoverySupervisorOutput(
  input: unknown
): CharacterHarnessRecoverySupervisorInterpretation {
  const value = expectObject(input, "Character Harness recovery supervisor output input");
  assertAllowedKeys(
    value,
    ["request", "output"],
    "Character Harness recovery supervisor output input"
  );

  const request = normalizeRequest(value.request);
  const proposal = normalizeProposal(value.output);
  if (proposal === null) {
    return Object.freeze({
      version: CHARACTER_HARNESS_5F_VERSION,
      status: "MALFORMED",
      reason: "INVALID_RECOVERY_SUPERVISOR_PROPOSAL"
    });
  }

  if (proposal.disposition === "RETRY_CHARACTER_GENERATION" && !request.retryAllowed) {
    return Object.freeze({
      version: CHARACTER_HARNESS_5F_VERSION,
      status: "NOT_ADMITTED",
      reason: "RETRY_NOT_ADMITTED"
    });
  }

  if (proposal.disposition === "FALLBACK_TO_COGNITION" && !request.cognitionAvailable) {
    return Object.freeze({
      version: CHARACTER_HARNESS_5F_VERSION,
      status: "NOT_ADMITTED",
      reason: "COGNITION_NOT_AVAILABLE"
    });
  }

  return Object.freeze({
    version: CHARACTER_HARNESS_5F_VERSION,
    status: "ACCEPTED",
    proposal
  });
}

function normalizeEscalation(input: unknown): RecoverySupervisorEscalation {
  const value = expectObject(input, "Character Harness recovery supervisor escalation");
  assertAllowedKeys(
    value,
    ["version", "disposition", "trigger", "reason"],
    "Character Harness recovery supervisor escalation"
  );
  if (
    value.version !== CHARACTER_HARNESS_5E_VERSION ||
    value.disposition !== "ESCALATE_RECOVERY_SUPERVISOR" ||
    value.trigger !== "UNKNOWN_FINISH_REASON" ||
    value.reason !== "AMBIGUOUS_GENERATION_FAILURE"
  ) {
    throw new Error("Character Harness recovery supervisor requires a 5E ambiguity escalation.");
  }

  return Object.freeze({
    version: CHARACTER_HARNESS_5E_VERSION,
    disposition: "ESCALATE_RECOVERY_SUPERVISOR",
    trigger: "UNKNOWN_FINISH_REASON",
    reason: "AMBIGUOUS_GENERATION_FAILURE"
  });
}

function normalizeRequest(input: unknown): CharacterHarnessRecoverySupervisorRequest {
  const value = expectObject(input, "Character Harness recovery supervisor request");
  assertAllowedKeys(
    value,
    ["version", "escalation", "characterRetriesUsed", "retryAllowed", "cognitionAvailable"],
    "Character Harness recovery supervisor request"
  );
  if (value.version !== CHARACTER_HARNESS_5F_VERSION) {
    throw new Error(`Character Harness recovery supervisor request version must be ${CHARACTER_HARNESS_5F_VERSION}.`);
  }

  return createCharacterHarnessRecoverySupervisorRequest({
    escalation: value.escalation,
    characterRetriesUsed: value.characterRetriesUsed,
    retryAllowed: value.retryAllowed,
    cognitionAvailable: value.cognitionAvailable
  });
}

function normalizeProposal(input: unknown): CharacterHarnessRecoverySupervisorProposal | null {
  try {
    const value = expectObject(input, "Character Harness recovery supervisor proposal");
    assertAllowedKeys(
      value,
      ["disposition"],
      "Character Harness recovery supervisor proposal"
    );
    if (
      value.disposition !== "RETRY_CHARACTER_GENERATION" &&
      value.disposition !== "FALLBACK_TO_COGNITION" &&
      value.disposition !== "FAIL_CHARACTER_OUTPUT"
    ) {
      return null;
    }
    return Object.freeze({ disposition: value.disposition });
  } catch {
    return null;
  }
}

function nonNegativeSafeInteger(input: unknown, field: string): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) {
    throw new Error(`${field} must be a non-negative safe integer.`);
  }
  return input;
}

function expectBoolean(input: unknown, field: string): boolean {
  if (typeof input !== "boolean") {
    throw new Error(`${field} must be a boolean.`);
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
