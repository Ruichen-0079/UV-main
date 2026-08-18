import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createClusterMarker,
  ensurePostgresDirectories,
  layoutFromRoot,
  readInitializationState,
  writeClusterMarker,
  writeInitializationState
} from "./postgres-layout.js";
import {
  INITDB_REASON_MAX_CHARS,
  INITDB_STDERR_TAIL_MAX_CHARS,
  INITDB_STDOUT_TAIL_MAX_CHARS,
  PG_CTL_START_WAIT_SECONDS,
  assertPrivatePostgresPort,
  assertYuviClusterId,
  buildInitdbFailureEvidence,
  buildPostgresStartCommand,
  buildWindowsPgCtlStartArguments,
  classifyInitdbSpawnResult,
  classifyWindowsPgCtlChildExit,
  ensureYuviDatabase,
  initializePrivateCluster,
  inspectExistingCluster,
  invokeWindowsPgCtlStart,
  launchWindowsPrivatePostgres,
  launcherProcessWasNeverCreated,
  POSTGRES_IDENTITY_DB_PROBE_SQL,
  POSTGRES_IDENTITY_DB_PROBE_TIMEOUT_MS,
  isPostgresIdentityStartTimePlausible,
  probePrivatePostgresIdentity,
  reconcileWindowsPrivatePostgresLaunch,
  runWindowsPgCtlChild,
  waitForPostmasterCandidate,
  writeLocalOnlyConfig,
  type WindowsPgCtlChildHandle
} from "./postgres-cluster.js";
import { generatePostgresPassword, redactSecretText } from "./postgres-secret.js";
import { CREATION_TIME_TOLERANCE_MS, expectedClusterName } from "./postgres-ownership.js";
import type { PostgresDistribution } from "./postgres-distribution.js";
import type { ProcessInspectionResult } from "./types.js";

type SpawnSyncOverride = (
  command: string,
  args?: readonly string[],
  options?: Record<string, unknown>
) => {
  error?: Error | undefined;
  status: number | null;
  signal: NodeJS.Signals | string | null;
  stdout: string;
  stderr: string;
};

type SpawnSyncOverrideRegistration = {
  command: string;
  run: SpawnSyncOverride;
};

const childProcessState = vi.hoisted(() => ({
  override: null as SpawnSyncOverrideRegistration | null
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: ((command: string, args?: readonly string[], options?: Record<string, unknown>) => {
      const override = childProcessState.override;
      if (override && command === override.command) {
        return override.run(command, args, options);
      }
      return actual.spawnSync(command, args as string[] | undefined, options);
    }) as typeof actual.spawnSync
  };
});

