import type { MemoryRepository } from "./repository.js";
import { MemoryRetriever } from "./retriever.js";
import { MemoryScorer } from "./scorer.js";
import type { CreateMemoryInput, Memory, MemoryQuery, MemorySearchQuery } from "./types.js";

export class MemoryService {
  private readonly scorer: MemoryScorer;
  private readonly retriever: MemoryRetriever;

  constructor(
    private readonly repository: MemoryRepository,
    scorer = new MemoryScorer(),
    retriever?: MemoryRetriever
  ) {
    this.scorer = scorer;
    this.retriever = retriever ?? new MemoryRetriever(repository, scorer);
  }

  async rememberInteraction(input: {
    userMessage: string;
    assistantMessage: string;
    source?: string;
    tags?: string[];
  }): Promise<Memory> {
    const content = [
      `User intent: ${input.userMessage.trim()}`,
      `Assistant response summary: ${input.assistantMessage.trim()}`
    ].join("\n");

    return this.repository.createMemory({
      type: "episodic",
      content,
      summary: this.compressForStorage(content),
      importance: this.scoreImportance(content),
      emotionValence: 0,
      emotionArousal: 0,
      source: input.source ?? "interaction",
      tags: input.tags ?? []
    });
  }

  async retrieveRelevantMemories(query: MemorySearchQuery): Promise<Memory[]> {
    const memories = await this.retrieveWithFallback(query);
    await Promise.all(memories.map((memory) => this.repository.updateMemoryAccess(memory.id)));
    return memories;
  }

  async consolidateMemory(_memoryId: string): Promise<void> {
    // Placeholder: future consolidation should merge related memories into stable semantic summaries.
  }

  scoreImportance(content: string): number {
    return this.scorer.scoreImportance(content);
  }

  async remember(_sessionId: string, content: string): Promise<void> {
    await this.repository.createMemory({
      type: "working",
      content,
      summary: this.compressForStorage(content),
      importance: this.scoreImportance(content),
      source: "runtime",
      tags: []
    });
  }

  async retrieveForPrompt(query: MemoryQuery): Promise<string[]> {
    const memories = await this.retrieveRelevantMemories({
      text: query.text,
      limit: query.limit ?? 5
    });

    return memories.map((memory) => this.reconstructForPrompt(memory));
  }

  private compressForStorage(content: string): string {
    const compact = content.replace(/\s+/g, " ").trim();
    return compact.length > 500 ? `${compact.slice(0, 497)}...` : compact;
  }

  private reconstructForPrompt(memory: Memory): string {
    return memory.summary ?? this.compressForStorage(memory.content);
  }

  private async retrieveWithFallback(query: MemorySearchQuery): Promise<Memory[]> {
    const memories = await this.retriever.retrieve(query);
    if (memories.length > 0 || !query.text?.trim()) {
      return memories;
    }

    const tokens = tokenize(query.text);
    if (tokens.length === 0) {
      return memories;
    }

    const recent = await this.repository.listRecentMemories(Math.max(query.limit ?? 6, 20));
    return this.scorer.rank(recent.filter((memory) => {
      const haystack = `${memory.content} ${memory.summary ?? ""} ${memory.tags.join(" ")}`.toLowerCase();
      return tokens.some((token) => haystack.includes(token));
    })).slice(0, query.limit ?? 6);
  }
}

export type { CreateMemoryInput };

function tokenize(text: string): string[] {
  return Array.from(new Set(text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .filter((token) => !stopWords.has(token))));
}

const stopWords = new Set([
  "the",
  "and",
  "you",
  "what",
  "know",
  "about",
  "with",
  "that",
  "this",
  "for"
]);
