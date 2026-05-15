export type ProviderHealth = {
  provider: string;
  status: "healthy" | "degraded" | "unavailable";
  checkedAt?: string;
  message?: string;
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
    useMemory: boolean;
    voiceOutput: boolean;
  };
};

export type MessageResponse = RuntimeEvent & {
  reply: string;
  promptPreview?: PromptPreviewResponse["promptPreview"];
  provider?: string;
  mock?: boolean;
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
  lastAccessedAt?: string;
};

export type CreateMemoryRequest = {
  type: string;
  content: string;
  summary?: string;
  importance?: number;
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
  traceId?: string;
  timestamp?: string;
  userMessage?: string;
  useMemory?: boolean;
  memoryRepository?: string;
  retrievedMemoryCount?: number;
  promptPreview: null | {
    traceId?: string;
    timestamp?: string;
    userMessage?: string;
    useMemory?: boolean;
    memoryRepository?: string;
    retrievedMemoryCount?: number;
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
  };
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

  searchMemories(query: string, options: { type?: string; limit?: number } = {}): Promise<{ mock: boolean; memories: MemoryRecord[] }> {
    const params = new URLSearchParams({
      q: query,
      limit: String(options.limit ?? 20)
    });
    if (options.type && options.type !== "all") {
      params.set("type", options.type);
    }

    return request<{ mock: boolean; memories: MemoryRecord[] }>(`/memory/search?${params.toString()}`);
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
  },

  createDashboardWebSocket(): WebSocket {
    return new WebSocket(getWebSocketUrl("/ws?dashboard=true"));
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
