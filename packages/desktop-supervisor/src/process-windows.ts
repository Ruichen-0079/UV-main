/**
 * Windows process helpers used by the desktop supervisor.
 * Avoids port-based or name-based mass kills.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ProcessInfo, ProcessInspectionResult, StartCommandSpec } from "./types.js";

export const DEFAULT_WINDOWS_PROCESS_QUERY_TIMEOUT_MS = 2_500;
export const MAX_WINDOWS_PROCESS_QUERY_TIMEOUT_MS = 10_000;
/** Diagnostic-only bound for the non-CIM PostgreSQL identity experiment. */
export const NON_CIM_PROCESS_PROBE_TIMEOUT_MS = 4_000;

export type ProcessInspectionOptions = {
  windowsQueryTimeoutMs?: number;
};

export type NonCimProcessProbeStatus =
  | "RESOLVED"
  | "NOT_RUNNING"
  | "TIMEOUT"
  | "EXIT_NONZERO"
  | "EMPTY_OUTPUT"
  | "PARSE_FAILED"
  | "ERROR";

export type NonCimProcessProbeResult = {
  status: NonCimProcessProbeStatus;
  processId: number;
  processIdMatches: boolean | null;
  durationMs: number;
  executablePath: string | null;
  startedAtUtc: string | null;
};

function normalizeWindowsProcessQueryTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_WINDOWS_PROCESS_QUERY_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_WINDOWS_PROCESS_QUERY_TIMEOUT_MS;
  return Math.min(Math.max(1, Math.floor(value)), MAX_WINDOWS_PROCESS_QUERY_TIMEOUT_MS);
}

/**
 * Fast liveness check — never shells out to PowerShell (that blocked Save for seconds).
 */
export function isProcessAlive(processId: number): boolean {
  if (!Number.isInteger(processId) || processId <= 0) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Full process inspection for ownership. The result deliberately distinguishes
 * a dead process from a live process whose identity query was unavailable.
 */
export function inspectProcess(
  processId: number,
  options?: ProcessInspectionOptions
): ProcessInspectionResult {
  if (!Number.isInteger(processId) || processId <= 0) {
    return { status: "not-running", processId, reason: "invalid-pid" };
  }
  if (!isProcessAlive(processId)) {
    return { status: "not-running", processId, reason: "process-not-alive" };
  }

  if (process.platform !== "win32") {
    return inspectPosixProcess(processId);
  }

  const script = `
$p = Get-CimInstance Win32_Process -Filter "ProcessId=${processId}" -ErrorAction SilentlyContinue
if (-not $p) { exit 3 }
$created = $null
if ($p.CreationDate) {
  $created = ([System.Management.ManagementDateTimeConverter]::ToDateTime([string]$p.CreationDate)).ToUniversalTime().ToString('o')
}
$obj = [ordered]@{
  processId = [int]$p.ProcessId
  parentProcessId = [int]$p.ParentProcessId
  commandLine = [string]$p.CommandLine
  createdAtUtc = $created
  executablePath = [string]$p.ExecutablePath
}
$obj | ConvertTo-Json -Compress
`;
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: normalizeWindowsProcessQueryTimeout(options?.windowsQueryTimeoutMs)
    }
  );
  return classifyProcessQueryResult(processId, {
    status: result.status,
    stdout: result.stdout,
    signal: result.signal,
    error: result.error
  });
}

type NonCimProcessQueryResult = {
  status: number | null;
  stdout?: string | null | undefined;
  signal?: NodeJS.Signals | string | null | undefined;
  error?: NodeJS.ErrnoException | null | undefined;
};

function boundedProbeDurationMs(value: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(Math.round(value), 0), 60_000) : 0;
}

