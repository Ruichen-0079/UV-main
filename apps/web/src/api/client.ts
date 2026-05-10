export type ProviderHealth = {
  provider: string;
  status: "healthy" | "degraded" | "unavailable";
  checkedAt?: string;
  message?: string;
};

export type HealthResponse = {
  ok: boolean;
  service: string;
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

export type MessageResponse = RuntimeEvent & {
  payload: {
    sessionId?: string;
    content?: string;
    traceId?: string;
    audio?: unknown;
  };
};

export type MemoryRecord = {
  id: string;
  type: string;
  content: string;
  summary?: string | null;
  importance: number;
  source: string;
  tags: string[];
  createdAt: string;
  updatedAt?: string;
};

export type CreateMemoryRequest = {
  type: string;
  content: string;
  summary?: string;
  source: string;
  tags: string[];
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

export type PromptPreviewResponse = {
  mock: boolean;
  message?: string;
  promptPreview: null | {
    sections: Array<{
      name: string;
      content: string;
      priority: number;
      stable: boolean;
    }>;
    prompt: string;
    characterCount: number;
    estimatedTokens: number;
    truncated: boolean;
  };
};

const apiBaseUrl = import.meta.env["VITE_API_BASE_URL"] ?? "/api";

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

  sendMessage(input: { sessionId: string; content: string; voiceOutput: boolean }): Promise<MessageResponse> {
    return request<MessageResponse>("/message", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  listRecentMemories(limit = 20): Promise<{ memories: MemoryRecord[] }> {
    return request<{ memories: MemoryRecord[] }>(`/memory/recent?limit=${limit}`);
  },

  createMemory(input: CreateMemoryRequest): Promise<MemoryRecord> {
    return request<MemoryRecord>("/memory", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },

  getProviderStatus(): Promise<ProvidersStatusResponse> {
    return request<ProvidersStatusResponse>("/providers/status");
  },

  listRecentEvents(limit = 50): Promise<{ mock: boolean; events: RuntimeEvent[] }> {
    return request<{ mock: boolean; events: RuntimeEvent[] }>(`/events/recent?limit=${limit}`);
  },

  getLatestPromptPreview(): Promise<PromptPreviewResponse> {
    return request<PromptPreviewResponse>("/debug/prompt/latest");
  }
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new ApiError(text || response.statusText, response.status);
  }

  return response.json() as Promise<T>;
}
