import type { MemoryRepository } from "./repository.js";
import type { Memory, MemorySearchQuery } from "./types.js";
import { MemoryScorer } from "./scorer.js";

export class MemoryRetriever {
  constructor(
    private readonly repository: MemoryRepository,
    private readonly scorer = new MemoryScorer()
  ) {}

  async retrieve(query: MemorySearchQuery): Promise<Memory[]> {
    const candidates = query.embedding?.length
      ? await this.repository.searchMemoriesByEmbedding(query)
      : await this.repository.searchMemoriesByTextFallback(query);

    return this.scorer.rank(candidates);
  }
}
