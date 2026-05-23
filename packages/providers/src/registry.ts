import type { ChatInput, ChatOutput, ChatProvider } from "./types/chat.js";
import type { EmbeddingProvider } from "./types/embedding.js";
import type { ProviderCapability, ProviderHealth } from "./types/common.js";
import type { ReasoningInput, ReasoningOutput, ReasoningProvider } from "./types/reasoning.js";
import type { STTInput, STTOutput, STTProvider } from "./types/stt.js";
import type { TTSInput, TTSOutput, TTSProvider } from "./types/tts.js";
import type { VisionInput, VisionOutput, VisionProvider } from "./types/vision.js";
import { ProviderError, ProviderErrorCode } from "./types/errors.js";
import { DeepSeekChatProvider } from "./deepseek/DeepSeekChatProvider.js";
import { DeepSeekReasoningProvider } from "./deepseek/DeepSeekReasoningProvider.js";
import { XAITTSProvider } from "./xai/XAITTSProvider.js";
import { XAIVisionProvider } from "./xai/XAIVisionProvider.js";
import { DashScopeSTTProvider } from "./alibaba/DashScopeSTTProvider.js";

export type ProviderRegistryConfig = {
  environment: "development" | "test" | "production";
  allowMocks: boolean;
  includeRawProviderResponses: boolean;
  databaseUrl: string | undefined;
  defaults: {
    chat: string;
    reasoning: string;
    tts: string;
    stt: string;
    vision: string;
    embedding: string;
  };
  deepseek: {
    apiKey: string | undefined;
    baseUrl: string;
    chatModel: string | undefined;
    reasoningModel: string | undefined;
  };
  xai: {
    apiKey: string | undefined;
    baseUrl: string;
    ttsModel: string | undefined;
    ttsVoice: string | undefined;
    visionModel: string | undefined;
  };
  dashscope: {
    apiKey: string | undefined;
    baseUrl: string;
    sttModel: string | undefined;
  };
  embedding: {
    apiKey: string | undefined;
    baseUrl: string | undefined;
    model: string | undefined;
    dimensions: number;
  };
};

type ProviderEnv = Record<string, string | undefined>;

export interface ProviderResolver {
  getChatProvider(): ChatProvider;
  getReasoningProvider(): ReasoningProvider;
  getTTSProvider(): TTSProvider;
  getSTTProvider(): STTProvider;
  getVisionProvider(): VisionProvider;
  getEmbeddingProvider(): EmbeddingProvider;
  getStatus?(): ProviderStatusMap;
}

export type ProviderStatusMap = {
  providers: Record<ProviderCapability, ProviderHealth>;
};

export class ProviderRegistry implements ProviderResolver {
  private readonly chatProviders = new Map<string, ChatProvider>();
  private readonly reasoningProviders = new Map<string, ReasoningProvider>();
  private readonly ttsProviders = new Map<string, TTSProvider>();
  private readonly sttProviders = new Map<string, STTProvider>();
  private readonly visionProviders = new Map<string, VisionProvider>();
  private readonly embeddingProviders = new Map<string, EmbeddingProvider>();

  constructor(private readonly config: ProviderRegistryConfig) {}

  registerChatProvider(provider: ChatProvider): void {
    this.chatProviders.set(provider.name, provider);
  }

  registerReasoningProvider(provider: ReasoningProvider): void {
    this.reasoningProviders.set(provider.name, provider);
  }

  registerTTSProvider(provider: TTSProvider): void {
    this.ttsProviders.set(provider.name, provider);
  }

  registerSTTProvider(provider: STTProvider): void {
    this.sttProviders.set(provider.name, provider);
  }

  registerVisionProvider(provider: VisionProvider): void {
    this.visionProviders.set(provider.name, provider);
  }

  registerEmbeddingProvider(provider: EmbeddingProvider): void {
    this.embeddingProviders.set(provider.name, provider);
  }

