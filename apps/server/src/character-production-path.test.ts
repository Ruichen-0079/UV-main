import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "./server.js";
import { loadServerConfig } from "./config.js";

const originalEnv = { ...process.env };
const createdDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  process.env = { ...originalEnv };
  for (const dir of createdDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function productionTestEnv(): NodeJS.ProcessEnv {
  const runtimeEnvDir = path.join(tmpdir(), `yuvi-character-${crypto.randomUUID()}`);
  createdDirs.push(runtimeEnvDir);
  return {
    NODE_ENV: "development",
    RUNTIME_MODE: "development",
    YUVI_RUNTIME_ENV_DIR: runtimeEnvDir,
    PROVIDER_ALLOW_MOCKS: "false",
    MEMORY_REPOSITORY: "in-memory",
    MEMORY_EXTRACTOR: "llm",
    EVENT_BUS: "in-memory",
    DEFAULT_CHAT_PROVIDER: "openai-compatible",
    CHAT_PROVIDER_CHAIN: "openai-compatible",
    DEFAULT_REASONING_PROVIDER: "openai-compatible",
    REASONING_PROVIDER_CHAIN: "openai-compatible",
    DEFAULT_TTS_PROVIDER: "xai",
    DEFAULT_STT_PROVIDER: "dashscope",
    DEFAULT_VISION_PROVIDER: "xai",
    EMBEDDING_PROVIDER: "mock",
    DEFAULT_EMBEDDING_PROVIDER: "mock",
    MEMORY_MAINTENANCE_ENABLED: "false",
    MEMORY_MAINTENANCE_RUN_ON_STARTUP: "false",
    MEMORY_MAINTENANCE_INTERVAL_MINUTES: "0",
    MEMORY_MAINTENANCE_LIMIT: "500",
    OPENAI_COMPATIBLE_API_BASEURL: "https://gateway.example/v1",
    OPENAI_COMPATIBLE_API_KEY: "test-only-key",
    OPENAI_COMPATIBLE_CHAT_MODEL: "deepseek-ai/DeepSeek-V4-Flash-0731",
    OPENAI_COMPATIBLE_REASONING_MODEL: "zai-org/GLM-5.3-Flash"
  };
}

function completion(model: string, content: string, reasoningContent?: string) {
  return new Response(
    JSON.stringify({
      model,
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content,
            ...(reasoningContent ? { reasoning_content: reasoningContent } : {})
          }
        }
      ],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

type RecordedRequest = {
  model?: string;
  messages?: Array<{ role: string; content: string }>;
};

describe("ordinary production Character path", () => {
  it("keeps a simple accepted RESPOND on the selected Chat model", async () => {
    const requests: RecordedRequest[] = [];
    const fetchSpy = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as RecordedRequest;
      requests.push(body);
      return completion(
        body.model ?? "unknown",
        '{"disposition":"RESPOND","text":"Simple production answer."}'
      );
    });
    vi.stubGlobal("fetch", fetchSpy);
    const env = productionTestEnv();
    process.env = { ...env };
    const app = await buildServer(loadServerConfig(env));

    try {
      const response = await app.inject({
        method: "POST",
        url: "/message",
        payload: {
          sessionId: "production-simple",
          text: "A simple production question.",
          options: { readMemory: false, writeMemory: false, voiceOutput: false }
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().reply).toBe("Simple production answer.");
      expect(response.json().provider).toMatchObject({
        name: "openai-compatible",
        model: "deepseek-ai/DeepSeek-V4-Flash-0731",
        capability: "chat"
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(requests[0]?.model).toBe("deepseek-ai/DeepSeek-V4-Flash-0731");
    } finally {
      await app.close();
    }
  });

  it("takes NEED_COGNITION through one GLM round-trip and returns clean final output", async () => {
    const requests: RecordedRequest[] = [];
    const fetchSpy = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as RecordedRequest;
      requests.push(body);
      const call = requests.length;
      if (call === 1) {
        return completion(
          body.model ?? "unknown",
          '{"disposition":"NEED_COGNITION","focus":"verification"}'
        );
      }
      if (call === 2) {
        return completion(body.model ?? "unknown", "Normalized cognition answer.", "private trace");
      }
      return completion(
        body.model ?? "unknown",
        '<think>private Character trace</think>{"disposition":"RESPOND","text":"Final production answer."}'
      );
    });
    vi.stubGlobal("fetch", fetchSpy);
    const env = productionTestEnv();
    process.env = { ...env };
    const app = await buildServer(loadServerConfig(env));

    try {
      const response = await app.inject({
        method: "POST",
        url: "/message",
        payload: {
          sessionId: "production-cognition",
          text: "Please verify this production question.",
          options: { readMemory: false, writeMemory: false, voiceOutput: false }
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().reply).toBe("Final production answer.");
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(requests.map((request) => request.model)).toEqual([
        "deepseek-ai/DeepSeek-V4-Flash-0731",
        "zai-org/GLM-5.3-Flash",
        "deepseek-ai/DeepSeek-V4-Flash-0731"
      ]);
      expect(JSON.stringify(requests[1])).toContain("Please verify this production question.");
      expect(JSON.stringify(requests[1])).not.toContain("SystemIdentity");
      expect(JSON.stringify(requests[2])).toContain("COGNITION_RESULT");
      expect(JSON.stringify(requests[2])).toContain("Normalized cognition answer.");
      expect(response.body).not.toContain("private trace");
      expect(response.body).not.toContain("private Character trace");
      expect(response.body).not.toContain("reasoning_content");
      expect(response.body).not.toContain("GLM-5.3-Flash");
    } finally {
      await app.close();
    }
  });

  it("uses the same Character disposition seam for ordinary message streaming", async () => {
    const fetchSpy = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as RecordedRequest;
      return completion(
        body.model ?? "unknown",
        '{"disposition":"RESPOND","text":"Streamed Character answer."}'
      );
    });
    vi.stubGlobal("fetch", fetchSpy);
    const env = productionTestEnv();
    process.env = { ...env };
    const app = await buildServer(loadServerConfig(env));

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/messages/stream",
        payload: {
          sessionId: "production-stream",
          content: "A streamed production question.",
          options: { readMemory: false, writeMemory: false, voiceOutput: false }
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("event: text-delta");
      expect(response.body).toContain("Streamed Character answer.");
      expect(response.body).toContain("event: completed");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});
