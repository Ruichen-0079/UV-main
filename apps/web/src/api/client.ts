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
  required?: boolean;
  baseUrl?: string;
  model?: string;
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
  lastAccessedAt?: string;
};

export type CreateMemoryRequest = {
  type: string;
  subtype?: string | null;
  content: string;
  summary?: string;
  importance?: number;
  source: string;
  sourceTraceId?: string | null;
  metadata?: Record<string, unknown>;
  tags: string[];
};

export type UpdateMemoryRequest = {
  type?: string;
  subtype?: string | null;
  content?: string;
  summary?: string | null;
  importance?: number;
  emotionValence?: number;
  emotionArousal?: number;
  metadata?: Record<string, unknown>;
  tags?: string[];
};

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
  capability: "chat" | "reasoning";
  model?: string;
  mock: boolean;
  latencyMs?: number;
  tokenUsage?: TokenUsage;
  error?: string;
};

export type RetrievedMemoryDebug = {
  id: string;
  type: string;
  subtype?: string | null;
  source: string;
  sourceTraceId: string | null;
  metadata?: Record<string, unknown>;
  importance: number;
  createdAt: string;
  displayText: string;
  matchedBy?: "original-query" | "keyword" | "fallback-recent";
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
  memoryExtractionSkippedReason?: string;
  retrievedMemoryCountRaw?: number;
  retrievedMemoryCount?: number;
  retrievalMode?: string;
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
    memoryExtractionSkippedReason?: string;
    retrievedMemoryCountRaw?: number;
    retrievedMemoryCount?: number;
    retrievalMode?: string;
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
    };
    ".env.local": {
      exists: boolean;
      gitIgnored: boolean;
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
    providers: {
      chat: ProviderHealth;
      reasoning: ProviderHealth;
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
    pendingRestart: boolean;
  };
  memory: {
    memoryRepository: string;
    activeMemoryRepository: string;
    databaseUrlConfigured: boolean;
    restartRequiredForChanges: boolean;
    postgresRequiresDatabaseUrl: boolean;
    postgresMigrationReminder: string;
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

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export const apiClient = {
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
    options: { type?: string; limit?: number } = {}
  ): Promise<{
    mock: boolean;
    memories: MemoryRecord[];
    rawCount?: number;
    count?: number;
    retrievalMode?: string;
    query?: string;
    repository?: string;
  }> {
    const params = new URLSearchParams({
      q: query,
      limit: String(options.limit ?? 20)
    });
    if (options.type && options.type !== "all") {
      params.set("type", options.type);
    }

    return request<{
      mock: boolean;
      memories: MemoryRecord[];
      rawCount?: number;
      count?: number;
      retrievalMode?: string;
      query?: string;
      repository?: string;
    }>(`/memory/search?${params.toString()}`);
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

  bulkDeleteMemories(ids: string[]): Promise<{ ok: boolean; deleted: number }> {
    return request<{ ok: boolean; deleted: number }>("/memory/bulk-delete", {
      method: "POST",
      body: JSON.stringify({ ids })
    });
  },

  getProviderStatus(): Promise<ProvidersStatusResponse> {
    return request<ProvidersStatusResponse>("/providers/status");
  },

  verifyProvider(capability: "chat" | "reasoning"): Promise<ProviderVerificationResponse> {
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