  getChatProvider(): ChatProvider {
    return this.getRequiredProvider(this.chatProviders, this.config.defaults.chat, "chat");
  }

  getReasoningProvider(): ReasoningProvider {
    return this.getRequiredProvider(
      this.reasoningProviders,
      this.config.defaults.reasoning,
      "reasoning"
    );
  }

  getTTSProvider(): TTSProvider {
    return this.getRequiredProvider(this.ttsProviders, this.config.defaults.tts, "tts");
  }

  getSTTProvider(): STTProvider {
    return this.getRequiredProvider(this.sttProviders, this.config.defaults.stt, "stt");
  }

  getVisionProvider(): VisionProvider {
    return this.getRequiredProvider(this.visionProviders, this.config.defaults.vision, "vision");
  }

  getEmbeddingProvider(): EmbeddingProvider {
    return this.getRequiredProvider(
      this.embeddingProviders,
      this.config.defaults.embedding,
      "embedding"
    );
  }

  getStatus(): ProviderStatusMap {
    return {
      providers: {
        chat: this.createStatus("chat", this.config.defaults.chat),
        reasoning: this.createStatus("reasoning", this.config.defaults.reasoning),
        tts: this.createStatus("tts", this.config.defaults.tts),
        stt: this.createStatus("stt", this.config.defaults.stt),
        vision: this.createStatus("vision", this.config.defaults.vision),
        embedding: this.createStatus("embedding", this.config.defaults.embedding)
      }
    };
  }

  private getRequiredProvider<TProvider>(
    providers: Map<string, TProvider>,
    name: string,
    capability: "chat" | "reasoning" | "tts" | "stt" | "vision" | "embedding"
  ): TProvider {
    const provider = providers.get(name);
    if (!provider) {
      throw new ProviderError({
        provider: name,
        capability,
        code: ProviderErrorCode.ProviderUnavailable,
        message: `Provider '${name}' is not registered for capability '${capability}'.`,
        retryable: false
      });
    }

    return provider;
  }

  private createStatus(capability: ProviderCapability, name: string): ProviderHealth {
    const configured = this.isConfigured(capability, name);
    const mock =
      (capability === "embedding" && name === "mock") || (!configured && this.config.allowMocks);
    const required = capability === "chat";
    const available = configured || mock;
    const status = available ? (mock ? "healthy" : "degraded") : "unavailable";

    return {
      provider: name,
      name,
      capability,
      configured,
      available,
      mock,
      required,
      status,
      checkedAt: new Date().toISOString(),
      ...this.safeProviderMetadata(capability, name),
      ...(capability === "embedding" && name === "mock"
        ? {
            semanticEmbedding: false,
            embeddingNote:
              "Mock embeddings validate the retrieval pipeline but do not provide real semantic similarity."
          }
        : capability === "embedding"
          ? { semanticEmbedding: configured }
          : {}),
      message: providerStatusMessage({ capability, name, configured, mock, required })
    };
  }

  private isConfigured(capability: ProviderCapability, name: string): boolean {
    if ((capability === "chat" || capability === "reasoning") && name === "deepseek") {
      return Boolean(
        this.config.deepseek.apiKey &&
        (capability === "chat"
          ? this.config.deepseek.chatModel
          : this.config.deepseek.reasoningModel)
      );
    }

    if (capability === "tts" && name === "xai") {
      return Boolean(this.config.xai.apiKey && this.config.xai.ttsModel);
    }

    if (capability === "vision" && name === "xai") {
      return Boolean(this.config.xai.apiKey && this.config.xai.visionModel);
    }

    if (capability === "stt" && name === "dashscope") {
      return Boolean(this.config.dashscope.apiKey && this.config.dashscope.sttModel);
    }

    if (capability === "embedding") {
      if (name === "mock") {
        return true;
      }
      return Boolean(this.config.embedding.apiKey && this.config.embedding.model);
    }

    return false;
  }

