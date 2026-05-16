import { describe, expect, it } from "vitest";
import {
  ConfigValidationError,
  parseRuntimeConfig,
  redactConfig,
  redactSecret,
  validateRuntimeConfig
} from "./index.js";

describe("runtime config", () => {
  it("parses environment values without reading process state", () => {
    const config = parseRuntimeConfig({
      NODE_ENV: "production",
      SERVER_HOST: "0.0.0.0",
      SERVER_PORT: "4310",
      LOG_LEVEL: "debug",
      MEMORY_REPOSITORY: "postgres",
      DATABASE_URL: "postgres://example"
    });

    expect(config.environment).toBe("production");
    expect(config.server).toMatchObject({
      host: "0.0.0.0",
      port: 4310,
      logLevel: "debug"
    });
    expect(config.memory.repository).toBe("postgres");
    expect(config.memory.extractor).toBe("llm");
    expect(config.memory.databaseUrl).toBe("postgres://example");
    expect(config.infrastructure.eventBusDriver).toBe("in-memory");
  });

  it("uses architecture default provider selection", () => {
    const config = parseRuntimeConfig({});

    expect(config.memory.repository).toBe("in-memory");
    expect(config.memory.extractor).toBe("llm");
    expect(config.server.port).toBe(6121);
    expect(config.providers.defaults).toEqual({
      chat: "deepseek",
      reasoning: "deepseek",
      tts: "xai",
      stt: "dashscope",
      vision: "xai",
      embedding: "mock"
    });
  });

  it("redacts secrets and authorization-like fields", () => {
    expect(redactSecret("sk-1234567890")).toBe("sk-...[redacted]...890");

    const redacted = redactConfig({
      apiKey: "secret-value",
      headers: {
        Authorization: "Bearer abc"
      },
      safe: "visible"
    });

    expect(redacted).toEqual({
      apiKey: "sec...[redacted]...lue",
      headers: {
        Authorization: "Bea...[redacted]...abc"
      },
      safe: "visible"
    });
  });

  it("reports missing provider config when mocks are disabled", () => {
    const config = parseRuntimeConfig({
      NODE_ENV: "production",
      PROVIDER_ALLOW_MOCKS: "false",
      MEMORY_REPOSITORY: "postgres",
      DATABASE_URL: "postgres://example",
      DEFAULT_CHAT_PROVIDER: "deepseek",
      DEFAULT_REASONING_PROVIDER: "deepseek"
    });

    expect(() => validateRuntimeConfig(config)).toThrow(ConfigValidationError);
  });

  it("allows missing optional provider secrets when mocks are enabled", () => {
    const config = parseRuntimeConfig({
      NODE_ENV: "development",
      PROVIDER_ALLOW_MOCKS: "true"
    });

    expect(() => validateRuntimeConfig(config)).not.toThrow();
  });

  it("requires DATABASE_URL only when postgres memory is enabled", () => {
    const inMemoryConfig = parseRuntimeConfig({
      MEMORY_REPOSITORY: "in-memory"
    });
    const postgresConfig = parseRuntimeConfig({
      MEMORY_REPOSITORY: "postgres"
    });

    expect(() => validateRuntimeConfig(inMemoryConfig)).not.toThrow();
    expect(() => validateRuntimeConfig(postgresConfig)).toThrow(ConfigValidationError);
  });

  it("marks NATS event bus as reserved but unsupported", () => {
    const config = parseRuntimeConfig({
      EVENT_BUS: "nats"
    });

    expect(config.infrastructure.eventBusDriver).toBe("nats");
    expect(() => validateRuntimeConfig(config)).toThrow(ConfigValidationError);
  });

  it("parses optional memory extractor mode", () => {
    expect(parseRuntimeConfig({}).memory.extractor).toBe("llm");
    expect(parseRuntimeConfig({ MEMORY_EXTRACTOR: "rule-based" }).memory.extractor).toBe(
      "rule-based"
    );
    expect(parseRuntimeConfig({ MEMORY_EXTRACTOR: "llm" }).memory.extractor).toBe("llm");
  });
});
