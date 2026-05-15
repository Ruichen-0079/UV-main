import type {
  ProviderCapability,
  ProviderHealth,
  TextMessage,
  TokenUsage
} from "../types/common.js";
import { ProviderError, ProviderErrorCode } from "../types/errors.js";

export type DeepSeekProviderOptions = {
  apiKey: string | undefined;
  baseUrl: string;
  model: string | undefined;
  timeoutMs?: number | undefined;
  includeRawResponse?: boolean | undefined;
};

export type DeepSeekChatRequest = {
  messages: TextMessage[];
  model?: string | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  stopSequences?: string[] | undefined;
  stream?: boolean | undefined;
};

export type DeepSeekChatCompletion = {
  content: string;
  reasoningContent?: string | undefined;
  finishReason?: "stop" | "length" | "tool_call" | "content_filter" | "unknown" | undefined;
  model?: string | undefined;
  tokenUsage?: TokenUsage | undefined;
  rawResponse?: unknown | undefined;
};

type OpenAICompatibleUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

type OpenAICompatibleResponse = {
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
    };
  }>;
  usage?: OpenAICompatibleUsage;
};

export async function healthCheckDeepSeek(
  provider: string,
  capability: ProviderCapability,
  options: DeepSeekProviderOptions
): Promise<ProviderHealth> {
  try {
    ensureDeepSeekConfig(provider, capability, options);

    return {
      provider,
      name: provider,
      capability,
      configured: true,
      available: true,
      mock: false,
      required: capability === "chat",
      baseUrl: options.baseUrl,
      model: options.model,
      status: "degraded",
      checkedAt: new Date().toISOString(),
      message: "DeepSeek is configured but not verified by health check."
    };
  } catch (error) {
    if (error instanceof ProviderError) {
      return {
        provider,
        name: provider,
        capability,
        configured: false,
        available: false,
        mock: false,
        required: capability === "chat",
        baseUrl: options.baseUrl,
        model: options.model,
        status: "unavailable",
        checkedAt: new Date().toISOString(),
        message: error.message
      };
    }

    return {
      provider,
      name: provider,
      capability,
      configured: false,
      available: false,
      mock: false,
      required: capability === "chat",
      baseUrl: options.baseUrl,
      model: options.model,
      status: "unavailable",
      checkedAt: new Date().toISOString(),
      message: "DeepSeek health check failed."
    };
  }
}

export async function createDeepSeekChatCompletion(
  provider: string,
  capability: ProviderCapability,
  options: DeepSeekProviderOptions,
  request: DeepSeekChatRequest
): Promise<DeepSeekChatCompletion & { latencyMs: number }> {
  ensureDeepSeekConfig(provider, capability, options);

  const model = request.model ?? options.model;
  if (!model) {
    throw new ProviderError({
      provider,
      capability,
      code: ProviderErrorCode.ModelNotFound,
      message: `${provider} ${capability} model is not configured.`,
      retryable: false
    });
  }

  const start = performance.now();
  const response = await deepSeekFetch(provider, capability, options, "/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model,
      messages: request.messages,
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      stop: request.stopSequences,
      stream: request.stream ?? false
    })
  });
  const rawResponse = await parseJsonResponse(provider, capability, response);
  const completion = normalizeDeepSeekChatCompletion(provider, capability, rawResponse);

  return {
    ...completion,
    rawResponse: options.includeRawResponse ? rawResponse : undefined,
    latencyMs: Math.round(performance.now() - start)
  };
}

function ensureDeepSeekConfig(
  provider: string,
  capability: ProviderCapability,
  options: DeepSeekProviderOptions
): void {
  if (!options.apiKey) {
    throw new ProviderError({
      provider,
      capability,
      code: ProviderErrorCode.MissingApiKey,
      message: "DEEPSEEK_API_KEY is required.",
      retryable: false
    });
  }
}

