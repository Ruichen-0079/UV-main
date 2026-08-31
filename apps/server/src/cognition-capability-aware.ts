import {
  createCognitionCapabilityAwareFailureDisposition,
  createCognitionCapabilityAwareProtocolReasoningInput,
  createCognitionCapabilityAwareReasoningTask,
  interpretCognitionCapabilityAwareReasoningOutput,
  type CognitionCapabilityAwareReasoningDisposition,
  type CognitionCapabilityAwareReasoningTask
} from "@companion/cognition/capability-aware-task";
import { executeRuntimeCognitionOnce } from "@companion/core";
import type { ProviderResolver, ReasoningOutput } from "@companion/providers";

export type ServerCapabilityAwareCognitionInput = Readonly<{
  providers: Pick<ProviderResolver, "getReasoningProvider">;
  task: CognitionCapabilityAwareReasoningTask;
  signal?: AbortSignal | undefined;
}>;

/**
 * Execute exactly one capability-aware initial Cognition pass.
 *
 * Cognition 6U validates the caller-owned semantic task/inventory before
 * provider selection. The 6W protocol boundary owns serialization and output
 * interpretation; Core retains provider selection, cancellation, and one-shot
 * execution authority. The inventory captured by this invocation is used only
 * to revalidate a returned 6H REQUEST_CAPABILITY against the same current
 * semantic surface that was shown to the provider.
 *
 * This composition does not perform Runtime capability admission, MCP binding
 * or invocation, post-capability reasoning, retry/fallback, persistence,
 * Memory/P8 writes, Runtime events, or Character re-entry.
 */
export async function executeServerCapabilityAwareCognition(
  input: ServerCapabilityAwareCognitionInput
): Promise<CognitionCapabilityAwareReasoningDisposition> {
  const task = createCognitionCapabilityAwareReasoningTask(input.task);
  const boundary = Object.freeze({
    createReasoningInput: createCognitionCapabilityAwareProtocolReasoningInput,
    normalizeReasoningOutput: (output: ReasoningOutput) =>
      interpretCognitionCapabilityAwareReasoningOutput(output, task.capabilities),
    createFailureResult: createCognitionCapabilityAwareFailureDisposition
  });

  return executeRuntimeCognitionOnce({
    providers: input.providers,
    boundary,
    task,
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
}
