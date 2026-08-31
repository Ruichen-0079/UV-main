import { createCognitionReasoningTask } from "@companion/cognition";
import {
  createCognitionCapabilityObservation
} from "@companion/cognition/capability-observation";
import {
  COGNITION_6P_VERSION,
  createCognitionPostCapabilityReasoningTask
} from "@companion/cognition/post-capability-task";
import type {
  CharacterHarnessCognitionRoundTrip
} from "@companion/character-harness/cognition-result";
import type { ProviderResolver } from "@companion/providers";
import { executeServerPostCapabilityRoundTrip } from "./cognition-post-capability-roundtrip.js";

export type ServerObservationContinuationInput = Readonly<{
  providers: Pick<ProviderResolver, "getReasoningProvider">;
  /** Original caller-authorized 6A task. */
  task: unknown;
  /** One normalized 6N capability observation; evidence, not final truth. */
  observation: unknown;
  signal?: AbortSignal | undefined;
}>;

/**
 * Continue Cognition exactly once from one normalized capability observation
 * and close the assisted completion into the existing 5H round-trip seam.
 *
 * The original 6A task and 6N observation are canonicalized synchronously,
 * combined through the existing 6P contract, then delegated to the existing 6S
 * post-capability one-shot/correlation composition. The observation remains
 * evidence for reasoning and never becomes Memory/P8 truth by this composition.
 *
 * This seam performs no MCP discovery/invocation, Runtime capability admission,
 * second capability round, retry/fallback, persistence, Character ABI assembly,
 * Character generation request, or Character invocation.
 */
export async function executeServerObservationContinuation(
  input: ServerObservationContinuationInput
): Promise<CharacterHarnessCognitionRoundTrip> {
  const task = createCognitionReasoningTask(input.task);
  const observation = createCognitionCapabilityObservation(input.observation);
  const postCapabilityTask = createCognitionPostCapabilityReasoningTask({
    version: COGNITION_6P_VERSION,
    task,
    observation
  });

  return executeServerPostCapabilityRoundTrip({
    providers: input.providers,
    task: postCapabilityTask,
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
}
