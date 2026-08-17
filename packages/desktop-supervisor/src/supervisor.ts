import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { buildChildProcessEnv, deriveConfigFromEnv } from "./config.js";
import {
  buildPostgresStartCommand,
  ensureYuviDatabase,
  launchWindowsPrivatePostgres,
  pingPostgres,
  pingPostgresServer,
  POSTGRES_LAUNCH_PROCESS_QUERY_TIMEOUT_MS,
  type PostgresLaunchDiagnostic
} from "./postgres-cluster.js";
import {
  adoptSurvivingPostgres,
  postgresDiagnostics,
  preparePrivatePostgres,
  publishListenMetadata
} from "./postgres-lifecycle.js";
import {
  POSTGRES_PASSWORD_ENV,
  redactSecretText,
  resolvePostgresPassword
} from "./postgres-secret.js";
import { selectPrivatePostgresPort } from "./postgres-port.js";
import {
  expectedClusterName,
  readPostmasterPid,
  stopPrivatePostgresIfOwned
} from "./postgres-ownership.js";
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
  readProcessMetadata,
  removeProcessMetadataIfMatches,
  shouldRemoveInvalidMetadata,
  testProcessOwnership,
  writeProcessMetadata
} from "./ownership.js";
import { parseUrlOrigin, pathsEqual } from "./paths.js";
import {
  PRIVATE_POSTGRES_HOST,
  PRIVATE_POSTGRES_MAJOR,
  readClusterMarker,
  readListenMetadata
} from "./postgres-layout.js";
import {
  forceKillProcessTree,
  inspectProcess,
  isProcessAlive,
  requestGracefulStop,
  spawnManagedProcess,
  type ProcessInspectionOptions
} from "./process-windows.js";
import type {
  ManagedServiceSpec,
  PostgresMigrationDiagnostics,
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
import {
  migrateSupervisorTarget,
  migrationSettingsFromEnv,
  resolveSupervisorMigrationTarget
} from "./postgres-migrate.js";
import { MigrationError, type MigrationDiagnostics } from "@companion/memory";

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
  /** Monotonically identifies the currently tracked managed-process generation. */
  generation: number;
  autoRecovered: boolean;
  pendingExternal: boolean;
  op: Promise<void> | null;
};

function safeSqlState(value: string | null | undefined): string | null {
  return typeof value === "string" && /^[0-9A-Z]{5}$/.test(value) ? value : null;
}

function safePostgresServiceErrorCode(value: string | null | undefined): string | null {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : null;
}

export type SupervisorListener = (snapshot: SupervisorSnapshot) => void;

