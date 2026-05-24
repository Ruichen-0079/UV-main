export type ProviderHealth = {
  provider: string;
  name?: string;
  capability?: string;
  status: "healthy" | "degraded" | "unavailable";
  checkedAt?: string;
  message?: string;
  configured?: boolean;
  available?: boolean;
  mock?: boolean;
  mode?: "real" | "mock" | "unavailable";
  mockAllowed?: boolean;
  missingFields?: string[];
  required?: boolean;
  baseUrl?: string;
  model?: string;
  dimensions?: number;
  semanticEmbedding?: boolean;
  embeddingNote?: string;
};

export type HealthResponse = {
  ok: boolean;
  service: string;
  runtimeMode?: string;
  server: { status: string };
  database: {
    status: "healthy" | "degraded" | "unavailable";
    message?: string;
  };
  providers: {
    chat: ProviderHealth;
    optional: {
      reasoning?: ProviderHealth;
      tts: ProviderHealth;
      stt: ProviderHealth;
      vision: ProviderHealth;
      embedding: ProviderHealth;
    };
  };
};

export type RuntimeEvent = {
  id: string;
  traceId: string;
  type: string;
  timestamp?: string;
  createdAt?: string;
  payload: Record<string, unknown>;
};

export type TokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type ProviderCallMetadata = {
  name: string;
  capability: string;
  model?: string;
  mock: boolean;
  latencyMs?: number;
  tokenUsage?: TokenUsage;
  healthStatus?: string;
};

export type DashboardWebSocketMessage =
  | RuntimeEvent
  | {
      kind: "dashboard.connected";
      traceId: string;
      timestamp: string;
      payload: {
        message: string;
      };
    };

export type SendMessageRequest = {
  sessionId: string;
  text: string;
  options: {
    useMemory?: boolean;
    readMemory?: boolean;
    writeMemory?: boolean;
    voiceOutput: boolean;
    promptPreview?: boolean;
  };
};

export type MessageResponse = RuntimeEvent & {
  reply: string;
  promptPreview?: PromptPreviewResponse["promptPreview"];
  provider?: ProviderCallMetadata;
  memory?: {
    legacyUseMemory?: boolean;
    readMemory: boolean;
    writeMemory: boolean;
    memoryReadEnabled: boolean;
    memoryWriteEnabled: boolean;
  };
  payload: {
    sessionId?: string;
    content?: string;
    provider?: ProviderCallMetadata;
    traceId?: string;
    audio?: unknown;
  };
};

export type MemoryRecord = {
  id: string;
  type: string;
  subtype?: string | null;
  scope?: "user" | "project" | "agent" | "plugin" | "session";
  scopeId?: string | null;
  memoryLayer?: "core" | "recall" | "archival" | "working";
  status?: "active" | "superseded" | "archived" | "forgotten" | "expired";
  content: string;
  summary?: string | null;
  importance: number;
  emotionValence?: number;
  emotionArousal?: number;
  source: string;
  sourceTraceId?: string | null;
  metadata?: Record<string, unknown>;
  tags: string[];
  createdAt: string;
  updatedAt?: string;
  observedAt?: string;
  eventTime?: string | null;
  validFrom?: string;
  validUntil?: string | null;
  expiresAt?: string | null;
  lastAccessedAt?: string;
  supersededAt?: string | null;
  supersedes?: string[];
  supersededBy?: string | null;
  contradicts?: string[];
  embedding?: null;
  embeddingModel?: string | null;
  embeddingProvider?: string | null;
  embeddingDimensions?: number | null;
  embeddedAt?: string | null;
  hasEmbedding?: boolean;
  semanticEmbedding?: boolean;
  embeddingError?: string;
};

export type CreateMemoryRequest = {
  type: string;
  subtype?: string | null;
  scope?: string;
  scopeId?: string | null;
  memoryLayer?: string;
  status?: string;
  content: string;
  summary?: string;
  importance?: number;
  source: string;
  sourceTraceId?: string | null;
  metadata?: Record<string, unknown>;
  tags: string[];
  observedAt?: string | null;
  eventTime?: string | null;
  validFrom?: string | null;
  validUntil?: string | null;
  expiresAt?: string | null;
  supersedes?: string[];
  supersededBy?: string | null;
  contradicts?: string[];
};