  private safeProviderMetadata(
    capability: ProviderCapability,
    name: string
  ): Pick<ProviderHealth, "baseUrl" | "model" | "dimensions"> {
    if ((capability === "chat" || capability === "reasoning") && name === "deepseek") {
      return {
        baseUrl: this.config.deepseek.baseUrl,
        model:
          capability === "chat"
            ? this.config.deepseek.chatModel
            : this.config.deepseek.reasoningModel
      };
    }

    if ((capability === "tts" || capability === "vision") && name === "xai") {
      return {
        baseUrl: this.config.xai.baseUrl,
        model: capability === "tts" ? this.config.xai.ttsModel : this.config.xai.visionModel
      };
    }

    if (capability === "stt" && name === "dashscope") {
      return {
        baseUrl: this.config.dashscope.baseUrl,
        model: this.config.dashscope.sttModel
      };
    }

    if (capability === "embedding") {
      return {
        baseUrl: this.config.embedding.baseUrl,
        model: this.config.embedding.model ?? (name === "mock" ? "mock" : undefined),
        dimensions: this.config.embedding.dimensions
      };
    }

    return {};
  }
}

function providerStatusMessage(input: {
  capability: ProviderCapability;
  name: string;
  configured: boolean;
  mock: boolean;
  required: boolean;
}): string {
  if (input.configured) {
    return `${input.name} ${input.capability} provider is configured; health is config-only and unverified.`;
  }

  if (input.mock) {
    return `${input.name} ${input.capability} provider is using mock fallback.`;
  }

  return input.required
    ? `${input.name} ${input.capability} provider is required but not configured.`
    : `${input.name} ${input.capability} provider is optional and not configured.`;
}

export function createProviderRegistryFromEnv(env: ProviderEnv = process.env): ProviderRegistry {
  const config = createProviderRegistryConfigFromEnv(env);

  const registry = new ProviderRegistry(config);
  registry.registerChatProvider(resolveChatProvider(config));
  registry.registerReasoningProvider(resolveReasoningProvider(config));
  registry.registerTTSProvider(resolveTTSProvider(config));
  registry.registerSTTProvider(resolveSTTProvider(config));
  registry.registerVisionProvider(resolveVisionProvider(config));
  registry.registerEmbeddingProvider(resolveEmbeddingProvider(config));

  return registry;
}

export function createProviderRegistryConfigFromEnv(env: ProviderEnv): ProviderRegistryConfig {
  const environment = parseEnvironment(env["NODE_ENV"]);
  const allowMocks = parseBoolean(env["PROVIDER_ALLOW_MOCKS"]);

  return {
    environment,
    allowMocks,
    includeRawProviderResponses: parseBoolean(env["PROVIDER_INCLUDE_RAW_RESPONSES"]),
    databaseUrl: emptyToUndefined(env["DATABASE_URL"]),
    defaults: {
      chat: env["DEFAULT_CHAT_PROVIDER"] ?? "deepseek",
      reasoning: env["DEFAULT_REASONING_PROVIDER"] ?? "deepseek",
      tts: env["DEFAULT_TTS_PROVIDER"] ?? "xai",
      stt: env["DEFAULT_STT_PROVIDER"] ?? "dashscope",
      vision: env["DEFAULT_VISION_PROVIDER"] ?? "xai",
      embedding:
        env["DEFAULT_EMBEDDING_PROVIDER"] ??
        env["EMBEDDING_PROVIDER"] ??
        (allowMocks ? "mock" : "openai-compatible")
    },
    deepseek: {
      apiKey: emptyToUndefined(env["DEEPSEEK_API_KEY"]),
      baseUrl:
        env["DEEPSEEK_API_BASEURL"] ?? env["DEEPSEEK_BASE_URL"] ?? "https://api.deepseek.com",
      chatModel: emptyToUndefined(env["DEEPSEEK_CHAT_MODEL"]),
      reasoningModel: emptyToUndefined(env["DEEPSEEK_REASONING_MODEL"])
    },
    xai: {
      apiKey: emptyToUndefined(env["XAI_API_KEY"]),
      baseUrl: env["XAI_API_BASEURL"] ?? env["XAI_BASE_URL"] ?? "https://api.x.ai/v1",
      ttsModel: emptyToUndefined(env["XAI_TTS_MODEL"]),
      ttsVoice: emptyToUndefined(env["XAI_TTS_VOICE"]),
      visionModel: emptyToUndefined(env["XAI_VISION_MODEL"])
    },
    dashscope: {
      apiKey: emptyToUndefined(env["DASHSCOPE_API_KEY"]),
      baseUrl:
        env["DASHSCOPE_API_BASEURL"] ??
        env["DASHSCOPE_BASE_URL"] ??
        "https://dashscope.aliyuncs.com/api/v1",
      sttModel: emptyToUndefined(env["DASHSCOPE_STT_MODEL"])
    },
    embedding: {
      apiKey: emptyToUndefined(env["EMBEDDING_API_KEY"]),
      baseUrl:
        emptyToUndefined(env["EMBEDDING_API_BASEURL"]) ??
        emptyToUndefined(env["EMBEDDING_BASE_URL"]),
      model: emptyToUndefined(env["EMBEDDING_MODEL"]),
      dimensions: parsePositiveInteger(env["EMBEDDING_DIMENSIONS"], 1536)
    }
  };
}

