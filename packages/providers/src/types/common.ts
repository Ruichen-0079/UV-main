export type ProviderCapability = "chat" | "reasoning" | "tts" | "stt" | "vision" | "embedding";

export type ProviderHealthStatus = "healthy" | "degraded" | "unavailable";

export type ProviderHealth = {
  status: ProviderHealthStatus;
  provider: string;
  name?: string | undefined;
  capability?: ProviderCapability | undefined;
  configured?: boolean | undefined;
  available?: boolean | undefined;
  mock?: boolean | undefined;
  required?: boolean | undefined;
  baseUrl?: string | undefined;
  model?: string | undefined;
  latencyMs?: number;
  checkedAt: string;
  message?: string;
};

export type TokenUsage = {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
};

export type ProviderDebug = {
  rawResponse?: unknown | undefined;
};

export type ProviderMetadata = {
  model?: string | undefined;
  latencyMs?: number | undefined;
  tokenUsage?: TokenUsage | undefined;
  providerMetadata?: Record<string, unknown> | undefined;
  /**
   * Debug metadata is opt-in and must never be emitted in runtime protocol events.
   */
  debug?: ProviderDebug | undefined;
};

export type TextMessageRole = "system" | "user" | "assistant" | "tool";

export type TextMessage = {
  role: TextMessageRole;
  content: string;
};
