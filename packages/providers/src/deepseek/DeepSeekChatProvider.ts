import type { ChatInput, ChatOutput, ChatProvider } from "../types/chat.js";
import type { ProviderHealth } from "../types/common.js";
import {
  createDeepSeekChatCompletion,
  healthCheckDeepSeek,
  streamDeepSeekChatCompletion,
  type DeepSeekProviderOptions
} from "./common.js";

export class DeepSeekChatProvider implements ChatProvider {
  readonly name = "deepseek";
  readonly streamingMode = "native" as const;

  constructor(private readonly options: DeepSeekProviderOptions) {}

  async healthCheck(): Promise<ProviderHealth> {
    return healthCheckDeepSeek(this.name, "chat", this.options);
  }

  async generateReply(input: ChatInput): Promise<ChatOutput> {
    const completion = await createDeepSeekChatCompletion(this.name, "chat", this.options, {
      messages: input.messages,
      model: input.model,
      temperature: input.temperature,
      maxTokens: input.maxTokens ?? input.maxOutputTokens,
      stopSequences: input.stopSequences,
      // Method selection is authoritative: generateReply is never a streamed
      // transport request, even when the legacy input field is set.
      stream: false
    });

    return {
      message: {
        role: "assistant",
        content: completion.content
      },
      finishReason: completion.finishReason,
      model: completion.model,
      latencyMs: completion.latencyMs,
      tokenUsage: completion.tokenUsage,
      debug: completion.rawResponse ? { rawResponse: completion.rawResponse } : undefined
    };
  }

  streamReply(input: ChatInput, options = {}) {
    return streamDeepSeekChatCompletion(this.name, this.options, input, options);
  }
}
