import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyDiagnostics } from "@companion/memory";
import { DesktopSupervisor, type SupervisorHooks } from "./supervisor.js";
import * as cluster from "./postgres-cluster.js";
import * as postgresSecret from "./postgres-secret.js";
import {
  createClusterMarker,
  ensurePostgresDirectories,
  layoutFromRoot,
  readListenMetadata,
  writeClusterMarker,
  writeInitializationState
} from "./postgres-layout.js";
import { expectedClusterName } from "./postgres-ownership.js";
import { PROCESS_METADATA_VERSION, writeProcessMetadata } from "./ownership.js";
import * as processWindows from "./process-windows.js";
import type { PostgresDistribution } from "./postgres-distribution.js";
import type { ProcessInspectionResult, SupervisorConfig } from "./types.js";

const tempDirs: string[] = [];
const supervisors: DesktopSupervisor[] = [];
let lifecycleDiagnosticsWasEnabled = false;
let previousLifecycleDiagnostics: string | undefined;

function enableLifecycleDiagnostics(): void {
  if (!lifecycleDiagnosticsWasEnabled) {
    previousLifecycleDiagnostics = process.env["YUVI_SUPERVISOR_DIAGNOSTICS"];
    lifecycleDiagnosticsWasEnabled = true;
  }
  process.env["YUVI_SUPERVISOR_DIAGNOSTICS"] = "1";
}