function classifyNonCimProcessProbeResult(
  processId: number,
  durationMs: number,
  result: NonCimProcessQueryResult
): NonCimProcessProbeResult {
  const duration = boundedProbeDurationMs(durationMs);
  const errorCode = result.error?.code ? String(result.error.code) : "";
  if (errorCode === "ETIMEDOUT" || (result.signal === "SIGTERM" && result.status === null)) {
    return {
      status: "TIMEOUT",
      processId,
      processIdMatches: null,
      durationMs: duration,
      executablePath: null,
      startedAtUtc: null
    };
  }
  if (result.status !== 0) {
    return {
      status: "EXIT_NONZERO",
      processId,
      processIdMatches: null,
      durationMs: duration,
      executablePath: null,
      startedAtUtc: null
    };
  }
  if (!result.stdout?.trim()) {
    return {
      status: "EMPTY_OUTPUT",
      processId,
      processIdMatches: null,
      durationMs: duration,
      executablePath: null,
      startedAtUtc: null
    };
  }
  try {
    const parsed = JSON.parse(result.stdout.trim()) as {
      processId?: unknown;
      executablePath?: unknown;
      startedAtUtc?: unknown;
    };
    const parsedProcessId = parsed.processId;
    const executablePath = parsed.executablePath;
    const startedAtUtc = parsed.startedAtUtc;
    if (
      typeof parsedProcessId !== "number" ||
      !Number.isInteger(parsedProcessId) ||
      parsedProcessId <= 0 ||
      typeof executablePath !== "string" ||
      executablePath.length === 0 ||
      executablePath.length > 1_024 ||
      typeof startedAtUtc !== "string" ||
      startedAtUtc.length === 0 ||
      startedAtUtc.length > 128 ||
      !Number.isFinite(Date.parse(startedAtUtc))
    ) {
      return {
        status: "PARSE_FAILED",
        processId,
        processIdMatches: null,
        durationMs: duration,
        executablePath: null,
        startedAtUtc: null
      };
    }
    return {
      status: "RESOLVED",
      processId,
      processIdMatches: parsedProcessId === processId,
      durationMs: duration,
      executablePath,
      startedAtUtc: new Date(startedAtUtc).toISOString()
    };
  } catch {
    return {
      status: "PARSE_FAILED",
      processId,
      processIdMatches: null,
      durationMs: duration,
      executablePath: null,
      startedAtUtc: null
    };
  }
}

/**
 * Diagnostic-only Windows identity experiment. This deliberately does not
 * use CIM/WMI and never participates in ownership or lifecycle decisions.
 */
export function inspectWindowsProcessWithoutCim(processId: number): NonCimProcessProbeResult {
  const started = Date.now();
  if (!Number.isInteger(processId) || processId <= 0) {
    return {
      status: "NOT_RUNNING",
      processId,
      processIdMatches: null,
      durationMs: 0,
      executablePath: null,
      startedAtUtc: null
    };
  }
  if (!isProcessAlive(processId)) {
    return {
      status: "NOT_RUNNING",
      processId,
      processIdMatches: null,
      durationMs: boundedProbeDurationMs(Date.now() - started),
      executablePath: null,
      startedAtUtc: null
    };
  }
  if (process.platform !== "win32") {
    return {
      status: "ERROR",
      processId,
      processIdMatches: null,
      durationMs: boundedProbeDurationMs(Date.now() - started),
      executablePath: null,
      startedAtUtc: null
    };
  }

  const script = `
try {
  $p = [System.Diagnostics.Process]::GetProcessById(${processId})
  $obj = [ordered]@{
    processId = [int]$p.Id
    executablePath = [string]$p.MainModule.FileName
    startedAtUtc = $p.StartTime.ToUniversalTime().ToString('o')
  }
  $obj | ConvertTo-Json -Compress
} catch {
  exit 5
}
`;
  let result: NonCimProcessQueryResult;
  try {
    result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: NON_CIM_PROCESS_PROBE_TIMEOUT_MS
      }
    );
  } catch {
    return {
      status: "ERROR",
      processId,
      processIdMatches: null,
      durationMs: boundedProbeDurationMs(Date.now() - started),
      executablePath: null,
      startedAtUtc: null
    };
  }
  return classifyNonCimProcessProbeResult(processId, Date.now() - started, result);
}

