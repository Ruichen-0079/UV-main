/**
 * Single strong ownership predicate for private PostgreSQL.
 * Used by adopt, stop, readiness publication, and restart.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { canonicalPath, pathsEqual } from "./paths.js";
import { PRIVATE_POSTGRES_MAJOR, readClusterMarker, readPgVersion } from "./postgres-layout.js";
import type { PostgresDistribution } from "./postgres-distribution.js";
import type { PostgresLayout } from "./postgres-layout.js";
import type { ProcessInspectionResult, ProcessMetadata } from "./types.js";

export const POSTGRES_OWNERSHIP_ROLE = "postgres";
export const CREATION_TIME_TOLERANCE_MS = 2_000;

export type PostgresArgvIdentity = {
  executable: string | null;
  dataDirectory: string | null;
  port: number | null;
  clusterName: string | null;
};

export type PostgresOwnershipEvidence = {
  owned: boolean;
  reason: string;
  pid: number | null;
  executable: string | null;
  dataDirectory: string | null;
  clusterId: string | null;
  clusterName: string | null;
  port: number | null;
  processStartedAtUtc: string | null;
};

export type PostgresOwnershipDiagnosticReason =
  | "NONE"
  | "MARKER_INVALID"
  | "MARKER_MAJOR_MISMATCH"
  | "PG_VERSION_MISMATCH"
  | "MARKER_DATA_DIRECTORY_MISMATCH"
  | "PROCESS_UNRESOLVED"
  | "PID_MISMATCH"
  | "EXECUTABLE_MISMATCH"
  | "PGDATA_ARGUMENT_MISMATCH"
  | "CLUSTER_NAME_MISMATCH"
  | "LAUNCH_TIME_MISMATCH"
  | "PREVIOUS_METADATA_MISMATCH"
  | "OTHER_BOUNDED";

/** Map internal ownership prose to a bounded, secret-free diagnostic enum. */
export function postgresOwnershipDiagnosticReason(
  reason: string
): PostgresOwnershipDiagnosticReason {
  if (reason === "YUVI cluster marker is missing") return "MARKER_INVALID";
  if (reason === "cluster marker major is not 16") return "MARKER_MAJOR_MISMATCH";
  if (reason === "PG_VERSION is not 16") return "PG_VERSION_MISMATCH";
  if (reason === "cluster marker PGDATA does not match layout") {
    return "MARKER_DATA_DIRECTORY_MISMATCH";
  }
  if (reason.startsWith("process is not inspectable")) return "PROCESS_UNRESOLVED";
  if (reason === "inspected process is not the nominated postmaster PID") return "PID_MISMATCH";
  if (reason === "executable is not the selected PostgreSQL 16 postgres binary") {
    return "EXECUTABLE_MISMATCH";
  }
  if (reason === "exact -D PGDATA token does not match canonical PGDATA") {
    return "PGDATA_ARGUMENT_MISMATCH";
  }
  if (reason === "cluster_name does not match yuvi-pg-<clusterId>") {
    return "CLUSTER_NAME_MISMATCH";
  }
  if (reason === "process start time is not plausible for this launch") {
    return "LAUNCH_TIME_MISMATCH";
  }
  if (reason === "previous ownership metadata is not valid first-party evidence") {
    return "PREVIOUS_METADATA_MISMATCH";
  }
  return "OTHER_BOUNDED";
}

export type EvaluatePostgresOwnershipInput = {
  layout: PostgresLayout;
  distribution: PostgresDistribution;
  processInspection: ProcessInspectionResult;
  metadata?: ProcessMetadata | null | undefined;
  requirePreviousMetadata?: boolean;
  expectedPid?: number;
  launchStartedAt?: Date | string | null;
  launchMaxAfterMs?: number;
};

export function tokenizeCommandLine(commandLine: string): string[] {
  const matches = commandLine.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return matches.map((part) => {
    if (
      (part.startsWith('"') && part.endsWith('"')) ||
      (part.startsWith("'") && part.endsWith("'"))
    ) {
      return part.slice(1, -1);
    }
    return part;
  });
}

