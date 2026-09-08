import type { ChatOutput } from "./chat.js";
import type { ProviderCallOptions, ProviderMetadata } from "./common.js";

export type ProactiveDecision = "NO_OP" | "REQUEST_TEXT";

export type ProactiveDecisionInput = {
  prompt: string;
};

export type ProactiveDecisionOutput = ProviderMetadata &
  (
    | { score: number; decision?: never }
    /** Legacy injected-provider compatibility; production emits only score. */
    | { decision: ProactiveDecision; score?: never }
  );

/** Pure machine-control capability. Its output is never user-visible text. */
export interface ProactiveDecisionProvider {
  readonly name: string;
  decide(
    input: ProactiveDecisionInput,
    options?: ProviderCallOptions
  ): Promise<ProactiveDecisionOutput>;
}

export type AssistantContinuationInput = {
  prompt: string;
  maxTokens?: number | undefined;
};

/** Generates one assistant continuation without manufacturing a Runtime user turn. */
export interface AssistantContinuationProvider {
  readonly name: string;
  generateContinuation(
    input: AssistantContinuationInput,
    options?: ProviderCallOptions
  ): Promise<ChatOutput>;
}
