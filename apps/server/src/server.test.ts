import { describe, expect, it, vi } from "vitest";
import { loadServerConfig } from "./config.js";
import { buildServer } from "./server.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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
      expect(prompt.json().memoryExtractorMode).toBe("llm");
      expect(prompt.json().fallbackUsed).toBe(true);
      expect(prompt.json().memoryExtractionCandidateCount).toBeTypeOf("number");
      expect(prompt.json().storedMemoryCount).toBeTypeOf("number");
      expect(prompt.json().rejectedMemoryCount).toBeTypeOf("number");
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
      expect(providers.json().providers.embedding).toMatchObject({
        provider: "mock",
        capability: "embedding",
        configured: true,
        available: true,
        mock: true,
        semanticEmbedding: false,
        embeddingNote: expect.stringContaining("do not provide real semantic similarity")
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
      const memoryId = memory.json().id as string;

      const memoryDetail = await app.inject({ method: "GET", url: `/memory/${memoryId}` });
      expect(memoryDetail.statusCode).toBe(200);
      expect(memoryDetail.json()).toMatchObject({
        id: memoryId,
        type: "semantic",
        scope: "user",
        memoryLayer: "core",
        status: "active",
        content: "Server test memory.",
        source: "test"
      });

      const invalidImportance = await app.inject({
        method: "PATCH",
        url: `/memory/${memoryId}`,
        payload: { importance: 2 }
      });
      expect(invalidImportance.statusCode).toBe(400);

      const unsafeMetadata = await app.inject({
        method: "PATCH",
        url: `/memory/${memoryId}`,
        payload: { metadata: { apiKey: "secret-value" } }
      });
      expect(unsafeMetadata.statusCode).toBe(400);
      expect(unsafeMetadata.body).not.toContain("secret-value");

      const updatedMemory = await app.inject({
        method: "PATCH",
        url: `/memory/${memoryId}`,
        payload: {
          type: "procedural",
          subtype: "workflow",
          scope: "project",
          scopeId: "yuvi-runtime",
          memoryLayer: "recall",
          status: "active",
          content: "Server test memory updated.",
          summary: "Server test memory updated.",
          importance: 0.8,
          tags: ["updated", "server"],
          validUntil: new Date(Date.now() + 60_000).toISOString()
        }
      });
      expect(updatedMemory.statusCode).toBe(200);
      expect(updatedMemory.json()).toMatchObject({
        id: memoryId,
        type: "procedural",
        subtype: "workflow",
        scope: "project",
        scopeId: "yuvi-runtime",
        memoryLayer: "recall",
        status: "active",
        content: "Server test memory updated.",
        summary: "Server test memory updated.",
        importance: 0.8,
        tags: ["updated", "server"]
      });

      const archiveMemory = await app.inject({
        method: "POST",
        url: `/memory/${memoryId}/archive`
      });
      expect(archiveMemory.statusCode).toBe(200);
      expect(archiveMemory.json().memory.status).toBe("archived");
      const archivedPromptSearch = await app.inject({
        method: "GET",
        url: "/memory/search?q=Server%20test%20memory%20updated&limit=5"
      });
      expect(
        archivedPromptSearch
          .json()
          .memories.some((memory: { id: string }) => memory.id === memoryId)
      ).toBe(false);
      const restoreMemory = await app.inject({
        method: "POST",
        url: `/memory/${memoryId}/restore`
      });
      expect(restoreMemory.statusCode).toBe(200);
      expect(restoreMemory.json().memory.status).toBe("active");
      const forgetMemory = await app.inject({
        method: "POST",
        url: `/memory/${memoryId}/forget`
      });
      expect(forgetMemory.statusCode).toBe(200);
      expect(forgetMemory.json().memory.status).toBe("forgotten");
      const restoreForgottenMemory = await app.inject({
        method: "POST",
        url: `/memory/${memoryId}/restore`
      });
      expect(restoreForgottenMemory.statusCode).toBe(200);
      expect(restoreForgottenMemory.json().memory.status).toBe("active");

      const missingUpdate = await app.inject({
        method: "PATCH",
        url: "/memory/missing",
        payload: { content: "nope" }
      });
      expect(missingUpdate.statusCode).toBe(404);

      const deleteCandidate = await app.inject({
        method: "POST",
        url: "/memory",
        payload: {
          type: "semantic",
          content: "Delete me from memory.",
          source: "test"
        }
      });
      expect(deleteCandidate.statusCode).toBe(200);
      const deleteId = deleteCandidate.json().id as string;
      const deleteMemory = await app.inject({ method: "DELETE", url: `/memory/${deleteId}` });
      expect(deleteMemory.statusCode).toBe(200);
      expect(deleteMemory.json()).toMatchObject({ ok: true, id: deleteId });

      const noBodyDeleteCandidate = await app.inject({
        method: "POST",
        url: "/memory",
        payload: {
          type: "semantic",
          content: "Delete me with no JSON content type.",
          source: "test"
        }
      });
      expect(noBodyDeleteCandidate.statusCode).toBe(200);
      const noBodyDeleteId = noBodyDeleteCandidate.json().id as string;
      const noBodyDelete = await app.inject({
        method: "DELETE",
        url: `/memory/${noBodyDeleteId}`,
        headers: {}
      });
      expect(noBodyDelete.statusCode).toBe(200);
      expect(noBodyDelete.json()).toMatchObject({ ok: true, id: noBodyDeleteId });

      const deletedDetail = await app.inject({ method: "GET", url: `/memory/${deleteId}` });
      expect(deletedDetail.statusCode).toBe(404);
      const deletedSearch = await app.inject({
        method: "GET",
        url: "/memory/search?q=Delete%20me&limit=5"
      });
      expect(deletedSearch.statusCode).toBe(200);
      expect(
        deletedSearch.json().memories.some((candidate: { id: string }) => candidate.id === deleteId)
      ).toBe(false);

      const missingDelete = await app.inject({ method: "DELETE", url: "/memory/missing" });
      expect(missingDelete.statusCode).toBe(404);

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
      expect(findPromptSection(promptWithMemory.json().sections, "CurrentTime")?.content).toContain(
        "ISO timestamp:"
      );
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
      const yuviDirectContext = findPromptSection(
        yuviPromptWithMemory.json().sections,
        "DirectContext"
      );
      expect(yuviPromptWithMemory.json().useMemory).toBe(true);
      expect(yuviPromptWithMemory.json().userMessage).toBe("YUVI Runtime 是什么项目？");
      expect(yuviPromptWithMemory.json().directContextEnabled).toBe(true);
      expect(yuviPromptWithMemory.json().directContextTurnCount).toBeGreaterThan(0);
      expect(yuviPromptWithMemory.json().directContextCharCount).toBeGreaterThan(0);
      expect(yuviDirectContext?.content).toContain("Server test details");
      expect(yuviDirectContext?.content).not.toContain("test_deepseek_secret");
      expect(yuviPromptWithMemory.json().retrievedMemoryCountRaw).toBeGreaterThan(
        yuviPromptWithMemory.json().retrievedMemoryCount
      );
      expect(yuviPromptWithMemory.json().retrievedMemoryCount).toBeGreaterThan(0);
      expect(yuviPromptWithMemory.json().retrievalScope).toContain("project:yuvi-runtime");
      expect(yuviPromptWithMemory.json().includedScopes).toContainEqual({
        scope: "session",
        scopeId: "test"
      });
      expect(yuviPromptWithMemory.json().excludedByStatus).toBeGreaterThanOrEqual(0);
      expect(yuviPromptWithMemory.json().excludedByTime).toBeGreaterThanOrEqual(0);
      expect(yuviPromptWithMemory.json().excludedByScope).toBeGreaterThanOrEqual(0);
      expect(yuviPromptWithMemory.json().currentTime).toMatch(/T/);
      expect(yuviRelevantMemory?.content).toMatch(/YUVI Runtime|AI Companion Runtime/);
      expect(yuviRelevantMemory?.content).toContain("[project:yuvi-runtime][core][active]");
      expect(countOccurrences(yuviRelevantMemory?.content ?? "", "YUVI Runtime")).toBe(1);
      expect(yuviRelevantMemory?.content).not.toContain("“");
      expect(yuviPromptWithMemory.json().retrievedMemories[0]).toMatchObject({
        type: "semantic",
        scope: "project",
        scopeId: "yuvi-runtime",
        memoryLayer: "core",
        status: "active",
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
      expect(search.json().retrievalMode).toMatch(/^in-memory-|fallback-recent$/);
      expect(search.json().semanticEmbedding).toBe(false);
      expect(search.json().embeddingNote).toContain("Mock embeddings");
      expect(search.json().rawCount).toBeGreaterThanOrEqual(search.json().count);
      expect(search.json().memories.length).toBeGreaterThan(0);
      expect(search.json().retrievalScope).toBeTruthy();
      expect(search.json().excludedByStatus).toBeGreaterThanOrEqual(0);

      const filteredSearch = await app.inject({
        method: "GET",
        url: `/memory/search?${new URLSearchParams({
          q: "Server test memory updated",
          type: "procedural",
          subtype: "workflow",
          source: "test",
          scope: "project",
          scopeId: "yuvi-runtime",
          memoryLayer: "recall",
          status: "active",
          tags: "updated,server",
          minImportance: "0.7",
          limit: "5"
        }).toString()}`
      });
      expect(filteredSearch.statusCode).toBe(200);
      expect(filteredSearch.json().memories[0]).toMatchObject({
        id: memoryId,
        type: "procedural",
        subtype: "workflow",
        source: "test",
        scope: "project",
        scopeId: "yuvi-runtime",
        memoryLayer: "recall",
        status: "active"
      });
      expect(filteredSearch.json().debugMemories[0]).toMatchObject({
        matchedBy: expect.any(String),
        score: expect.any(Number)
      });

      const postChineseSearch = await app.inject({
        method: "POST",
        url: "/memory/search",
        payload: {
          q: "模型供应商偏好",
          limit: 10,
          scope: "project",
          scopeId: "yuvi-runtime"
        }
      });
      expect(postChineseSearch.statusCode).toBe(200);
      expect(postChineseSearch.json().query).toBe("模型供应商偏好");
      expect(postChineseSearch.json().repository).toBe("in-memory");
      expect(postChineseSearch.json().retrievalMode).not.toMatch(/^postgres-/);

      const invalidSearch = await app.inject({
        method: "GET",
        url: "/memory/search?limit=999"
      });
      expect(invalidSearch.statusCode).toBe(400);
      expect(invalidSearch.json().message).toContain("POST /memory/search");

      const encodedChineseSearch = await app.inject({
        method: "GET",
        url: `/memory/search?${new URLSearchParams({ q: "项目", limit: "5" }).toString()}`
      });
      expect(encodedChineseSearch.statusCode).toBe(200);
      expect(encodedChineseSearch.json().memories.length).toBeGreaterThan(0);
      expect(encodedChineseSearch.json().memories[0].content).toContain("YUVI Runtime");

      const archived = await app.inject({
        method: "POST",
        url: "/memory",
        payload: {
          type: "semantic",
          content: "Archived manual search memory for YUVI Runtime.",
          status: "archived",
          source: "test",
          tags: ["yuvi"]
        }
      });
      expect(archived.statusCode).toBe(200);
      const archivedDefaultSearch = await app.inject({
        method: "GET",
        url: "/memory/search?q=Archived%20manual%20search&limit=5"
      });
      expect(archivedDefaultSearch.json().memories).toHaveLength(0);
      const archivedIncludedSearch = await app.inject({
        method: "GET",
        url: "/memory/search?q=Archived%20manual%20search&includeArchived=true&limit=5"
      });
      expect(archivedIncludedSearch.json().memories[0].status).toBe("archived");

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

  it("does not silently mock required chat provider in real-first mode", async () => {
    const previous = snapshotEnv();
    process.env = {
      NODE_ENV: "development",
      RUNTIME_MODE: "development",
      PROVIDER_ALLOW_MOCKS: "false",
      MEMORY_REPOSITORY: "in-memory",
      DEFAULT_CHAT_PROVIDER: "deepseek",
      DEFAULT_REASONING_PROVIDER: "deepseek",
      DEFAULT_EMBEDDING_PROVIDER: "openai-compatible"
    };

    try {
      const app = await buildServer(loadServerConfig(process.env));
      const providers = await app.inject({ method: "GET", url: "/providers/status" });
      expect(providers.statusCode).toBe(200);
      expect(providers.json().providers.chat).toMatchObject({
        configured: false,
        available: false,
        mock: false,
        status: "unavailable"
      });

      const message = await app.inject({
        method: "POST",
        url: "/message",
        payload: {
          sessionId: "real-first",
          text: "hello",
          options: {
            readMemory: false,
            writeMemory: false,
            voiceOutput: false
          }
        }
      });
      expect(message.statusCode).toBe(503);
      expect(message.json()).toMatchObject({
        error: "provider_unavailable",
        provider: "deepseek",
        capability: "chat"
      });
      expect(message.json().setup).toContain("PROVIDER_ALLOW_MOCKS=true");
      expect(message.body).not.toContain("API_KEY");

      await app.close();
    } finally {
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
      expect(disabledPrompt.json().memoryCandidates).toEqual([]);
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
      expect(writeOnlyPrompt.json().memoryCandidates[0]).toMatchObject({
        type: "semantic",
        subtype: "provider-choice",
        decision: "stored",
        sourceTraceId: writeOnly.json().traceId
      });

      const recentCandidates = await app.inject({
        method: "GET",
        url: "/memory/candidates/recent?limit=5"
      });
      expect(recentCandidates.statusCode).toBe(200);
      expect(recentCandidates.json()).toMatchObject({
        volatile: true,
        count: expect.any(Number),
        storedCount: expect.any(Number),
        rejectedCount: expect.any(Number),
        fallbackUsed: expect.any(Boolean)
      });
      const candidateId = recentCandidates.json().candidates[0].id as string;
      expect(recentCandidates.json().candidates[0]).toMatchObject({
        source: "runtime",
        extractorMode: "llm",
        fallbackUsed: true,
        createdAt: expect.any(String)
      });
      expect(recentCandidates.body).not.toContain("test_deepseek_secret");

      const acceptedCandidate = await app.inject({
        method: "POST",
        url: `/memory/candidates/${candidateId}/accept`,
        payload: {
          content: "用户偏好 Reasoning 使用 DeepSeek。",
          summary: "用户偏好 Reasoning 使用 DeepSeek。",
          importance: 0.9,
          tags: ["accepted"]
        }
      });
      expect(acceptedCandidate.statusCode).toBe(200);
      expect(acceptedCandidate.json()).toMatchObject({
        ok: true,
        alreadyStored: true,
        message: expect.stringContaining("already stored")
      });
      const afterAlreadyStoredAccept = await app.inject({
        method: "GET",
        url: "/memory/recent?limit=10"
      });
      expect(
        afterAlreadyStoredAccept
          .json()
          .memories.filter(
            (memory: { content: string }) => memory.content === "用户偏好 Reasoning 使用 DeepSeek。"
          )
      ).toHaveLength(1);

      const rejectedCandidate = await app.inject({
        method: "POST",
        url: `/memory/candidates/${candidateId}/reject`,
        payload: { reason: "Not useful now." }
      });
      expect(rejectedCandidate.statusCode).toBe(200);
      expect(rejectedCandidate.json().candidate).toMatchObject({
        id: candidateId,
        decision: "stored",
        rejectedReason: "Candidate is already stored and was not rejected."
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

  it("requires the optional dashboard dev token for sensitive development endpoints", async () => {
    const previous = snapshotEnv();
    setMockEnv();

    try {
      const app = await buildServer(
        loadServerConfig({
          ...process.env,
          DASHBOARD_DEV_TOKEN: "dev-token"
        })
      );

      const blockedSettings = await app.inject({
        method: "POST",
        url: "/settings/runtime",
        payload: { values: { SERVER_PORT: "6121" } }
      });
      expect(blockedSettings.statusCode).toBe(401);
      expect(blockedSettings.body).not.toContain("dev-token");

      const blockedVerify = await app.inject({
        method: "POST",
        url: "/providers/verify/chat"
      });
      expect(blockedVerify.statusCode).toBe(401);
      expect(blockedVerify.body).not.toContain("dev-token");

      const allowedVerify = await app.inject({
        method: "POST",
        url: "/providers/verify/chat",
        headers: {
          "X-YUVI-Dev-Token": "dev-token"
        }
      });
      expect(allowedVerify.statusCode).toBe(200);
      expect(allowedVerify.json()).toMatchObject({
        ok: true,
        capability: "chat"
      });
      expect(allowedVerify.body).not.toContain("dev-token");

      await app.close();
    } finally {
      restoreEnv(previous);
    }
  });

  it("parses optional memory extractor mode", () => {
    expect(loadServerConfig({}).memoryExtractor).toBe("llm");
    expect(loadServerConfig({ MEMORY_EXTRACTOR: "rule-based" }).memoryExtractor).toBe("rule-based");
    expect(loadServerConfig({ MEMORY_EXTRACTOR: "llm" }).memoryExtractor).toBe("llm");
    expect(() => loadServerConfig({ MEMORY_EXTRACTOR: "external" })).toThrow(
      "Unsupported MEMORY_EXTRACTOR"
    );
  });

  it("parses event bus boundary values", async () => {
    expect(loadServerConfig({ EVENT_BUS: "in-memory" }).eventBus).toBe("in-memory");
    expect(loadServerConfig({ EVENT_BUS: "nats" }).eventBus).toBe("nats");
    await expect(buildServer(loadServerConfig({ EVENT_BUS: "nats" }))).rejects.toThrow(
      "EVENT_BUS=nats is reserved"
    );
    expect(() => loadServerConfig({ EVENT_BUS: "external" })).toThrow("Unsupported EVENT_BUS");
  });

  it("returns and updates safe runtime settings without exposing secrets", async () => {
    const previous = snapshotEnv();
    const previousCwd = process.cwd();
    const tempDir = await mkdtemp(path.join(tmpdir(), "yuvi-settings-"));
    setConfiguredDeepSeekEnv();

    try {
      process.chdir(tempDir);
      const app = await buildServer(loadServerConfig(process.env));

      const settings = await app.inject({ method: "GET", url: "/settings/runtime" });
      expect(settings.statusCode).toBe(200);
      expect(settings.json().configFiles[".env"].exists).toBe(false);
      expect(settings.json().configFiles[".env.local"].exists).toBe(false);
      expect(settings.json().providers.deepseek.apiKeyConfigured).toBe(true);
      expect(settings.json().providers.deepseek.apiKeyPreview).toBe("••••••••••••cret");
      expect(settings.json().providers.deepseek.apiKeyPreview).not.toBe(
        "configured_deepseek_secret"
      );
      expect(settings.json().providers.deepseek.apiKeyPreview.length).toBe(16);
      expect(settings.json().providers.xai.apiKeyConfigured).toBe(false);
      expect(settings.json().providers.xai.apiKeyPreview).toBeUndefined();
      expect(settings.json().memory).toMatchObject({
        memoryExtractor: "llm",
        activeMemoryExtractor: "llm",
        memoryExtractorDefault: "llm",
        reasoningProviderConfigured: true
      });
      expect(settings.body).not.toContain("configured_deepseek_secret");
      expect(settings.body).not.toContain("Authorization");

      const unsafe = await app.inject({
        method: "POST",
        url: "/settings/runtime",
        payload: {
          values: {
            NODE_ENV: "production"
          }
        }
      });
      expect(unsafe.statusCode).toBe(400);
      expect(unsafe.json().error).toBe("unsafe_keys");

      const invalidExtractor = await app.inject({
        method: "POST",
        url: "/settings/runtime",
        payload: {
          values: {
            MEMORY_EXTRACTOR: "external"
          }
        }
      });
      expect(invalidExtractor.statusCode).toBe(400);
      expect(invalidExtractor.json().error).toBe("invalid_memory_extractor");

      const update = await app.inject({
        method: "POST",
        url: "/settings/runtime",
        payload: {
          values: {
            MEMORY_REPOSITORY: "postgres",
            MEMORY_EXTRACTOR: "rule-based",
            DEEPSEEK_API_KEY: "new_deepseek_secret",
            DEEPSEEK_CHAT_MODEL: "deepseek-chat"
          }
        }
      });
      expect(update.statusCode).toBe(200);
      expect(update.json()).toMatchObject({
        ok: true,
        restartRequired: true
      });
      expect(update.json().changedKeys).toEqual(
        expect.arrayContaining(["MEMORY_REPOSITORY", "MEMORY_EXTRACTOR", "DEEPSEEK_API_KEY"])
      );
      expect(update.json().settings.memory.memoryRepository).toBe("postgres");
      expect(update.json().settings.memory.memoryExtractor).toBe("rule-based");
      expect(update.json().settings.configFiles[".env.local"].exists).toBe(true);
      expect(update.json().settings.settings.MEMORY_REPOSITORY).toMatchObject({
        base: "",
        localOverride: "postgres",
        effective: "postgres",
        source: ".env.local"
      });
      expect(update.json().settings.settings.MEMORY_EXTRACTOR).toMatchObject({
        base: "",
        localOverride: "rule-based",
        effective: "rule-based",
        source: ".env.local"
      });
      expect(update.json().settings.settings.DEEPSEEK_API_KEY).toMatchObject({
        baseConfigured: false,
        localOverrideConfigured: true,
        effectiveConfigured: true,
        maskedValue: "••••••••••••cret",
        source: ".env.local"
      });
      expect(update.body).not.toContain("new_deepseek_secret");
      expect(update.body).not.toContain("configured_deepseek_secret");
      expect(update.json().settings.providers.deepseek.apiKeyConfigured).toBe(true);
      expect(update.json().settings.providers.deepseek.apiKeyPreview).toBe("••••••••••••cret");

      const localEnv = await readFile(path.join(tempDir, ".env.local"), "utf8");
      expect(localEnv.match(/^DEEPSEEK_API_KEY=/gmu)).toHaveLength(1);
      expect(localEnv).toContain("DEEPSEEK_API_KEY=new_deepseek_secret");

      const updateExisting = await app.inject({
        method: "POST",
        url: "/settings/runtime",
        payload: {
          values: {
            DEEPSEEK_API_KEY: "second_secret_value"
          }
        }
      });
      expect(updateExisting.statusCode).toBe(200);
      const updatedLocalEnv = await readFile(path.join(tempDir, ".env.local"), "utf8");
      expect(updatedLocalEnv.match(/^DEEPSEEK_API_KEY=/gmu)).toHaveLength(1);
      expect(updatedLocalEnv).toContain("DEEPSEEK_API_KEY=second_secret_value");
      expect(updateExisting.body).not.toContain("second_secret_value");

      await app.close();
    } finally {
      process.chdir(previousCwd);
      await rm(tempDir, { recursive: true, force: true });
      restoreEnv(previous);
    }
  });

  it("shows .env.local overrides as pending safe settings without mutating .env", async () => {
    const previous = snapshotEnv();
    const previousCwd = process.cwd();
    const tempDir = await mkdtemp(path.join(tmpdir(), "yuvi-settings-overlay-"));
    setMockEnv();

    try {
      process.chdir(tempDir);
      await writeFile(path.join(tempDir, ".env"), "DEEPSEEK_CHAT_MODEL=from-env\n", "utf8");
      await writeFile(
        path.join(tempDir, ".env.local"),
        "DEEPSEEK_CHAT_MODEL=from-local\nXAI_API_KEY=local_xai_secret\n",
        "utf8"
      );

      const app = await buildServer(loadServerConfig(process.env));
      const settings = await app.inject({ method: "GET", url: "/settings/runtime" });

      expect(settings.statusCode).toBe(200);
      expect(settings.json().configFiles[".env"]).toMatchObject({
        exists: true,
        gitIgnored: true
      });
      expect(settings.json().configFiles[".env.local"]).toMatchObject({
        exists: true,
        gitIgnored: true
      });
      expect(settings.json().providers.deepseek.chatModel).toBe("from-local");
      expect(settings.json().settings.DEEPSEEK_CHAT_MODEL).toMatchObject({
        base: "from-env",
        localOverride: "from-local",
        effective: "from-local",
        source: ".env.local"
      });
      expect(settings.json().baseConfig.DEEPSEEK_CHAT_MODEL).toBe("from-env");
      expect(settings.json().localOverrideConfig.DEEPSEEK_CHAT_MODEL).toBe("from-local");
      expect(settings.json().effectiveConfig.DEEPSEEK_CHAT_MODEL).toBe("from-local");
      expect(settings.json().providers.xai.apiKeyConfigured).toBe(true);
      expect(settings.json().providers.xai.apiKeyPreview).toBe("••••••••••••cret");
      expect(settings.json().settings.XAI_API_KEY).toMatchObject({
        baseConfigured: false,
        localOverrideConfigured: true,
        effectiveConfigured: true,
        maskedValue: "••••••••••••cret",
        source: ".env.local"
      });
      expect(settings.json().restartRequired).toBe(false);
      expect(settings.body).not.toContain("local_xai_secret");
      expect(await readFile(path.join(tempDir, ".env"), "utf8")).toBe(
        "DEEPSEEK_CHAT_MODEL=from-env\n"
      );

      await app.close();
    } finally {
      process.chdir(previousCwd);
      await rm(tempDir, { recursive: true, force: true });
      restoreEnv(previous);
    }
  });

  it("reloads saved provider config into the active runtime without leaking secrets", async () => {
    const previous = snapshotEnv();
    const previousCwd = process.cwd();
    const tempDir = await mkdtemp(path.join(tmpdir(), "yuvi-settings-reload-"));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "deepseek-chat",
          choices: [
            {
              finish_reason: "stop",
              message: { role: "assistant", content: "Reloaded provider reply." }
            }
          ],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 5,
            total_tokens: 17
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    setMockEnv();

    try {
      process.chdir(tempDir);
      delete process.env["DEEPSEEK_CHAT_MODEL"];
      delete process.env["DEEPSEEK_REASONING_MODEL"];
      const app = await buildServer(loadServerConfig(process.env));

      const initialProviders = await app.inject({ method: "GET", url: "/providers/status" });
      expect(initialProviders.statusCode).toBe(200);
      expect(initialProviders.json().providers.chat).toMatchObject({
        configured: false,
        mock: true
      });

      const update = await app.inject({
        method: "POST",
        url: "/settings/runtime",
        payload: {
          values: {
            DEEPSEEK_API_KEY: "reload_deepseek_secret",
            DEEPSEEK_CHAT_MODEL: "deepseek-chat",
            DEEPSEEK_REASONING_MODEL: "deepseek-reasoner",
            MEMORY_EXTRACTOR: "rule-based"
          }
        }
      });
      expect(update.statusCode).toBe(200);
      expect(update.body).not.toContain("reload_deepseek_secret");

      const reload = await app.inject({ method: "POST", url: "/settings/runtime/reload" });
      expect(reload.statusCode).toBe(200);
      expect(reload.json()).toMatchObject({
        ok: true,
        applied: true,
        restartRequired: false
      });
      expect(reload.json().settings.memory.activeMemoryExtractor).toBe("rule-based");
      expect(reload.json().active.providers.chat).toMatchObject({
        provider: "deepseek",
        configured: true,
        mock: false,
        model: "deepseek-chat"
      });
      expect(reload.body).not.toContain("reload_deepseek_secret");

      const providers = await app.inject({ method: "GET", url: "/providers/status" });
      expect(providers.statusCode).toBe(200);
      expect(providers.json().providers.chat).toMatchObject({
        configured: true,
        mock: false,
        model: "deepseek-chat"
      });
      expect(providers.body).not.toContain("reload_deepseek_secret");

      const message = await app.inject({
        method: "POST",
        url: "/message",
        payload: {
          sessionId: "reload",
          text: "hello after reload",
          options: {
            readMemory: false,
            writeMemory: false,
            voiceOutput: false
          }
        }
      });
      expect(message.statusCode).toBe(200);
      expect(message.json().reply).toBe("Reloaded provider reply.");
      expect(message.json().provider).toMatchObject({
        name: "deepseek",
        capability: "chat",
        mock: false,
        model: "deepseek-chat"
      });
      expect(message.body).not.toContain("reload_deepseek_secret");

      const memoryUpdate = await app.inject({
        method: "POST",
        url: "/settings/runtime",
        payload: {
          values: {
            MEMORY_REPOSITORY: "postgres"
          }
        }
      });
      expect(memoryUpdate.statusCode).toBe(200);
      const memoryReload = await app.inject({ method: "POST", url: "/settings/runtime/reload" });
      expect(memoryReload.statusCode).toBe(200);
      expect(memoryReload.json().restartRequired).toBe(true);
      expect(memoryReload.json().notHotReloaded).toContain("MEMORY_REPOSITORY");
      expect(memoryReload.json().active.memoryRepository).toBe("in-memory");

      await app.close();
    } finally {
      fetchSpy.mockRestore();
      process.chdir(previousCwd);
      await rm(tempDir, { recursive: true, force: true });
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
