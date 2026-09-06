import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  classifyProcessQueryResult,
  forceKillProcessTree,
  isProcessAlive,
  ownedUnixProcessGroup,
  requestGracefulStop,
  spawnManagedProcess
} from "./process-windows.js";

describe("Windows process inspection result classification", () => {
  it("keeps a live-process timeout as unavailable", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    const result = classifyProcessQueryResult(1234, {
      status: null,
      signal: "SIGTERM",
      error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })
    });
    expect(result).toEqual({
      status: "unavailable",
      processId: 1234,
      reason: "query-timeout"
    });
  });

  it("classifies a nonzero PowerShell result as query-failed", () => {
    expect(
      classifyProcessQueryResult(1234, { status: 7, stdout: "", signal: null })
    ).toMatchObject({ status: "unavailable", reason: "query-failed" });
  });

  it("classifies empty output as unavailable", () => {
    expect(
      classifyProcessQueryResult(1234, { status: 0, stdout: "  ", signal: null })
    ).toMatchObject({ status: "unavailable", reason: "empty-output" });
  });

  it("classifies malformed JSON as parse-failed", () => {
    expect(
      classifyProcessQueryResult(1234, { status: 0, stdout: "not-json", signal: null })
    ).toMatchObject({ status: "unavailable", reason: "parse-failed" });
  });

  it("accepts a complete resolved process record", () => {
    const result = classifyProcessQueryResult(1234, {
      status: 0,
      signal: null,
      stdout: JSON.stringify({
        processId: 1234,
        parentProcessId: 77,
        commandLine: "yuvi-mem0.exe",
        createdAtUtc: "2026-08-06T00:00:00.000Z"
      })
    });
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.info.commandLine).toBe("yuvi-mem0.exe");
      expect(result.info.parentProcessId).toBe(77);
    }
  });
});

describe.skipIf(process.platform === "win32")("Unix owned process tree", () => {
  function waitDead(pid: number, ms = 3_000): Promise<void> {
    const deadline = Date.now() + ms;
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (!isProcessAlive(pid)) {
          resolve();
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error(`pid ${pid} still alive`));
          return;
        }
        setTimeout(tick, 40);
      };
      tick();
    });
  }

  it("graceful stop reaps the spawned process group after a wrapper-style exec tree", async () => {
    const child = spawnManagedProcess(
      {
        file: "sh",
        args: ["-c", "sleep 30 & sleep 30 & wait"],
        cwd: process.cwd(),
        env: {},
        commandMarker: "sleep"
      },
      { out: "/dev/null", err: "/dev/null" }
    );
    const pid = child.pid;
    expect(pid).toBeTruthy();
    expect(ownedUnixProcessGroup(pid!)).toBe(pid);
    requestGracefulStop(pid!);
    await waitDead(pid!);
    expect(isProcessAlive(pid!)).toBe(false);
  });

  it("force-kill reaps a term-ignoring descendant tree", async () => {
    const child = spawnManagedProcess(
      {
        file: "sh",
        args: ["-c", "trap '' TERM; sleep 30 & wait"],
        cwd: process.cwd(),
        env: {},
        commandMarker: "sleep"
      },
      { out: "/dev/null", err: "/dev/null" }
    );
    const pid = child.pid;
    expect(pid).toBeTruthy();
    forceKillProcessTree(pid!);
    await waitDead(pid!);
    expect(isProcessAlive(pid!)).toBe(false);
  });

  it("never signals a foreign pid that is not the owned group leader", () => {
    const foreign = spawn("sleep", ["30"], { stdio: "ignore" });
    const foreignPid = foreign.pid!;
    try {
      expect(ownedUnixProcessGroup(process.pid)).toBeNull();
      expect(isProcessAlive(foreignPid)).toBe(true);
      expect(ownedUnixProcessGroup(foreignPid) === foreignPid || ownedUnixProcessGroup(foreignPid) === null).toBe(
        true
      );
    } finally {
      foreign.kill("SIGKILL");
    }
  });
});
