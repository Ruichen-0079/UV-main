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
  mode?: "real" | "mock" | "unavailable" | undefined;
  mockAllowed?: boolean | undefined;
  missingFields?: string[] | undefined;
  required?: boolean | undefined;
  baseUrl?: string | undefined;
  model?: string | undefined;
  dimensions?: number | undefined;
  semanticEmbedding?: boolean | undefined;
  embeddingNote?: string | undefined;
  latencyMs?: number;
  checkedAt: string;
  message?: string;
  enabled?: boolean | undefined;
  priority?: number | undefined;
  fallbackEligible?: boolean | undefined;
  lastVerifiedAt?: string | undefined;
  lastError?: string | undefined;
};

export type ProviderRouteStatus = ProviderHealth & {
  capability: ProviderCapability;
  provider: string;
  enabled: boolean;
  priority: number;
  fallbackEligible: boolean;
};

export type ProviderAttempt = {
  provider: string;
  model?: string | undefined;
  status: "success" | "failed" | "skipped" | "unavailable";
  errorCode?: string | undefined;
  error?: string | undefined;
  latencyMs?: number | undefined;
  configured?: boolean | undefined;
  enabled?: boolean | undefined;
  priority?: number | undefined;
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
  fallbackUsed?: boolean | undefined;
  attemptedProviders?: ProviderAttempt[] | undefined;
  finalProvider?: string | undefined;
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
