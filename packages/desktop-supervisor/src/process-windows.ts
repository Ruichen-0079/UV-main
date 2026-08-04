/**
 * Windows process helpers used by the desktop supervisor.
 * Avoids port-based or name-based mass kills.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ProcessInfo, StartCommandSpec } from "./types.js";

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
 * Full process info for ownership (command line). Prefer isProcessAlive for loops.
 * On Windows uses a short-timeout PowerShell query only when needed.
 */
export function getProcessInfo(processId: number): ProcessInfo | null {
  if (!Number.isInteger(processId) || processId <= 0) return null;
  if (!isProcessAlive(processId)) return null;

  if (process.platform !== "win32") {
    return {
      processId,
      parentProcessId: 0,
      commandLine: `pid=${processId}`,
      createdAtUtc: new Date()
    };
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
    { encoding: "utf8", windowsHide: true, timeout: 2_500 }
  );
  if (result.status !== 0 || !result.stdout?.trim()) {
    // Process is alive but command line unavailable — still return a stub so ownership can use pid.
    return {
      processId,
      parentProcessId: 0,
      commandLine: "",
      createdAtUtc: null
    };
  }
  try {
    const parsed = JSON.parse(result.stdout.trim()) as {
      processId: number;
      parentProcessId: number;
      commandLine: string;
      createdAtUtc: string | null;
    };
    return {
      processId: parsed.processId,
      parentProcessId: parsed.parentProcessId,
      commandLine: parsed.commandLine ?? "",
      createdAtUtc: parsed.createdAtUtc ? new Date(parsed.createdAtUtc) : null
    };
  } catch {
    return {
      processId,
      parentProcessId: 0,
      commandLine: "",
      createdAtUtc: null
    };
  }
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
