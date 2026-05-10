import type { ProviderHealth } from "../types/common.js";
import type { ReasoningInput, ReasoningOutput, ReasoningProvider } from "../types/reasoning.js";
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
      stream: input.stream ?? false
    });

    return {
      reasoning: completion.reasoningContent ?? completion.content,
      answer: completion.reasoningContent ? completion.content : undefined,
      finishReason: completion.finishReason,
      model: completion.model,
      latencyMs: completion.latencyMs,
      tokenUsage: completion.tokenUsage,
      debug: completion.rawResponse ? { rawResponse: completion.rawResponse } : undefined
    };
  }
}