export function parsePostgresArgv(commandLine: string): PostgresArgvIdentity {
  const tokens = tokenizeCommandLine(commandLine);
  const identity: PostgresArgvIdentity = {
    executable: tokens[0] ? canonicalPath(tokens[0]) : null,
    dataDirectory: null,
    port: null,
    clusterName: null
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? "";
    if (token === "-D" || token === "--pgdata") {
      const next = tokens[i + 1];
      if (next) identity.dataDirectory = canonicalPath(next);
      i += 1;
      continue;
    }
    if (token.startsWith("--pgdata=")) {
      identity.dataDirectory = canonicalPath(token.slice("--pgdata=".length));
      continue;
    }
    if (token === "-p" || token === "--port") {
      const next = Number(tokens[i + 1]);
      if (Number.isInteger(next) && next > 0) identity.port = next;
      i += 1;
      continue;
    }
    if (token.startsWith("--port=")) {
      const next = Number(token.slice("--port=".length));
      if (Number.isInteger(next) && next > 0) identity.port = next;
      continue;
    }
    if (token === "-c" || token === "--set") {
      const next = tokens[i + 1] ?? "";
      applySettingToken(identity, next);
      i += 1;
      continue;
    }
    if (token.startsWith("--cluster_name=")) {
      identity.clusterName = token.slice("--cluster_name=".length);
    }
    if (token.startsWith("cluster_name=")) {
      identity.clusterName = token.slice("cluster_name=".length);
    }
  }
  return identity;
}

function applySettingToken(identity: PostgresArgvIdentity, setting: string): void {
  const eq = setting.indexOf("=");
  if (eq <= 0) return;
  const key = setting.slice(0, eq);
  const value = setting.slice(eq + 1);
  if (key === "cluster_name") identity.clusterName = value;
  if (key === "port") {
    const port = Number(value);
    if (Number.isInteger(port) && port > 0) identity.port = port;
  }
}

export function expectedClusterName(clusterId: string): string {
  return `yuvi-pg-${clusterId}`;
}

export function creationTimesMatch(
  left: Date | string | null | undefined,
  right: Date | string | null | undefined,
  toleranceMs = CREATION_TIME_TOLERANCE_MS
): boolean {
  if (!left || !right) return false;
  const a = typeof left === "string" ? Date.parse(left) : left.getTime();
  const b = typeof right === "string" ? Date.parse(right) : right.getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= toleranceMs;
}

export function processStartedDuringLaunch(
  processStartedAt: Date | string | null | undefined,
  launchStartedAt: Date | string,
  maxAfterMs: number,
  toleranceMs = CREATION_TIME_TOLERANCE_MS
): boolean {
  if (!processStartedAt) return false;
  const started =
    typeof processStartedAt === "string"
      ? Date.parse(processStartedAt)
      : processStartedAt.getTime();
  const launched =
    typeof launchStartedAt === "string" ? Date.parse(launchStartedAt) : launchStartedAt.getTime();
  if (!Number.isFinite(started) || !Number.isFinite(launched)) return false;
  if (!Number.isFinite(maxAfterMs) || maxAfterMs < 0) return false;
  return started >= launched - toleranceMs && started <= launched + maxAfterMs + toleranceMs;
}

export function executablesMatch(actual: string | null | undefined, expected: string): boolean {
  if (!actual) return false;
  return pathsEqual(canonicalPath(actual), canonicalPath(expected));
}

export function dataDirectoriesMatch(actual: string | null | undefined, expected: string): boolean {
  if (!actual) return false;
  return pathsEqual(canonicalPath(actual), canonicalPath(expected));
}