export function validateRequiredProviderConfig(config: ProviderRegistryConfig): void {
  const errors: string[] = [];

  if (!config.allowMocks && config.defaults.chat === "deepseek" && !config.deepseek.apiKey) {
    errors.push("DEEPSEEK_API_KEY is required when DEFAULT_CHAT_PROVIDER=deepseek.");
  }

  if (!config.allowMocks && config.defaults.chat === "deepseek" && !config.deepseek.chatModel) {
    errors.push("DEEPSEEK_CHAT_MODEL is required when DEFAULT_CHAT_PROVIDER=deepseek.");
  }

  if (!config.allowMocks && config.defaults.reasoning === "deepseek" && !config.deepseek.apiKey) {
    errors.push("DEEPSEEK_API_KEY is required when DEFAULT_REASONING_PROVIDER=deepseek.");
  }

  if (
    !config.allowMocks &&
    config.defaults.reasoning === "deepseek" &&
    !config.deepseek.reasoningModel
  ) {
    errors.push("DEEPSEEK_REASONING_MODEL is required when DEFAULT_REASONING_PROVIDER=deepseek.");
  }

  if (errors.length > 0) {
    throw new ProviderError({
      provider: "registry",
      capability: "chat",
      code: ProviderErrorCode.MissingApiKey,
      message: `Provider startup configuration is incomplete:\n- ${errors.join("\n- ")}`,
      retryable: false
    });
  }
}

type ProviderFactory<TProvider> = (config: ProviderRegistryConfig) => TProvider | undefined;

const chatProviderFactories: Record<string, ProviderFactory<ChatProvider>> = {
  deepseek(config) {
    if (!config.deepseek.apiKey || !config.deepseek.chatModel) {
      return undefined;
    }

    return new DeepSeekChatProvider({
      apiKey: config.deepseek.apiKey,
      baseUrl: config.deepseek.baseUrl,
      model: config.deepseek.chatModel,
      includeRawResponse: config.includeRawProviderResponses
    });
  }
};

const reasoningProviderFactories: Record<string, ProviderFactory<ReasoningProvider>> = {
  deepseek(config) {
    if (!config.deepseek.apiKey || !config.deepseek.reasoningModel) {
      return undefined;
    }

    return new DeepSeekReasoningProvider({
      apiKey: config.deepseek.apiKey,
      baseUrl: config.deepseek.baseUrl,
      model: config.deepseek.reasoningModel,
      includeRawResponse: config.includeRawProviderResponses
    });
  }
};

