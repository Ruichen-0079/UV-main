import type { ProviderCapability } from "./common.js";

export const ProviderErrorCode = {
  MissingApiKey: "MISSING_API_KEY",
  InvalidApiKey: "INVALID_API_KEY",
  PermissionDenied: "PERMISSION_DENIED",
  ModelNotFound: "MODEL_NOT_FOUND",
  RateLimited: "RATE_LIMITED",
  Timeout: "TIMEOUT",
  NetworkError: "NETWORK_ERROR",
  MalformedResponse: "MALFORMED_RESPONSE",
  UnsupportedInput: "UNSUPPORTED_INPUT",
  ProviderUnavailable: "PROVIDER_UNAVAILABLE"
} as const;

export type ProviderErrorCode = typeof ProviderErrorCode[keyof typeof ProviderErrorCode];

export type ProviderErrorOptions = {
  provider: string;
  capability: ProviderCapability;
  code: ProviderErrorCode;
  message: string;
  retryable?: boolean;
  statusCode?: number;
  cause?: unknown;
};

export class ProviderError extends Error {
  readonly provider: string;
  readonly capability: ProviderCapability;
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  readonly statusCode: number | undefined;
  override readonly cause: unknown;

  constructor(options: ProviderErrorOptions) {
    super(options.message);
    this.name = "ProviderError";
    this.provider = options.provider;
    this.capability = options.capability;
    this.code = options.code;
    this.retryable = options.retryable ?? isRetryableProviderError(options.code);
    this.statusCode = options.statusCode;
    this.cause = options.cause;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      provider: this.provider,
      capability: this.capability,
      code: this.code,
      retryable: this.retryable,
      statusCode: this.statusCode,
      message: this.message
    };
  }
}

export function isRetryableProviderError(code: ProviderErrorCode): boolean {
  return code === ProviderErrorCode.RateLimited
    || code === ProviderErrorCode.Timeout
    || code === ProviderErrorCode.NetworkError
    || code === ProviderErrorCode.ProviderUnavailable;
}
