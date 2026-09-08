import Fastify from "fastify";
import { InMemoryMemoryRepository } from "@companion/memory";
import { expect, it, vi } from "vitest";
import { registerMemoryRoutes } from "./memory.js";

it("record browsing stays with CRUD storage, includes explicitly forgotten records, and leaves semantic search separate", async () => {
  const app = Fastify();
  const repository = new InMemoryMemoryRepository();
  const record = await repository.createMemory({
    type: "semantic",
    content: "garden mint",
    scope: "session",
    scopeId: "isolated",
    source: "manual",
    tags: []
  });
  const semantic = vi.fn(async () => {
    throw new Error("Semantic backend unavailable");
  });
  await registerMemoryRoutes(app, {
    memoryRepository: repository,
    activeMemoryRepository: "in-memory",
    memory: { retrieveRelevantMemoriesWithMetadata: semantic }
  } as never);
  try {
    const search = (extra: object = {}) =>
      app.inject({
        method: "POST",
        url: "/memory/search",
        payload: { view: "records", q: "garden", scope: "session", scopeId: "isolated", ...extra }
      });
    expect((await search()).json().memories.map((m: { id: string }) => m.id)).toEqual([record.id]);
    expect(semantic).not.toHaveBeenCalled();
    await repository.updateMemory(record.id, { status: "forgotten" });
    expect((await search()).json().memories).toEqual([]);
    expect(
      (await search({ status: "forgotten" })).json().memories.map((m: { id: string }) => m.id)
    ).toEqual([record.id]);
    expect((await search({ status: "forgotten", scopeId: "other" })).json().memories).toEqual([]);
    expect(
      (await app.inject({ method: "POST", url: "/memory/search", payload: { q: "garden" } }))
        .statusCode
    ).toBe(500);
    expect(semantic).toHaveBeenCalledOnce();
  } finally {
    await app.close();
  }
});