function inspectPosixProcess(processId: number): ProcessInspectionResult {
  try {
    const cmdline = fs.readFileSync(`/proc/${processId}/cmdline`, "utf8");
    const commandLine = cmdline.replaceAll("\0", " ").trim();
    let parentProcessId = 0;
    let createdAtUtc: Date | null = null;
    try {
      const stat = fs.readFileSync(`/proc/${processId}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const rest = close >= 0 ? stat.slice(close + 2).split(" ") : [];
      parentProcessId = Number(rest[1] ?? 0) || 0;
      const startTicks = Number(rest[19] ?? 0);
      if (Number.isFinite(startTicks) && startTicks > 0) {
        const uptime = fs.readFileSync("/proc/uptime", "utf8");
        const uptimeSec = Number(uptime.split(" ")[0] ?? 0);
        const hertz = 100;
        const elapsedSec = uptimeSec - startTicks / hertz;
        createdAtUtc = new Date(Date.now() - Math.max(0, elapsedSec) * 1000);
      }
    } catch {
      // Command line is the required identity; start time is best-effort.
    }
    if (!commandLine) {
      return { status: "unavailable", processId, reason: "empty-output" };
    }
    let executablePath: string | null = null;
    try {
      executablePath = fs.realpathSync.native(`/proc/${processId}/exe`);
    } catch {
      executablePath = null;
    }
    return {
      status: "resolved",
      processId,
      info: {
        processId,
        parentProcessId,
        commandLine,
        createdAtUtc,
        executablePath
      }
    };
  } catch {
    if (!isProcessAlive(processId)) {
      return { status: "not-running", processId, reason: "process-not-alive" };
    }
    return { status: "unavailable", processId, reason: "query-failed" };
  }
}

type ProcessQueryResult = {
  status: number | null;
  stdout?: string | null | undefined;
  signal?: NodeJS.Signals | null | undefined;
  error?: NodeJS.ErrnoException | null | undefined;
};

/** Convert a PowerShell/CIM result into the explicit inspection state. */
export function classifyProcessQueryResult(
  processId: number,
  result: ProcessQueryResult
): ProcessInspectionResult {
  const errorCode = result.error?.code ? String(result.error.code) : "";
  if (errorCode === "ETIMEDOUT" || (result.signal === "SIGTERM" && result.status === null)) {
    return { status: "unavailable", processId, reason: "query-timeout" };
  }
  if (result.status !== 0) {
    return { status: "unavailable", processId, reason: "query-failed" };
  }
  if (!result.stdout?.trim()) {
    return { status: "unavailable", processId, reason: "empty-output" };
  }
  try {
    const parsed = JSON.parse(result.stdout.trim()) as {
      processId: number;
      parentProcessId: number;
      commandLine: string;
      createdAtUtc: string | null;
      executablePath?: string | null;
    };
    if (
      !Number.isInteger(parsed.processId) ||
      parsed.processId <= 0 ||
      !Number.isInteger(parsed.parentProcessId) ||
      typeof parsed.commandLine !== "string"
    ) {
      return { status: "unavailable", processId, reason: "parse-failed" };
    }
    return {
      status: "resolved",
      processId: parsed.processId,
      info: {
        processId: parsed.processId,
        parentProcessId: parsed.parentProcessId,
        commandLine: parsed.commandLine,
        createdAtUtc: parsed.createdAtUtc ? new Date(parsed.createdAtUtc) : null,
        executablePath: parsed.executablePath ? String(parsed.executablePath) : null
      }
    };
  } catch {
    return { status: "unavailable", processId, reason: "parse-failed" };
  }
}

/**
 * Compatibility wrapper for callers that only need resolved process details.
 * Ownership revalidation must use inspectProcess so unavailable is not confused
 * with a dead process.
 */
export function getProcessInfo(processId: number): ProcessInfo | null {
  const inspection = inspectProcess(processId);
  return inspection.status === "resolved" ? inspection.info : null;
}

/**
 * Spawn a managed child with no console window flash on Windows.
 * When `env` is provided it is used as-is (caller must merge + unset secrets).
 * Otherwise falls back to process.env + command.env.
 *
 * Note: on Windows, children are NOT auto-killed when the supervisor exits unless
 * we explicitly taskkill the tree during shutdown (see forceKillProcessTree).
 */
export function spawnManagedProcess(
  command: StartCommandSpec,
  log: { out: string; err: string },
  options?: { env?: NodeJS.ProcessEnv }
): ChildProcess {
  fs.mkdirSync(path.dirname(log.out), { recursive: true });
  const child = spawn(command.file, command.args, {
    cwd: command.cwd,
    env: options?.env ?? { ...process.env, ...command.env },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false
  });

  const outStream = fs.createWriteStream(log.out, { flags: "a" });
  const errStream = fs.createWriteStream(log.err, { flags: "a" });
  child.stdout?.pipe(outStream);
  child.stderr?.pipe(errStream);
  // Prevent uncaughtException when the binary is missing (tests / misconfig).
  child.on("error", () => {
    try {
      outStream.end();
      errStream.end();
    } catch {
      // ignore
    }
  });
  child.on("exit", () => {
    outStream.end();
    errStream.end();
  });
  return child;
}

/**
 * Request graceful exit of a process tree (no /F on Windows).
 * Only call after ownership checks pass.
 */
export function requestGracefulStop(processId: number): void {
  if (!Number.isInteger(processId) || processId <= 0) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(processId), "/T"], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 5_000
    });
    return;
  }
  try {
    process.kill(processId, "SIGTERM");
  } catch {
    // ignore
  }
}

/**
 * Force-kill process tree. Only after ownership re-check + graceful timeout.
 * Never used for external services.
 */
export function forceKillProcessTree(processId: number): void {
  if (!Number.isInteger(processId) || processId <= 0) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(processId), "/T", "/F"], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 8_000
    });
    return;
  }
  try {
    process.kill(processId, "SIGKILL");
  } catch {
    // ignore
  }
}

/** @deprecated Prefer requestGracefulStop + forceKillProcessTree with re-check. */
export function stopProcessTree(processId: number): void {
  forceKillProcessTree(processId);
}
