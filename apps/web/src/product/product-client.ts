import { apiClient } from "../api/client.js";

export type ProductHealthItem = {
  id: string;
  label: string;
  state: string;
  tone: "ok" | "warn" | "bad" | "idle";
  summary: string;
  detail?: string;
  epistemic?: string;
};

export type ProductOverview = {
  version: string;
  generatedAt: string;
  preferences: {
    appearance: { theme: string; density: string; reducedMotion: boolean };
    general: { rememberLastPage: boolean; lastPage: string; language: string };
    firstRun: { completed: boolean; skipped: boolean };
    diagnostics: { follow: boolean };
  };
  preferencesMalformed: boolean;
  compactHealth: ProductHealthItem[];
  roles: Array<{
    id: string;
    label: string;
    capability: string;
    health: ProductHealthItem;
    fallback?: string;
  }>;
  connections: Array<{
    id: string;
    label: string;
    baseUrl: string;
    apiKeyConfigured: boolean;
    sourceHint: string;
  }>;
  deferredRoles: Array<{
    id: string;
    label: string;
    intended: string;
    status: string;
    reason: string;
  }>;
  memory: ProductMemoryOverview;
  settings: {
    settings: Record<string, LayeredValue>;
    runtime?: { pendingRestart?: boolean; pendingRestartKeys?: string[] };
    providers?: Record<string, Record<string, unknown>>;
  };
};

export type ProductMemoryOverview = {
  backend: string;
  extractor?: string;
  databaseConfigured: boolean;
  ingestion: {
    status: string;
    diagnosticsAvailability?: string;
    pendingCount?: number;
    reconcileRequiredCount?: number;
    terminalFailedCount?: number;
  };
  compression: { classification: string; operational: boolean };
  idleDream: { classification: string; operational: boolean };
};

export type ProductMemorySurface = {
  l0: { name: string; description: string };
  l1: {
    name: string;
    episodes: Array<{
      id: string;
      status: string;
      whatHappened: string;
      startedAt?: string;
      endedAt?: string;
      temporalConfidence?: string;
    }>;
  };
  l2: {
    name: string;
    state: string;
    tone: "ok" | "warn" | "bad" | "idle";
    summary: string;
    epistemic?: string;
    query: string | null;
    events: Array<{ id: string; content: string; kind?: string }>;
  };
  dream: {
    idleClassification: string;
    dueJobs: Array<{
      jobId: string;
      triggerKind: string;
      status: string;
      lastErrorCode?: string;
    }>;
  };
};

export type ProductCapabilitiesSurface = {
  authority: string;
  userConfigurableServers: boolean;
  deferredReason: string;
  version: string;
  capabilities: Array<{ capabilityRef: string; toolName: string }>;
  descriptions: Record<string, string> | Array<{ capabilityRef: string; description: string }>;
};

export type LayeredValue =
  | { effective: string; source: string }
  | { effectiveConfigured: boolean; maskedValue?: string; source: string };

export const productClient = {
  overview(signal?: AbortSignal): Promise<ProductOverview> {
    return apiClient.getProductOverview(signal) as Promise<ProductOverview>;
  },
  savePreferences(patch: Record<string, unknown>): Promise<{ ok: boolean }> {
    return apiClient.saveProductPreferences(patch);
  },
  saveConnections(values: Record<string, string | null>, removeOverrides: string[] = []) {
    return apiClient.saveProductConnections({ values, removeOverrides, apply: true });
  },
  testConnection(connectionId: string) {
    return apiClient.testProductConnection(connectionId);
  },
  discoverModels(connectionId: string) {
    return apiClient.discoverProductModels(connectionId);
  },
  memory(query?: string) {
    return apiClient.getProductMemory(query) as Promise<ProductMemorySurface>;
  },
  capabilities() {
    return apiClient.getProductCapabilities() as Promise<ProductCapabilitiesSurface>;
  },
  testVoice() {
    return apiClient.testProductVoice();
  },
  exportDiagnostics() {
    return apiClient.exportProductDiagnostics();
  }
};