const ttsProviderFactories: Record<string, ProviderFactory<TTSProvider>> = {
  xai(config) {
    if (!config.xai.apiKey || !config.xai.ttsModel) {
      return undefined;
    }

    return new XAITTSProvider({
      apiKey: config.xai.apiKey,
      baseUrl: config.xai.baseUrl,
      model: config.xai.ttsModel,
      defaultVoice: config.xai.ttsVoice
    });
  }
};

const sttProviderFactories: Record<string, ProviderFactory<STTProvider>> = {
  dashscope(config) {
    if (!config.dashscope.apiKey || !config.dashscope.sttModel) {
      return undefined;
    }

    return new DashScopeSTTProvider({
      apiKey: config.dashscope.apiKey,
      baseUrl: config.dashscope.baseUrl,
      model: config.dashscope.sttModel,
      includeRawResponse: config.includeRawProviderResponses
    });
  }
};

const visionProviderFactories: Record<string, ProviderFactory<VisionProvider>> = {
  xai(config) {
    if (!config.xai.apiKey || !config.xai.visionModel) {
      return undefined;
    }

    return new XAIVisionProvider({
      apiKey: config.xai.apiKey,
      baseUrl: config.xai.baseUrl,
      model: config.xai.visionModel,
      includeRawResponse: config.includeRawProviderResponses
    });
  }
};

const embeddingProviderFactories: Record<string, ProviderFactory<EmbeddingProvider>> = {
  "openai-compatible"(config) {
    if (!config.embedding.apiKey) {
      return undefined;
    }

    return new OpenAICompatibleEmbeddingProvider(config);
  },
  mock(config) {
    return new MockEmbeddingProvider(config.embedding.dimensions);
  }
};

function resolveChatProvider(config: ProviderRegistryConfig): ChatProvider {
  return resolveConfiguredProvider({
    config,
    capability: "chat",
    name: config.defaults.chat,
    factories: chatProviderFactories,
    createMock: createMockChatProvider,
    createUnavailable: (name) =>
      new UnavailableChatProvider(
        name,
        "Chat provider config is missing or provider is not implemented."
      )
  });
}

function resolveReasoningProvider(config: ProviderRegistryConfig): ReasoningProvider {
  return resolveConfiguredProvider({
    config,
    capability: "reasoning",
    name: config.defaults.reasoning,
    factories: reasoningProviderFactories,
    createMock: createMockReasoningProvider,
    createUnavailable: (name) =>
      new UnavailableReasoningProvider(
        name,
        "Reasoning provider config is missing or provider is not implemented."
      )
  });
}

function resolveTTSProvider(config: ProviderRegistryConfig): TTSProvider {
  return resolveConfiguredProvider({
    config,
    capability: "tts",
    name: config.defaults.tts,
    factories: ttsProviderFactories,
    createMock: createMockTTSProvider,
    createUnavailable: (name) =>
      new UnavailableTTSProvider(
        name,
        "TTS provider config is missing or provider is not implemented."
      )
  });
}

function resolveSTTProvider(config: ProviderRegistryConfig): STTProvider {
  return resolveConfiguredProvider({
    config,
    capability: "stt",
    name: config.defaults.stt,
    factories: sttProviderFactories,
    createMock: createMockSTTProvider,
    createUnavailable: (name) =>
      new UnavailableSTTProvider(
        name,
        "STT provider config is missing or provider is not implemented."
      )
  });
}

function resolveVisionProvider(config: ProviderRegistryConfig): VisionProvider {
  return resolveConfiguredProvider({
    config,
    capability: "vision",
    name: config.defaults.vision,
    factories: visionProviderFactories,
    createMock: createMockVisionProvider,
    createUnavailable: (name) =>
      new UnavailableVisionProvider(
        name,
        "Vision provider config is missing or provider is not implemented."
      )
  });
}

