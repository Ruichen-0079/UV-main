import {
  createCharacterHarnessAdapterRequest,
  type CharacterHarnessAdapterRequest
} from "@companion/character-harness/adapter-request";
import {
  createCharacterHarnessCognitionResultSection
} from "@companion/character-harness/cognition-section";
import {
  assembleCharacterHarnessPostCognitionContext,
  type CharacterHarnessPostCognitionAssembly
} from "@companion/character-harness/post-cognition-assembly";

export type ServerPostCapabilityCharacterRequestInput = Readonly<{
  /** Existing 6S output: a validated 5H request/result round-trip. */
  roundTrip: unknown;
  /** Authorized Character ABI 2D base context without COGNITION_RESULT. */
  context: unknown;
  /** Existing Harness semantic budget. */
  budget: unknown;
}>;

export type ServerPostCapabilityCharacterRequestOutcome =
  | CharacterHarnessAdapterRequest
  | Extract<
      CharacterHarnessPostCognitionAssembly,
      { status: "COGNITION_RESULT_OVER_BUDGET" }
    >;

/**
 * Close the model-independent post-capability path into the existing 5L
 * Character-generation semantic request.
 *
 * This is transparent composition only:
 * 6S/5H round-trip -> 5I structured COGNITION_RESULT -> 5K reserved assembly
 * -> 5L semantic adapter request.
 *
 * A 5K mandatory-cognition over-budget outcome is returned unchanged instead
 * of being reclassified. No Character adapter/model is invoked here, and no
 * prompt serialization, provider routing, retry, persistence, or capability
 * execution occurs.
 */
export function createServerPostCapabilityCharacterRequest(
  input: ServerPostCapabilityCharacterRequestInput
): ServerPostCapabilityCharacterRequestOutcome {
  const cognitionProjection = createCharacterHarnessCognitionResultSection(input.roundTrip);
  const assembly = assembleCharacterHarnessPostCognitionContext({
    context: input.context,
    cognitionProjection,
    budget: input.budget
  });

  if (assembly.status === "COGNITION_RESULT_OVER_BUDGET") {
    return assembly;
  }

  return createCharacterHarnessAdapterRequest({ assembly });
}
