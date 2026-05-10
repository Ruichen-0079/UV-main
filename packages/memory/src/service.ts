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
    const memories = await this.retriever.retrieve(query);
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
}

export type { CreateMemoryInput };
