import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopSupervisor } from "./supervisor.js";
import type { SupervisorConfig } from "./types.js";
import * as health from "./health.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function baseConfig(overrides: Partial<SupervisorConfig> = {}): SupervisorConfig {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-sup-"));
  tempDirs.push(stateDirectory);
  return {
    repositoryRoot: "C:\\Dev\\UV-main",
    stateDirectory,
    instanceId: "inst-1",
    ownershipToken: "tok-1",
    controlToken: "a".repeat(64),
    controlHost: "127.0.0.1",
    controlPort: 0,
    env: {},
    memoryBackend: "mem0",
    autostartRuntime: false,
    autostartMem0: false,
    autostartTts: false,
    runtimeUrl: "http://127.0.0.1:6121",
    mem0Url: "http://127.0.0.1:6130",
    ttsWrapperUrl: "http://127.0.0.1:9881",
    ttsUpstreamUrl: "http://127.0.0.1:9880",
    ollamaUrl: "http://127.0.0.1:11434",
    databaseUrl: "postgres://yuvi:x@127.0.0.1:5432/yuvi",
    runtimeStart: null,
    mem0Start: null,
    ttsWrapperStart: null,
    ttsUpstreamStart: null,
    ...overrides
  };
}

describe("DesktopSupervisor classification", () => {
  it("marks healthy runtime without metadata as external", async () => {
    vi.spyOn(health, "probeHttpHealth").mockImplementation(async (url) => {
      if (url.includes("6121")) {
        return {
          ok: true,
          statusCode: 200,
          protocolOk: true,
          message: "healthy",
          latencyMs: 5
        };
      }
      return {
        ok: false,
        statusCode: null,
        protocolOk: false,
        message: "down",
        latencyMs: 1
      };
    });
    vi.spyOn(health, "probeTcp").mockResolvedValue({
      ok: true,
      statusCode: null,
      protocolOk: true,
      message: "tcp open",
      latencyMs: 1
    });

    const supervisor = new DesktopSupervisor(baseConfig());
    await supervisor.refreshAll();
    const runtime = supervisor.snapshot().services.find((s) => s.id === "runtime");
    expect(runtime?.status).toBe("healthy");
    expect(runtime?.ownership).toBe("external");
    expect(runtime?.canStop).toBe(false);
    vi.restoreAllMocks();
  });

  it("marks protocol mismatch as unavailable without taking ownership", async () => {
    vi.spyOn(health, "probeHttpHealth").mockImplementation(async (url) => {
      if (url.includes("6121")) {
        return {
          ok: false,
          statusCode: 200,
          protocolOk: false,
          message: "port responds but protocol mismatch",
          latencyMs: 3
        };
      }
      return {
        ok: false,
        statusCode: null,
        protocolOk: false,
        message: "down",
        latencyMs: 1
      };
    });
    vi.spyOn(health, "probeTcp").mockResolvedValue({
      ok: false,
      statusCode: null,
      protocolOk: false,
      message: "closed",
      latencyMs: 1
    });

    const supervisor = new DesktopSupervisor(baseConfig());
    await supervisor.refreshAll();
    const runtime = supervisor.snapshot().services.find((s) => s.id === "runtime");
    expect(runtime?.status).toBe("unavailable");
    expect(runtime?.ownership).toBe("none");
    expect(runtime?.summary).toMatch(/unexpected/i);
    vi.restoreAllMocks();
  });

  it("mem0 failure does not remove runtime from snapshot", async () => {
    vi.spyOn(health, "probeHttpHealth").mockImplementation(async (url) => {
      if (url.includes("6121")) {
        return { ok: true, statusCode: 200, protocolOk: true, message: "ok", latencyMs: 1 };
      }
      if (url.includes("6130")) {
        return { ok: false, statusCode: null, protocolOk: false, message: "mem0 down", latencyMs: 1 };
      }
      return { ok: false, statusCode: null, protocolOk: false, message: "down", latencyMs: 1 };
    });
    vi.spyOn(health, "probeTcp").mockResolvedValue({
      ok: true,
      statusCode: null,
      protocolOk: true,
      message: "tcp open",
      latencyMs: 1
    });

    const supervisor = new DesktopSupervisor(baseConfig());
    await supervisor.refreshAll();
    const snap = supervisor.snapshot();
    expect(snap.services.find((s) => s.id === "runtime")?.status).toBe("healthy");
    expect(snap.services.find((s) => s.id === "mem0")?.status).toBe("stopped");
    vi.restoreAllMocks();
  });

  it("marks protocol-mismatched HTTP as unavailable (not external/owned)", async () => {
    vi.spyOn(health, "probeHttpHealth").mockImplementation(async (url) => {
      if (url.includes("6121")) {
        return {
          ok: false,
          statusCode: 200,
          protocolOk: false,
          message: "port responds but protocol mismatch",
          latencyMs: 2
        };
      }
      return { ok: false, statusCode: null, protocolOk: false, message: "down", latencyMs: 1 };
    });
    vi.spyOn(health, "probeTcp").mockResolvedValue({
      ok: false,
      statusCode: null,
      protocolOk: false,
      message: "closed",
      latencyMs: 1
    });
    const supervisor = new DesktopSupervisor(baseConfig());
    await supervisor.refreshAll();
    const runtime = supervisor.snapshot().services.find((s) => s.id === "runtime");
    expect(runtime?.status).toBe("unavailable");
    expect(runtime?.ownership).toBe("none");
    expect(runtime?.canStop).toBe(false);
  });

  it("stopService refuses external processes", async () => {
    vi.spyOn(health, "probeHttpHealth").mockResolvedValue({
      ok: true,
      statusCode: 200,
      protocolOk: true,
      message: "ok",
      latencyMs: 1
    });
    vi.spyOn(health, "probeTcp").mockResolvedValue({
      ok: true,
      statusCode: null,
      protocolOk: true,
      message: "tcp open",
      latencyMs: 1
    });
    const supervisor = new DesktopSupervisor(baseConfig());
    await supervisor.refreshAll();
    await supervisor.stopService("runtime");
    const runtime = supervisor.snapshot().services.find((s) => s.id === "runtime");
    expect(runtime?.lastError).toMatch(/external/i);
    expect(runtime?.status).toBe("healthy");
    vi.restoreAllMocks();
  });
});
