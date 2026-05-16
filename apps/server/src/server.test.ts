import { describe, expect, it, vi } from "vitest";
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
      expect(health.body).not.toContain("test_deepseek_secret");

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
      expect(message.json().provider).toMatchObject({
        name: "mock",
        capability: "chat",
        mock: true,
        healthStatus: "healthy"
      });
      expect(message.json().provider.latencyMs).toBeTypeOf("number");
      expect(message.json().provider.tokenUsage.totalTokens).toBeTypeOf("number");

      const prompt = await app.inject({ method: "GET", url: "/debug/prompt/latest" });
      expect(prompt.statusCode).toBe(200);
      expect(prompt.json().promptPreview.sections.length).toBeGreaterThan(0);
      expect(prompt.json().traceId).toBe(message.json().traceId);
      expect(prompt.json().retrievedMemoryCount).toBe(0);
      expect(prompt.json().providerName).toBe("mock");
      expect(prompt.json().providerMock).toBe(true);
      expect(prompt.body).not.toContain("test_deepseek_secret");

      const providers = await app.inject({ method: "GET", url: "/providers/status" });
      expect(providers.statusCode).toBe(200);
      expect(providers.json().providers.chat).toMatchObject({
        provider: "deepseek",
        capability: "chat",
        configured: false,
        available: true,
        mock: true,
        required: true
      });
      expect(providers.json().providers.reasoning).toMatchObject({
        provider: "deepseek",
        capability: "reasoning",
        configured: false,
        available: true,
        mock: true,
        required: false
      });
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

  it("includes safe real-provider metadata when DeepSeek chat is configured", async () => {
    const previous = snapshotEnv();
    setConfiguredDeepSeekEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "deepseek-chat",
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: "Real provider test reply."
              }
            }
          ],
          usage: {
            prompt_tokens: 11,
            completion_tokens: 4,
            total_tokens: 15
          }
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      )
    );

    try {
      const app = await buildServer(loadServerConfig(process.env));
      const message = await app.inject({
        method: "POST",
        url: "/message",
        payload: {
          sessionId: "test",
          text: "hello real DeepSeek",
          options: {
            useMemory: false,
            voiceOutput: false
          }
        }
      });

      expect(message.statusCode).toBe(200);
      expect(message.json().reply).toBe("Real provider test reply.");
      expect(message.json().provider).toMatchObject({
        name: "deepseek",
        capability: "chat",
        model: "deepseek-chat",
        mock: false,
        healthStatus: "degraded",
        tokenUsage: {
          inputTokens: 11,
          outputTokens: 4,
          totalTokens: 15
        }
      });
      expect(message.json().provider.latencyMs).toBeTypeOf("number");
      expect(message.body).not.toContain("configured_deepseek_secret");
      expect(message.body).not.toContain("Authorization");

      const prompt = await app.inject({ method: "GET", url: "/debug/prompt/latest" });
      expect(prompt.statusCode).toBe(200);
      expect(prompt.json().providerName).toBe("deepseek");
      expect(prompt.json().providerModel).toBe("deepseek-chat");
      expect(prompt.json().providerMock).toBe(false);
      expect(prompt.body).not.toContain("configured_deepseek_secret");

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      await app.close();
    } finally {
      vi.restoreAllMocks();
      restoreEnv(previous);
    }
  });

  it("separates memory read and write behavior", async () => {
    const previous = snapshotEnv();
    setMockEnv();

    try {
      const app = await buildServer(loadServerConfig(process.env));
      const seeded = await app.inject({
        method: "POST",
        url: "/memory",
        payload: {
          type: "semantic",
          content: "用户偏好 Chat 使用 DeepSeek。",
          source: "dashboard"
        }
      });
      expect(seeded.statusCode).toBe(200);

      const disabled = await app.inject({
        method: "POST",
        url: "/message",
        payload: {
          sessionId: "test",
          text: "用户偏好什么 Chat provider？",
          options: {
            useMemory: false,
            voiceOutput: false
          }
        }
      });
      expect(disabled.statusCode).toBe(200);
      const disabledPrompt = await app.inject({ method: "GET", url: "/debug/prompt/latest" });
      expect(disabledPrompt.json()).toMatchObject({
        readMemory: false,
        writeMemory: false,
        retrievedMemoryCount: 0
      });
      expect(disabledPrompt.body).not.toContain("用户偏好 Chat 使用 DeepSeek");
      expect(
        (await app.inject({ method: "GET", url: "/memory/recent?limit=10" })).json().memories
      ).toHaveLength(1);

      const writeOnly = await app.inject({
        method: "POST",
        url: "/message",
        payload: {
          sessionId: "test",
          text: "记住：用户偏好 Reasoning 使用 DeepSeek。",
          options: {
            useMemory: false,
            readMemory: false,
            writeMemory: true,
            voiceOutput: false
          }
        }
      });
      expect(writeOnly.statusCode).toBe(200);
      const writeOnlyPrompt = await app.inject({ method: "GET", url: "/debug/prompt/latest" });
      expect(writeOnlyPrompt.json()).toMatchObject({
        readMemory: false,
        writeMemory: true,
        retrievedMemoryCount: 0
      });
      const afterWriteOnly = await app.inject({ method: "GET", url: "/memory/recent?limit=10" });
      expect(afterWriteOnly.json().memories).toHaveLength(2);
      expect(afterWriteOnly.json().memories[0]).toMatchObject({
        type: "semantic",
        subtype: "provider-choice",
        source: "runtime",
        sourceTraceId: writeOnly.json().traceId
      });

      const readOnly = await app.inject({
        method: "POST",
        url: "/message",
        payload: {
          sessionId: "test",
          text: "Chat provider 偏好是什么？",
          options: {
            readMemory: true,
            writeMemory: false,
            voiceOutput: false
          }
        }
      });
      expect(readOnly.statusCode).toBe(200);
      const readOnlyPrompt = await app.inject({ method: "GET", url: "/debug/prompt/latest" });
      expect(readOnlyPrompt.json().readMemory).toBe(true);
      expect(readOnlyPrompt.json().writeMemory).toBe(false);
      expect(readOnlyPrompt.json().retrievedMemoryCount).toBeGreaterThan(0);
      expect(readOnlyPrompt.body).toContain("用户偏好 Chat 使用 DeepSeek");
      const afterReadOnly = await app.inject({ method: "GET", url: "/memory/recent?limit=10" });
      expect(afterReadOnly.json().memories).toHaveLength(2);

      const enabled = await app.inject({
        method: "POST",
        url: "/message",
        payload: {
          sessionId: "test",
          text: "记住：项目里程碑是 provider observability 已完成。",
          options: {
            useMemory: true,
            voiceOutput: false
          }
        }
      });
      expect(enabled.statusCode).toBe(200);
      const enabledPrompt = await app.inject({ method: "GET", url: "/debug/prompt/latest" });
      expect(enabledPrompt.json().readMemory).toBe(true);
      expect(enabledPrompt.json().writeMemory).toBe(true);

      await app.close();
    } finally {
      restoreEnv(previous);
    }
  });

  it("avoids writing low-value runtime memories", async () => {
    const previous = snapshotEnv();
    setMockEnv();

    try {
      const app = await buildServer(loadServerConfig(process.env));
      const greeting = await app.inject({
        method: "POST",
        url: "/message",
        payload: {
          sessionId: "test",
          text: "hi",
          options: {
            useMemory: true,
            voiceOutput: false
          }
        }
      });
      expect(greeting.statusCode).toBe(200);

      const ordinaryQuestion = await app.inject({
        method: "POST",
        url: "/message",
        payload: {
          sessionId: "test",
          text: "What is the weather?",
          options: {
            useMemory: true,
            voiceOutput: false
          }
        }
      });
      expect(ordinaryQuestion.statusCode).toBe(200);

      const recent = await app.inject({ method: "GET", url: "/memory/recent?limit=10" });
      expect(recent.json().memories).toHaveLength(0);
      await app.close();
    } finally {
      restoreEnv(previous);
    }
  });

  it("verifies providers only when explicit endpoints are called", async () => {
    const previous = snapshotEnv();
    setMockEnv();

    try {
      const app = await buildServer(loadServerConfig(process.env));
      const chat = await app.inject({ method: "POST", url: "/providers/verify/chat" });
      expect(chat.statusCode).toBe(200);
      expect(chat.json()).toMatchObject({
        ok: true,
        provider: "mock",
        capability: "chat",
        mock: true
      });
      expect(chat.body).not.toContain("test_deepseek_secret");

      const reasoning = await app.inject({
        method: "POST",
        url: "/providers/verify/reasoning"
      });
      expect(reasoning.statusCode).toBe(200);
      expect(reasoning.json()).toMatchObject({
        ok: true,
        provider: "mock",
        capability: "reasoning",
        mock: true
      });
      expect(reasoning.body).not.toContain("test_deepseek_secret");
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

function setConfiguredDeepSeekEnv(): void {
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
  process.env["DEEPSEEK_API_KEY"] = "configured_deepseek_secret";
  process.env["DEEPSEEK_CHAT_MODEL"] = "deepseek-chat";
  process.env["DEEPSEEK_REASONING_MODEL"] = "deepseek-reasoner";
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
