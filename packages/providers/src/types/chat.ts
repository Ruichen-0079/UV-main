import type { ProviderHealth, ProviderMetadata, TextMessage } from "./common.js";

export type ChatInput = {
  messages: TextMessage[];
  model?: string | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  maxOutputTokens?: number | undefined;
  stopSequences?: string[] | undefined;
  stream?: boolean | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export type ChatOutput = ProviderMetadata & {
  message: TextMessage;
  finishReason?: "stop" | "length" | "tool_call" | "content_filter" | "unknown" | undefined;
};

export type ChatStreamingMode = "unsupported" | "native" | "compatible";

export type ChatStreamOptions = {
  signal?: AbortSignal | undefined;
};

export type ChatStreamEvent =
  | {
      type: "text-delta";
      text: string;
    }
  | {
      type: "completed";
      output: ChatOutput;
    };

export interface ChatProvider {
  readonly name: string;
  readonly streamingMode?: ChatStreamingMode | undefined;
  healthCheck(): Promise<ProviderHealth>;
  generateReply(input: ChatInput): Promise<ChatOutput>;
  streamReply?(
    input: ChatInput,
    options?: ChatStreamOptions | undefined
  ): AsyncIterable<ChatStreamEvent>;
}