export type UpdateMemoryRequest = {
  type?: string;
  subtype?: string | null;
  scope?: string;
  scopeId?: string | null;
  memoryLayer?: string;
  status?: string;
  content?: string;
  summary?: string | null;
  importance?: number;
  emotionValence?: number;
  emotionArousal?: number;
  metadata?: Record<string, unknown>;
  tags?: string[];
  observedAt?: string | null;
  eventTime?: string | null;
  validFrom?: string | null;
  validUntil?: string | null;
  expiresAt?: string | null;
  supersededAt?: string | null;
  supersedes?: string[];
  supersededBy?: string | null;
  contradicts?: string[];
};

export type MemoryCandidateReview = {
  id: string;
  traceId: string;
  timestamp: string;
  type: string;
  subtype?: string | null;
  scope?: string;
  scopeId?: string | null;
  memoryLayer?: string;
  content: string;
  contentPreview: string;
  summary?: string | null;
  importance: number;
  confidence?: number;
  tags: string[];
  reason: string;
  decision: "stored" | "rejected";
  rejectedReason?: string;
  source?: string;
  sourceTraceId?: string | null;
  storedMemoryId?: string;
  createdAt?: string;
  extractorMode?: string;
  extractorProvider?: string;
  fallbackUsed?: boolean;
  metadata?: Record<string, unknown>;
  observedAt?: string | null;
  eventTime?: string | null;
  validFrom?: string | null;
  validUntil?: string | null;
  expiresAt?: string | null;
  possibleSupersedes?: string[];
  possibleContradictions?: string[];
  relationshipConfidence?: number;
  relationshipReason?: string;
};

export type AcceptMemoryCandidateRequest = Partial<
  Pick<
    MemoryCandidateReview,
    | "type"
    | "subtype"
    | "scope"
    | "scopeId"
    | "memoryLayer"
    | "content"
    | "summary"
    | "importance"
    | "tags"
    | "observedAt"
    | "eventTime"
    | "validFrom"
    | "validUntil"
    | "expiresAt"
    | "possibleSupersedes"
    | "possibleContradictions"
  >
>;

export type ProvidersStatusResponse = {
  providers: {
    chat: ProviderHealth;
    reasoning: ProviderHealth;
    tts: ProviderHealth;
    stt: ProviderHealth;
    vision: ProviderHealth;
    embedding: ProviderHealth;
  };
};

export type ProviderVerificationResponse = {
  ok: boolean;
  provider: string;
  capability: "chat" | "reasoning" | "embedding";
  model?: string;
  dimensions?: number;
  expectedDimensions?: number;
  actualDimensions?: number | null;
  configuredDimensions?: number;
  semanticEmbedding?: boolean;
  mock: boolean;
  latencyMs?: number;
  tokenUsage?: TokenUsage;
  error?: string;
};

export type RetrievedMemoryDebug = {
  id: string;
  type: string;
  subtype?: string | null;
  scope?: string;
  scopeId?: string | null;
  memoryLayer?: string;
  status?: string;
  source: string;
  sourceTraceId: string | null;
  metadata?: Record<string, unknown>;
  importance: number;
  createdAt: string;
  observedAt?: string;
  validFrom?: string;
  validUntil?: string | null;
  expiresAt?: string | null;
  supersededAt?: string | null;
  lastAccessedAt?: string;
  displayText: string;
  hasEmbedding: boolean;
  embeddingProvider?: string | null;
  embeddingModel?: string | null;
  embeddingDimensions?: number | null;
  embeddedAt?: string | null;
  semanticEmbedding?: boolean;
  embeddingError?: string;
  matchedBy?:
    | "vector"
    | "content"
    | "summary"
    | "tag"
    | "type"
    | "subtype"
    | "scope"
    | "metadata"
    | "source"
    | "keyword"
    | "fallback";
  score?: number;
  retrievalMode?: string;
  vectorScore?: number;
  keywordScore?: number;
  hybridScore?: number;
  rankComponents?: {
    vectorScore?: number;
    hybridScore?: number;
    keywordScore?: number;
    tagScore?: number;
    trigramScore?: number;
    fullTextScore?: number;
    scopeScore?: number;
    recencyScore?: number;
    importanceScore?: number;
  };
  excludedReason?: string;
};

