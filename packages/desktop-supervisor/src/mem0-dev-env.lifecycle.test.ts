import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopSupervisor } from "./supervisor.js";
import type { StartCommandSpec, SupervisorConfig } from "./types.js";
import * as processWindows from "./process-windows.js";
import * as health from "./health.js";

const tempDirs: string[] = [];
const supervisors = new Set<DesktopSupervisor>();
let spawnCount = 0;

function baseConfig(stateDirectory: string, rest: Partial<SupervisorConfig> = {}): SupervisorConfig {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-mem0-life-"));
  tempDirs.push(repositoryRoot);
  return {
    layout: { mode: "development", repositoryRoot },
    repositoryRoot,
    stateDirectory,
    instanceId: "inst-mem0-env",
    ownershipToken: "tok-mem0-env",
    controlToken: "b".repeat(64),
    controlHost: "127.0.0.1",
    controlPort: 0,
    env: {},
    memoryBackend: "mem0",
    autostartRuntime: false,
    autostartMem0: true,
    autostartTts: false,
    runtimeUrl: "http://127.0.0.1:6121",
    mem0Url: "http://127.0.0.1:6131",
    ttsWrapperUrl: "http://127.0.0.1:9881",
    ttsUpstreamUrl: "http://127.0.0.1:9880",
    ollamaUrl: "http://127.0.0.1:11434",
    databaseUrl: null,
    runtimeStart: null,
    mem0Start: null,
    mem0StartError:
      "Mem0 development environment not installed/invalid (missing services/memory-mem0/.venv/bin/python). " +
      'Create services/memory-mem0/.venv with Python 3.11 and run: pip install -e ".[dev]"',
    ttsWrapperStart: null,
    ttsUpstreamStart: null,
    ...rest
  };
}

beforeEach(() => {
  spawnCount = 0;
  vi.spyOn(processWindows, "spawnManagedProcess").mockImplementation(() => {
    spawnCount += 1;
    throw new Error("should not spawn Mem0 when development env is invalid");
  });
  vi.spyOn(health, "probeHttpHealth").mockResolvedValue({
    ok: false,
    statusCode: null,
    latencyMs: 1,
    protocolOk: false,
    message: "connection refused"
  });
});

afterEach(async () => {
  await Promise.allSettled([...supervisors].map((s) => s.shutdown()));
  supervisors.clear();
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Mem0 development env fail-closed lifecycle", () => {
  it("exposes unavailable actionable state without spawning", async () => {
    const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-mem0-state-"));
    tempDirs.push(stateDirectory);
    const supervisor = new DesktopSupervisor(baseConfig(stateDirectory));
    supervisors.add(supervisor);
    await supervisor.bootstrap();
    const mem0 = supervisor.snapshot().services.find((s) => s.id === "mem0");
    expect(mem0?.status).toBe("unavailable");
    expect(mem0?.lastError).toMatch(/Mem0 development environment not installed\/invalid/i);
    expect(mem0?.ownership).toBe("none");
    expect(spawnCount).toBe(0);
  });

  it("does not infinite-respawn on refreshAll when env preflight failed", async () => {
    const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-mem0-state-"));
    tempDirs.push(stateDirectory);
    const supervisor = new DesktopSupervisor(baseConfig(stateDirectory));
    supervisors.add(supervisor);
    await supervisor.bootstrap();
    await supervisor.refreshAll();
    await supervisor.refreshAll();
    await supervisor.refreshAll();
    const mem0 = supervisor.snapshot().services.find((s) => s.id === "mem0");
    expect(mem0?.status).toBe("unavailable");
    expect(spawnCount).toBe(0);
  });

  it("starts from a valid Linux venv start command and stops owned process", async () => {
    const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-mem0-state-"));
    tempDirs.push(stateDirectory);
    const child = {
      pid: 424242,
      killed: false,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      once: vi.fn(),
      kill: vi.fn()
    };
    vi.spyOn(processWindows, "spawnManagedProcess").mockImplementation(() => {
      spawnCount += 1;
      return child as never;
    });
    vi.spyOn(processWindows, "inspectProcess").mockReturnValue({
      status: "resolved",
      info: {
        processId: 424242,
        createdAtUtc: new Date("2026-01-01T00:00:00.000Z"),
        executablePath: "/tmp/python",
        commandLine: "python -m yuvi_mem0"
      }
    } as never);
    vi.spyOn(processWindows, "requestGracefulStop").mockImplementation(() => undefined);
    vi.spyOn(processWindows, "forceKillProcessTree").mockImplementation(() => undefined);
    vi.spyOn(processWindows, "isProcessAlive").mockReturnValue(false);
    vi.spyOn(health, "probeHttpHealth").mockImplementation(async () => {
      if (spawnCount === 0) {
        return {
          ok: false,
          statusCode: null,
          latencyMs: 1,
          protocolOk: false,
          message: "connection refused"
        };
      }
      return {
        ok: true,
        statusCode: 200,
        latencyMs: 2,
        protocolOk: true,
        message: "ok"
      };
    });

    const mem0Start: StartCommandSpec = {
      file: "/repo/services/memory-mem0/.venv/bin/python",
      args: ["-m", "yuvi_mem0"],
      cwd: "/repo/services/memory-mem0",
      env: { PYTHONPATH: "src", MEM0_SIDECAR_PORT: "6131", MEM0_SIDECAR_HOST: "127.0.0.1" },
      commandMarker: "yuvi_mem0"
    };
    const supervisor = new DesktopSupervisor(
      baseConfig(stateDirectory, { mem0Start, mem0StartError: null, autostartMem0: true })
    );
    supervisors.add(supervisor);
    await supervisor.bootstrap();
    const started = supervisor.snapshot().services.find((s) => s.id === "mem0");
    expect(spawnCount).toBe(1);
    expect(started?.ownership).toBe("owned");
    expect(started?.status).toBe("healthy");

    expect(started?.pid).toBe(424242);
    await supervisor.shutdown();
    expect(child.kill).toHaveBeenCalled();
    const after = supervisor.snapshot().services.find((s) => s.id === "mem0");
    expect(after?.ownership).toBe("none");
  });
});
