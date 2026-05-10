import { describe, expect, it } from "vitest";
import { MissingDatabaseUrlError, parseDotEnv, readSqlMigrations, resolveDatabaseUrl } from "./migrations.js";
import { InMemoryMemoryRepository, createMemoryRepositoryFromEnv, PostgresMemoryRepository } from "./repository.js";

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
    expect(recent.map((memory) => memory.id)).toContain(created.id);
  });

  it("uses in-memory storage by default unless postgres is explicit", () => {
    expect(createMemoryRepositoryFromEnv({ DATABASE_URL: "postgres://example" })).toBeInstanceOf(InMemoryMemoryRepository);
    expect(createMemoryRepositoryFromEnv({ MEMORY_REPOSITORY: "postgres", DATABASE_URL: "postgres://example" })).toBeInstanceOf(PostgresMemoryRepository);
    expect(() => createMemoryRepositoryFromEnv({ MEMORY_REPOSITORY: "postgres" })).toThrow("DATABASE_URL");
  });

  it("resolves DATABASE_URL from process env or .env text without printing it", () => {
    expect(resolveDatabaseUrl({ DATABASE_URL: "postgres://from-env" }, "DATABASE_URL=postgres://from-file")).toBe("postgres://from-env");
    expect(resolveDatabaseUrl({}, "DATABASE_URL=postgres://from-file")).toBe("postgres://from-file");
    expect(parseDotEnv("# comment\nDATABASE_URL='postgres://quoted'\n")).toEqual({
      DATABASE_URL: "postgres://quoted"
    });
    expect(() => resolveDatabaseUrl({})).toThrow(MissingDatabaseUrlError);
  });

  it("ships idempotent PostgreSQL migration SQL", async () => {
    const migrations = await readSqlMigrations();
    const combinedSql = migrations.map((migration) => migration.sql).join("\n").toLowerCase();

    expect(combinedSql).toContain("create extension if not exists vector");
    expect(combinedSql).toContain("create table if not exists memories");
    expect(combinedSql).toContain("create table if not exists entities");
    expect(combinedSql).toContain("create table if not exists relations");
  });
});
