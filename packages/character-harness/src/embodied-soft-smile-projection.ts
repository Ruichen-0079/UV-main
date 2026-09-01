import {
  CHARACTER_HARNESS_ACCEPTED_PROPOSAL_INSTANCE_7X_VERSION,
  allocateCharacterHarnessAcceptedProposalInstance,
  type CharacterHarnessAcceptedProposalInstance
} from "./accepted-proposal-instance.js";

export const CHARACTER_HARNESS_SOFT_SMILE_PROJECTION_7Y_VERSION =
  "character-harness-soft-smile-projection-7y.v1" as const;

export type CharacterHarnessEmbodiedCanonicalizer<TResult> = (input: unknown) => TResult;

export type CharacterHarnessSoftSmileProjectionInput = Readonly<{
  version: typeof CHARACTER_HARNESS_SOFT_SMILE_PROJECTION_7Y_VERSION;
  acceptedProposal: CharacterHarnessAcceptedProposalInstance;
  correlation: Readonly<{
    kind: "turn";
    reference: string;
  }>;
}>;

type UnknownObject = Record<string, unknown> & {
  version?: unknown;
  acceptedProposal?: unknown;
  correlation?: unknown;
  proposalInstance?: unknown;
  proposal?: unknown;
  reference?: unknown;
  createdAtMs?: unknown;
  kind?: unknown;
};

const OPAQUE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/;

/**
 * Project exactly one bounded Character semantic presentation intent into a 7B
 * candidate while leaving canonical protocol validation injected by composition.
 *
 * The accepted 7X proposal instance is revalidated before projection. The same
 * opaque proposal-instance reference is used as both the Character causal audit
 * anchor and the semantic source-instance identity: it identifies the accepted
 * Character proposal that caused this request, but remains distinct in meaning
 * from Runtime effect identity. Runtime later allocates its own effectId.
 *
 * Only a turn-correlated RESPOND proposal with presentation.intent="soft-smile"
 * is eligible. Session/decision correlation, arbitrary presentation strings,
 * provider/device metadata, Runtime trace identity, admission, execution, and
 * publication are intentionally outside this first Character-driven slice.
 */
export function projectCharacterHarnessSoftSmileToEmbodiedBehavior<TResult>(
  input: unknown,
  canonicalize: CharacterHarnessEmbodiedCanonicalizer<TResult>
): TResult | null {
  if (typeof canonicalize !== "function") {
    return null;
  }

  try {
    const value = expectObject(input);
    if (!hasExactKeys(value, ["version", "acceptedProposal", "correlation"])) {
      return null;
    }
    if (value.version !== CHARACTER_HARNESS_SOFT_SMILE_PROJECTION_7Y_VERSION) {
      return null;
    }

    const acceptedInput = expectObject(value.acceptedProposal);
    if (!hasExactKeys(acceptedInput, ["version", "proposalInstance", "proposal"])) {
      return null;
    }
    if (acceptedInput.version !== CHARACTER_HARNESS_ACCEPTED_PROPOSAL_INSTANCE_7X_VERSION) {
      return null;
    }

    const proposalInstanceInput = expectObject(acceptedInput.proposalInstance);
    if (!hasExactKeys(proposalInstanceInput, ["reference", "createdAtMs"])) {
      return null;
    }

    const accepted = allocateCharacterHarnessAcceptedProposalInstance(
      {
        version: "character-harness-5d.v1",
        status: "ACCEPTED",
        proposal: acceptedInput.proposal
      },
      () => ({
        reference: proposalInstanceInput.reference,
        createdAtMs: proposalInstanceInput.createdAtMs
      })
    );

    if (
      accepted.proposal.disposition !== "RESPOND" ||
      accepted.proposal.presentation?.intent !== "soft-smile"
    ) {
      return null;
    }

    const correlation = expectObject(value.correlation);
    if (!hasExactKeys(correlation, ["kind", "reference"])) {
      return null;
    }
    if (correlation.kind !== "turn" || !isOpaqueReference(correlation.reference)) {
      return null;
    }

    return canonicalize({
      version: "embodied-behavior-7b.v1",
      behavior: {
        version: "embodied-behavior-7a.v1",
        kind: "EXPRESSION",
        cause: {
          kind: "character",
          reference: accepted.proposalInstance.reference
        },
        intent: "soft-smile"
      },
      sourceInstance: {
        reference: accepted.proposalInstance.reference,
        createdAtMs: accepted.proposalInstance.createdAtMs
      },
      correlation: {
        kind: "turn",
        reference: correlation.reference
      }
    });
  } catch {
    return null;
  }
}

function isOpaqueReference(input: unknown): input is string {
  return (
    typeof input === "string" &&
    input.length >= 1 &&
    input.length <= 200 &&
    OPAQUE_REFERENCE_PATTERN.test(input)
  );
}

function expectObject(input: unknown): UnknownObject {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Character Harness soft-smile projection input must be an object.");
  }
  return input as UnknownObject;
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
