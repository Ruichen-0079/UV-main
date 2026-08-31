import {
  createCharacterHarnessCognitionRoundTrip,
  type CharacterHarnessCognitionRoundTrip
} from "@companion/character-harness/cognition-result";
import {
  createCognitionPostCapabilityReasoningTask
} from "@companion/cognition/post-capability-task";
import type { ProviderResolver } from "@companion/providers";
import { executeServerPostCapabilityCognition } from "./cognition-post-capability.js";

export type ServerPostCapabilityRoundTripInput = Readonly<{
  providers: Pick<ProviderResolver, "getReasoningProvider">;
  task: unknown;
  signal?: AbortSignal | undefined;
}>;

/**
 * Close one admitted post-capability Cognition pass back into the existing 5H
 * Character Harness round-trip contract.
 *
 * The 6P task is canonicalized before asynchronous provider execution and the
 * frozen escalation from that canonical task is retained for request/result
 * correlation. This prevents caller-side mutation during provider I/O from
 * changing the 5H request identity.
 *
 * This function does not project the result into Character ABI 2D, perform 5K
 * budgeting, invoke Character, execute another capability, retry, or persist.
 */
export async function executeServerPostCapabilityRoundTrip(
  input: ServerPostCapabilityRoundTripInput
): Promise<CharacterHarnessCognitionRoundTrip> {
  const task = createCognitionPostCapabilityReasoningTask(input.task);
  const result = await executeServerPostCapabilityCognition({
    providers: input.providers,
    task,
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });

  return createCharacterHarnessCognitionRoundTrip({
    request: task.task.escalation,
    result
  });
}
