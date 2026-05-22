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

export const MemoryScopes = ["user", "project", "agent", "plugin", "session"] as const;
export type MemoryScope = (typeof MemoryScopes)[number];

export const MemoryLayers = ["core", "recall", "archival", "working"] as const;
export type MemoryLayer = (typeof MemoryLayers)[number];

export const MemoryStatuses = ["active", "superseded", "archived", "forgotten", "expired"] as const;
export type MemoryStatus = (typeof MemoryStatuses)[number];

export type Memory = {
  id: string;
  type: MemoryType;
  subtype: MemorySubtype | null;
  scope: MemoryScope;
  scopeId: string | null;
  memoryLayer: MemoryLayer;
  status: MemoryStatus;
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
  observedAt: Date;
  eventTime: Date | null;
  validFrom: Date;
  validUntil: Date | null;
  expiresAt: Date | null;
  lastAccessedAt: Date;
  supersededAt: Date | null;
  supersedes: string[];
  supersededBy: string | null;
  contradicts: string[];
};

export type CreateMemoryInput = {
  type: MemoryType;
  subtype?: MemorySubtype | null;
  scope?: MemoryScope;
  scopeId?: string | null;
  memoryLayer?: MemoryLayer;
  status?: MemoryStatus;
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
  observedAt?: Date | string | null;
  eventTime?: Date | string | null;
  validFrom?: Date | string | null;
  validUntil?: Date | string | null;
  expiresAt?: Date | string | null;
  supersededAt?: Date | string | null;
  supersedes?: string[];
  supersededBy?: string | null;
  contradicts?: string[];
};

export type UpdateMemoryInput = {
  type?: MemoryType;
  subtype?: MemorySubtype | null;
  scope?: MemoryScope;
  scopeId?: string | null;
  memoryLayer?: MemoryLayer;
  status?: MemoryStatus;
  content?: string;
  summary?: string | null;
  importance?: number;
  emotionValence?: number;
  emotionArousal?: number;
  metadata?: Record<string, unknown>;
  tags?: string[];
  observedAt?: Date | string | null;
  eventTime?: Date | string | null;
  validFrom?: Date | string | null;
  validUntil?: Date | string | null;
  expiresAt?: Date | string | null;
  supersededAt?: Date | string | null;
  supersedes?: string[];
  supersededBy?: string | null;
  contradicts?: string[];
};

export type MemoryCandidate = {
  type: MemoryType;
  subtype?: MemorySubtype | null;
  scope?: MemoryScope;
  scopeId?: string | null;
  memoryLayer?: MemoryLayer;
  content: string;
  summary?: string | null;
  importance: number;
  confidence?: number;
  metadata?: Record<string, unknown>;
  tags: string[];
  reason: string;
  sourceTraceId?: string | null;
  observedAt?: Date | string | null;
  eventTime?: Date | string | null;
  validFrom?: Date | string | null;
  validUntil?: Date | string | null;
  expiresAt?: Date | string | null;
  possibleSupersedes?: string[];
  possibleContradictions?: string[];
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
  rawPreview?: string;
  validationIssues?: string[];
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
  scope?: MemoryScope;
  scopeId?: string;
  includeArchived?: boolean;
  includeHistory?: boolean;
  limit?: number;
};

export type MemoryMatchReason =
  | "content"
  | "summary"
  | "tag"
  | "type"
  | "metadata"
  | "source"
  | "keyword"
  | "fallback";
export type MemoryRetrievalMode =
  | "keyword"
  | "postgres-trigram"
  | "hybrid-keyword"
  | "fallback-recent";

export type RetrievedMemoryDebug = {
  id: string;
  type: MemoryType;
  subtype: MemorySubtype | null;
  scope: MemoryScope;
  scopeId: string | null;
  memoryLayer: MemoryLayer;
  status: MemoryStatus;
  source: string;
  sourceTraceId: string | null;
  metadata?: Record<string, unknown>;
  importance: number;
  createdAt: Date;
  observedAt?: Date;
  validFrom?: Date;
  validUntil?: Date | null;
  expiresAt?: Date | null;
  supersededAt?: Date | null;
  displayText: string;
  matchedBy: MemoryMatchReason;
  score?: number;
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
