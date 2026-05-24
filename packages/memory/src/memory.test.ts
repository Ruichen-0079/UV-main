import { describe, expect, it } from "vitest";
import { parseMemoryRepositoryEnv } from "./env.js";
import {
  MissingDatabaseUrlError,
  parseDotEnv,
  readSqlMigrations,
  resolveDatabaseUrl
} from "./migrations.js";
import {
  InMemoryMemoryRepository,
  createMemoryRepositoryFromEnv,
  PostgresMemoryRepository
} from "./repository.js";
import { MemoryScorer } from "./scorer.js";
import { createMemoryDisplayText, extractSearchKeywords, MemoryService } from "./service.js";
import { LlmMemoryExtractor, RuleBasedMemoryExtractor } from "./extractor.js";

describe("MemoryRepository", () => {
  it("creates and retrieves memory records", async () => {
    const repository = new InMemoryMemoryRepository();
    const created = await repository.createMemory({
      type: "semantic",
      content: "The user is testing memory.",
      source: "test",
      metadata: { origin: "unit-test" },
      tags: ["test"]
    });

    const byId = await repository.getMemoryById(created.id);
    const recent = await repository.listRecentMemories(5);

    expect(byId?.content).toBe("The user is testing memory.");
    expect(byId?.subtype).toBeNull();
    expect(byId?.sourceTraceId).toBeNull();
    expect(byId?.metadata).toEqual({ origin: "unit-test" });
    expect(recent.map((memory) => memory.id)).toContain(created.id);
  });

  it("normalizes supported MEMORY_REPOSITORY values", () => {
    expect(parseMemoryRepositoryEnv({ MEMORY_REPOSITORY: "memory" }).kind).toBe("in-memory");
    expect(parseMemoryRepositoryEnv({ MEMORY_REPOSITORY: "in-memory" }).kind).toBe("in-memory");
    expect(parseMemoryRepositoryEnv({ MEMORY_REPOSITORY: "postgres" }).kind).toBe("postgres");
    expect(createMemoryRepositoryFromEnv({ MEMORY_REPOSITORY: "memory" }).kind).toBe("in-memory");
  });

  it("fails clearly for invalid MEMORY_REPOSITORY values", () => {
    expect(() => parseMemoryRepositoryEnv({ MEMORY_REPOSITORY: "sqlite" })).toThrow(/Valid values/);
  });

  it("assigns Memory Model v2 defaults for existing create paths", async () => {
    const repository = new InMemoryMemoryRepository();
    const created = await repository.createMemory({
      type: "semantic",
      subtype: "project",
      content: "用户正在开发 YUVI Runtime。",
      source: "test",
      tags: ["yuvi"]
    });

    expect(created).toMatchObject({
      scope: "project",
      scopeId: "yuvi-runtime",
      memoryLayer: "core",
      status: "active",
      supersedes: [],
      supersededBy: null,
      contradicts: []
    });
    expect(created.observedAt).toBeInstanceOf(Date);
    expect(created.validFrom).toBeInstanceOf(Date);
    expect(created.expiresAt).toBeNull();
  });

  it("updates and deletes in-memory memory records", async () => {
    const repository = new InMemoryMemoryRepository();
    const created = await repository.createMemory({
      type: "working",
      content: "Temporary memory.",
      source: "test",
      tags: ["draft"]
    });

    const updated = await repository.updateMemory(created.id, {
      type: "semantic",
      subtype: "fact",
      content: "Stable memory.",
      summary: "Stable summary.",
      importance: 0.9,
      emotionValence: 0.2,
      emotionArousal: 0.3,
      metadata: { edited: true },
      tags: ["stable"]
    });

    expect(updated).toMatchObject({
      id: created.id,
      type: "semantic",
      subtype: "fact",
      content: "Stable memory.",
      summary: "Stable summary.",
      importance: 0.9,
      emotionValence: 0.2,
      emotionArousal: 0.3,
      metadata: { edited: true },
      tags: ["stable"]
    });
    expect(updated?.createdAt).toEqual(created.createdAt);
    expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());

    await expect(repository.updateMemory("missing", { content: "nope" })).resolves.toBeNull();
    await expect(repository.deleteMemory(created.id)).resolves.toBe(true);
    await expect(repository.getMemoryById(created.id)).resolves.toBeNull();
    await expect(repository.deleteMemory(created.id)).resolves.toBe(false);
  });

  it("retrieves mixed Chinese and English memories from a natural-language turn", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository);
    await repository.createMemory({
      type: "semantic",
      content: "用户正在开发 YUVI Runtime，一个类 AIRI 的 AI Companion Runtime。",
      source: "test",
      tags: ["yuvi", "runtime"]
    });

    const memories = await service.retrieveRelevantMemories({
      text: "YUVI Runtime 是什么项目？",
      limit: 5
    });

    expect(memories.length).toBeGreaterThan(0);
    expect(memories[0]?.content).toContain("YUVI Runtime");
  });

  it("stores deterministic embedding metadata when an embedding provider is available", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository, undefined, undefined, undefined, {
      provider: createTestEmbeddingProvider()
    });

    const created = await service.createMemory({
      type: "semantic",
      content: "YUVI Runtime uses DeepSeek for chat.",
      summary: "YUVI provider choice.",
      source: "test",
      tags: ["yuvi", "deepseek"]
    });

    expect(created.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(created.embeddingProvider).toBe("mock-test");
    expect(created.embeddingModel).toBe("mock-test-model");
    expect(created.embeddingDimensions).toBe(3);
    expect(created.embeddedAt).toBeInstanceOf(Date);
  });

  it("stores memory without embedding if embedding generation fails", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository, undefined, undefined, undefined, {
      provider: createFailingEmbeddingProvider()
    });

    const created = await service.createMemory({
      type: "semantic",
      content: "YUVI Runtime survives embedding outages.",
      source: "test",
      tags: ["yuvi"]
    });

    expect(created.content).toContain("survives");
    expect(created.embedding).toBeNull();
    expect(created.embeddingProvider).toBeNull();
    expect(created.metadata["embeddingError"]).toContain("embedding unavailable");
    expect(created.metadata["embeddingError"]).toContain("provider=failing-test");

    const retrieved = await service.retrieveRelevantMemoriesWithMetadata({
      text: "embedding outages",
      limit: 5
    });
    expect(retrieved.memories[0]?.displayText).toContain("embedding outages");
    expect(retrieved.vectorEnabled).toBe(true);
    expect(retrieved.vectorUsed).toBe(false);
    expect(retrieved.fallbackUsed).toBe(true);
    expect(retrieved.fallbackReason).toContain("embedding unavailable");
  });

  it("does not store vectors when embedding dimensions mismatch", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository, undefined, undefined, undefined, {
      provider: createWrongDimensionEmbeddingProvider()
    });

    const created = await service.createMemory({
      type: "semantic",
      content: "YUVI Runtime avoids storing wrong-size vectors.",
      source: "test",
      tags: ["yuvi"]
    });

    expect(created.embedding).toBeNull();
    expect(created.embeddingProvider).toBeNull();
    expect(created.embeddingDimensions).toBeNull();
    expect(created.metadata["embeddingError"]).toContain("expectedDimensions=3");
    expect(created.metadata["embeddingError"]).not.toContain("Bearer");
  });

  it("regenerates embedding metadata when memory text changes", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository, undefined, undefined, undefined, {
      provider: createTestEmbeddingProvider()
    });
    const created = await service.createMemory({
      type: "semantic",
      content: "Old content",
      source: "test",
      tags: ["old"]
    });

    const updated = await service.updateMemory(created.id, {
      content: "New content for embedding regeneration.",
      tags: ["new"]
    });

    expect(updated?.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(updated?.embeddingProvider).toBe("mock-test");
    expect(updated?.embeddedAt).toBeInstanceOf(Date);
  });

  it("uses vector retrieval when configured but keeps exact keyword matches ranked first", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository, undefined, undefined, undefined, {
      provider: createTestEmbeddingProvider()
    });
    await service.createMemory({
      type: "semantic",
      subtype: "provider-choice",
      content: "用户偏好 Chat 和 Reasoning 使用 DeepSeek。",
      source: "manual",
      tags: ["provider", "deepseek"],
      importance: 0.9
    });
    await service.createMemory({
      type: "semantic",
      content: "A vague companion architecture preference.",
      source: "manual",
      tags: ["general"],
      importance: 0.2
    });

    const result = await service.retrieveRelevantMemoriesWithMetadata({
      text: "DeepSeek provider",
      limit: 5
    });

    expect(result.vectorEnabled).toBe(true);
    expect(result.vectorUsed).toBe(true);
    expect(result.queryEmbeddingGenerated).toBe(true);
    expect(result.vectorResultCount).toBeGreaterThan(0);
    expect(result.retrievalMode).toBe("in-memory-hybrid");
    expect(result.memories[0]?.displayText).toContain("DeepSeek");
    expect(result.memories[0]?.matchedBy).not.toBe("vector");
  });

  it("excludes non-active or temporally invalid memories from prompt retrieval", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository);
    await repository.createMemory({
      type: "semantic",
      content: "Active YUVI Runtime memory.",
      source: "test",
      tags: ["yuvi"]
    });
    await repository.createMemory({
      type: "semantic",
      content: "Forgotten YUVI Runtime memory.",
      source: "test",
      status: "forgotten",
      tags: ["yuvi"]
    });
    await repository.createMemory({
      type: "semantic",
      content: "Archived YUVI Runtime memory.",
      source: "test",
      status: "archived",
      tags: ["yuvi"]
    });
    await repository.createMemory({
      type: "semantic",
      content: "Superseded YUVI Runtime memory.",
      source: "test",
      status: "superseded",
      tags: ["yuvi"]
    });
    await repository.createMemory({
      type: "semantic",
      content: "Expired YUVI Runtime memory.",
      source: "test",
      expiresAt: new Date(Date.now() - 1000),
      tags: ["yuvi"]
    });
    await repository.createMemory({
      type: "semantic",
      content: "Future-valid YUVI Runtime memory.",
      source: "test",
      validFrom: new Date(Date.now() + 60_000),
      tags: ["yuvi"]
    });

    const result = await service.retrieveRelevantMemoriesWithMetadata({
      text: "YUVI Runtime",
      limit: 10
    });

    expect(result.memories.map((memory) => memory.displayText)).toEqual([
      "Active YUVI Runtime memory."
    ]);
    expect(result.excludedByStatus).toBeGreaterThanOrEqual(3);
    expect(result.excludedByTime).toBeGreaterThanOrEqual(2);
    expect(result.currentTime).toMatch(/T/);
  });

  it("supports scope-filtered retrieval", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository);
    await repository.createMemory({
      type: "semantic",
      content: "Project-scoped YUVI Runtime memory.",
      source: "test",
      scope: "project",
      scopeId: "yuvi-runtime"
    });
    await repository.createMemory({
      type: "semantic",
      content: "User-scoped YUVI Runtime memory.",
      source: "test",
      scope: "user"
    });

    const projectResult = await service.retrieveRelevantMemoriesWithMetadata({
      text: "YUVI Runtime",
      scope: "project",
      scopeId: "yuvi-runtime",
      limit: 10
    });

    expect(projectResult.memories).toHaveLength(1);
    expect(projectResult.memories[0]?.scope).toBe("project");
    expect(projectResult.memories[0]?.scopeId).toBe("yuvi-runtime");
  });

  it("excludes unrelated project scope memories while keeping matching project and session memory", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository);
    await repository.createMemory({
      type: "semantic",
      content: "YUVI Runtime uses DeepSeek for chat.",
      source: "test",
      scope: "project",
      scopeId: "yuvi-runtime"
    });
    await repository.createMemory({
      type: "semantic",
      content: "Other project uses a different provider.",
      source: "test",
      scope: "project",
      scopeId: "other-project",
      tags: ["provider"]
    });
    await repository.createMemory({
      type: "working",
      content: "This session is debugging Memory Read Pipeline v2.",
      source: "test",
      scope: "session",
      scopeId: "session-1"
    });

    const projectResult = await service.retrieveRelevantMemoriesWithMetadata({
      text: "provider",
      projectId: "yuvi-runtime",
      limit: 10
    });
    const sessionResult = await service.retrieveRelevantMemoriesWithMetadata({
      text: "Memory Read Pipeline",
      sessionId: "session-1",
      projectId: "yuvi-runtime",
      limit: 10
    });

    expect(projectResult.memories.map((memory) => memory.scopeId)).not.toContain("other-project");
    expect(projectResult.excludedByScope).toBeGreaterThan(0);
    expect(sessionResult.memories.some((memory) => memory.scope === "session")).toBe(true);
    expect(sessionResult.includedScopes).toContainEqual({
      scope: "session",
      scopeId: "session-1"
    });
  });

  it("allows archived memories only when manual search opts in", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository);
    await repository.createMemory({
      type: "semantic",
      content: "Archived YUVI Runtime provider decision.",
      source: "test",
      status: "archived",
      tags: ["yuvi"]
    });

    const defaultResult = await service.retrieveRelevantMemoriesWithMetadata({
      text: "YUVI Runtime",
      limit: 10
    });
    const includedResult = await service.retrieveRelevantMemoriesWithMetadata({
      text: "YUVI Runtime",
      includeArchived: true,
      limit: 10
    });

    expect(defaultResult.memories).toHaveLength(0);
    expect(defaultResult.excludedByStatus).toBe(1);
    expect(includedResult.memories).toHaveLength(1);
    expect(includedResult.memories[0]?.status).toBe("archived");
    expect(includedResult.includeArchived).toBe(true);
  });

  it("updates lastAccessedAt when a memory is selected", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository);
    const created = await repository.createMemory({
      type: "semantic",
      content: "YUVI Runtime prompt retrieval uses scoped memory.",
      source: "test",
      tags: ["yuvi"]
    });
    const before = created.lastAccessedAt.getTime();
    await new Promise((resolve) => setTimeout(resolve, 2));

    const result = await service.retrieveRelevantMemoriesWithMetadata({
      text: "scoped memory",
      limit: 5
    });
    const after = await repository.getMemoryById(created.id);

    expect(result.memories[0]?.id).toBe(created.id);
    expect(after?.lastAccessedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("deduplicates display-equivalent memories and prefers semantic memory", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository);
    const content = "用户正在开发 YUVI Runtime，一个类 AIRI 的 AI Companion Runtime。";
    await repository.createMemory({
      type: "working",
      content,
      importance: 1,
      source: "test",
      scope: "project",
      scopeId: "yuvi-runtime"
    });
    await repository.createMemory({
      type: "semantic",
      content: `" ${content} "`,
      importance: 0.5,
      source: "test"
    });

    const result = await service.retrieveRelevantMemoriesWithMetadata({
      text: "YUVI Runtime 是什么项目？",
      limit: 5
    });

    expect(result.retrievalMode).toBe("in-memory-keyword");
    expect(result.rawCount).toBeGreaterThan(1);
    expect(result.count).toBe(1);
    expect(result.memories[0]?.type).toBe("semantic");
    expect(result.memories[0]?.displayText).toBe(content);
    expect(result.rawMemories.some((memory) => memory.excludedReason?.startsWith("deduped"))).toBe(
      true
    );
  });

  it("ranks concise semantic memories ahead of verbose runtime episodic memories", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository);
    await repository.createMemory({
      type: "episodic",
      content: [
        "User intent: YUVI Runtime 是什么项目？",
        `Assistant response summary: ${"This was a long generated answer. ".repeat(30)}`
      ].join("\n"),
      importance: 1,
      source: "runtime"
    });
    await repository.createMemory({
      type: "semantic",
      content: "用户正在开发 YUVI Runtime，一个类 AIRI 的 AI Companion Runtime。",
      importance: 0.4,
      source: "manual"
    });

    const result = await service.retrieveRelevantMemoriesWithMetadata({
      text: "YUVI Runtime 是什么项目？",
      limit: 5
    });

    expect(result.memories[0]?.type).toBe("semantic");
    expect(result.memories[0]?.displayText).toContain("AI Companion Runtime");
  });

  it("normalizes noisy display text without mutating stored content", async () => {
    const repository = new InMemoryMemoryRepository();
    const stored = await repository.createMemory({
      type: "semantic",
      content: "“  - - 用户偏好 DeepSeek。\n\n\n  ”",
      source: "test"
    });

    expect(createMemoryDisplayText(stored)).toBe("用户偏好 DeepSeek。");
    expect(stored.content).toContain("“");
    expect(stored.content).toContain("- -");
  });

  it("searches memory tags and metadata through the local repository fallback", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository);
    await repository.createMemory({
      type: "semantic",
      subtype: "project",
      content: "A stable project memory.",
      source: "dashboard",
      metadata: { project: "YUVI Runtime" },
      tags: ["项目", "runtime"]
    });

    const tagResult = await service.retrieveRelevantMemoriesWithMetadata({
      text: "项目",
      limit: 5
    });
    const metadataResult = await service.retrieveRelevantMemoriesWithMetadata({
      text: "YUVI",
      limit: 5
    });

    expect(tagResult.count).toBeGreaterThan(0);
    expect(metadataResult.count).toBeGreaterThan(0);
    expect(metadataResult.memories[0]?.metadata).toMatchObject({ project: "YUVI Runtime" });
  });

  it("returns retrieval debug metadata for summary, tag, command, and path matches", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository);
    await repository.createMemory({
      type: "semantic",
      subtype: "project",
      content: "A concise project fact.",
      summary: "YUVI Runtime is an AI Companion Runtime.",
      source: "manual",
      tags: ["runtime"]
    });
    await repository.createMemory({
      type: "procedural",
      subtype: "command",
      content: "Run pnpm db:migrate before Postgres smoke tests.",
      source: "manual",
      tags: ["command"]
    });
    await repository.createMemory({
      type: "semantic",
      subtype: "path",
      content: "Windows source path is C:\\Users\\Administrator.DESKTOP-NPU6DHJ\\Desktop\\uv-main.",
      source: "manual",
      tags: ["path"]
    });

    const summaryResult = await service.retrieveRelevantMemoriesWithMetadata({
      text: "AI Companion Runtime",
      limit: 5
    });
    const tagResult = await service.retrieveRelevantMemoriesWithMetadata({
      text: "command",
      limit: 5
    });
    const commandResult = await service.retrieveRelevantMemoriesWithMetadata({
      text: "pnpm db:migrate",
      limit: 5
    });
    const pathResult = await service.retrieveRelevantMemoriesWithMetadata({
      text: "C:\\Users\\Administrator.DESKTOP-NPU6DHJ\\Desktop\\uv-main",
      limit: 5
    });

    expect(summaryResult.memories[0]).toMatchObject({ matchedBy: "summary" });
    expect(summaryResult.retrievalMode).toBe("in-memory-keyword");
    expect(summaryResult.memories[0]?.score).toBeGreaterThan(0);
    expect(tagResult.memories[0]?.matchedBy).toBe("tag");
    expect(commandResult.memories[0]?.displayText).toContain("pnpm db:migrate");
    expect(pathResult.memories[0]?.displayText).toContain("Administrator.DESKTOP-NPU6DHJ");
  });

  it("supports Postgres Search v2 filter shape in the in-memory fallback", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository);
    await repository.createMemory({
      type: "semantic",
      subtype: "provider-choice",
      scope: "project",
      scopeId: "yuvi-runtime",
      memoryLayer: "core",
      status: "active",
      content: "用户偏好 Chat 和 Reasoning 使用 DeepSeek。",
      source: "dashboard",
      tags: ["provider", "deepseek"],
      importance: 0.9
    });
    await repository.createMemory({
      type: "procedural",
      subtype: "command",
      scope: "project",
      scopeId: "yuvi-runtime",
      memoryLayer: "recall",
      status: "active",
      content: "Run pnpm db:migrate before Postgres smoke tests.",
      source: "manual",
      tags: ["command", "postgres"],
      importance: 0.7
    });
    await repository.createMemory({
      type: "semantic",
      subtype: "path",
      scope: "user",
      memoryLayer: "core",
      status: "active",
      content: "Windows source path is C:\\Users\\Administrator.DESKTOP-NPU6DHJ\\Desktop\\uv-main.",
      source: "manual",
      tags: ["path"],
      importance: 0.8
    });
    await repository.createMemory({
      type: "episodic",
      subtype: "milestone",
      scope: "project",
      scopeId: "other-project",
      memoryLayer: "recall",
      status: "archived",
      content: "Other project archived milestone.",
      source: "runtime",
      tags: ["provider"],
      importance: 1
    });

    const providerResult = await service.retrieveRelevantMemoriesWithMetadata({
      text: "DashScope STT DeepSeek provider",
      subtypes: ["provider-choice"],
      memoryLayers: ["core"],
      statuses: ["active"],
      sources: ["dashboard"],
      tags: ["provider"],
      minImportance: 0.8,
      projectId: "yuvi-runtime",
      limit: 5
    });
    const commandResult = await service.retrieveRelevantMemoriesWithMetadata({
      text: "pnpm db:migrate",
      subtypes: ["command"],
      tags: ["command"],
      projectId: "yuvi-runtime",
      limit: 5
    });
    const pathResult = await service.retrieveRelevantMemoriesWithMetadata({
      text: "C:\\Users\\Administrator.DESKTOP-NPU6DHJ\\Desktop\\uv-main",
      subtypes: ["path"],
      limit: 5
    });
    const archivedDefault = await service.retrieveRelevantMemoriesWithMetadata({
      text: "archived milestone",
      statuses: ["archived"],
      limit: 5
    });
    const archivedIncluded = await service.retrieveRelevantMemoriesWithMetadata({
      text: "archived milestone",
      statuses: ["archived"],
      includeArchived: true,
      includeSuperseded: true,
      includeExpired: true,
      projectId: "other-project",
      limit: 5
    });

    expect(providerResult.memories).toHaveLength(1);
    expect(providerResult.memories[0]).toMatchObject({
      subtype: "provider-choice",
      source: "dashboard"
    });
    expect(["content", "tag"]).toContain(providerResult.memories[0]?.matchedBy);
    expect(commandResult.memories[0]).toMatchObject({ subtype: "command" });
    expect(pathResult.memories[0]?.displayText).toContain("Administrator.DESKTOP-NPU6DHJ");
    expect(archivedDefault.memories).toHaveLength(0);
    expect(archivedIncluded.memories[0]).toMatchObject({ status: "archived" });
  });

  it("scores only durable memory-worthy interactions highly", () => {
    const scorer = new MemoryScorer();

    expect(scorer.scoreImportance("hi")).toBe(0);
    expect(scorer.scoreImportance("What is TypeScript?")).toBe(0);
    expect(scorer.scoreImportance("What is the current repo? I cannot determine the answer.")).toBe(
      0
    );
    expect(scorer.scoreImportance("记住：用户偏好 Chat 使用 DeepSeek。")).toBeGreaterThan(0.9);
    expect(
      scorer.scoreImportance("用户偏好 Chat/Reasoning 使用 DeepSeek，TTS 使用 xAI。")
    ).toBeGreaterThanOrEqual(0.8);
    expect(scorer.scoreImportance("项目里程碑：Dashboard provider observability 已完成。")).toBe(
      0.75
    );
  });

  it("stores runtime source trace and subtype metadata", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository);

    const memory = await service.rememberInteraction({
      userMessage: "记住：用户偏好 Chat 使用 DeepSeek。",
      assistantMessage: "OK",
      source: "runtime",
      sourceTraceId: "trace-123"
    });

    expect(memory).toMatchObject({
      type: "semantic",
      subtype: "provider-choice",
      source: "runtime",
      sourceTraceId: "trace-123"
    });
    expect(memory?.metadata).toMatchObject({
      generatedBy: "rule-based-memory-extractor",
      reason: expect.any(String)
    });
  });

  it("does not store ordinary interactions without extractor candidates", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository);

    const memory = await service.rememberInteraction({
      userMessage: "What is TypeScript?",
      assistantMessage: "TypeScript is JavaScript with types.",
      source: "runtime",
      sourceTraceId: "trace-ordinary"
    });

    expect(memory).toBeNull();
    await expect(repository.listRecentMemories()).resolves.toEqual([]);
  });

  it("extracts explicit remembered project paths as semantic path memories", async () => {
    const extractor = new RuleBasedMemoryExtractor();

    const candidates = await extractor.extractCandidates({
      userMessage: "记住：我的项目路径是 /home/administrator/uv-main/uv-main",
      sourceTraceId: "trace-path"
    });

    expect(candidates).toEqual([
      expect.objectContaining({
        type: "semantic",
        subtype: "path",
        content: "我的项目路径是 /home/administrator/uv-main/uv-main",
        importance: expect.any(Number),
        sourceTraceId: "trace-path"
      })
    ]);
    expect(candidates[0]?.importance).toBeGreaterThanOrEqual(0.9);
  });

  it("extracts provider preferences as provider-choice memories", async () => {
    const extractor = new RuleBasedMemoryExtractor();

    const candidates = await extractor.extractCandidates({
      userMessage: "以后 chat 用 DeepSeek，TTS 用 xAI"
    });

    expect(candidates).toContainEqual(
      expect.objectContaining({
        type: "semantic",
        subtype: "provider-choice",
        reason: "provider-choice"
      })
    );
  });

  it("classifies ordinary relative-time daily events as rejected episodic candidates", async () => {
    const extractor = new RuleBasedMemoryExtractor();
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository, undefined, undefined, extractor);

    const candidates = await extractor.extractCandidates({
      userMessage: "我今早吃了芒果蛋糕",
      timestamp: "2026-05-23T02:00:00.000Z",
      sourceTraceId: "trace-mango"
    });
    const result = await service.processCandidateForStorage(candidates[0]!, {
      source: "runtime",
      tags: ["session-1"]
    });

    expect(candidates[0]).toMatchObject({
      type: "episodic",
      subtype: "event",
      memoryLayer: "recall"
    });
    expect(result.decision).toBe("rejected");
    expect(result.rejectedReason).toBe("ordinary one-off daily event");
    expect(result.candidate.content).toContain("2026-05-23");
    expect(result.candidate.content).not.toContain("今早");
    expect(result.candidate.importance).toBeLessThan(0.65);
    expect(result.candidate.eventTime).toBeTruthy();
    expect(result.candidate.validFrom).toBeTruthy();
    expect(result.candidate.validUntil).toBeTruthy();
    expect(result.candidate.metadata).toMatchObject({
      originalTemporalText: "我今早吃了芒果蛋糕",
      temporalResolution: {
        relativeExpression: "今早",
        resolvedDate: "2026-05-23"
      }
    });
    await expect(repository.listRecentMemories()).resolves.toEqual([]);
  });

  it("stores explicit remembered daily events as time-bound episodic recall memories", async () => {
    const extractor = new RuleBasedMemoryExtractor();
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository, undefined, undefined, extractor);
    const candidates = await extractor.extractCandidates({
      userMessage: "记住：我今早吃了芒果蛋糕",
      timestamp: "2026-05-23T02:00:00.000Z",
      sourceTraceId: "trace-explicit-mango"
    });

    const result = await service.processCandidateForStorage(candidates[0]!, {
      source: "runtime",
      tags: ["session-1"]
    });

    expect(result.decision).toBe("stored");
    expect(result.memory).toMatchObject({
      type: "episodic",
      subtype: "event",
      memoryLayer: "recall",
      sourceTraceId: "trace-explicit-mango"
    });
    expect(result.memory?.content).toContain("2026-05-23");
    expect(result.memory?.content).not.toContain("今早");
    expect(result.memory?.importance).toBeLessThan(0.65);
    expect(result.memory?.eventTime?.toISOString()).toContain("2026-05-23");
    expect(result.memory?.validFrom.toISOString()).toContain("2026-05-23");
    expect(result.memory?.validUntil?.toISOString()).toContain("2026-05-23");
    expect(result.memory?.expiresAt?.toISOString()).toContain("2026-05-30");
  });

  it("keeps stable mango cake preferences semantic core memories", async () => {
    const extractor = new RuleBasedMemoryExtractor();
    const candidates = await extractor.extractCandidates({
      userMessage: "我喜欢芒果蛋糕",
      timestamp: "2026-05-23T02:00:00.000Z"
    });

    expect(candidates).toContainEqual(
      expect.objectContaining({
        type: "semantic",
        subtype: "preference",
        memoryLayer: "core"
      })
    );
  });

  it("excludes stale episodic memories from normal retrieval but allows historical episodic lookup", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository);
    await repository.createMemory({
      type: "episodic",
      subtype: "event",
      memoryLayer: "recall",
      content: "用户在 2026-05-23 早上吃了芒果蛋糕。",
      source: "test",
      tags: ["meal"],
      observedAt: "2026-05-23T02:00:00.000Z",
      eventTime: "2026-05-23T08:00:00.000Z",
      validFrom: "2026-05-23T08:00:00.000Z",
      validUntil: "2026-05-23T23:59:59.999Z",
      expiresAt: "2026-05-30T02:00:00.000Z"
    });
    await repository.createMemory({
      type: "episodic",
      subtype: "event",
      memoryLayer: "recall",
      status: "forgotten",
      content: "用户在 2026-05-23 晚上吃了芒果蛋糕秘密甜点。",
      source: "test",
      tags: ["meal"],
      validUntil: "2026-05-23T23:59:59.999Z",
      expiresAt: "2026-05-30T02:00:00.000Z"
    });

    const normal = await service.retrieveRelevantMemoriesWithMetadata({
      text: "芒果蛋糕",
      currentTime: "2026-06-02T00:00:00.000Z",
      limit: 5
    });
    const historical = await service.retrieveRelevantMemoriesWithMetadata({
      text: "之前吃过什么芒果蛋糕",
      includeHistoricalEpisodic: true,
      currentTime: "2026-06-02T00:00:00.000Z",
      limit: 5
    });

    expect(normal.memories).toHaveLength(0);
    expect(normal.excludedByTime).toBeGreaterThan(0);
    expect(historical.memories).toHaveLength(1);
    expect(historical.memories[0]?.displayText).toContain("芒果蛋糕");
    expect(historical.rawMemories.some((memory) => memory.status === "forgotten")).toBe(true);
    expect(historical.memories.some((memory) => memory.status === "forgotten")).toBe(false);
  });

  it("rejects low-confidence temporal normalization instead of rewriting aggressively", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository);
    const result = await service.processCandidateForStorage({
      type: "episodic",
      subtype: "event",
      memoryLayer: "recall",
      content: "最近我看了电影",
      importance: 0.5,
      tags: ["activity"],
      reason: "ordinary-one-off-daily-event",
      observedAt: "2026-05-23T02:00:00.000Z"
    });

    expect(result.decision).toBe("rejected");
    expect(result.rejectedReason).toBe("low-confidence temporal resolution");
    expect(result.candidate.content).toContain("最近");
    expect(result.candidate.metadata).toMatchObject({
      temporalResolution: {
        relativeExpression: "最近",
        confidence: 0.55
      }
    });
  });

  it("auto-supersedes provider preferences in the same project scope", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository);
    const old = await repository.createMemory({
      type: "semantic",
      subtype: "provider-choice",
      scope: "project",
      scopeId: "yuvi-runtime",
      memoryLayer: "core",
      content: "用户偏好 Chat provider 使用 OpenAI。",
      source: "test",
      tags: ["provider", "chat", "openai"],
      importance: 0.9
    });

    const result = await service.processCandidateForStorage({
      type: "semantic",
      subtype: "provider-choice",
      scope: "project",
      scopeId: "yuvi-runtime",
      memoryLayer: "core",
      content: "用户偏好 Chat provider 使用 DeepSeek。",
      importance: 0.9,
      tags: ["provider", "chat", "deepseek"],
      reason: "provider-choice"
    });

    expect(result.decision).toBe("stored");
    expect(result.candidate.possibleSupersedes).toContain(old.id);
    expect(result.candidate.relationshipConfidence).toBeGreaterThanOrEqual(0.9);
    expect(result.memory?.supersedes).toContain(old.id);
    const superseded = await repository.getMemoryById(old.id);
    expect(superseded).toMatchObject({
      status: "superseded",
      supersededBy: result.memory?.id
    });
    expect(superseded?.supersededAt).toBeInstanceOf(Date);
  });

  it("auto-supersedes project paths in the same project scope only", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository);
    const sameProjectOld = await repository.createMemory({
      type: "semantic",
      subtype: "path",
      scope: "project",
      scopeId: "yuvi-runtime",
      memoryLayer: "core",
      content: "项目路径是 C:\\old-path",
      source: "test",
      tags: ["path", "project"],
      importance: 0.9
    });
    const otherProjectOld = await repository.createMemory({
      type: "semantic",
      subtype: "path",
      scope: "project",
      scopeId: "other-project",
      memoryLayer: "core",
      content: "项目路径是 C:\\other-old-path",
      source: "test",
      tags: ["path", "project"],
      importance: 0.9
    });

    const result = await service.processCandidateForStorage({
      type: "semantic",
      subtype: "path",
      scope: "project",
      scopeId: "yuvi-runtime",
      memoryLayer: "core",
      content: "项目路径改为 C:\\Users\\Administrator.DESKTOP-NPU6DHJ\\Desktop\\uv-main",
      importance: 0.9,
      tags: ["path", "project"],
      reason: "project-path"
    });

    expect(result.decision).toBe("stored");
    expect(result.candidate.possibleSupersedes).toContain(sameProjectOld.id);
    expect(result.candidate.possibleSupersedes).not.toContain(otherProjectOld.id);
    expect((await repository.getMemoryById(sameProjectOld.id))?.status).toBe("superseded");
    expect((await repository.getMemoryById(otherProjectOld.id))?.status).toBe("active");
  });

  it("suggests but does not auto-apply safety-sensitive contradictions", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository);
    const old = await repository.createMemory({
      type: "semantic",
      subtype: "fact",
      scope: "user",
      memoryLayer: "core",
      content: "用户对芒果过敏。",
      source: "test",
      tags: ["health", "allergy"],
      importance: 0.9
    });

    const result = await service.processCandidateForStorage({
      type: "semantic",
      subtype: "fact",
      scope: "user",
      memoryLayer: "core",
      content: "用户不过敏芒果。",
      importance: 0.9,
      tags: ["health", "allergy"],
      reason: "health-note"
    });

    expect(result.decision).toBe("stored");
    expect(result.candidate.possibleContradictions).toContain(old.id);
    expect(result.memory?.supersedes).not.toContain(old.id);
    expect(result.memory?.contradicts).toContain(old.id);
    expect((await repository.getMemoryById(old.id))?.status).toBe("active");
  });

  it("keeps superseded memories out of normal retrieval but available in historical search", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository);
    const old = await repository.createMemory({
      type: "semantic",
      subtype: "provider-choice",
      scope: "project",
      scopeId: "yuvi-runtime",
      memoryLayer: "core",
      content: "用户偏好 Chat provider 使用 OpenAI。",
      source: "test",
      tags: ["provider", "chat", "openai"],
      importance: 0.9
    });
    await service.processCandidateForStorage({
      type: "semantic",
      subtype: "provider-choice",
      scope: "project",
      scopeId: "yuvi-runtime",
      memoryLayer: "core",
      content: "用户偏好 Chat provider 使用 DeepSeek。",
      importance: 0.9,
      tags: ["provider", "chat", "deepseek"],
      reason: "provider-choice"
    });

    const normal = await service.retrieveRelevantMemoriesWithMetadata({
      text: "Chat provider",
      scope: "project",
      scopeId: "yuvi-runtime",
      limit: 10
    });
    const historical = await service.retrieveRelevantMemoriesWithMetadata({
      text: "Chat provider",
      scope: "project",
      scopeId: "yuvi-runtime",
      includeSuperseded: true,
      limit: 10
    });

    expect(normal.memories.map((memory) => memory.id)).not.toContain(old.id);
    expect(normal.rawMemories.some((memory) => memory.id === old.id)).toBe(true);
    expect(historical.memories.map((memory) => memory.id)).toContain(old.id);
    expect(JSON.stringify(historical)).not.toContain("secret");
  });

  it("extracts startup commands, config decisions, and troubleshooting conclusions", async () => {
    const extractor = new RuleBasedMemoryExtractor();

    await expect(
      extractor.extractCandidates({
        userMessage: "以后启动开发环境使用命令 pnpm dev"
      })
    ).resolves.toContainEqual(
      expect.objectContaining({
        type: "procedural",
        subtype: "command",
        reason: "command-or-startup-instruction"
      })
    );

    await expect(
      extractor.extractCandidates({
        userMessage: "默认使用 SERVER_PORT=6121 作为本地开发端口"
      })
    ).resolves.toContainEqual(
      expect.objectContaining({
        type: "semantic",
        subtype: "preference"
      })
    );

    await expect(
      extractor.extractCandidates({
        userMessage: "排错结论：Memory action failed 的原因是 DELETE 请求带了空 JSON body"
      })
    ).resolves.toContainEqual(
      expect.objectContaining({
        type: "procedural",
        subtype: "troubleshooting",
        reason: "troubleshooting-conclusion"
      })
    );
  });

  it("does not extract trivial greetings or ordinary questions", async () => {
    const extractor = new RuleBasedMemoryExtractor();

    await expect(extractor.extractCandidates({ userMessage: "hi" })).resolves.toEqual([]);
    await expect(
      extractor.extractCandidates({ userMessage: "What is TypeScript?" })
    ).resolves.toEqual([]);
    await expect(
      extractor.extractCandidates({
        userMessage: "What is the current project path?",
        assistantMessage: "I cannot determine the answer because I lack context."
      })
    ).resolves.toEqual([]);
  });

  it("extracts project milestones as episodic milestone memories", async () => {
    const extractor = new RuleBasedMemoryExtractor();

    const candidates = await extractor.extractCandidates({
      userMessage: "项目里程碑：Dashboard provider observability 已完成，并且 validation passed"
    });

    expect(candidates).toContainEqual(
      expect.objectContaining({
        type: "episodic",
        subtype: "milestone",
        reason: "project-milestone"
      })
    );
  });

  it("extracts validated LLM memory candidates from strict JSON", async () => {
    let calls = 0;
    const extractor = new LlmMemoryExtractor(
      {
        async generateReasoning() {
          calls += 1;
          return {
            reasoning: JSON.stringify({
              candidates: [
                {
                  type: "semantic",
                  subtype: "provider-choice",
                  content: "用户偏好 chat 使用 DeepSeek。",
                  summary: "用户偏好 chat 使用 DeepSeek。",
                  importance: 0.86,
                  confidence: 0.91,
                  tags: ["deepseek", "provider-choice"],
                  reason: "provider preference",
                  sourceTraceId: "trace-llm"
                }
              ]
            })
          };
        }
      },
      new RuleBasedMemoryExtractor(),
      { enabled: true, providerConfigured: true, providerName: "deepseek" }
    );

    const candidates = await extractor.extractCandidates({
      userMessage: "以后 chat 用 DeepSeek",
      sourceTraceId: "trace-fallback"
    });

    expect(candidates).toEqual([
      expect.objectContaining({
        type: "semantic",
        subtype: "provider-choice",
        content: "用户偏好 chat 使用 DeepSeek。",
        importance: 0.86,
        reason: "provider preference",
        sourceTraceId: "trace-llm"
      })
    ]);
    expect(calls).toBe(1);
    expect(extractor.getStatus()).toMatchObject({
      mode: "llm",
      active: "llm",
      provider: "deepseek",
      fallbackUsed: false,
      candidateCount: 1
    });
  });

  it("recovers common LLM JSON formatting variants", async () => {
    const outputs = [
      '```json\n{"candidates":[{"type":"semantic","subtype":"provider-choice","content":"用户偏好 Chat 和 Reasoning 使用 DeepSeek。","summary":"用户偏好 DeepSeek。","importance":"0.9","tags":["deepseek"],"reason":"provider preference"}]}\n```',
      'Here is the JSON:\n{"candidates":[{"type":"fact","content":"用户正在开发 YUVI Runtime。","summary":"用户正在开发 YUVI Runtime。","importance":0.8,"confidence":0.8,"tags":["yuvi"],"reason":"project fact"}]}',
      '[{"type":"preference","content":"用户偏好简洁的调试输出。","summary":"用户偏好简洁调试输出。","importance":0.82,"confidence":0.8,"tags":["preference"],"reason":"stable preference"}]',
      '{"memories":[{"type":"procedure","content":"启动开发环境使用 ./scripts/dev.sh。","summary":"使用 dev.sh 启动开发环境。","importance":0.83,"confidence":0.8,"tags":["command"],"reason":"startup command"}]}'
    ];

    for (const output of outputs) {
      const extractor = createLlmExtractor(output);
      const candidates = await extractor.extractCandidates({
        userMessage: "记住：以后 chat 用 DeepSeek",
        sourceTraceId: "trace-format"
      });

      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.importance).toBeGreaterThanOrEqual(0.8);
      expect(candidates[0]?.confidence).toBeGreaterThanOrEqual(0.7);
      expect(extractor.getStatus()).toMatchObject({
        active: "llm",
        fallbackUsed: false
      });
    }
  });

  it("rejects unsafe or malformed LLM candidates without storing them", async () => {
    const extractor = createLlmExtractor({
      candidates: [
        {
          type: "unknown",
          content: "用户偏好 Chat 使用 DeepSeek。",
          summary: "用户偏好 DeepSeek。",
          importance: 0.9,
          confidence: 0.9,
          tags: [],
          reason: "unknown type"
        },
        {
          type: "semantic",
          subtype: "fact",
          content: "",
          summary: "empty",
          importance: 0.9,
          confidence: 0.9,
          tags: [],
          reason: "empty content"
        },
        {
          type: "semantic",
          subtype: "fact",
          content: "用户偏好 Chat 使用 DeepSeek。",
          summary: "用户偏好 DeepSeek。",
          importance: 0.9,
          confidence: 0.9,
          tags: [],
          metadata: { apiKey: "sk-secret-value" },
          reason: "unsafe metadata"
        }
      ]
    });

    const candidates = await extractor.extractCandidates({
      userMessage: "What should be remembered?",
      sourceTraceId: "trace-invalid-candidates"
    });

    expect(candidates).toEqual([]);
    expect(extractor.getStatus().rejectedCount).toBe(3);
    expect(extractor.getStatus().validationIssues?.join("\n")).not.toContain("sk-secret-value");
  });

  it("rejects low-confidence LLM memory candidates", async () => {
    const extractor = new LlmMemoryExtractor(
      {
        async generateReasoning() {
          return {
            reasoning: JSON.stringify({
              candidates: [
                {
                  type: "semantic",
                  subtype: "fact",
                  content: "Maybe this ordinary answer matters.",
                  summary: "Maybe this ordinary answer matters.",
                  importance: 0.9,
                  confidence: 0.2,
                  tags: [],
                  reason: "uncertain"
                }
              ]
            })
          };
        }
      },
      new RuleBasedMemoryExtractor(),
      { enabled: true, providerConfigured: true, providerName: "deepseek" }
    );

    await expect(
      extractor.extractCandidates({ userMessage: "What is TypeScript?" })
    ).resolves.toEqual([]);
  });

  it("falls back to rule-based extraction when LLM output is invalid JSON", async () => {
    const extractor = new LlmMemoryExtractor(
      {
        async generateReasoning() {
          return {
            reasoning: "not json with apiKey=sk-secret-value"
          };
        }
      },
      new RuleBasedMemoryExtractor(),
      { enabled: true, providerConfigured: true, providerName: "deepseek" }
    );

    const candidates = await extractor.extractCandidates({
      userMessage: "记住：我的项目路径是 /home/administrator/uv-main/uv-main",
      sourceTraceId: "trace-rule"
    });

    expect(candidates).toContainEqual(
      expect.objectContaining({
        type: "semantic",
        subtype: "path",
        sourceTraceId: "trace-rule"
      })
    );
    expect(extractor.getStatus()).toMatchObject({
      active: "fallback-rule-based",
      fallbackUsed: true,
      rejectedReasons: ["invalid-llm-output"],
      skippedReason: "LLM extractor output was invalid; falling back to rule-based extraction."
    });
    expect(extractor.getStatus().rawPreview).toContain("apiKey=[redacted]");
    expect(extractor.getStatus().rawPreview).not.toContain("sk-secret-value");
  });

  it("falls back to rule-based extraction when the reasoning provider call fails", async () => {
    const extractor = new LlmMemoryExtractor(
      {
        async generateReasoning() {
          throw new Error("network unavailable with sk-secret");
        }
      },
      new RuleBasedMemoryExtractor(),
      { enabled: true, providerConfigured: true, providerName: "deepseek" }
    );

    const candidates = await extractor.extractCandidates({
      userMessage: "记住：我的项目路径是 /home/administrator/uv-main/uv-main",
      sourceTraceId: "trace-rule"
    });

    expect(candidates).toContainEqual(
      expect.objectContaining({
        type: "semantic",
        subtype: "path",
        sourceTraceId: "trace-rule"
      })
    );
    expect(extractor.getStatus()).toMatchObject({
      active: "fallback-rule-based",
      fallbackUsed: true
    });
    expect(extractor.getStatus().error).not.toContain("sk-secret");
  });

  it("does not call the reasoning provider unless LLM extraction is explicitly enabled", async () => {
    let calls = 0;
    const extractor = new LlmMemoryExtractor(
      {
        async generateReasoning() {
          calls += 1;
          throw new Error("should not be called");
        }
      },
      new RuleBasedMemoryExtractor()
    );

    const candidates = await extractor.extractCandidates({
      userMessage: "记住：以后 chat 用 DeepSeek",
      sourceTraceId: "trace-disabled-llm"
    });

    expect(calls).toBe(0);
    expect(extractor.getStatus()).toMatchObject({
      mode: "llm",
      active: "fallback-rule-based",
      enabled: false
    });
    expect(candidates).toContainEqual(
      expect.objectContaining({
        subtype: "provider-choice",
        sourceTraceId: "trace-disabled-llm"
      })
    );
  });

  it("falls back without calling the reasoning provider when it is not configured", async () => {
    let calls = 0;
    const extractor = new LlmMemoryExtractor(
      {
        async generateReasoning() {
          calls += 1;
          throw new Error("should not be called");
        }
      },
      new RuleBasedMemoryExtractor(),
      { enabled: true, providerConfigured: false, providerName: "deepseek" }
    );

    const candidates = await extractor.extractCandidates({
      userMessage: "以后 chat 用 DeepSeek",
      sourceTraceId: "trace-unconfigured"
    });

    expect(calls).toBe(0);
    expect(extractor.getStatus()).toMatchObject({
      active: "fallback-rule-based",
      fallbackUsed: true,
      skippedReason: "Reasoning provider is not configured; falling back to rule-based extraction."
    });
    expect(candidates).toContainEqual(
      expect.objectContaining({
        subtype: "provider-choice",
        sourceTraceId: "trace-unconfigured"
      })
    );
  });

  it("extracts useful keywords from mixed Chinese and English input", () => {
    expect(extractSearchKeywords("YUVI Runtime 是什么项目？")).toEqual(
      expect.arrayContaining(["yuvi", "runtime", "项目"])
    );
  });

  it("uses in-memory storage by default unless postgres is explicit", () => {
    expect(createMemoryRepositoryFromEnv({ DATABASE_URL: "postgres://example" })).toBeInstanceOf(
      InMemoryMemoryRepository
    );
    expect(
      createMemoryRepositoryFromEnv({
        MEMORY_REPOSITORY: "postgres",
        DATABASE_URL: "postgres://example"
      })
    ).toBeInstanceOf(PostgresMemoryRepository);
    expect(() => createMemoryRepositoryFromEnv({ MEMORY_REPOSITORY: "postgres" })).toThrow(
      "DATABASE_URL"
    );
  });

  it("resolves DATABASE_URL from process env or .env text without printing it", () => {
    expect(
      resolveDatabaseUrl(
        { DATABASE_URL: "postgres://from-env" },
        "DATABASE_URL=postgres://from-file"
      )
    ).toBe("postgres://from-env");
    expect(resolveDatabaseUrl({}, "DATABASE_URL=postgres://from-file")).toBe(
      "postgres://from-file"
    );
    expect(parseDotEnv("# comment\nDATABASE_URL='postgres://quoted'\n")).toEqual({
      DATABASE_URL: "postgres://quoted"
    });
    expect(() => resolveDatabaseUrl({})).toThrow(MissingDatabaseUrlError);
  });

  it("ships idempotent PostgreSQL migration SQL", async () => {
    const migrations = await readSqlMigrations();
    const combinedSql = migrations
      .map((migration) => migration.sql)
      .join("\n")
      .toLowerCase();

    expect(combinedSql).toContain("create extension if not exists vector");
    expect(combinedSql).toContain("create extension if not exists pg_trgm");
    expect(combinedSql).toContain("metadata jsonb");
    expect(combinedSql).toContain("troubleshooting");
    expect(combinedSql).toContain("config");
    expect(combinedSql).toContain("create table if not exists memories");
    expect(combinedSql).toContain("create table if not exists entities");
    expect(combinedSql).toContain("create table if not exists relations");
    expect(combinedSql).toContain("memories_summary_trgm_idx");
    expect(combinedSql).toContain("memories_metadata_idx");
    expect(combinedSql).toContain("memories_subtype_idx");
    expect(combinedSql).toContain("memories_source_trace_id_idx");
    expect(combinedSql).toContain("memories_created_at_idx");
    expect(combinedSql).toContain("scope text not null default 'user'");
    expect(combinedSql).toContain("memory_layer text not null default 'recall'");
    expect(combinedSql).toContain("status text not null default 'active'");
    expect(combinedSql).toContain("valid_until");
    expect(combinedSql).toContain("expires_at");
    expect(combinedSql).toContain("superseded_by");
    expect(combinedSql).toContain("memories_scope_scope_id_idx");
    expect(combinedSql).toContain("memories_memory_layer_idx");
    expect(combinedSql).toContain("memories_status_idx");
    expect(combinedSql).toContain("memories_search_tsv_idx");
    expect(combinedSql).toContain("memories_scope_scope_id_status_idx");
    expect(combinedSql).toContain("memories_type_subtype_idx");
    expect(combinedSql).toContain("memories_source_trace_id_trgm_idx");
    expect(combinedSql).toContain("to_tsvector('simple'");
    expect(combinedSql).toContain("embedding_model");
    expect(combinedSql).toContain("embedding_provider");
    expect(combinedSql).toContain("embedding_dimensions");
    expect(combinedSql).toContain("embedded_at");
    expect(combinedSql).toContain("memories_embedding_provider_model_idx");
  });
});

function createLlmExtractor(output: string | Record<string, unknown>): LlmMemoryExtractor {
  return new LlmMemoryExtractor(
    {
      async generateReasoning() {
        return {
          reasoning: typeof output === "string" ? output : JSON.stringify(output)
        };
      }
    },
    new RuleBasedMemoryExtractor(),
    { enabled: true, providerConfigured: true, providerName: "deepseek" }
  );
}

function createTestEmbeddingProvider() {
  return {
    name: "mock-test",
    model: "mock-test-model",
    dimensions: 3,
    mock: true,
    async embedText(_text: string): Promise<number[]> {
      return [0.1, 0.2, 0.3];
    }
  };
}

function createFailingEmbeddingProvider() {
  return {
    name: "failing-test",
    model: "failing-test-model",
    dimensions: 3,
    mock: true,
    async embedText(_text: string): Promise<number[]> {
      throw new Error("embedding unavailable");
    }
  };
}

function createWrongDimensionEmbeddingProvider() {
  return {
    name: "wrong-dimension-test",
    model: "wrong-dimension-test-model",
    dimensions: 3,
    mock: false,
    async embedText(_text: string): Promise<number[]> {
      return [0.1, 0.2];
    }
  };
}
