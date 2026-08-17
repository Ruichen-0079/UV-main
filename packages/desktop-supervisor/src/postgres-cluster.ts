/**
 * First-run private cluster initialization and localhost-only configuration.
 * Bootstrap SQL here only creates the `yuvi` database. Yuvi schema migrations
 * belong to P4-2D2.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { canonicalPath, pathsEqual } from "./paths.js";
import type { PostgresDistribution } from "./postgres-distribution.js";
import {
  PRIVATE_POSTGRES_DATABASE,
  PRIVATE_POSTGRES_HOST,
  PRIVATE_POSTGRES_MAJOR,
  PRIVATE_POSTGRES_USER,
  assertPgdataContained,
  createClusterMarker,
  isPgdataEmpty,
  pgdataLooksInitialized,
  readClusterMarker,
  readInitializationState,
  readPgVersion,
  restrictPathToCurrentUser,
  writeClusterMarker,
  writeInitializationState,
  type PostgresInitializationFailureEvidence,
  type PostgresInitializationFailureKind,
  type PostgresLayout,
  type YuviClusterMarker
} from "./postgres-layout.js";
import { redactSecretText } from "./postgres-secret.js";
import {
  evaluatePostgresOwnership,
  expectedClusterName,
  postgresOwnershipDiagnosticReason,
  readPostmasterPid,
  type PostgresOwnershipDiagnosticReason,
  type PostgresOwnershipEvidence
} from "./postgres-ownership.js";
import type { ProcessInspectionResult } from "./types.js";

export const INITDB_REASON_MAX_CHARS = 180;
export const INITDB_STDOUT_TAIL_MAX_CHARS = 2048;
export const INITDB_STDERR_TAIL_MAX_CHARS = 4096;
export const PG_CTL_START_WAIT_SECONDS = 30;
export const PG_CTL_LAUNCH_TIMEOUT_MS = (PG_CTL_START_WAIT_SECONDS + 10) * 1000;
export const PG_CTL_OUTPUT_MAX_CHARS = 2048;
/** Small, secret-safe tails surfaced through the lifecycle diagnostic only. */
export const PG_CTL_DIAGNOSTIC_OUTPUT_MAX_CHARS = 512;
export const POSTMASTER_SETTLE_WINDOW_MS = 1_500;
export const POSTMASTER_SETTLE_INTERVAL_MS = 50;
export const DUPLICATE_DATABASE_SQLSTATE = "42P04";
export const STANDARD_POSTGRES_DATABASE = "postgres";

export type ClusterPrepareResult =
  | {
      ok: true;
      marker: YuviClusterMarker;
      initialized: boolean;
    }
  | {
      ok: false;
      code:
        | "POSTGRES_INIT_IN_PROGRESS"
        | "POSTGRES_INIT_FAILED"
        | "POSTGRES_FOREIGN_PGDATA"
        | "POSTGRES_MAJOR_MISMATCH"
        | "POSTGRES_MARKER_MISMATCH"
        | "POSTGRES_PGDATA_OUTSIDE_ROOT";
      message: string;
    };

export function inspectExistingCluster(layout: PostgresLayout): ClusterPrepareResult {
  try {
    assertPgdataContained(layout);
  } catch (error) {
    return {
      ok: false,
      code: "POSTGRES_PGDATA_OUTSIDE_ROOT",
      message: error instanceof Error ? error.message : "PGDATA is outside the canonical root."
    };
  }
  const outside = !pathsEqual(path.dirname(layout.data), layout.root);
  if (outside) {
    return {
      ok: false,
      code: "POSTGRES_PGDATA_OUTSIDE_ROOT",
      message: "PGDATA is outside the canonical YUVI Postgres data root."
    };
  }

  const marker = readClusterMarker(layout);
  const initialized = pgdataLooksInitialized(layout);
  const empty = isPgdataEmpty(layout);
  const initState = readInitializationState(layout);

  if (!initialized && empty) {
    return {
      ok: true,
      marker: marker ?? createClusterMarker(layout),
      initialized: false
    };
  }

  if (initState?.state === "initializing") {
    return {
      ok: false,
      code: "POSTGRES_INIT_IN_PROGRESS",
      message: "Private PostgreSQL initialization was interrupted and is not ready."
    };
  }

  if (!marker) {
    return {
      ok: false,
      code: "POSTGRES_FOREIGN_PGDATA",
      message: "Non-empty PGDATA has no YUVI cluster marker; refusing to adopt or initialize."
    };
  }

  if (!pathsEqual(marker.dataDirectory, layout.data)) {
    return {
      ok: false,
      code: "POSTGRES_MARKER_MISMATCH",
      message: "YUVI cluster marker does not match this PGDATA path."
    };
  }

  const major = readPgVersion(layout);
  if (major !== PRIVATE_POSTGRES_MAJOR) {
    return {
      ok: false,
      code: "POSTGRES_MAJOR_MISMATCH",
      message: `Existing PGDATA major ${major ?? "unknown"} is not PostgreSQL ${PRIVATE_POSTGRES_MAJOR}.`
    };
  }

  if (initState?.state === "failed") {
    return {
      ok: false,
      code: "POSTGRES_INIT_FAILED",
      message: initState.reason ?? "Private PostgreSQL initialization previously failed."
    };
  }

  return { ok: true, marker, initialized: true };
}

