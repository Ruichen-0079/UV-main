import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigValidationError,
  getLegacyServerLocalEnvWarning,
  parseRuntimeConfig,
  redactConfig,
  redactSecret,
  readRuntimeEnvFiles,
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
    expect(config.memory.backend).toBe("legacy");
    expect(config.memory.mem0BaseUrl).toBe("http://127.0.0.1:6130");
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
      embedding: "openai-compatible"
    });
    expect(config.providers.allowMocks).toBe(false);
    expect(config.providers.endpoints.embedding.dimensions).toBe(1536);
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
      MEMORY_REPOSITORY: "in-memory",
      PROVIDER_ALLOW_MOCKS: "true"
    });
    const postgresConfig = parseRuntimeConfig({
      MEMORY_REPOSITORY: "postgres",
      PROVIDER_ALLOW_MOCKS: "true"
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

  it("merges runtime env as .env, process env, then .env.local", async () => {
    await withTempWorkspace(async (root) => {
      await writeFile(path.join(root, ".env"), "DATABASE_URL=base\nBASE_ONLY=base\n", "utf8");
      await writeFile(
        path.join(root, ".env.local"),
        "DATABASE_URL=local\nLOCAL_ONLY=local\n",
        "utf8"
      );

      const files = await readRuntimeEnvFiles({
        cwd: root,
        env: { DATABASE_URL: "shell", SHELL_ONLY: "shell" }
      });

      expect(files.env["DATABASE_URL"]).toBe("local");
      expect(files.env["BASE_ONLY"]).toBe("base");
      expect(files.env["SHELL_ONLY"]).toBe("shell");
      expect(files.env["LOCAL_ONLY"]).toBe("local");
    });
  });

  it("supports only .env, only process env, only .env.local, and missing files", async () => {
    await withTempWorkspace(async (root) => {
      await writeFile(path.join(root, ".env"), "DATABASE_URL=base\n", "utf8");
      expect((await readRuntimeEnvFiles({ cwd: root, env: {} })).env["DATABASE_URL"]).toBe("base");

      await rm(path.join(root, ".env"));
      expect(
        (await readRuntimeEnvFiles({ cwd: root, env: { DATABASE_URL: "shell" } })).env[
          "DATABASE_URL"
        ]
      ).toBe("shell");

      await writeFile(path.join(root, ".env.local"), "DATABASE_URL=local\n", "utf8");
      expect((await readRuntimeEnvFiles({ cwd: root, env: {} })).env["DATABASE_URL"]).toBe("local");

      await rm(path.join(root, ".env.local"));
      const files = await readRuntimeEnvFiles({ cwd: root, env: {} });
      expect(files.base.exists).toBe(false);
      expect(files.local.exists).toBe(false);
      expect(files.env["DATABASE_URL"]).toBeUndefined();
    });
  });

  it("warns about legacy apps/server/.env.local without loading it", async () => {
    await withTempWorkspace(async (root) => {
      await mkdir(path.join(root, "apps", "server"), { recursive: true });
      await writeFile(path.join(root, "apps", "server", ".env.local"), "DATABASE_URL=legacy\n");

      const files = await readRuntimeEnvFiles({ cwd: root, env: {} });
      const warning = await getLegacyServerLocalEnvWarning({ cwd: root, env: {} });

      expect(files.env["DATABASE_URL"]).toBeUndefined();
      expect(warning).toContain("legacy misplaced file will not be used");
    });
  });
});

async function withTempWorkspace(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "yuvi-config-test-"));
  try {
    await writeFile(path.join(root, "pnpm-workspace.yaml"), "packages: []\n", "utf8");
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
