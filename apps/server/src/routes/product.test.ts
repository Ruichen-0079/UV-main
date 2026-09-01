import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadServerConfig } from "../config.js";
import { buildServer } from "../server.js";

const originalEnv = { ...process.env };
const dirs: string[] = [];

afterEach(async () => {
  process.env = { ...originalEnv };
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function testEnv(): NodeJS.ProcessEnv {
  const runtimeEnvDir = mkdtempSync(path.join(tmpdir(), "yuvi-product-"));
  dirs.push(runtimeEnvDir);
  return {
    ...originalEnv,
    NODE_ENV: "test",
    RUNTIME_MODE: "development",
    YUVI_RUNTIME_ENV_DIR: runtimeEnvDir,
    PROVIDER_ALLOW_MOCKS: "true",
    MEMORY_REPOSITORY: "in-memory",
    MEMORY_EXTRACTOR: "llm",
    EVENT_BUS: "in-memory",
    DEFAULT_CHAT_PROVIDER: "deepseek",
    DEFAULT_REASONING_PROVIDER: "deepseek",
    DEFAULT_TTS_PROVIDER: "xai",
    DEFAULT_STT_PROVIDER: "dashscope",
    DEFAULT_VISION_PROVIDER: "xai",
    EMBEDDING_PROVIDER: "mock",
    DEFAULT_EMBEDDING_PROVIDER: "mock",
    MEMORY_MAINTENANCE_ENABLED: "false",
    MEMORY_MAINTENANCE_RUN_ON_STARTUP: "false",
    DEEPSEEK_API_KEY: "test_deepseek_secret"
  };
}

describe("product UI routes", () => {
  it("returns compact health without leaking secrets", async () => {
    const env = testEnv();
    process.env = { ...env };
    const app = await buildServer(loadServerConfig(env));
    try {
      const response = await app.inject({ method: "GET", url: "/product/overview" });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.compactHealth.length).toBeGreaterThan(0);
      expect(body.memory.compression.operational).toBe(false);
      expect(body.memory.idleDream.operational).toBe(false);
      expect(response.body).not.toContain("test_deepseek_secret");
      expect(body.deferredRoles.some((role: { id: string }) => role.id === "cognition-fast")).toBe(
        true
      );
    } finally {
      await app.close();
    }
  });

  it("saves a local OpenAI-compatible base URL", async () => {
    const env = testEnv();
    process.env = { ...env };
    const app = await buildServer(loadServerConfig(env));
    try {
      const response = await app.inject({
        method: "POST",
        url: "/product/connections",
        payload: {
          values: { LOCAL_MODEL_BASEURL: "http://127.0.0.1:8080/v1" },
          apply: false
        }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().changedKeys).toContain("LOCAL_MODEL_BASEURL");
      expect(response.body).not.toContain("test_deepseek_secret");
    } finally {
      await app.close();
    }
  });

  it("returns a Memory surface with layer cards instead of requiring a JSON dump", async () => {
    const env = testEnv();
    process.env = { ...env };
    const app = await buildServer(loadServerConfig(env));
    try {
      const response = await app.inject({ method: "GET", url: "/product/memory" });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.l0.name).toBe("DirectContext");
      expect(Array.isArray(body.l1.episodes)).toBe(true);
      expect(body.l2.epistemic).toBeTruthy();
      expect(body.dream.idleClassification).toContain("DEFERRED");
    } finally {
      await app.close();
    }
  });

  it("returns a static capability allowlist and does not imply editable MCP servers", async () => {
    const env = testEnv();
    process.env = { ...env };
    const app = await buildServer(loadServerConfig(env));
    try {
      const response = await app.inject({ method: "GET", url: "/product/capabilities" });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.userConfigurableServers).toBe(false);
      expect(body.deferredReason).toContain("static allowlist");
      expect(Array.isArray(body.capabilities)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("rejects unknown connection keys", async () => {
    const env = testEnv();
    process.env = { ...env };
    const app = await buildServer(loadServerConfig(env));
    try {
      const response = await app.inject({
        method: "POST",
        url: "/product/connections",
        payload: { values: { NOT_A_KEY: "x" } }
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("unsafe_keys");
    } finally {
      await app.close();
    }
  });
});
