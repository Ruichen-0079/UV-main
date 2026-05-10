import { describe, expect, it } from "vitest";
import { loadServerConfig } from "./config.js";
import { buildServer } from "./server.js";

describe("server", () => {
  it("handles health, message, and memory endpoints with mock providers", async () => {
    const previous = snapshotEnv();
    setMockEnv();

    try {
      const app = await buildServer(loadServerConfig(process.env));

      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
      expect(health.json().ok).toBe(true);

      const message = await app.inject({
        method: "POST",
        url: "/message",
        payload: {
          sessionId: "test",
          content: "hello"
        }
      });
      expect(message.statusCode).toBe(200);
      expect(message.json().type).toBe("agent.reply");

      const memory = await app.inject({
        method: "POST",
        url: "/memory",
        payload: {
          type: "semantic",
          content: "Server test memory.",
          source: "test"
        }
      });
      expect(memory.statusCode).toBe(200);

      const recent = await app.inject({ method: "GET", url: "/memory/recent?limit=5" });
      expect(recent.statusCode).toBe(200);
      expect(recent.json().memories.length).toBeGreaterThan(0);

      await app.close();
    } finally {
      restoreEnv(previous);
    }
  });
});

function setMockEnv(): void {
  process.env["NODE_ENV"] = "test";
  process.env["PROVIDER_ALLOW_MOCKS"] = "true";
  process.env["MEMORY_REPOSITORY"] = "memory";
  process.env["DATABASE_URL"] = "postgres://companion:companion@localhost:5432/companion";
  process.env["DEFAULT_CHAT_PROVIDER"] = "deepseek";
  process.env["DEFAULT_REASONING_PROVIDER"] = "deepseek";
  process.env["DEFAULT_TTS_PROVIDER"] = "xai";
  process.env["DEFAULT_STT_PROVIDER"] = "dashscope";
  process.env["DEFAULT_VISION_PROVIDER"] = "xai";
  process.env["DEFAULT_EMBEDDING_PROVIDER"] = "mock";
}

function snapshotEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}

function restoreEnv(snapshot: NodeJS.ProcessEnv): void {
  process.env = snapshot;
}