function resolveEmbeddingProvider(config: ProviderRegistryConfig): EmbeddingProvider {
  return resolveConfiguredProvider({
    config,
    capability: "embedding",
    name: config.defaults.embedding,
    factories: embeddingProviderFactories,
    createMock: () => new MockEmbeddingProvider(config.embedding.dimensions),
    createUnavailable: (name) =>
      new UnavailableEmbeddingProvider(
        name,
        config.embedding.dimensions,
        "Embedding provider config is missing or provider is not implemented."
      )
  });
}

function resolveConfiguredProvider<TProvider>(input: {
  config: ProviderRegistryConfig;
  capability: "chat" | "reasoning" | "tts" | "stt" | "vision" | "embedding";
  name: string;
  factories: Record<string, ProviderFactory<TProvider>>;
  createMock(name: string): TProvider;
  createUnavailable(name: string): TProvider;
}): TProvider {
  const provider = input.factories[input.name]?.(input.config);
  if (provider) {
    return provider;
  }

  if (input.config.allowMocks) {
    return input.createMock(input.name);
  }

  return input.createUnavailable(input.name);
}

class UnimplementedChatProvider implements ChatProvider {
  constructor(
    readonly name: string,
    private readonly message: string
  ) {}

  async healthCheck(): Promise<ProviderHealth> {
    return providerHealth(this.name, "unavailable", this.message);
  }

  async generateReply(): Promise<ChatOutput> {
    throw unavailableError(this.name, "chat", this.message);
  }
}

class UnimplementedReasoningProvider implements ReasoningProvider {
  constructor(
    readonly name: string,
    private readonly message: string
  ) {}

  async healthCheck(): Promise<ProviderHealth> {
    return providerHealth(this.name, "unavailable", this.message);
  }

  async generateReasoning(): Promise<ReasoningOutput> {
    throw unavailableError(this.name, "reasoning", this.message);
  }
}

class UnimplementedTTSProvider implements TTSProvider {
  constructor(
    readonly name: string,
    private readonly message: string
  ) {}

  async healthCheck(): Promise<ProviderHealth> {
    return providerHealth(this.name, "unavailable", this.message);
  }

  async synthesizeSpeech(): Promise<TTSOutput> {
    throw unavailableError(this.name, "tts", this.message);
  }
}

class UnimplementedSTTProvider implements STTProvider {
  constructor(
    readonly name: string,
    private readonly message: string
  ) {}

  async healthCheck(): Promise<ProviderHealth> {
    return providerHealth(this.name, "unavailable", this.message);
  }

  async transcribeAudio(): Promise<STTOutput> {
    throw unavailableError(this.name, "stt", this.message);
  }
}

class UnimplementedVisionProvider implements VisionProvider {
  constructor(
    readonly name: string,
    private readonly message: string
  ) {}

  async healthCheck(): Promise<ProviderHealth> {
    return providerHealth(this.name, "unavailable", this.message);
  }

  async analyzeImage(): Promise<VisionOutput> {
    throw unavailableError(this.name, "vision", this.message);
  }
}

class UnimplementedEmbeddingProvider implements EmbeddingProvider {
  constructor(
    readonly name: string,
    readonly dimensions: number,
    private readonly message: string
  ) {}

  async healthCheck(): Promise<ProviderHealth> {
    return providerHealth(this.name, "unavailable", this.message);
  }

  async embedText(_text: string): Promise<number[]> {
    throw unavailableError(this.name, "embedding", this.message);
  }

  async embedBatch(_texts: string[]): Promise<number[][]> {
    throw unavailableError(this.name, "embedding", this.message);
  }
}

class UnavailableChatProvider extends UnimplementedChatProvider {}
class UnavailableReasoningProvider extends UnimplementedReasoningProvider {}
class UnavailableTTSProvider extends UnimplementedTTSProvider {}
class UnavailableSTTProvider extends UnimplementedSTTProvider {}
class UnavailableVisionProvider extends UnimplementedVisionProvider {}
class UnavailableEmbeddingProvider extends UnimplementedEmbeddingProvider {}

