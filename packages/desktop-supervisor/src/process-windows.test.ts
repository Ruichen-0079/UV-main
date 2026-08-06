import { describe, expect, it } from "vitest";
import { classifyProcessQueryResult, isProcessAlive } from "./process-windows.js";

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
