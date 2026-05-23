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
  RetrievedMemoryDebug
} from "./types.js";

export class MemoryService {
  private readonly scorer: MemoryScorer;
  private readonly retriever: MemoryRetriever;

  constructor(
    private readonly repository: MemoryRepository,
    scorer = new MemoryScorer(),
    retriever?: MemoryRetriever,
    private readonly extractor: MemoryExtractor = new RuleBasedMemoryExtractor()
  ) {
    this.scorer = scorer;
    this.retriever = retriever ?? new MemoryRetriever(repository, scorer);
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
    return this.repository.createMemory({
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
    await this.repository.createMemory({
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
    const broadQuery: MemorySearchQuery = {
      includeHistory: true,
      limit: Math.max(query.limit ?? 6, 20)
    };
    if (query.text !== undefined) broadQuery.text = query.text;
    if (query.embedding !== undefined) broadQuery.embedding = query.embedding;
    if (query.types !== undefined) broadQuery.types = query.types;
    if (query.tags !== undefined) broadQuery.tags = query.tags;
    const memories = await this.retriever.retrieve(broadQuery);
    if (!queryText || keywords.length === 0) {
      return this.buildRetrievalResult(
        query,
        policy,
        keywords,
        memories,
        this.repository.getRetrievalMode?.() ?? "keyword"
      );
    }

    const candidates = [
      ...this.toCandidates(memories, keywords, policy),
      ...(await this.retrieveByKeywords(query, keywords, policy))
    ].sort(compareCandidates);

    if (candidates.length > 0) {
      return this.buildRetrievalResultFromCandidates(
        query,
        policy,
        keywords,
        candidates,
        this.resolveRetrievalMode(true)
      );
    }

    const recent = await this.repository.listRecentMemories(Math.max(query.limit ?? 6, 20));
    return this.buildRetrievalResultFromCandidates(
      query,
      policy,
      keywords,
      this.rankFallbackRecent(recent, policy),
      "fallback-recent"
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
      .map((memory) => ({
        memory,
        displayText: createMemoryDisplayText(memory),
        matchedBy: detectMatchReason(memory, keywords),
        score: scoreMemory(memory, keywords, policy),
        ...memoryExclusion(memory, policy)
      }))
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
    retrievalMode: MemoryRetrievalMode
  ): MemoryRetrievalResult {
    return this.buildRetrievalResultFromCandidates(
      query,
      policy,
      keywords,
      memories
        .map((memory) => ({
          memory,
          displayText: createMemoryDisplayText(memory),
          matchedBy: detectMatchReason(memory, keywords),
          score: scoreMemory(memory, keywords, policy),
          ...memoryExclusion(memory, policy)
        }))
        .sort(compareCandidates),
      retrievalMode
    );
  }

  private resolveRetrievalMode(hasKeywordFallback: boolean): MemoryRetrievalMode {
    const repositoryMode = this.repository.getRetrievalMode?.() ?? "keyword";
    if (repositoryMode === "postgres-trigram") {
      return "postgres-trigram";
    }
    return hasKeywordFallback ? "hybrid-keyword" : "keyword";
  }

  private buildRetrievalResultFromCandidates(
    query: MemorySearchQuery,
    policy: RetrievalPolicy,
    keywords: string[],
    candidates: RetrievedMemoryCandidate[],
    retrievalMode: MemoryRetrievalMode
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
      return "type";
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
    if (!current || candidate.score > current.score) {
      byId.set(candidate.memory.id, candidate);
    }
  }
  return [...byId.values()].sort(compareCandidates);
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
    score: candidate.score,
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