async function deepSeekFetch(
  provider: string,
  capability: ProviderCapability,
  options: DeepSeekProviderOptions,
  path: string,
  init: RequestInit
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30000);

  try {
    const response = await fetch(`${trimTrailingSlash(options.baseUrl)}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${options.apiKey}`,
        ...init.headers
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw await createStatusError(provider, capability, response);
    }

    return response;
  } catch (error) {
    if (error instanceof ProviderError) {
      throw error;
    }

    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ProviderError({
        provider,
        capability,
        code: ProviderErrorCode.Timeout,
        message: "DeepSeek request timed out.",
        cause: error
      });
    }

    throw new ProviderError({
      provider,
      capability,
      code: ProviderErrorCode.NetworkError,
      message: "DeepSeek network request failed.",
      cause: error
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function createStatusError(
  provider: string,
  capability: ProviderCapability,
  response: Response
): Promise<ProviderError> {
  const code = mapStatusToProviderErrorCode(response.status);
  const safeBody = await readSafeErrorBody(response);

  return new ProviderError({
    provider,
    capability,
    code,
    statusCode: response.status,
    message: safeBody
      ? `DeepSeek request failed with ${response.status}: ${safeBody}`
      : `DeepSeek request failed with ${response.status}.`,
    retryable:
      code === ProviderErrorCode.RateLimited || code === ProviderErrorCode.ProviderUnavailable
  });
}

function mapStatusToProviderErrorCode(status: number): ProviderErrorCode {
  if (status === 401) {
    return ProviderErrorCode.InvalidApiKey;
  }

  if (status === 403) {
    return ProviderErrorCode.PermissionDenied;
  }

  if (status === 404) {
    return ProviderErrorCode.ModelNotFound;
  }

  if (status === 429) {
    return ProviderErrorCode.RateLimited;
  }

  return ProviderErrorCode.ProviderUnavailable;
}

async function parseJsonResponse(
  provider: string,
  capability: ProviderCapability,
  response: Response
): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new ProviderError({
      provider,
      capability,
      code: ProviderErrorCode.MalformedResponse,
      message: "DeepSeek returned a non-JSON response.",
      retryable: false,
      cause: error
    });
  }
}

function normalizeDeepSeekChatCompletion(
  provider: string,
  capability: ProviderCapability,
  rawResponse: unknown
): DeepSeekChatCompletion {
  if (!isOpenAICompatibleResponse(rawResponse)) {
    throw new ProviderError({
      provider,
      capability,
      code: ProviderErrorCode.MalformedResponse,
      message: "DeepSeek response did not match the expected chat completion shape.",
      retryable: false,
      cause: rawResponse
    });
  }

  const firstChoice = rawResponse.choices?.[0];
  const content = firstChoice?.message?.content;
  if (typeof content !== "string") {
    throw new ProviderError({
      provider,
      capability,
      code: ProviderErrorCode.MalformedResponse,
      message: "DeepSeek response did not include assistant message content.",
      retryable: false,
      cause: rawResponse
    });
  }

  return {
    content,
    reasoningContent: firstChoice?.message?.reasoning_content ?? undefined,
    finishReason: normalizeFinishReason(firstChoice?.finish_reason),
    model: rawResponse.model,
    tokenUsage: normalizeUsage(rawResponse.usage)
  };
}

function isOpenAICompatibleResponse(value: unknown): value is OpenAICompatibleResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as OpenAICompatibleResponse).choices)
  );
}

function normalizeUsage(usage: OpenAICompatibleUsage | undefined): TokenUsage | undefined {
  if (!usage) {
    return undefined;
  }

  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens
  };
}

function normalizeFinishReason(
  value: string | null | undefined
): DeepSeekChatCompletion["finishReason"] {
  if (
    value === "stop" ||
    value === "length" ||
    value === "tool_call" ||
    value === "content_filter"
  ) {
    return value;
  }

  return "unknown";
}

async function readSafeErrorBody(response: Response): Promise<string | undefined> {
  try {
    const text = await response.text();
    return redactSecrets(text).slice(0, 500) || undefined;
  } catch {
    return undefined;
  }
}

function redactSecrets(value: string): string {
  return value.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]");
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
