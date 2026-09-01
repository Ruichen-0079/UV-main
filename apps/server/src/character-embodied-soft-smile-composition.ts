import type { CharacterHarnessRepetitionSupervision } from "@companion/character-harness";
import {
  allocateCharacterHarnessAcceptedProposalInstance,
  type CharacterHarnessProposalInstanceAllocator
} from "@companion/character-harness/accepted-proposal-instance";
import {
  CHARACTER_HARNESS_SOFT_SMILE_PROJECTION_7Y_VERSION,
  projectCharacterHarnessSoftSmileToEmbodiedBehavior
} from "@companion/character-harness/embodied-soft-smile-projection";
import {
  RUNTIME_EMBODIED_EFFECT_RECORD_INITIALIZATION_7T_VERSION,
  allocateRuntimeEmbodiedEffectIdentity,
  initializeRuntimeEmbodiedEffectRecord,
  type RuntimeEmbodiedEffectIdAllocator,
  type RuntimeEmbodiedEffectRecordInitializationDecision
} from "@companion/core";
import {
  createCorrelatedEmbodiedBehavior,
  type CorrelatedEmbodiedBehavior
} from "@companion/protocol";

export type ServerCharacterSoftSmileRuntimePolicy = (
  behavior: CorrelatedEmbodiedBehavior
) => boolean;

export type ServerCharacterSoftSmileCompositionDependencies = Readonly<{
  allocateProposalInstance: CharacterHarnessProposalInstanceAllocator;
  allocateEffectId: RuntimeEmbodiedEffectIdAllocator;
  policyAllowsEmbodiedEffect: ServerCharacterSoftSmileRuntimePolicy;
}>;

/**
 * Compose the first Character-driven expression slice at the server boundary.
 *
 * This is deliberately composition rather than a new semantic contract: an
 * already-final 5D Harness result receives Harness-owned 7X instance identity,
 * 7Y projects only the bounded soft-smile meaning through the canonical Protocol
 * 7B validator, and the existing Runtime 7G -> 7T chain owns effect identity and
 * admission. The Runtime policy dependency sees only canonical semantic 7B data.
 *
 * This seam does not bind a Character model/provider, choose a Presentation
 * device or clip, construct Runtime traces, publish events, execute an effect,
 * or grant Harness/Presentation admission authority.
 */
export function composeServerCharacterSoftSmileEmbodiedEffect(
  generation: CharacterHarnessRepetitionSupervision,
  correlation: Readonly<{ kind: "turn"; reference: string }>,
  dependencies: ServerCharacterSoftSmileCompositionDependencies
): RuntimeEmbodiedEffectRecordInitializationDecision | null {
  assertDependencies(dependencies);

  const acceptedProposal = allocateCharacterHarnessAcceptedProposalInstance(
    generation,
    dependencies.allocateProposalInstance
  );

  const behavior = projectCharacterHarnessSoftSmileToEmbodiedBehavior(
    {
      version: CHARACTER_HARNESS_SOFT_SMILE_PROJECTION_7Y_VERSION,
      acceptedProposal,
      correlation
    },
    createCorrelatedEmbodiedBehavior
  );

  if (behavior === null) {
    return null;
  }

  const policyAllowsEmbodiedEffect = dependencies.policyAllowsEmbodiedEffect(behavior);
  if (typeof policyAllowsEmbodiedEffect !== "boolean") {
    throw new Error("Server embodied Runtime policy must return a boolean.");
  }

  const identity = allocateRuntimeEmbodiedEffectIdentity(
    behavior,
    dependencies.allocateEffectId
  );

  return initializeRuntimeEmbodiedEffectRecord({
    version: RUNTIME_EMBODIED_EFFECT_RECORD_INITIALIZATION_7T_VERSION,
    identity,
    policyAllowsEmbodiedEffect
  });
}

function assertDependencies(
  dependencies: ServerCharacterSoftSmileCompositionDependencies
): void {
  if (typeof dependencies !== "object" || dependencies === null) {
    throw new Error("Server Character embodied composition dependencies must be an object.");
  }
  if (typeof dependencies.allocateProposalInstance !== "function") {
    throw new Error("Server Character embodied composition requires a proposal-instance allocator.");
  }
  if (typeof dependencies.allocateEffectId !== "function") {
    throw new Error("Server Character embodied composition requires a Runtime effect-ID allocator.");
  }
  if (typeof dependencies.policyAllowsEmbodiedEffect !== "function") {
    throw new Error("Server Character embodied composition requires Runtime admission policy.");
  }
}
