export const MemoryTypes = [
  "working",
  "episodic",
  "semantic",
  "emotional",
  "procedural",
  "relationship"
] as const;

export type MemoryType = (typeof MemoryTypes)[number];

export const MemorySubtypes = [
  "preference",
  "fact",
  "project",
  "workflow",
  "milestone",
  "provider-choice",
  "path",
  "repo",
  "command",
  "emotion",
  "relationship"
] as const;

export type MemorySubtype = (typeof MemorySubtypes)[number];

export type Memory = {
  id: string;
  type: MemoryType;
  subtype: MemorySubtype | null;
  content: string;
  summary: string | null;
  embedding: number[] | null;
  importance: number;
  emotionValence: number;
  emotionArousal: number;
  source: string;
  sourceTraceId: string | null;
  metadata: Record<string, unknown>;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
  lastAccessedAt: Date;
};

export type CreateMemoryInput = {
  type: MemoryType;
  subtype?: MemorySubtype | null;
  content: string;
  summary?: string | null;
  embedding?: number[] | null;
  importance?: number;
  emotionValence?: number;
  emotionArousal?: number;
  source: string;
  sourceTraceId?: string | null;
  metadata?: Record<string, unknown>;
  tags?: string[];
};

export type MemoryCandidate = {
  type: MemoryType;
  subtype?: MemorySubtype | null;
  content: string;
  summary?: string | null;
  importance: number;
  tags: string[];
  reason: string;
  sourceTraceId?: string | null;
};

export type MemoryExtractionInput = {
  userMessage: string;
  assistantMessage?: string | undefined;
  sourceTraceId?: string | null | undefined;
};

export type MemoryExtractor = {
  extractCandidates(input: MemoryExtractionInput): Promise<MemoryCandidate[]>;
};

export type MemorySearchQuery = {
  text?: string;
  embedding?: number[];
  types?: MemoryType[];
  tags?: string[];
  limit?: number;
};

export type MemoryMatchReason = "original-query" | "keyword" | "fallback-recent";
export type MemoryRetrievalMode = "direct" | "hybrid-keyword" | "fallback-recent";

export type RetrievedMemoryDebug = {
  id: string;
  type: MemoryType;
  subtype: MemorySubtype | null;
  source: string;
  sourceTraceId: string | null;
  metadata?: Record<string, unknown>;
  importance: number;
  createdAt: Date;
  displayText: string;
  matchedBy: MemoryMatchReason;
  excludedReason?: string;
};

export type RetrievedMemoryCandidate = {
  memory: Memory;
  displayText: string;
  matchedBy: MemoryMatchReason;
  score: number;
  excludedReason?: string;
};

export type MemoryRetrievalResult = {
  query: string;
  keywords: string[];
  rawCount: number;
  count: number;
  retrievalMode: MemoryRetrievalMode;
  rawMemories: RetrievedMemoryDebug[];
  memories: RetrievedMemoryDebug[];
  selectedMemories: Memory[];
};

export type Entity = {
  id: string;
  name: string;
  type: string;
  createdAt: Date;
};

export type CreateEntityInput = {
  name: string;
  type: string;
};

export type Relation = {
  id: string;
  sourceEntity: string;
  targetEntity: string;
  relation: string;
  weight: number;
  createdAt: Date;
};

export type CreateRelationInput = {
  sourceEntity: string;
  targetEntity: string;
  relation: string;
  weight?: number;
};

export type MemoryQuery = {
  sessionId?: string;
  text: string;
  limit?: number;
};
