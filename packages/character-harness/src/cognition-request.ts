import {
  CHARACTER_HARNESS_5D_VERSION,
  type CharacterHarnessRepetitionSupervision
} from "./index.js";
import { createCharacterProposal } from "../../character-abi/src/index.js";

export const CHARACTER_HARNESS_5G_VERSION = "character-harness-5g.v1" as const;

type AcceptedCharacterGeneration = Extract<
  CharacterHarnessRepetitionSupervision,
  { status: "ACCEPTED" }
>;

export type CharacterHarnessCognitionRequest = Readonly<{
  version: typeof CHARACTER_HARNESS_5G_VERSION;
  kind: "NEED_COGNITION";
  focus?: string;
}>;

type UnknownObject = Record<string, unknown> & {
  generation?: unknown;
  version?: unknown;
  status?: unknown;
  proposal?: unknown;
};

/**
 * Translate a fully supervised Character NEED_COGNITION proposal into a small
 * semantic request for Runtime admission.
 *
 * The request contains only the Character-owned coarse escalation meaning and
 * optional focus. It carries no provider/model/tool/capability choice, Runtime
 * identity, raw user prompt, Memory payload, or execution instruction.
 */
export function createCharacterHarnessCognitionRequest(
  input: unknown
): CharacterHarnessCognitionRequest {
  const value = expectObject(input, "Character Harness cognition request input");
  assertAllowedKeys(value, ["generation"], "Character Harness cognition request input");

  const generation = normalizeAcceptedGeneration(value.generation);
  if (generation.proposal.disposition !== "NEED_COGNITION") {
    throw new Error("Character Harness cognition request requires NEED_COGNITION.");
  }

  return Object.freeze({
    version: CHARACTER_HARNESS_5G_VERSION,
    kind: "NEED_COGNITION",
    ...(generation.proposal.focus === undefined ? {} : { focus: generation.proposal.focus })
  });
}

function normalizeAcceptedGeneration(input: unknown): AcceptedCharacterGeneration {
  const value = expectObject(input, "Character Harness cognition request generation");
  assertAllowedKeys(
    value,
    ["version", "status", "proposal"],
    "Character Harness cognition request generation"
  );
  if (value.version !== CHARACTER_HARNESS_5D_VERSION || value.status !== "ACCEPTED") {
    throw new Error("Character Harness cognition request requires an accepted 5D generation.");
  }

  return Object.freeze({
    version: CHARACTER_HARNESS_5D_VERSION,
    status: "ACCEPTED",
    proposal: createCharacterProposal(value.proposal)
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
