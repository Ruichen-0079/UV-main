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

    const keywords = extractSearchKeywords(query.text);
    if (keywords.length === 0) {
      return memories;
    }

    const keywordMatches = await this.retrieveByKeywords(query, keywords);
    if (keywordMatches.length > 0) {
      return keywordMatches;
    }

    const recent = await this.repository.listRecentMemories(Math.max(query.limit ?? 6, 20));
    return this.rankKeywordMatches(recent, keywords).slice(0, query.limit ?? 6);
  }

  private async retrieveByKeywords(
    query: MemorySearchQuery,
    keywords: string[]
  ): Promise<Memory[]> {
    const matches = new Map<string, Memory>();
    for (const keyword of keywords.slice(0, 8)) {
      const results = await this.repository.searchMemoriesByTextFallback({
        ...query,
        text: keyword,
        limit: Math.max(query.limit ?? 6, 10)
      });
      for (const memory of results) {
        matches.set(memory.id, memory);
      }
    }

    return this.rankKeywordMatches([...matches.values()], keywords).slice(0, query.limit ?? 6);
  }

  private rankKeywordMatches(memories: Memory[], keywords: string[]): Memory[] {
    const scored = memories
      .map((memory) => ({
        memory,
        score: keywordScore(memory, keywords)
      }))
      .filter((entry) => entry.score > 0);

    return scored
      .sort((left, right) => {
        const scoreDelta = right.score - left.score;
        if (scoreDelta !== 0) {
          return scoreDelta;
        }

        return this.scorer.rank([left.memory, right.memory])[0]?.id === left.memory.id ? -1 : 1;
      })
      .map((entry) => entry.memory);
  }
}

export type { CreateMemoryInput };

export function extractSearchKeywords(text: string): string[] {
  const normalized = text.toLowerCase();
  const latinTokens = normalized
    .match(/[a-z0-9][a-z0-9_-]*/gu)
    ?.map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .filter((token) => !stopWords.has(token));
  const cjkTokens = normalized
    .match(/[\u4e00-\u9fff]{2,}/gu)
    ?.flatMap((token) => cjkKeywordCandidates(token));

  return Array.from(new Set([...(latinTokens ?? []), ...(cjkTokens ?? [])])).slice(0, 16);
}

function cjkKeywordCandidates(token: string): string[] {
  const candidates = new Set<string>();
  if (token.length <= 6 && !cjkStopWords.has(token)) {
    candidates.add(token);
  }

  for (let size = 2; size <= Math.min(4, token.length); size += 1) {
    for (let index = 0; index <= token.length - size; index += 1) {
      const gram = token.slice(index, index + size);
      if (!cjkStopWords.has(gram)) {
        candidates.add(gram);
      }
    }
  }

  return [...candidates];
}

function keywordScore(memory: Memory, keywords: string[]): number {
  const haystack =
    `${memory.content} ${memory.summary ?? ""} ${memory.tags.join(" ")}`.toLowerCase();
  const matchCount = keywords.filter((keyword) => haystack.includes(keyword)).length;
  if (matchCount === 0) {
    return 0;
  }

  return matchCount + memory.importance + memory.lastAccessedAt.getTime() / 1_000_000_000_000_000;
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

const cjkStopWords = new Set(["什么", "是什", "是什么", "的吗", "这个", "那个"]);
