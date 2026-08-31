import {
  createCharacterHarnessCognitionRoundTrip,
  type CharacterHarnessCognitionRoundTrip
} from "@companion/character-harness/cognition-result";
import type { CharacterHarnessCognitionRequest } from "@companion/character-harness/cognition-request";
import {
  COGNITION_6A_VERSION,
  createCognitionFailureResult,
  createCognitionReasoningInput,
  normalizeCognitionReasoningOutput,
  type Cognition6AReasoningTask
} from "@companion/cognition";
import { executeRuntimeCognitionOnce } from "@companion/core";
import type { ProviderResolver } from "@companion/providers";

const cognitionBoundary = Object.freeze({
  createReasoningInput: createCognitionReasoningInput,
  normalizeReasoningOutput: normalizeCognitionReasoningOutput,
  createFailureResult: createCognitionFailureResult
});

export type ServerCognitionRoundTripInput = Readonly<{
  providers: Pick<ProviderResolver, "getReasoningProvider">;
  request: CharacterHarnessCognitionRequest;
  /** Runtime-authorized, privacy-minimized task statement for Cognition. */
  problem: string;
  signal?: AbortSignal | undefined;
}>;

/**
 * Compose one admitted Character -> Cognition -> Character semantic round-trip.
 *
 * This function is deliberately stateless: the current provider resolver is
 * supplied for every invocation, so server hot reload cannot leave Cognition
 * bound to a stale ProviderRegistry. Core retains provider execution and
 * cancellation authority; Cognition 6A retains normalization authority; the
 * Harness 5H boundary validates the result crossing back toward Character.
 *
 * No retry, fallback, persistence, capability/tool invocation, AppContext
 * mutation, or Character re-entry is performed here.
 */
export async function executeServerCognitionRoundTrip(
  input: ServerCognitionRoundTripInput
): Promise<CharacterHarnessCognitionRoundTrip> {
  const task: Cognition6AReasoningTask = Object.freeze({
    version: COGNITION_6A_VERSION,
    escalation: input.request,
    problem: input.problem
  });

  const result = await executeRuntimeCognitionOnce({
    providers: input.providers,
    boundary: cognitionBoundary,
    task,
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });

  return createCharacterHarnessCognitionRoundTrip({
    request: input.request,
    result
  });
}