export type SupervisorHooks = {
  inspectProcess?: typeof inspectProcess;
  invokePostgresStop?: (input: {
    layout: NonNullable<SupervisorConfig["postgresLayout"]>;
    distribution: NonNullable<SupervisorConfig["postgresDistribution"]>;
  }) => boolean;
  migratePostgres?: typeof migrateSupervisorTarget;
  platform?: NodeJS.Platform;
  spawnWindowsPgCtl?: import("./postgres-cluster.js").WindowsPgCtlSpawnAsync;
  postmasterSettleTimeoutMs?: number;
  postmasterSettleIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

/** Secret keys that must never leak into status/config responses. */
const SECRET_ENV_KEYS = new Set([
  "DEEPSEEK_API_KEY",
  "DATABASE_URL",
  "MEM0_PG_CONNECTION_STRING",
  "MEM0_LLM_API_KEY",
  POSTGRES_PASSWORD_ENV,
  "PGPASSWORD"
]);

const RUNTIME_RELOAD_KEYS = new Set([
  "DEEPSEEK_API_KEY",
  "DATABASE_URL",
  "MEMORY_BACKEND",
  "MEM0_BASE_URL",
  "MEMORY_SUBJECT_USER_ID",
  "MEMORY_PERSONA_ID"
]);

const MEM0_CONFIG_KEYS = new Set([
  "MEMORY_BACKEND",
  "YUVI_AUTOSTART_MEM0",
  "MEM0_BASE_URL",
  "MEM0_OLLAMA_BASE_URL",
  "DATABASE_URL",
  "MEM0_PG_CONNECTION_STRING",
  "MEM0_LLM_PROVIDER",
  "MEM0_LLM_MODEL",
  "MEM0_LLM_API_KEY",
  "MEM0_LLM_BASE_URL",
  "MEM0_LLM_TEMPERATURE",
  "MEM0_LLM_TIMEOUT_MS",
  "MEM0_REQUEST_TIMEOUT_MS",
  "MEM0_LOG_CONTENT",
  "MEM0_HEALTH_EMBED_CACHE_TTL_S",
  "YUVI_MEM0_DATA_DIR",
  "YUVI_MEM0_LOG_DIR"
]);

type Mem0ReconcileAction = "none" | "start" | "stop" | "restart" | "pending_external";

type ServiceConfigState = {
  spec: ManagedServiceSpec;
  ownership: ServiceOwnership;
  status: ServiceLifecycle;
  effectiveEnv: NodeJS.ProcessEnv | null;
};

type SupervisorConfigState = {
  env: Record<string, string>;
  runtime: ServiceConfigState;
  mem0: ServiceConfigState;
};

type ConfigReconcilePlan = {
  generation: number;
  runtimeChanged: boolean;
  mem0Action: Mem0ReconcileAction;
};

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
  /** Tracks background config reconciliation so updates never overlap. */
  private configReconcileOp: Promise<void> | null = null;
  private configGeneration = 0;
  private readonly lifecycleDiagnostics = process.env["YUVI_SUPERVISOR_DIAGNOSTICS"] === "1";
  private readonly lifecycleStartedAt = process.hrtime.bigint();
  private lifecycleSequence = 0;
  private readonly hooks: SupervisorHooks;
  private migrationDiagnostics: PostgresMigrationDiagnostics | undefined;

  constructor(
    private config: SupervisorConfig,
    hooks: SupervisorHooks = {}
  ) {
    this.hooks = hooks;
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
        generation: 0,
        autoRecovered: false,
        pendingExternal: false,
        op: null
      });
    }
  }

  getConfig(): SupervisorConfig {
    return this.config;
  }

  /**
   * Apply a redacted runtime-config update as one transaction. The HTTP caller
   * only waits for validation and the in-memory commit; service reconciliation
   * is tracked in the background so Save remains responsive.
   */
  async applyRuntimeConfig(update: RuntimeConfigUpdate): Promise<RuntimeConfigUpdateResult> {
    if (this.shuttingDown) {
      throw new Error("Supervisor is shutting down.");
    }
    const previousReconcile = this.configReconcileOp;
    if (previousReconcile) await previousReconcile.catch(() => undefined);
    if (this.shuttingDown) {
      throw new Error("Supervisor is shutting down.");
    }

    const appliedEnvKeys = new Set<string>();
    const unsetEnvKeys = new Set<string>();
    let plan!: ConfigReconcilePlan;

    await this.withConfigLock(async () => {
      const existingReconcile = this.configReconcileOp;
      if (existingReconcile) await existingReconcile.catch(() => undefined);
      // Wait for in-flight service operations so a new plan never races a
      // previous spawn/stop/restart operation.
      const ops = [...this.services.values()].map((s) => s.op).filter(Boolean) as Promise<void>[];
      if (ops.length > 0) await Promise.allSettled(ops);

      const previousState = this.captureConfigState();
      const candidateEnv: Record<string, string> = { ...this.config.env };
      const candidateOverrides = new Set(this.dynamicOverrideKeys);

      const applyUnset = (key: string): void => {
        if (!key) return;
        unsetEnvKeys.add(key);
        candidateOverrides.delete(key);
        const baseValue = this.baseEnv[key];
        if (baseValue !== undefined) candidateEnv[key] = baseValue;
        else delete candidateEnv[key];
      };

      const unset = Array.isArray(update.unsetEnv) ? update.unsetEnv : [];
      for (const rawKey of unset) applyUnset(String(rawKey ?? "").trim());

      const incoming = update.env && typeof update.env === "object" ? update.env : {};
      for (const [rawKey, rawValue] of Object.entries(incoming)) {
        const key = String(rawKey ?? "").trim();
        if (!key) continue;
        const value = rawValue == null ? "" : String(rawValue);
        if (value.trim() === "") {
          applyUnset(key);
          continue;
        }
        candidateEnv[key] = value;
        candidateOverrides.add(key);
        appliedEnvKeys.add(key);
      }

      // Derive everything against the candidate. A malformed managed URL or
      // manifest error therefore leaves the live config/specs untouched.
      const derived = deriveConfigFromEnv(this.config.layout, candidateEnv);
      const preserveMissingFlag = (key: string): boolean =>
        candidateEnv[key] === undefined && !this.dynamicOverrideKeys.has(key);
      const candidateDerived = {
        ...derived,
        // Hand-built SupervisorConfig instances may intentionally provide a
        // false flag without an env key. Preserve that value until the key is
        // explicitly supplied; removing a dynamic override still uses the
        // derive default because it remains in dynamicOverrideKeys currently.
        autostartRuntime: preserveMissingFlag("YUVI_AUTOSTART_RUNTIME")
          ? this.config.autostartRuntime
          : derived.autostartRuntime,
        autostartMem0: preserveMissingFlag("YUVI_AUTOSTART_MEM0")
          ? this.config.autostartMem0
          : derived.autostartMem0,
        autostartTts: preserveMissingFlag("YUVI_AUTOSTART_TTS")
          ? this.config.autostartTts
          : derived.autostartTts,
        // Rust only sends user settings; preserve existing TTS commands when
        // the update does not include their explicit start-command variables.
        ttsWrapperStart: derived.ttsWrapperStart ?? this.config.ttsWrapperStart,
        ttsUpstreamStart: derived.ttsUpstreamStart ?? this.config.ttsUpstreamStart,
        postgresStart: derived.postgresStart ?? this.config.postgresStart
      };

      // Commit synchronously only after all candidate validation succeeds.
      this.config.env = candidateEnv;
      Object.assign(this.config, candidateDerived);
      this.dynamicOverrideKeys.clear();
      for (const key of candidateOverrides) this.dynamicOverrideKeys.add(key);
      this.rebuildSpecsInPlace();
      this.configGeneration += 1;

      const nextState = this.captureConfigState();
      plan = this.buildReconcilePlan(previousState, nextState);
      plan.generation = this.configGeneration;
      if (plan.runtimeChanged || plan.mem0Action !== "none") {
        this.enqueueConfigReconcile(plan);
      }
    });

    this.emit();
    return {
      ok: true,
      appliedEnvKeys: [...appliedEnvKeys].filter((key) => !SECRET_ENV_KEYS.has(key)),
      unsetEnvKeys: [...unsetEnvKeys],
      restartedServices: [
        ...(plan.runtimeChanged ? (["runtime"] as const) : []),
        ...(plan.mem0Action !== "none" ? (["mem0"] as const) : [])
      ],
      updatedAt: new Date().toISOString()
    };
  }

  /** Effective env for managed child spawn: base + current config overrides + command.env. */
  private effectiveChildEnv(
    commandEnv: Record<string, string>,
    serviceId?: ServiceId,
    configEnv = this.config.env
  ): NodeJS.ProcessEnv {
    // baseEnv first, then live config.env (includes dynamic overrides or restored base),
    // then per-command env. Do not read live process.env so shell pollution cannot leak.
    return buildChildProcessEnv(
      { ...this.baseEnv, ...configEnv },
      commandEnv,
      serviceId === "mem0" && this.config.layout.mode === "packaged" ? ["DATABASE_URL"] : []
    );
  }

  /** Test/helper: env that would be used for the next spawn of a service. */
  resolveSpawnEnv(id: ServiceId): NodeJS.ProcessEnv | null {
    const svc = this.services.get(id);
    if (!svc?.spec.startCommand) return null;
    return this.effectiveChildEnv(svc.spec.startCommand.env, id);
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
    const postgres = this.services.get("postgres");
    return {
      instanceId: this.config.instanceId,
      shuttingDown: this.shuttingDown,
      services,
      updatedAt: new Date().toISOString(),
      postgres: {
        ...postgresDiagnostics({
          mode: this.config.postgresMode ?? "external",
          layout: this.config.postgresLayout ?? null,
          distributionError: this.config.postgresDistributionError ?? null,
          ownership: postgres?.ownership ?? "none",
          status: postgres?.status ?? "stopped"
        }),
        migration: this.migrationDiagnostics
      }
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
    if ((this.config.postgresMode ?? "external") === "private") {
      await this.prepareAndStartPrivatePostgres();
    } else {
      await this.refreshService("postgres");
    }
    await this.runSchemaBootstrap();
    await this.refreshService("ollama");

    if (this.config.autostartRuntime) {
      await this.ensureService("runtime");
    } else {
      await this.refreshService("runtime");
    }

    if (
      this.config.memoryBackend === "mem0" &&
      this.config.autostartMem0 &&
      this.memorySearchAllowsMem0()
    ) {
      await this.ensureService("mem0");
    } else {
      await this.refreshService("mem0");
      const mem0 = this.services.get("mem0");
      if (
        mem0 &&
        this.config.autostartMem0 &&
        !this.memorySearchAllowsMem0() &&
        mem0.ownership !== "owned"
      ) {
        mem0.summary = "Memory-search schema is not ready.";
        mem0.lastError =
          this.migrationDiagnostics?.memorySearchErrorCode ??
          this.migrationDiagnostics?.memorySearchStatus ??
          "unavailable";
      }
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
    const mem0 = this.services.get("mem0");
    if (mem0) this.lifecycleEvent("memory.refresh.queued", mem0);
    for (const id of this.services.keys()) {
      const svc = this.services.get(id);
      if (!svc) continue;
      await this.queue(svc, async () => {
        await this.refreshService(id);
      });
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
    if (
      mem0 &&
      !this.shuttingDown &&
      mem0.spec.managed &&
      mem0.spec.autostart &&
      mem0.ownership === "none" &&
      mem0.status === "stopped"
    ) {
      await this.queue(mem0, async () => {
        await this.startManagedIfNeeded("mem0");
      });
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
        if (id === "postgres" && (this.config.postgresMode ?? "external") === "private") {
          const mayExist =
            svc.ownership === "owned" ||
            Boolean(svc.pid) ||
            Boolean(svc.child) ||
            this.privatePostgresHasLiveCandidate() ||
            this.privatePostgresIdentityUnresolved(svc);
          if (mayExist) {
            await this.stopOwned(svc);
            if (!this.privatePostgresQuiescentForRelaunch(svc)) {
              svc.status = "unavailable";
              svc.summary = "Ownership uncertain; refusing to restart PostgreSQL.";
              svc.lastError = svc.lastError ?? "POSTGRES_FENCED_STOP_FAILED";
              if (!this.privatePostgresIdentityUnresolved(svc)) {
                svc.lastError = "POSTGRES_FENCED_STOP_FAILED";
              }
              return;
            }
          }
          await this.startManagedIfNeeded(id);
          return;
        }
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
  private usesDedicatedWindowsPostgresStart(): boolean {
    return (
      (this.hooks.platform ?? process.platform) === "win32" &&
      (this.config.postgresMode ?? "external") === "private"
    );
  }

  private async startManagedIfNeeded(id: ServiceId): Promise<void> {
    if (this.shuttingDown) return;
    if (id === "postgres" && this.usesDedicatedWindowsPostgresStart()) {
      await this.startWindowsPrivatePostgresIfNeeded();
      return;
    }
    const svc = this.require(id);
    this.lifecycleEvent("memory.start.enter", svc);
    await this.refreshService(id);
    if (svc.status === "healthy" || svc.status === "degraded") {
      return;
    }
    // An identity query timeout is not evidence that a live child died. Keep
    // the current managed generation and wait for an explicit restart instead
    // of spawning a second sidecar over the same port.
    if (this.hasLiveManagedChild(svc)) {
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
      const spawnEnv = this.effectiveChildEnv(svc.spec.startCommand.env, id);
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
      const generation = svc.generation + 1;
      svc.generation = generation;
      svc.child = child;
      svc.pid = pid;
      const clearTrackedChild = () => {
        if (svc.generation !== generation || svc.child !== child || svc.pid !== pid) return;
        svc.child = null;
        svc.pid = null;
        svc.startedAt = null;
      };
      child.once("exit", clearTrackedChild);
      child.once("close", clearTrackedChild);
      this.lifecycleEvent("memory.spawn.returned", svc, { pid });
      // Wait briefly so process creation time is queryable.
      await sleep(200);
      const inspection = inspectProcess(pid);
      const startedAt =
        (inspection.status === "resolved" ? inspection.info.createdAtUtc : null) ?? new Date();
      const startedAtIso = startedAt.toISOString();
      svc.startedAt = startedAtIso;
      this.lifecycleEvent("memory.identity.resolved", svc, {
        pid,
        startTime: startedAtIso,
        processInspectionStatus: inspection.status,
        processInspectionReason: inspection.status === "resolved" ? null : inspection.reason
      });
      const metadata: ProcessMetadata = {
        schemaVersion: PROCESS_METADATA_VERSION,
        role: svc.spec.role,
        pid,
        repositoryRoot: this.config.repositoryRoot,
        stateDirectory: this.config.stateDirectory,
        commandMarker: svc.spec.startCommand.commandMarker,
        processStartedAtUtc: startedAtIso,
        createdAtUtc: new Date().toISOString(),
        ownershipToken: this.config.ownershipToken,
        instanceId: this.config.instanceId
      };
      this.lifecycleEvent("memory.metadata.write.begin", svc, { pid, startTime: startedAt });
      writeProcessMetadata(svc.spec.metadataFile, metadata, {
        onTempWritten: () => this.lifecycleEvent("memory.metadata.temp.written", svc),
        onRenameCompleted: () => this.lifecycleEvent("memory.metadata.rename.completed", svc),
        onCleanup: () => this.lifecycleEvent("memory.metadata.cleanup", svc)
      });
      const readback = readProcessMetadata(svc.spec.metadataFile);
      this.lifecycleEvent("memory.metadata.readback.completed", svc, {
        metadataExists: Boolean(readback),
        pid: readback?.pid ?? 0
      });
      if (!readback || readback.pid !== pid || readback.instanceId !== this.config.instanceId) {
        throw new Error("ownership metadata readback failed");
      }
      svc.ownership = "owned";
      svc.pendingExternal = false;
      this.lifecycleEvent("memory.owned.published", svc, { ownership: svc.ownership });

      this.lifecycleEvent("memory.health.probe.begin", svc, { phase: "readiness" });
      if (id === "postgres") {
        const applicationReady = await this.completePrivatePostgresApplicationReady();
        if (!applicationReady.ok) {
          svc.status = "unavailable";
          svc.summary = "Private PostgreSQL started but the yuvi database is not ready.";
          svc.lastError = applicationReady.code;
          return;
        }
      } else {
        const ready = await this.waitReady(svc, svc.spec.startTimeoutMs);
        if (!ready) {
          svc.status = "unavailable";
          svc.summary = "Started but readiness timed out.";
          svc.lastError = "readiness timeout";
          // Leave process owned so user can stop/restart; do not kill external-like failures automatically.
          return;
        }
      }
      await this.refreshService(id);
    } catch (error) {
      try {
        await this.stopOwned(svc);
      } catch {
        // Preserve the original managed-start failure.
      }
      svc.status = "unavailable";
      svc.summary = "Start failed.";
      svc.lastError = error instanceof Error ? error.message : String(error);
      if (id === "postgres" && !this.privatePostgresQuiescentForRelaunch(svc)) {
        svc.lastError = "POSTGRES_FENCED_STOP_FAILED";
        throw error;
      }
      svc.ownership = "none";
      svc.pid = null;
      throw error;
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
    // Wait briefly for the tracked config reconcile and service ops (do not
    // block exit forever). New config updates are rejected once shutting down
    // is set, while the final stop pass below still handles owned children.
    const reconcile = this.configReconcileOp;
    if (reconcile) await Promise.race([reconcile, sleep(1_500)]);
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
    if (
      svc.spec.id === "postgres" &&
      this.config.postgresLayout &&
      this.config.postgresDistribution
    ) {
      const stopped = this.stopPrivatePostgresOwned();
      this.emitFencedStopDiagnostic(svc, stopped);
      if (!stopped.invoked) {
        if (svc.ownership === "owned" || svc.pid || svc.child) {
          svc.status = "unavailable";
          svc.summary = "Ownership uncertain; refusing to stop PostgreSQL.";
          svc.detail = stopped.reason;
          svc.lastError = stopped.reason;
        }
        svc.generation += 1;
        return;
      }
    }
    // Invalidate callbacks from the generation being stopped before sending
    // any signal. A delayed exit/close event must not clear a replacement.
    svc.generation += 1;
    const trackedPid = svc.pid;
    const child = svc.child;
    const metadataSnapshot = readProcessMetadata(svc.spec.metadataFile);
    const metadataBelongsToThisSupervisor = Boolean(
      metadataSnapshot &&
      metadataSnapshot.schemaVersion === PROCESS_METADATA_VERSION &&
      metadataSnapshot.role === svc.spec.role &&
      pathsEqual(metadataSnapshot.repositoryRoot, this.config.repositoryRoot) &&
      pathsEqual(metadataSnapshot.stateDirectory, this.config.stateDirectory) &&
      metadataSnapshot.ownershipToken === this.config.ownershipToken &&
      metadataSnapshot.instanceId === this.config.instanceId
    );

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

      const processInspection = inspectProcess(processId);
      const ownership = testProcessOwnership({
        metadataPath: svc.spec.metadataFile,
        expectedRole: svc.spec.role,
        repositoryRoot: this.config.repositoryRoot,
        stateDirectory: this.config.stateDirectory,
        ownershipToken: this.config.ownershipToken,
        instanceId: this.config.instanceId,
        processInspection,
        currentChild: child
      });

      // Kill when owned OR when we still hold a child handle for this pid (we started it).
      // A tracked numeric pid alone is not first-party evidence after a
      // Supervisor restart. Only the live ChildProcess handle can bypass an
      // unavailable identity query during shutdown.
      const weStarted = Boolean(child?.pid === processId);
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

    const removed = metadataBelongsToThisSupervisor
      ? removeProcessMetadataIfMatches(svc.spec.metadataFile, metadataSnapshot)
      : false;
    if (svc.spec.id === "postgres") {
      this.emitPostgresPhaseDiagnostic(svc, "metadata", {
        phase: "METADATA_CLEANUP",
        status: removed ? "REMOVED" : metadataBelongsToThisSupervisor ? "FAILED" : "RETAINED"
      });
    }
    this.lifecycleEvent("memory.metadata.cleanup", svc, {
      reason: removed
        ? "explicit-owned-stop"
        : metadataBelongsToThisSupervisor
          ? "compare-delete-mismatch"
          : "foreign-metadata",
      removed,
      metadataSnapshotMatch: removed
    });
    svc.child = null;
    svc.pid = null;
    svc.startedAt = null;
    svc.ownership = "none";
  }

  private async refreshService(id: ServiceId): Promise<void> {
    const svc = this.require(id);
    this.lifecycleEvent("memory.refresh.enter", svc);
    const now = new Date().toISOString();

    // Ownership first
    const metaPid = this.readOwnedPid(svc);
    const processInspection = metaPid ? inspectProcess(metaPid) : null;
    const ownership = testProcessOwnership({
      metadataPath: svc.spec.metadataFile,
      expectedRole: svc.spec.role,
      repositoryRoot: this.config.repositoryRoot,
      stateDirectory: this.config.stateDirectory,
      ownershipToken: this.config.ownershipToken,
      instanceId: this.config.instanceId,
      processInspection,
      currentChild: svc.child
    });
    let metadataCleanupMismatch = false;
    if (shouldRemoveInvalidMetadata(ownership)) {
      const removed = removeProcessMetadataIfMatches(svc.spec.metadataFile, ownership.metadata);
      metadataCleanupMismatch = !removed;
      if (svc.spec.id === "postgres") {
        this.emitPostgresPhaseDiagnostic(svc, "metadata", {
          phase: "METADATA_CLEANUP",
          status: removed ? "REMOVED" : "FAILED"
        });
      }
      this.lifecycleEvent("memory.metadata.cleanup", svc, {
        reason: removed ? ownership.cleanupReason : "compare-delete-mismatch",
        removed,
        cleanupAllowed: ownership.cleanupAllowed,
        metadataSnapshotMatch: ownership.metadataSnapshotMatch
      });
    }
    if (ownership.owned) {
      svc.ownership = "owned";
      svc.pid = ownership.processId;
      svc.pendingExternal = false;
    } else if (svc.ownership === "owned") {
      if (svc.child && ownership.status !== "unavailable") {
        this.invalidateTrackedChild(svc);
      }
      svc.ownership = "none";
      svc.pid = null;
      svc.pendingExternal = false;
    }

    const ownershipDiagnostics = {
      processInspectionStatus: ownership.processInspectionStatus,
      processInspectionReason: ownership.processInspectionReason,
      processAlive: ownership.processAlive,
      processInfoComplete: ownership.processInfoComplete,
      ownershipStatus: ownership.status,
      cleanupAllowed: ownership.cleanupAllowed,
      cleanupReason: ownership.cleanupReason,
      currentChildMatch: ownership.currentChildMatch,
      metadataSnapshotMatch: ownership.metadataSnapshotMatch
    };

    if (metadataCleanupMismatch) {
      svc.status = "unavailable";
      svc.ownership = "none";
      svc.pid = null;
      svc.summary = "Ownership metadata changed during verification.";
      svc.detail = "Metadata compare-and-delete was refused.";
      svc.lastError = null;
      this.lifecycleEvent("memory.classification.result", svc, {
        phase: "compare-delete-mismatch",
        ...ownershipDiagnostics,
        cleanupReason: "compare-delete-mismatch"
      });
      return;
    }

    if (ownership.status === "unavailable" && !ownership.owned) {
      svc.status = "unavailable";
      svc.ownership = "none";
      svc.pid = null;
      svc.summary = "Ownership verification unavailable.";
      svc.detail = ownership.message;
      svc.lastError = null;
      this.lifecycleEvent("memory.classification.result", svc, {
        phase: "ownership-unavailable",
        ...ownershipDiagnostics
      });
      return;
    }

    // Health / TCP
    if (svc.spec.id === "postgres" && (this.config.postgresMode ?? "external") === "private") {
      const sqlOk = svc.spec.readinessCheck ? await svc.spec.readinessCheck() : false;
      if (sqlOk && svc.ownership === "owned") {
        svc.status = "healthy";
        svc.summary = "Private PostgreSQL running (owned)";
        svc.lastError = null;
      } else if (sqlOk) {
        svc.status = "unavailable";
        svc.summary = "PostgreSQL answered but is not owned by this Supervisor.";
        svc.ownership = "none";
      } else if (svc.ownership === "owned") {
        svc.status = "unavailable";
        svc.summary = "Owned private PostgreSQL is not ready.";
      } else {
        svc.status = "stopped";
        svc.ownership = "none";
        svc.summary = "Private PostgreSQL is stopped.";
      }
      this.lifecycleEvent("memory.classification.result", svc, {
        phase: "private-postgres",
        ...ownershipDiagnostics
      });
      void now;
      return;
    }

    if (svc.spec.tcp && !svc.spec.healthUrl) {
      this.lifecycleEvent("memory.health.probe.begin", svc, { phase: "tcp" });
      const tcp = await probeTcp(svc.spec.tcp.host, svc.spec.tcp.port);
      if (tcp.ok) {
        svc.status = "healthy";
        svc.ownership = svc.ownership === "owned" ? "owned" : "external";
        if (svc.ownership !== "external" || !svc.pendingExternal) {
          svc.summary = "Reachable";
          svc.detail = tcp.message;
        }
        svc.lastError = null;
      } else {
        svc.status = svc.ownership === "owned" ? "unavailable" : "stopped";
        svc.summary = "Not reachable";
        svc.detail = tcp.message;
        if (svc.ownership !== "owned") {
          svc.ownership = "none";
          svc.pendingExternal = false;
        }
      }
      this.lifecycleEvent("memory.classification.result", svc, {
        phase: "tcp",
        ...ownershipDiagnostics
      });
      void now;
      return;
    }

    if (!svc.spec.healthUrl) {
      svc.status = "stopped";
      svc.summary = "No health endpoint";
      svc.pendingExternal = false;
      this.lifecycleEvent("memory.classification.result", svc, {
        phase: "no-health-endpoint",
        ...ownershipDiagnostics
      });
      return;
    }

    this.lifecycleEvent("memory.health.probe.begin", svc, { phase: "http" });
    const health = await probeHttpHealth(svc.spec.healthUrl, {
      validateBody: svc.spec.validateHealthBody
    });

    if (health.ok) {
      svc.status = "healthy";
      svc.summary = ownership.owned
        ? "Running (owned)"
        : svc.pendingExternal
          ? svc.summary
          : "Running (external)";
      svc.detail = svc.pendingExternal ? svc.detail : `latency ${health.latencyMs}ms`;
      svc.lastError = null;
      if (!ownership.owned) {
        svc.ownership = "external";
        svc.pid = null;
      }
      this.lifecycleEvent("memory.classification.result", svc, {
        phase: "healthy",
        ...ownershipDiagnostics
      });
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
        svc.pendingExternal = false;
      }
      this.lifecycleEvent("memory.classification.result", svc, {
        phase: "protocol-mismatch",
        ...ownershipDiagnostics
      });
      return;
    }

    if (ownership.owned) {
      svc.status = "unavailable";
      svc.summary = "Owned process not healthy";
      svc.lastError = health.message;
      this.lifecycleEvent("memory.classification.result", svc, {
        phase: "owned-unhealthy",
        ...ownershipDiagnostics
      });
      return;
    }

    svc.status = "stopped";
    svc.ownership = "none";
    svc.pendingExternal = false;
    svc.summary = "Not running";
    svc.detail = health.message;
    svc.lastError = null;
    this.lifecycleEvent("memory.classification.result", svc, {
      phase: "stopped",
      ...ownershipDiagnostics
    });
  }

  private hasLiveManagedChild(svc: InternalService): boolean {
    const child = svc.child;
    return Boolean(
      child &&
      (svc.pid == null || svc.pid === child.pid) &&
      !child.killed &&
      child.exitCode == null &&
      child.signalCode == null
    );
  }

  private invalidateTrackedChild(svc: InternalService): void {
    svc.generation += 1;
    svc.child = null;
    svc.pid = null;
    svc.startedAt = null;
  }

  private async waitReady(svc: InternalService, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (svc.spec.readinessCheck) {
        if (await svc.spec.readinessCheck()) return true;
      } else if (svc.spec.healthUrl) {
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

  private memorySearchAllowsMem0(): boolean {
    const status = this.migrationDiagnostics?.memorySearchStatus;
    if (status == null) return true;
    return status === "ready";
  }

  private toMigrationDiagnostics(diagnostics: MigrationDiagnostics): PostgresMigrationDiagnostics {
    return {
      schemaReady: diagnostics.schemaReady,
      memorySearchReady: diagnostics.memorySearchReady,
      memorySearchStatus: diagnostics.memorySearch.status,
      memorySearchErrorCode: diagnostics.memorySearch.errorCode,
      memorySearchFailedMigration: diagnostics.memorySearch.failedMigration,
      vectorAvailable: diagnostics.vectorAvailable,
      applied: diagnostics.applied,
      pending: diagnostics.pending,
      currentMigration: diagnostics.currentMigration,
      lastErrorCode: diagnostics.lastErrorCode,
      lockWaitMs: diagnostics.lockWaitMs
    };
  }

  private async runSchemaBootstrap(): Promise<void> {
    const mode = this.config.postgresMode ?? "external";
    const password = this.resolvePrivatePostgresPassword();
    const target = resolveSupervisorMigrationTarget(this.config, password);
    if (!target) {
      if (mode === "private") {
        const postgres = this.services.get("postgres");
        if (postgres) {
          this.emitPostgresPhaseDiagnostic(postgres, "service", {
            phase: "SERVICE_LAST_ERROR",
            status: "FAILED",
            lastErrorCode: safePostgresServiceErrorCode(postgres.lastError)
          });
        }
        throw new MigrationError(
          "DATABASE_UNAVAILABLE",
          "The private PostgreSQL target is not reachable."
        );
      }
      return;
    }
    if (mode === "private") {
      const postgres = this.services.get("postgres");
      if (postgres?.status !== "healthy" || postgres.ownership !== "owned") {
        if (postgres) {
          this.emitPostgresPhaseDiagnostic(postgres, "service", {
            phase: "SERVICE_LAST_ERROR",
            status: "FAILED",
            lastErrorCode: safePostgresServiceErrorCode(postgres.lastError)
          });
        }
        throw new MigrationError(
          "DATABASE_UNAVAILABLE",
          "The private PostgreSQL target is not reachable."
        );
      }
    }
    const migrate = this.hooks.migratePostgres ?? migrateSupervisorTarget;
    try {
      const result = await migrate(target, {
        settings: migrationSettingsFromEnv(this.config.env)
      });
      this.migrationDiagnostics = this.toMigrationDiagnostics(result.diagnostics);
      if (!result.ok || !result.schemaReady) {
        throw new MigrationError(
          result.diagnostics.lastErrorCode ?? "SCHEMA_POSTCONDITION_FAILED",
          "Yuvi schema bootstrap did not reach schema_ready."
        );
      }
    } catch (error) {
      if (error instanceof MigrationError) {
        this.migrationDiagnostics = {
          schemaReady: false,
          memorySearchReady: false,
          memorySearchStatus: this.migrationDiagnostics?.memorySearchStatus ?? null,
          memorySearchErrorCode: this.migrationDiagnostics?.memorySearchErrorCode ?? null,
          memorySearchFailedMigration:
            this.migrationDiagnostics?.memorySearchFailedMigration ?? null,
          vectorAvailable: this.migrationDiagnostics?.vectorAvailable ?? false,
          applied: this.migrationDiagnostics?.applied ?? [],
          pending: this.migrationDiagnostics?.pending ?? [],
          currentMigration: this.migrationDiagnostics?.currentMigration ?? null,
          lastErrorCode: error.code,
          lockWaitMs: this.migrationDiagnostics?.lockWaitMs ?? 0
        };
      }
      throw error;
    }
  }

  private async completePrivatePostgresApplicationReady(): Promise<
    | { ok: true }
    | {
        ok: false;
        code:
          | "POSTGRES_NOT_CONFIGURED"
          | "POSTGRES_SERVER_NOT_READY"
          | "YUVI_DATABASE_CREATE_FAILED"
          | "YUVI_DATABASE_NOT_READY";
      }
  > {
    const layout = this.config.postgresLayout;
    const distribution = this.config.postgresDistribution;
    const port = this.config.postgresListenPort;
    const clusterId = layout ? readClusterMarker(layout)?.clusterId : null;
    const password = this.resolvePrivatePostgresPassword();
    if (!layout || !distribution || !port || !clusterId || !password) {
      const svc = this.services.get("postgres");
      if (svc) {
        this.emitPostgresPhaseDiagnostic(svc, "server_ready", {
          phase: "SERVER_READY",
          status: "NOT_RUN"
        });
        this.emitPostgresPhaseDiagnostic(svc, "database_create", {
          phase: "DATABASE_CREATE",
          status: "NOT_RUN",
          sqlState: null
        });
        this.emitPostgresPhaseDiagnostic(svc, "yuvi_ready", {
          phase: "YUVI_READY",
          status: "NOT_RUN"
        });
      }
      return { ok: false, code: "POSTGRES_NOT_CONFIGURED" };
    }
    const serverReady = await this.waitPrivatePostgresServerReady();
    const svc = this.services.get("postgres");
    if (svc) {
      this.emitPostgresPhaseDiagnostic(svc, "server_ready", {
        phase: "SERVER_READY",
        status: serverReady ? "READY" : "FAILED"
      });
    }
    if (!serverReady) return { ok: false, code: "POSTGRES_SERVER_NOT_READY" };
    const created = await ensureYuviDatabase({
      distribution,
      port,
      password
    });
    if (svc) {
      this.emitPostgresPhaseDiagnostic(svc, "database_create", {
        phase: "DATABASE_CREATE",
        status: created.ok ? (created.alreadyExists ? "ALREADY_EXISTS" : "CREATED") : "FAILED",
        sqlState: safeSqlState(created.sqlState)
      });
    }
    if (!created.ok) return { ok: false, code: "YUVI_DATABASE_CREATE_FAILED" };
    const yuviReady = await pingPostgres({
      layout,
      distribution,
      port,
      password,
      clusterId
    });
    if (svc) {
      this.emitPostgresPhaseDiagnostic(svc, "yuvi_ready", {
        phase: "YUVI_READY",
        status: yuviReady ? "READY" : "FAILED"
      });
    }
    return yuviReady ? { ok: true } : { ok: false, code: "YUVI_DATABASE_NOT_READY" };
  }

  private async waitPrivatePostgresServerReady(): Promise<boolean> {
    const layout = this.config.postgresLayout;
    const distribution = this.config.postgresDistribution;
    const port = this.config.postgresListenPort;
    const clusterId = layout ? readClusterMarker(layout)?.clusterId : null;
    const password = this.resolvePrivatePostgresPassword();
    if (!layout || !distribution || !port || !clusterId || !password) return false;
    const svc = this.services.get("postgres");
    const timeoutMs = svc?.spec.startTimeoutMs ?? 30_000;
    const intervalMs = svc?.spec.readinessIntervalMs ?? 400;
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const ready = await pingPostgresServer({
        layout,
        distribution,
        port,
        password,
        clusterId
      });
      if (ready) return true;
      if (Date.now() >= deadline) return false;
      await sleep(intervalMs);
    }
  }

  private async startWindowsPrivatePostgresIfNeeded(): Promise<void> {
    const svc = this.require("postgres");
    await this.refreshService("postgres");
    if (svc.status === "healthy" || svc.status === "degraded") {
      return;
    }
    const layout = this.config.postgresLayout;
    const distribution = this.config.postgresDistribution;
    const clusterId = layout ? readClusterMarker(layout)?.clusterId : null;
    const port = this.config.postgresListenPort;
    if (!layout || !distribution || !clusterId || !port) {
      svc.status = "unavailable";
      svc.summary = "Private PostgreSQL is not configured.";
      svc.lastError = "POSTGRES_NOT_CONFIGURED";
      svc.ownership = "none";
      return;
    }
    if (svc.ownership === "owned" && svc.pid) {
      const alreadyReady = await this.completePrivatePostgresApplicationReady();
      if (alreadyReady.ok) {
        svc.status = "healthy";
        svc.ownership = "owned";
        svc.summary = "Private PostgreSQL is ready.";
        svc.child = null;
        return;
      }
      svc.status = "unavailable";
      svc.summary = "Private PostgreSQL started but the yuvi database is not ready.";
      svc.lastError = alreadyReady.code;
      return;
    }
    if (svc.pid && isProcessAlive(svc.pid)) {
      this.markPostgresIdentityUncertain(
        svc,
        "A live PostgreSQL process is tracked but is not strongly owned."
      );
      return;
    }

    const diagnosticSecrets = [
      this.config.env[POSTGRES_PASSWORD_ENV],
      this.baseEnv[POSTGRES_PASSWORD_ENV]
    ].filter((value): value is string => typeof value === "string" && value.length > 0);

    const launched = await launchWindowsPrivatePostgres({
      layout,
      distribution,
      port,
      clusterId,
      inspectProcess: (processId) =>
        this.inspectManagedProcess(processId, {
          windowsQueryTimeoutMs: POSTGRES_LAUNCH_PROCESS_QUERY_TIMEOUT_MS
        }),
      ...(this.hooks.spawnWindowsPgCtl ? { spawnImpl: this.hooks.spawnWindowsPgCtl } : {}),
      ...(this.hooks.postmasterSettleTimeoutMs != null
        ? { settleTimeoutMs: this.hooks.postmasterSettleTimeoutMs }
        : {}),
      ...(this.hooks.postmasterSettleIntervalMs != null
        ? { settleIntervalMs: this.hooks.postmasterSettleIntervalMs }
        : {}),
      ...(this.hooks.sleep ? { sleepImpl: this.hooks.sleep } : {}),
      ...(diagnosticSecrets.length ? { diagnosticSecrets } : {}),
      diagnosticSink: (diagnostic: PostgresLaunchDiagnostic) =>
        this.emitPostgresLaunchDiagnostic(svc, diagnostic)
    });
    if (launched.outcome === "uncertain") {
      this.markPostgresIdentityUncertain(
        svc,
        launched.message,
        launched.nominatedPid,
        launched.code
      );
      return;
    }
    if (launched.outcome === "quiescent-failure") {
      this.markPostgresLaunchFailed(svc, launched.code, launched.message, launched.detail);
      return;
    }

    const recorded = this.recordPrivatePostgresIdentity(svc, {
      pid: launched.pid,
      processStartedAtUtc: launched.processStartedAtUtc,
      clusterId
    });
    if (!recorded) {
      const stopped = this.stopPrivatePostgresOwned();
      const stopProven = this.privatePostgresStopProven(stopped, launched.pid);
      this.emitFencedStopDiagnostic(svc, stopped, stopProven);
      if (!stopProven) {
        this.markPostgresIdentityUncertain(
          svc,
          "Ownership metadata readback failed and the postmaster could not be fenced-stopped.",
          launched.pid
        );
        svc.lastError = "POSTGRES_FENCED_STOP_FAILED";
        return;
      }
      this.markPostgresLaunchFailed(
        svc,
        "POSTGRES_METADATA_READBACK_FAILED",
        "Ownership metadata readback failed."
      );
      return;
    }

    if (launched.outcome === "owned-after-failure") {
      const stopped = this.stopPrivatePostgresOwned();
      const stopProven = this.privatePostgresStopProven(stopped, launched.pid);
      this.emitFencedStopDiagnostic(svc, stopped, stopProven);
      if (!stopProven) {
        this.markPostgresIdentityUncertain(
          svc,
          "pg_ctl failed after starting a strongly owned postmaster that could not be fenced-stopped.",
          launched.pid
        );
        svc.lastError = "POSTGRES_FENCED_STOP_FAILED";
        return;
      }
      this.markPostgresLaunchFailed(
        svc,
        "POSTGRES_PG_CTL_START_FAILED",
        "pg_ctl failed after starting a postmaster; the owned server was fenced-stopped."
      );
      return;
    }

    const applicationReady = await this.completePrivatePostgresApplicationReady();
    if (!applicationReady.ok) {
      const stopped = this.stopPrivatePostgresOwned();
      const stopProven = this.privatePostgresStopProven(stopped, launched.pid);
      this.emitFencedStopDiagnostic(svc, stopped, stopProven);
      if (!stopProven) {
        svc.status = "unavailable";
        svc.ownership = "owned";
        svc.pid = launched.pid;
        svc.child = null;
        svc.summary = "Private PostgreSQL started but the yuvi database is not ready.";
        svc.lastError = "POSTGRES_FENCED_STOP_FAILED";
        return;
      }
      this.markPostgresLaunchFailed(
        svc,
        applicationReady.code,
        "Private PostgreSQL started but the yuvi database is not ready."
      );
      return;
    }
    svc.status = "healthy";
    svc.ownership = "owned";
    svc.summary = "Private PostgreSQL is ready.";
    svc.child = null;
  }

  private async prepareAndStartPrivatePostgres(): Promise<void> {
    const layout = this.config.postgresLayout;
    const distribution = this.config.postgresDistribution;
    const svc = this.services.get("postgres");
    if (!layout || !distribution || !svc) {
      if (svc) {
        svc.status = "unavailable";
        svc.summary =
          this.config.postgresDistributionError ?? "Private PostgreSQL is not configured.";
        svc.lastError = this.config.postgresDistributionError ?? "private postgres unavailable";
        svc.ownership = "none";
      }
      return;
    }

    if (this.tryAdoptSurvivingPostgres(svc)) {
      const applicationReady = await this.completePrivatePostgresApplicationReady();
      if (!applicationReady.ok) {
        svc.status = "unavailable";
        svc.summary = "Adopted private PostgreSQL is not yuvi-ready.";
        svc.lastError = applicationReady.code;
        return;
      }
      await this.refreshService("postgres");
      const adopted = this.services.get("postgres");
      const adoptedPort = this.config.postgresListenPort;
      const clusterId = readClusterMarker(layout)?.clusterId;
      if (
        adopted?.ownership === "owned" &&
        adopted.status === "healthy" &&
        adoptedPort &&
        clusterId
      ) {
        publishListenMetadata(layout, {
          schemaVersion: 1,
          host: PRIVATE_POSTGRES_HOST,
          port: adoptedPort,
          clusterId,
          postgresMajor: PRIVATE_POSTGRES_MAJOR
        });
      }
      return;
    }

    const prepared = await preparePrivatePostgres({
      layout,
      distribution,
      env: this.config.env,
      authority: this.config.postgresSecretAuthority ?? "development-file",
      ownedPort: svc.ownership === "owned" ? svc.spec.tcp?.port : null,
      skipPortPersistence: true
    });
    if (!prepared.ok) {
      svc.status = "unavailable";
      svc.summary = prepared.message;
      svc.lastError = prepared.code;
      svc.ownership = "none";
      svc.spec.managed = false;
      svc.spec.startCommand = null;
      return;
    }

    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (attempt > 0 && this.shouldHaltPrivatePostgresPortRetry(svc)) {
        return;
      }
      const listen =
        attempt === 0
          ? prepared.listen
          : await selectPrivatePostgresPort({
              layout,
              clusterId: prepared.marker.clusterId,
              persisted: null
            });
      this.config.postgresStart = buildPostgresStartCommand(
        layout,
        distribution,
        listen.port,
        prepared.marker.clusterId
      );
      this.config.postgresLayout = prepared.layout;
      this.config.postgresListenPort = listen.port;
      this.rebuildSpecsInPlace();
      try {
        await this.ensureService("postgres");
      } catch {
        // startManagedIfNeeded records lastError
      }
      const ready = this.services.get("postgres");
      if (ready?.status === "healthy" && ready.ownership === "owned") {
        const password = this.resolvePrivatePostgresPassword();
        const sqlReady =
          Boolean(password) &&
          (await pingPostgres({
            layout,
            distribution,
            port: listen.port,
            password: password!,
            clusterId: prepared.marker.clusterId
          }));
        if (sqlReady) {
          publishListenMetadata(layout, listen);
          return;
        }
        ready.status = "unavailable";
        ready.lastError = "YUVI_DATABASE_NOT_READY";
      }
      if (this.shouldHaltPrivatePostgresPortRetry(ready ?? svc)) {
        return;
      }
    }
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

  private inspectManagedProcess(processId: number, options?: ProcessInspectionOptions) {
    return (this.hooks.inspectProcess ?? inspectProcess)(processId, options);
  }

  private emitPostgresLaunchDiagnostic(
    svc: InternalService,
    diagnostic: PostgresLaunchDiagnostic
  ): void {
    const eventByPhase: Record<PostgresLaunchDiagnostic["phase"], string> = {
      PG_CTL_LAUNCH: "launch",
      POSTMASTER_PID: "postmaster",
      PROCESS_INSPECTION: "inspect",
      OWNERSHIP: "ownership"
    };
    try {
      this.lifecycleEvent(`postgres.private.${eventByPhase[diagnostic.phase]}`, svc, diagnostic);
    } catch {
      // Diagnostic failures must never affect PostgreSQL lifecycle behavior.
    }
  }

  private emitPostgresPhaseDiagnostic(
    svc: InternalService,
    event:
      | "metadata"
      | "server_ready"
      | "database_create"
      | "yuvi_ready"
      | "fenced_stop"
      | "service",
    extra: Record<string, unknown>
  ): void {
    try {
      this.lifecycleEvent(`postgres.private.${event}`, svc, extra);
    } catch {
      // Diagnostic failures must never affect PostgreSQL lifecycle behavior.
    }
  }

  private emitFencedStopDiagnostic(
    svc: InternalService,
    stopped: { invoked: boolean; owned: boolean; reason: string; pid: number | null },
    proven?: boolean
  ): void {
    const status =
      proven === true
        ? "PROVEN"
        : proven === false || (stopped.owned && !stopped.invoked)
          ? "FAILED"
          : stopped.invoked
            ? "INVOKED"
            : "NOT_RUN";
    this.emitPostgresPhaseDiagnostic(svc, "fenced_stop", {
      phase: "FENCED_STOP",
      status,
      pid: Number.isInteger(stopped.pid) && (stopped.pid ?? 0) > 0 ? stopped.pid : null
    });
  }

  private resolvePrivatePostgresPassword(): string | null {
    const layout = this.config.postgresLayout;
    if (!layout) return null;
    return resolvePostgresPassword(
      layout,
      this.config.env,
      this.config.postgresSecretAuthority ?? "development-file"
    );
  }

  private stopPrivatePostgresOwned() {
    const layout = this.config.postgresLayout;
    const distribution = this.config.postgresDistribution;
    const svc = this.services.get("postgres");
    if (!layout || !distribution || !svc) {
      return { invoked: false, owned: false, reason: "postgres is not configured", pid: null };
    }
    const metadata = readProcessMetadata(svc.spec.metadataFile);
    const pid = svc.pid ?? metadata?.pid ?? 0;
    const inspection = pid
      ? this.inspectManagedProcess(pid)
      : { status: "not-running" as const, processId: 0, reason: "invalid-pid" as const };
    return stopPrivatePostgresIfOwned({
      layout,
      distribution,
      processInspection: inspection,
      metadata,
      invokeStop: this.hooks.invokePostgresStop
    });
  }

  private recordPrivatePostgresIdentity(
    svc: InternalService,
    launched: { pid: number; processStartedAtUtc: string; clusterId: string }
  ): boolean {
    const generation = svc.generation + 1;
    svc.generation = generation;
    svc.child = null;
    svc.pid = launched.pid;
    svc.startedAt = launched.processStartedAtUtc;
    svc.status = "starting";
    svc.summary = "Starting private PostgreSQL…";
    svc.lastError = null;
    const metadata: ProcessMetadata = {
      schemaVersion: PROCESS_METADATA_VERSION,
      role: svc.spec.role,
      pid: launched.pid,
      repositoryRoot: this.config.repositoryRoot,
      stateDirectory: this.config.stateDirectory,
      commandMarker: expectedClusterName(launched.clusterId),
      processStartedAtUtc: launched.processStartedAtUtc,
      createdAtUtc: new Date().toISOString(),
      ownershipToken: this.config.ownershipToken,
      instanceId: this.config.instanceId
    };
    try {
      writeProcessMetadata(svc.spec.metadataFile, metadata);
      this.emitPostgresPhaseDiagnostic(svc, "metadata", {
        phase: "METADATA_WRITE",
        status: "SUCCESS"
      });
    } catch (error) {
      this.emitPostgresPhaseDiagnostic(svc, "metadata", {
        phase: "METADATA_WRITE",
        status: "FAILED"
      });
      throw error;
    }
    const readback = readProcessMetadata(svc.spec.metadataFile);
    const readbackOk = Boolean(
      readback && readback.pid === launched.pid && readback.instanceId === this.config.instanceId
    );
    this.emitPostgresPhaseDiagnostic(svc, "metadata", {
      phase: "METADATA_READBACK",
      status: readbackOk ? "SUCCESS" : "FAILED"
    });
    return readbackOk;
  }

  private markPostgresIdentityUncertain(
    svc: InternalService,
    message: string,
    nominatedPid?: number | null,
    code:
      | "POSTGRES_START_IDENTITY_UNCERTAIN"
      | "POSTGRES_POSTMASTER_IDENTITY_UNPROVEN" = "POSTGRES_START_IDENTITY_UNCERTAIN"
  ): void {
    svc.status = "unavailable";
    svc.summary = message;
    svc.lastError = code;
    svc.detail = message;
    if (nominatedPid && nominatedPid > 0) {
      svc.pid = nominatedPid;
    }
    svc.child = null;
  }

  private markPostgresLaunchFailed(
    svc: InternalService,
    code: string,
    message: string,
    detail?: string
  ): void {
    const password = this.resolvePrivatePostgresPassword();
    svc.status = "unavailable";
    svc.summary = message;
    svc.lastError = code;
    svc.detail = detail ? redactSecretText(detail, password ? [password] : []) : null;
    svc.ownership = "none";
    svc.pid = null;
    svc.child = null;
    svc.startedAt = null;
  }

  private privatePostgresIdentityUnresolved(svc: InternalService): boolean {
    const haltCodes = new Set([
      "POSTGRES_START_IDENTITY_UNCERTAIN",
      "POSTGRES_POSTMASTER_IDENTITY_UNPROVEN",
      "POSTGRES_POSTMASTER_PID_MISSING",
      "POSTGRES_FENCED_STOP_FAILED"
    ]);
    return Boolean(svc.lastError && haltCodes.has(svc.lastError));
  }

  private shouldHaltPrivatePostgresPortRetry(svc: InternalService): boolean {
    if (this.privatePostgresIdentityUnresolved(svc)) return true;
    if (svc.ownership === "owned") return true;
    if (svc.pid && isProcessAlive(svc.pid)) return true;
    if (svc.child || this.hasLiveManagedChild(svc)) return true;
    if (this.privatePostgresHasLiveCandidate()) return true;
    return false;
  }

  private privatePostgresHasLiveCandidate(): boolean {
    const layout = this.config.postgresLayout;
    if (!layout) return false;
    const pid = readPostmasterPid(layout.data);
    if (pid == null) return false;
    const inspection = this.inspectManagedProcess(pid);
    return inspection.status !== "not-running";
  }

  private privatePostgresQuiescentForRelaunch(svc: InternalService): boolean {
    if (this.privatePostgresIdentityUnresolved(svc)) return false;
    if (svc.ownership === "owned") return false;
    if (svc.child || this.hasLiveManagedChild(svc)) return false;
    if (svc.pid && isProcessAlive(svc.pid)) return false;
    return !this.privatePostgresHasLiveCandidate();
  }

  private privatePostgresStopProven(
    stopped: { invoked: boolean; owned: boolean; pid: number | null },
    expectedPid: number
  ): boolean {
    if (!stopped.invoked) return false;
    if (isProcessAlive(expectedPid)) return false;
    const leftover = this.config.postgresLayout
      ? readPostmasterPid(this.config.postgresLayout.data)
      : null;
    if (leftover != null && leftover === expectedPid && isProcessAlive(leftover)) return false;
    return !this.privatePostgresHasLiveCandidate();
  }

  private tryAdoptSurvivingPostgres(svc: InternalService): boolean {
    const layout = this.config.postgresLayout;
    const distribution = this.config.postgresDistribution;
    const marker = layout ? readClusterMarker(layout) : null;
    if (!layout || !distribution || !marker) return false;
    const metadata = readProcessMetadata(svc.spec.metadataFile);
    if (!metadata?.pid) return false;
    const inspection = this.inspectManagedProcess(metadata.pid);
    const adopted = adoptSurvivingPostgres({
      layout,
      distribution,
      processInspection: inspection,
      metadata
    });
    if (!adopted.adopted) return false;
    const password = this.resolvePrivatePostgresPassword();
    const port = adopted.evidence.port ?? readListenMetadata(layout)?.port ?? null;
    if (!password || !port) return false;
    // Readiness is verified by the caller after listen is reconstructed.
    const next: ProcessMetadata = {
      schemaVersion: PROCESS_METADATA_VERSION,
      role: "postgres",
      pid: metadata.pid,
      repositoryRoot: this.config.repositoryRoot,
      stateDirectory: this.config.stateDirectory,
      commandMarker: expectedClusterName(marker.clusterId),
      processStartedAtUtc:
        adopted.evidence.processStartedAtUtc ??
        (inspection.status === "resolved"
          ? (inspection.info.createdAtUtc?.toISOString() ?? metadata.processStartedAtUtc)
          : metadata.processStartedAtUtc),
      createdAtUtc: new Date().toISOString(),
      ownershipToken: this.config.ownershipToken,
      instanceId: this.config.instanceId
    };
    writeProcessMetadata(svc.spec.metadataFile, next);
    svc.pid = metadata.pid;
    svc.ownership = "owned";
    svc.startedAt = next.processStartedAtUtc;
    svc.status = "starting";
    svc.summary = "Adopted surviving private PostgreSQL.";
    this.config.postgresListenPort = port;
    this.config.postgresStart = buildPostgresStartCommand(
      layout,
      distribution,
      port,
      marker.clusterId
    );
    this.rebuildSpecsInPlace();
    return true;
  }

  private buildPostgresSpec(
    state: string,
    db: { host: string; port: number } | null
  ): ManagedServiceSpec {
    const privateMode = (this.config.postgresMode ?? "external") === "private";
    const port = this.config.postgresListenPort ?? null;
    const layout = this.config.postgresLayout;
    const distribution = this.config.postgresDistribution;
    return {
      id: "postgres",
      role: "postgres",
      label: "PostgreSQL",
      managed: privateMode && Boolean(this.config.postgresStart),
      autostart: privateMode && Boolean(this.config.postgresStart),
      healthUrl: null,
      tcp: privateMode
        ? { host: "127.0.0.1", port: port ?? 55432 }
        : (db ?? { host: "127.0.0.1", port: 5432 }),
      startTimeoutMs: privateMode ? 30_000 : 5_000,
      readinessIntervalMs: privateMode ? 400 : 500,
      startCommand: privateMode ? (this.config.postgresStart ?? null) : null,
      metadataFile: layout?.metadataFile ?? path.join(state, "postgres.pid.json"),
      logFile: layout?.logFile ?? path.join(state, "postgres.log"),
      readinessCheck:
        privateMode && layout && distribution && port
          ? async () => {
              const password = this.resolvePrivatePostgresPassword();
              const clusterId = readClusterMarker(layout)?.clusterId;
              if (!password || !clusterId) return false;
              return await pingPostgres({
                layout,
                distribution,
                port,
                password,
                clusterId
              });
            }
          : undefined
    };
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
      this.buildPostgresSpec(state, db),
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
          generation: 0,
          autoRecovered: false,
          pendingExternal: false,
          op: null
        });
      }
    }
  }

  private captureConfigState(): SupervisorConfigState {
    const capture = (id: ServiceId): ServiceConfigState => {
      const svc = this.require(id);
      return {
        spec: svc.spec,
        ownership: svc.ownership,
        status: svc.status,
        effectiveEnv: svc.spec.startCommand
          ? this.effectiveChildEnv(svc.spec.startCommand.env, id)
          : null
      };
    };
    return {
      env: { ...this.config.env },
      runtime: capture("runtime"),
      mem0: capture("mem0")
    };
  }

  private buildReconcilePlan(
    previous: SupervisorConfigState,
    next: SupervisorConfigState
  ): ConfigReconcilePlan {
    return {
      generation: this.configGeneration,
      runtimeChanged: this.runtimeConfigChanged(previous, next),
      mem0Action: this.mem0ReconcileAction(previous.mem0, next.mem0, previous, next)
    };
  }

  private runtimeConfigChanged(
    previous: SupervisorConfigState,
    next: SupervisorConfigState
  ): boolean {
    for (const key of RUNTIME_RELOAD_KEYS) {
      const previousValue = this.runtimeConfigValue(previous, key);
      const nextValue = this.runtimeConfigValue(next, key);
      if (previousValue !== nextValue) return true;
    }
    return false;
  }

  private runtimeConfigValue(state: SupervisorConfigState, key: string): string {
    if (key === "MEMORY_BACKEND") {
      const value = state.env[key]?.trim().toLowerCase();
      return value === "legacy" ? "legacy" : "mem0";
    }
    if (key === "MEM0_BASE_URL") return state.mem0.spec.healthUrl ?? "";
    return state.runtime.effectiveEnv?.[key] ?? state.env[key] ?? "";
  }

  private mem0ReconcileAction(
    previous: ServiceConfigState,
    next: ServiceConfigState,
    previousConfig: SupervisorConfigState,
    nextConfig: SupervisorConfigState
  ): Mem0ReconcileAction {
    const previousManaged = previous.spec.managed;
    const nextManaged = next.spec.managed;
    const previousOwned = previous.ownership === "owned";

    if (!previousManaged && !nextManaged) return "none";
    if (previousManaged && !nextManaged) return previousOwned ? "stop" : "none";

    if (!previousManaged && nextManaged) {
      return next.spec.autostart ? "start" : "none";
    }

    // In development, managed and autostart are separate. Turning autostart
    // off must still stop an owned sidecar without changing dev resolution.
    if (previous.spec.autostart && !next.spec.autostart) {
      return previousOwned ? "stop" : "none";
    }
    if (!next.spec.autostart) return "none";

    const effectiveChanged =
      previous.spec.healthUrl !== next.spec.healthUrl ||
      !startCommandEqual(previous.spec.startCommand, next.spec.startCommand) ||
      this.mem0EffectiveConfigChanged(previous, next, previousConfig, nextConfig);
    if (!effectiveChanged) return "none";
    if (previous.ownership === "external" || next.ownership === "external") {
      return "pending_external";
    }
    return previousOwned ? "restart" : "start";
  }

  private mem0EffectiveConfigChanged(
    previous: ServiceConfigState,
    next: ServiceConfigState,
    previousConfig: SupervisorConfigState,
    nextConfig: SupervisorConfigState
  ): boolean {
    for (const key of MEM0_CONFIG_KEYS) {
      const previousValue = this.mem0ConfigValue(previous, previousConfig, key);
      const nextValue = this.mem0ConfigValue(next, nextConfig, key);
      if (previousValue !== nextValue) return true;
    }
    return false;
  }

  private mem0ConfigValue(
    state: ServiceConfigState,
    config: SupervisorConfigState,
    key: string
  ): string {
    if (key === "MEMORY_BACKEND") {
      const value = config.env[key]?.trim().toLowerCase();
      return value === "legacy" ? "legacy" : "mem0";
    }
    if (key === "YUVI_AUTOSTART_MEM0") return state.spec.autostart ? "true" : "false";
    if (key === "MEM0_BASE_URL") return state.spec.healthUrl ?? "";
    if (key === "DATABASE_URL") return state.effectiveEnv?.[key] ?? "";
    return state.effectiveEnv?.[key] ?? config.env[key] ?? "";
  }

  private enqueueConfigReconcile(plan: ConfigReconcilePlan): void {
    const previous = this.configReconcileOp ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        // A subsequent update waits for this operation before committing, but
        // keep the generation guard for callers that queue work concurrently.
        if (plan.generation !== this.configGeneration || this.shuttingDown) return;
        await this.reconcileConfig(plan);
      });
    this.configReconcileOp = next.catch(() => undefined);
  }

  private async reconcileConfig(plan: ConfigReconcilePlan): Promise<void> {
    if (this.shuttingDown) return;
    if (plan.runtimeChanged) await this.reconcileRuntimeConfig();
    if (plan.mem0Action !== "none") await this.reconcileMem0Config(plan.mem0Action);
  }

  private async reconcileRuntimeConfig(): Promise<void> {
    const svc = this.services.get("runtime");
    if (!svc || this.shuttingDown) return;
    await this.queue(svc, async () => {
      try {
        if (svc.ownership === "external") {
          await this.refreshService("runtime");
        }
        if (svc.ownership === "external") {
          this.markExternalPending(svc, "Runtime");
          return;
        }
        if (svc.ownership === "owned") {
          await this.stopOwned(svc);
        }
        if (svc.spec.autostart) {
          await this.startManagedIfNeeded("runtime");
        }
      } catch {
        svc.status = "unavailable";
        svc.summary = "Runtime reconcile failed.";
        svc.lastError = "Runtime reconcile failed.";
        this.emit();
      }
    });
  }

  private async reconcileMem0Config(action: Mem0ReconcileAction): Promise<void> {
    const svc = this.services.get("mem0");
    if (!svc || this.shuttingDown) return;
    await this.queue(svc, async () => {
      try {
        if (action === "stop") {
          if (svc.ownership === "owned" || svc.pid || svc.child) await this.stopOwned(svc);
          svc.pendingExternal = false;
          svc.status = "stopped";
          svc.summary = "Mem0 disabled — external detection only.";
          svc.detail = null;
          svc.lastError = null;
          this.emit();
          return;
        }

        if (action === "restart" && svc.ownership === "owned") {
          svc.status = "restarting";
          svc.summary = "Restarting…";
          this.emit();
          await this.stopOwned(svc);
          await this.startManagedIfNeeded("mem0");
          return;
        }
        await this.refreshService("mem0");
        if (svc.status === "healthy" && svc.ownership === "external") {
          this.markExternalPending(svc, "Mem0");
          return;
        }
        await this.startManagedIfNeeded("mem0");
        if (svc.status === "healthy" && svc.ownership === "external") {
          this.markExternalPending(svc, "Mem0");
        }
      } catch {
        svc.status = "unavailable";
        svc.summary = "Mem0 reconcile failed.";
        svc.lastError = "Mem0 reconcile failed.";
        this.emit();
      }
    });
  }

  private markExternalPending(svc: InternalService, label: string): void {
    svc.pendingExternal = true;
    svc.summary = `Managed ${label} pending — external service owns the port`;
    svc.detail = `The configured ${label} endpoint is healthy but is not owned by this Supervisor.`;
    svc.lastError = null;
    this.emit();
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
      canRestart:
        svc.spec.managed &&
        Boolean(svc.spec.startCommand) &&
        svc.ownership !== "external" &&
        !this.shuttingDown,
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

  private lifecycleEvent(
    event: string,
    svc: InternalService,
    extra: Record<string, unknown> = {}
  ): void {
    if (!this.lifecycleDiagnostics || (svc.spec.id !== "mem0" && svc.spec.id !== "postgres"))
      return;
    const metadataExists = fs.existsSync(svc.spec.metadataFile);
    let metadataRootHash: string | null = null;
    try {
      metadataRootHash = createHash("sha256")
        .update(path.resolve(this.config.stateDirectory))
        .digest("hex")
        .slice(0, 12);
    } catch {
      metadataRootHash = null;
    }
    const elapsedMs = Number(process.hrtime.bigint() - this.lifecycleStartedAt) / 1_000_000;
    const payload = {
      event,
      sequence: ++this.lifecycleSequence,
      elapsedMs: Math.round(elapsedMs),
      role: svc.spec.role,
      generation: svc.generation,
      pid: svc.pid ?? 0,
      instanceId: this.config.instanceId.slice(0, 12),
      startTime: svc.startedAt,
      metadataExists,
      metadataRootHash,
      ownership: svc.ownership,
      health: svc.status,
      ...extra
    };
    try {
      console.log(`YUVI_SUPERVISOR_LIFECYCLE ${JSON.stringify(payload)}`);
    } catch {
      // Diagnostics must never affect service lifecycle.
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

function startCommandEqual(
  previous: ManagedServiceSpec["startCommand"],
  next: ManagedServiceSpec["startCommand"]
): boolean {
  if (!previous || !next) return previous === next;
  if (
    previous.file !== next.file ||
    previous.cwd !== next.cwd ||
    previous.commandMarker !== next.commandMarker ||
    previous.args.length !== next.args.length
  ) {
    return false;
  }

  for (let index = 0; index < previous.args.length; index += 1) {
    if (previous.args[index] !== next.args[index]) return false;
  }
  const previousKeys = Object.keys(previous.env);
  const nextKeys = Object.keys(next.env);
  if (previousKeys.length !== nextKeys.length) return false;
  for (const key of previousKeys) {
    if (previous.env[key] !== next.env[key]) return false;
  }
  return true;
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
