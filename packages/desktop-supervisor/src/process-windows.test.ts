import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyProcessQueryResult,
  inspectWindowsProcessIdentity,
  isProcessAlive,
  WINDOWS_NATIVE_PROCESS_IDENTITY_MAX_OUTPUT_CHARS,
  WINDOWS_NATIVE_PROCESS_IDENTITY_TIMEOUT_MS
} from "./process-windows.js";

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
      if (command !== "powershell.exe" && !String(command).endsWith("yuvi-process-identity.exe")) {
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

function resolvedNativeProcessOutput(processId: number): string {
  return JSON.stringify({
    protocol: 1,
    status: "RESOLVED",
    processId,
    executablePath: "C:\\YUVI\\Postgres\\bin\\postgres.exe",
    startedAtUtc: "2026-08-06T00:00:00.000Z"
  });
}

afterEach(() => {
  processQueryState.calls = [];
  processQueryState.result = null;
});

describe("Windows process inspection result classification", () => {
  it("runs the bounded native identity helper with no secret-bearing execution data", () => {
    processQueryState.result = {
      status: 0,
      signal: null,
      stdout: resolvedNativeProcessOutput(process.pid),
      stderr: ""
    };

    const result = withWindowsPlatform(() =>
      inspectWindowsProcessIdentity(process.pid, "C:\\YUVI\\native\\yuvi-process-identity.exe")
    );

    expect(result).toMatchObject({
      status: "RESOLVED",
      processId: process.pid,
      processIdMatches: true,
      executablePath: "C:\\YUVI\\Postgres\\bin\\postgres.exe",
      startedAtUtc: "2026-08-06T00:00:00.000Z"
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(processQueryState.calls).toHaveLength(1);
    const call = processQueryState.calls[0];
    expect(call?.command).toBe("C:\\YUVI\\native\\yuvi-process-identity.exe");
    expect(call?.args).toEqual([String(process.pid)]);
    expect(call?.options?.["shell"]).toBe(false);
    expect(call?.options?.["timeout"]).toBe(WINDOWS_NATIVE_PROCESS_IDENTITY_TIMEOUT_MS);
    expect(call?.options?.["maxBuffer"]).toBe(WINDOWS_NATIVE_PROCESS_IDENTITY_MAX_OUTPUT_CHARS);
    expect(call?.options?.["env"]).toEqual({});
  });

  it("classifies native timeout, process failure, empty, malformed, and oversize output safely", () => {
    const cases = [
      [
        {
          status: null,
          signal: "SIGTERM" as const,
          stdout: "",
          stderr: "",
          error: Object.assign(new Error(), { code: "ETIMEDOUT" })
        },
        "TIMEOUT"
      ],
      [{ status: 5, signal: null, stdout: "", stderr: "" }, "EXIT_NONZERO"],
      [{ status: 0, signal: null, stdout: "", stderr: "" }, "EMPTY_OUTPUT"],
      [{ status: 0, signal: null, stdout: "not-json", stderr: "" }, "PARSE_FAILED"],
      [
        {
          status: 0,
          signal: null,
          stdout: resolvedNativeProcessOutput(process.pid),
          stderr: "unexpected diagnostic"
        },
        "PARSE_FAILED"
      ],
      [
        {
          status: 0,
          signal: null,
          stdout: "x".repeat(WINDOWS_NATIVE_PROCESS_IDENTITY_MAX_OUTPUT_CHARS + 1),
          stderr: ""
        },
        "OVERSIZE_OUTPUT"
      ]
    ] as const;
    for (const [result, status] of cases) {
      processQueryState.result = result;
      expect(
        withWindowsPlatform(() =>
          inspectWindowsProcessIdentity(process.pid, "C:\\YUVI\\native\\yuvi-process-identity.exe")
        )
      ).toMatchObject({ status, processId: process.pid });
    }
  });

  it("rejects helper records with extra fields, non-UTC time, or a wrong PID", () => {
    processQueryState.result = {
      status: 0,
      signal: null,
      stdout: JSON.stringify({
        protocol: 1,
        status: "RESOLVED",
        processId: process.pid + 1,
        executablePath: "C:\\YUVI\\Postgres\\bin\\postgres.exe",
        startedAtUtc: "2026-08-06T00:00:00.000Z",
        commandLine: "secret"
      }),
      stderr: ""
    };
    const extra = withWindowsPlatform(() =>
      inspectWindowsProcessIdentity(process.pid, "C:\\YUVI\\native\\yuvi-process-identity.exe")
    );
    expect(extra.status).toBe("PARSE_FAILED");

    processQueryState.result = {
      status: 0,
      signal: null,
      stdout: JSON.stringify({
        protocol: 1,
        status: "RESOLVED",
        processId: process.pid + 1,
        executablePath: "C:\\YUVI\\Postgres\\bin\\postgres.exe",
        startedAtUtc: "2026-08-06T00:00:00.000+00:00"
      }),
      stderr: ""
    };
    const wrongTime = withWindowsPlatform(() =>
      inspectWindowsProcessIdentity(process.pid, "C:\\YUVI\\native\\yuvi-process-identity.exe")
    );
    expect(wrongTime.status).toBe("PARSE_FAILED");

    processQueryState.result = {
      status: 0,
      signal: null,
      stdout: resolvedNativeProcessOutput(process.pid + 1),
      stderr: ""
    };
    const wrongPid = withWindowsPlatform(() =>
      inspectWindowsProcessIdentity(process.pid, "C:\\YUVI\\native\\yuvi-process-identity.exe")
    );
    expect(wrongPid).toMatchObject({ status: "RESOLVED", processIdMatches: false });
  });

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
    expect(processQueryState.calls[0]?.command).toBe("powershell.exe");
    expect(processQueryState.calls[0]?.command).not.toContain("yuvi-process-identity.exe");
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