class OpenAICompatibleEmbeddingProvider extends UnimplementedEmbeddingProvider {
  readonly model: string | undefined;
  readonly mock = false;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly timeoutMs = 30000;

  constructor(private readonly config: ProviderRegistryConfig) {
    super("openai-compatible", config.embedding.dimensions, "OpenAI-compatible embeddings.");
    this.model = config.embedding.model;
    this.apiKey = config.embedding.apiKey;
    this.baseUrl = config.embedding.baseUrl ?? "https://api.openai.com/v1";
  }

  override async healthCheck(): Promise<ProviderHealth> {
    return {
      provider: this.name,
      name: this.name,
      capability: "embedding",
      configured: Boolean(this.apiKey && this.model),
      available: Boolean(this.apiKey && this.model),
      mock: false,
      required: false,
      baseUrl: this.baseUrl,
      model: this.model,
      dimensions: this.dimensions,
      semanticEmbedding: true,
      status: this.apiKey && this.model ? "degraded" : "unavailable",
      checkedAt: new Date().toISOString(),
      message:
        this.apiKey && this.model
          ? "OpenAI-compatible embedding provider is configured but not verified by health check."
          : "EMBEDDING_API_KEY and EMBEDDING_MODEL are required for real embeddings."
    };
  }

  override async embedText(text: string): Promise<number[]> {
    const [vector] = await this.embedBatch([text]);
    return vector ?? [];
  }

