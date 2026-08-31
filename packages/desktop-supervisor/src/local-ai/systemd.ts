import { spawnSync } from "node:child_process";
import { ALLOWLISTED_SYSTEMD_UNIT_NAMES, assertAllowlistedUnit } from "./allowlist.js";

export type SystemdUnitAction = "start" | "stop" | "restart";

export type SystemdUnitSnapshot = {
  unit: string;
  loaded: boolean;
  activeState: string;
  subState: string;
  mainPid: number | null;
  memoryCurrent: number | null;
  exists: boolean;
};

export function isSystemdUserAvailable(): boolean {
  if (process.platform !== "linux") return false;
  const probe = spawnSync("systemctl", ["--user", "--version"], {
    encoding: "utf8",
    timeout: 2_000,
    windowsHide: true
  });
  return probe.status === 0;
}

export function showAllowlistedUnit(unit: string): SystemdUnitSnapshot {
  const safe = assertAllowlistedUnit(unit);
  if (!isSystemdUserAvailable()) {
    return emptySnapshot(safe);
  }
  const result = spawnSync(
    "systemctl",
    ["--user", "show", safe, "--property=LoadState,ActiveState,SubState,MainPID,MemoryCurrent,Id"],
    { encoding: "utf8", timeout: 3_000, windowsHide: true }
  );
  if (result.status !== 0) {
    return emptySnapshot(safe);
  }
  const fields = parseShow(result.stdout);
  const loadState = fields["LoadState"] ?? "not-found";
  const mainPid = parsePositiveInt(fields["MainPID"]);
  const memory = parseNonNegativeInt(fields["MemoryCurrent"]);
  return {
    unit: safe,
    loaded: loadState === "loaded",
    activeState: fields["ActiveState"] ?? "unknown",
    subState: fields["SubState"] ?? "unknown",
    mainPid,
    memoryCurrent: memory != null && memory > 1e15 ? null : memory,
    exists: loadState === "loaded"
  };
}

export function controlAllowlistedUnit(
  unit: string,
  action: SystemdUnitAction
): { ok: boolean; message: string } {
  const safe = assertAllowlistedUnit(unit);
  if (!isSystemdUserAvailable()) {
    return { ok: false, message: "systemd --user is not available on this host." };
  }
  const result = spawnSync("systemctl", ["--user", action, safe], {
    encoding: "utf8",
    timeout: action === "start" ? 180_000 : 45_000,
    windowsHide: true
  });
  if (result.status === 0) {
    return { ok: true, message: `${action} ${safe}` };
  }
  const err = (result.stderr || result.stdout || "systemctl failed").trim();
  return { ok: false, message: sanitizeSystemdError(err) };
}

export function isAllowlistedSystemdUnitName(unit: string): boolean {
  return ALLOWLISTED_SYSTEMD_UNIT_NAMES.has(unit);
}

function emptySnapshot(unit: string): SystemdUnitSnapshot {
  return {
    unit,
    loaded: false,
    activeState: "inactive",
    subState: "dead",
    mainPid: null,
    memoryCurrent: null,
    exists: false
  };
}

function parseShow(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const sep = line.indexOf("=");
    if (sep <= 0) continue;
    out[line.slice(0, sep)] = line.slice(sep + 1);
  }
  return out;
}

function parsePositiveInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseNonNegativeInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function sanitizeSystemdError(message: string): string {
  return message.replace(/[\r\n]+/g, " ").slice(0, 400);
}
