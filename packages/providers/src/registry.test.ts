import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError, ProviderErrorCode, createProviderRegistryFromEnv } from "./index.js";

describe("ProviderRegistry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("initializes mock providers without real API keys", async () => {
    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "test",
      PROVIDER_ALLOW_MOCKS: "true",
      DEFAULT_CHAT_PROVIDER: "deepseek",
      DEFAULT_REASONING_PROVIDER: "deepseek",
      DEFAULT_TTS_PROVIDER: "xai",
      DEFAULT_STT_PROVIDER: "dashscope",
      DEFAULT_VISION_PROVIDER: "xai",
      DEFAULT_EMBEDDING_PROVIDER: "mock",
      EMBEDDING_DIMENSIONS: "1024"
    });

    const chat = registry.getChatProvider();
    const reply = await chat.generateReply({
      messages: [{ role: "user", content: "hello" }]
    });

    expect(reply.message.content).toContain("Mock reply");
    const embedding = await registry.getEmbeddingProvider().embedText("hello");
    expect(embedding.length).toBe(1024);
    await expect(registry.getEmbeddingProvider().embedText("hello")).resolves.toEqual(embedding);

    const status = registry.getStatus();
    expect(status.providers.chat).toMatchObject({
      provider: "deepseek",
      capability: "chat",
      configured: false,
      available: true,
      mock: true,
      required: true
    });
    expect(JSON.stringify(status)).not.toContain("API_KEY");
  });

  it("uses real-provider-first behavior unless mock fallback is explicitly allowed", async () => {
    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "development",
      DEFAULT_CHAT_PROVIDER: "deepseek",
      DEFAULT_REASONING_PROVIDER: "deepseek"
    });

    const status = registry.getStatus();
    expect(status.providers.chat).toMatchObject({
      provider: "deepseek",
      capability: "chat",
      configured: false,
      available: false,
      mock: false,
      required: true,
      status: "unavailable"
    });
    expect(status.providers.embedding).toMatchObject({
      provider: "openai-compatible",
      capability: "embedding",
      configured: false,
      available: false,
      mock: false,
      status: "unavailable"
    });
    await expect(
      registry.getChatProvider().generateReply({ messages: [{ role: "user", content: "hello" }] })
    ).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      provider: "deepseek",
      capability: "chat"
    });
  });

  it("reports embedding provider status without leaking secrets", () => {
    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "test",
      DEFAULT_EMBEDDING_PROVIDER: "openai-compatible",
      EMBEDDING_API_KEY: "embedding-secret-key",
      EMBEDDING_API_BASEURL: "https://embedding.example/v1",
      EMBEDDING_MODEL: "text-embedding-test",
      EMBEDDING_DIMENSIONS: "3"
    });

    const status = registry.getStatus().providers.embedding;

    expect(status).toMatchObject({
      provider: "openai-compatible",
      capability: "embedding",
      configured: true,
      available: true,
      mock: false,
      baseUrl: "https://embedding.example/v1",
      model: "text-embedding-test",
      dimensions: 3
    });
    expect(status.semanticEmbedding).toBe(true);
    expect(JSON.stringify(status)).not.toContain("embedding-secret-key");
  });

  it("reports configured DeepSeek providers without making health HTTP calls", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "production",
      PROVIDER_ALLOW_MOCKS: "false",
      DEFAULT_CHAT_PROVIDER: "deepseek",
      DEFAULT_REASONING_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "test-key",
      DEEPSEEK_CHAT_MODEL: "deepseek-chat",
      DEEPSEEK_REASONING_MODEL: "deepseek-reasoner"
    });

    const status = registry.getStatus();
    expect(status.providers.chat).toMatchObject({
      configured: true,
      available: true,
      mock: false,
      required: true,
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat"
    });
    expect(status.providers.reasoning).toMatchObject({
      configured: true,
      available: true,
      mock: false,
      required: false,
      model: "deepseek-reasoner"
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(status)).not.toContain("test-key");
  });

  it("normalizes provider errors", () => {
    const error = new ProviderError({
      provider: "deepseek",
      capability: "chat",
      code: ProviderErrorCode.InvalidApiKey,
      message: "bad key",
      statusCode: 401
    });

    expect(error.code).toBe("INVALID_API_KEY");
    expect(error.statusCode).toBe(401);
    expect(error.toJSON()).toMatchObject({
      provider: "deepseek",
      capability: "chat",
      code: "INVALID_API_KEY"
    });
  });

  it("omits raw provider responses unless explicitly enabled", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            model: "deepseek-test",
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: "hello from deepseek"
                }
              }
            ],
            usage: {
              prompt_tokens: 2,
              completion_tokens: 3,
              total_tokens: 5
            }
          }),
          { status: 200 }
        )
    );

    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "production",
      PROVIDER_ALLOW_MOCKS: "false",
      DATABASE_URL: "postgres://example",
      DEFAULT_CHAT_PROVIDER: "deepseek",
      DEFAULT_REASONING_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "test-key",
      DEEPSEEK_CHAT_MODEL: "deepseek-chat",
      DEEPSEEK_REASONING_MODEL: "deepseek-reasoner"
    });

    const reply = await registry.getChatProvider().generateReply({
      messages: [{ role: "user", content: "hello" }]
    });

    expect(reply.debug).toBeUndefined();
  });

  it("can include raw provider responses behind an explicit debug flag", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            model: "deepseek-test",
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: "hello from deepseek"
                }
              }
            ]
          }),
          { status: 200 }
        )
    );

    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "production",
      PROVIDER_ALLOW_MOCKS: "false",
      PROVIDER_INCLUDE_RAW_RESPONSES: "true",
      DATABASE_URL: "postgres://example",
      DEFAULT_CHAT_PROVIDER: "deepseek",
      DEFAULT_REASONING_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "test-key",
      DEEPSEEK_CHAT_MODEL: "deepseek-chat",
      DEEPSEEK_REASONING_MODEL: "deepseek-reasoner"
    });

    const reply = await registry.getChatProvider().generateReply({
      messages: [{ role: "user", content: "hello" }]
    });

    expect(reply.debug?.rawResponse).toMatchObject({
      model: "deepseek-test"
    });
  });

  it("falls back from primary chat provider to local provider with safe attempt metadata", async () => {
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("api.deepseek.com")) {
        return new Response(JSON.stringify({ error: "bad upstream sk-secret-value" }), {
          status: 500
        });
      }
      return new Response(
        JSON.stringify({
          model: "local-chat",
          choices: [{ finish_reason: "stop", message: { content: "hello from local" } }]
        }),
        { status: 200 }
      );
    });

    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "development",
      PROVIDER_ALLOW_MOCKS: "false",
      DEFAULT_CHAT_PROVIDER: "deepseek",
      CHAT_PROVIDER_CHAIN: "deepseek,local",
      DEEPSEEK_API_KEY: "deepseek-secret",
      DEEPSEEK_CHAT_MODEL: "deepseek-chat",
      LOCAL_MODEL_BASEURL: "https://local.example/v1",
      LOCAL_CHAT_MODEL: "local-chat"
    });

    const reply = await registry.getChatProvider().generateReply({
      messages: [{ role: "user", content: "hello" }]
    });

    expect(reply.message.content).toBe("hello from local");
    expect(reply.fallbackUsed).toBe(true);
    expect(reply.finalProvider).toBe("local");
    expect(reply.attemptedProviders?.map((attempt) => attempt.status)).toEqual([
      "failed",
      "success"
    ]);
    expect(JSON.stringify(reply.attemptedProviders)).not.toContain("deepseek-secret");
    expect(JSON.stringify(reply.attemptedProviders)).not.toContain("sk-secret-value");
  });

  it("reports local and NVIDIA provider routes without health calls or secret leakage", () => {
    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "development",
      PROVIDER_ALLOW_MOCKS: "false",
      CHAT_PROVIDER_CHAIN: "deepseek,nvidia,local",
      NVIDIA_API_KEY: "nvidia-secret",
      NVIDIA_CHAT_MODEL: "nvidia-chat",
      LOCAL_MODEL_BASEURL: "https://local.example/v1",
      LOCAL_CHAT_MODEL: "local-chat"
    });

    const routes = registry.getStatus().routes?.chat ?? [];

    expect(routes.map((route) => route.provider)).toEqual(["deepseek", "nvidia", "local"]);
    expect(routes.find((route) => route.provider === "nvidia")).toMatchObject({
      configured: true,
      available: true,
      model: "nvidia-chat"
    });
    expect(routes.find((route) => route.provider === "local")).toMatchObject({
      configured: true,
      available: true,
      baseUrl: "https://local.example/v1",
      model: "local-chat"
    });
    expect(JSON.stringify(routes)).not.toContain("nvidia-secret");
  });

  it("configures the local GPT-SoVITS adapter without requiring a generic model URL", () => {
    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "development",
      PROVIDER_ALLOW_MOCKS: "false",
      DEFAULT_TTS_PROVIDER: "local",
      TTS_PROVIDER_CHAIN: "local",
      LOCAL_TTS_MODEL: "alice-v4",
      GPT_SOVITS_TTS_BASE_URL: "http://127.0.0.1:9881",
      GPT_SOVITS_TTS_GPT_WEIGHTS: "D:/GPT.ckpt",
      GPT_SOVITS_TTS_SOVITS_WEIGHTS: "D:/SoVITS.pth",
      GPT_SOVITS_TTS_REFERENCE_AUDIO: "D:/reference.wav",
      GPT_SOVITS_TTS_REFERENCE_TEXT: "reference"
    });

    expect(registry.getStatus().providers.tts).toMatchObject({
      provider: "local",
      configured: true,
      baseUrl: "http://127.0.0.1:9881",
      model: "alice-v4"
    });
  });

  it("uses mock STT/TTS/Vision runtime fallback only when explicitly enabled", async () => {
    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "test",
      PROVIDER_ALLOW_MOCKS: "true",
      DEFAULT_STT_PROVIDER: "dashscope",
      DEFAULT_TTS_PROVIDER: "xai",
      DEFAULT_VISION_PROVIDER: "xai",
      STT_PROVIDER_CHAIN: "dashscope,local,mock",
      TTS_PROVIDER_CHAIN: "xai,local,mock",
      VISION_PROVIDER_CHAIN: "xai,nvidia,local,mock"
    });

    const transcript = await registry.getSTTProvider().transcribeAudio({
      metadata: { mockTranscription: "烦死了，这个报错我看不懂" }
    });
    expect(transcript.text).toContain("烦死了");
    expect(transcript.fallbackUsed).toBe(true);
    expect(transcript.finalProvider).toBe("mock");
    expect(transcript.attemptedProviders?.at(-1)).toMatchObject({
      provider: "mock",
      status: "success"
    });

    const speech = await registry.getTTSProvider().synthesizeSpeech({ text: "hello" });
    expect(speech.mimeType).toBe("audio/wav");
    expect(speech.finalProvider).toBe("mock");

    const vision = await registry.getVisionProvider().analyzeImage({ prompt: "describe" });
    expect(vision.text).toContain("Mock image analysis");
    expect(vision.finalProvider).toBe("mock");
  });

  it("does not silently mock STT when mock fallback is disabled", async () => {
    const registry = createProviderRegistryFromEnv({
      NODE_ENV: "development",
      PROVIDER_ALLOW_MOCKS: "false",
      DEFAULT_STT_PROVIDER: "dashscope",
      STT_PROVIDER_CHAIN: "dashscope,local,mock"
    });

    await expect(registry.getSTTProvider().transcribeAudio({})).rejects.toMatchObject({
      capability: "stt",
      code: "PROVIDER_UNAVAILABLE"
    });
  });
});
