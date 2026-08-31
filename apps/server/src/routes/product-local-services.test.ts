import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildServer } from "../server.js";
import { loadServerConfig } from "../config.js";

const originalEnv = { ...process.env };

afterEach(async () => {
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
});

function testEnv(): Record<string, string> {
  return {
    ...originalEnv,
    NODE_ENV: "test",
    RUNTIME_MODE: "test",
    SERVER_HOST: "127.0.0.1",
    SERVER_PORT: "0",
    PROVIDER_ALLOW_MOCKS: "true",
    DEFAULT_CHAT_PROVIDER: "mock",
    DEFAULT_REASONING_PROVIDER: "mock",
    DEFAULT_TTS_PROVIDER: "mock",
    DEFAULT_STT_PROVIDER: "mock",
    DEFAULT_VISION_PROVIDER: "mock",
    DEFAULT_EMBEDDING_PROVIDER: "mock",
    MEMORY_REPOSITORY: "in-memory",
    MEMORY_BACKEND: "legacy",
    YUVI_LOCAL_AI_STATE_DIR: mkdtempSync(path.join(tmpdir(), "yuvi-product-local-ai-")),
    LOCAL_LLM_BASEURL: "",
    LOCAL_STT_MODEL: ""
  } as Record<string, string>;
}

describe("product local-services API", () => {
  it("lists local AI services on loopback without secrets or role routing", async () => {
    process.env = testEnv();
    const app = await buildServer(loadServerConfig(process.env));
    try {
      const listed = await app.inject({ method: "GET", url: "/product/local-services" });
      expect(listed.statusCode).toBe(200);
      const body = listed.json() as { services: Array<Record<string, unknown>> };
      const ids = body.services.map((service) => service["id"]);
      expect(ids).toContain("alice");
      expect(ids).toContain("embedding");
      expect(ids).toContain("stt");
      expect(ids).toContain("local-llm");
      expect(listed.body).not.toContain("DEEPSEEK_API_KEY");
      expect(listed.body).not.toContain("Authorization");
      expect(listed.body).not.toMatch(/"apiKey"/);
      const llm = body.services.find((service) => service["id"] === "local-llm");
      expect(llm?.["metadata"]).toMatchObject({ roleRouting: false });
    } finally {
      await app.close();
    }
  });

  it("rejects unknown service ids and refuses stop of unmanaged local-llm", async () => {
    process.env = testEnv();
    const app = await buildServer(loadServerConfig(process.env));
    try {
      const missing = await app.inject({
        method: "POST",
        url: "/product/local-services/not-a-service/stop"
      });
      expect(missing.statusCode).toBe(404);
      const stopLlm = await app.inject({
        method: "POST",
        url: "/product/local-services/local-llm/stop"
      });
      expect(stopLlm.statusCode).toBe(409);
      expect(stopLlm.json()).toMatchObject({ ok: false });
    } finally {
      await app.close();
    }
  });
});
