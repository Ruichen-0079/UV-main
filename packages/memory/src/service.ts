import type { MemoryRepository } from "./repository.js";
import { RuleBasedMemoryExtractor } from "./extractor.js";
import { MemoryRetriever } from "./retriever.js";
import { MemoryScorer } from "./scorer.js";
import type {
  CreateMemoryInput,
  Memory,
  MemoryCandidate,
  MemoryExtractionInput,
  MemoryExtractor,
  MemoryExtractorStatus,
  MemoryLayer,
  MemoryMatchReason,
  MemoryRetrievalMode,
  MemoryScope,
  MemoryQuery,
  MemoryRetrievalResult,
  MemorySearchQuery,
  MemorySubtype,
  MemoryType,
  RetrievedMemoryCandidate,
  RetrievedMemoryDebug,
  UpdateMemoryInput
} from "./types.js";

export type MemoryEmbeddingProvider = {
  readonly name: string;
  readonly dimensions: number;
  readonly model?: string | undefined;
  readonly mock?: boolean | undefined;
  embedText(text: string): Promise<number[]>;
};

export type MemoryEmbeddingConfig = {
  provider?: MemoryEmbeddingProvider | undefined;
  enabled?: boolean | undefined;
  logger?: { warn?(message: string, context?: Record<string, unknown>): void } | undefined;
};

export class MemoryService {
  private readonly scorer: MemoryScorer;
  private readonly retriever: MemoryRetriever;
  private readonly embeddingProvider: MemoryEmbeddingProvider | undefined;
  private readonly embeddingEnabled: boolean;
  private readonly embeddingLogger: MemoryEmbeddingConfig["logger"];

  constructor(
    private readonly repository: MemoryRepository,
    scorer = new MemoryScorer(),
    retriever?: MemoryRetriever,
    private readonly extractor: MemoryExtractor = new RuleBasedMemoryExtractor(),
    embedding?: MemoryEmbeddingConfig
  ) {
    this.scorer = scorer;
    this.retriever = retriever ?? new MemoryRetriever(repository, scorer);
    this.embeddingProvider = embedding?.provider;
    this.embeddingEnabled = embedding?.enabled ?? Boolean(embedding?.provider);
    this.embeddingLogger = embedding?.logger;
  }

  async createMemory(input: CreateMemoryInput): Promise<Memory> {
    return this.repository.createMemory(await this.withEmbedding(input));
  }

  async updateMemory(id: string, input: UpdateMemoryInput): Promise<Memory | null> {
    const shouldRegenerate =
      input.content !== undefined || input.summary !== undefined || input.tags !== undefined;
    if (!shouldRegenerate) {
      return this.repository.updateMemory(id, input);
    }
    const current = await this.repository.getMemoryById(id);
    if (!current) {
      return null;
    }
    const nextInput: CreateMemoryInput = {
      type: input.type ?? current.type,
      subtype: input.subtype ?? current.subtype,
      scope: input.scope ?? current.scope,
      scopeId: input.scopeId ?? current.scopeId,
      memoryLayer: input.memoryLayer ?? current.memoryLayer,
      status: input.status ?? current.status,
      content: input.content ?? current.content,
      summary: input.summary ?? current.summary,
      importance: input.importance ?? current.importance,
      emotionValence: input.emotionValence ?? current.emotionValence,
      emotionArousal: input.emotionArousal ?? current.emotionArousal,
      source: current.source,
      sourceTraceId: current.sourceTraceId,
      metadata: input.metadata ?? current.metadata,
      tags: input.tags ?? current.tags,
      observedAt: input.observedAt ?? current.observedAt,
      eventTime: input.eventTime ?? current.eventTime,
      validFrom: input.validFrom ?? current.validFrom,
      validUntil: input.validUntil ?? current.validUntil,
      expiresAt: input.expiresAt ?? current.expiresAt,
      supersededAt: input.supersededAt ?? current.supersededAt,
      supersedes: input.supersedes ?? current.supersedes,
      supersededBy: input.supersededBy ?? current.supersededBy,
      contradicts: input.contradicts ?? current.contradicts
    };
    const embedded = await this.withEmbedding(nextInput);
    const updateInput: UpdateMemoryInput = { ...input };
    if (embedded.embedding !== undefined) updateInput.embedding = embedded.embedding;
    if (embedded.embeddingProvider !== undefined) {
      updateInput.embeddingProvider = embedded.embeddingProvider;
    }
    if (embedded.embeddingModel !== undefined) updateInput.embeddingModel = embedded.embeddingModel;
    if (embedded.embeddingDimensions !== undefined) {
      updateInput.embeddingDimensions = embedded.embeddingDimensions;
    }
    if (embedded.embeddedAt !== undefined) updateInput.embeddedAt = embedded.embeddedAt;
    return this.repository.updateMemory(id, updateInput);
  }

