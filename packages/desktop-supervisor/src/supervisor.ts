import fs from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { buildChildProcessEnv, deriveConfigFromEnv } from "./config.js";
import {
  mem0HealthOk,
  ollamaTagsOk,
  probeHttpHealth,
  probeTcp,
  runtimeHealthOk,
  ttsUpstreamHealthOk,
  ttsWrapperHealthOk
} from "./health.js";
import {
  PROCESS_METADATA_VERSION,
  removeMetadataFile,
  shouldRemoveInvalidMetadata,
  testProcessOwnership,
  writeProcessMetadata
} from "./ownership.js";
import { parseUrlOrigin } from "./paths.js";
import {
  forceKillProcessTree,
  getProcessInfo,
  isProcessAlive,
  requestGracefulStop,
  spawnManagedProcess
} from "./process-windows.js";
import type {
  ManagedServiceSpec,
  ProcessMetadata,
  RuntimeConfigUpdate,
  RuntimeConfigUpdateResult,
  ServiceId,
  ServiceLifecycle,
  ServiceOwnership,
  ServiceSnapshot,
  SupervisorConfig,
  SupervisorSnapshot
} from "./types.js";

type InternalService = {
  spec: ManagedServiceSpec;
  status: ServiceLifecycle;
  ownership: ServiceOwnership;
  summary: string;
  detail: string | null;
  lastError: string | null;
  pid: number | null;
  startedAt: string | null;
  child: ChildProcess | null;
  autoRecovered: boolean;
  op: Promise<void> | null;
};

export type SupervisorListener = (snapshot: SupervisorSnapshot) => void;

/** Secret keys that must never leak into status/config responses. */
const SECRET_ENV_KEYS = new Set(["DEEPSEEK_API_KEY", "DATABASE_URL"]);

export class DesktopSupervisor {
  private readonly services = new Map<ServiceId, InternalService>();
  private shuttingDown = false;
  private readonly listeners = new Set<SupervisorListener>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Snapshot of process.env + initial config.env at construction.
   * Dynamic user overrides never permanently destroy these fallbacks.
   */
  private readonly baseEnv: Record<string, string>;
  /**
   * Keys currently held only by the dynamic user-override layer.
   * Cleared on unset so child env falls back to baseEnv.
   */
  private readonly dynamicOverrideKeys = new Set<string>();
  /** Serializes config updates against service start/restart/stop. */
  private configOp: Promise<void> | null = null;

