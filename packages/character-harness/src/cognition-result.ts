import {
  createCharacterProposal,
  createNormalizedCognitionResult,
  type NormalizedCognitionResult
} from "../../character-abi/dist/index.js";
import {
  CHARACTER_HARNESS_5G_VERSION,
  type CharacterHarnessCognitionRequest
} from "./cognition-request.js";

export const CHARACTER_HARNESS_5H_VERSION = "character-harness-5h.v1" as const;

export type CharacterHarnessCognitionRoundTrip = Readonly<{
  version: typeof CHARACTER_HARNESS_5H_VERSION;
  request: CharacterHarnessCognitionRequest;
  result: NormalizedCognitionResult;
}>;

type UnknownObject = Record<string, unknown> & {
  request?: unknown;
  result?: unknown;
  version?: unknown;
  kind?: unknown;
  focus?: unknown;
};

/**
 * Validate the semantic round-trip boundary between a Harness-produced
 * NEED_COGNITION request and a phase-6-produced Normalized Cognition Result.
 *
 * This performs no backend normalization, summarization, ranking, or result
 * projection into the Character ABI. The phase-6 normalized result is preserved
 * as-is after Character ABI validation; Runtime remains responsible for request
 * correlation, execution, cancellation, and admission.
 */
export function createCharacterHarnessCognitionRoundTrip(
  input: unknown
): CharacterHarnessCognitionRoundTrip {
  const value = expectObject(input, "Character Harness cognition round-trip input");
  assertAllowedKeys(
    value,
    ["request", "result"],
    "Character Harness cognition round-trip input"
  );

  const request = normalizeCognitionRequest(value.request);
  const result = createNormalizedCognitionResult(value.result);

  return Object.freeze({
    version: CHARACTER_HARNESS_5H_VERSION,
    request,
    result
  });
}

function normalizeCognitionRequest(input: unknown): CharacterHarnessCognitionRequest {
  const value = expectObject(input, "Character Harness cognition round-trip request");
  assertAllowedKeys(
    value,
    ["version", "kind", "focus"],
    "Character Harness cognition round-trip request"
  );
  if (value.version !== CHARACTER_HARNESS_5G_VERSION || value.kind !== "NEED_COGNITION") {
    throw new Error("Character Harness cognition round-trip requires a 5G NEED_COGNITION request.");
  }

  const proposal = createCharacterProposal({
    disposition: "NEED_COGNITION",
    ...(value.focus === undefined ? {} : { focus: value.focus })
  });
  if (proposal.disposition !== "NEED_COGNITION") {
    throw new Error("Character Harness cognition round-trip request is invalid.");
  }

  return Object.freeze({
    version: CHARACTER_HARNESS_5G_VERSION,
    kind: "NEED_COGNITION",
    ...(proposal.focus === undefined ? {} : { focus: proposal.focus })
  });
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