export function initializePrivateCluster(input: {
  layout: PostgresLayout;
  distribution: PostgresDistribution;
  password: string;
  port: number;
}): ClusterPrepareResult {
  const existing = inspectExistingCluster(input.layout);
  if (!existing.ok) return existing;
  if (existing.initialized) return existing;
  if (!isPgdataEmpty(input.layout)) {
    return {
      ok: false,
      code: "POSTGRES_FOREIGN_PGDATA",
      message: "Refusing to run initdb over a non-empty PGDATA directory."
    };
  }

  const marker = existing.marker;
  writeInitializationState(input.layout, "initializing", "initdb");
  const pwFile = path.join(input.layout.runtime, `initdb-pw.${process.pid}.tmp`);
  try {
    fs.writeFileSync(pwFile, `${input.password}\n`, { encoding: "utf8", mode: 0o600 });
    restrictPathToCurrentUser(pwFile, { kind: "file" });
    const args = [
      "-D",
      input.layout.data,
      "--encoding=UTF8",
      "--locale=C",
      `--username=${PRIVATE_POSTGRES_USER}`,
      "--auth-host=scram-sha-256",
      "--auth-local=scram-sha-256",
      `--pwfile=${pwFile}`
    ];
    const result = spawnSync(input.distribution.initdb, args, {
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true
    });
    if (result.status !== 0) {
      const evidence = buildInitdbFailureEvidence(result, { secrets: [input.password] });
      writeInitializationState(input.layout, "failed", evidence.reason, evidence);
      return {
        ok: false,
        code: "POSTGRES_INIT_FAILED",
        message: "initdb failed for the private YUVI PostgreSQL cluster."
      };
    }
    writeLocalOnlyConfig(input.layout, input.port);
    writeClusterMarker(input.layout, marker);
    writeInitializationState(input.layout, "ready");
    return { ok: true, marker, initialized: true };
  } catch (error) {
    const thrown = buildInitdbThrownEvidence(error, { secrets: [input.password] });
    writeInitializationState(input.layout, "failed", thrown.reason, thrown);
    return {
      ok: false,
      code: "POSTGRES_INIT_FAILED",
      message: "Private PostgreSQL initialization failed."
    };
  } finally {
    try {
      fs.unlinkSync(pwFile);
    } catch {
      // ignore
    }
  }
}

export function writeLocalOnlyConfig(layout: PostgresLayout, port: number): void {
  const conf = path.join(layout.data, "postgresql.conf");
  const hba = path.join(layout.data, "pg_hba.conf");
  const include = path.join(layout.data, "postgresql.yuvi.conf");
  const socketDir = layout.runtime.replaceAll("\\", "/");
  fs.writeFileSync(
    include,
    [
      "# Generated by YUVI. Do not listen on non-loopback addresses.",
      "listen_addresses = '127.0.0.1'",
      `port = ${port}`,
      "password_encryption = scram-sha-256",
      `unix_socket_directories = '${socketDir}'`,
      "logging_collector = off",
      ""
    ].join("\n"),
    "utf8"
  );
  restrictPathToCurrentUser(include, { kind: "file" });

  const existing = fs.existsSync(conf) ? fs.readFileSync(conf, "utf8") : "";
  if (!existing.includes("postgresql.yuvi.conf")) {
    fs.appendFileSync(conf, "\ninclude = 'postgresql.yuvi.conf'\n", "utf8");
  }

  fs.writeFileSync(
    hba,
    [
      "# YUVI private cluster: localhost scram only. Trust is not permitted.",
      "local   all   all                   scram-sha-256",
      "host    all   all   127.0.0.1/32    scram-sha-256",
      "host    all   all   ::1/128         reject",
      ""
    ].join("\n"),
    "utf8"
  );
  restrictPathToCurrentUser(hba, { kind: "file" });
}

export function buildPostgresStartCommand(
  layout: PostgresLayout,
  distribution: PostgresDistribution,
  port: number,
  clusterId: string
): import("./types.js").StartCommandSpec {
  const marker = `yuvi-pg-${clusterId}`;
  return {
    file: distribution.postgres,
    args: [
      "-D",
      layout.data,
      "-p",
      String(port),
      "-h",
      PRIVATE_POSTGRES_HOST,
      "-c",
      "listen_addresses=127.0.0.1",
      "-c",
      `unix_socket_directories=${layout.runtime}`,
      "-c",
      `cluster_name=${marker}`
    ],
    cwd: layout.runtime,
    env: {
      PGDATA: layout.data
    },
    commandMarker: marker
  };
}

export function assertPrivatePostgresPort(port: number): number {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("Private PostgreSQL port is not a valid TCP port.");
  }
  return port;
}

export function assertYuviClusterId(clusterId: string): string {
  const trimmed = clusterId.trim();
  if (!/^[0-9a-fA-F-]{8,64}$/.test(trimmed)) {
    throw new Error("Private PostgreSQL cluster id is not a safe internal marker.");
  }
  return trimmed;
}