  async rememberInteraction(input: {
    userMessage: string;
    assistantMessage: string;
    source?: string;
    sourceTraceId?: string | null;
    tags?: string[];
  }): Promise<Memory | null> {
    const candidates = await this.extractCandidates({
      userMessage: input.userMessage,
      assistantMessage: input.assistantMessage,
      sourceTraceId: input.sourceTraceId
    });
    const selected = candidates.find((candidate) => candidate.importance >= 0.65);
    if (selected) {
      return this.rememberCandidate(selected, {
        source: input.source ?? "runtime",
        tags: input.tags ?? []
      });
    }
    return null;
  }

  async extractCandidates(input: MemoryExtractionInput): Promise<MemoryCandidate[]> {
    return this.extractor.extractCandidates(input);
  }

  getExtractorStatus(): MemoryExtractorStatus {
    return (
      this.extractor.getStatus?.() ?? {
        mode: "rule-based",
        active: "rule-based",
        enabled: true
      }
    );
  }

  async rememberCandidate(
    candidate: MemoryCandidate,
    options: { source?: string; tags?: string[] } = {}
  ): Promise<Memory> {
    return this.createMemory({
      type: candidate.type,
      subtype: candidate.subtype ?? null,
      scope: candidate.scope ?? inferMemoryScope(candidate),
      scopeId: candidate.scopeId ?? inferMemoryScopeId(candidate),
      memoryLayer:
        candidate.memoryLayer ?? inferMemoryLayer(candidate.type, candidate.subtype ?? null),
      content: candidate.content,
      summary: candidate.summary ?? this.compressForStorage(candidate.content),
      importance: candidate.importance,
      emotionValence: 0,
      emotionArousal: 0,
      source: options.source ?? "runtime",
      sourceTraceId: candidate.sourceTraceId ?? null,
      metadata: {
        ...(candidate.metadata ?? {}),
        generatedBy: candidate.metadata?.["generatedBy"] ?? "memory-extractor",
        reason: candidate.reason,
        confidence: candidate.confidence ?? null,
        sourceTraceId: candidate.sourceTraceId ?? null
      },
      tags: Array.from(new Set([...(candidate.tags ?? []), ...(options.tags ?? [])])),
      observedAt: candidate.observedAt ?? new Date(),
      eventTime: candidate.eventTime ?? null,
      validFrom: candidate.validFrom ?? candidate.observedAt ?? new Date(),
      validUntil: candidate.validUntil ?? null,
      expiresAt: candidate.expiresAt ?? null,
      supersedes: candidate.possibleSupersedes ?? [],
      contradicts: candidate.possibleContradictions ?? []
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
    await this.createMemory({
      type: "working",
      subtype: inferMemorySubtype(content),
      content,
      summary: this.compressForStorage(content),
      importance: this.scoreImportance(content),
      source: "runtime",
      metadata: { generatedBy: "runtime" },
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

  private async withEmbedding(input: CreateMemoryInput): Promise<CreateMemoryInput> {
    if (!this.embeddingEnabled || !this.embeddingProvider) {
      return input;
    }

    const embeddingInput = buildEmbeddingInput(input);
    if (!embeddingInput) {
      return input;
    }

    try {
      const vector = await this.embeddingProvider.embedText(embeddingInput);
      validateEmbeddingDimensions(vector, this.embeddingProvider.dimensions);
      return {
        ...input,
        embedding: vector,
        embeddingProvider: this.embeddingProvider.name,
        embeddingModel: this.embeddingProvider.model ?? this.embeddingProvider.name,
        embeddingDimensions: this.embeddingProvider.dimensions,
        embeddedAt: new Date()
      };
    } catch (error) {
      this.embeddingLogger?.warn?.("memory embedding generation failed; storing without vector", {
        provider: this.embeddingProvider.name,
        message: safeErrorMessage(error)
      });
      return {
        ...input,
        embedding: input.embedding ?? null,
        embeddingProvider: input.embeddingProvider ?? null,
        embeddingModel: input.embeddingModel ?? null,
        embeddingDimensions: input.embeddingDimensions ?? null,
        embeddedAt: input.embeddedAt ?? null
      };
    }
  }

  private async generateQueryEmbedding(
    queryText: string,
    query: MemorySearchQuery
  ): Promise<RetrievalEmbeddingDebug> {
    if (!shouldUseVectorRetrieval(query) || !this.embeddingEnabled || !this.embeddingProvider) {
      return emptyRetrievalEmbeddingDebug();
    }
    if (!shouldEmbedQuery(queryText)) {
      return {
        ...emptyRetrievalEmbeddingDebug(),
        vectorEnabled: true,
        embeddingProvider: this.embeddingProvider.name,
        embeddingModel: this.embeddingProvider.model ?? this.embeddingProvider.name,
        semanticEmbedding: !this.embeddingProvider.mock,
        ...(this.embeddingProvider.mock
          ? {
              embeddingNote:
                "Mock embeddings validate the retrieval pipeline but do not provide real semantic similarity."
            }
          : {}),
        fallbackUsed: true,
        fallbackReason: "Query was empty or too trivial for vector retrieval."
      };
    }

    try {
      const embedding = query.embedding ?? (await this.embeddingProvider.embedText(queryText));
      validateEmbeddingDimensions(embedding, this.embeddingProvider.dimensions);
      return {
        vectorEnabled: true,
        vectorUsed: true,
        queryEmbeddingGenerated: true,
        embedding,
        embeddingProvider: this.embeddingProvider.name,
        embeddingModel: this.embeddingProvider.model ?? this.embeddingProvider.name,
        semanticEmbedding: !this.embeddingProvider.mock,
        ...(this.embeddingProvider.mock
          ? {
              embeddingNote:
                "Mock embeddings validate the retrieval pipeline but do not provide real semantic similarity."
            }
          : {}),
        fallbackUsed: false
      };
    } catch (error) {
      this.embeddingLogger?.warn?.("query embedding generation failed; using keyword retrieval", {
        provider: this.embeddingProvider.name,
        message: safeErrorMessage(error)
      });
      return {
        vectorEnabled: true,
        vectorUsed: false,
        queryEmbeddingGenerated: false,
        embeddingProvider: this.embeddingProvider.name,
        embeddingModel: this.embeddingProvider.model ?? this.embeddingProvider.name,
        semanticEmbedding: !this.embeddingProvider.mock,
        ...(this.embeddingProvider.mock
          ? {
              embeddingNote:
                "Mock embeddings validate the retrieval pipeline but do not provide real semantic similarity."
            }
          : {}),
        fallbackUsed: true,
        fallbackReason: safeErrorMessage(error)
      };
    }
  }

  private compressForStorage(content: string): string {
    const compact = content.replace(/\s+/g, " ").trim();
    return compact.length > 500 ? `${compact.slice(0, 497)}...` : compact;
  }

  private reconstructForPrompt(memory: Memory): string {
    return memory.summary ?? this.compressForStorage(memory.content);
  }

  private async retrieveWithFallback(query: MemorySearchQuery): Promise<MemoryRetrievalResult> {
    const policy = createRetrievalPolicy(query);
    const queryText = query.text?.trim() ?? "";
    const keywords = queryText ? extractSearchKeywords(queryText) : [];
    const embeddingDebug = await this.generateQueryEmbedding(queryText, query);
    const broadQuery: MemorySearchQuery = {
      includeHistory: true,
      limit: Math.max(query.limit ?? 6, 20)
    };
    if (query.text !== undefined) broadQuery.text = query.text;
    if (query.types !== undefined) broadQuery.types = query.types;
    if (query.subtypes !== undefined) broadQuery.subtypes = query.subtypes;
    if (query.memoryLayers !== undefined) broadQuery.memoryLayers = query.memoryLayers;
    if (query.statuses !== undefined) broadQuery.statuses = query.statuses;
    if (query.sources !== undefined) broadQuery.sources = query.sources;
    if (query.minImportance !== undefined) broadQuery.minImportance = query.minImportance;
    if (query.tags !== undefined) broadQuery.tags = query.tags;
    const memories = await this.retriever.retrieve(broadQuery);
    const vectorCandidates =
      embeddingDebug.embedding && shouldUseVectorRetrieval(query)
        ? this.toCandidates(
            await this.repository.searchMemoriesByEmbedding({
              ...broadQuery,
              embedding: embeddingDebug.embedding,
              limit: Math.max(query.limit ?? 6, 10)
            }),
            keywords,
            policy
          )
        : [];
    if (!queryText || keywords.length === 0) {
      return this.buildRetrievalResult(
        query,
        policy,
        keywords,
        [...memories, ...vectorCandidates.map((candidate) => candidate.memory)],
        vectorCandidates.length > 0
          ? this.hybridRetrievalMode()
          : (this.repository.getRetrievalMode?.() ?? "in-memory-keyword"),
        embeddingDebug,
        vectorCandidates.length,
        memories.length
      );
    }

    const candidates = [
      ...this.toCandidates(memories, keywords, policy),
      ...vectorCandidates,
      ...(await this.retrieveByKeywords(query, keywords, policy))
    ].sort(compareCandidates);

    if (candidates.length > 0) {
      return this.buildRetrievalResultFromCandidates(
        query,
        policy,
        keywords,
        candidates,
        vectorCandidates.length > 0 ? this.hybridRetrievalMode() : this.resolveRetrievalMode(true),
        embeddingDebug,
        vectorCandidates.length,
        memories.length
      );
    }

    const recent = await this.repository.listRecentMemories(Math.max(query.limit ?? 6, 20));
    return this.buildRetrievalResultFromCandidates(
      query,
      policy,
      keywords,
      this.rankFallbackRecent(recent, policy),
      "fallback-recent",
      {
        ...embeddingDebug,
        fallbackUsed: true,
        fallbackReason: "No keyword or vector candidates matched."
      },
      vectorCandidates.length,
      memories.length
    );
  }

  private async retrieveByKeywords(
    query: MemorySearchQuery,
    keywords: string[],
    policy: RetrievalPolicy
  ): Promise<RetrievedMemoryCandidate[]> {
    const matches = new Map<string, RetrievedMemoryCandidate>();
    for (const keyword of keywords.slice(0, 8)) {
      const results = await this.repository.searchMemoriesByTextFallback({
        text: keyword,
        includeHistory: true,
        limit: Math.max(query.limit ?? 6, 10),
        ...(query.types !== undefined ? { types: query.types } : {}),
        ...(query.subtypes !== undefined ? { subtypes: query.subtypes } : {}),
        ...(query.memoryLayers !== undefined ? { memoryLayers: query.memoryLayers } : {}),
        ...(query.statuses !== undefined ? { statuses: query.statuses } : {}),
        ...(query.sources !== undefined ? { sources: query.sources } : {}),
        ...(query.minImportance !== undefined ? { minImportance: query.minImportance } : {}),
        ...(query.tags !== undefined ? { tags: query.tags } : {})
      });
      for (const candidate of this.rankKeywordMatches(results, keywords, policy)) {
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
    policy: RetrievalPolicy
  ): RetrievedMemoryCandidate[] {
    return this.toCandidates(memories, keywords, policy).sort(compareCandidates);
  }

  private toCandidates(
    memories: Memory[],
    keywords: string[],
    policy: RetrievalPolicy
  ): RetrievedMemoryCandidate[] {
    return memories
      .map((memory) => {
        const lexicalScore = scoreMemory(memory, keywords, policy);
        const matchedBy = memory.searchMatchedBy ?? detectMatchReason(memory, keywords);
        const vectorScore = memory.searchRankComponents?.vectorScore ?? 0;
        const vectorOnlyMatch = matchedBy === "vector" && keywords.length > 0 && lexicalScore <= 0;
        const vectorThreshold = this.embeddingProvider?.mock ? 0.95 : 0.78;
        const vectorExclusion =
          vectorOnlyMatch && vectorScore < vectorThreshold
            ? { excludedReason: `vector-below-threshold:${vectorScore.toFixed(3)}` }
            : {};

        return {
          memory,
          displayText: createMemoryDisplayText(memory),
          matchedBy,
          score: lexicalScore + (memory.searchScore ?? 0),
          ...(memory.searchRankComponents ? { rankComponents: memory.searchRankComponents } : {}),
          ...memoryExclusion(memory, policy),
          ...vectorExclusion
        };
      })
      .filter((entry) => entry.score > 0 || Boolean(entry.excludedReason));
  }

  private rankFallbackRecent(
    memories: Memory[],
    policy: RetrievalPolicy
  ): RetrievedMemoryCandidate[] {
    return memories
      .map((memory) => ({
        memory,
        displayText: createMemoryDisplayText(memory),
        matchedBy: "fallback" as const,
        score:
          typePriority(memory.type) +
          layerPriority(memory.memoryLayer) +
          memory.importance +
          sourceQuality(memory.source) +
          scopeQuality(memory, policy),
        ...memoryExclusion(memory, policy)
      }))
      .sort(compareCandidates);
  }

  private buildRetrievalResult(
    query: MemorySearchQuery,
    policy: RetrievalPolicy,
    keywords: string[],
    memories: Memory[],
    retrievalMode: MemoryRetrievalMode,
    embeddingDebug: RetrievalEmbeddingDebug = emptyRetrievalEmbeddingDebug(),
    vectorResultCount = 0,
    keywordResultCount = memories.length
  ): MemoryRetrievalResult {
    return this.buildRetrievalResultFromCandidates(
      query,
      policy,
      keywords,
      memories
        .map((memory) => ({
          memory,
          displayText: createMemoryDisplayText(memory),
          matchedBy: memory.searchMatchedBy ?? detectMatchReason(memory, keywords),
          score: scoreMemory(memory, keywords, policy) + (memory.searchScore ?? 0),
          ...(memory.searchRankComponents ? { rankComponents: memory.searchRankComponents } : {}),
          ...memoryExclusion(memory, policy)
        }))
        .sort(compareCandidates),
      retrievalMode,
      embeddingDebug,
      vectorResultCount,
      keywordResultCount
    );
  }

  private resolveRetrievalMode(hasKeywordFallback: boolean): MemoryRetrievalMode {
    const repositoryMode = this.repository.getRetrievalMode?.() ?? "in-memory-keyword";
    if (
      repositoryMode === "postgres-hybrid" ||
      repositoryMode === "postgres-hybrid-keyword" ||
      repositoryMode === "postgres-trigram" ||
      repositoryMode === "in-memory-hybrid" ||
      repositoryMode === "in-memory-keyword"
    ) {
      return repositoryMode;
    }
    return hasKeywordFallback ? "hybrid-keyword" : "keyword";
  }

  private hybridRetrievalMode(): MemoryRetrievalMode {
    const repositoryMode = this.repository.getRetrievalMode?.() ?? "in-memory-keyword";
    return repositoryMode.startsWith("postgres") ? "postgres-hybrid" : "in-memory-hybrid";
  }

  private buildRetrievalResultFromCandidates(
    query: MemorySearchQuery,
    policy: RetrievalPolicy,
    keywords: string[],
    candidates: RetrievedMemoryCandidate[],
    retrievalMode: MemoryRetrievalMode,
    embeddingDebug: RetrievalEmbeddingDebug = emptyRetrievalEmbeddingDebug(),
    vectorResultCount = candidates.filter((candidate) => candidate.matchedBy === "vector").length,
    keywordResultCount = candidates.length - vectorResultCount
  ): MemoryRetrievalResult {
    const mergedCandidates = mergeCandidateMatches(candidates);
    const { selected, all } = dedupeCandidates(
      mergedCandidates.filter((candidate) => !candidate.excludedReason)
    );
    const excluded = mergedCandidates.filter((candidate) => candidate.excludedReason);
    const selectedLimited = selected.slice(0, query.limit ?? 6);
    const selectedIds = new Set(selectedLimited.map((candidate) => candidate.memory.id));
    const debug = [...all, ...excluded].map((candidate) =>
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
      retrievalMode,
      vectorEnabled: embeddingDebug.vectorEnabled,
      vectorUsed: embeddingDebug.vectorUsed || vectorResultCount > 0,
      ...(embeddingDebug.embeddingProvider
        ? { embeddingProvider: embeddingDebug.embeddingProvider }
        : {}),
      ...(embeddingDebug.embeddingModel ? { embeddingModel: embeddingDebug.embeddingModel } : {}),
      ...(embeddingDebug.semanticEmbedding !== undefined
        ? { semanticEmbedding: embeddingDebug.semanticEmbedding }
        : {}),
      ...(embeddingDebug.embeddingNote ? { embeddingNote: embeddingDebug.embeddingNote } : {}),
      queryEmbeddingGenerated: embeddingDebug.queryEmbeddingGenerated,
      vectorResultCount,
      keywordResultCount,
      hybridResultCount: selectedLimited.length,
      fallbackUsed: Boolean(embeddingDebug.fallbackUsed || retrievalMode === "fallback-recent"),
      ...(embeddingDebug.fallbackReason ? { fallbackReason: embeddingDebug.fallbackReason } : {}),
      retrievalScope: policy.retrievalScope,
      includedScopes: policy.includedScopes,
      includeArchived: policy.includeArchived,
      includeSuperseded: policy.includeSuperseded,
      includeExpired: policy.includeExpired,
      currentTime: policy.currentTime.toISOString(),
      excludedByStatus: countUniqueExcluded(debug, "status:"),
      excludedByTime: countUniqueExcluded(debug, "time:"),
      excludedByScope: countUniqueExcluded(debug, "scope:"),
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

type RetrievalPolicy = {
  retrievalScope: string;
  includedScopes: Array<{ scope: MemoryScope; scopeId?: string | null }>;
  includeArchived: boolean;
  includeSuperseded: boolean;
  includeExpired: boolean;
  currentTime: Date;
};

type RetrievalEmbeddingDebug = {
  vectorEnabled: boolean;
  vectorUsed: boolean;
  queryEmbeddingGenerated: boolean;
  embedding?: number[] | undefined;
  embeddingProvider?: string | undefined;
  embeddingModel?: string | undefined;
  semanticEmbedding?: boolean | undefined;
  embeddingNote?: string | undefined;
  fallbackUsed?: boolean | undefined;
  fallbackReason?: string | undefined;
};

function emptyRetrievalEmbeddingDebug(): RetrievalEmbeddingDebug {
  return {
    vectorEnabled: false,
    vectorUsed: false,
    queryEmbeddingGenerated: false,
    fallbackUsed: false
  };
}

function shouldUseVectorRetrieval(query: MemorySearchQuery): boolean {
  return query.vectorEnabled !== false;
}

function shouldEmbedQuery(text: string): boolean {
  const normalized = text.trim();
  if (normalized.length < 3) {
    return false;
  }
  return !/^(hi|hey|hello|你好|在吗)[!.。！\s]*$/iu.test(normalized);
}

function buildEmbeddingInput(input: CreateMemoryInput): string {
  return [input.summary, input.content, input.tags?.join(" ")]
    .filter((part): part is string => Boolean(part?.trim()))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 8000);
}

function validateEmbeddingDimensions(vector: number[], expected: number): void {
  if (vector.length !== expected) {
    throw new Error(
      `Embedding dimension mismatch: expected ${expected}, received ${vector.length}.`
    );
  }
  if (!vector.every((value) => Number.isFinite(value))) {
    throw new Error("Embedding vector contained non-finite values.");
  }
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [REDACTED]").slice(0, 300);
}

function createRetrievalPolicy(query: MemorySearchQuery): RetrievalPolicy {
  const includedScopes = resolveIncludedScopes(query);
  return {
    retrievalScope: includedScopes
      .map((entry) => `${entry.scope}${entry.scopeId ? `:${entry.scopeId}` : ""}`)
      .join(","),
    includedScopes,
    includeArchived: Boolean(query.includeArchived),
    includeSuperseded: Boolean(query.includeSuperseded || query.includeHistory),
    includeExpired: Boolean(query.includeExpired || query.includeHistory),
    currentTime: new Date()
  };
}

function resolveIncludedScopes(
  query: MemorySearchQuery
): Array<{ scope: MemoryScope; scopeId?: string | null }> {
  if (query.scope) {
    return [{ scope: query.scope, ...(query.scopeId ? { scopeId: query.scopeId } : {}) }];
  }
  if (query.scopes?.length) {
    return query.scopes.map((scope) => scopeEntryForQuery(scope, query));
  }

  const scopes: MemoryScope[] = ["user", "project"];
  if (query.sessionId) scopes.push("session");
  if (query.agentId) scopes.push("agent");
  if (query.pluginId) scopes.push("plugin");
  return scopes.map((scope) => scopeEntryForQuery(scope, query));
}

function scopeEntryForQuery(
  scope: MemoryScope,
  query: MemorySearchQuery
): { scope: MemoryScope; scopeId?: string | null } {
  if (scope === "project") {
    return { scope, scopeId: query.projectId ?? query.scopeId ?? "yuvi-runtime" };
  }
  if (scope === "session" && query.sessionId) {
    return { scope, scopeId: query.sessionId };
  }
  if (scope === "agent" && query.agentId) {
    return { scope, scopeId: query.agentId };
  }
  if (scope === "plugin" && query.pluginId) {
    return { scope, scopeId: query.pluginId };
  }
  return { scope };
}

function memoryExclusion(
  memory: Memory,
  policy: RetrievalPolicy
): Pick<RetrievedMemoryCandidate, "excludedReason"> {
  const scopeReason = scopeExclusion(memory, policy);
  if (scopeReason) return { excludedReason: scopeReason };

  const statusReason = statusExclusion(memory, policy);
  if (statusReason) return { excludedReason: statusReason };

  const timeReason = timeExclusion(memory, policy);
  if (timeReason) return { excludedReason: timeReason };

  return {};
}

function scopeExclusion(memory: Memory, policy: RetrievalPolicy): string | null {
  const match = policy.includedScopes.some((entry) => {
    if (entry.scope !== memory.scope) return false;
    if (!entry.scopeId) return true;
    if (!memory.scopeId && memory.scope === "session") return true;
    return memory.scopeId === entry.scopeId;
  });
  return match
    ? null
    : `scope:not-included:${memory.scope}${memory.scopeId ? `:${memory.scopeId}` : ""}`;
}

function statusExclusion(memory: Memory, policy: RetrievalPolicy): string | null {
  if (memory.status === "active") return null;
  if (memory.status === "archived" && policy.includeArchived) return null;
  if (memory.status === "superseded" && policy.includeSuperseded) return null;
  if (memory.status === "expired" && policy.includeExpired) return null;
  return `status:${memory.status}`;
}

function timeExclusion(memory: Memory, policy: RetrievalPolicy): string | null {
  const now = policy.currentTime.getTime();
  if (!policy.includeExpired && memory.expiresAt && memory.expiresAt.getTime() <= now) {
    return "time:expiresAt";
  }
  if (!policy.includeExpired && memory.validUntil && memory.validUntil.getTime() <= now) {
    return "time:validUntil";
  }
  if (memory.validFrom && memory.validFrom.getTime() > now) {
    return "time:validFrom";
  }
  return null;
}

function scoreMemory(memory: Memory, keywords: string[], policy: RetrievalPolicy): number {
  const matchCount = keywords.reduce(
    (score, keyword) => score + keywordMatchWeight(memory, keyword),
    0
  );
  if (keywords.length > 0 && matchCount === 0) {
    return 0;
  }

  const isRuntimeNoise = isVerboseRuntimeSummary(memory.summary ?? memory.content);
  const effectiveMatchCount = isRuntimeNoise ? Math.min(matchCount, 1) : matchCount;
  const runtimeNoisePenalty = isRuntimeNoise ? 3 : 0;
  const recencyBonus = recencyScore(memory.createdAt);
  const accessBonus = accessScore(memory.lastAccessedAt);
  return (
    effectiveMatchCount * 4 +
    typePriority(memory.type) +
    layerPriority(memory.memoryLayer) +
    memory.importance * 2 -
    runtimeNoisePenalty +
    sourceQuality(memory.source) +
    scopeQuality(memory, policy) +
    recencyBonus +
    accessBonus
  );
}

function detectMatchReason(memory: Memory, keywords: string[]): MemoryMatchReason {
  if (keywords.length === 0) {
    return "keyword";
  }

  for (const keyword of keywords) {
    if (includesKeyword(memory.content, keyword)) {
      return "content";
    }
    if (memory.summary && includesKeyword(memory.summary, keyword)) {
      return "summary";
    }
    if (memory.tags.some((tag) => includesKeyword(tag, keyword))) {
      return "tag";
    }
    if (
      includesKeyword(memory.type, keyword) ||
      (memory.subtype && includesKeyword(memory.subtype, keyword))
    ) {
      return memory.subtype && includesKeyword(memory.subtype, keyword) ? "subtype" : "type";
    }
    if (
      includesKeyword(memory.scope, keyword) ||
      (memory.scopeId && includesKeyword(memory.scopeId, keyword)) ||
      includesKeyword(memory.memoryLayer, keyword)
    ) {
      return "scope";
    }
    if (
      includesKeyword(memory.source, keyword) ||
      (memory.sourceTraceId && includesKeyword(memory.sourceTraceId, keyword))
    ) {
      return "source";
    }
    if (includesKeyword(JSON.stringify(memory.metadata), keyword)) {
      return "metadata";
    }
  }

  return "keyword";
}

function keywordMatchWeight(memory: Memory, keyword: string): number {
  let score = 0;
  if (includesKeyword(memory.content, keyword)) {
    score += 2.5;
  }
  if (memory.summary && includesKeyword(memory.summary, keyword)) {
    score += 3;
  }
  if (memory.tags.some((tag) => includesKeyword(tag, keyword))) {
    score += 3.5;
  }
  if (
    includesKeyword(memory.type, keyword) ||
    (memory.subtype && includesKeyword(memory.subtype, keyword))
  ) {
    score += 2.25;
  }
  if (
    includesKeyword(memory.scope, keyword) ||
    (memory.scopeId && includesKeyword(memory.scopeId, keyword)) ||
    includesKeyword(memory.memoryLayer, keyword)
  ) {
    score += 1.75;
  }
  if (
    includesKeyword(memory.source, keyword) ||
    (memory.sourceTraceId && includesKeyword(memory.sourceTraceId, keyword))
  ) {
    score += 1.5;
  }
  if (includesKeyword(JSON.stringify(memory.metadata), keyword)) {
    score += 1.25;
  }
  return score;
}

function includesKeyword(value: string, keyword: string): boolean {
  return value.toLowerCase().includes(keyword.toLowerCase());
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

function mergeCandidateMatches(candidates: RetrievedMemoryCandidate[]): RetrievedMemoryCandidate[] {
  const byId = new Map<string, RetrievedMemoryCandidate>();
  for (const candidate of candidates) {
    const current = byId.get(candidate.memory.id);
    if (!current) {
      byId.set(candidate.memory.id, candidate);
      continue;
    }

    const merged = mergeCandidateScore(current, candidate);
    if (candidate.score > current.score) {
      byId.set(candidate.memory.id, merged);
    } else {
      byId.set(candidate.memory.id, {
        ...merged,
        matchedBy:
          current.matchedBy === "vector" && candidate.matchedBy !== "vector"
            ? candidate.matchedBy
            : current.matchedBy
      });
    }
  }
  return [...byId.values()].sort(compareCandidates);
}

function mergeCandidateScore(
  left: RetrievedMemoryCandidate,
  right: RetrievedMemoryCandidate
): RetrievedMemoryCandidate {
  const keywordCandidate =
    left.matchedBy === "vector" && right.matchedBy !== "vector" ? right : left;
  return {
    ...keywordCandidate,
    score: Math.max(left.score, right.score) + Math.min(left.score, right.score) * 0.15,
    rankComponents: {
      ...(left.rankComponents ?? {}),
      ...(right.rankComponents ?? {})
    }
  };
}

function countUniqueExcluded(memories: RetrievedMemoryDebug[], prefix: string): number {
  return new Set(
    memories
      .filter((memory) => memory.excludedReason?.startsWith(prefix))
      .map((memory) => memory.id)
  ).size;
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

  const layerDelta =
    layerPriority(right.memory.memoryLayer) - layerPriority(left.memory.memoryLayer);
  if (layerDelta !== 0) {
    return layerDelta;
  }

  const importanceDelta = right.memory.importance - left.memory.importance;
  if (importanceDelta !== 0) {
    return importanceDelta;
  }

  return right.memory.createdAt.getTime() - left.memory.createdAt.getTime();
}

function sourceQuality(source: string): number {
  if (source === "dashboard" || source === "manual") {
    return 1.5;
  }
  if (source === "runtime") {
    return -0.4;
  }
  return 0;
}

function recencyScore(createdAt: Date): number {
  const ageMs = Date.now() - createdAt.getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return 0;
  }
  const ageDays = ageMs / 86_400_000;
  return Math.max(0, 1 - ageDays / 30) * 0.5;
}

function accessScore(lastAccessedAt: Date): number {
  const ageMs = Date.now() - lastAccessedAt.getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return 0;
  }
  const ageDays = ageMs / 86_400_000;
  return Math.max(0, 1 - ageDays / 14) * 0.25;
}

function scopeQuality(memory: Memory, policy: RetrievalPolicy): number {
  const matchingScope = policy.includedScopes.find((entry) => entry.scope === memory.scope);
  if (!matchingScope) {
    return -6;
  }
  if (!matchingScope.scopeId) {
    return memory.scope === "user" ? 1.2 : 0.6;
  }
  if (memory.scopeId === matchingScope.scopeId) {
    return 2;
  }
  if (!memory.scopeId && memory.scope === "session") {
    return 0.5;
  }
  return -6;
}

function layerPriority(layer: MemoryLayer): number {
  switch (layer) {
    case "core":
      return 3;
    case "working":
      return 2.5;
    case "recall":
      return 1.5;
    case "archival":
      return -0.5;
  }
}

function typePriority(type: MemoryType): number {
  switch (type) {
    case "semantic":
      return 5;
    case "procedural":
      return 4;
    case "relationship":
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
    subtype: candidate.memory.subtype,
    scope: candidate.memory.scope,
    scopeId: candidate.memory.scopeId,
    memoryLayer: candidate.memory.memoryLayer,
    status: candidate.memory.status,
    source: candidate.memory.source,
    sourceTraceId: candidate.memory.sourceTraceId,
    metadata: candidate.memory.metadata,
    importance: candidate.memory.importance,
    createdAt: candidate.memory.createdAt,
    observedAt: candidate.memory.observedAt,
    validFrom: candidate.memory.validFrom,
    validUntil: candidate.memory.validUntil,
    expiresAt: candidate.memory.expiresAt,
    lastAccessedAt: candidate.memory.lastAccessedAt,
    supersededAt: candidate.memory.supersededAt,
    displayText: candidate.displayText,
    matchedBy: candidate.matchedBy,
    ...(candidate.memory.searchRetrievalMode
      ? { retrievalMode: candidate.memory.searchRetrievalMode }
      : {}),
    ...(candidate.rankComponents?.vectorScore !== undefined
      ? { vectorScore: candidate.rankComponents.vectorScore }
      : {}),
    ...(candidate.rankComponents?.hybridScore !== undefined
      ? { hybridScore: candidate.rankComponents.hybridScore }
      : {}),
    score: candidate.score,
    ...(candidate.rankComponents ? { rankComponents: candidate.rankComponents } : {}),
    ...(candidate.excludedReason ? { excludedReason: candidate.excludedReason } : {})
  };
}

function isPromptRetrievableMemory(memory: Memory): boolean {
  const now = Date.now();
  return (
    memory.status === "active" &&
    (!memory.expiresAt || memory.expiresAt.getTime() > now) &&
    (!memory.validFrom || memory.validFrom.getTime() <= now) &&
    (!memory.validUntil || memory.validUntil.getTime() > now)
  );
}

function inferMemoryScope(
  candidate: MemoryCandidate
): "user" | "project" | "agent" | "plugin" | "session" {
  if (candidate.type === "working") {
    return "session";
  }
  const haystack =
    `${candidate.content} ${candidate.summary ?? ""} ${candidate.tags.join(" ")}`.toLowerCase();
  return haystack.includes("yuvi") || haystack.includes("runtime") ? "project" : "user";
}

function inferMemoryScopeId(candidate: MemoryCandidate): string | null {
  return inferMemoryScope(candidate) === "project" ? "yuvi-runtime" : null;
}

function inferMemoryLayer(
  type: MemoryType,
  subtype: MemorySubtype | null
): "core" | "recall" | "archival" | "working" {
  if (type === "working") {
    return "working";
  }
  if (
    type === "semantic" ||
    subtype === "preference" ||
    subtype === "project" ||
    subtype === "provider-choice"
  ) {
    return "core";
  }
  if (type === "episodic" || subtype === "milestone" || subtype === "troubleshooting") {
    return "recall";
  }
  return "recall";
}

function inferRuntimeMemoryType(text: string): MemoryType {
  const normalized = text.toLowerCase();
  if (/workflow|流程|步骤|command|命令|脚本|script/u.test(normalized)) {
    return "procedural";
  }
  if (/relationship|关系|称呼/u.test(normalized)) {
    return "relationship";
  }
  if (/prefer|preference|偏好|默认|provider|deepseek|xai|dashscope|使用/u.test(normalized)) {
    return "semantic";
  }
  return "episodic";
}

function inferMemorySubtype(text: string): MemorySubtype | null {
  const normalized = text.toLowerCase();
  if (
    /deepseek|xai|dashscope|provider|chat|reasoning|tts|stt|vision|供应商|模型/u.test(normalized)
  ) {
    return "provider-choice";
  }
  if (/repo|repository|仓库|github/u.test(normalized)) {
    return "repo";
  }
  if (/\/home\/|c:\\|\\\\wsl|路径|目录|workspace|工作区/u.test(normalized)) {
    return "path";
  }
  if (/workflow|流程|步骤/u.test(normalized)) {
    return "workflow";
  }
  if (/command|命令|pnpm|docker|script|脚本/u.test(normalized)) {
    return "command";
  }
  if (/完成|implemented|finished|milestone|里程碑|通过验证/u.test(normalized)) {
    return "milestone";
  }
  if (/prefer|preference|偏好|默认|喜欢/u.test(normalized)) {
    return "preference";
  }
  if (/project|项目|yuvi|runtime/u.test(normalized)) {
    return "project";
  }
  if (/emotion|情绪|感受/u.test(normalized)) {
    return "emotion";
  }
  if (/relationship|关系|称呼/u.test(normalized)) {
    return "relationship";
  }
  return null;
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
