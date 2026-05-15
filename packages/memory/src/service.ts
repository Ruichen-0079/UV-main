import type { MemoryRepository } from "./repository.js";
import { MemoryRetriever } from "./retriever.js";
import { MemoryScorer } from "./scorer.js";
import type {
  CreateMemoryInput,
  Memory,
  MemoryMatchReason,
  MemoryQuery,
  MemoryRetrievalResult,
  MemorySearchQuery,
  MemoryType,
  RetrievedMemoryCandidate,
  RetrievedMemoryDebug
} from "./types.js";

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
    const result = await this.retrieveRelevantMemoriesWithMetadata(query);
    return result.selectedMemories;
  }

  async retrieveRelevantMemoriesWithMetadata(
    query: MemorySearchQuery
  ): Promise<MemoryRetrievalResult> {
    const result = await this.retrieveWithFallback(query);
    await Promise.all(
      result.selectedMemories.map((memory) => this.repository.updateMemoryAccess(memory.id))
    );
    return result;
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

  private async retrieveWithFallback(query: MemorySearchQuery): Promise<MemoryRetrievalResult> {
    const queryText = query.text?.trim() ?? "";
    const keywords = queryText ? extractSearchKeywords(queryText) : [];
    const memories = await this.retriever.retrieve(query);
    if (!queryText || keywords.length === 0) {
      return this.buildRetrievalResult(query, keywords, memories, "original-query");
    }

    const candidates = [
      ...this.toCandidates(memories, keywords, "original-query"),
      ...(await this.retrieveByKeywords(query, keywords))
    ].sort(compareCandidates);

    if (candidates.length > 0) {
      return this.buildRetrievalResultFromCandidates(query, keywords, candidates);
    }

    const recent = await this.repository.listRecentMemories(Math.max(query.limit ?? 6, 20));
    return this.buildRetrievalResultFromCandidates(
      query,
      keywords,
      this.rankKeywordMatches(recent, keywords, "fallback-recent")
    );
  }

  private async retrieveByKeywords(
    query: MemorySearchQuery,
    keywords: string[]
  ): Promise<RetrievedMemoryCandidate[]> {
    const matches = new Map<string, RetrievedMemoryCandidate>();
    for (const keyword of keywords.slice(0, 8)) {
      const results = await this.repository.searchMemoriesByTextFallback({
        ...query,
        text: keyword,
        limit: Math.max(query.limit ?? 6, 10)
      });
      for (const candidate of this.rankKeywordMatches(results, keywords, "keyword")) {
        const current = matches.get(candidate.memory.id);
        if (!current || candidate.score > current.score) {
          matches.set(candidate.memory.id, candidate);
        }
      }
    }

    return [...matches.values()].sort(compareCandidates);
  }

  private rankKeywordMatches(
    memories: Memory[],
    keywords: string[],
    matchedBy: MemoryMatchReason
  ): RetrievedMemoryCandidate[] {
    return this.toCandidates(memories, keywords, matchedBy).sort(compareCandidates);
  }

  private toCandidates(
    memories: Memory[],
    keywords: string[],
    matchedBy: MemoryMatchReason
  ): RetrievedMemoryCandidate[] {
    return memories
      .map((memory) => ({
        memory,
        displayText: createMemoryDisplayText(memory),
        matchedBy,
        score: scoreMemory(memory, keywords)
      }))
      .filter((entry) => entry.score > 0);
  }

  private buildRetrievalResult(
    query: MemorySearchQuery,
    keywords: string[],
    memories: Memory[],
    matchedBy: MemoryMatchReason
  ): MemoryRetrievalResult {
    return this.buildRetrievalResultFromCandidates(
      query,
      keywords,
      memories
        .map((memory) => ({
          memory,
          displayText: createMemoryDisplayText(memory),
          matchedBy,
          score: scoreMemory(memory, keywords)
        }))
        .sort(compareCandidates)
    );
  }

  private buildRetrievalResultFromCandidates(
    query: MemorySearchQuery,
    keywords: string[],
    candidates: RetrievedMemoryCandidate[]
  ): MemoryRetrievalResult {
    const { selected, all } = dedupeCandidates(candidates);
    const selectedLimited = selected.slice(0, query.limit ?? 6);
    const selectedIds = new Set(selectedLimited.map((candidate) => candidate.memory.id));
    const debug = all.map((candidate) =>
      toDebugMemory(
        selectedIds.has(candidate.memory.id)
          ? candidate
          : { ...candidate, excludedReason: candidate.excludedReason ?? "filtered-after-ranking" }
      )
    );

    return {
      query: query.text ?? "",
      keywords,
      rawCount: candidates.length,
      count: selectedLimited.length,
      rawMemories: debug,
      memories: debug.filter((memory) => !memory.excludedReason),
      selectedMemories: selectedLimited.map((candidate) => candidate.memory)
    };
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

export function createMemoryDisplayText(memory: Memory): string {
  const content = normalizeDisplayText(memory.content);
  const summary = memory.summary ? normalizeDisplayText(memory.summary) : "";
  const summaryIsUseful =
    summary.length >= 12 && summary.length < content.length && !isVerboseRuntimeSummary(summary);
  const selected = summaryIsUseful ? summary : content;

  return truncateDisplayText(stripVerboseRuntimeTranscript(selected), 220);
}

export function normalizeDisplayText(text: string): string {
  return stripEdgeQuotes(text)
    .replace(/\r\n/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function stripEdgeQuotes(text: string): string {
  let result = text.trim();
  let changed = true;
  while (changed && result.length > 0) {
    changed = false;
    if (quoteChars.has(result.at(0) ?? "")) {
      result = result.slice(1).trimStart();
      changed = true;
    }
    if (quoteChars.has(result.at(-1) ?? "")) {
      result = result.slice(0, -1).trimEnd();
      changed = true;
    }
  }
  return result;
}

function stripVerboseRuntimeTranscript(text: string): string {
  const userIntent = text.match(/User intent:\s*([^\n]+)/i)?.[1];
  if (userIntent && isVerboseRuntimeSummary(text)) {
    return normalizeDisplayText(userIntent);
  }

  return text
    .replace(/Assistant response summary:\s*.*$/gis, "")
    .replace(/User intent:\s*/gi, "")
    .trim();
}

function isVerboseRuntimeSummary(text: string): boolean {
  return /Assistant response summary:/i.test(text) && text.length > 160;
}

function truncateDisplayText(text: string, maxLength: number): string {
  const normalized = stripLeadingListMarkers(normalizeDisplayText(text));
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 3).trim()}...`
    : normalized;
}

function stripLeadingListMarkers(text: string): string {
  let result = text.trim();
  let previous = "";

  while (result && result !== previous) {
    previous = result;
    result = result
      .replace(/^>\s*/, "")
      .replace(/^(?:[-*+•]\s+|\d+[.)]\s+)/u, "")
      .trimStart();
  }

  return result;
}

function scoreMemory(memory: Memory, keywords: string[]): number {
  const haystack =
    `${memory.content} ${memory.summary ?? ""} ${memory.tags.join(" ")}`.toLowerCase();
  const matchCount = keywords.filter((keyword) => haystack.includes(keyword)).length;
  if (keywords.length > 0 && matchCount === 0) {
    return 0;
  }

  const isRuntimeNoise = isVerboseRuntimeSummary(memory.summary ?? memory.content);
  const effectiveMatchCount = isRuntimeNoise ? Math.min(matchCount, 1) : matchCount;
  const runtimeNoisePenalty = isRuntimeNoise ? 3 : 0;
  return (
    effectiveMatchCount * 4 +
    typePriority(memory.type) +
    memory.importance * 2 -
    runtimeNoisePenalty
  );
}

function dedupeCandidates(candidates: RetrievedMemoryCandidate[]): {
  selected: RetrievedMemoryCandidate[];
  all: RetrievedMemoryCandidate[];
} {
  const all: RetrievedMemoryCandidate[] = [];
  const selected: RetrievedMemoryCandidate[] = [];

  for (const candidate of [...candidates].sort(compareCandidates)) {
    const duplicateOf = selected.find((kept) =>
      isDuplicateDisplayText(kept.displayText, candidate.displayText)
    );
    if (duplicateOf) {
      all.push({
        ...candidate,
        excludedReason: `deduped-near-duplicate-of:${duplicateOf.memory.id}`
      });
      continue;
    }
    selected.push(candidate);
    all.push(candidate);
  }

  return { selected, all };
}

function isDuplicateDisplayText(left: string, right: string): boolean {
  const normalizedLeft = normalizeForDedup(left);
  const normalizedRight = normalizeForDedup(right);
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  if (normalizedLeft === normalizedRight) {
    return true;
  }

  const shorter =
    normalizedLeft.length <= normalizedRight.length ? normalizedLeft : normalizedRight;
  const longer = normalizedLeft.length > normalizedRight.length ? normalizedLeft : normalizedRight;
  return shorter.length >= 24 && longer.includes(shorter);
}

function normalizeForDedup(text: string): string {
  return normalizeDisplayText(text)
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

function compareCandidates(
  left: RetrievedMemoryCandidate,
  right: RetrievedMemoryCandidate
): number {
  const scoreDelta = right.score - left.score;
  if (scoreDelta !== 0) {
    return scoreDelta;
  }

  const typeDelta = typePriority(right.memory.type) - typePriority(left.memory.type);
  if (typeDelta !== 0) {
    return typeDelta;
  }

  const importanceDelta = right.memory.importance - left.memory.importance;
  if (importanceDelta !== 0) {
    return importanceDelta;
  }

  return right.memory.createdAt.getTime() - left.memory.createdAt.getTime();
}

function typePriority(type: MemoryType): number {
  switch (type) {
    case "semantic":
      return 5;
    case "procedural":
      return 4;
    case "emotional":
      return 3;
    case "episodic":
      return 2;
    case "working":
      return 1;
  }
}

function toDebugMemory(candidate: RetrievedMemoryCandidate): RetrievedMemoryDebug {
  return {
    id: candidate.memory.id,
    type: candidate.memory.type,
    source: candidate.memory.source,
    importance: candidate.memory.importance,
    createdAt: candidate.memory.createdAt,
    displayText: candidate.displayText,
    matchedBy: candidate.matchedBy,
    ...(candidate.excludedReason ? { excludedReason: candidate.excludedReason } : {})
  };
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

const quoteChars = new Set(['"', "'", "“", "”", "‘", "’"]);