export function buildWindowsPgCtlStartArguments(input: {
  layout: PostgresLayout;
  port: number;
  clusterId: string;
}): string[] {
  const port = assertPrivatePostgresPort(input.port);
  const clusterId = assertYuviClusterId(input.clusterId);
  return [
    "start",
    "-w",
    "-t",
    String(PG_CTL_START_WAIT_SECONDS),
    "-D",
    input.layout.data,
    "-l",
    input.layout.logFile,
    "-o",
    `-p ${port} -c cluster_name=${expectedClusterName(clusterId)}`
  ];
}

export type WindowsPgCtlOutcomeKind =
  | "SUCCESS"
  | "EXIT_NONZERO"
  | "TIMEOUT"
  | "PRE_SPAWN_ERROR"
  | "POST_SPAWN_ERROR"
  | "SIGNALLED";

export type WindowsPgCtlChildHandle = {
  stdout?: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  stderr?: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(
    event: "exit",
    listener: (status: number | null, signal: NodeJS.Signals | string | null) => unknown
  ): unknown;
  once(event: "spawn", listener: () => void): unknown;
  kill(): void;
};

export type WindowsPgCtlSpawnOptions = {
  windowsHide: boolean;
  shell: boolean;
  timeoutMs: number;
  createChild?: (
    command: string,
    args: readonly string[],
    options: { windowsHide: boolean; shell: boolean; stdio: ["ignore", "pipe", "pipe"] }
  ) => WindowsPgCtlChildHandle;
};

export type WindowsPgCtlStartResult =
  | {
      ok: true;
      kind: "SUCCESS";
      status: 0;
      signal: null;
      stdout: string;
      stderr: string;
    }
  | {
      ok: false;
      kind: Exclude<WindowsPgCtlOutcomeKind, "SUCCESS">;
      status: number | null;
      signal: string | null;
      stdout: string;
      stderr: string;
      detail: string;
    };

export type WindowsPgCtlSpawnAsync = (
  command: string,
  args: readonly string[],
  options: WindowsPgCtlSpawnOptions
) => Promise<WindowsPgCtlStartResult>;

/** @deprecated Use WindowsPgCtlSpawnAsync. Kept as an alias for hook typing. */
export type WindowsPgCtlSpawn = WindowsPgCtlSpawnAsync;

export type PostgresLaunchDiagnostic =
  | {
      phase: "PG_CTL_LAUNCH";
      status: WindowsPgCtlOutcomeKind;
      exitCode: number | null;
      signal: string | null;
      pgCtlStdoutTail: string;
      pgCtlStderrTail: string;
    }
  | {
      phase: "POSTMASTER_PID";
      status: "PRESENT" | "MISSING";
      postmasterPid: number | null;
      source: "immediate" | "delayed-settle";
    }
  | {
      phase: "PROCESS_INSPECTION";
      status:
        | "RESOLVED"
        | "NOT_RUNNING"
        | "QUERY_TIMEOUT"
        | "QUERY_FAILED"
        | "EMPTY_OUTPUT"
        | "PARSE_FAILED";
      processId: number;
    }
  | {
      phase: "OWNERSHIP";
      status: "NOT_RUN" | "ACCEPTED" | "REJECTED" | "UNCERTAIN";
      reason: PostgresOwnershipDiagnosticReason;
      postmasterPid: number | null;
    };

export type PostgresLaunchDiagnosticSink = (diagnostic: PostgresLaunchDiagnostic) => void;

function reportPostgresLaunchDiagnostic(
  sink: PostgresLaunchDiagnosticSink | undefined,
  diagnostic: PostgresLaunchDiagnostic
): void {
  try {
    sink?.(diagnostic);
  } catch {
    // Diagnostic failures must never affect PostgreSQL lifecycle behavior.
  }
}

function processInspectionDiagnosticStatus(
  inspection: ProcessInspectionResult
): Extract<PostgresLaunchDiagnostic, { phase: "PROCESS_INSPECTION" }>["status"] {
  if (inspection.status === "resolved") return "RESOLVED";
  if (inspection.status === "not-running") return "NOT_RUNNING";
  if (inspection.reason === "query-timeout") return "QUERY_TIMEOUT";
  if (inspection.reason === "query-failed") return "QUERY_FAILED";
  if (inspection.reason === "empty-output") return "EMPTY_OUTPUT";
  return "PARSE_FAILED";
}

export function boundPgCtlOutput(text: string, maxChars = PG_CTL_OUTPUT_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  return text.slice(-maxChars);
}

function redactPgCtlDiagnosticText(text: string, secrets: readonly string[]): string {
  return redactSecretText(text, [...secrets])
    .replace(/Authorization:\s*Bearer\s+\S+/giu, "Authorization: Bearer [REDACTED]")
    .replace(/\bBearer\s+\S+/giu, "Bearer [REDACTED]")
    .replace(
      /\b(password|DATABASE_URL|PGPASSWORD|YUVI_POSTGRES_PASSWORD)\s*[=:]\s*\S+/giu,
      "$1=[REDACTED]"
    )
    .replace(/\bconnectionString\s*[=:]\s*\S+/giu, "connectionString=[REDACTED]")
    .replace(
      /\b(argv|args|commandLine|command|env|environment)\s*[=:][^\r\n]*/giu,
      "[REDACTED_EXECUTION_DATA]"
    );
}