export function readPostmasterPid(dataDirectory: string): number | null {
  const file = path.join(dataDirectory, "postmaster.pid");
  if (!fs.existsSync(file)) return null;
  try {
    const first = fs.readFileSync(file, "utf8").split(/\r?\n/)[0]?.trim() ?? "";
    const pid = Number(first);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function previousMetadataIsFirstPartyEvidence(input: {
  metadata: ProcessMetadata | null | undefined;
  livePid: number;
  liveStartedAt: Date | null;
  expectedRole: string;
  expectedCommandMarker: string;
}): boolean {
  const metadata = input.metadata;
  if (!metadata) return false;
  if (metadata.schemaVersion !== 1) return false;
  if (metadata.role !== input.expectedRole) return false;
  if (metadata.pid !== input.livePid) return false;
  if (metadata.commandMarker !== input.expectedCommandMarker) return false;
  if (!creationTimesMatch(metadata.processStartedAtUtc, input.liveStartedAt)) return false;
  return true;
}

export function evaluatePostgresOwnership(
  input: EvaluatePostgresOwnershipInput
): PostgresOwnershipEvidence {
  const fail = (reason: string): PostgresOwnershipEvidence => ({
    owned: false,
    reason,
    pid: null,
    executable: null,
    dataDirectory: null,
    clusterId: null,
    clusterName: null,
    port: null,
    processStartedAtUtc: null
  });

  const marker = readClusterMarker(input.layout);
  if (!marker) return fail("YUVI cluster marker is missing");
  if (marker.postgresMajor !== PRIVATE_POSTGRES_MAJOR) {
    return fail("cluster marker major is not 16");
  }
  const pgVersion = readPgVersion(input.layout);
  if (pgVersion !== PRIVATE_POSTGRES_MAJOR) {
    return fail("PG_VERSION is not 16");
  }
  if (!dataDirectoriesMatch(marker.dataDirectory, input.layout.data)) {
    return fail("cluster marker PGDATA does not match layout");
  }

  if (input.processInspection.status !== "resolved") {
    return fail(`process is not inspectable (${input.processInspection.status})`);
  }
  const info = input.processInspection.info;
  if (input.expectedPid != null && info.processId !== input.expectedPid) {
    return fail("inspected process is not the nominated postmaster PID");
  }
  const argv = parsePostgresArgv(info.commandLine);
  const expectedName = expectedClusterName(marker.clusterId);
  const expectedExe = input.distribution.postgres;
  const liveExe = info.executablePath ?? argv.executable;

  if (!executablesMatch(liveExe, expectedExe)) {
    return fail("executable is not the selected PostgreSQL 16 postgres binary");
  }
  if (!dataDirectoriesMatch(argv.dataDirectory, input.layout.data)) {
    return fail("exact -D PGDATA token does not match canonical PGDATA");
  }
  if (argv.clusterName !== expectedName) {
    return fail("cluster_name does not match yuvi-pg-<clusterId>");
  }

  if (input.launchStartedAt) {
    const maxAfterMs = input.launchMaxAfterMs ?? 30_000;
    if (
      !processStartedDuringLaunch(
        info.createdAtUtc,
        input.launchStartedAt,
        maxAfterMs,
        CREATION_TIME_TOLERANCE_MS
      )
    ) {
      return fail("process start time is not plausible for this launch");
    }
  }

  const requireMetadata = input.requirePreviousMetadata !== false;
  if (requireMetadata) {
    if (
      !previousMetadataIsFirstPartyEvidence({
        metadata: input.metadata,
        livePid: info.processId,
        liveStartedAt: info.createdAtUtc,
        expectedRole: POSTGRES_OWNERSHIP_ROLE,
        expectedCommandMarker: expectedName
      })
    ) {
      return fail("previous ownership metadata is not valid first-party evidence");
    }
  } else if (input.metadata && input.metadata.pid === info.processId) {
    if (!creationTimesMatch(input.metadata.processStartedAtUtc, info.createdAtUtc)) {
      return fail("process creation time does not match ownership metadata");
    }
  }

  return {
    owned: true,
    reason: "strong private PostgreSQL ownership",
    pid: info.processId,
    executable: canonicalPath(expectedExe),
    dataDirectory: canonicalPath(input.layout.data),
    clusterId: marker.clusterId,
    clusterName: expectedName,
    port: argv.port,
    processStartedAtUtc: info.createdAtUtc?.toISOString() ?? null
  };
}

export type StopPrivatePostgresInput = {
  layout: PostgresLayout;
  distribution: PostgresDistribution;
  processInspection: ProcessInspectionResult;
  metadata?: ProcessMetadata | null | undefined;
  invokeStop?:
    | ((input: { layout: PostgresLayout; distribution: PostgresDistribution }) => boolean)
    | undefined;
};

export type StopPrivatePostgresResult = {
  invoked: boolean;
  owned: boolean;
  reason: string;
  pid: number | null;
};

export function defaultInvokePgCtlStop(input: {
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

export function stopPrivatePostgresIfOwned(
  input: StopPrivatePostgresInput
): StopPrivatePostgresResult {
  const evidence = evaluatePostgresOwnership({
    layout: input.layout,
    distribution: input.distribution,
    processInspection: input.processInspection,
    metadata: input.metadata,
    requirePreviousMetadata: true
  });
  if (!evidence.owned || evidence.pid == null) {
    return {
      invoked: false,
      owned: false,
      reason: evidence.reason,
      pid: evidence.pid
    };
  }
  const nativePid = readPostmasterPid(input.layout.data);
  if (nativePid != null && nativePid !== evidence.pid) {
    return {
      invoked: false,
      owned: false,
      reason: "native postmaster.pid does not match the owned PostgreSQL process",
      pid: evidence.pid
    };
  }
  const invoke = input.invokeStop ?? defaultInvokePgCtlStop;
  const stopped = invoke({ layout: input.layout, distribution: input.distribution });
  return {
    invoked: stopped,
    owned: true,
    reason: stopped ? evidence.reason : "fenced PostgreSQL stop did not succeed",
    pid: evidence.pid
  };
}