export type PromptPreviewResponse = {
  mock: boolean;
  message?: string;
  traceId?: string;
  timestamp?: string;
  userMessage?: string;
  legacyUseMemory?: boolean;
  useMemory?: boolean;
  readMemory?: boolean;
  writeMemory?: boolean;
  memoryReadEnabled?: boolean;
  memoryWriteEnabled?: boolean;
  memoryRepository?: string;
  memoryExtractorMode?: string;
  memoryExtractorActive?: string;
  memoryExtractorUsed?: boolean;
  memoryExtractorProvider?: string;
  memoryExtractionCandidateCount?: number;
  storedMemoryCount?: number;
  rejectedMemoryCount?: number;
  rejectedReasons?: string[];
  fallbackUsed?: boolean;
  llmExtractionError?: string;
  llmExtractionRawPreview?: string;
  validationIssues?: string[];
  memoryExtractionSkippedReason?: string;
  memoryCandidates?: MemoryCandidateReview[];
  retrievedMemoryCountRaw?: number;
  retrievedMemoryCount?: number;
  retrievalMode?: string;
  vectorEnabled?: boolean;
  vectorUsed?: boolean;
  embeddingProvider?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  semanticEmbedding?: boolean;
  embeddingNote?: string;
  queryEmbeddingGenerated?: boolean;
  vectorResultCount?: number;
  keywordResultCount?: number;
  hybridResultCount?: number;
  retrievalFallbackUsed?: boolean;
  retrievalFallbackReason?: string;
  retrievalScope?: string;
  includedScopes?: Array<{ scope: string; scopeId?: string | null }>;
  includeArchived?: boolean;
  includeSuperseded?: boolean;
  includeExpired?: boolean;
  includeHistoricalEpisodic?: boolean;
  currentTime?: string;
  directContextEnabled?: boolean;
  directContextTurnCount?: number;
  directContextCharCount?: number;
  directContextTruncated?: boolean;
  directContextSource?: string;
  excludedByStatus?: number;
  excludedByTime?: number;
  excludedByScope?: number;
  retrievedMemories?: RetrievedMemoryDebug[];
  providerName?: string;
  providerModel?: string;
  providerMock?: boolean;
  providerLatencyMs?: number;
  providerHealthStatus?: string;
  tokenUsage?: TokenUsage;
  promptPreview: null | {
    traceId?: string;
    timestamp?: string;
    userMessage?: string;
    legacyUseMemory?: boolean;
    useMemory?: boolean;
    readMemory?: boolean;
    writeMemory?: boolean;
    memoryReadEnabled?: boolean;
    memoryWriteEnabled?: boolean;
    memoryRepository?: string;
    memoryExtractorMode?: string;
    memoryExtractorActive?: string;
    memoryExtractorUsed?: boolean;
    memoryExtractorProvider?: string;
    memoryExtractionCandidateCount?: number;
    storedMemoryCount?: number;
    rejectedMemoryCount?: number;
    rejectedReasons?: string[];
    fallbackUsed?: boolean;
    llmExtractionError?: string;
    llmExtractionRawPreview?: string;
    validationIssues?: string[];
    memoryExtractionSkippedReason?: string;
    memoryCandidates?: MemoryCandidateReview[];
    retrievedMemoryCountRaw?: number;
    retrievedMemoryCount?: number;
    retrievalMode?: string;
    vectorEnabled?: boolean;
    vectorUsed?: boolean;
    embeddingProvider?: string;
    embeddingModel?: string;
    embeddingDimensions?: number;
    semanticEmbedding?: boolean;
    embeddingNote?: string;
    queryEmbeddingGenerated?: boolean;
    vectorResultCount?: number;
    keywordResultCount?: number;
    hybridResultCount?: number;
    retrievalFallbackUsed?: boolean;
    retrievalFallbackReason?: string;
    retrievalScope?: string;
    includedScopes?: Array<{ scope: string; scopeId?: string | null }>;
    includeArchived?: boolean;
    includeSuperseded?: boolean;
    includeExpired?: boolean;
    includeHistoricalEpisodic?: boolean;
    currentTime?: string;
    directContextEnabled?: boolean;
    directContextTurnCount?: number;
    directContextCharCount?: number;
    directContextTruncated?: boolean;
    directContextSource?: string;
    excludedByStatus?: number;
    excludedByTime?: number;
    excludedByScope?: number;
    retrievedMemories?: RetrievedMemoryDebug[];
    sections: Array<{
      name: string;
      content: string;
      priority: number;
      stable: boolean;
    }>;
    prompt?: string;
    finalPrompt?: string;
    finalMessages?: Array<{ role: string; content: string }>;
    characterCount: number;
    estimatedTokens: number;
    truncated: boolean;
    providerName?: string;
    providerModel?: string;
    providerMock?: boolean;
    providerLatencyMs?: number;
    providerHealthStatus?: string;
    tokenUsage?: TokenUsage;
  };
};