  override async embedBatch(texts: string[]): Promise<number[][]> {
    if (!this.apiKey) {
      throw unavailableError(this.name, "embedding", "EMBEDDING_API_KEY is required.");
    }
    if (!this.model) {
      throw unavailableError(this.name, "embedding", "EMBEDDING_MODEL is required.");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${trimTrailingSlash(this.baseUrl)}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: this.model,
          input: texts
        }),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new ProviderError({
          provider: this.name,
          capability: "embedding",
          code:
            response.status === 401
              ? ProviderErrorCode.InvalidApiKey
              : ProviderErrorCode.ProviderUnavailable,
          statusCode: response.status,
          message: `Embedding request failed with ${response.status}.`,
          retryable: response.status >= 500 || response.status === 429
        });
      }
      const raw = (await response.json()) as {
        data?: Array<{ embedding?: unknown; index?: number }>;
      };
      const vectors = raw.data
        ?.slice()
        .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
        .map((item) => item.embedding)
        .filter(
          (embedding): embedding is number[] =>
            Array.isArray(embedding) && embedding.every((value) => typeof value === "number")
        );
      if (!vectors || vectors.length !== texts.length) {
        throw new ProviderError({
          provider: this.name,
          capability: "embedding",
          code: ProviderErrorCode.MalformedResponse,
          message: "Embedding response did not include one vector per input.",
          retryable: false
        });
      }
      return vectors;
    } catch (error) {
      if (error instanceof ProviderError) {
        throw error;
      }
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new ProviderError({
          provider: this.name,
          capability: "embedding",
          code: ProviderErrorCode.Timeout,
          message: "Embedding request timed out.",
          cause: error
        });
      }
      throw new ProviderError({
        provider: this.name,
        capability: "embedding",
        code: ProviderErrorCode.NetworkError,
        message: "Embedding network request failed.",
        cause: error
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createMockChatProvider(name = "mock-chat"): ChatProvider {
  return {
    name,
    async healthCheck() {
      return providerHealth(name, "healthy", "Mock chat provider is available.");
    },
    async generateReply(input: ChatInput) {
      const start = performance.now();
      const lastUserMessage = [...input.messages]
        .reverse()
        .find((message) => message.role === "user");
      const content = `Mock reply: ${lastUserMessage?.content ?? ""}`;

      return {
        message: { role: "assistant", content },
        latencyMs: Math.round(performance.now() - start),
        tokenUsage: {
          inputTokens: estimateTokenCount(
            input.messages.map((message) => message.content).join("\n")
          ),
          outputTokens: estimateTokenCount(content),
          totalTokens: estimateTokenCount(
            input.messages.map((message) => message.content).join("\n") + content
          )
        },
        finishReason: "stop"
      };
    }
  };
}

export function createMockReasoningProvider(name = "mock-reasoning"): ReasoningProvider {
  return {
    name,
    async healthCheck() {
      return providerHealth(name, "healthy", "Mock reasoning provider is available.");
    },
    async generateReasoning(input: ReasoningInput) {
      const joined = input.messages.map((message) => message.content).join("\n");
      return {
        reasoning: "Mock reasoning path.",
        answer: joined.slice(0, 256),
        latencyMs: 0,
        tokenUsage: { inputTokens: estimateTokenCount(joined), outputTokens: 4 }
      };
    }
  };
}

export function createMockTTSProvider(name = "mock-tts"): TTSProvider {
  return {
    name,
    async healthCheck() {
      return providerHealth(name, "healthy", "Mock TTS provider is available.");
    },
    async synthesizeSpeech(_input: TTSInput) {
      return {
        audio: new Uint8Array(),
        mimeType: "audio/wav",
        durationMs: 0,
        latencyMs: 0
      };
    }
  };
}

export function createMockSTTProvider(name = "mock-stt"): STTProvider {
  return {
    name,
    async healthCheck() {
      return providerHealth(name, "healthy", "Mock STT provider is available.");
    },
    async transcribeAudio(_input: STTInput) {
      return {
        text: "",
        confidence: 0,
        latencyMs: 0
      };
    }
  };
}

export function createMockVisionProvider(name = "mock-vision"): VisionProvider {
  return {
    name,
    async healthCheck() {
      return providerHealth(name, "healthy", "Mock vision provider is available.");
    },
    async analyzeImage(_input: VisionInput) {
      return {
        text: "Mock image analysis.",
        labels: [],
        latencyMs: 0
      };
    }
  };
}

export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = "mock";
  readonly model = "mock";
  readonly mock = true;

  constructor(readonly dimensions: number) {}

  async healthCheck(): Promise<ProviderHealth> {
    return {
      ...providerHealth(this.name, "healthy", "Mock embedding provider is available."),
      name: this.name,
      capability: "embedding",
      configured: true,
      available: true,
      mock: true,
      required: false,
      model: this.model,
      dimensions: this.dimensions,
      semanticEmbedding: false,
      embeddingNote:
        "Mock embeddings validate the retrieval pipeline but do not provide real semantic similarity."
    };
  }

  async embedText(text: string): Promise<number[]> {
    return stableMockVector(text, this.dimensions);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.embedText(text)));
  }
}

function providerHealth(
  provider: string,
  status: ProviderHealth["status"],
  message: string
): ProviderHealth {
  return {
    provider,
    status,
    checkedAt: new Date().toISOString(),
    message
  };
}

function unavailableError(
  provider: string,
  capability: "chat" | "reasoning" | "tts" | "stt" | "vision" | "embedding",
  message: string
): ProviderError {
  return new ProviderError({
    provider,
    capability,
    code: ProviderErrorCode.ProviderUnavailable,
    message,
    retryable: false
  });
}

function parseEnvironment(value: string | undefined): ProviderRegistryConfig["environment"] {
  if (value === "production" || value === "test" || value === "development") {
    return value;
  }

  return "development";
}

function parseBoolean(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "TRUE";
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function estimateTokenCount(text: string): number {
  return Math.ceil(text.trim().length / 4);
}

function stableMockVector(text: string, dimensions: number): number[] {
  let seed = 2166136261;
  for (const char of text) {
    seed ^= char.charCodeAt(0);
    seed = Math.imul(seed, 16777619);
  }

  return Array.from({ length: dimensions }, (_, index) => {
    const value = Math.sin(seed + index * 101) * 10000;
    return Number((value - Math.floor(value)).toFixed(6));
  });
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
