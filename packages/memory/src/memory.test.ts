import { describe, expect, it } from "vitest";
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

describe("MemoryRepository", () => {
  it("creates and retrieves memory records", async () => {
    const repository = new InMemoryMemoryRepository();
    const created = await repository.createMemory({
      type: "semantic",
      content: "The user is testing memory.",
      source: "test",
      tags: ["test"]
    });

    const byId = await repository.getMemoryById(created.id);
    const recent = await repository.listRecentMemories(5);

    expect(byId?.content).toBe("The user is testing memory.");
    expect(byId?.subtype).toBeNull();
    expect(byId?.sourceTraceId).toBeNull();
    expect(recent.map((memory) => memory.id)).toContain(created.id);
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

  it("deduplicates display-equivalent memories and prefers semantic memory", async () => {
    const repository = new InMemoryMemoryRepository();
    const service = new MemoryService(repository);
    const content = "用户正在开发 YUVI Runtime，一个类 AIRI 的 AI Companion Runtime。";
    await repository.createMemory({
      type: "working",
      content,
      importance: 1,
      source: "test"
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

  it("scores only durable memory-worthy interactions highly", () => {
    const scorer = new MemoryScorer();

    expect(scorer.scoreImportance("hi")).toBe(0);
    expect(scorer.scoreImportance("What is TypeScript?")).toBe(0);
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
    expect(combinedSql).toContain("create table if not exists memories");
    expect(combinedSql).toContain("create table if not exists entities");
    expect(combinedSql).toContain("create table if not exists relations");
  });
});
