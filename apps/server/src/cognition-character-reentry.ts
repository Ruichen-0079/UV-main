import type { CharacterHarnessAdapterRequest } from "@companion/character-harness/adapter-request";
import { createCharacterHarnessAdapterRequest } from "@companion/character-harness/adapter-request";
import { createCharacterHarnessCognitionResultSection } from "@companion/character-harness/cognition-section";
import {
  assembleCharacterHarnessPostCognitionContext,
  type CharacterHarnessPostCognitionAssembly
} from "@companion/character-harness/post-cognition-assembly";

export type ServerPostCognitionCharacterRequestResult =
  | CharacterHarnessAdapterRequest
  | Extract<CharacterHarnessPostCognitionAssembly, { status: "COGNITION_RESULT_OVER_BUDGET" }>;

export type ServerPostCognitionCharacterRequestInput = Readonly<{
  /** Already-correlated Character Harness 5H Cognition round-trip. */
  roundTrip: unknown;
  /** Caller-authorized base Character ABI 2D context without COGNITION_RESULT. */
  context: unknown;
  /** Caller-selected Harness budget; this seam invents no priority or budget policy. */
  budget: unknown;
}>;

/**
 * Compose one completed Cognition round-trip back to the stable semantic
 * Character-generation request boundary.
 *
 * Existing Harness contracts remain the sole authorities at every step:
 * 5I projects the normalized result, 5K reserves/budgets the mandatory
 * Cognition Result, and 5L emits the provider-neutral CHARACTER_GENERATION
 * request. A 5K over-budget rejection is returned unchanged.
 *
 * No Character adapter/model is invoked here. This function performs no
 * provider call, capability/MCP work, retry, persistence, context retrieval,
 * budget selection, or Runtime state mutation.
 */
export function createServerPostCognitionCharacterRequest(
  input: ServerPostCognitionCharacterRequestInput
): ServerPostCognitionCharacterRequestResult {
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
