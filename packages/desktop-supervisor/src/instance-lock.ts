import fs from "node:fs";
import path from "node:path";
import { isProcessAlive } from "./process-windows.js";

export const SUPERVISOR_INSTANCE_LOCK_FILE = "supervisor.instance.lock";

export class SupervisorInstanceLockError extends Error {
  readonly holderPid: number | null;

  constructor(message: string, holderPid: number | null = null) {
    super(message);
    this.name = "SupervisorInstanceLockError";
    this.holderPid = holderPid;
  }
}

export type SupervisorInstanceLock = {
  lockPath: string;
  release: () => void;
};

/**
 * Exclusive lock under the shared DesktopSupervisor pointer root so one
 * desktop owner cannot silently start a second competing Supervisor.
 * Stale dead-pid files are recovered; a live foreign holder is not stolen.
 */
export function acquireSupervisorInstanceLock(pointerRoot: string): SupervisorInstanceLock {
  fs.mkdirSync(pointerRoot, { recursive: true });
  const lockPath = path.join(pointerRoot, SUPERVISOR_INSTANCE_LOCK_FILE);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.writeFileSync(
        lockPath,
        `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 }
      );
      return { lockPath, release: () => releaseLockFile(lockPath, process.pid) };
    } catch (error) {
      if (error instanceof SupervisorInstanceLockError) throw error;
      let stale = false;
      try {
        const raw = fs.readFileSync(lockPath, "utf8");
        const data = JSON.parse(raw) as { pid?: unknown };
        const holder = Number(data?.pid);
        if (!Number.isFinite(holder) || holder <= 0 || !isProcessAlive(holder)) {
          stale = true;
        } else if (holder === process.pid) {
          return { lockPath, release: () => releaseLockFile(lockPath, process.pid) };
        } else {
          throw new SupervisorInstanceLockError(
            `Another YUVI Supervisor is already running (pid ${holder}). Close other YUVI windows/installs, then retry.`,
            holder
          );
        }
      } catch (inner) {
        if (inner instanceof SupervisorInstanceLockError) throw inner;
        stale = true;
      }
      if (stale) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // retry wx create
        }
      }
    }
  }
  throw new SupervisorInstanceLockError("Unable to acquire Supervisor instance lock.");
}

function releaseLockFile(lockPath: string, pid: number): void {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const data = JSON.parse(raw) as { pid?: unknown };
    if (data?.pid === pid) fs.unlinkSync(lockPath);
  } catch {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // ignore
    }
  }
}