function boundPgCtlDiagnosticOutput(text: string, secrets: readonly string[]): string {
  try {
    return boundPgCtlOutput(
      redactPgCtlDiagnosticText(text, secrets),
      PG_CTL_DIAGNOSTIC_OUTPUT_MAX_CHARS
    );
  } catch {
    // Diagnostic redaction must never affect PostgreSQL lifecycle behavior.
    return "";
  }
}

export function classifyWindowsPgCtlChildExit(input: {
  status: number | null;
  signal: NodeJS.Signals | string | null;
  error?: Error | undefined;
  timedOut?: boolean | undefined;
  spawned?: boolean | undefined;
  stdout?: string | undefined;
  stderr?: string | undefined;
}): WindowsPgCtlStartResult {
  const stdout = boundPgCtlOutput(input.stdout ?? "");
  const stderr = boundPgCtlOutput(input.stderr ?? "");
  const output = `${stdout}${stderr}`.trim();
  if (input.timedOut) {
    return {
      ok: false,
      kind: "TIMEOUT",
      status: input.status,
      signal: typeof input.signal === "string" ? input.signal : null,
      stdout,
      stderr,
      detail: output || "pg_ctl start timed out"
    };
  }
  if (input.error) {
    return {
      ok: false,
      kind: input.spawned ? "POST_SPAWN_ERROR" : "PRE_SPAWN_ERROR",
      status: input.status,
      signal: typeof input.signal === "string" ? input.signal : null,
      stdout,
      stderr,
      detail: output || input.error.message || "pg_ctl spawn failed"
    };
  }
  if (typeof input.signal === "string" && input.signal) {
    return {
      ok: false,
      kind: "SIGNALLED",
      status: input.status,
      signal: input.signal,
      stdout,
      stderr,
      detail: output || input.signal
    };
  }
  if (input.status === 0) {
    return { ok: true, kind: "SUCCESS", status: 0, signal: null, stdout, stderr };
  }
  return {
    ok: false,
    kind: "EXIT_NONZERO",
    status: input.status,
    signal: null,
    stdout,
    stderr,
    detail: output || `pg_ctl exited ${input.status}`
  };
}

export function runWindowsPgCtlChild(
  command: string,
  args: readonly string[],
  options: WindowsPgCtlSpawnOptions
): Promise<WindowsPgCtlStartResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let stdout = "";
    let stderr = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: WindowsPgCtlStartResult) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };
    let spawned = false;
    const createChild =
      options.createChild ??
      ((file, childArgs, childOptions) =>
        spawn(file, [...childArgs], childOptions) as WindowsPgCtlChildHandle);
    let child: WindowsPgCtlChildHandle;
    try {
      child = createChild(command, args, {
        windowsHide: options.windowsHide,
        shell: options.shell,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      finish(
        classifyWindowsPgCtlChildExit({
          status: null,
          signal: null,
          error: error instanceof Error ? error : new Error(String(error)),
          spawned: false
        })
      );
      return;
    }
    child.once("spawn", () => {
      spawned = true;
    });
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout = boundPgCtlOutput(`${stdout}${String(chunk)}`);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = boundPgCtlOutput(`${stderr}${String(chunk)}`);
    });
    child.on("error", (error) => {
      finish(
        classifyWindowsPgCtlChildExit({
          status: null,
          signal: null,
          error,
          timedOut,
          spawned,
          stdout,
          stderr
        })
      );
    });
    child.on("exit", (status, signal) => {
      finish(
        classifyWindowsPgCtlChildExit({
          status,
          signal,
          timedOut,
          spawned,
          stdout,
          stderr
        })
      );
    });
    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        // The launcher only is signalled; the postmaster is not our child.
      }
      finish(
        classifyWindowsPgCtlChildExit({
          status: null,
          signal: null,
          timedOut: true,
          stdout,
          stderr
        })
      );
    }, options.timeoutMs);
  });
}

export async function invokeWindowsPgCtlStart(input: {
  layout: PostgresLayout;
  distribution: PostgresDistribution;
  port: number;
  clusterId: string;
  spawnImpl?: WindowsPgCtlSpawnAsync;
}): Promise<WindowsPgCtlStartResult> {
  const args = buildWindowsPgCtlStartArguments(input);
  const run = input.spawnImpl ?? runWindowsPgCtlChild;
  return run(input.distribution.pgCtl, args, {
    windowsHide: true,
    shell: false,
    timeoutMs: PG_CTL_LAUNCH_TIMEOUT_MS
  });
}

export type WindowsLaunchReconciliation =
  | {
      disposition: "owned";
      pid: number;
      processStartedAtUtc: string;
      evidence: PostgresOwnershipEvidence;
    }
  | {
      disposition: "quiescent";
    }
  | {
      disposition: "missing";
    }
  | {
      disposition: "uncertain";
      code: "POSTGRES_START_IDENTITY_UNCERTAIN";
      message: string;
      nominatedPid: number | null;
    };