const tempDirs: string[] = [];
afterEach(() => {
  childProcessState.override = null;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("private postgres cluster safety", () => {
  it("runs the read-only authenticated identity probe with bounded postgres-client settings", async () => {
    const layout = layoutFromRoot(fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-identity-db-")));
    tempDirs.push(layout.root);
    const marker = createClusterMarker(layout);
    const distribution: PostgresDistribution = {
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
    const launchStartedAt = new Date();
    const postmasterStartTime = new Date(launchStartedAt.getTime() + 100).toISOString();
    let captured: Record<string, unknown> | null = null;
    const result = await probePrivatePostgresIdentity({
      layout,
      distribution,
      port: 55432,
      password: "identity-test-password",
      clusterId: marker.clusterId,
      launchStartedAt,
      execute: async (input) => {
        captured = input as unknown as Record<string, unknown>;
        return {
          ok: true,
          output: "",
          sqlState: null,
          rows: [
            {
              data_directory: layout.data,
              cluster_name: expectedClusterName(marker.clusterId),
              port: "55432",
              server_version_num: "160010",
              postmaster_start_time: postmasterStartTime
            }
          ]
        };
      }
    });

    expect(result.status).toBe("RESOLVED");
    expect(result.dataDirectoryMatchesExpected).toBe(true);
    expect(result.clusterNameMatchesExpected).toBe(true);
    expect(result.portMatchesExpected).toBe(true);
    expect(result.majorMatches).toBe(true);
    expect(result.startTimePlausible).toBe(true);
    expect(captured?.["database"]).toBe("postgres");
    expect(captured?.["queryTimeoutMs"]).toBe(POSTGRES_IDENTITY_DB_PROBE_TIMEOUT_MS);
    expect(captured?.["includeRows"]).toBe(true);
    expect(captured?.["sql"]).toBe(POSTGRES_IDENTITY_DB_PROBE_SQL);
    expect(String(captured?.["sql"])).not.toMatch(/CREATE|INSERT|UPDATE|DELETE|ALTER|DROP/i);
  });

  it("surfaces identity probe mismatches and fails closed on query timeout", async () => {
    const layout = layoutFromRoot(fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-identity-fail-")));
    tempDirs.push(layout.root);
    const marker = createClusterMarker(layout);
    const distribution: PostgresDistribution = {
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
    const launchStartedAt = new Date();
    const mismatch = await probePrivatePostgresIdentity({
      layout,
      distribution,
      port: 55432,
      password: "identity-test-password",
      clusterId: marker.clusterId,
      launchStartedAt,
      execute: async () => ({
        ok: true,
        output: "",
        sqlState: null,
        rows: [
          {
            data_directory: "/foreign/data",
            cluster_name: "foreign-cluster",
            port: "5432",
            server_version_num: "150000",
            postmaster_start_time: "2020-01-01T00:00:00.000Z"
          }
        ]
      })
    });
    expect(mismatch.status).toBe("RESOLVED");
    expect(mismatch.dataDirectoryMatchesExpected).toBe(false);
    expect(mismatch.clusterNameMatchesExpected).toBe(false);
    expect(mismatch.portMatchesExpected).toBe(false);
    expect(mismatch.majorMatches).toBe(false);
    expect(mismatch.startTimePlausible).toBe(false);

    const timeout = await probePrivatePostgresIdentity({
      layout,
      distribution,
      port: 55432,
      password: "identity-test-password",
      clusterId: marker.clusterId,
      launchStartedAt,
      execute: async () => ({
        ok: false,
        output: "not surfaced",
        sqlState: "57014",
        errorCode: "57014"
      })
    });
    expect(timeout.status).toBe("TIMEOUT");
    expect(timeout.dataDirectory).toBeNull();
    expect(timeout.clusterName).toBeNull();
  });

  it("uses the ownership-grade launch window for OS and DB identity timestamps", () => {
    const launchStartedAt = new Date("2026-08-17T00:00:00.000Z");
    const lowerBoundary = launchStartedAt.getTime() - CREATION_TIME_TOLERANCE_MS;
    const upperBoundary =
      launchStartedAt.getTime() + PG_CTL_START_WAIT_SECONDS * 1_000 + CREATION_TIME_TOLERANCE_MS;
    const timestamps = [
      [lowerBoundary - 1, false],
      [lowerBoundary, true],
      [launchStartedAt.getTime(), true],
      [upperBoundary, true],
      [upperBoundary + 1, false]
    ] as const;

    for (const [timestamp, expected] of timestamps) {
      const value = new Date(timestamp).toISOString();
      expect(isPostgresIdentityStartTimePlausible(value, launchStartedAt)).toBe(expected);
    }

    const delayedClock = vi.spyOn(Date, "now").mockReturnValue(upperBoundary + 60_000);
    expect(
      isPostgresIdentityStartTimePlausible(new Date(upperBoundary).toISOString(), launchStartedAt)
    ).toBe(true);
    expect(
      isPostgresIdentityStartTimePlausible(
        new Date(upperBoundary + 1).toISOString(),
        launchStartedAt
      )
    ).toBe(false);
    delayedClock.mockRestore();
  });

  it("applies the fixed launch window to the authenticated postmaster timestamp", async () => {
    const layout = layoutFromRoot(fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-identity-time-")));
    tempDirs.push(layout.root);
    const marker = createClusterMarker(layout);
    const distribution: PostgresDistribution = {
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
    const launchStartedAt = new Date("2026-08-17T00:00:00.000Z");
    const upperBoundary =
      launchStartedAt.getTime() + PG_CTL_START_WAIT_SECONDS * 1_000 + CREATION_TIME_TOLERANCE_MS;
    const execute = async (postmasterStartTime: string) =>
      probePrivatePostgresIdentity({
        layout,
        distribution,
        port: 55432,
        password: "identity-test-password",
        clusterId: marker.clusterId,
        launchStartedAt,
        execute: async () => ({
          ok: true,
          output: "",
          sqlState: null,
          rows: [
            {
              data_directory: layout.data,
              cluster_name: expectedClusterName(marker.clusterId),
              port: "55432",
              server_version_num: "160010",
              postmaster_start_time: postmasterStartTime
            }
          ]
        })
      });

    const atUpperBoundary = await execute(new Date(upperBoundary).toISOString());
    const afterUpperBoundary = await execute(new Date(upperBoundary + 1).toISOString());
    expect(atUpperBoundary.startTimePlausible).toBe(true);
    expect(afterUpperBoundary.startTimePlausible).toBe(false);
  });

  it("refuses init over non-empty PGDATA without a YUVI marker", () => {
    const layout = layoutFromRoot(fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-foreign-")));
    tempDirs.push(layout.root);
    ensurePostgresDirectories(layout);
    fs.writeFileSync(path.join(layout.data, "PG_VERSION"), "16\n");
    const result = inspectExistingCluster(layout);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("POSTGRES_FOREIGN_PGDATA");
  });

  it("refuses a marker/cluster mismatch and a wrong major", () => {
    const layout = layoutFromRoot(fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-mismatch-")));
    tempDirs.push(layout.root);
    ensurePostgresDirectories(layout);
    const marker = createClusterMarker(layout);
    writeClusterMarker(layout, { ...marker, dataDirectory: "/not/this/data" });
    fs.writeFileSync(path.join(layout.data, "PG_VERSION"), "16\n");
    writeInitializationState(layout, "ready");
    const mismatch = inspectExistingCluster(layout);
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.code).toBe("POSTGRES_MARKER_MISMATCH");

    const wrong = layoutFromRoot(fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-v18-")));
    tempDirs.push(wrong.root);
    ensurePostgresDirectories(wrong);
    writeClusterMarker(wrong, createClusterMarker(wrong));
    fs.writeFileSync(path.join(wrong.data, "PG_VERSION"), "18\n");
    writeInitializationState(wrong, "ready");
    const major = inspectExistingCluster(wrong);
    expect(major.ok).toBe(false);
    if (!major.ok) expect(major.code).toBe("POSTGRES_MAJOR_MISMATCH");
  });

  it("generates localhost-only scram config without trust", () => {
    const layout = layoutFromRoot(fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-conf-")));
    tempDirs.push(layout.root);
    ensurePostgresDirectories(layout);
    fs.writeFileSync(path.join(layout.data, "postgresql.conf"), "# stock\n");
    writeLocalOnlyConfig(layout, 55432);
    const yuvi = fs.readFileSync(path.join(layout.data, "postgresql.yuvi.conf"), "utf8");
    const hba = fs.readFileSync(path.join(layout.data, "pg_hba.conf"), "utf8");
    expect(yuvi).toContain("listen_addresses = '127.0.0.1'");
    expect(yuvi).not.toContain("0.0.0.0");
    expect(yuvi).not.toContain("*");
    expect(hba).toContain("scram-sha-256");
    expect(hba).not.toMatch(/\btrust\b/);
    const password = generatePostgresPassword();
    expect(redactSecretText(yuvi, [password])).not.toContain(password);
    expect(redactSecretText(hba, [password])).not.toContain(password);
  });

  it("builds a start command without a secret URL", () => {
    const layout = layoutFromRoot(fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-cmd-")));
    tempDirs.push(layout.root);
    const command = buildPostgresStartCommand(
      layout,
      {
        home: "/opt/pg16",
        binDir: "/opt/pg16/bin",
        postgres: "/opt/pg16/bin/postgres",
        pgCtl: "/opt/pg16/bin/pg_ctl",
        initdb: "/opt/pg16/bin/initdb",
        createdb: null,
        psql: "/opt/pg16/bin/psql",
        major: 16,
        versionText: "postgres (PostgreSQL) 16.0"
      },
      55432,
      "abc-cluster"
    );
    expect(command.args).toContain("127.0.0.1");
    expect(command.args).toContain(`unix_socket_directories=${layout.runtime}`);
    expect(command.args.join(" ")).not.toContain("postgres://");
    expect(command.env["PGPASSWORD"]).toBeUndefined();
    expect(command.commandMarker).toBe("yuvi-pg-abc-cluster");
  });

  it("builds a fenced Windows pg_ctl start command without PATH or secrets", () => {
    const layout = layoutFromRoot(fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-ctl-")));
    tempDirs.push(layout.root);
    const clusterId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const args = buildWindowsPgCtlStartArguments({
      layout,
      port: 55432,
      clusterId
    });
    expect(args).toEqual([
      "start",
      "-w",
      "-t",
      String(PG_CTL_START_WAIT_SECONDS),
      "-D",
      layout.data,
      "-l",
      layout.logFile,
      "-o",
      "-p 55432 -c cluster_name=yuvi-pg-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee -c unix_socket_directories="
    ]);
    const serverOptions = args[args.indexOf("-o") + 1];
    expect(serverOptions).toBe(
      "-p 55432 -c cluster_name=yuvi-pg-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee -c unix_socket_directories="
    );
    expect(serverOptions).not.toContain('unix_socket_directories=""');
    expect(serverOptions).not.toContain("unix_socket_directories=''");
    expect(serverOptions).not.toContain("-k");
    const joined = args.join(" ");
    expect(joined).not.toMatch(/(?:^|\s)pg_ctl(?:\s|$)/);
    expect(joined).not.toContain("PGPASSWORD");
    expect(joined).not.toContain("password");
    expect(args[5]).toBe(layout.data);
    expect(layout.logFile.startsWith(layout.root)).toBe(true);
  });

  it("overrides a stale long socket directory on an already initialized Windows cluster", () => {
    const layout = layoutFromRoot(fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-ctl-stale-")));
    tempDirs.push(layout.root);
    ensurePostgresDirectories(layout);
    const staleSocketDir = path.join(layout.root, "a".repeat(180));
    const config = `unix_socket_directories = '${staleSocketDir.replaceAll("\\", "/")}'\n`;
    fs.writeFileSync(path.join(layout.data, "postgresql.conf"), config, "utf8");

    const args = buildWindowsPgCtlStartArguments({
      layout,
      port: 55432,
      clusterId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    });

    expect(fs.readFileSync(path.join(layout.data, "postgresql.conf"), "utf8")).toBe(config);
    expect(args[args.indexOf("-o") + 1]).toBe(
      "-p 55432 -c cluster_name=yuvi-pg-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee -c unix_socket_directories="
    );
  });

  it("rejects unsafe cluster ids and ports before interpolating -o", () => {
    expect(() => assertPrivatePostgresPort(0)).toThrow(/TCP port/);
    expect(() => assertPrivatePostgresPort(65536)).toThrow(/TCP port/);
    expect(() => assertYuviClusterId('id"quoted')).toThrow(/cluster id/);
    expect(() => assertYuviClusterId("id with space")).toThrow(/cluster id/);
    expect(() => assertYuviClusterId("id&more")).toThrow(/cluster id/);
    expect(() => assertYuviClusterId("id|more")).toThrow(/cluster id/);
    expect(() => assertYuviClusterId("id\nmore")).toThrow(/cluster id/);
    expect(assertYuviClusterId("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")).toBe(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    );
  });

  it("invokes distribution.pgCtl with shell disabled and never publishes the launcher pid", async () => {
    const layout = layoutFromRoot(fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-ctl-run-")));
    tempDirs.push(layout.root);
    ensurePostgresDirectories(layout);
    const marker = createClusterMarker(layout);
    writeClusterMarker(layout, marker);
    fs.writeFileSync(path.join(layout.data, "PG_VERSION"), "16\n");
    const distribution: import("./postgres-distribution.js").PostgresDistribution = {
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
    const captured: {
      command: string;
      args: readonly string[];
      options?: { shell?: boolean; windowsHide?: boolean };
    } = { command: "", args: [] };
    let inspectionCalls = 0;
    const fakePgCtl: import("./postgres-cluster.js").WindowsPgCtlSpawnAsync = async (
      command,
      args,
      options
    ) => {
      captured.command = command;
      captured.args = args;
      captured.options = options;
      return { ok: true, kind: "SUCCESS", status: 0, signal: null, stdout: "", stderr: "" };
    };
    const started = await invokeWindowsPgCtlStart({
      layout,
      distribution,
      port: 55432,
      clusterId: marker.clusterId,
      spawnImpl: fakePgCtl
    });
    expect(started.ok).toBe(true);
    expect(captured.command).toBe(distribution.pgCtl);
    expect(captured.command).not.toBe("pg_ctl");
    expect(captured.options?.shell).toBe(false);
    expect(captured.options?.windowsHide).toBe(true);
    expect(captured.args).toContain("-w");
    expect(captured.args).toContain("-D");
    fs.writeFileSync(path.join(layout.data, "postmaster.pid"), "4242\n");
    const launched = await launchWindowsPrivatePostgres({
      layout,
      distribution,
      port: 55432,
      clusterId: marker.clusterId,
      spawnImpl: fakePgCtl,
      inspectProcess: (processId) => {
        inspectionCalls += 1;
        return {
          status: "resolved",
          processId,
          info: {
            processId,
            parentProcessId: 1,
            commandLine: `${distribution.postgres} -D ${layout.data} -p 55432 -c cluster_name=yuvi-pg-${marker.clusterId}`,
            createdAtUtc: new Date(),
            executablePath: distribution.postgres
          }
        };
      }
    });
    expect(launched.outcome).toBe("started");
    expect(inspectionCalls).toBe(1);
    if (launched.outcome === "started") {
      expect(launched.pid).toBe(4242);
    }

    fs.rmSync(path.join(layout.data, "postmaster.pid"), { force: true });
    const missingAfterDelete = await launchWindowsPrivatePostgres({
      layout,
      distribution,
      port: 55432,
      clusterId: marker.clusterId,
      spawnImpl: fakePgCtl,
      settleTimeoutMs: 15,
      settleIntervalMs: 5,
      sleepImpl: async () => undefined,
      nowMs: (() => {
        let t = 0;
        return () => {
          t += 15;
          return t;
        };
      })(),
      inspectProcess: () => {
        throw new Error("must not inspect when postmaster.pid is absent");
      }
    });
    expect(missingAfterDelete.outcome).toBe("uncertain");
    if (missingAfterDelete.outcome === "uncertain") {
      expect(missingAfterDelete.code).toBe("POSTGRES_POSTMASTER_IDENTITY_UNPROVEN");
    }
  });

  it("emits bounded launch, PID, inspection, and ownership diagnostics", async () => {
    const layout = layoutFromRoot(fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-ctl-diag-")));
    tempDirs.push(layout.root);
    ensurePostgresDirectories(layout);
    const marker = createClusterMarker(layout);
    writeClusterMarker(layout, marker);
    fs.writeFileSync(path.join(layout.data, "PG_VERSION"), "16\n");
    const distribution: import("./postgres-distribution.js").PostgresDistribution = {
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
    const started = new Date();
    const ownedInspection = (
      processId: number
    ): Extract<ProcessInspectionResult, { status: "resolved" }> => ({
      status: "resolved",
      processId,
      info: {
        processId,
        parentProcessId: 1,
        commandLine: `${distribution.postgres} -D ${layout.data} -p 55432 -c cluster_name=yuvi-pg-${marker.clusterId}`,
        createdAtUtc: started,
        executablePath: distribution.postgres
      }
    });
    const diagnostics: Array<import("./postgres-cluster.js").PostgresLaunchDiagnostic> = [];

    fs.writeFileSync(path.join(layout.data, "postmaster.pid"), "4242\n");
    const success = await launchWindowsPrivatePostgres({
      layout,
      distribution,
      port: 55432,
      clusterId: marker.clusterId,
      spawnImpl: async () => ({
        ok: true,
        kind: "SUCCESS",
        status: 0,
        signal: null,
        stdout: "",
        stderr: ""
      }),
      now: () => started,
      inspectProcess: ownedInspection,
      diagnosticSink: (diagnostic) => diagnostics.push(diagnostic)
    });
    expect(success.outcome).toBe("started");
    expect(diagnostics).toEqual([
      {
        phase: "PG_CTL_LAUNCH",
        status: "SUCCESS",
        exitCode: 0,
        signal: null,
        pgCtlStdoutTail: "",
        pgCtlStderrTail: ""
      },
      {
        phase: "POSTMASTER_PID",
        status: "PRESENT",
        postmasterPid: 4242,
        source: "immediate"
      },
      { phase: "PROCESS_INSPECTION", status: "RESOLVED", processId: 4242 },
      { phase: "OWNERSHIP", status: "ACCEPTED", reason: "NONE", postmasterPid: 4242 }
    ]);

    const inspectionFailure: Array<import("./postgres-cluster.js").PostgresLaunchDiagnostic> = [];
    const uncertain = await launchWindowsPrivatePostgres({
      layout,
      distribution,
      port: 55432,
      clusterId: marker.clusterId,
      spawnImpl: async () => ({
        ok: true,
        kind: "SUCCESS",
        status: 0,
        signal: null,
        stdout: "",
        stderr: ""
      }),
      now: () => started,
      inspectProcess: (processId) => ({
        status: "unavailable",
        processId,
        reason: "query-timeout"
      }),
      diagnosticSink: (diagnostic) => inspectionFailure.push(diagnostic)
    });
    expect(uncertain.outcome).toBe("uncertain");
    expect(inspectionFailure).toContainEqual({
      phase: "PROCESS_INSPECTION",
      status: "QUERY_TIMEOUT",
      processId: 4242
    });
    expect(inspectionFailure).toContainEqual({
      phase: "OWNERSHIP",
      status: "UNCERTAIN",
      reason: "PROCESS_UNRESOLVED",
      postmasterPid: 4242
    });

    const ownershipRejection: Array<import("./postgres-cluster.js").PostgresLaunchDiagnostic> = [];
    const rejected = reconcileWindowsPrivatePostgresLaunch({
      layout,
      distribution,
      launchStartedAt: started,
      inspectProcess: (processId) => ({
        status: "resolved",
        processId,
        info: {
          ...ownedInspection(processId).info,
          executablePath: "/other/postgres"
        }
      }),
      diagnosticSink: (diagnostic) => ownershipRejection.push(diagnostic)
    });
    expect(rejected.disposition).toBe("uncertain");
    expect(ownershipRejection).toContainEqual({
      phase: "OWNERSHIP",
      status: "REJECTED",
      reason: "EXECUTABLE_MISMATCH",
      postmasterPid: 4242
    });

    fs.rmSync(path.join(layout.data, "postmaster.pid"), { force: true });
    const ambiguous: Array<import("./postgres-cluster.js").PostgresLaunchDiagnostic> = [];
    const ambiguousLaunch = await launchWindowsPrivatePostgres({
      layout,
      distribution,
      port: 55432,
      clusterId: marker.clusterId,
      settleTimeoutMs: 0,
      spawnImpl: async () => ({
        ok: false as const,
        kind: "POST_SPAWN_ERROR",
        status: null,
        signal: null,
        stdout: "",
        stderr: "",
        detail: "launcher failed after spawn"
      }),
      inspectProcess: () => {
        throw new Error("missing PID must not be inspected");
      },
      diagnosticSink: (diagnostic) => ambiguous.push(diagnostic)
    });
    expect(ambiguousLaunch.outcome).toBe("uncertain");
    expect(ambiguous).toContainEqual({
      phase: "PG_CTL_LAUNCH",
      status: "POST_SPAWN_ERROR",
      exitCode: null,
      signal: null,
      pgCtlStdoutTail: "",
      pgCtlStderrTail: ""
    });
    expect(ambiguous.at(-1)).toEqual({
      phase: "POSTMASTER_PID",
      status: "MISSING",
      postmasterPid: null,
      source: "delayed-settle"
    });
  });

  it("surfaces bounded redacted pg_ctl output without changing launch classification", async () => {
    const layout = layoutFromRoot(fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-ctl-output-")));
    tempDirs.push(layout.root);
    ensurePostgresDirectories(layout);
    const marker = createClusterMarker(layout);
    writeClusterMarker(layout, marker);
    fs.writeFileSync(path.join(layout.data, "PG_VERSION"), "16\n");
    const distribution: import("./postgres-distribution.js").PostgresDistribution = {
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
    const secret = "YUVI_TEST_SECRET_DO_NOT_PRINT";
    const stdout = `HEAD_ONLY_SENTINEL ${"x".repeat(800)} STDOUT_TAIL_SENTINEL`;
    const stderr = [
      `PGPASSWORD=${secret}`,
      `DATABASE_URL=postgres://yuvi:${secret}@127.0.0.1/yuvi`,
      `${"e".repeat(800)} STDERR_TAIL_SENTINEL`
    ].join("\n");
    const diagnostics: Array<import("./postgres-cluster.js").PostgresLaunchDiagnostic> = [];
    const launched = await launchWindowsPrivatePostgres({
      layout,
      distribution,
      port: 55432,
      clusterId: marker.clusterId,
      diagnosticSecrets: [secret],
      spawnImpl: async () => ({
        ok: false,
        kind: "EXIT_NONZERO",
        status: 1,
        signal: null,
        stdout,
        stderr,
        detail: "pg_ctl failed"
      }),
      settleTimeoutMs: 0,
      sleepImpl: async () => undefined,
      inspectProcess: () => {
        throw new Error("missing PID must not be inspected");
      },
      diagnosticSink: (diagnostic) => diagnostics.push(diagnostic)
    });
    expect(launched.outcome).toBe("uncertain");
    const launch = diagnostics[0];
    expect(launch?.phase).toBe("PG_CTL_LAUNCH");
    if (launch?.phase !== "PG_CTL_LAUNCH") return;
    expect(launch.status).toBe("EXIT_NONZERO");
    expect(launch.pgCtlStdoutTail.length).toBeLessThanOrEqual(512);
    expect(launch.pgCtlStderrTail.length).toBeLessThanOrEqual(512);
    expect(launch.pgCtlStdoutTail).not.toContain("HEAD_ONLY_SENTINEL");
    expect(launch.pgCtlStdoutTail).toContain("STDOUT_TAIL_SENTINEL");
    expect(launch.pgCtlStderrTail).not.toContain(secret);
    expect(launch.pgCtlStderrTail).toContain("STDERR_TAIL_SENTINEL");
  });

  it("contains diagnostic sink failures without changing the launch result", async () => {
    const layout = layoutFromRoot(fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-ctl-sink-")));
    tempDirs.push(layout.root);
    ensurePostgresDirectories(layout);
    const marker = createClusterMarker(layout);
    writeClusterMarker(layout, marker);
    fs.writeFileSync(path.join(layout.data, "PG_VERSION"), "16\n");
    const distribution: import("./postgres-distribution.js").PostgresDistribution = {
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
    const launchInput = {
      layout,
      distribution,
      port: 55432,
      clusterId: marker.clusterId,
      settleTimeoutMs: 0,
      spawnImpl: async () => ({
        ok: false as const,
        kind: "EXIT_NONZERO" as const,
        status: 1,
        signal: null,
        stdout: "PG_CTL_STDOUT",
        stderr: "PG_CTL_STDERR",
        detail: "pg_ctl failed"
      }),
      inspectProcess: () => {
        throw new Error("missing PID must not be inspected");
      }
    };
    const control = await launchWindowsPrivatePostgres(launchInput);
    const contained = await launchWindowsPrivatePostgres({
      ...launchInput,
      diagnosticSink: () => {
        throw new Error("diagnostic sink failure");
      }
    });
    expect(contained.outcome).toBe(control.outcome);
    expect(contained).toEqual(control);
  });

  it("classifies async pg_ctl outcomes without blocking the event loop", async () => {
    expect(classifyWindowsPgCtlChildExit({ status: 0, signal: null }).kind).toBe("SUCCESS");
    expect(classifyWindowsPgCtlChildExit({ status: 1, signal: null, stderr: "failed" }).kind).toBe(
      "EXIT_NONZERO"
    );
    expect(classifyWindowsPgCtlChildExit({ status: null, signal: null, timedOut: true }).kind).toBe(
      "TIMEOUT"
    );
    expect(
      classifyWindowsPgCtlChildExit({
        status: null,
        signal: null,
        error: new Error("ENOENT")
      }).kind
    ).toBe("PRE_SPAWN_ERROR");
    expect(
      classifyWindowsPgCtlChildExit({
        status: null,
        signal: null,
        error: new Error("kill failed"),
        spawned: true
      }).kind
    ).toBe("POST_SPAWN_ERROR");
    expect(classifyWindowsPgCtlChildExit({ status: null, signal: "SIGTERM" }).kind).toBe(
      "SIGNALLED"
    );

    let ticks = 0;
    const ticker = setInterval(() => {
      ticks += 1;
    }, 8);
    const result = await runWindowsPgCtlChild(
      process.execPath,
      ["-e", "setTimeout(() => {}, 5000)"],
      {
        windowsHide: true,
        shell: false,
        timeoutMs: 40
      }
    );
    clearInterval(ticker);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("TIMEOUT");
    expect(ticks).toBeGreaterThan(0);

    const nonzero = await runWindowsPgCtlChild(process.execPath, ["-e", "process.exit(3)"], {
      windowsHide: true,
      shell: false,
      timeoutMs: 5_000
    });
    expect(nonzero.ok).toBe(false);
    if (!nonzero.ok) expect(nonzero.kind).toBe("EXIT_NONZERO");

    const success = await runWindowsPgCtlChild(process.execPath, ["-e", "process.exit(0)"], {
      windowsHide: true,
      shell: false,
      timeoutMs: 5_000
    });
    expect(success.ok).toBe(true);

    const missing = await runWindowsPgCtlChild(path.join(os.tmpdir(), "yuvi-missing-pg-ctl"), [], {
      windowsHide: true,
      shell: false,
      timeoutMs: 1_000
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.kind).toBe("PRE_SPAWN_ERROR");
    expect(launcherProcessWasNeverCreated(missing)).toBe(true);
  });

  it("reconciles failed and successful pg_ctl launches against postmaster.pid", async () => {
    const layout = layoutFromRoot(fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-ctl-rec-")));
    tempDirs.push(layout.root);
    ensurePostgresDirectories(layout);
    const marker = createClusterMarker(layout);
    writeClusterMarker(layout, marker);
    fs.writeFileSync(path.join(layout.data, "PG_VERSION"), "16\n");
    const distribution: import("./postgres-distribution.js").PostgresDistribution = {
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
    const started = new Date();
    const inspectOwned = (processId: number) => ({
      status: "resolved" as const,
      processId,
      info: {
        processId,
        parentProcessId: 1,
        commandLine: `${distribution.postgres} -D ${layout.data} -p 55432 -c cluster_name=yuvi-pg-${marker.clusterId}`,
        createdAtUtc: started,
        executablePath: distribution.postgres
      }
    });
    const failLauncher: import("./postgres-cluster.js").WindowsPgCtlSpawnAsync = async () => ({
      ok: false,
      kind: "EXIT_NONZERO",
      status: 1,
      signal: null,
      stdout: "",
      stderr: "pg_ctl failed",
      detail: "pg_ctl failed"
    });

    const noPid = await launchWindowsPrivatePostgres({
      layout,
      distribution,
      port: 55432,
      clusterId: marker.clusterId,
      spawnImpl: failLauncher,
      settleTimeoutMs: 15,
      settleIntervalMs: 5,
      sleepImpl: async () => undefined,
      nowMs: (() => {
        let t = 0;
        return () => {
          t += 15;
          return t;
        };
      })(),
      inspectProcess: () => {
        throw new Error("must not inspect when postmaster.pid is absent");
      }
    });
    expect(noPid.outcome).toBe("uncertain");
    if (noPid.outcome === "uncertain") {
      expect(noPid.code).toBe("POSTGRES_START_IDENTITY_UNCERTAIN");
    }
    expect(
      reconcileWindowsPrivatePostgresLaunch({
        layout,
        distribution,
        inspectProcess: () => {
          throw new Error("absent");
        },
        launchStartedAt: started
      }).disposition
    ).toBe("missing");

    fs.writeFileSync(path.join(layout.data, "postmaster.pid"), "4242\n");
    const ownedAfterFail = await launchWindowsPrivatePostgres({
      layout,
      distribution,
      port: 55432,
      clusterId: marker.clusterId,
      spawnImpl: failLauncher,
      now: () => started,
      inspectProcess: inspectOwned
    });
    expect(ownedAfterFail.outcome).toBe("owned-after-failure");
    if (ownedAfterFail.outcome === "owned-after-failure") {
      expect(ownedAfterFail.pid).toBe(4242);
    }

    const uncertain = await launchWindowsPrivatePostgres({
      layout,
      distribution,
      port: 55432,
      clusterId: marker.clusterId,
      spawnImpl: failLauncher,
      now: () => started,
      inspectProcess: () => ({
        status: "unavailable",
        processId: 4242,
        reason: "query-timeout"
      })
    });
    expect(uncertain.outcome).toBe("uncertain");

    const successUnproven = await launchWindowsPrivatePostgres({
      layout,
      distribution,
      port: 55432,
      clusterId: marker.clusterId,
      spawnImpl: async () => ({
        ok: true,
        kind: "SUCCESS",
        status: 0,
        signal: null,
        stdout: "",
        stderr: ""
      }),
      now: () => started,
      inspectProcess: () => ({
        status: "resolved",
        processId: 4242,
        info: {
          processId: 4242,
          parentProcessId: 1,
          commandLine: `/usr/bin/postgres -D ${layout.data} -c cluster_name=yuvi-pg-${marker.clusterId}`,
          createdAtUtc: started,
          executablePath: "/usr/bin/postgres"
        }
      })
    });
    expect(successUnproven.outcome).toBe("uncertain");
  });

  it("settles a delayed postmaster.pid after an ambiguous launcher failure", async () => {
    const layout = layoutFromRoot(fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-ctl-delay-")));
    tempDirs.push(layout.root);
    ensurePostgresDirectories(layout);
    const marker = createClusterMarker(layout);
    writeClusterMarker(layout, marker);
    fs.writeFileSync(path.join(layout.data, "PG_VERSION"), "16\n");
    const distribution: import("./postgres-distribution.js").PostgresDistribution = {
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
    const started = new Date();
    let reads = 0;
    let clock = 0;
    const delayed = await launchWindowsPrivatePostgres({
      layout,
      distribution,
      port: 55432,
      clusterId: marker.clusterId,
      now: () => started,
      settleTimeoutMs: 20,
      settleIntervalMs: 5,
      sleepImpl: async () => {
        clock += 5;
      },
      nowMs: () => clock,
      readPid: () => {
        reads += 1;
        return reads < 3 ? null : 4242;
      },
      spawnImpl: async () => ({
        ok: false,
        kind: "TIMEOUT",
        status: null,
        signal: null,
        stdout: "",
        stderr: "",
        detail: "timed out"
      }),
      inspectProcess: (processId) => ({
        status: "resolved",
        processId,
        info: {
          processId,
          parentProcessId: 1,
          commandLine: `${distribution.postgres} -D ${layout.data} -p 55432 -c cluster_name=yuvi-pg-${marker.clusterId}`,
          createdAtUtc: started,
          executablePath: distribution.postgres
        }
      })
    });
    expect(reads).toBeGreaterThan(1);
    expect(delayed.outcome).toBe("owned-after-failure");
    if (delayed.outcome === "owned-after-failure") expect(delayed.pid).toBe(4242);

    const unprovenDelayed = await launchWindowsPrivatePostgres({
      layout,
      distribution,
      port: 55432,
      clusterId: marker.clusterId,
      now: () => started,
      settleTimeoutMs: 20,
      settleIntervalMs: 5,
      sleepImpl: async () => {
        clock += 5;
      },
      nowMs: () => clock,
      readPid: (() => {
        let n = 0;
        return () => {
          n += 1;
          return n < 2 ? null : 4242;
        };
      })(),
      spawnImpl: async () => ({
        ok: false,
        kind: "EXIT_NONZERO",
        status: 1,
        signal: null,
        stdout: "",
        stderr: "failed",
        detail: "failed"
      }),
      inspectProcess: () => ({
        status: "unavailable",
        processId: 4242,
        reason: "query-timeout"
      })
    });
    expect(unprovenDelayed.outcome).toBe("uncertain");
  });

  it("halts when an ambiguous launcher leaves no postmaster.pid after the settle window", async () => {
    const layout = layoutFromRoot(fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-ctl-miss-")));
    tempDirs.push(layout.root);
    ensurePostgresDirectories(layout);
    const marker = createClusterMarker(layout);
    writeClusterMarker(layout, marker);
    fs.writeFileSync(path.join(layout.data, "PG_VERSION"), "16\n");
    const distribution: import("./postgres-distribution.js").PostgresDistribution = {
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
    const kinds = ["TIMEOUT", "EXIT_NONZERO", "SIGNALLED"] as const;
    for (const kind of kinds) {
      const launched = await launchWindowsPrivatePostgres({
        layout,
        distribution,
        port: 55432,
        clusterId: marker.clusterId,
        settleTimeoutMs: 15,
        settleIntervalMs: 5,
        sleepImpl: async () => undefined,
        nowMs: (() => {
          let t = 0;
          return () => {
            t += 15;
            return t;
          };
        })(),
        spawnImpl: async () =>
          kind === "EXIT_NONZERO"
            ? {
                ok: false,
                kind,
                status: 1,
                signal: null,
                stdout: "",
                stderr: "failed",
                detail: "failed"
              }
            : {
                ok: false,
                kind,
                status: null,
                signal: kind === "SIGNALLED" ? "SIGTERM" : null,
                stdout: "",
                stderr: "",
                detail: kind.toLowerCase()
              },
        inspectProcess: () => {
          throw new Error(`${kind} must not inspect a missing PID`);
        }
      });
      expect(launched.outcome, kind).toBe("uncertain");
      if (launched.outcome === "uncertain") {
        expect(launched.code).toBe("POSTGRES_START_IDENTITY_UNCERTAIN");
      }
    }

    const successMissing = await launchWindowsPrivatePostgres({
      layout,
      distribution,
      port: 55432,
      clusterId: marker.clusterId,
      settleTimeoutMs: 15,
      settleIntervalMs: 5,
      sleepImpl: async () => undefined,
      nowMs: (() => {
        let t = 0;
        return () => {
          t += 15;
          return t;
        };
      })(),
      spawnImpl: async () => ({
        ok: true,
        kind: "SUCCESS",
        status: 0,
        signal: null,
        stdout: "",
        stderr: ""
      }),
      inspectProcess: () => {
        throw new Error("success-missing must not inspect");
      }
    });
    expect(successMissing.outcome).toBe("uncertain");
    if (successMissing.outcome === "uncertain") {
      expect(successMissing.code).toBe("POSTGRES_POSTMASTER_IDENTITY_UNPROVEN");
    }

    const spawnError = await launchWindowsPrivatePostgres({
      layout,
      distribution,
      port: 55432,
      clusterId: marker.clusterId,
      spawnImpl: async () => ({
        ok: false,
        kind: "PRE_SPAWN_ERROR",
        status: null,
        signal: null,
        stdout: "",
        stderr: "",
        detail: "ENOENT"
      }),
      inspectProcess: () => {
        throw new Error("spawn error must not inspect when no candidate exists");
      }
    });
    expect(spawnError.outcome).toBe("quiescent-failure");
    expect(launcherProcessWasNeverCreated(spawnError.launcher)).toBe(true);
    expect(
      await waitForPostmasterCandidate({ dataDirectory: layout.data, timeoutMs: 0 })
    ).toBeNull();
  });

  it("classifies ChildProcess error before spawn as pre-spawn and spawn-then-error as post-spawn", async () => {
    function fakeChild(sequence: Array<"spawn" | "error">, error = new Error("boom")) {
      const emitter = new EventEmitter() as EventEmitter & WindowsPgCtlChildHandle;
      emitter.stdout = null;
      emitter.stderr = null;
      emitter.kill = () => undefined;
      queueMicrotask(() => {
        for (const event of sequence) {
          if (event === "spawn") emitter.emit("spawn");
          else emitter.emit("error", error);
        }
      });
      return emitter;
    }

    const preSpawn = await runWindowsPgCtlChild("pg_ctl", ["start"], {
      windowsHide: true,
      shell: false,
      timeoutMs: 1_000,
      createChild: () => fakeChild(["error"])
    });
    expect(preSpawn.ok).toBe(false);
    if (!preSpawn.ok) expect(preSpawn.kind).toBe("PRE_SPAWN_ERROR");
    expect(launcherProcessWasNeverCreated(preSpawn)).toBe(true);

    const postSpawn = await runWindowsPgCtlChild("pg_ctl", ["start"], {
      windowsHide: true,
      shell: false,
      timeoutMs: 1_000,
      createChild: () => fakeChild(["spawn", "error"])
    });
    expect(postSpawn.ok).toBe(false);
    if (!postSpawn.ok) expect(postSpawn.kind).toBe("POST_SPAWN_ERROR");
    expect(launcherProcessWasNeverCreated(postSpawn)).toBe(false);

    const syncThrow = await runWindowsPgCtlChild("pg_ctl", ["start"], {
      windowsHide: true,
      shell: false,
      timeoutMs: 1_000,
      createChild: () => {
        throw new Error("create failed");
      }
    });
    expect(syncThrow.ok).toBe(false);
    if (!syncThrow.ok) expect(syncThrow.kind).toBe("PRE_SPAWN_ERROR");
    expect(launcherProcessWasNeverCreated(syncThrow)).toBe(true);

    const layout = layoutFromRoot(fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-ctl-post-")));
    tempDirs.push(layout.root);
    ensurePostgresDirectories(layout);
    const marker = createClusterMarker(layout);
    writeClusterMarker(layout, marker);
    fs.writeFileSync(path.join(layout.data, "PG_VERSION"), "16\n");
    const distribution: import("./postgres-distribution.js").PostgresDistribution = {
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
    const started = new Date();
    const missingAfterPostSpawn = await launchWindowsPrivatePostgres({
      layout,
      distribution,
      port: 55432,
      clusterId: marker.clusterId,
      now: () => started,
      settleTimeoutMs: 15,
      settleIntervalMs: 5,
      sleepImpl: async () => undefined,
      nowMs: (() => {
        let t = 0;
        return () => {
          t += 15;
          return t;
        };
      })(),
      spawnImpl: async () => postSpawn,
      inspectProcess: () => {
        throw new Error("post-spawn missing PID must not inspect");
      }
    });
    expect(missingAfterPostSpawn.outcome).toBe("uncertain");
    if (missingAfterPostSpawn.outcome === "uncertain") {
      expect(missingAfterPostSpawn.code).toBe("POSTGRES_START_IDENTITY_UNCERTAIN");
    }
    expect(launcherProcessWasNeverCreated(missingAfterPostSpawn.launcher)).toBe(false);

    let reads = 0;
    let clock = 0;
    const delayedOwned = await launchWindowsPrivatePostgres({
      layout,
      distribution,
      port: 55432,
      clusterId: marker.clusterId,
      now: () => started,
      settleTimeoutMs: 20,
      settleIntervalMs: 5,
      sleepImpl: async () => {
        clock += 5;
      },
      nowMs: () => clock,
      readPid: () => {
        reads += 1;
        return reads < 3 ? null : 4242;
      },
      spawnImpl: async () => postSpawn,
      inspectProcess: (processId) => ({
        status: "resolved",
        processId,
        info: {
          processId,
          parentProcessId: 1,
          commandLine: `${distribution.postgres} -D ${layout.data} -p 55432 -c cluster_name=yuvi-pg-${marker.clusterId}`,
          createdAtUtc: started,
          executablePath: distribution.postgres
        }
      })
    });
    expect(delayedOwned.outcome).toBe("owned-after-failure");
    expect(launcherProcessWasNeverCreated(delayedOwned.launcher)).toBe(false);
  });

  it("treats SQLSTATE 42P04 as idempotent yuvi database creation", async () => {
    const distribution: import("./postgres-distribution.js").PostgresDistribution = {
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
    const created = await ensureYuviDatabase({
      distribution,
      port: 55432,
      password: "secret",
      execute: async () => ({ ok: true, output: "", sqlState: null })
    });
    expect(created).toEqual({
      ok: true,
      created: true,
      alreadyExists: false,
      sqlState: null
    });
    const existing = await ensureYuviDatabase({
      distribution,
      port: 55432,
      password: "secret",
      execute: async () => ({ ok: false, output: "duplicate_database", sqlState: "42P04" })
    });
    expect(existing.ok).toBe(true);
    if (existing.ok) {
      expect(existing.alreadyExists).toBe(true);
      expect(existing.sqlState).toBe("42P04");
    }
    const failed = await ensureYuviDatabase({
      distribution,
      port: 55432,
      password: "secret",
      execute: async () => ({ ok: false, output: "insufficient_privilege", sqlState: "42501" })
    });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.sqlState).toBe("42501");
    const auth = await ensureYuviDatabase({
      distribution,
      port: 55432,
      password: "secret",
      execute: async () => ({ ok: false, output: "password authentication failed", sqlState: null })
    });
    expect(auth.ok).toBe(false);
  });
});

describe("initdb failure evidence", () => {
  const windowsBanner = [
    'The files belonging to this database system will be owned by user "runneradmin".',
    "",
    "This user must also own the server process.",
    "",
    'The database cluster will be initialized with locale "C".',
    'The default text search configuration will be set to "english".',
    ""
  ].join("\n");

  function emptyLayout() {
    const layout = layoutFromRoot(fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-initdb-")));
    tempDirs.push(layout.root);
    ensurePostgresDirectories(layout);
    return layout;
  }

  function fakeDistribution(initdb: string): PostgresDistribution {
    const binDir = path.dirname(initdb);
    return {
      home: binDir,
      binDir,
      postgres: path.join(binDir, "postgres"),
      pgCtl: path.join(binDir, "pg_ctl"),
      initdb,
      createdb: null,
      psql: path.join(binDir, "psql"),
      major: 16,
      versionText: "postgres (PostgreSQL) 16.10"
    };
  }

  function runInitialize(initdb: string, password = generatePostgresPassword()) {
    const layout = emptyLayout();
    const result = initializePrivateCluster({
      layout,
      distribution: fakeDistribution(initdb),
      password,
      port: 55432
    });
    return { layout, result, password };
  }

  function assertInitdbSpawnCall(
    call: {
      command: string;
      args: readonly string[];
      options: Record<string, unknown> | undefined;
    },
    input: { initdb: string; dataDir: string; password: string }
  ) {
    expect(call.command).toBe(input.initdb);
    expect(call.args).toEqual(
      expect.arrayContaining([
        "-D",
        input.dataDir,
        "--encoding=UTF8",
        "--locale=C",
        "--username=yuvi",
        "--auth-host=scram-sha-256",
        "--auth-local=scram-sha-256"
      ])
    );
    const pwfile = call.args.find((value) => String(value).startsWith("--pwfile="));
    expect(pwfile).toEqual(expect.stringMatching(/^--pwfile=/));
    expect(String(pwfile)).not.toContain(input.password);
    expect(call.command).not.toContain(input.password);
    expect(call.args.join("\0")).not.toContain(input.password);
    expect(call.options?.["encoding"]).toBe("utf8");
    expect(call.options?.["timeout"]).toBe(60_000);
    expect(call.options?.["windowsHide"]).toBe(true);
  }

  function syntheticInitdbCommand(): string {
    return path.join(os.tmpdir(), "yuvi-test-initdb", `initdb-${randomUUID()}`);
  }

  function registerExactInitdbOverride(
    initdb: string,
    result: {
      error?: Error | undefined;
      status: number | null;
      signal: NodeJS.Signals | string | null;
      stdout: string;
      stderr: string;
    }
  ) {
    const invocations: Array<{
      command: string;
      args: readonly string[];
      options: Record<string, unknown> | undefined;
    }> = [];
    childProcessState.override = {
      command: initdb,
      run(command, args = [], options) {
        expect(command).toBe(initdb);
        expect(command).not.toBe("icacls");
        invocations.push({ command, args, options });
        return result;
      }
    };
    return {
      invocations,
      expectInterceptedOnce() {
        expect(invocations).toHaveLength(1);
        expect(invocations[0]?.command).toBe(initdb);
        expect(invocations.some((call) => call.command === "icacls")).toBe(false);
      }
    };
  }

  it("classifies spawn failure, nonzero exit, signal, timeout, and success separately", () => {
    expect(
      classifyInitdbSpawnResult({
        error: Object.assign(new Error("spawn initdb ENOENT"), { code: "ENOENT" }),
        status: null,
        signal: null
      })
    ).toEqual({ kind: "SPAWN_FAILED", spawnErrorCode: "ENOENT" });
    expect(
      classifyInitdbSpawnResult({
        error: Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" }),
        status: null,
        signal: "SIGTERM"
      })
    ).toEqual({ kind: "TIMEOUT", spawnErrorCode: "ETIMEDOUT", signal: "SIGTERM" });
    expect(
      classifyInitdbSpawnResult({ error: undefined, status: null, signal: "SIGTERM" })
    ).toEqual({
      kind: "SIGNALLED",
      signal: "SIGTERM"
    });
    expect(classifyInitdbSpawnResult({ error: undefined, status: 1, signal: null })).toEqual({
      kind: "EXIT_NONZERO",
      exitStatus: 1
    });
    expect(classifyInitdbSpawnResult({ error: undefined, status: 0, signal: null })).toEqual({
      kind: "SUCCESS"
    });
  });

  it("keeps a Windows initdb banner from crowding out a later stderr fatal line", () => {
    const evidence = buildInitdbFailureEvidence(
      {
        error: undefined,
        status: 1,
        signal: null,
        stdout: windowsBanner,
        stderr: "FATAL_TEST_SENTINEL\n"
      },
      { secrets: [] }
    );
    expect(evidence.errorCode).toBe("EXIT_NONZERO");
    expect(evidence.exitStatus).toBe(1);
    expect(evidence.reason).toContain("FATAL_TEST_SENTINEL");
    expect(evidence.reason).not.toContain("owned by user");
    expect(evidence.stderrTail).toContain("FATAL_TEST_SENTINEL");
    expect(evidence.stdoutTail).toContain("owned by user");
  });

  it("persists the stderr fatal sentinel after a Windows-like initdb banner", () => {
    const initdb = syntheticInitdbCommand();
    const override = registerExactInitdbOverride(initdb, {
      error: undefined,
      status: 1,
      signal: null,
      stdout: windowsBanner,
      stderr: "FATAL_TEST_SENTINEL\n"
    });
    const { layout, result, password } = runInitialize(initdb);
    override.expectInterceptedOnce();
    assertInitdbSpawnCall(override.invocations[0]!, { initdb, dataDir: layout.data, password });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("POSTGRES_INIT_FAILED");
    const state = readInitializationState(layout);
    expect(state?.state).toBe("failed");
    expect(state?.errorCode).toBe("EXIT_NONZERO");
    expect(state?.exitStatus).toBe(1);
    expect(state?.reason).toContain("FATAL_TEST_SENTINEL");
    expect(state?.reason).not.toContain("owned by user");
    expect(state?.reason).not.toMatch(/RestrictedAclError|icacls/);
    expect(state?.stderrTail).toContain("FATAL_TEST_SENTINEL");
    const serialized = fs.readFileSync(layout.initializationStateFile, "utf8");
    expect(serialized).toContain("FATAL_TEST_SENTINEL");
    expect(serialized.indexOf("FATAL_TEST_SENTINEL")).toBeGreaterThan(-1);
  });

  it("preserves a missing-executable spawn as SPAWN_FAILED with a safe code", () => {
    childProcessState.override = null;
    const { layout, result } = runInitialize(
      path.join(os.tmpdir(), "yuvi-missing-initdb", "initdb-does-not-exist")
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("POSTGRES_INIT_FAILED");
    const state = readInitializationState(layout);
    expect(state?.state).toBe("failed");
    expect(state?.errorCode).toBe("SPAWN_FAILED");
    expect(state?.spawnErrorCode).toBe("ENOENT");
    expect(state?.exitStatus).toBeNull();
    expect(state?.reason).toContain("SPAWN_FAILED");
  });

  it("preserves a signalled initdb separately from a nonzero exit", () => {
    const initdb = syntheticInitdbCommand();
    const override = registerExactInitdbOverride(initdb, {
      error: undefined,
      status: null,
      signal: "SIGTERM",
      stdout: "",
      stderr: ""
    });
    const { layout, result } = runInitialize(initdb);
    override.expectInterceptedOnce();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("POSTGRES_INIT_FAILED");
    const state = readInitializationState(layout);
    expect(state?.state).toBe("failed");
    expect(state?.errorCode).toBe("SIGNALLED");
    expect(state?.signal).toBe("SIGTERM");
    expect(state?.exitStatus).toBeNull();
    expect(state?.reason).not.toMatch(/RestrictedAclError|icacls/);
  });

  it("leaves success initialization-state free of failure evidence", () => {
    const initdb = syntheticInitdbCommand();
    const override = registerExactInitdbOverride(initdb, {
      error: undefined,
      status: 0,
      signal: null,
      stdout: "",
      stderr: ""
    });
    const { layout, result } = runInitialize(initdb);
    override.expectInterceptedOnce();
    expect(result.ok).toBe(true);
    const state = readInitializationState(layout);
    expect(state?.state).toBe("ready");
    expect(state?.reason).toBeUndefined();
    expect(state?.errorCode).toBeUndefined();
    expect(state?.stdoutTail).toBeUndefined();
    expect(state?.stderrTail).toBeUndefined();
    expect(state?.exitStatus).toBeUndefined();
    expect(state?.signal).toBeUndefined();
    expect(state?.spawnErrorCode).toBeUndefined();
    const serialized = fs.readFileSync(layout.initializationStateFile, "utf8");
    expect(serialized).not.toContain("stdoutTail");
    expect(serialized).not.toContain("stderrTail");
    expect(serialized).not.toContain("EXIT_NONZERO");
    expect(serialized).not.toMatch(/RestrictedAclError|icacls/);
  });

  it("keeps a failure sentinel from large stdout/stderr and bounds persisted tails", () => {
    const stdout = `${windowsBanner}${"BANNER_NOISE".repeat(4000)}`;
    const stderr = `${"E".repeat(8000)}\nFATAL_TEST_SENTINEL\n`;
    const evidence = buildInitdbFailureEvidence(
      { error: undefined, status: 13, signal: null, stdout, stderr },
      { secrets: [] }
    );
    expect(evidence.exitStatus).toBe(13);
    expect(evidence.stdoutTail?.length ?? 0).toBeLessThanOrEqual(INITDB_STDOUT_TAIL_MAX_CHARS);
    expect(evidence.stderrTail?.length ?? 0).toBeLessThanOrEqual(INITDB_STDERR_TAIL_MAX_CHARS);
    expect(evidence.reason.length).toBeLessThanOrEqual(INITDB_REASON_MAX_CHARS);
    expect(evidence.stderrTail).toContain("FATAL_TEST_SENTINEL");
    expect(evidence.reason).toContain("FATAL_TEST_SENTINEL");
    expect(JSON.stringify(evidence).length).toBeLessThan(12_000);
  });

  it("redacts secrets from initdb failure diagnostics and persisted state", () => {
    const logs: string[] = [];
    const spy = (method: "log" | "info" | "warn" | "error") =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logs.push(args.map((value) => String(value)).join(" "));
      });
    const spies = [spy("log"), spy("info"), spy("warn"), spy("error")];
    const initdb = syntheticInitdbCommand();
    const override = registerExactInitdbOverride(initdb, {
      error: undefined,
      status: 1,
      signal: null,
      stdout: windowsBanner,
      stderr: [
        "YUVI_POSTGRES_PASSWORD=SUPERSECRET",
        "postgres://yuvi:SUPERSECRET@127.0.0.1/yuvi",
        "password=SUPERSECRET",
        "PGPASSWORD=SUPERSECRET",
        "Bearer SUPERSECRET",
        "FATAL_TEST_SENTINEL"
      ].join("\n")
    });
    try {
      const { layout, result } = runInitialize(initdb, generatePostgresPassword());
      override.expectInterceptedOnce();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("POSTGRES_INIT_FAILED");
      const state = readInitializationState(layout);
      expect(state?.errorCode).toBe("EXIT_NONZERO");
      expect(state?.reason).not.toMatch(/RestrictedAclError|icacls/);
      const serialized = fs.readFileSync(layout.initializationStateFile, "utf8");
      for (const haystack of [
        state?.reason ?? "",
        state?.stdoutTail ?? "",
        state?.stderrTail ?? "",
        serialized,
        logs.join("\n")
      ]) {
        expect(haystack).not.toContain("SUPERSECRET");
      }
      expect(state?.reason).toContain("FATAL_TEST_SENTINEL");
      expect(state?.stderrTail).toContain("FATAL_TEST_SENTINEL");
      expect(state?.stderrTail).toMatch(/YUVI_POSTGRES_PASSWORD=\[REDACTED\]/i);
      expect(state?.stderrTail).toMatch(/password=\[REDACTED\]/i);
      expect(state?.stderrTail).toMatch(/Bearer \[REDACTED\]/i);
      expect(state?.stderrTail).toMatch(/postgres:\/\/\[REDACTED\]/i);
    } finally {
      for (const current of spies) current.mockRestore();
    }
  });
});
