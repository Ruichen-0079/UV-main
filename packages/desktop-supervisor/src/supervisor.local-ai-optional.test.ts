import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalAiManagerConfig } from "./local-ai/types.js";
import type { SupervisorConfig } from "./types.js";

const { probeBinaryMock, probeJsonMock, showAllowlistedUnitMock } = vi.hoisted(() => ({
  probeBinaryMock: vi.fn(),
  probeJsonMock: vi.fn(),
  showAllowlistedUnitMock: vi.fn()
}));

vi.mock("./local-ai/http.js", () => ({
  originOf: (url: string) => {
    try {
      const parsed = new URL(url.includes("://") ? url : `http://${url}`);
      return {
        host: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : 80,
        origin: `${parsed.protocol}//${parsed.host}`
      };
    } catch {
      return null;
    }
  },
  probeBinary: probeBinaryMock,
  probeJson: probeJsonMock
}));

vi.mock("./local-ai/systemd.js", () => ({
  controlAllowlistedUnit: vi.fn(() => ({ ok: false, message: "systemd unavailable" })),
  isAllowlistedSystemdUnitName: vi.fn(() => true),
  isSystemdUserAvailable: vi.fn(() => false),
  showAllowlistedUnit: showAllowlistedUnitMock
}));

import * as health from "./health.js";
import { LocalAiServiceManager } from "./local-ai/manager.js";
import { DesktopSupervisor } from "./supervisor.js";

const tempDirs: string[] = [];
const supervisors = new Set<DesktopSupervisor>();

beforeEach(() => {
  probeBinaryMock.mockReset();
  probeJsonMock.mockReset();
  showAllowlistedUnitMock.mockReset();
  probeJsonMock.mockResolvedValue({
    ok: false,
    statusCode: null,
    latencyMs: 1,
    body: null,
    message: "service unavailable"
  });
  vi.spyOn(health, "probeHttpHealth").mockImplementation(async (url) =>
    url.includes(":6121")
      ? { ok: true, statusCode: 200, protocolOk: true, message: "healthy", latencyMs: 1 }
      : {
          ok: false,
          statusCode: null,
          protocolOk: false,
          message: "service unavailable",
          latencyMs: 1
        }
  );
  vi.spyOn(health, "probeTcp").mockResolvedValue({
    ok: false,
    statusCode: null,
    protocolOk: false,
    message: "service unavailable",
    latencyMs: 1
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all([...supervisors].map((supervisor) => supervisor.shutdown()));
  supervisors.clear();
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function localAiConfig(): LocalAiManagerConfig {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-local-ai-optional-"));
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-local-ai-repo-"));
  tempDirs.push(stateDirectory, repositoryRoot);
  return {
    repositoryRoot,
    stateDirectory,
    instanceId: "local-ai-optional",
    ownershipToken: "local-ai-optional-token",
    env: {},
    ttsWrapperUrl: "http://127.0.0.1:9881",
    ttsUpstreamUrl: "http://127.0.0.1:9880",
    embeddingUrl: "http://127.0.0.1:8128/v1",
    embeddingApiKey: null,
    embeddingModel: null,
    embeddingDimensions: 512,
    sttUrl: "http://127.0.0.1:9876",
    sttPython: null,
    sttScript: null,
    sttModelDir: path.join(stateDirectory, "models"),
    localLlmUrl: null,
    localLlmSystemdUnit: null
  };
}

function supervisorConfig(): SupervisorConfig {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-supervisor-optional-"));
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-supervisor-repo-"));
  tempDirs.push(stateDirectory, repositoryRoot);
  return {
    layout: { mode: "development", repositoryRoot },
    repositoryRoot,
    stateDirectory,
    instanceId: "supervisor-optional",
    ownershipToken: "supervisor-optional-token",
    controlToken: "a".repeat(64),
    controlHost: "127.0.0.1",
    controlPort: 0,
    env: {
      SERVER_HOST: "127.0.0.1",
      SERVER_PORT: "6121",
      MEMORY_BACKEND: "legacy",
      MEM0_BASE_URL: "http://127.0.0.1:6131"
    },
    memoryBackend: "legacy",
    autostartRuntime: true,
    autostartMem0: false,
    autostartTts: false,
    runtimeUrl: "http://127.0.0.1:6121",
    mem0Url: "http://127.0.0.1:6131",
    ttsWrapperUrl: "http://127.0.0.1:9881",
    ttsUpstreamUrl: "http://127.0.0.1:9880",
    ollamaUrl: "http://127.0.0.1:11434",
    databaseUrl: null,
    runtimeStart: null,
    mem0Start: null,
    ttsWrapperStart: null,
    ttsUpstreamStart: null,
    postgresMode: "external"
  };
}

describe("LocalAiServiceManager on Windows without systemd", () => {
  it("keeps Alice, embedding, and STT unavailable without blocking discovery", async () => {
    const manager = new LocalAiServiceManager(localAiConfig());

    const snapshot = await manager.refreshAll();
    const services = new Map(snapshot.services.map((service) => [service.id, service]));

    expect(services.get("alice")?.lifecycle).toBe("STOPPED");
    expect(services.get("alice")?.ownership).toBe("none");
    expect(services.get("alice.upstream")?.startPolicy).toBe("ALWAYS");
    expect(services.get("alice.wrapper")?.startPolicy).toBe("ALWAYS");
    expect(services.get("embedding")?.lifecycle).toBe("STOPPED");
    expect(services.get("embedding")?.startPolicy).toBe("ALWAYS");
    expect(services.get("stt")?.lifecycle).toBe("STOPPED");
    expect(services.get("stt")?.startPolicy).toBe("ON_DEMAND");
    expect(showAllowlistedUnitMock).not.toHaveBeenCalled();
  });

  it("keeps one refresh failure visible as ERROR and continues the catalog refresh", async () => {
    probeJsonMock.mockImplementationOnce(async () => {
      throw new Error("optional probe failed");
    });
    const manager = new LocalAiServiceManager(localAiConfig());

    const snapshot = await manager.refreshAll();
    const services = new Map(snapshot.services.map((service) => [service.id, service]));

    expect(services.get("alice.upstream")?.lifecycle).toBe("ERROR");
    expect(services.get("alice.upstream")?.lastError).toBe("optional probe failed");
    expect(services.get("embedding")?.lifecycle).toBe("STOPPED");
    expect(services.get("stt")?.lifecycle).toBe("STOPPED");
  });
});

describe("DesktopSupervisor optional Local AI bootstrap", () => {
  it("lets core Runtime bootstrap complete when Local AI refresh fails", async () => {
    const supervisor = new DesktopSupervisor(supervisorConfig());
    supervisors.add(supervisor);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const refresh = vi
      .spyOn(supervisor.localAi, "refreshAll")
      .mockRejectedValue(new Error("optional refresh failed"));

    const snapshot = await supervisor.bootstrap();
    const runtime = snapshot.services.find((service) => service.id === "runtime");

    expect(runtime?.status).toBe("healthy");
    expect(refresh).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("optional refresh failed"));
  });

  it("does not wait for a hung Local AI refresh", async () => {
    vi.useFakeTimers();
    const supervisor = new DesktopSupervisor(supervisorConfig());
    supervisors.add(supervisor);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(supervisor.localAi, "refreshAll").mockImplementation(
      () => new Promise(() => undefined)
    );

    const snapshot = await supervisor.bootstrap();
    expect(snapshot.services.find((service) => service.id === "runtime")?.status).toBe("healthy");

    await vi.advanceTimersByTimeAsync(15_000);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("timed out"));
  });
});
