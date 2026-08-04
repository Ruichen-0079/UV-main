/**
 * Windows process helpers used by the desktop supervisor.
 * Avoids port-based or name-based mass kills.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ProcessInfo, StartCommandSpec } from "./types.js";

export function getProcessInfo(processId: number): ProcessInfo | null {
  if (!Number.isInteger(processId) || processId <= 0) return null;
  if (process.platform !== "win32") {
    try {
      process.kill(processId, 0);
      return {
        processId,
        parentProcessId: 0,
        commandLine: `pid=${processId}`,
        createdAtUtc: new Date()
      };
    } catch {
      return null;
    }
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
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8", windowsHide: true, timeout: 8_000 }
  );
  if (result.status !== 0 || !result.stdout?.trim()) {
    return null;
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
    return null;
  }
}

export function isProcessAlive(processId: number): boolean {
  return getProcessInfo(processId) !== null;
}

/**
 * Spawn a managed child with no console window flash on Windows.
 */
export function spawnManagedProcess(
  command: StartCommandSpec,
  log: { out: string; err: string }
): ChildProcess {
  fs.mkdirSync(path.dirname(log.out), { recursive: true });
  const child = spawn(command.file, command.args, {
    cwd: command.cwd,
    env: { ...process.env, ...command.env },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false
  });

  const outStream = fs.createWriteStream(log.out, { flags: "a" });
  const errStream = fs.createWriteStream(log.err, { flags: "a" });
  child.stdout?.pipe(outStream);
  child.stderr?.pipe(errStream);
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
      timeout: 10_000
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
      timeout: 15_000
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
