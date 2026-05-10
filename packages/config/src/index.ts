export type RuntimeEnvironment = "development" | "test" | "production";
export type MemoryRepositoryDriver = "memory" | "postgres";

export type ProviderCapability =
  | "chat"
  | "reasoning"
  | "tts"
  | "stt"
  | "vision"
  | "embedding";

export type ProviderSelection = Record<ProviderCapability, string>;

export type ProviderEndpointConfig = {
  provider: string;
  enabled: boolean;
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  model?: string | undefined;
  voice?: string | undefined;
  dimensions?: number | undefined;
};

export type RuntimeProviderConfig = {
  allowMocks: boolean;
  includeRawResponses: boolean;
  defaults: ProviderSelection;
  endpoints: Record<ProviderCapability, ProviderEndpointConfig>;
};

export type RuntimeConfig = {
  environment: RuntimeEnvironment;
  server: {
    host: string;
    port: number;
    logLevel: string;
  };
  memory: {
    repository: MemoryRepositoryDriver;
    databaseUrl?: string | undefined;
  };
  providers: RuntimeProviderConfig;
  infrastructure: {
    redisUrl?: string | undefined;
    natsUrl?: string | undefined;
    eventBusDriver: string;
  };
};

export type RuntimeConfigEnv = Record<string, string | undefined>;

export type ConfigValidationIssue = {
  path: string;
  message: string;
};

export class ConfigValidationError extends Error {
  readonly issues: ConfigValidationIssue[];