export function reconcileWindowsPrivatePostgresLaunch(input: {
  layout: PostgresLayout;
  distribution: PostgresDistribution;
  inspectProcess: (processId: number) => ProcessInspectionResult;
  launchStartedAt: Date;
  readPid?: (dataDirectory: string) => number | null;
  diagnosticSink?: PostgresLaunchDiagnosticSink;
  diagnosticSource?: "immediate" | "delayed-settle";
}): WindowsLaunchReconciliation {
  const readPid = input.readPid ?? readPostmasterPid;
  const pid = readPid(input.layout.data);
  reportPostgresLaunchDiagnostic(input.diagnosticSink, {
    phase: "POSTMASTER_PID",
    status: pid == null ? "MISSING" : "PRESENT",
    postmasterPid: pid,
    source: input.diagnosticSource ?? "immediate"
  });
  if (pid == null) {
    return { disposition: "missing" };
  }
  const inspection = input.inspectProcess(pid);
  reportPostgresLaunchDiagnostic(input.diagnosticSink, {
    phase: "PROCESS_INSPECTION",
    status: processInspectionDiagnosticStatus(inspection),
    processId: pid
  });
  if (inspection.status === "not-running") {
    reportPostgresLaunchDiagnostic(input.diagnosticSink, {
      phase: "OWNERSHIP",
      status: "NOT_RUN",
      reason: "NONE",
      postmasterPid: pid
    });
    return { disposition: "quiescent" };
  }
  const evidence = evaluatePostgresOwnership({
    layout: input.layout,
    distribution: input.distribution,
    processInspection: inspection,
    metadata: null,
    requirePreviousMetadata: false,
    expectedPid: pid,
    launchStartedAt: input.launchStartedAt,
    launchMaxAfterMs: PG_CTL_START_WAIT_SECONDS * 1000
  });
  reportPostgresLaunchDiagnostic(input.diagnosticSink, {
    phase: "OWNERSHIP",
    status: evidence.owned
      ? "ACCEPTED"
      : inspection.status === "resolved"
        ? "REJECTED"
        : "UNCERTAIN",
    reason: evidence.owned ? "NONE" : postgresOwnershipDiagnosticReason(evidence.reason),
    postmasterPid: pid
  });
  if (evidence.owned && evidence.pid === pid) {
    return {
      disposition: "owned",
      pid,
      processStartedAtUtc: evidence.processStartedAtUtc ?? input.launchStartedAt.toISOString(),
      evidence
    };
  }
  return {
    disposition: "uncertain",
    code: "POSTGRES_START_IDENTITY_UNCERTAIN",
    message:
      evidence.reason || "A postmaster candidate exists but its identity could not be proven.",
    nominatedPid: pid
  };
}

export async function waitForPostmasterCandidate(input: {
  dataDirectory: string;
  timeoutMs?: number;
  intervalMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
  now?: () => number;
  readPid?: (dataDirectory: string) => number | null;
}): Promise<number | null> {
  const timeoutMs = input.timeoutMs ?? POSTMASTER_SETTLE_WINDOW_MS;
  const intervalMs = input.intervalMs ?? POSTMASTER_SETTLE_INTERVAL_MS;
  const sleepImpl =
    input.sleepImpl ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = input.now ?? Date.now;
  const readPid = input.readPid ?? readPostmasterPid;
  const deadline = now() + timeoutMs;
  while (true) {
    const pid = readPid(input.dataDirectory);
    if (pid != null) return pid;
    if (now() >= deadline) return null;
    await sleepImpl(intervalMs);
  }
}

export function launcherProcessWasNeverCreated(launcher: WindowsPgCtlStartResult): boolean {
  return !launcher.ok && launcher.kind === "PRE_SPAWN_ERROR";
}

export type WindowsPrivatePostgresLaunchResult =
  | {
      outcome: "started";
      pid: number;
      processStartedAtUtc: string;
      evidence: PostgresOwnershipEvidence;
      launcher: WindowsPgCtlStartResult;
    }
  | {
      outcome: "owned-after-failure";
      pid: number;
      processStartedAtUtc: string;
      evidence: PostgresOwnershipEvidence;
      launcher: WindowsPgCtlStartResult;
    }
  | {
      outcome: "quiescent-failure";
      code: string;
      message: string;
      detail?: string;
      launcher: WindowsPgCtlStartResult;
    }
  | {
      outcome: "uncertain";
      code: "POSTGRES_START_IDENTITY_UNCERTAIN" | "POSTGRES_POSTMASTER_IDENTITY_UNPROVEN";
      message: string;
      nominatedPid: number | null;
      detail?: string;
      launcher: WindowsPgCtlStartResult;
    };