  constructor(private config: SupervisorConfig) {
    // Base layer: shell/process + bootstrap config.env (e.g. .env files).
    const base: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === "string") base[key] = value;
    }
    for (const [key, value] of Object.entries(config.env)) {
      base[key] = value;
    }
    this.baseEnv = base;

    fs.mkdirSync(config.stateDirectory, { recursive: true });
    for (const spec of this.buildSpecs()) {
      this.services.set(spec.id, {
        spec,
        status: "stopped",
        ownership: "none",
        summary: "Not checked yet",
        detail: null,
        lastError: null,
        pid: null,
        startedAt: null,
        child: null,
        autoRecovered: false,
        op: null
      });
    }
  }

  getConfig(): SupervisorConfig {
    return this.config;
  }

  /**
   * Atomically apply env overrides from Tauri.
   * Non-secret URL/model changes apply in place for the next start/restart.
   * Secret keys that *actually change* schedule a background Runtime reload so
   * Save returns quickly (blocking restart previously froze the Settings UI).
   */
  async applyRuntimeConfig(update: RuntimeConfigUpdate): Promise<RuntimeConfigUpdateResult> {
    if (this.shuttingDown) {
      throw new Error("Supervisor is shutting down.");
    }

    const appliedEnvKeys: string[] = [];
    const unsetEnvKeys: string[] = [];
    let secretsChanged = false;

    await this.withConfigLock(async () => {
      // Wait for in-flight service ops so restart never reads a half-applied map.
      const ops = [...this.services.values()].map((s) => s.op).filter(Boolean) as Promise<void>[];
      if (ops.length > 0) {
        await Promise.allSettled(ops);
      }

      const unset = Array.isArray(update.unsetEnv) ? update.unsetEnv : [];
      for (const rawKey of unset) {
        const key = String(rawKey ?? "").trim();
        if (!key) continue;
        const hadSecret =
          SECRET_ENV_KEYS.has(key) &&
          Boolean(this.config.env[key]?.trim() || this.dynamicOverrideKeys.has(key));
        this.clearDynamicOverride(key);
        unsetEnvKeys.push(key);
        if (hadSecret) secretsChanged = true;
      }

      const incoming = update.env && typeof update.env === "object" ? update.env : {};
      for (const [rawKey, rawValue] of Object.entries(incoming)) {
        const key = String(rawKey ?? "").trim();
        if (!key) continue;
        const value = rawValue == null ? "" : String(rawValue);
        if (value.trim() === "") {
          // Empty means unset, never store blank secrets.
          const hadSecret =
            SECRET_ENV_KEYS.has(key) &&
            Boolean(this.config.env[key]?.trim() || this.dynamicOverrideKeys.has(key));
          this.clearDynamicOverride(key);
          if (!unsetEnvKeys.includes(key)) unsetEnvKeys.push(key);
          if (hadSecret) secretsChanged = true;
          continue;
        }
        const previous = this.config.env[key] ?? "";
        this.config.env[key] = value;
        process.env[key] = value;
        this.dynamicOverrideKeys.add(key);
        appliedEnvKeys.push(key);
        // Only reload Runtime when the secret *value* changes (not every Save re-push).
        if (SECRET_ENV_KEYS.has(key) && previous !== value) {
          secretsChanged = true;
        }
      }

      const derived = deriveConfigFromEnv(this.config.layout, this.config.env);
      // Preserve TTS start commands when the update payload does not re-supply them
      // (Rust only sends user-settings keys, not YUVI_TTS_*_START_COMMAND).
      const keepTtsWrapper = this.config.ttsWrapperStart;
      const keepTtsUpstream = this.config.ttsUpstreamStart;
      Object.assign(this.config, derived);
      if (!derived.ttsWrapperStart && keepTtsWrapper) {
        this.config.ttsWrapperStart = keepTtsWrapper;
      }
      if (!derived.ttsUpstreamStart && keepTtsUpstream) {
        this.config.ttsUpstreamStart = keepTtsUpstream;
      }

      this.rebuildSpecsInPlace();
    });

    const restartedServices: string[] = [];
    if (secretsChanged && !this.shuttingDown) {
      // Do NOT await — HTTP /v1/config must return so Tauri Save does not freeze.
      restartedServices.push("runtime");
      void this.reloadRuntimeAfterSecretChange().catch(() => {
        // Errors surface on the service snapshot; never reject the config ack.
      });
    }

    this.emit();
    return {
      ok: true,
      // Key names only — never values. Secret names may appear so clients know unset ran.
      appliedEnvKeys: appliedEnvKeys.filter((k) => !SECRET_ENV_KEYS.has(k)),
      unsetEnvKeys: [...new Set(unsetEnvKeys)],
      restartedServices,
      updatedAt: new Date().toISOString()
    };
  }

  /**
   * Reload managed Runtime so secret env is present in the child process.
   * Never kills external (unowned) processes — surfaces a clear pending message instead.
   */
  private async reloadRuntimeAfterSecretChange(): Promise<void> {
    const runtime = this.services.get("runtime");
    if (!runtime || this.shuttingDown) return;

    if (runtime.ownership === "external") {
      // Health may be green but that process was not started with our secrets.
      runtime.lastError =
        "Secrets saved, but Runtime is external (another process owns :6121). Free the port or stop the other YUVI instance, then Start Runtime.";
      runtime.summary = "Secrets pending — external Runtime";
      runtime.detail =
        "Managed Runtime must be owned by this Supervisor to inject DEEPSEEK_API_KEY / DATABASE_URL.";
      this.emit();
      return;
    }

    try {
      await this.restartService("runtime");
    } catch (error) {
      runtime.lastError =
        error instanceof Error ? error.message : "Failed to reload Runtime after secret change.";
      runtime.summary = "Secret reload failed";
      this.emit();
    }
  }

  /**
   * Remove a dynamic user override and restore base-env fallback when present.
   * Never leaves a stale dynamic secret in config.env / process.env / child env.
   */
  private clearDynamicOverride(key: string): void {
    this.dynamicOverrideKeys.delete(key);
    const baseValue = this.baseEnv[key];
    if (baseValue !== undefined) {
      this.config.env[key] = baseValue;
      process.env[key] = baseValue;
    } else {
      delete this.config.env[key];
      delete process.env[key];
    }
  }

  /** Effective env for managed child spawn: base + current config overrides + command.env. */
  private effectiveChildEnv(commandEnv: Record<string, string>): NodeJS.ProcessEnv {
    // baseEnv first, then live config.env (includes dynamic overrides or restored base),
    // then per-command env. Do not read live process.env so shell pollution cannot leak.
    return buildChildProcessEnv(
      { ...this.baseEnv, ...this.config.env },
      commandEnv,
      []
    );
  }

  /** Test/helper: env that would be used for the next spawn of a service. */
  resolveSpawnEnv(id: ServiceId): NodeJS.ProcessEnv | null {
    const svc = this.services.get(id);
    if (!svc?.spec.startCommand) return null;
    return this.effectiveChildEnv(svc.spec.startCommand.env);
  }

  /** Test/helper: current health URL for a service after config updates. */
  resolveHealthUrl(id: ServiceId): string | null {
    return this.services.get(id)?.spec.healthUrl ?? null;
  }

  onChange(listener: SupervisorListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): SupervisorSnapshot {
    const services = [...this.services.values()].map((svc) => this.toSnapshot(svc));
    return {
      instanceId: this.config.instanceId,
      shuttingDown: this.shuttingDown,
      services,
      updatedAt: new Date().toISOString()
    };
  }

  startBackgroundRefresh(intervalMs = 5_000): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => {
      void this.refreshAll().catch(() => {
        // keep loop alive
      });
    }, intervalMs);
  }

  stopBackgroundRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  async bootstrap(): Promise<SupervisorSnapshot> {
    if (this.shuttingDown) return this.snapshot();
    // Dependencies first (detect only)
    await this.refreshService("postgres");
    await this.refreshService("ollama");

    if (this.config.autostartRuntime) {
      await this.ensureService("runtime");
    } else {
      await this.refreshService("runtime");
    }

    if (this.config.memoryBackend === "mem0" && this.config.autostartMem0) {
      await this.ensureService("mem0");
    } else {
      await this.refreshService("mem0");
    }

    if (this.config.autostartTts) {
      await this.ensureService("tts_upstream");
      await this.ensureService("tts_wrapper");
    } else {
      await this.refreshService("tts_upstream");
      await this.refreshService("tts_wrapper");
    }

    this.emit();
    return this.snapshot();
  }

  async refreshAll(): Promise<SupervisorSnapshot> {
    for (const id of this.services.keys()) {
      await this.refreshService(id);
    }
    // One controlled auto-recover for owned runtime crash only.
    const runtime = this.services.get("runtime");
    if (
      runtime &&
      !this.shuttingDown &&
      runtime.ownership === "owned" &&
      runtime.status === "unavailable" &&
      !runtime.autoRecovered &&
      this.config.autostartRuntime
    ) {
      runtime.autoRecovered = true;
      await this.ensureService("runtime");
    }
    this.emit();
    return this.snapshot();
  }

  async restartService(id: ServiceId): Promise<SupervisorSnapshot> {
    if (this.shuttingDown) {
      const svc = this.services.get(id);
      if (svc) {
        svc.lastError = "Supervisor is shutting down.";
      }
      return this.snapshot();
    }
    // Serialize against config updates so spawn always sees a consistent env map.
    await this.withConfigLock(async () => {
      const svc = this.require(id);
      await this.queue(svc, async () => {
        svc.status = "restarting";
        svc.summary = "Restarting…";
        this.emit();
        if (svc.ownership === "owned" && svc.pid) {
          await this.stopOwned(svc);
        }
        await this.startManagedIfNeeded(id);
      });
    });
    return this.snapshot();
  }

  async stopService(id: ServiceId): Promise<SupervisorSnapshot> {
    const svc = this.require(id);
    await this.queue(svc, async () => {
      if (svc.ownership !== "owned") {
        svc.lastError = "Refusing to stop external or unmanaged service.";
        svc.summary = "External process is not owned by this instance.";
        this.emit();
        return;
      }
      await this.stopOwned(svc);
      svc.status = "stopped";
      svc.summary = "Stopped by user.";
      svc.ownership = "none";
      this.emit();
    });
    return this.snapshot();
  }

  async ensureService(id: ServiceId): Promise<void> {
    if (this.shuttingDown) return;
    await this.withConfigLock(async () => {
      const svc = this.require(id);
      await this.queue(svc, async () => {
        await this.startManagedIfNeeded(id);
      });
    });
  }

  /**
   * Probe then spawn if needed. Must run inside a service queue (and config lock
   * when racing with applyRuntimeConfig). Does not re-enter queue.
   */
  private async startManagedIfNeeded(id: ServiceId): Promise<void> {
    if (this.shuttingDown) return;
    const svc = this.require(id);
    await this.refreshService(id);
    if (svc.status === "healthy" || svc.status === "degraded") {
      return;
    }
    if (!svc.spec.managed || !svc.spec.startCommand) {
      svc.status = "unavailable";
      svc.summary = svc.spec.managed
        ? "No start command configured."
        : "External dependency — not managed by YUVI.";
      return;
    }
    if (svc.ownership === "external") {
      // Healthy external already handled; if external but unhealthy with protocol mismatch, do not take over.
      if (svc.status === "unavailable" && svc.detail?.includes("protocol")) {
        return;
      }
    }

    svc.status = "starting";
    svc.summary = "Starting…";
    svc.lastError = null;
    this.emit();

    try {
      const spawnEnv = this.effectiveChildEnv(svc.spec.startCommand.env);
      const child = spawnManagedProcess(
        svc.spec.startCommand,
        {
          out: svc.spec.logFile,
          err: `${svc.spec.logFile}.err`
        },
        { env: spawnEnv }
      );
      const pid = child.pid;
      if (!pid) {
        throw new Error("spawn returned no pid");
      }
      // Wait briefly so process creation time is queryable.
      await sleep(200);
      const info = getProcessInfo(pid);
      const startedAt = (info?.createdAtUtc ?? new Date()).toISOString();
      const metadata: ProcessMetadata = {
        schemaVersion: PROCESS_METADATA_VERSION,
        role: svc.spec.role,
        pid,
        repositoryRoot: this.config.repositoryRoot,
        stateDirectory: this.config.stateDirectory,
        commandMarker: svc.spec.startCommand.commandMarker,
        processStartedAtUtc: startedAt,
        createdAtUtc: new Date().toISOString(),
        ownershipToken: this.config.ownershipToken,
        instanceId: this.config.instanceId
      };
      writeProcessMetadata(svc.spec.metadataFile, metadata);
      svc.child = child;
      svc.pid = pid;
      svc.startedAt = startedAt;
      svc.ownership = "owned";

      child.on("exit", () => {
        if (svc.pid === pid) {
          svc.child = null;
          // refresh will mark unavailable/stale
        }
      });

      const ready = await this.waitReady(svc, svc.spec.startTimeoutMs);
      if (!ready) {
        svc.status = "unavailable";
        svc.summary = "Started but readiness timed out.";
        svc.lastError = "readiness timeout";
        // Leave process owned so user can stop/restart; do not kill external-like failures automatically.
        return;
      }
      await this.refreshService(id);
    } catch (error) {
      svc.status = "unavailable";
      svc.summary = "Start failed.";
      svc.lastError = error instanceof Error ? error.message : String(error);
      svc.ownership = "none";
      svc.pid = null;
    }
  }

  async shutdown(): Promise<void> {
    // Idempotent: repeated shutdown is safe.
    if (this.shuttingDown) {
      this.appendExitLog("shutdown already in progress/complete");
      return;
    }
    this.shuttingDown = true;
    this.stopBackgroundRefresh();
    // Wait briefly for in-flight ops (do not block exit forever).
    const ops = [...this.services.values()].map((s) => s.op).filter(Boolean);
    await Promise.race([Promise.allSettled(ops), sleep(1_500)]);

    for (const svc of this.services.values()) {
      // Always try to stop anything we tracked — Windows does not kill children with parent.
      if (svc.pid || svc.child || svc.ownership === "owned") {
        await this.stopOwned(svc);
      }
    }
    this.appendExitLog("shutdown complete");
    this.emit();
  }

  private async stopOwned(svc: InternalService): Promise<void> {
    const trackedPid = svc.pid;
    const child = svc.child;

    // Kill our ChildProcess handle first (best signal we started it).
    if (child && !child.killed) {
      try {
        child.kill();
      } catch {
        // ignore
      }
    }

    const pidCandidates = new Set<number>();
    if (trackedPid && trackedPid > 0) pidCandidates.add(trackedPid);
    if (child?.pid && child.pid > 0) pidCandidates.add(child.pid);

    const metaPid = this.readOwnedPid(svc);
    if (metaPid && metaPid > 0) pidCandidates.add(metaPid);

    for (const processId of pidCandidates) {
      if (!isProcessAlive(processId)) continue;

      const processInfo = getProcessInfo(processId);
      const ownership = testProcessOwnership({
        metadataPath: svc.spec.metadataFile,
        expectedRole: svc.spec.role,
        repositoryRoot: this.config.repositoryRoot,
        stateDirectory: this.config.stateDirectory,
        ownershipToken: this.config.ownershipToken,
        instanceId: this.config.instanceId,
        processInfo
      });

      // Kill when owned OR when we still hold a child handle for this pid (we started it).
      const weStarted = Boolean(child?.pid === processId || trackedPid === processId);
      if (!ownership.owned && !weStarted) {
        continue;
      }

      requestGracefulStop(processId);
      for (let i = 0; i < 8; i += 1) {
        if (!isProcessAlive(processId)) break;
        await sleep(100);
      }
      if (isProcessAlive(processId)) {
        forceKillProcessTree(processId);
        for (let i = 0; i < 8; i += 1) {
          if (!isProcessAlive(processId)) break;
          await sleep(80);
        }
      }
    }

    removeMetadataFile(svc.spec.metadataFile);
    svc.child = null;
    svc.pid = null;
    svc.startedAt = null;
    svc.ownership = "none";
  }

  private async refreshService(id: ServiceId): Promise<void> {
    const svc = this.require(id);
    const now = new Date().toISOString();

    // Ownership first
    const metaPid = this.readOwnedPid(svc);
    const processInfo = metaPid ? getProcessInfo(metaPid) : null;
    const ownership = testProcessOwnership({
      metadataPath: svc.spec.metadataFile,
      expectedRole: svc.spec.role,
      repositoryRoot: this.config.repositoryRoot,
      stateDirectory: this.config.stateDirectory,
      ownershipToken: this.config.ownershipToken,
      instanceId: this.config.instanceId,
      processInfo
    });
    if (shouldRemoveInvalidMetadata(ownership)) {
      removeMetadataFile(svc.spec.metadataFile);
    }
    if (ownership.owned) {
      svc.ownership = "owned";
      svc.pid = ownership.processId;
    } else if (svc.ownership === "owned") {
      svc.ownership = "none";
      svc.pid = null;
    }

    // Health / TCP
    if (svc.spec.tcp && !svc.spec.healthUrl) {
      const tcp = await probeTcp(svc.spec.tcp.host, svc.spec.tcp.port);
      if (tcp.ok) {
        svc.status = "healthy";
        svc.ownership = svc.ownership === "owned" ? "owned" : "external";
        svc.summary = "Reachable";
        svc.detail = tcp.message;
        svc.lastError = null;
      } else {
        svc.status = svc.ownership === "owned" ? "unavailable" : "stopped";
        svc.summary = "Not reachable";
        svc.detail = tcp.message;
        if (svc.ownership !== "owned") svc.ownership = "none";
      }
      void now;
      return;
    }

    if (!svc.spec.healthUrl) {
      svc.status = "stopped";
      svc.summary = "No health endpoint";
      return;
    }

    const health = await probeHttpHealth(svc.spec.healthUrl, {
      validateBody: svc.spec.validateHealthBody
    });

    if (health.ok) {
      svc.status = "healthy";
      svc.summary = ownership.owned ? "Running (owned)" : "Running (external)";
      svc.detail = `latency ${health.latencyMs}ms`;
      svc.lastError = null;
      if (!ownership.owned) {
        svc.ownership = "external";
        svc.pid = null;
      }
      return;
    }

    if (health.statusCode !== null && !health.protocolOk) {
      svc.status = "unavailable";
      svc.summary = "Port busy with unexpected service";
      svc.detail = health.message;
      svc.lastError = health.message;
      // Do not claim ownership / do not kill
      if (!ownership.owned) {
        svc.ownership = "none";
      }
      return;
    }

    if (ownership.owned) {
      svc.status = "unavailable";
      svc.summary = "Owned process not healthy";
      svc.lastError = health.message;
      return;
    }

    svc.status = "stopped";
    svc.ownership = "none";
    svc.summary = "Not running";
    svc.detail = health.message;
    svc.lastError = null;
  }

  private async waitReady(svc: InternalService, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (svc.spec.healthUrl) {
        const health = await probeHttpHealth(svc.spec.healthUrl, {
          validateBody: svc.spec.validateHealthBody,
          timeoutMs: 1_500
        });
        if (health.ok) return true;
      } else if (svc.spec.tcp) {
        const tcp = await probeTcp(svc.spec.tcp.host, svc.spec.tcp.port, 1_000);
        if (tcp.ok) return true;
      }
      await sleep(svc.spec.readinessIntervalMs);
    }
    return false;
  }

  private readOwnedPid(svc: InternalService): number | null {
    try {
      if (!fs.existsSync(svc.spec.metadataFile)) return null;
      const raw = JSON.parse(fs.readFileSync(svc.spec.metadataFile, "utf8")) as { pid?: number };
      return typeof raw.pid === "number" ? raw.pid : null;
    } catch {
      return null;
    }
  }

  private buildSpecs(): ManagedServiceSpec[] {
    const state = this.config.stateDirectory;
    const ttsU = parseUrlOrigin(this.config.ttsUpstreamUrl);
    const ollama = parseUrlOrigin(this.config.ollamaUrl);
    const db = this.config.databaseUrl ? tryParseDb(this.config.databaseUrl) : null;

    return [
      {
        id: "runtime",
        role: "runtime",
        label: "Runtime",
        managed: true,
        autostart: this.config.autostartRuntime,
        healthUrl: `${this.config.runtimeUrl.replace(/\/$/, "")}/health`,
        startTimeoutMs: 45_000,
        readinessIntervalMs: 500,
        startCommand: this.config.runtimeStart,
        metadataFile: path.join(state, "runtime.pid.json"),
        logFile: path.join(state, "runtime.log"),
        validateHealthBody: runtimeHealthOk
      },
      {
        id: "mem0",
        role: "mem0",
        label: "Memory (Mem0)",
        // A Mem0 service without a resolved start command is external/detect-only.
        managed: this.config.memoryBackend === "mem0" && Boolean(this.config.mem0Start),
        autostart:
          this.config.autostartMem0 &&
          this.config.memoryBackend === "mem0" &&
          Boolean(this.config.mem0Start),
        healthUrl: `${this.config.mem0Url.replace(/\/$/, "")}/health`,
        startTimeoutMs: 60_000,
        readinessIntervalMs: 800,
        startCommand: this.config.memoryBackend === "mem0" ? this.config.mem0Start : null,
        metadataFile: path.join(state, "mem0.pid.json"),
        logFile: path.join(state, "mem0.log"),
        validateHealthBody: mem0HealthOk
      },
      {
        id: "ollama",
        role: "ollama",
        label: "Ollama",
        managed: false,
        autostart: false,
        healthUrl: `${(ollama?.origin ?? "http://127.0.0.1:11434").replace(/\/$/, "")}/api/tags`,
        startTimeoutMs: 5_000,
        readinessIntervalMs: 500,
        startCommand: null,
        metadataFile: path.join(state, "ollama.pid.json"),
        logFile: path.join(state, "ollama.log"),
        validateHealthBody: ollamaTagsOk
      },
      {
        id: "postgres",
        role: "postgres",
        label: "PostgreSQL",
        managed: false,
        autostart: false,
        healthUrl: null,
        tcp: db ?? { host: "127.0.0.1", port: 5432 },
        startTimeoutMs: 5_000,
        readinessIntervalMs: 500,
        startCommand: null,
        metadataFile: path.join(state, "postgres.pid.json"),
        logFile: path.join(state, "postgres.log")
      },
      {
        id: "tts_wrapper",
        role: "tts_wrapper",
        label: "TTS (Alice)",
        managed: Boolean(this.config.ttsWrapperStart),
        autostart: this.config.autostartTts && Boolean(this.config.ttsWrapperStart),
        healthUrl: `${this.config.ttsWrapperUrl.replace(/\/$/, "")}/health`,
        startTimeoutMs: 90_000,
        readinessIntervalMs: 1_000,
        startCommand: this.config.ttsWrapperStart,
        metadataFile: path.join(state, "tts-wrapper.pid.json"),
        logFile: path.join(state, "tts-wrapper.log"),
        validateHealthBody: ttsWrapperHealthOk
      },
      {
        id: "tts_upstream",
        role: "tts_upstream",
        label: "TTS upstream",
        managed: Boolean(this.config.ttsUpstreamStart),
        autostart: this.config.autostartTts && Boolean(this.config.ttsUpstreamStart),
        // GPT-SoVITS api_v2 intentionally returns 404 at `/`; use its
        // OpenAPI document to distinguish the expected FastAPI service from
        // an unrelated process listening on the configured port.
        healthUrl: ttsU ? `${ttsU.origin}/openapi.json` : null,
        tcp: ttsU ? { host: ttsU.host, port: ttsU.port } : { host: "127.0.0.1", port: 9880 },
        startTimeoutMs: 90_000,
        readinessIntervalMs: 1_000,
        startCommand: this.config.ttsUpstreamStart,
        metadataFile: path.join(state, "tts-upstream.pid.json"),
        logFile: path.join(state, "tts-upstream.log"),
        validateHealthBody: ttsUpstreamHealthOk
      }
    ];
  }

  /** Replace service specs in place; keep live ownership/pid state. Does not spawn/kill. */
  private rebuildSpecsInPlace(): void {
    for (const next of this.buildSpecs()) {
      const existing = this.services.get(next.id);
      if (existing) {
        existing.spec = next;
      } else {
        this.services.set(next.id, {
          spec: next,
          status: "stopped",
          ownership: "none",
          summary: "Not checked yet",
          detail: null,
          lastError: null,
          pid: null,
          startedAt: null,
          child: null,
          autoRecovered: false,
          op: null
        });
      }
    }
  }

  private async withConfigLock(work: () => Promise<void>): Promise<void> {
    const previous = this.configOp ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.configOp = previous.catch(() => undefined).then(() => gate);
    await previous.catch(() => undefined);
    try {
      await work();
    } finally {
      release();
    }
  }

  private require(id: ServiceId): InternalService {
    const svc = this.services.get(id);
    if (!svc) throw new Error(`unknown service ${id}`);
    return svc;
  }

  private async queue(svc: InternalService, work: () => Promise<void>): Promise<void> {
    const previous = svc.op ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    svc.op = next.then(
      () => undefined,
      () => undefined
    );
    await next;
  }

  private toSnapshot(svc: InternalService): ServiceSnapshot {
    return {
      id: svc.spec.id,
      label: svc.spec.label,
      status: svc.status,
      ownership: svc.ownership,
      url: svc.spec.healthUrl,
      summary: svc.summary,
      detail: svc.detail,
      lastError: svc.lastError,
      pid: svc.ownership === "owned" ? svc.pid : null,
      startedAt: svc.ownership === "owned" ? svc.startedAt : null,
      managed: svc.spec.managed,
      canRestart: svc.spec.managed && Boolean(svc.spec.startCommand) && !this.shuttingDown,
      canStop: svc.ownership === "owned" && !this.shuttingDown,
      checkedAt: new Date().toISOString()
    };
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snap);
      } catch {
        // ignore listener errors
      }
    }
  }

  private appendExitLog(message: string): void {
    try {
      const logPath = path.join(this.config.stateDirectory, "supervisor-exit.log");
      fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`, "utf8");
    } catch {
      // ignore
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tryParseDb(databaseUrl: string): { host: string; port: number } | null {
  try {
    const normalized = databaseUrl.replace(/^postgres(ql)?:/i, "http:");
    const url = new URL(normalized);
    return {
      host: url.hostname || "127.0.0.1",
      port: url.port ? Number(url.port) : 5432
    };
  } catch {
    return null;
  }
}