export type RuntimeSettingsResponse = {
  configFiles: {
    ".env": {
      exists: boolean;
      gitIgnored: boolean;
      path?: string;
    };
    ".env.local": {
      exists: boolean;
      gitIgnored: boolean;
      path?: string;
    };
  };
  baseConfig: Record<string, unknown>;
  localOverrideConfig: Record<string, unknown>;
  effectiveConfig: Record<string, unknown>;
  activeRuntimeConfig: {
    serverHost: string;
    serverPort: number;
    eventBus: string;
    memoryRepository: string;
    memoryExtractor?: string;
    memoryExtractorActive?: string;
    providers: {
      chat: ProviderHealth;
      reasoning: ProviderHealth;
      embedding?: ProviderHealth;
    };
  };
  settings: Record<string, LayeredSetting>;
  runtime: {
    serverHost: string;
    serverPort: number;
    activeServerHost: string;
    activeServerPort: number;
    runtimeMode: string;
    eventBus: string;
    activeEventBus: string;
    providerAllowMocks?: boolean;
    pendingRestart: boolean;
  };
  memory: {
    memoryRepository: string;
    activeMemoryRepository: string;
    databaseUrlConfigured: boolean;
    restartRequiredForChanges: boolean;
    postgresRequiresDatabaseUrl: boolean;
    postgresMigrationReminder: string;
    memoryExtractor?: string;
    activeMemoryExtractor?: string;
    memoryExtractorActive?: string;
    memoryExtractorDefault?: string;
    memoryExtractorFallbackUsed?: boolean;
    memoryExtractorSkippedReason?: string;
    reasoningProviderConfigured?: boolean;
  };
  providers: {
    deepseek: {
      baseUrl: string;
      apiKeyConfigured: boolean;
      apiKeyPreview?: string;
      chatModel: string;
      reasoningModel: string;
      status?: {
        chat: ProviderHealth;
        reasoning: ProviderHealth;
      };
    };
    xai: {
      baseUrl: string;
      apiKeyConfigured: boolean;
      apiKeyPreview?: string;
      ttsModel: string;
      ttsVoice: string;
      visionModel: string;
      optional: boolean;
      implemented: boolean;
    };
    dashscope: {
      baseUrl: string;
      apiKeyConfigured: boolean;
      apiKeyPreview?: string;
      sttModel: string;
      optional: boolean;
      implemented: boolean;
    };
    embedding: {
      provider: string;
      baseUrl: string;
      apiKeyConfigured: boolean;
      apiKeyPreview?: string;
      model: string;
      dimensions: string;
      status?: ProviderHealth;
    };
  };
  restartRequired: boolean;
  editableKeys: string[];
};

