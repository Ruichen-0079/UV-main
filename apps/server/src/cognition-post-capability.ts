import {
  createCognitionFailureResult,
  normalizeCognitionReasoningOutput
} from "@companion/cognition";
import {
  createCognitionPostCapabilityReasoningInput,
  type CognitionPostCapabilityReasoningTask
} from "@companion/cognition/post-capability-task";
import { executeRuntimeCognitionOnce } from "@companion/core";
import type { ProviderResolver } from "@companion/providers";

const postCapabilityBoundary = Object.freeze({
  createReasoningInput: createCognitionPostCapabilityReasoningInput,
  normalizeReasoningOutput: normalizeCognitionReasoningOutput,
  createFailureResult: createCognitionFailureResult
});

export type ServerPostCapabilityCognitionInput = Readonly<{
  providers: Pick<ProviderResolver, "getReasoningProvider">;
  task: CognitionPostCapabilityReasoningTask;
  signal?: AbortSignal | undefined;
}>;

/**
 * Execute exactly one post-capability Cognition reasoning pass.
 *
 * The 6Q boundary revalidates/serializes the 6P semantic task. Core retains
 * provider selection, cancellation, and one-shot execution authority. The
 * existing 6A boundary remains the sole producer of the normalized Cognition
 * result, so this composition introduces no second result interpretation.
 *
 * No capability invocation, retry/fallback, persistence, round mutation,
 * Character re-entry, or provider/model tuning occurs here.
 */
export async function executeServerPostCapabilityCognition(
  input: ServerPostCapabilityCognitionInput
): Promise<ReturnType<typeof normalizeCognitionReasoningOutput>> {
  return executeRuntimeCognitionOnce({
    providers: input.providers,
    boundary: postCapabilityBoundary,
    task: input.task,
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
}