export async function launchWindowsPrivatePostgres(input: {
  layout: PostgresLayout;
  distribution: PostgresDistribution;
  port: number;
  clusterId: string;
  inspectProcess: (processId: number) => ProcessInspectionResult;
  spawnImpl?: WindowsPgCtlSpawnAsync;
  now?: () => Date;
  settleTimeoutMs?: number;
  settleIntervalMs?: number;
  sleepImpl?: (ms: number) => Promise<void>;
  nowMs?: () => number;
  readPid?: (dataDirectory: string) => number | null;
  diagnosticSecrets?: readonly string[];
  diagnosticSink?: PostgresLaunchDiagnosticSink;
}): Promise<WindowsPrivatePostgresLaunchResult> {
  const launchStartedAt = (input.now ?? (() => new Date()))();
  const launcher = await invokeWindowsPgCtlStart(input);
  const diagnosticSecrets = input.diagnosticSecrets ?? [];
  reportPostgresLaunchDiagnostic(input.diagnosticSink, {
    phase: "PG_CTL_LAUNCH",
    status: launcher.kind,
    exitCode: launcher.status,
    signal: launcher.signal,
    pgCtlStdoutTail: boundPgCtlDiagnosticOutput(launcher.stdout, diagnosticSecrets),
    pgCtlStderrTail: boundPgCtlDiagnosticOutput(launcher.stderr, diagnosticSecrets)
  });
  const reconcileInput = {
    layout: input.layout,
    distribution: input.distribution,
    inspectProcess: input.inspectProcess,
    launchStartedAt,
    ...(input.diagnosticSink ? { diagnosticSink: input.diagnosticSink } : {}),
    diagnosticSource: "immediate" as const,
    ...(input.readPid ? { readPid: input.readPid } : {})
  };
  let reconciled = reconcileWindowsPrivatePostgresLaunch(reconcileInput);
  if (reconciled.disposition === "missing" && !launcherProcessWasNeverCreated(launcher)) {
    await waitForPostmasterCandidate({
      dataDirectory: input.layout.data,
      timeoutMs: input.settleTimeoutMs ?? POSTMASTER_SETTLE_WINDOW_MS,
      intervalMs: input.settleIntervalMs ?? POSTMASTER_SETTLE_INTERVAL_MS,
      ...(input.sleepImpl ? { sleepImpl: input.sleepImpl } : {}),
      ...(input.nowMs ? { now: input.nowMs } : {}),
      ...(input.readPid ? { readPid: input.readPid } : {})
    });
    reconciled = reconcileWindowsPrivatePostgresLaunch({
      ...reconcileInput,
      diagnosticSource: "delayed-settle"
    });
  }
  if (reconciled.disposition === "owned") {
    if (launcher.ok) {
      return {
        outcome: "started",
        pid: reconciled.pid,
        processStartedAtUtc: reconciled.processStartedAtUtc,
        evidence: reconciled.evidence,
        launcher
      };
    }
    return {
      outcome: "owned-after-failure",
      pid: reconciled.pid,
      processStartedAtUtc: reconciled.processStartedAtUtc,
      evidence: reconciled.evidence,
      launcher
    };
  }
  if (reconciled.disposition === "uncertain") {
    return {
      outcome: "uncertain",
      code: reconciled.code,
      message: reconciled.message,
      nominatedPid: reconciled.nominatedPid,
      ...(launcher.ok ? {} : { detail: launcher.detail }),
      launcher
    };
  }
  if (reconciled.disposition === "quiescent") {
    if (launcher.ok) {
      return {
        outcome: "uncertain",
        code: "POSTGRES_POSTMASTER_IDENTITY_UNPROVEN",
        message: "pg_ctl reported success but the nominated postmaster is not live.",
        nominatedPid: null,
        launcher
      };
    }
    return {
      outcome: "quiescent-failure",
      code: "POSTGRES_PG_CTL_START_FAILED",
      message: "pg_ctl could not start the private PostgreSQL server.",
      ...(launcher.ok ? {} : { detail: launcher.detail }),
      launcher
    };
  }
  if (launcherProcessWasNeverCreated(launcher) && !launcher.ok) {
    return {
      outcome: "quiescent-failure",
      code: "POSTGRES_PG_CTL_START_FAILED",
      message: "pg_ctl could not start the private PostgreSQL server.",
      detail: launcher.detail,
      launcher
    };
  }
  if (launcher.ok) {
    return {
      outcome: "uncertain",
      code: "POSTGRES_POSTMASTER_IDENTITY_UNPROVEN",
      message: "pg_ctl reported success but no postmaster identity could be proven.",
      nominatedPid: null,
      launcher
    };
  }
  return {
    outcome: "uncertain",
    code: "POSTGRES_START_IDENTITY_UNCERTAIN",
    message: "pg_ctl failed and no postmaster identity could be proven.",
    nominatedPid: null,
    ...(launcher.ok ? {} : { detail: launcher.detail }),
    launcher
  };
}

export function createYuviDatabase(input: {
  layout: PostgresLayout;
  distribution: PostgresDistribution;
}): { ok: boolean; message: string } {
  return createYuviDatabaseSingleUser(input);
}

export function createYuviDatabaseSingleUser(input: {
  layout: PostgresLayout;
  distribution: PostgresDistribution;
}): { ok: boolean; message: string } {
  const result = spawnSync(
    input.distribution.postgres,
    ["--single", "-D", input.layout.data, "postgres"],
    {
      input: `CREATE DATABASE ${PRIVATE_POSTGRES_DATABASE};\n`,
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true
    }
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status === 0 || /already exists/i.test(output)) {
    return { ok: true, message: "yuvi database ready" };
  }
  return { ok: false, message: "CREATE DATABASE failed" };
}

type SqlClient = {
  connect(): Promise<void>;
  query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
};