function capturedLifecycleEvents(spy: {
  mock: { calls: unknown[][] };
}): Array<Record<string, unknown>> {
  const prefix = "YUVI_SUPERVISOR_LIFECYCLE ";
  return spy.mock.calls.flatMap(([message]) => {
    if (typeof message !== "string" || !message.startsWith(prefix)) return [];
    try {
      const event = JSON.parse(message.slice(prefix.length));
      return event && typeof event === "object" ? [event as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });
}

afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) {
    await supervisor.shutdown().catch(() => undefined);
  }
  vi.restoreAllMocks();
  if (lifecycleDiagnosticsWasEnabled) {
    if (previousLifecycleDiagnostics === undefined) {
      delete process.env["YUVI_SUPERVISOR_DIAGNOSTICS"];
    } else {
      process.env["YUVI_SUPERVISOR_DIAGNOSTICS"] = previousLifecycleDiagnostics;
    }
    previousLifecycleDiagnostics = undefined;
    lifecycleDiagnosticsWasEnabled = false;
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function distribution(): PostgresDistribution {
  return {
    home: "/opt/pg16",
    binDir: "/opt/pg16/bin",
    postgres: "/opt/pg16/bin/postgres",
    pgCtl: "/opt/pg16/bin/pg_ctl",
    initdb: "/opt/pg16/bin/initdb",
    createdb: null,
    psql: "/opt/pg16/bin/psql",
    major: 16,
    versionText: "postgres (PostgreSQL) 16.10"
  };
}

function privateConfig(): {
  config: SupervisorConfig;
  layout: ReturnType<typeof layoutFromRoot>;
  marker: ReturnType<typeof createClusterMarker>;
  dist: PostgresDistribution;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-sup-"));
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-sup-state-"));
  tempDirs.push(root, stateDirectory);
  const layout = layoutFromRoot(root);
  ensurePostgresDirectories(layout);
  const marker = createClusterMarker(layout);
  writeClusterMarker(layout, marker);
  fs.writeFileSync(path.join(layout.data, "PG_VERSION"), "16\n");
  writeInitializationState(layout, "ready");
  const dist = distribution();
  const start = cluster.buildPostgresStartCommand(layout, dist, 55432, marker.clusterId);
  return {
    layout,
    marker,
    dist,
    config: {
      layout: { mode: "development", repositoryRoot: root },
      repositoryRoot: root,
      stateDirectory,
      instanceId: "pg-inst",
      ownershipToken: "pg-token",
      controlToken: "c".repeat(64),
      controlHost: "127.0.0.1",
      controlPort: 0,
      env: {
        YUVI_POSTGRES_PASSWORD: "unit-test-password",
        YUVI_POSTGRES_MODE: "private"
      },
      memoryBackend: "mem0",
      autostartRuntime: false,
      autostartMem0: false,
      autostartTts: false,
      runtimeUrl: "http://127.0.0.1:6121",
      mem0Url: "http://127.0.0.1:6131",
      ttsWrapperUrl: "http://127.0.0.1:9881",
      ttsUpstreamUrl: "http://127.0.0.1:9880",
      ollamaUrl: "http://127.0.0.1:11434",
      databaseUrl: null,
      runtimeStart: null,
      mem0Start: null,
      ttsWrapperStart: null,
      ttsUpstreamStart: null,
      postgresMode: "private",
      postgresLayout: layout,
      postgresDistribution: dist,
      postgresStart: start,
      postgresListenPort: 55432,
      postgresSecretAuthority: "development-file"
    }
  };
}

function ownedInspection(
  dist: PostgresDistribution,
  layout: ReturnType<typeof layoutFromRoot>,
  clusterId: string,
  started: Date,
  processId = 4242
): ProcessInspectionResult {
  return {
    status: "resolved",
    processId,
    info: {
      processId,
      parentProcessId: 1,
      commandLine: `${dist.postgres} -D ${layout.data} -p 55432 -c cluster_name=yuvi-pg-${clusterId}`,
      createdAtUtc: started,
      executablePath: dist.postgres
    }
  };
}

function createSupervisor(config: SupervisorConfig, hooks: SupervisorHooks): DesktopSupervisor {
  const supervisor = new DesktopSupervisor(config, {
    postmasterSettleTimeoutMs: 20,
    postmasterSettleIntervalMs: 5,
    ...hooks
  });
  supervisors.push(supervisor);
  return supervisor;
}

describe("private postgres Windows start state machine", () => {
  it("does not resolve a password for diagnostics before pg_ctl launch", async () => {
    const { config } = privateConfig();
    const originalResolve = postgresSecret.resolvePostgresPassword;
    const resolverStacks: string[] = [];
    const resolver = vi
      .spyOn(postgresSecret, "resolvePostgresPassword")
      .mockImplementation((layout, env, authority) => {
        resolverStacks.push(new Error().stack ?? "");
        return originalResolve(layout, env, authority);
      });
    const supervisor = createSupervisor(config, {
      platform: "win32",
      spawnWindowsPgCtl: async () => {
        return {
          ok: false,
          kind: "PRE_SPAWN_ERROR",
          status: null,
          signal: null,
          stdout: "",
          stderr: "",
          detail: "spawn blocked for test"
        };
      }
    });

    await expect(supervisor.bootstrap()).rejects.toMatchObject({ code: "DATABASE_UNAVAILABLE" });
    const directStartCalls = resolverStacks.filter((stack) => {
      const frames = stack.split("\n").slice(1);
      const resolverFrameIndex = frames.findIndex((frame) =>
        frame.includes("DesktopSupervisor.resolvePrivatePostgresPassword")
      );
      return frames[resolverFrameIndex + 1]?.includes(
        "DesktopSupervisor.startWindowsPrivatePostgresIfNeeded"
      );
    });
    expect(directStartCalls).toHaveLength(0);
    expect(resolver.mock.calls.length).toBeGreaterThan(0);
    expect(config.env["YUVI_POSTGRES_PASSWORD"]).toBe("unit-test-password");
  });

  it("does not publish healthy or invoke D2 when only the postgres database is ready", async () => {
    enableLifecycleDiagnostics();
    const lifecycleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const { config, layout, marker, dist } = privateConfig();
    const migratePostgres = vi.fn();
    const started = new Date();
    let alive = true;
    vi.spyOn(cluster, "pingPostgresServer").mockResolvedValue(true);
    vi.spyOn(cluster, "pingPostgres").mockResolvedValue(false);
    vi.spyOn(cluster, "ensureYuviDatabase").mockResolvedValue({
      ok: true,
      created: true,
      alreadyExists: false,
      sqlState: null
    });
    vi.spyOn(processWindows, "spawnManagedProcess").mockImplementation(() => {
      throw new Error("generic spawn must not start private PostgreSQL on Windows");
    });
    const supervisor = createSupervisor(config, {
      platform: "win32",
      migratePostgres,
      inspectProcess: (processId) =>
        alive
          ? ownedInspection(dist, layout, marker.clusterId, started, processId)
          : { status: "not-running", processId, reason: "process-not-alive" },
      spawnWindowsPgCtl: async () => {
        fs.writeFileSync(path.join(layout.data, "postmaster.pid"), "4242\n");
        return {
          ok: true,
          kind: "SUCCESS",
          status: 0,
          signal: null,
          stdout: "PG_CTL_STDOUT_TEST_MARKER",
          stderr: "PG_CTL_STDERR_TEST_MARKER"
        };
      },
      invokePostgresStop: () => {
        alive = false;
        fs.rmSync(path.join(layout.data, "postmaster.pid"), { force: true });
        return true;
      }
    });
    await expect(supervisor.bootstrap()).rejects.toMatchObject({ code: "DATABASE_UNAVAILABLE" });
    const postgres = supervisor.snapshot().services.find((service) => service.id === "postgres");
    expect(postgres?.status).not.toBe("healthy");
    expect(postgres?.ownership).not.toBe("owned");
    expect(migratePostgres).not.toHaveBeenCalled();
    expect(readListenMetadata(layout)).toBeNull();
    const events = capturedLifecycleEvents(lifecycleLog);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "postgres.private.server_ready",
        phase: "SERVER_READY",
        status: "READY"
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "postgres.private.database_create",
        phase: "DATABASE_CREATE",
        status: "CREATED"
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "postgres.private.yuvi_ready",
        phase: "YUVI_READY",
        status: "FAILED"
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "postgres.private.fenced_stop",
        phase: "FENCED_STOP",
        status: "PROVEN"
      })
    );
  });

  it("does not publish healthy when CREATE DATABASE fails", async () => {
    enableLifecycleDiagnostics();
    const lifecycleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const { config, layout, marker, dist } = privateConfig();
    const migratePostgres = vi.fn();
    const started = new Date();
    let alive = true;
    vi.spyOn(cluster, "pingPostgresServer").mockResolvedValue(true);
    vi.spyOn(cluster, "pingPostgres").mockResolvedValue(false);
    vi.spyOn(cluster, "ensureYuviDatabase").mockResolvedValue({
      ok: false,
      message: "insufficient_privilege",
      sqlState: "42501"
    });
    const supervisor = createSupervisor(config, {
      platform: "win32",
      migratePostgres,
      inspectProcess: (processId) =>
        alive
          ? ownedInspection(dist, layout, marker.clusterId, started, processId)
          : { status: "not-running", processId, reason: "process-not-alive" },
      spawnWindowsPgCtl: async () => {
        alive = true;
        fs.writeFileSync(path.join(layout.data, "postmaster.pid"), "4242\n");
        return { ok: true, kind: "SUCCESS", status: 0, signal: null, stdout: "", stderr: "" };
      },
      invokePostgresStop: () => {
        alive = false;
        fs.rmSync(path.join(layout.data, "postmaster.pid"), { force: true });
        return true;
      }
    });
    await expect(supervisor.bootstrap()).rejects.toMatchObject({ code: "DATABASE_UNAVAILABLE" });
    const postgres = supervisor.snapshot().services.find((service) => service.id === "postgres");
    expect(postgres?.status).not.toBe("healthy");
    expect(postgres?.lastError).toBe("YUVI_DATABASE_CREATE_FAILED");
    expect(migratePostgres).not.toHaveBeenCalled();
    expect(readListenMetadata(layout)).toBeNull();
    const events = capturedLifecycleEvents(lifecycleLog);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "postgres.private.server_ready",
        phase: "SERVER_READY",
        status: "READY"
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "postgres.private.database_create",
        phase: "DATABASE_CREATE",
        status: "FAILED",
        sqlState: "42501"
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "postgres.private.fenced_stop",
        phase: "FENCED_STOP",
        status: "PROVEN"
      })
    );
  });

  it("publishes healthy+owned only after yuvi-ready", async () => {
    enableLifecycleDiagnostics();
    const lifecycleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const { config, layout, marker, dist } = privateConfig();
    const migratePostgres = vi.fn(async () => ({
      ok: true,
      schemaReady: true,
      diagnostics: { ...emptyDiagnostics(), schemaReady: true }
    }));
    const started = new Date();
    vi.spyOn(cluster, "pingPostgresServer").mockResolvedValue(true);
    vi.spyOn(cluster, "pingPostgres").mockResolvedValue(true);
    vi.spyOn(cluster, "ensureYuviDatabase").mockResolvedValue({
      ok: true,
      created: false,
      alreadyExists: true,
      sqlState: "42P04"
    });
    const supervisor = createSupervisor(config, {
      platform: "win32",
      migratePostgres,
      inspectProcess: (processId) =>
        ownedInspection(dist, layout, marker.clusterId, started, processId),
      spawnWindowsPgCtl: async () => {
        fs.writeFileSync(path.join(layout.data, "postmaster.pid"), "4242\n");
        return {
          ok: true,
          kind: "SUCCESS",
          status: 0,
          signal: null,
          stdout: "PG_CTL_STDOUT_TEST_MARKER",
          stderr: "PG_CTL_STDERR_TEST_MARKER"
        };
      }
    });
    await supervisor.bootstrap();
    const postgres = supervisor.snapshot().services.find((service) => service.id === "postgres");
    expect(postgres?.status).toBe("healthy");
    expect(postgres?.ownership).toBe("owned");
    expect(postgres?.pid).toBe(4242);
    expect(migratePostgres).toHaveBeenCalledTimes(1);
    const listen = readListenMetadata(layout);
    expect(listen?.clusterId).toBe(marker.clusterId);
    expect(listen?.port).toBe(supervisor.snapshot().postgres?.port ?? null);
    expect(listen?.port).toBeGreaterThan(0);
    const events = capturedLifecycleEvents(lifecycleLog);
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "postgres.private.launch",
        phase: "PG_CTL_LAUNCH",
        status: "SUCCESS",
        pgCtlStdoutTail: "PG_CTL_STDOUT_TEST_MARKER",
        pgCtlStderrTail: "PG_CTL_STDERR_TEST_MARKER"
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "postgres.private.postmaster",
        phase: "POSTMASTER_PID",
        status: "PRESENT",
        postmasterPid: 4242
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "postgres.private.inspect",
        phase: "PROCESS_INSPECTION",
        status: "RESOLVED",
        processId: 4242
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "postgres.private.ownership",
        phase: "OWNERSHIP",
        status: "ACCEPTED",
        reason: "NONE"
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "postgres.private.metadata",
        phase: "METADATA_WRITE",
        status: "SUCCESS"
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "postgres.private.metadata",
        phase: "METADATA_READBACK",
        status: "SUCCESS"
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "postgres.private.server_ready",
        phase: "SERVER_READY",
        status: "READY"
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "postgres.private.database_create",
        phase: "DATABASE_CREATE",
        status: "ALREADY_EXISTS",
        sqlState: "42P04"
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "postgres.private.yuvi_ready",
        phase: "YUVI_READY",
        status: "READY"
      })
    );
  });

  it("does not let background refresh promote server-ready-only to healthy", async () => {
    const { config, layout, marker, dist } = privateConfig();
    const started = new Date();
    const pingYuvi = vi.spyOn(cluster, "pingPostgres").mockResolvedValue(true);
    vi.spyOn(cluster, "pingPostgresServer").mockResolvedValue(true);
    vi.spyOn(cluster, "ensureYuviDatabase").mockResolvedValue({
      ok: true,
      created: true,
      alreadyExists: false,
      sqlState: null
    });
    const supervisor = createSupervisor(config, {
      platform: "win32",
      migratePostgres: async () => ({
        ok: true,
        schemaReady: true,
        diagnostics: { ...emptyDiagnostics(), schemaReady: true }
      }),
      inspectProcess: (processId) =>
        ownedInspection(dist, layout, marker.clusterId, started, processId),
      spawnWindowsPgCtl: async () => {
        fs.writeFileSync(path.join(layout.data, "postmaster.pid"), "4242\n");
        return { ok: true, kind: "SUCCESS", status: 0, signal: null, stdout: "", stderr: "" };
      }
    });
    await supervisor.bootstrap();
    pingYuvi.mockResolvedValue(false);
    await supervisor.refreshAll();
    const postgres = supervisor.snapshot().services.find((service) => service.id === "postgres");
    expect(postgres?.status).not.toBe("healthy");
  });

  it("halts retry when a live postmaster candidate cannot be identified", async () => {
    const { config, layout } = privateConfig();
    let launches = 0;
    vi.spyOn(cluster, "pingPostgresServer").mockResolvedValue(false);
    vi.spyOn(cluster, "pingPostgres").mockResolvedValue(false);
    const supervisor = createSupervisor(config, {
      platform: "win32",
      migratePostgres: vi.fn(),
      inspectProcess: () => ({
        status: "unavailable",
        processId: 4242,
        reason: "query-timeout"
      }),
      spawnWindowsPgCtl: async () => {
        launches += 1;
        fs.writeFileSync(path.join(layout.data, "postmaster.pid"), "4242\n");
        return {
          ok: false,
          kind: "TIMEOUT",
          status: null,
          signal: null,
          stdout: "",
          stderr: "",
          detail: "timed out"
        };
      }
    });
    await expect(supervisor.bootstrap()).rejects.toMatchObject({ code: "DATABASE_UNAVAILABLE" });
    expect(launches).toBe(1);
    const postgres = supervisor.snapshot().services.find((service) => service.id === "postgres");
    expect(postgres?.lastError).toBe("POSTGRES_START_IDENTITY_UNCERTAIN");
  });

  it("fenced-stops an owned leftover from a failed pg_ctl and does not overlap launches", async () => {
    const { config, layout, marker, dist } = privateConfig();
    const started = new Date();
    let launches = 0;
    let alive = true;
    let stopped = 0;
    vi.spyOn(cluster, "pingPostgresServer").mockResolvedValue(true);
    vi.spyOn(cluster, "pingPostgres").mockResolvedValue(true);
    vi.spyOn(cluster, "ensureYuviDatabase").mockResolvedValue({
      ok: true,
      created: true,
      alreadyExists: false,
      sqlState: null
    });
    const supervisor = createSupervisor(config, {
      platform: "win32",
      migratePostgres: async () => ({
        ok: true,
        schemaReady: true,
        diagnostics: { ...emptyDiagnostics(), schemaReady: true }
      }),
      inspectProcess: (processId) =>
        alive
          ? ownedInspection(dist, layout, marker.clusterId, started, processId)
          : { status: "not-running", processId, reason: "process-not-alive" },
      spawnWindowsPgCtl: async () => {
        launches += 1;
        alive = true;
        fs.writeFileSync(path.join(layout.data, "postmaster.pid"), `${4200 + launches}\n`);
        if (launches === 1) {
          return {
            ok: false,
            kind: "EXIT_NONZERO",
            status: 1,
            signal: null,
            stdout: "",
            stderr: "start failed",
            detail: "start failed"
          };
        }
        return { ok: true, kind: "SUCCESS", status: 0, signal: null, stdout: "", stderr: "" };
      },
      invokePostgresStop: () => {
        stopped += 1;
        alive = false;
        fs.rmSync(path.join(layout.data, "postmaster.pid"), { force: true });
        return true;
      }
    });
    await supervisor.bootstrap();
    expect(launches).toBe(2);
    expect(stopped).toBeGreaterThanOrEqual(1);
    const postgres = supervisor.snapshot().services.find((service) => service.id === "postgres");
    expect(postgres?.status).toBe("healthy");
    expect(postgres?.pid).toBe(4202);
  });

  it("halts when fenced stop of an owned leftover fails", async () => {
    const { config, layout, marker, dist } = privateConfig();
    const started = new Date();
    let launches = 0;
    vi.spyOn(cluster, "pingPostgresServer").mockResolvedValue(false);
    const supervisor = createSupervisor(config, {
      platform: "win32",
      migratePostgres: vi.fn(),
      inspectProcess: (processId) =>
        ownedInspection(dist, layout, marker.clusterId, started, processId),
      spawnWindowsPgCtl: async () => {
        launches += 1;
        fs.writeFileSync(path.join(layout.data, "postmaster.pid"), "4242\n");
        return {
          ok: false,
          kind: "EXIT_NONZERO",
          status: 1,
          signal: null,
          stdout: "",
          stderr: "start failed",
          detail: "start failed"
        };
      },
      invokePostgresStop: () => false
    });
    await expect(supervisor.bootstrap()).rejects.toMatchObject({ code: "DATABASE_UNAVAILABLE" });
    expect(launches).toBe(1);
    const postgres = supervisor.snapshot().services.find((service) => service.id === "postgres");
    expect(postgres?.lastError).toBe("POSTGRES_FENCED_STOP_FAILED");
  });

  it("allows another port attempt only after a spawn that never created a process", async () => {
    const { config, layout } = privateConfig();
    let launches = 0;
    vi.spyOn(cluster, "pingPostgresServer").mockResolvedValue(false);
    const supervisor = createSupervisor(config, {
      platform: "win32",
      migratePostgres: vi.fn(),
      inspectProcess: (processId) => ({
        status: "not-running",
        processId,
        reason: "process-not-alive"
      }),
      spawnWindowsPgCtl: async () => {
        launches += 1;
        return {
          ok: false,
          kind: "PRE_SPAWN_ERROR",
          status: null,
          signal: null,
          stdout: "",
          stderr: "",
          detail: "ENOENT"
        };
      }
    });
    await expect(supervisor.bootstrap()).rejects.toMatchObject({ code: "DATABASE_UNAVAILABLE" });
    expect(launches).toBeGreaterThan(1);
    expect(fs.existsSync(path.join(layout.data, "postmaster.pid"))).toBe(false);
  });

  it("does not invoke D2 when an adopted server is missing the yuvi database", async () => {
    const { config, layout, marker, dist } = privateConfig();
    const started = new Date("2026-01-01T00:00:00.000Z");
    writeProcessMetadata(layout.metadataFile, {
      schemaVersion: PROCESS_METADATA_VERSION,
      role: "postgres",
      pid: 4242,
      repositoryRoot: config.repositoryRoot,
      stateDirectory: config.stateDirectory,
      commandMarker: expectedClusterName(marker.clusterId),
      processStartedAtUtc: started.toISOString(),
      createdAtUtc: started.toISOString(),
      ownershipToken: config.ownershipToken,
      instanceId: config.instanceId
    });
    const migratePostgres = vi.fn();
    vi.spyOn(cluster, "pingPostgresServer").mockResolvedValue(true);
    vi.spyOn(cluster, "pingPostgres").mockResolvedValue(false);
    vi.spyOn(cluster, "ensureYuviDatabase").mockResolvedValue({
      ok: false,
      message: "duplicate check failed",
      sqlState: "42501"
    });
    const supervisor = createSupervisor(config, {
      platform: "win32",
      migratePostgres,
      inspectProcess: () => ownedInspection(dist, layout, marker.clusterId, started),
      spawnWindowsPgCtl: async () => {
        throw new Error("adopted postgres must not relaunch");
      }
    });
    await expect(supervisor.bootstrap()).rejects.toMatchObject({ code: "DATABASE_UNAVAILABLE" });
    expect(migratePostgres).not.toHaveBeenCalled();
    const postgres = supervisor.snapshot().services.find((service) => service.id === "postgres");
    expect(postgres?.status).not.toBe("healthy");
    expect(postgres?.ownership).toBe("owned");
    expect(readListenMetadata(layout)).toBeNull();
  });

  it("refuses a postgres restart when the fenced stop does not invoke", async () => {
    const { config, layout, marker, dist } = privateConfig();
    const started = new Date();
    vi.spyOn(cluster, "pingPostgresServer").mockResolvedValue(true);
    vi.spyOn(cluster, "pingPostgres").mockResolvedValue(true);
    vi.spyOn(cluster, "ensureYuviDatabase").mockResolvedValue({
      ok: true,
      created: true,
      alreadyExists: false,
      sqlState: null
    });
    let launches = 0;
    const supervisor = createSupervisor(config, {
      platform: "win32",
      migratePostgres: async () => ({
        ok: true,
        schemaReady: true,
        diagnostics: { ...emptyDiagnostics(), schemaReady: true }
      }),
      inspectProcess: (processId) =>
        ownedInspection(dist, layout, marker.clusterId, started, processId),
      spawnWindowsPgCtl: async () => {
        launches += 1;
        fs.writeFileSync(path.join(layout.data, "postmaster.pid"), "4242\n");
        return { ok: true, kind: "SUCCESS", status: 0, signal: null, stdout: "", stderr: "" };
      },
      invokePostgresStop: () => false
    });
    await supervisor.bootstrap();
    const firstLaunches = launches;
    await supervisor.restartService("postgres");
    expect(launches).toBe(firstLaunches);
    const postgres = supervisor.snapshot().services.find((service) => service.id === "postgres");
    expect(postgres?.lastError).toBe("POSTGRES_FENCED_STOP_FAILED");
  });

  it("halts when TIMEOUT leaves no postmaster.pid after the settle window", async () => {
    const { config, layout } = privateConfig();
    let launches = 0;
    const supervisor = createSupervisor(config, {
      platform: "win32",
      migratePostgres: vi.fn(),
      spawnWindowsPgCtl: async () => {
        launches += 1;
        return {
          ok: false,
          kind: "TIMEOUT",
          status: null,
          signal: null,
          stdout: "",
          stderr: "",
          detail: "timed out"
        };
      }
    });
    await expect(supervisor.bootstrap()).rejects.toMatchObject({ code: "DATABASE_UNAVAILABLE" });
    expect(launches).toBe(1);
    expect(fs.existsSync(path.join(layout.data, "postmaster.pid"))).toBe(false);
    const postgres = supervisor.snapshot().services.find((service) => service.id === "postgres");
    expect(postgres?.lastError).toBe("POSTGRES_START_IDENTITY_UNCERTAIN");
  });

  it("halts when SUCCESS never produces a postmaster identity", async () => {
    const { config } = privateConfig();
    let launches = 0;
    const supervisor = createSupervisor(config, {
      platform: "win32",
      migratePostgres: vi.fn(),
      spawnWindowsPgCtl: async () => {
        launches += 1;
        return { ok: true, kind: "SUCCESS", status: 0, signal: null, stdout: "", stderr: "" };
      }
    });
    await expect(supervisor.bootstrap()).rejects.toMatchObject({ code: "DATABASE_UNAVAILABLE" });
    expect(launches).toBe(1);
    const postgres = supervisor.snapshot().services.find((service) => service.id === "postgres");
    expect(postgres?.lastError).toBe("POSTGRES_POSTMASTER_IDENTITY_UNPROVEN");
  });

  it("reconciles a delayed owned postmaster.pid after launcher failure before any retry", async () => {
    const { config, layout, marker, dist } = privateConfig();
    const started = new Date();
    let launches = 0;
    let alive = true;
    let stopped = 0;
    vi.spyOn(cluster, "pingPostgresServer").mockResolvedValue(true);
    vi.spyOn(cluster, "pingPostgres").mockResolvedValue(true);
    vi.spyOn(cluster, "ensureYuviDatabase").mockResolvedValue({
      ok: true,
      created: true,
      alreadyExists: false,
      sqlState: null
    });
    const supervisor = createSupervisor(config, {
      platform: "win32",
      migratePostgres: async () => ({
        ok: true,
        schemaReady: true,
        diagnostics: { ...emptyDiagnostics(), schemaReady: true }
      }),
      inspectProcess: (processId) =>
        alive
          ? ownedInspection(dist, layout, marker.clusterId, started, processId)
          : { status: "not-running", processId, reason: "process-not-alive" },
      sleep: async () => {
        if (launches === 1 && !fs.existsSync(path.join(layout.data, "postmaster.pid"))) {
          alive = true;
          fs.writeFileSync(path.join(layout.data, "postmaster.pid"), "4242\n");
        }
      },
      spawnWindowsPgCtl: async () => {
        launches += 1;
        if (launches === 1) {
          return {
            ok: false,
            kind: "TIMEOUT",
            status: null,
            signal: null,
            stdout: "",
            stderr: "",
            detail: "timed out"
          };
        }
        alive = true;
        fs.writeFileSync(path.join(layout.data, "postmaster.pid"), "4243\n");
        return { ok: true, kind: "SUCCESS", status: 0, signal: null, stdout: "", stderr: "" };
      },
      invokePostgresStop: () => {
        stopped += 1;
        alive = false;
        fs.rmSync(path.join(layout.data, "postmaster.pid"), { force: true });
        return true;
      }
    });
    await supervisor.bootstrap();
    expect(launches).toBe(2);
    expect(stopped).toBeGreaterThanOrEqual(1);
    const postgres = supervisor.snapshot().services.find((service) => service.id === "postgres");
    expect(postgres?.status).toBe("healthy");
    expect(postgres?.pid).toBe(4243);
  });

  it("halts when a delayed postmaster.pid cannot be strongly owned", async () => {
    const { config, layout } = privateConfig();
    let launches = 0;
    const supervisor = createSupervisor(config, {
      platform: "win32",
      migratePostgres: vi.fn(),
      inspectProcess: () => ({
        status: "unavailable",
        processId: 4242,
        reason: "query-timeout"
      }),
      sleep: async () => {
        if (!fs.existsSync(path.join(layout.data, "postmaster.pid"))) {
          fs.writeFileSync(path.join(layout.data, "postmaster.pid"), "4242\n");
        }
      },
      spawnWindowsPgCtl: async () => {
        launches += 1;
        return {
          ok: false,
          kind: "EXIT_NONZERO",
          status: 1,
          signal: null,
          stdout: "",
          stderr: "failed",
          detail: "failed"
        };
      }
    });
    await expect(supervisor.bootstrap()).rejects.toMatchObject({ code: "DATABASE_UNAVAILABLE" });
    expect(launches).toBe(1);
    const postgres = supervisor.snapshot().services.find((service) => service.id === "postgres");
    expect(postgres?.lastError).toBe("POSTGRES_START_IDENTITY_UNCERTAIN");
  });

  it("halts after a post-spawn launcher error when no postmaster.pid appears", async () => {
    const { config } = privateConfig();
    let launches = 0;
    const supervisor = createSupervisor(config, {
      platform: "win32",
      migratePostgres: vi.fn(),
      spawnWindowsPgCtl: async () => {
        launches += 1;
        return {
          ok: false,
          kind: "POST_SPAWN_ERROR",
          status: null,
          signal: null,
          stdout: "",
          stderr: "",
          detail: "kill failed"
        };
      }
    });
    await expect(supervisor.bootstrap()).rejects.toMatchObject({ code: "DATABASE_UNAVAILABLE" });
    expect(launches).toBe(1);
    const postgres = supervisor.snapshot().services.find((service) => service.id === "postgres");
    expect(postgres?.lastError).toBe("POSTGRES_START_IDENTITY_UNCERTAIN");
  });
});
