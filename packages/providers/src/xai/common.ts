import type { ProviderCapability, ProviderHealth } from "../types/common.js";
import { ProviderError, ProviderErrorCode } from "../types/errors.js";

export type XAIProviderOptions = {
  apiKey: string | undefined;
  baseUrl: string;
  model: string | undefined;
  timeoutMs?: number | undefined;
  includeRawResponse?: boolean | undefined;
};

export async function healthCheckXAI(
  provider: string,
  capability: ProviderCapability,
  options: XAIProviderOptions
): Promise<ProviderHealth> {
  const start = performance.now();

  try {
    ensureXAIConfig(provider, capability, options);
    await xaiFetch(provider, capability, options, "/models", { method: "GET" });

    return {
      provider,
      status: "healthy",
      checkedAt: new Date().toISOString(),
      latencyMs: Math.round(performance.now() - start)
    };
  } catch (error) {
    return {
      provider,
      status: "unavailable",
      checkedAt: new Date().toISOString(),
      latencyMs: Math.round(performance.now() - start),
      message: error instanceof Error ? error.message : "xAI health check failed."
    };
  }
}

export function ensureXAIConfig(
  provider: string,
  capability: ProviderCapability,
  options: XAIProviderOptions
): void {
  if (!options.apiKey) {
    throw new ProviderError({
      provider,
      capability,
      code: ProviderErrorCode.MissingApiKey,
      message: "XAI_API_KEY is required.",
      retryable: false
    });
  }

  if (!options.model) {
    throw new ProviderError({
      provider,
      capability,
      code: ProviderErrorCode.ModelNotFound,
      message: `xAI ${capability} model is not configured.`,
      retryable: false
    });
  }
}

export async function xaiFetch(
  provider: string,
  capability: ProviderCapability,
  options: XAIProviderOptions,
  path: string,
  init: RequestInit
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30000);

  try {
    const response = await fetch(`${trimTrailingSlash(options.baseUrl)}${path}`, {
      ...init,
      headers: {
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
        message: "xAI request timed out.",
        cause: error
      });
    }

    throw new ProviderError({
      provider,
      capability,
      code: ProviderErrorCode.NetworkError,
      message: "xAI network request failed.",
      cause: error
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function parseJsonResponse(
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
      message: "xAI returned a non-JSON response.",
      retryable: false,
      cause: error
    });
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
    message: safeBody ? `xAI request failed with ${response.status}: ${safeBody}` : `xAI request failed with ${response.status}.`,
    retryable: code === ProviderErrorCode.RateLimited || code === ProviderErrorCode.ProviderUnavailable
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

  if (status === 400) {
    return ProviderErrorCode.UnsupportedInput;
  }

  return ProviderErrorCode.ProviderUnavailable;
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
