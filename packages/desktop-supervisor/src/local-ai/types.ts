/**
 * Local AI service-manager types.
 * Lifecycle/ownership for processes and systemd units — not AI routing.
 */

export type LocalAiServiceId =
  | "alice"
  | "alice.upstream"
  | "alice.wrapper"
  | "embedding"
  | "stt"
  | "local-llm";

export type LocalAiOwnershipKind = "managed-process" | "systemd-user" | "external" | "none";

export type LocalAiLifecycle = "STOPPED" | "STARTING" | "READY" | "BUSY" | "ERROR";

export type LocalAiStartPolicy = "ALWAYS" | "ON_DEMAND" | "MANUAL";

export type LocalAiServiceKind = "logical" | "leaf";

export type LocalAiResourceUsage = {
  rssBytes: number | null;
  cpuPercent: number | null;
  gpuVramBytes: number | null;
  threads: number | null;
};

export type LocalAiServiceSnapshot = {
  id: LocalAiServiceId;
  label: string;
  kind: LocalAiServiceKind;
  parentId: LocalAiServiceId | null;
  children: LocalAiServiceId[];
  lifecycle: LocalAiLifecycle;
  ownership: LocalAiOwnershipKind;
  startPolicy: LocalAiStartPolicy;
  endpoint: string | null;
  pid: number | null;
  systemdUnit: string | null;
  canStart: boolean;
  canStop: boolean;
  canRestart: boolean;
  canTest: boolean;
  summary: string;
  detail: string | null;
  lastError: string | null;
  resources: LocalAiResourceUsage;
  /** Safe diagnostics only: no API keys, no raw embeddings, no role routing. */
  metadata: Record<string, unknown>;
  checkedAt: string;
};

export type LocalAiCatalogSnapshot = {
  services: LocalAiServiceSnapshot[];
  updatedAt: string;
};

export type LocalAiActionResult = {
  ok: boolean;
  service: LocalAiServiceSnapshot;
  error?: string | undefined;
};

export type LocalAiTestResult = {
  ok: boolean;
  serviceId: LocalAiServiceId;
  latencyMs: number;
  summary: string;
  detail: Record<string, unknown>;
};

export type SpeakerIdentity = "KNOWN" | "UNKNOWN";

export type SpeakerProfilePublic = {
  speakerId: string;
  label: string;
  enrolledAt: string;
};

export type SpeakerIdentifyResult = {
  identity: SpeakerIdentity;
  speakerId: string | null;
  label: string | null;
  score: number | null;
  threshold: number;
};

export type LocalAiManagerConfig = {
  repositoryRoot: string;
  stateDirectory: string;
  instanceId: string;
  ownershipToken: string;
  env: Record<string, string>;
  ttsWrapperUrl: string;
  ttsUpstreamUrl: string;
  embeddingUrl: string;
  embeddingApiKey: string | null;
  embeddingModel: string | null;
  embeddingDimensions: number;
  sttUrl: string;
  sttPython: string | null;
  sttScript: string | null;
  sttModelDir: string;
  localLlmUrl: string | null;
  /** Must be empty or an allowlisted unit. Arbitrary units are rejected. */
  localLlmSystemdUnit: string | null;
};
