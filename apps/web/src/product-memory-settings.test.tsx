import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { LocalServicesStatus } from "./api/client.js";
import {
  ProductMemorySettings,
  productMemoryOperational
} from "./product-memory-settings.js";

function memory(
  patch: Partial<LocalServicesStatus["memory"]> = {}
): LocalServicesStatus["memory"] {
  return {
    backend: "mem0",
    repository: "postgres",
    database: "healthy",
    ollama: true,
    embedderPresent: true,
    model: "yuvi-embedding:0.6b",
    dimensions: 1024,
    status: "degraded",
    crud: true,
    search: true,
    infer: false,
    embedder: true,
    vectorStore: true,
    ...patch
  };
}

describe("Product Memory simplification", () => {
  it("does not expose infrastructure settings on the normal browser surface", () => {
    const markup = renderToStaticMarkup(<ProductMemorySettings />);

    for (const hidden of [
      "Memory backend",
      "Persistence repository",
      "Mem0 URL",
      "Ollama URL",
      "PostgreSQL connection",
      "DATABASE_URL",
      "Save memory configuration",
      "Restart local services"
    ]) {
      expect(markup).not.toContain(hidden);
    }
  });

  it("treats infer=false as operational when normal Memory capabilities are healthy", () => {
    expect(productMemoryOperational(memory({ infer: false, status: "degraded" }))).toBe(true);
    expect(productMemoryOperational(memory({ search: false }))).toBe(false);
    expect(productMemoryOperational(memory({ vectorStore: false }))).toBe(false);
    expect(productMemoryOperational(memory({ database: "unavailable" }))).toBe(false);
  });
});
