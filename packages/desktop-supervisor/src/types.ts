/**
 * Desktop service orchestration types.
 * Single source of truth for managed Runtime / Mem0 / TTS lifecycle.
 */

export type ServiceId = "runtime" | "mem0" | "tts_wrapper" | "tts_upstream" | "ollama" | "postgres";

export type ServiceLifecycle =
  | "starting"
  | "healthy"
  | "degraded"
  | "unavailable"
  | "stopped"
  | "restarting";

export type ServiceOwnership = "owned" | "external" | "none";

export type ServiceSnapshot = {
  id: ServiceId;
  label: string;
  status: ServiceLifecycle;
  ownership: ServiceOwnership;
  url: string | null;
  /** Safe, user-facing one-liner. Never secrets. */
  summary: string;
  /** Expandable detail; may include non-secret diagnostics. */
  detail: string | null;
  lastError: string | null;
  pid: number | null;
  startedAt: string | null;
  managed: boolean;
  canRestart: boolean;
  canStop: boolean;
  checkedAt: string;
};

export type SupervisorSnapshot = {
  instanceId: string;
  shuttingDown: boolean;
  services: ServiceSnapshot[];
  updatedAt: string;
};

export type ProcessMetadata = {
  schemaVersion: 1;
  role: string;
  pid: number;
  repositoryRoot: string;
  stateDirectory: string;
  commandMarker: string;
  processStartedAtUtc: string;
  createdAtUtc: string;
  /** Unique to this YUVI desktop instance — never kill without matching token. */
  ownershipToken: string;
  instanceId: string;
};

export type OwnershipStatus = "running" | "missing" | "stale" | "mismatch" | "invalid";

export type OwnershipResult = {
  status: OwnershipStatus;
  owned: boolean;
  processId: number;
  message: string;
  metadata: ProcessMetadata | null;
};

export type ProcessInfo = {
  processId: number;
  parentProcessId: number;
  commandLine: string;
  createdAtUtc: Date | null;
};

export type HealthProbeResult = {
  ok: boolean;
  statusCode: number | null;
  /** High-level protocol match (expected JSON shape / keyword). */
  protocolOk: boolean;
  message: string;
  latencyMs: number;
};

export type ManagedServiceSpec = {
  id: ServiceId;
  role: string;
  label: string;
  /** When false, only probe — never spawn. */
  managed: boolean;
  /** Prefer connect if already healthy. */
  autostart: boolean;
  healthUrl: string | null;
  /** Optional host:port for TCP-only dependency checks. */
  tcp?: { host: string; port: number } | undefined;
  startTimeoutMs: number;
  readinessIntervalMs: number;
  /** Spawn definition; null means detect-only. */
  startCommand: StartCommandSpec | null;
  metadataFile: string;
  logFile: string;
  /** Optional health body validator. */
  validateHealthBody?: ((body: unknown) => boolean) | undefined;
};

export type StartCommandSpec = {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** Substring that must appear in the live command line for ownership. */
  commandMarker: string;
};

/**
 * Explicit layout: development uses repo tooling; packaged uses resource tree.
 * Do not fake repositoryRoot to force packaged mode through dev logic.
 */
export type SupervisorLayout =
  | {
      mode: "development";
      repositoryRoot: string;
    }
  | {
      mode: "packaged";
      resourceRoot: string;
      dataRoot: string;
      runtimeManifestPath: string;
    };

export type RuntimeManifest = {
  schemaVersion: 1;
  platform: string;
  arch: string;
  nodeVersion?: string;
  nodeExecutable: string;
  runtimeEntry: string;
};

export type SupervisorConfig = {
  layout: SupervisorLayout;
  /**
   * Ownership / metadata root path.
   * Development: repository root. Packaged: resource root.
   */
  repositoryRoot: string;
  stateDirectory: string;
  instanceId: string;
  ownershipToken: string;
  /**
   * High-entropy control-plane token for Supervisor HTTP write ops.
   * Never log or return this in status snapshots.
   */
  controlToken: string;
  controlHost: string;
  controlPort: number;
  env: Record<string, string>;
  memoryBackend: "mem0" | "legacy";
  autostartRuntime: boolean;
  autostartMem0: boolean;
  autostartTts: boolean;
  runtimeUrl: string;
  mem0Url: string;
  ttsWrapperUrl: string;
  ttsUpstreamUrl: string;
  ollamaUrl: string;
  databaseUrl: string | null;
  runtimeStart: StartCommandSpec | null;
  mem0Start: StartCommandSpec | null;
  ttsWrapperStart: StartCommandSpec | null;
  ttsUpstreamStart: StartCommandSpec | null;
};

/**
 * Runtime config push from Tauri ConfigService.
 * Secrets may appear in `env` for managed services only; never echoed in responses/logs.
 * `unsetEnv` keys must be removed from child process env (not merely left unoverwritten).
 */
export type RuntimeConfigUpdate = {
  env?: Record<string, string> | undefined;
  unsetEnv?: string[] | undefined;
};

/** Redacted ack for POST /v1/config — no secret values. */
export type RuntimeConfigUpdateResult = {
  ok: true;
  appliedEnvKeys: string[];
  unsetEnvKeys: string[];
  updatedAt: string;
};

/** Public endpoint file shape (controlToken is present for Rust only; never sent to React). */
export type ControlEndpointFile = {
  host: string;
  port: number;
  baseUrl: string;
  instanceId: string;
  pid: number;
  startedAt: string;
  /** Opaque token; Rust reads this file, React never does. */
  controlToken: string;
};
