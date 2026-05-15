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
          text: "hello",
          options: {
            useMemory: true,
            voiceOutput: false
          }
        }
      });
      expect(message.statusCode).toBe(200);
      expect(message.json().type).toBe("agent.reply");
      expect(message.json().reply).toContain("Mock reply");
      expect(message.json().traceId).toBeTypeOf("string");

      const prompt = await app.inject({ method: "GET", url: "/debug/prompt/latest" });
      expect(prompt.statusCode).toBe(200);
      expect(prompt.json().promptPreview.sections.length).toBeGreaterThan(0);
      expect(prompt.json().traceId).toBe(message.json().traceId);
      expect(prompt.json().retrievedMemoryCount).toBe(0);
      expect(prompt.body).not.toContain("test_deepseek_secret");

      const providers = await app.inject({ method: "GET", url: "/providers/status" });
      expect(providers.statusCode).toBe(200);
      expect(providers.json().providers.chat.status).toBe("healthy");
      expect(providers.body).not.toContain("test_deepseek_secret");
      expect(providers.body).not.toContain("Authorization");

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

      const yuviMemory = await app.inject({
        method: "POST",
        url: "/memory",
        payload: {
          type: "semantic",
          content: "“  用户正在开发 YUVI Runtime，一个类 AIRI 的 AI Companion Runtime。  ”",
          source: "test",
          tags: ["yuvi", "runtime"]
        }
      });
      expect(yuviMemory.statusCode).toBe(200);

      const duplicateWorkingMemory = await app.inject({
        method: "POST",
        url: "/memory",
        payload: {
          type: "working",
          content: "用户正在开发 YUVI Runtime，一个类 AIRI 的 AI Companion Runtime。",
          importance: 1,
          source: "test"
        }
      });
      expect(duplicateWorkingMemory.statusCode).toBe(200);

      const messageWithMemory = await app.inject({
        method: "POST",
        url: "/message",
        payload: {
          sessionId: "test",
          text: "What do you know about Server test details?",
          options: {
            useMemory: true,
            voiceOutput: false
          }
        }
      });
      expect(messageWithMemory.statusCode).toBe(200);

      const promptWithMemory = await app.inject({ method: "GET", url: "/debug/prompt/latest" });
      const relevantMemory = findPromptSection(promptWithMemory.json().sections, "RelevantMemory");
      expect(promptWithMemory.json().useMemory).toBe(true);
      expect(promptWithMemory.json().retrievedMemoryCount).toBeGreaterThan(0);
      expect(relevantMemory?.content).toContain("Server test memory");

      const yuviMessageWithMemory = await app.inject({
        method: "POST",
        url: "/message",
        payload: {
          sessionId: "test",
          text: "YUVI Runtime 是什么项目？",
          options: {
            useMemory: true,
            voiceOutput: false
          }
        }
      });
      expect(yuviMessageWithMemory.statusCode).toBe(200);

      const yuviPromptWithMemory = await app.inject({
        method: "GET",
        url: "/debug/prompt/latest"
      });
      const yuviRelevantMemory = findPromptSection(
        yuviPromptWithMemory.json().sections,
        "RelevantMemory"
      );
      expect(yuviPromptWithMemory.json().useMemory).toBe(true);
      expect(yuviPromptWithMemory.json().userMessage).toBe("YUVI Runtime 是什么项目？");
      expect(yuviPromptWithMemory.json().retrievedMemoryCountRaw).toBeGreaterThan(
        yuviPromptWithMemory.json().retrievedMemoryCount
      );
      expect(yuviPromptWithMemory.json().retrievedMemoryCount).toBeGreaterThan(0);
      expect(yuviRelevantMemory?.content).toMatch(/YUVI Runtime|AI Companion Runtime/);
      expect(countOccurrences(yuviRelevantMemory?.content ?? "", "YUVI Runtime")).toBe(1);
      expect(yuviRelevantMemory?.content).not.toContain("“");
      expect(yuviPromptWithMemory.json().retrievedMemories[0]).toMatchObject({
        type: "semantic",
        source: "test",
        displayText: "用户正在开发 YUVI Runtime，一个类 AIRI 的 AI Companion Runtime。"
      });
      expect(
        yuviPromptWithMemory
          .json()
          .promptPreview.retrievedMemories.some((memory: { excludedReason?: string }) =>
            memory.excludedReason?.startsWith("deduped")
          )
      ).toBe(true);
      expect(yuviPromptWithMemory.body).not.toContain("test_deepseek_secret");

      const messageWithoutMemory = await app.inject({
        method: "POST",
        url: "/message",
        payload: {
          sessionId: "test",
          text: "YUVI Runtime 是什么项目？",
          options: {
            useMemory: false,
            voiceOutput: false
          }
        }
      });
      expect(messageWithoutMemory.statusCode).toBe(200);

      const promptWithoutMemory = await app.inject({ method: "GET", url: "/debug/prompt/latest" });
      const emptyRelevantMemory = findPromptSection(
        promptWithoutMemory.json().sections,
        "RelevantMemory"
      );
      expect(promptWithoutMemory.json().useMemory).toBe(false);
      expect(promptWithoutMemory.json().retrievedMemoryCountRaw).toBe(0);
      expect(promptWithoutMemory.json().retrievedMemoryCount).toBe(0);
      expect(emptyRelevantMemory?.content).toBe("Memory was disabled for this turn.");
      expect(promptWithoutMemory.body).not.toContain("Server test memory");
      expect(promptWithoutMemory.body).not.toContain("用户正在开发 YUVI Runtime");

      const recent = await app.inject({ method: "GET", url: "/memory/recent?limit=5" });
      expect(recent.statusCode).toBe(200);
      expect(recent.json().memories.length).toBeGreaterThan(0);

      const search = await app.inject({ method: "GET", url: "/memory/search?q=Server&limit=5" });
      expect(search.statusCode).toBe(200);
      expect(search.json().query).toBe("Server");
      expect(search.json().repository).toBe("in-memory");
      expect(search.json().rawCount).toBeGreaterThanOrEqual(search.json().count);
      expect(search.json().memories.length).toBeGreaterThan(0);

      const encodedChineseSearch = await app.inject({
        method: "GET",
        url: `/memory/search?${new URLSearchParams({ q: "项目", limit: "5" }).toString()}`
      });
      expect(encodedChineseSearch.statusCode).toBe(200);
      expect(encodedChineseSearch.json().memories.length).toBeGreaterThan(0);
      expect(encodedChineseSearch.json().memories[0].content).toContain("YUVI Runtime");

      const events = await app.inject({ method: "GET", url: "/events/recent?limit=20" });
      expect(events.statusCode).toBe(200);
      expect(events.json().events.some((event: { traceId?: string }) => event.traceId)).toBe(true);
      expect(events.body).not.toContain("test_deepseek_secret");

      await app.listen({ host: "127.0.0.1", port: 0 });
      const dashboardMessage = await readFirstWebSocketMessage(
        `${getServerOrigin(app.server.address())}/ws?dashboard=true`
      );
      expect(dashboardMessage.kind).toBe("dashboard.connected");
      expect(dashboardMessage.traceId).toBeTypeOf("string");

      await app.close();
    } finally {
      restoreEnv(previous);
    }
  });
});

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function setMockEnv(): void {
  process.env["NODE_ENV"] = "test";
  process.env["RUNTIME_MODE"] = "development";
  process.env["PROVIDER_ALLOW_MOCKS"] = "true";
  process.env["MEMORY_REPOSITORY"] = "in-memory";
  process.env["DEFAULT_CHAT_PROVIDER"] = "deepseek";
  process.env["DEFAULT_REASONING_PROVIDER"] = "deepseek";
  process.env["DEFAULT_TTS_PROVIDER"] = "xai";
  process.env["DEFAULT_STT_PROVIDER"] = "dashscope";
  process.env["DEFAULT_VISION_PROVIDER"] = "xai";
  process.env["DEFAULT_EMBEDDING_PROVIDER"] = "mock";
  process.env["DEEPSEEK_API_KEY"] = "test_deepseek_secret";
  process.env["XAI_API_KEY"] = "test_xai_secret";
  process.env["DASHSCOPE_API_KEY"] = "test_dashscope_secret";
}

