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
  "troubleshooting",
  "config",
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

export type UpdateMemoryInput = {
  type?: MemoryType;
  subtype?: MemorySubtype | null;
  content?: string;
  summary?: string | null;
  importance?: number;
  emotionValence?: number;
  emotionArousal?: number;
  metadata?: Record<string, unknown>;
  tags?: string[];
};

export type MemoryCandidate = {
  type: MemoryType;
  subtype?: MemorySubtype | null;
  content: string;
  summary?: string | null;
  importance: number;
  confidence?: number;
  metadata?: Record<string, unknown>;
  tags: string[];
  reason: string;
  sourceTraceId?: string | null;
};

export type MemoryExtractorMode = "rule-based" | "llm";
export type MemoryExtractorActive = "rule-based" | "llm" | "fallback-rule-based" | "disabled";

export type MemoryExtractorStatus = {
  mode: MemoryExtractorMode;
  active: MemoryExtractorActive;
  enabled: boolean;
  provider?: string;
  fallbackUsed?: boolean;
  candidateCount?: number;
  rejectedCount?: number;
  rejectedReasons?: string[];
  error?: string;
  skippedReason?: string;
};

export type MemoryExtractionInput = {
  sessionId?: string | undefined;
  userMessage: string;
  assistantMessage?: string | undefined;
  sourceTraceId?: string | null | undefined;
  timestamp?: string | undefined;
  providerMetadata?:
    | {
        name?: string | undefined;
        capability?: string | undefined;
        model?: string | undefined;
        mock?: boolean | undefined;
        latencyMs?: number | undefined;
      }
    | undefined;
  memoryOptions?:
    | {
        readMemory: boolean;
        writeMemory: boolean;
      }
    | undefined;
};

export type MemoryExtractor = {
  getStatus?(): MemoryExtractorStatus;
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
