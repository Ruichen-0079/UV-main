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
      DEFAULT_EMBEDDING_PROVIDER: "mock"
    });

    const chat = registry.getChatProvider();
    const reply = await chat.generateReply({
      messages: [{ role: "user", content: "hello" }]
    });

    expect(reply.message.content).toContain("Mock reply");
    expect((await registry.getEmbeddingProvider().embedText("hello")).length).toBe(1536);

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
});
