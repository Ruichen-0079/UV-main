import { describe, expect, it } from "vitest";
import { InMemoryMemoryRepository } from "./repository.js";

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
});
