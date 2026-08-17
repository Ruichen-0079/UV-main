import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyProcessQueryResult, isProcessAlive } from "./process-windows.js";

type SpawnSyncCapture = {
  command: string;
  args: readonly string[];
  options: Record<string, unknown> | undefined;
};

type SpawnSyncStubResult = {
  status: number | null;
  signal: NodeJS.Signals | string | null;
  stdout: string;
  stderr: string;
  error?: NodeJS.ErrnoException | null;
};

const processQueryState = vi.hoisted(() => ({
  calls: [] as SpawnSyncCapture[],
  result: null as SpawnSyncStubResult | null
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: ((command: string, args?: readonly string[], options?: Record<string, unknown>) => {
      if (command !== "powershell.exe") {
        return actual.spawnSync(command, args as string[] | undefined, options);
      }
      processQueryState.calls.push({ command, args: args ?? [], options });
      return processQueryState.result;
    }) as typeof actual.spawnSync
  };
});

function withWindowsPlatform<T>(run: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (!descriptor) throw new Error("process.platform descriptor is unavailable");
  Object.defineProperty(process, "platform", { ...descriptor, value: "win32" });
  try {
    return run();
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
}

function resolvedWindowsProcessOutput(processId: number): string {
  return JSON.stringify({
    processId,
    parentProcessId: 77,
    commandLine: "postgres.exe -D C:\\YUVI\\Postgres\\data",
    createdAtUtc: "2026-08-06T00:00:00.000Z",
    executablePath: "C:\\YUVI\\Postgres\\bin\\postgres.exe"
  });
}

afterEach(() => {
  processQueryState.calls = [];
  processQueryState.result = null;
});

describe("Windows process inspection result classification", () => {
  it("uses the bounded 2500 ms default for generic Windows inspection", async () => {
    const { inspectProcess } = await import("./process-windows.js");
    processQueryState.result = {
      status: 0,
      signal: null,
      stdout: resolvedWindowsProcessOutput(process.pid),
      stderr: ""
    };

    const result = withWindowsPlatform(() => inspectProcess(process.pid));

    expect(result.status).toBe("resolved");
    expect(processQueryState.calls).toHaveLength(1);
    expect(processQueryState.calls[0]?.options?.["timeout"]).toBe(2_500);
  });

  it("honors an explicit bounded Windows inspection timeout", async () => {
    const { inspectProcess } = await import("./process-windows.js");
    processQueryState.result = {
      status: 0,
      signal: null,
      stdout: resolvedWindowsProcessOutput(process.pid),
      stderr: ""
    };

    const result = withWindowsPlatform(() =>
      inspectProcess(process.pid, { windowsQueryTimeoutMs: 10_000 })
    );

    expect(result.status).toBe("resolved");
    expect(processQueryState.calls[0]?.options?.["timeout"]).toBe(10_000);
  });

  it("normalizes invalid inspection budgets without removing the bound", async () => {
    const { inspectProcess } = await import("./process-windows.js");
    processQueryState.result = {
      status: 0,
      signal: null,
      stdout: resolvedWindowsProcessOutput(process.pid),
      stderr: ""
    };

    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0]) {
      withWindowsPlatform(() => inspectProcess(process.pid, { windowsQueryTimeoutMs: value }));
    }
    withWindowsPlatform(() =>
      inspectProcess(process.pid, { windowsQueryTimeoutMs: Number.MAX_SAFE_INTEGER })
    );

    expect(processQueryState.calls.slice(0, 4).map((call) => call.options?.["timeout"])).toEqual([
      2_500, 2_500, 2_500, 2_500
    ]);
    expect(processQueryState.calls[4]?.options?.["timeout"]).toBe(10_000);
  });

  it("keeps a Windows query timeout classified as unavailable", async () => {
    const { inspectProcess } = await import("./process-windows.js");
    processQueryState.result = {
      status: null,
      signal: "SIGTERM",
      stdout: "",
      stderr: "",
      error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })
    };

    const result = withWindowsPlatform(() =>
      inspectProcess(process.pid, { windowsQueryTimeoutMs: 10_000 })
    );

    expect(result).toEqual({
      status: "unavailable",
      processId: process.pid,
      reason: "query-timeout"
    });
  });

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
    expect(classifyProcessQueryResult(1234, { status: 7, stdout: "", signal: null })).toMatchObject(
      { status: "unavailable", reason: "query-failed" }
    );
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
