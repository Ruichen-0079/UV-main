import {
  createCharacterProposal,
  type CharacterProposal
} from "@companion/character-abi";
import { CHARACTER_HARNESS_5D_VERSION } from "./versions.js";

export const CHARACTER_HARNESS_ACCEPTED_PROPOSAL_INSTANCE_7X_VERSION =
  "character-harness-accepted-proposal-instance-7x.v1" as const;

export type CharacterHarnessProposalInstance = Readonly<{
  reference: string;
  createdAtMs: number;
}>;

export type CharacterHarnessProposalInstanceAllocator = () => unknown;

export type CharacterHarnessAcceptedProposalInstance = Readonly<{
  version: typeof CHARACTER_HARNESS_ACCEPTED_PROPOSAL_INSTANCE_7X_VERSION;
  proposalInstance: CharacterHarnessProposalInstance;
  proposal: CharacterProposal;
}>;

type UnknownObject = Record<string, unknown> & {
  version?: unknown;
  status?: unknown;
  proposal?: unknown;
  reference?: unknown;
  createdAtMs?: unknown;
};

const OPAQUE_PROPOSAL_INSTANCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/;

/**
 * Allocate identity for one already-accepted 5D Character Harness proposal.
 *
 * The proposal is revalidated through Character ABI before the allocator is
 * called. The resulting proposalInstance identifies only this accepted semantic
 * proposal instance. It is not a Runtime effect identity, provider request ID,
 * admission token, execution/publication authority, model identity, or device
 * identity. Runtime remains responsible for any later embodied-effect identity
 * and admission.
 */
export function allocateCharacterHarnessAcceptedProposalInstance(
  input: unknown,
  allocator: CharacterHarnessProposalInstanceAllocator
): CharacterHarnessAcceptedProposalInstance {
  const value = expectObject(input, "Character Harness accepted proposal input");
  assertAllowedKeys(
    value,
    ["version", "status", "proposal"],
    "Character Harness accepted proposal input"
  );

  if (value.version !== CHARACTER_HARNESS_5D_VERSION || value.status !== "ACCEPTED") {
    throw new Error("Character Harness proposal instance requires an accepted 5D proposal.");
  }

  const proposal = createCharacterProposal(value.proposal);

  if (typeof allocator !== "function") {
    throw new Error("Character Harness proposal instance allocator must be a function.");
  }

  const allocated = expectObject(
    allocator(),
    "Character Harness proposal instance allocation"
  );
  assertAllowedKeys(
    allocated,
    ["reference", "createdAtMs"],
    "Character Harness proposal instance allocation"
  );

  if (!isOpaqueProposalInstanceReference(allocated.reference)) {
    throw new Error(
      "Character Harness proposal instance reference must be a valid opaque reference."
    );
  }
  if (
    typeof allocated.createdAtMs !== "number" ||
    !Number.isFinite(allocated.createdAtMs) ||
    allocated.createdAtMs < 0
  ) {
    throw new Error(
      "Character Harness proposal instance createdAtMs must be a finite non-negative number."
    );
  }

  const proposalInstance = Object.freeze({
    reference: allocated.reference,
    createdAtMs: allocated.createdAtMs
  });

  return Object.freeze({
    version: CHARACTER_HARNESS_ACCEPTED_PROPOSAL_INSTANCE_7X_VERSION,
    proposalInstance,
    proposal
  });
}

function isOpaqueProposalInstanceReference(input: unknown): input is string {
  return (
    typeof input === "string" &&
    input.length >= 1 &&
    input.length <= 200 &&
    OPAQUE_PROPOSAL_INSTANCE_PATTERN.test(input)
  );
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
