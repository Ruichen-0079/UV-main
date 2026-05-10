import type { ProviderHealth, ProviderMetadata, TextMessage } from "./common.js";

export type ReasoningInput = {
  messages: TextMessage[];
  model?: string | undefined;
  effort?: "low" | "medium" | "high" | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  maxOutputTokens?: number | undefined;
  stream?: boolean | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export type ReasoningOutput = ProviderMetadata & {
  reasoning: string;
  answer?: string | undefined;
  finishReason?: "stop" | "length" | "tool_call" | "content_filter" | "unknown" | undefined;
};

export interface ReasoningProvider {
  readonly name: string;
  healthCheck(): Promise<ProviderHealth>;
  generateReasoning(input: ReasoningInput): Promise<ReasoningOutput>;
}