  constructor(issues: ConfigValidationIssue[]) {
    super(`Runtime configuration is invalid:\n- ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n- ")}`);
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

const defaultProviderSelection: ProviderSelection = {
  chat: "deepseek",
  reasoning: "deepseek",
  tts: "xai",
  stt: "dashscope",
  vision: "xai",
  embedding: "mock"
};

export function parseRuntimeConfig(env: RuntimeConfigEnv = process.env): RuntimeConfig {
  const environment = parseEnvironment(env["NODE_ENV"]);
  const allowMocks = parseBoolean(env["PROVIDER_ALLOW_MOCKS"], environment !== "production");
  const defaults = parseProviderSelection(env);

  return {
    environment,
    server: {
      host: readString(env["SERVER_HOST"], "127.0.0.1"),
      port: parsePort(env["SERVER_PORT"], 3000),
      logLevel: readString(env["LOG_LEVEL"], "info")
    },
    memory: {
      repository: parseMemoryRepository(env["MEMORY_REPOSITORY"]),
      databaseUrl: emptyToUndefined(env["DATABASE_URL"])
    },
    providers: {
      allowMocks,
      includeRawResponses: parseBoolean(env["PROVIDER_INCLUDE_RAW_RESPONSES"], false),
      defaults,
      endpoints: {
        chat: {
          provider: defaults.chat,
          enabled: true,
          baseUrl: readProviderBaseUrl(defaults.chat, env["DEEPSEEK_API_BASEURL"], "https://api.deepseek.com"),
          apiKey: emptyToUndefined(env["DEEPSEEK_API_KEY"]),
          model: emptyToUndefined(env["DEEPSEEK_CHAT_MODEL"])
        },
        reasoning: {
          provider: defaults.reasoning,
          enabled: true,
          baseUrl: readProviderBaseUrl(defaults.reasoning, env["DEEPSEEK_API_BASEURL"], "https://api.deepseek.com"),
          apiKey: emptyToUndefined(env["DEEPSEEK_API_KEY"]),
          model: emptyToUndefined(env["DEEPSEEK_REASONING_MODEL"])
        },
        tts: {
          provider: defaults.tts,
          enabled: parseBoolean(env["TTS_ENABLED"], true),
          baseUrl: readProviderBaseUrl(defaults.tts, env["XAI_API_BASEURL"], "https://api.x.ai/v1"),
          apiKey: emptyToUndefined(env["XAI_API_KEY"]),
          model: emptyToUndefined(env["XAI_TTS_MODEL"]),
          voice: emptyToUndefined(env["XAI_TTS_VOICE"])
        },
        stt: {
          provider: defaults.stt,
          enabled: parseBoolean(env["STT_ENABLED"], true),
          baseUrl: readProviderBaseUrl(defaults.stt, env["DASHSCOPE_API_BASEURL"], "https://dashscope.aliyuncs.com/api/v1"),
          apiKey: emptyToUndefined(env["DASHSCOPE_API_KEY"]),
          model: emptyToUndefined(env["DASHSCOPE_STT_MODEL"])
        },
        vision: {
          provider: defaults.vision,
          enabled: parseBoolean(env["VISION_ENABLED"], true),
          baseUrl: readProviderBaseUrl(defaults.vision, env["XAI_API_BASEURL"], "https://api.x.ai/v1"),
          apiKey: emptyToUndefined(env["XAI_API_KEY"]),
          model: emptyToUndefined(env["XAI_VISION_MODEL"])
        },
        embedding: {
          provider: defaults.embedding,
          enabled: parseBoolean(env["EMBEDDING_ENABLED"], true),
          baseUrl: emptyToUndefined(env["EMBEDDING_API_BASEURL"]),
          apiKey: emptyToUndefined(env["EMBEDDING_API_KEY"]),
          model: emptyToUndefined(env["EMBEDDING_MODEL"]),
          dimensions: parsePositiveInteger(env["EMBEDDING_DIMENSIONS"], 1536)
        }
      }
    },
    infrastructure: {
      redisUrl: emptyToUndefined(env["REDIS_URL"]),
      natsUrl: emptyToUndefined(env["NATS_URL"]),
      eventBusDriver: readString(env["EVENT_BUS_DRIVER"], "memory")
    }
  };
}

export function validateRuntimeConfig(config: RuntimeConfig): void {
  const issues = collectRuntimeConfigIssues(config);

  if (issues.length > 0) {
    throw new ConfigValidationError(issues);
  }
}

export function collectRuntimeConfigIssues(config: RuntimeConfig): ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = [];

  if (config.memory.repository === "postgres" && !config.memory.databaseUrl) {
    issues.push({
      path: "memory.databaseUrl",
      message: "DATABASE_URL is required when MEMORY_REPOSITORY=postgres."
    });
  }

  for (const capability of providerCapabilities) {
    const endpoint = config.providers.endpoints[capability];

    if (!endpoint.enabled || endpoint.provider === "mock") {
      continue;
    }

    const requiresSecrets = !config.providers.allowMocks;

    if (requiresSecrets && !endpoint.apiKey) {
      issues.push({
        path: `providers.endpoints.${capability}.apiKey`,
        message: `${providerEnvPrefix(endpoint.provider)} API key is required when ${capability} provider '${endpoint.provider}' is enabled.`
      });
    }

    if (requiresSecrets && !endpoint.model && capability !== "embedding") {
      issues.push({
        path: `providers.endpoints.${capability}.model`,
        message: `Model is required when ${capability} provider '${endpoint.provider}' is enabled.`
      });
    }
  }

  return issues;
}

export function redactSecret(value: string | undefined): string | undefined {
  if (!value) {
    return value;
  }

  if (value.length <= 8) {
    return "[redacted]";
  }

  return `${value.slice(0, 3)}...[redacted]...${value.slice(-3)}`;
}

export function redactConfig<T>(value: T): T {
  return redactValue(value) as T;
}

const providerCapabilities: ProviderCapability[] = ["chat", "reasoning", "tts", "stt", "vision", "embedding"];

function parseProviderSelection(env: RuntimeConfigEnv): ProviderSelection {
  return {
    chat: readString(env["DEFAULT_CHAT_PROVIDER"], defaultProviderSelection.chat),
    reasoning: readString(env["DEFAULT_REASONING_PROVIDER"], defaultProviderSelection.reasoning),
    tts: readString(env["DEFAULT_TTS_PROVIDER"], defaultProviderSelection.tts),
    stt: readString(env["DEFAULT_STT_PROVIDER"], defaultProviderSelection.stt),
    vision: readString(env["DEFAULT_VISION_PROVIDER"], defaultProviderSelection.vision),
    embedding: readString(env["DEFAULT_EMBEDDING_PROVIDER"] ?? env["EMBEDDING_PROVIDER"], defaultProviderSelection.embedding)
  };
}

function parseEnvironment(value: string | undefined): RuntimeEnvironment {
  if (value === "production" || value === "test" || value === "development") {
    return value;
  }

  return "development";
}

function parseMemoryRepository(value: string | undefined): MemoryRepositoryDriver {
  if (value === "postgres") {
    return "postgres";
  }

  return "memory";
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parsePort(value: string | undefined, fallback: number): number {
  const port = parsePositiveInteger(value, fallback);
  return port > 65535 ? fallback : port;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readString(value: string | undefined, fallback: string): string {
  return emptyToUndefined(value) ?? fallback;
}

function readProviderBaseUrl(provider: string, value: string | undefined, fallback: string): string | undefined {
  if (provider === "mock") {
    return undefined;
  }

  return readString(value, fallback);
}

function emptyToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function providerEnvPrefix(provider: string): string {
  switch (provider) {
    case "deepseek":
      return "DEEPSEEK";
    case "xai":
      return "XAI";
    case "dashscope":
      return "DASHSCOPE";
    default:
      return provider.toUpperCase();
  }
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }

  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};

    for (const [key, nestedValue] of Object.entries(value)) {
      result[key] = isSensitiveKey(key) && typeof nestedValue === "string"
        ? redactSecret(nestedValue)
        : redactValue(nestedValue);
    }

    return result;
  }

  return value;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized.includes("apikey")
    || normalized.includes("api_key")
    || normalized.includes("authorization")
    || normalized.includes("token")
    || normalized.includes("secret")
    || normalized.includes("password");
}
