import { createCognitionReasoningTask } from "@companion/cognition";
import type { CharacterHarnessCognitionRoundTrip } from "@companion/character-harness/cognition-result";
import type { ProviderResolver } from "@companion/providers";
import type { ServerMcpCapabilityBindings } from "./mcp-capability-binding.js";
import type { ServerMcpClient } from "./mcp-client.js";
import { executeServerObservationContinuation } from "./cognition-observation-continuation.js";
import { executeServerReadTextObservationRound } from "./cognition-read-text-observation.js";

export type ServerReadTextAssistedCompletionInput = Readonly<{
  providers: Pick<ProviderResolver, "getReasoningProvider">;
  mcpClient: Pick<ServerMcpClient, "listTools" | "callTool">;
  staticRegistry: ServerMcpCapabilityBindings;
  /** Original caller-authorized 6A task. */
  task: unknown;
  /** One already-proposed Cognition 6H semantic read-text request. */
  request: unknown;
  capabilityRoundsUsed: number;
  policyAllowsCapability: boolean;
  /** Runtime-authorized concrete path; never derived from Cognition request text. */
  runtimeAuthorizedPath: string;
  signal?: AbortSignal | undefined;
}>;

/**
 * Complete the single Phase-6 assisted read-text path after Cognition has
 * proposed one 6H request.
 *
 * The original 6A task is canonicalized before any MCP I/O. Existing 6Z owns
 * the one admitted read-text invocation and 6O observation normalization;
 * existing 6AA owns exactly one post-observation Cognition pass and 5H
 * correlation. This composition adds no second capability opportunity.
 *
 * It does not perform initial capability-aware Cognition, mutate/persist round
 * state, retry/fallback, write Memory/P8, assemble Character ABI context, emit a
 * Character generation request, or invoke Character.
 */
export async function executeServerReadTextAssistedCompletion(
  input: ServerReadTextAssistedCompletionInput
): Promise<CharacterHarnessCognitionRoundTrip> {
  const task = createCognitionReasoningTask(input.task);

  const observed = await executeServerReadTextObservationRound({
    mcpClient: input.mcpClient,
    staticRegistry: input.staticRegistry,
    request: input.request,
    capabilityRoundsUsed: input.capabilityRoundsUsed,
    policyAllowsCapability: input.policyAllowsCapability,
    runtimeAuthorizedPath: input.runtimeAuthorizedPath,
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });

  return executeServerObservationContinuation({
    providers: input.providers,
    task,
    observation: observed.observation,
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
}
