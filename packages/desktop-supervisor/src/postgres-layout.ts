/**
 * Packaged private PostgreSQL data-directory and identity contract.
 * Mutable cluster state lives under the user-writable YUVI data root, never
 * the install/resource tree or a repository checkout.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  canonicalPath,
  defaultYuviLocalDataRoot,
  isWindowsStylePath,
  pathsEqual
} from "./paths.js";
import {
  aclGrantArguments as aclGrantArgumentsImpl,
  applyRestrictedPermissions,
  type RestrictedPathKind,
  type WindowsAclAdapter
} from "./postgres-acl.js";

export const PRIVATE_POSTGRES_MAJOR = 16;
export const PRIVATE_POSTGRES_PREFERRED_PORT = 55432;
export const PRIVATE_POSTGRES_HOST = "127.0.0.1";
export const PRIVATE_POSTGRES_USER = "yuvi";
export const PRIVATE_POSTGRES_DATABASE = "yuvi";
export const PRIVATE_POSTGRES_PRODUCT = "yuvi";
export const CLUSTER_MARKER_SCHEMA_VERSION = 1 as const;
export const INITIALIZATION_STATE_SCHEMA_VERSION = 1 as const;
export const LISTEN_METADATA_SCHEMA_VERSION = 1 as const;

export type PostgresInitializationStateName = "missing" | "initializing" | "ready" | "failed";

export type PostgresLayout = {
  root: string;
  data: string;
  runtime: string;
  markerFile: string;
  listenFile: string;
  initializationStateFile: string;
  logFile: string;
  pgpassFile: string;
  passwordFile: string;
  metadataFile: string;
};

export type YuviClusterMarker = {
  schemaVersion: 1;
  product: typeof PRIVATE_POSTGRES_PRODUCT;
  clusterId: string;
  postgresMajor: typeof PRIVATE_POSTGRES_MAJOR;
  createdAt: string;
  dataDirectory: string;
};

export type PostgresListenMetadata = {
  schemaVersion: 1;
  host: typeof PRIVATE_POSTGRES_HOST;
  port: number;
  clusterId: string;
  postgresMajor: typeof PRIVATE_POSTGRES_MAJOR;
};

export type PostgresInitializationFailureKind =
  | "SPAWN_FAILED"
  | "EXIT_NONZERO"
  | "SIGNALLED"
  | "TIMEOUT"
  | "INIT_THREW";

export type PostgresInitializationFailureEvidence = {
  errorCode?: PostgresInitializationFailureKind | undefined;
  exitStatus?: number | null | undefined;
  signal?: string | null | undefined;
  spawnErrorCode?: string | null | undefined;
  stdoutTail?: string | undefined;
  stderrTail?: string | undefined;
};

export type PostgresInitializationState = {
  schemaVersion: 1;
  state: PostgresInitializationStateName;
  updatedAt: string;
  reason?: string | undefined;
} & PostgresInitializationFailureEvidence;

export type PostgresLayoutBounds = {
  resourceRoot?: string | undefined;
  repositoryRoot?: string | undefined;
  packaged?: boolean | undefined;
  localAppData?: string | undefined;
  userProfile?: string | undefined;
  tempRoot?: string | undefined;
  windowsDirectory?: string | undefined;
};

export type PathIdentity = {
  lexical: string;
  identity: string;
};

export function resolvePostgresLayout(
  env: Record<string, string | undefined>,
  bounds: PostgresLayoutBounds = {}
): PostgresLayout {
  const explicit = env["YUVI_POSTGRES_DATA_ROOT"]?.trim();
  const root = explicit
    ? requireAbsolutePath(explicit, "YUVI_POSTGRES_DATA_ROOT")
    : canonicalPath(path.join(defaultYuviLocalDataRoot(env), "Postgres"));
  const unsafe = describeUnsafePostgresDataRoot(root, { ...bounds, env });
  if (unsafe) {
    throw new Error(`Private PostgreSQL data root is not safe: ${unsafe}`);
  }
  return layoutFromRoot(root);
}

export function layoutFromRoot(root: string): PostgresLayout {
  const canonical = canonicalPath(root);
  const data = canonicalPath(path.join(canonical, "data"));
  const runtime = canonicalPath(path.join(canonical, "runtime"));
  return {
    root: canonical,
    data,
    runtime,
    markerFile: path.join(canonical, "marker.json"),
    listenFile: path.join(runtime, "listen.json"),
    initializationStateFile: path.join(runtime, "initialization-state.json"),
    logFile: path.join(runtime, "postgres.log"),
    pgpassFile: path.join(runtime, "pgpass"),
    passwordFile: path.join(runtime, "local.secret"),
    metadataFile: path.join(runtime, "postgres.pid.json")
  };
}

export function resolvePathIdentity(input: string): PathIdentity {
  const lexical = canonicalPath(input);
  if (!lexical) return { lexical, identity: lexical };
  if (isUncPath(lexical) || isDevicePath(lexical)) {
    return { lexical, identity: lexical };
  }
  if (isWindowsStylePath(lexical) && process.platform !== "win32") {
    return { lexical, identity: lexical.replace(/\\+$/, "") };
  }
  try {
    if (fs.existsSync(lexical)) {
      return { lexical, identity: canonicalPath(fs.realpathSync.native(lexical)) };
    }
    const parts: string[] = [];
    let current = lexical;
    while (true) {
      const parent = path.dirname(current);
      if (parent === current) break;
      if (fs.existsSync(current)) {
        const real = canonicalPath(fs.realpathSync.native(current));
        return { lexical, identity: canonicalPath(path.join(real, ...parts.reverse())) };
      }
      parts.push(path.basename(current));
      current = parent;
    }
  } catch {
    return { lexical, identity: lexical };
  }
  return { lexical, identity: lexical };
}

export function describeUnsafePostgresDataRoot(
  root: string,
  bounds: PostgresLayoutBounds & { env?: Record<string, string | undefined> } = {}
): string | null {
  const env = bounds.env ?? process.env;
  if (!root?.trim()) return "empty path";
  if (isUncPath(root) || (!path.isAbsolute(root) && !isWindowsStylePath(root))) {
    if (!path.isAbsolute(root) && !isWindowsStylePath(root)) return "relative path";
  }
  if (isUncPath(root)) return "UNC/network path";
  if (isDevicePath(root)) return "device path";

  const resolved = resolvePathIdentity(root);
  const candidate = resolved.identity;
  if (!candidate) return "empty path";
  if (isVolumeRoot(candidate)) return "volume root";
  if (isUncPath(candidate)) return "UNC/network path";
  if (isDevicePath(candidate)) return "device path";

  const resource = bounds.resourceRoot ? resolvePathIdentity(bounds.resourceRoot).identity : null;
  if (resource && isSameOrInsideIdentity(candidate, resource)) {
    return "inside the install/resource directory";
  }
  const repo = bounds.repositoryRoot ? resolvePathIdentity(bounds.repositoryRoot).identity : null;
  if (repo && isSameOrInsideIdentity(candidate, repo)) {
    return "inside the repository checkout";
  }

  const windowsDir =
    bounds.windowsDirectory ??
    env["SystemRoot"] ??
    env["WINDIR"] ??
    (isWindowsStylePath(candidate) ? "C:\\Windows" : null);
  if (windowsDir && isSameOrInsideIdentity(candidate, resolvePathIdentity(windowsDir).identity)) {
    return "inside the Windows directory";
  }
  if (isProgramFilesIdentity(candidate)) return "inside Program Files";
  if (isProgramDataIdentity(candidate, env)) return "inside ProgramData";

  const profile = bounds.userProfile ?? env["USERPROFILE"] ?? env["HOME"];
  if (profile && pathsEqual(candidate, resolvePathIdentity(profile).identity)) {
    return "user profile root";
  }

  const packaged = bounds.packaged === true;
  const tempRoot = bounds.tempRoot ?? env["TEMP"] ?? env["TMP"] ?? os.tmpdir();
  if (
    packaged &&
    tempRoot &&
    isSameOrInsideIdentity(candidate, resolvePathIdentity(tempRoot).identity)
  ) {
    return "inside the temporary directory";
  }
  if (packaged) {
    const yuviRoot = resolvePathIdentity(
      bounds.localAppData ? path.join(bounds.localAppData, "YUVI") : defaultYuviLocalDataRoot(env)
    ).identity;
    if (!isSameOrInsideIdentity(candidate, yuviRoot)) {
      return "outside the user YUVI data root";
    }
  }
  return null;
}

export function describeEscapedPgdata(layout: PostgresLayout): string | null {
  const root = resolvePathIdentity(layout.root);
  const data = resolvePathIdentity(layout.data);
  if (!isSameOrInsideIdentity(data.identity, root.identity)) {
    return "PGDATA escapes the data root through a symlink, junction, or reparse point";
  }
  if (path.basename(layout.data) !== "data") {
    return "PGDATA is not the canonical data/ child of the cluster root";
  }
  return null;
}

export function assertPgdataContained(layout: PostgresLayout): void {
  const escaped = describeEscapedPgdata(layout);
  if (escaped) {
    throw new Error(`Private PostgreSQL PGDATA is not contained: ${escaped}`);
  }
}

export function ensurePostgresDirectories(
  layout: PostgresLayout,
  options: { adapter?: WindowsAclAdapter; platform?: NodeJS.Platform } = {}
): void {
  assertPgdataContained(layout);
  const directoryAcl = {
    kind: "directory" as const,
    ...(options.adapter ? { adapter: options.adapter } : {}),
    ...(options.platform ? { platform: options.platform } : {})
  };
  fs.mkdirSync(layout.root, { recursive: true });
  applyRestrictedPermissions(layout.root, directoryAcl);
  fs.mkdirSync(layout.data, { recursive: true });
  applyRestrictedPermissions(layout.data, directoryAcl);
  fs.mkdirSync(layout.runtime, { recursive: true });
  applyRestrictedPermissions(layout.runtime, directoryAcl);
  assertPgdataContained(layout);
}

export function readClusterMarker(layout: PostgresLayout): YuviClusterMarker | null {
  return readJsonFile(layout.markerFile, parseClusterMarker);
}

export function writeClusterMarker(layout: PostgresLayout, marker: YuviClusterMarker): void {
  writeJsonFile(layout.markerFile, marker);
  restrictPathToCurrentUser(layout.markerFile, { kind: "file" });
}

export function createClusterMarker(layout: PostgresLayout): YuviClusterMarker {
  return {
    schemaVersion: CLUSTER_MARKER_SCHEMA_VERSION,
    product: PRIVATE_POSTGRES_PRODUCT,
    clusterId: randomUUID(),
    postgresMajor: PRIVATE_POSTGRES_MAJOR,
    createdAt: new Date().toISOString(),
    dataDirectory: layout.data
  };
}

export function readListenMetadata(layout: PostgresLayout): PostgresListenMetadata | null {
  return readJsonFile(layout.listenFile, parseListenMetadata);
}

export function writeListenMetadata(layout: PostgresLayout, listen: PostgresListenMetadata): void {
  writeJsonFile(layout.listenFile, listen);
  restrictPathToCurrentUser(layout.listenFile, { kind: "file" });
}

export function readInitializationState(
  layout: PostgresLayout
): PostgresInitializationState | null {
  return readJsonFile(layout.initializationStateFile, parseInitializationState);
}

export function writeInitializationState(
  layout: PostgresLayout,
  state: PostgresInitializationStateName,
  reason?: string,
  evidence?: PostgresInitializationFailureEvidence
): void {
  const record: PostgresInitializationState = {
    schemaVersion: INITIALIZATION_STATE_SCHEMA_VERSION,
    state,
    updatedAt: new Date().toISOString(),
    ...(reason ? { reason } : {})
  };
  if (state === "failed" && evidence) {
    if (evidence.errorCode) record.errorCode = evidence.errorCode;
    if (evidence.exitStatus !== undefined) record.exitStatus = evidence.exitStatus;
    if (evidence.signal !== undefined) record.signal = evidence.signal;
    if (evidence.spawnErrorCode !== undefined) record.spawnErrorCode = evidence.spawnErrorCode;
    if (evidence.stdoutTail) record.stdoutTail = evidence.stdoutTail;
    if (evidence.stderrTail) record.stderrTail = evidence.stderrTail;
  }
  writeJsonFile(layout.initializationStateFile, record);
  restrictPathToCurrentUser(layout.initializationStateFile, { kind: "file" });
}

export function readPgVersion(layout: PostgresLayout): number | null {
  const file = path.join(layout.data, "PG_VERSION");
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, "utf8").trim();
  const major = Number.parseInt(raw.split(".")[0] ?? "", 10);
  return Number.isInteger(major) ? major : null;
}

export function isPgdataEmpty(layout: PostgresLayout): boolean {
  if (!fs.existsSync(layout.data)) return true;
  const entries = fs.readdirSync(layout.data).filter((name) => name !== "." && name !== "..");
  return entries.length === 0;
}

export function pgdataLooksInitialized(layout: PostgresLayout): boolean {
  return fs.existsSync(path.join(layout.data, "PG_VERSION"));
}

export function restrictPathToCurrentUser(
  targetPath: string,
  options: {
    adapter?: WindowsAclAdapter;
    platform?: NodeJS.Platform;
    kind: RestrictedPathKind;
  }
): void {
  applyRestrictedPermissions(targetPath, options);
}

export function aclGrantArguments(
  targetPath: string,
  user: string,
  kind: RestrictedPathKind
): string[] {
  return aclGrantArgumentsImpl(targetPath, user, kind);
}

function requireAbsolutePath(value: string, key: string): string {
  if (!path.isAbsolute(value) && !isWindowsStylePath(value)) {
    throw new Error(`${key} must be an absolute path.`);
  }
  return canonicalPath(value);
}

function isUncPath(value: string): boolean {
  return /^\\\\[^\\]/.test(value.trim()) || value.trim().startsWith("//");
}

function isDevicePath(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.startsWith("\\\\.\\") ||
    trimmed.startsWith("\\\\?\\") ||
    trimmed === "/dev" ||
    trimmed.startsWith("/dev/")
  );
}

function isVolumeRoot(value: string): boolean {
  const stripped = value.replace(/[\\/]+$/, "");
  if (stripped === "" || stripped === "/" || /^[A-Za-z]:$/.test(stripped)) return true;
  const normalized = canonicalPath(value);
  if (normalized === "/" || normalized === "\\") return true;
  if (/^[A-Za-z]:\\?$/.test(normalized)) return true;
  return false;
}

function isProgramFilesIdentity(value: string): boolean {
  const win = value.replaceAll("/", "\\");
  const lower = win.toLowerCase();
  const match = lower.match(/^([a-z]:\\)(.*)$/);
  if (!match) return false;
  const rest = match[2] ?? "";
  return (
    rest === "program files" ||
    rest === "program files (x86)" ||
    rest.startsWith("program files\\") ||
    rest.startsWith("program files (x86)\\")
  );
}

function isProgramDataIdentity(value: string, env: Record<string, string | undefined>): boolean {
  const programData = env["ProgramData"] ?? (isWindowsStylePath(value) ? "C:\\ProgramData" : null);
  if (!programData) return false;
  return isSameOrInsideIdentity(value, resolvePathIdentity(programData).identity);
}

function isSameOrInsideIdentity(candidate: string, root: string): boolean {
  const left = canonicalPath(candidate);
  const right = canonicalPath(root);
  if (!right) return false;
  if (pathsEqual(left, right)) return true;
  const sep = isWindowsStylePath(left) || isWindowsStylePath(right) ? "\\" : path.sep;
  const leftCmp = isWindowsStylePath(left) || isWindowsStylePath(right) ? left.toLowerCase() : left;
  const rightCmp =
    isWindowsStylePath(left) || isWindowsStylePath(right) ? right.toLowerCase() : right;
  const prefix = rightCmp.endsWith(sep) ? rightCmp : `${rightCmp}${sep}`;
  return leftCmp.startsWith(prefix);
}

function readJsonFile<T>(filePath: string, parse: (value: unknown) => T | null): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return parse(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch {
    return null;
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  applyRestrictedPermissions(path.dirname(filePath), { kind: "directory" });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, filePath);
  applyRestrictedPermissions(filePath, { kind: "file" });
}

function parseClusterMarker(value: unknown): YuviClusterMarker | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record["schemaVersion"] !== CLUSTER_MARKER_SCHEMA_VERSION) return null;
  if (record["product"] !== PRIVATE_POSTGRES_PRODUCT) return null;
  if (record["postgresMajor"] !== PRIVATE_POSTGRES_MAJOR) return null;
  if (typeof record["clusterId"] !== "string" || !record["clusterId"].trim()) return null;
  if (typeof record["createdAt"] !== "string" || !record["createdAt"].trim()) return null;
  if (typeof record["dataDirectory"] !== "string" || !record["dataDirectory"].trim()) return null;
  return {
    schemaVersion: CLUSTER_MARKER_SCHEMA_VERSION,
    product: PRIVATE_POSTGRES_PRODUCT,
    clusterId: record["clusterId"],
    postgresMajor: PRIVATE_POSTGRES_MAJOR,
    createdAt: record["createdAt"],
    dataDirectory: canonicalPath(record["dataDirectory"])
  };
}

function parseListenMetadata(value: unknown): PostgresListenMetadata | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record["schemaVersion"] !== LISTEN_METADATA_SCHEMA_VERSION) return null;
  if (record["host"] !== PRIVATE_POSTGRES_HOST) return null;
  if (typeof record["clusterId"] !== "string" || !record["clusterId"].trim()) return null;
  if (record["postgresMajor"] !== PRIVATE_POSTGRES_MAJOR) return null;
  const port = Number(record["port"]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return {
    schemaVersion: LISTEN_METADATA_SCHEMA_VERSION,
    host: PRIVATE_POSTGRES_HOST,
    port,
    clusterId: record["clusterId"],
    postgresMajor: PRIVATE_POSTGRES_MAJOR
  };
}

function parseInitializationState(value: unknown): PostgresInitializationState | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const state = record["state"];
  if (record["schemaVersion"] !== INITIALIZATION_STATE_SCHEMA_VERSION) return null;
  if (state !== "missing" && state !== "initializing" && state !== "ready" && state !== "failed") {
    return null;
  }
  if (typeof record["updatedAt"] !== "string") return null;
  return {
    schemaVersion: INITIALIZATION_STATE_SCHEMA_VERSION,
    state,
    updatedAt: record["updatedAt"],
    ...(typeof record["reason"] === "string" ? { reason: record["reason"] } : {}),
    ...optionalFailureKind(record["errorCode"]),
    ...optionalIntOrNullField("exitStatus", record["exitStatus"]),
    ...optionalStringOrNullField("signal", record["signal"]),
    ...optionalStringOrNullField("spawnErrorCode", record["spawnErrorCode"]),
    ...(typeof record["stdoutTail"] === "string" ? { stdoutTail: record["stdoutTail"] } : {}),
    ...(typeof record["stderrTail"] === "string" ? { stderrTail: record["stderrTail"] } : {})
  };
}

function optionalFailureKind(
  value: unknown
): { errorCode: PostgresInitializationFailureKind } | Record<string, never> {
  if (
    value === "SPAWN_FAILED" ||
    value === "EXIT_NONZERO" ||
    value === "SIGNALLED" ||
    value === "TIMEOUT" ||
    value === "INIT_THREW"
  ) {
    return { errorCode: value };
  }
  return {};
}

function optionalIntOrNullField(
  key: "exitStatus",
  value: unknown
): { exitStatus: number | null } | Record<string, never> {
  if (value === null) return { [key]: null };
  if (typeof value === "number" && Number.isInteger(value)) return { [key]: value };
  return {};
}

function optionalStringOrNullField(
  key: "signal" | "spawnErrorCode",
  value: unknown
): { [K in typeof key]?: string | null } {
  if (value === null) return { [key]: null };
  if (typeof value === "string") return { [key]: value.slice(0, 64) };
  return {};
}