async function createSqlClient(input: {
  port: number;
  password: string;
  database: string;
}): Promise<SqlClient> {
  const mod = (await import("pg")) as {
    Client: new (config: Record<string, unknown>) => SqlClient;
  };
  return new mod.Client({
    host: PRIVATE_POSTGRES_HOST,
    port: input.port,
    user: PRIVATE_POSTGRES_USER,
    password: input.password,
    database: input.database,
    connectionTimeoutMillis: 4_000
  });
}

export type AuthenticatedSqlResult = {
  ok: boolean;
  output: string;
  sqlState: string | null;
};

function sqlStateFromError(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

export async function execAuthenticatedSql(input: {
  distribution: PostgresDistribution;
  port: number;
  password: string;
  database?: string;
  sql: string;
}): Promise<AuthenticatedSqlResult> {
  void input.distribution;
  const client = await createSqlClient({
    port: input.port,
    password: input.password,
    database: input.database ?? PRIVATE_POSTGRES_DATABASE
  });
  try {
    await client.connect();
    const result = await client.query(input.sql);
    const output = result.rows
      .map((row) =>
        Object.values(row)
          .map((value) => String(value ?? ""))
          .join("|")
      )
      .join("\n");
    return { ok: true, output, sqlState: null };
  } catch (error) {
    return {
      ok: false,
      output: error instanceof Error ? error.message : String(error),
      sqlState: sqlStateFromError(error)
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

function pingMatchesCluster(output: string, clusterId: string): boolean {
  const line = output.trim().split(/\r?\n/)[0] ?? "";
  const [versionRaw, clusterName] = line.split("|").map((part) => part.trim());
  const version = Number.parseInt(versionRaw ?? "", 10);
  const major = Number.isInteger(version) ? Math.floor(version / 10000) : NaN;
  return major === PRIVATE_POSTGRES_MAJOR && clusterName === expectedClusterName(clusterId);
}

export async function pingPostgresDatabase(input: {
  layout: PostgresLayout;
  distribution: PostgresDistribution;
  port: number;
  password: string;
  clusterId: string;
  database: string;
}): Promise<boolean> {
  void input.layout;
  const probed = await execAuthenticatedSql({
    distribution: input.distribution,
    port: input.port,
    password: input.password,
    database: input.database,
    sql: "SELECT current_setting('server_version_num') AS version, current_setting('cluster_name') AS cluster"
  });
  return probed.ok && pingMatchesCluster(probed.output, input.clusterId);
}

export async function pingPostgresServer(input: {
  layout: PostgresLayout;
  distribution: PostgresDistribution;
  port: number;
  password: string;
  clusterId: string;
}): Promise<boolean> {
  return pingPostgresDatabase({ ...input, database: STANDARD_POSTGRES_DATABASE });
}

export async function pingPostgres(input: {
  layout: PostgresLayout;
  distribution: PostgresDistribution;
  port: number;
  password: string;
  clusterId: string;
}): Promise<boolean> {
  return pingPostgresDatabase({ ...input, database: PRIVATE_POSTGRES_DATABASE });
}

export type EnsureYuviDatabaseResult =
  | { ok: true; created: boolean; alreadyExists: boolean; sqlState: string | null }
  | { ok: false; message: string; sqlState: string | null };

export async function ensureYuviDatabase(input: {
  distribution: PostgresDistribution;
  port: number;
  password: string;
  execute?: typeof execAuthenticatedSql;
}): Promise<EnsureYuviDatabaseResult> {
  const execute = input.execute ?? execAuthenticatedSql;
  const result = await execute({
    distribution: input.distribution,
    port: input.port,
    password: input.password,
    database: STANDARD_POSTGRES_DATABASE,
    sql: `CREATE DATABASE ${PRIVATE_POSTGRES_DATABASE}`
  });
  if (result.ok) {
    return { ok: true, created: true, alreadyExists: false, sqlState: result.sqlState };
  }
  if (result.sqlState === DUPLICATE_DATABASE_SQLSTATE) {
    return { ok: true, created: false, alreadyExists: true, sqlState: result.sqlState };
  }
  return {
    ok: false,
    message: result.output || "CREATE DATABASE yuvi failed",
    sqlState: result.sqlState
  };
}

export function runSingleUserSql(input: {
  layout: PostgresLayout;
  distribution: PostgresDistribution;
  database: string;
  sql: string;
}): { ok: boolean; output: string } {
  const result = spawnSync(
    input.distribution.postgres,
    ["--single", "-D", input.layout.data, input.database],
    {
      input: `${input.sql}\n`,
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true
    }
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { ok: result.status === 0, output };
}

export function stopPostgresFast(input: {
  layout: PostgresLayout;
  distribution: PostgresDistribution;
}): boolean {
  const result = spawnSync(
    input.distribution.pgCtl,
    ["stop", "-D", input.layout.data, "-m", "fast", "-w", "-t", "10"],
    { encoding: "utf8", timeout: 20_000, windowsHide: true, shell: false }
  );
  return result.status === 0;
}

export type InitdbSpawnClassification =
  | { kind: "SUCCESS" }
  | { kind: "SPAWN_FAILED"; spawnErrorCode: string | null }
  | { kind: "TIMEOUT"; spawnErrorCode: "ETIMEDOUT"; signal: string | null }
  | { kind: "SIGNALLED"; signal: string }
  | { kind: "EXIT_NONZERO"; exitStatus: number | null };

type InitdbSpawnSnapshot = {
  error?: Error | undefined;
  status: number | null;
  signal: NodeJS.Signals | string | null;
  stdout?: string | Buffer | null | undefined;
  stderr?: string | Buffer | null | undefined;
};

export function classifyInitdbSpawnResult(result: InitdbSpawnSnapshot): InitdbSpawnClassification {
  const spawnErrorCode = safeSpawnErrorCode(result.error);
  if (spawnErrorCode === "ETIMEDOUT") {
    return {
      kind: "TIMEOUT",
      spawnErrorCode: "ETIMEDOUT",
      signal: typeof result.signal === "string" ? result.signal : null
    };
  }
  if (result.error) {
    return { kind: "SPAWN_FAILED", spawnErrorCode };
  }
  if (typeof result.signal === "string" && result.signal) {
    return { kind: "SIGNALLED", signal: result.signal };
  }
  if (result.status === 0) return { kind: "SUCCESS" };
  return {
    kind: "EXIT_NONZERO",
    exitStatus: typeof result.status === "number" ? result.status : null
  };
}

export function buildInitdbFailureEvidence(
  result: InitdbSpawnSnapshot,
  options: { secrets?: string[] } = {}
): PostgresInitializationFailureEvidence & { reason: string } {
  const secrets = options.secrets ?? [];
  const classified = classifyInitdbSpawnResult(result);
  const stdoutTail = boundInitdbTail(
    redactInitdbDiagnosticText(stringSpawnOutput(result.stdout), secrets),
    INITDB_STDOUT_TAIL_MAX_CHARS
  );
  const stderrTail = boundInitdbTail(
    redactInitdbDiagnosticText(stringSpawnOutput(result.stderr), secrets),
    INITDB_STDERR_TAIL_MAX_CHARS
  );
  const errorCode: PostgresInitializationFailureKind =
    classified.kind === "SUCCESS" ? "EXIT_NONZERO" : classified.kind;
  const exitStatus = classified.kind === "EXIT_NONZERO" ? classified.exitStatus : null;
  const signal =
    classified.kind === "SIGNALLED" || classified.kind === "TIMEOUT" ? classified.signal : null;
  const spawnErrorCode =
    classified.kind === "SPAWN_FAILED" || classified.kind === "TIMEOUT"
      ? classified.spawnErrorCode
      : null;
  const reason = buildInitdbFailureReason({
    errorCode,
    stdoutTail,
    stderrTail,
    exitStatus,
    signal,
    spawnErrorCode
  });
  return {
    reason,
    errorCode,
    exitStatus,
    signal,
    spawnErrorCode,
    ...(stdoutTail ? { stdoutTail } : {}),
    ...(stderrTail ? { stderrTail } : {})
  };
}

function buildInitdbThrownEvidence(
  error: unknown,
  options: { secrets?: string[] } = {}
): PostgresInitializationFailureEvidence & { reason: string } {
  const secrets = options.secrets ?? [];
  const message = error instanceof Error ? error.message : "initialization threw";
  const reason = buildInitdbFailureReason({
    errorCode: "INIT_THREW",
    stdoutTail: "",
    stderrTail: redactInitdbDiagnosticText(message, secrets),
    exitStatus: null,
    signal: null,
    spawnErrorCode: safeSpawnErrorCode(error)
  });
  return {
    reason,
    errorCode: "INIT_THREW",
    exitStatus: null,
    signal: null,
    spawnErrorCode: safeSpawnErrorCode(error)
  };
}

function buildInitdbFailureReason(input: {
  errorCode: PostgresInitializationFailureKind;
  stdoutTail: string;
  stderrTail: string;
  exitStatus: number | null;
  signal: string | null;
  spawnErrorCode: string | null;
}): string {
  const prefix = `${input.errorCode}: `;
  const preferred = input.stderrTail.trim() ? input.stderrTail : input.stdoutTail;
  const detail =
    collapseInitdbText(preferred) ||
    (input.spawnErrorCode ? input.spawnErrorCode : "") ||
    (input.signal ? input.signal : "") ||
    (input.exitStatus !== null ? `status=${input.exitStatus}` : "") ||
    "initdb failed";
  const body = boundInitdbTail(detail, Math.max(1, INITDB_REASON_MAX_CHARS - prefix.length));
  return `${prefix}${body}`.slice(0, INITDB_REASON_MAX_CHARS);
}

function redactInitdbDiagnosticText(text: string, secrets: string[]): string {
  return redactSecretText(text, secrets)
    .replace(/\bpassword\s*=\s*\S+/giu, "password=[REDACTED]")
    .replace(/\bBearer\s+\S+/giu, "Bearer [REDACTED]");
}

function boundInitdbTail(text: string, maxChars: number): string {
  const normalized = text.replace(/\r\n/g, "\n");
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(-maxChars);
}

function collapseInitdbText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function stringSpawnOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return "";
}

function safeSpawnErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string") return null;
  const trimmed = code.slice(0, 32);
  return /^[A-Za-z0-9_]+$/.test(trimmed) ? trimmed : null;
}

export function assertPgdataInsideLayout(layout: PostgresLayout): boolean {
  return pathsEqual(canonicalPath(path.dirname(layout.data)), layout.root);
}