function findPromptSection(
  sections: Array<{ name: string; content: string }>,
  name: string
): { name: string; content: string } | undefined {
  return sections.find((section) => section.name === name);
}

function snapshotEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}

function restoreEnv(snapshot: NodeJS.ProcessEnv): void {
  process.env = snapshot;
}

function getServerOrigin(address: string | import("node:net").AddressInfo | null): string {
  if (!address || typeof address === "string") {
    throw new Error("Expected Fastify to listen on a TCP address.");
  }

  return `ws://${address.address}:${address.port}`;
}

async function readFirstWebSocketMessage(
  url: string
): Promise<{ kind?: string; traceId?: string }> {
  type MinimalWebSocket = {
    addEventListener(
      event: "open" | "message" | "error",
      listener: (event: { data?: unknown }) => void
    ): void;
    close(): void;
  };
  const WebSocketCtor = (
    globalThis as unknown as { WebSocket: new (url: string) => MinimalWebSocket }
  ).WebSocket;

  return new Promise((resolve, reject) => {
    const socket = new WebSocketCtor(url);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out waiting for dashboard WebSocket message."));
    }, 2000);

    socket.addEventListener("message", (event) => {
      clearTimeout(timeout);
      socket.close();
      resolve(JSON.parse(String(event.data)) as { kind?: string; traceId?: string });
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("Dashboard WebSocket connection failed."));
    });
  });
}
