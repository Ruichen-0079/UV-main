import type { ProviderHealth } from "../types/common.js";
import {
  normalizeReasoningOutput,
  type ReasoningInput,
  type ReasoningOutput,
  type ReasoningProvider
} from "../types/reasoning.js";
import {
  createDeepSeekChatCompletion,
  healthCheckDeepSeek,
  type DeepSeekProviderOptions
} from "./common.js";

export class DeepSeekReasoningProvider implements ReasoningProvider {
  readonly name = "deepseek";

  constructor(private readonly options: DeepSeekProviderOptions) {}

  async healthCheck(): Promise<ProviderHealth> {
    return healthCheckDeepSeek(this.name, "reasoning", this.options);
  }

  async generateReasoning(input: ReasoningInput): Promise<ReasoningOutput> {
    const completion = await createDeepSeekChatCompletion(this.name, "reasoning", this.options, {
      messages: input.messages,
      model: input.model,
      temperature: input.temperature,
      maxTokens: input.maxTokens ?? input.maxOutputTokens,
      // generateReasoning is non-streaming. The deprecated input.stream flag
      // must not create a second transport control plane.
      stream: false
    });

    return normalizeReasoningOutput(this.name, {
      // DeepSeek's reasoning_content is provider-internal trace and is
      // intentionally not copied into the normalized compatibility field.
      answer: completion.content,
      finishReason: completion.finishReason,
      model: completion.model,
      latencyMs: completion.latencyMs,
      tokenUsage: completion.tokenUsage
    });
  }
}