export type LayeredSetting =
  | {
      base: string;
      localOverride: string;
      effective: string;
      source: string;
    }
  | {
      baseConfigured: boolean;
      localOverrideConfigured: boolean;
      effectiveConfigured: boolean;
      maskedValue?: string;
      source: string;
    };

export type RuntimeSettingsUpdateRequest = {
  values: Record<string, string | null>;
};

export type RuntimeSettingsUpdateResponse = {
  ok: boolean;
  restartRequired: boolean;
  changedKeys: string[];
  settings: RuntimeSettingsResponse;
};

export type RuntimeSettingsReloadResponse = {
  ok: boolean;
  applied: boolean;
  restartRequired: boolean;
  active: {
    providers: ProvidersStatusResponse["providers"];
    memoryRepository: string;
  };
  notHotReloaded: string[];
  message: string;
  settings: RuntimeSettingsResponse;
};

const apiBaseUrl = import.meta.env["VITE_API_BASE_URL"] ?? "/api";
const explicitWebSocketBaseUrl = import.meta.env["VITE_WS_BASE_URL"] as string | undefined;
let dashboardDevToken = "";

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export const apiClient = {
  setDashboardDevToken(token: string): void {
    dashboardDevToken = token;
  },

  getDashboardDevTokenConfigured(): boolean {
    return dashboardDevToken.length > 0;
  },

  getHealth(): Promise<HealthResponse> {
    return request<HealthResponse>("/health");
  },

  sendMessage(input: SendMessageRequest): Promise<MessageResponse> {
    return request<MessageResponse>("/message", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  listRecentMemories(limit = 20): Promise<{ memories: MemoryRecord[] }> {
    return request<{ memories: MemoryRecord[] }>(`/memory/recent?limit=${limit}`);
  },

  searchMemories(
    query: string,
    options: {
      type?: string;
      subtype?: string;
      source?: string;
      scope?: string;
      scopeId?: string;
      memoryLayer?: string;
      status?: string;
      tags?: string;
      minImportance?: string;
      includeArchived?: boolean;
      includeSuperseded?: boolean;
      includeExpired?: boolean;
      includeHistoricalEpisodic?: boolean;
      limit?: number;
    } = {}
  ): Promise<{
    mock: boolean;
    memories: MemoryRecord[];
    rawCount?: number;
    count?: number;
    retrievalMode?: string;
    vectorEnabled?: boolean;
    vectorUsed?: boolean;
    embeddingProvider?: string;
    embeddingModel?: string;
    embeddingDimensions?: number;
    semanticEmbedding?: boolean;
    embeddingNote?: string;
    queryEmbeddingGenerated?: boolean;
    vectorResultCount?: number;
    keywordResultCount?: number;
    hybridResultCount?: number;
    fallbackUsed?: boolean;
    fallbackReason?: string;
    retrievalScope?: string;
    includedScopes?: Array<{ scope: string; scopeId?: string | null }>;
    includeArchived?: boolean;
    includeSuperseded?: boolean;
    includeExpired?: boolean;
    includeHistoricalEpisodic?: boolean;
    excludedByStatus?: number;
    excludedByTime?: number;
    excludedByScope?: number;
    debugMemories?: RetrievedMemoryDebug[];
    query?: string;
    repository?: string;
  }> {
    const body: Record<string, string | number | boolean> = {
      q: query,
      limit: String(options.limit ?? 20)
    };
    if (options.type && options.type !== "all") {
      body["type"] = options.type;
    }
    if (options.subtype && options.subtype !== "all") {
      body["subtype"] = options.subtype;
    }
    if (options.source && options.source !== "all") {
      body["source"] = options.source;
    }
    if (options.scope && options.scope !== "all") {
      body["scope"] = options.scope;
    }
    if (options.scopeId?.trim()) {
      body["scopeId"] = options.scopeId.trim();
    }
    if (options.memoryLayer && options.memoryLayer !== "all") {
      body["memoryLayer"] = options.memoryLayer;
    }
    if (options.status && options.status !== "all") {
      body["status"] = options.status;
    }
    if (options.tags?.trim()) {
      body["tags"] = options.tags.trim();
    }
    if (options.minImportance?.trim()) {
      body["minImportance"] = options.minImportance.trim();
    }
    if (options.includeArchived) {
      body["includeArchived"] = true;
    }
    if (options.includeSuperseded) {
      body["includeSuperseded"] = true;
    }
    if (options.includeExpired) {
      body["includeExpired"] = true;
    }
    if (options.includeHistoricalEpisodic) {
      body["includeHistoricalEpisodic"] = true;
    }

    return request<{
      mock: boolean;
      memories: MemoryRecord[];
      rawCount?: number;
      count?: number;
      retrievalMode?: string;
      vectorEnabled?: boolean;
      vectorUsed?: boolean;
      embeddingProvider?: string;
      embeddingModel?: string;
      embeddingDimensions?: number;
      semanticEmbedding?: boolean;
      embeddingNote?: string;
      queryEmbeddingGenerated?: boolean;
      vectorResultCount?: number;
      keywordResultCount?: number;
      hybridResultCount?: number;
      fallbackUsed?: boolean;
      fallbackReason?: string;
      retrievalScope?: string;
      includedScopes?: Array<{ scope: string; scopeId?: string | null }>;
      includeArchived?: boolean;
      includeSuperseded?: boolean;
      includeExpired?: boolean;
      includeHistoricalEpisodic?: boolean;
      excludedByStatus?: number;
      excludedByTime?: number;
      excludedByScope?: number;
      debugMemories?: RetrievedMemoryDebug[];
      query?: string;
      repository?: string;
    }>("/memory/search", {
      method: "POST",
      body: JSON.stringify(body)
    });
  },

  createMemory(input: CreateMemoryRequest): Promise<MemoryRecord> {
    return request<MemoryRecord>("/memory", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  getMemory(id: string): Promise<MemoryRecord> {
    return request<MemoryRecord>(`/memory/${encodeURIComponent(id)}`);
  },

  updateMemory(id: string, input: UpdateMemoryRequest): Promise<MemoryRecord> {
    return request<MemoryRecord>(`/memory/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    });
  },

  deleteMemory(id: string): Promise<{ ok: boolean; id: string }> {
    return request<{ ok: boolean; id: string }>(`/memory/${encodeURIComponent(id)}`, {
      method: "DELETE"
    });
  },

  archiveMemory(id: string): Promise<{ ok: boolean; id: string; memory: MemoryRecord }> {
    return request<{ ok: boolean; id: string; memory: MemoryRecord }>(
      `/memory/${encodeURIComponent(id)}/archive`,
      { method: "POST" }
    );
  },

  restoreMemory(id: string): Promise<{ ok: boolean; id: string; memory: MemoryRecord }> {
    return request<{ ok: boolean; id: string; memory: MemoryRecord }>(
      `/memory/${encodeURIComponent(id)}/restore`,
      { method: "POST" }
    );
  },

  forgetMemory(id: string): Promise<{ ok: boolean; id: string; memory: MemoryRecord }> {
    return request<{ ok: boolean; id: string; memory: MemoryRecord }>(
      `/memory/${encodeURIComponent(id)}/forget`,
      { method: "POST" }
    );
  },

  bulkDeleteMemories(ids: string[]): Promise<{ ok: boolean; deleted: number }> {
    return request<{ ok: boolean; deleted: number }>("/memory/bulk-delete", {
      method: "POST",
      body: JSON.stringify({ ids })
    });
  },

  listRecentMemoryCandidates(limit = 20): Promise<{
    mock: boolean;
    volatile: boolean;
    message?: string;
    count: number;
    storedCount: number;
    rejectedCount: number;
    candidateCount: number;
    fallbackUsed: boolean;
    candidates: MemoryCandidateReview[];
  }> {
    return request<{
      mock: boolean;
      volatile: boolean;
      message?: string;
      count: number;
      storedCount: number;
      rejectedCount: number;
      candidateCount: number;
      fallbackUsed: boolean;
      candidates: MemoryCandidateReview[];
    }>(`/memory/candidates/recent?limit=${limit}`);
  },

  acceptMemoryCandidate(
    id: string,
    input: AcceptMemoryCandidateRequest
  ): Promise<{
    ok: boolean;
    alreadyStored?: boolean;
    message?: string;
    memoryId?: string;
    memory: MemoryRecord | null;
  }> {
    return request<{
      ok: boolean;
      alreadyStored?: boolean;
      message?: string;
      memoryId?: string;
      memory: MemoryRecord | null;
    }>(`/memory/candidates/${encodeURIComponent(id)}/accept`, {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  rejectMemoryCandidate(
    id: string,
    reason?: string
  ): Promise<{ ok: boolean; candidate: MemoryCandidateReview }> {
    return request<{ ok: boolean; candidate: MemoryCandidateReview }>(
      `/memory/candidates/${encodeURIComponent(id)}/reject`,
      {
        method: "POST",
        body: JSON.stringify(reason ? { reason } : {})
      }
    );
  },

  getProviderStatus(): Promise<ProvidersStatusResponse> {
    return request<ProvidersStatusResponse>("/providers/status");
  },

  verifyProvider(
    capability: "chat" | "reasoning" | "embedding"
  ): Promise<ProviderVerificationResponse> {
    return request<ProviderVerificationResponse>(`/providers/verify/${capability}`, {
      method: "POST"
    });
  },

  listRecentEvents(limit = 50): Promise<{ mock: boolean; events: RuntimeEvent[] }> {
    return request<{ mock: boolean; events: RuntimeEvent[] }>(`/events/recent?limit=${limit}`);
  },

  getLatestPromptPreview(): Promise<PromptPreviewResponse> {
    return request<PromptPreviewResponse>("/debug/prompt/latest");
  },

  getRuntimeSettings(): Promise<RuntimeSettingsResponse> {
    return request<RuntimeSettingsResponse>("/settings/runtime");
  },

  updateRuntimeSettings(
    input: RuntimeSettingsUpdateRequest
  ): Promise<RuntimeSettingsUpdateResponse> {
    return request<RuntimeSettingsUpdateResponse>("/settings/runtime", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  reloadRuntimeSettings(): Promise<RuntimeSettingsReloadResponse> {
    return request<RuntimeSettingsReloadResponse>("/settings/runtime/reload", {
      method: "POST"
    });
  },

  createDashboardWebSocket(): WebSocket {
    return new WebSocket(getWebSocketUrl("/ws?dashboard=true"));
  }
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (dashboardDevToken && shouldAttachDashboardDevToken(path, init?.method)) {
    headers.set("x-yuvi-dev-token", dashboardDevToken);
  }

  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers
  });

  if (!response.ok) {
    const text = await response.text();
    throw new ApiError(text || response.statusText, response.status);
  }

  return response.json() as Promise<T>;
}

function shouldAttachDashboardDevToken(path: string, method: string | undefined): boolean {
  if (path.startsWith("/memory/candidates")) {
    return true;
  }
  const normalized = method?.toUpperCase() ?? "GET";
  return normalized !== "GET" && normalized !== "HEAD" && normalized !== "OPTIONS";
}

function getWebSocketUrl(path: string): string {
  if (explicitWebSocketBaseUrl) {
    return `${explicitWebSocketBaseUrl.replace(/\/$/, "")}${path}`;
  }

  if (apiBaseUrl.startsWith("http://") || apiBaseUrl.startsWith("https://")) {
    return `${apiBaseUrl.replace(/^http/, "ws").replace(/\/$/, "")}${path}`;
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.hostname}:6121${path}`;
}
