import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildChildProcessEnv } from "./config.js";
import { DesktopSupervisor } from "./supervisor.js";
import type { StartCommandSpec, SupervisorConfig } from "./types.js";
import * as health from "./health.js";
import * as processWindows from "./process-windows.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  delete process.env["DEEPSEEK_API_KEY"];
  delete process.env["DATABASE_URL"];
  delete process.env["DEEPSEEK_CHAT_MODEL"];
  delete process.env["MEM0_BASE_URL"];
});

/**
 * Platform-independent fake repo root so deriveConfigFromEnv / resolveRuntimeStart
 * keep finding scripts/dev-server-runner.ps1 after applyRuntimeConfig (not a
 * hardcoded Windows path that is missing on Ubuntu CI).
 */
function makeTempRepositoryRoot(): string {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-repo-"));
  tempDirs.push(repositoryRoot);
  const scriptsDir = path.join(repositoryRoot, "scripts");
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(
    path.join(scriptsDir, "dev-server-runner.ps1"),
    "# fixture placeholder for supervisor tests\n",
    "utf8"
  );
  return repositoryRoot;
}

function baseConfig(overrides: Partial<SupervisorConfig> = {}): SupervisorConfig {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-sup-"));
  tempDirs.push(stateDirectory);
  const { repositoryRoot: overrideRoot, ...rest } = overrides;
  const repositoryRoot =
    typeof overrideRoot === "string" && overrideRoot.length > 0
      ? overrideRoot
      : makeTempRepositoryRoot();
  return {
    layout: { mode: "development", repositoryRoot },
    repositoryRoot,
    stateDirectory,
    instanceId: "inst-1",
    ownershipToken: "tok-1",
    controlToken: "a".repeat(64),
    controlHost: "127.0.0.1",
    controlPort: 0,
    env: {
      DEEPSEEK_CHAT_MODEL: "model-A",
      DEEPSEEK_API_KEY: "key-A",
      DATABASE_URL: "postgres://yuvi:a@127.0.0.1:5432/yuvi",
      MEM0_BASE_URL: "http://127.0.0.1:6131",
      SERVER_PORT: "6121",
      SERVER_HOST: "127.0.0.1"
    },
    memoryBackend: "mem0",
    autostartRuntime: false,
    autostartMem0: false,
    autostartTts: false,
    runtimeUrl: "http://127.0.0.1:6121",
    mem0Url: "http://127.0.0.1:6131",
    ttsWrapperUrl: "http://127.0.0.1:9881",
    ttsUpstreamUrl: "http://127.0.0.1:9880",
    ollamaUrl: "http://127.0.0.1:11434",
    databaseUrl: "postgres://yuvi:a@127.0.0.1:5432/yuvi",
    // Default stub; applyRuntimeConfig re-derives via fixture scripts/ path.
    // Pass runtimeStart: null when a test wants detect-only / no start command.
    runtimeStart: {
      file: "node",
      args: ["-e", "setInterval(()=>{}, 60000)"],
      cwd: stateDirectory,
      env: { SERVER_PORT: "6121" },
      commandMarker: "node"
    } satisfies StartCommandSpec,
    mem0Start: null,
    ttsWrapperStart: null,
    ttsUpstreamStart: null,
    ...rest
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
      if (url.includes("6131")) {
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

describe("DesktopSupervisor runtime config push", () => {
  beforeEach(() => {
    // Secret changes schedule background Runtime reload — do not spawn children in unit tests.
    vi.spyOn(DesktopSupervisor.prototype, "restartService").mockImplementation(async function (
      this: DesktopSupervisor
    ) {
      return this.snapshot();
    });
  });

  it("starts with env A, applyRuntimeConfig B, resolveSpawnEnv uses B", async () => {
    process.env["DEEPSEEK_API_KEY"] = "key-A";
    process.env["DEEPSEEK_CHAT_MODEL"] = "model-A";
    const supervisor = new DesktopSupervisor(baseConfig());

    // Fixture repositoryRoot keeps startCommand resolvable before and after derive.
    expect(supervisor.resolveSpawnEnv("runtime")).not.toBeNull();
    const envA = supervisor.resolveSpawnEnv("runtime");
    expect(envA?.["DEEPSEEK_CHAT_MODEL"]).toBe("model-A");
    expect(envA?.["DEEPSEEK_API_KEY"]).toBe("key-A");

    const result = await supervisor.applyRuntimeConfig({
      env: {
        DEEPSEEK_CHAT_MODEL: "model-B",
        DEEPSEEK_API_KEY: "key-B",
        SERVER_PORT: "6121",
        SERVER_HOST: "127.0.0.1",
        MEM0_BASE_URL: "http://127.0.0.1:6131"
      },
      unsetEnv: []
    });
    expect(result.ok).toBe(true);
    expect(result.appliedEnvKeys).toContain("DEEPSEEK_CHAT_MODEL");
    expect(result.restartedServices).toContain("runtime");
    // Secret values never appear in ack.
    expect(JSON.stringify(result)).not.toContain("key-B");
    expect(JSON.stringify(result)).not.toContain("key-A");

    // deriveConfigFromEnv re-ran resolveRuntimeStart against the temp repo fixture.
    expect(supervisor.resolveSpawnEnv("runtime")).not.toBeNull();
    const envB = supervisor.resolveSpawnEnv("runtime");
    expect(envB?.["DEEPSEEK_CHAT_MODEL"]).toBe("model-B");
    expect(envB?.["DEEPSEEK_API_KEY"]).toBe("key-B");
  });

  it("base fallback A → override B → delete restores A (not stale B)", async () => {
    process.env["DEEPSEEK_API_KEY"] = "fallback-A";
    const supervisor = new DesktopSupervisor(
      baseConfig({
        env: {
          DEEPSEEK_CHAT_MODEL: "model-A",
          DEEPSEEK_API_KEY: "fallback-A",
          DATABASE_URL: "postgres://yuvi:a@127.0.0.1:5432/yuvi",
          MEM0_BASE_URL: "http://127.0.0.1:6131",
          SERVER_PORT: "6121",
          SERVER_HOST: "127.0.0.1"
        }
      })
    );
    expect(supervisor.resolveSpawnEnv("runtime")).not.toBeNull();
    expect(supervisor.resolveSpawnEnv("runtime")?.["DEEPSEEK_API_KEY"]).toBe("fallback-A");

    await supervisor.applyRuntimeConfig({
      env: { DEEPSEEK_API_KEY: "user-secret-B", DEEPSEEK_CHAT_MODEL: "model-B" },
      unsetEnv: []
    });
    expect(supervisor.resolveSpawnEnv("runtime")).not.toBeNull();
    expect(supervisor.resolveSpawnEnv("runtime")?.["DEEPSEEK_API_KEY"]).toBe("user-secret-B");
    expect(process.env["DEEPSEEK_API_KEY"]).toBe("user-secret-B");

    await supervisor.applyRuntimeConfig({
      env: { DEEPSEEK_CHAT_MODEL: "model-B", SERVER_PORT: "6121" },
      unsetEnv: ["DEEPSEEK_API_KEY"]
    });

    // Must not keep dynamic B; restore base fallback A.
    expect(supervisor.resolveSpawnEnv("runtime")).not.toBeNull();
    expect(supervisor.resolveSpawnEnv("runtime")?.["DEEPSEEK_API_KEY"]).toBe("fallback-A");
    expect(process.env["DEEPSEEK_API_KEY"]).toBe("fallback-A");
    // Live process.env pollution must not replace the resolved child map.
    process.env["DEEPSEEK_API_KEY"] = "stale-from-shell";
    expect(supervisor.resolveSpawnEnv("runtime")?.["DEEPSEEK_API_KEY"]).toBe("fallback-A");
  });

  it("delete secret with no base fallback leaves key absent (no stale B)", async () => {
    delete process.env["DEEPSEEK_API_KEY"];
    const supervisor = new DesktopSupervisor(
      baseConfig({
        env: {
          DEEPSEEK_CHAT_MODEL: "model-A",
          SERVER_PORT: "6121",
          SERVER_HOST: "127.0.0.1",
          MEM0_BASE_URL: "http://127.0.0.1:6131"
        }
      })
    );
    expect(supervisor.resolveSpawnEnv("runtime")).not.toBeNull();
    await supervisor.applyRuntimeConfig({
      env: { DEEPSEEK_API_KEY: "user-secret-B" },
      unsetEnv: []
    });
    expect(supervisor.resolveSpawnEnv("runtime")).not.toBeNull();
    expect(supervisor.resolveSpawnEnv("runtime")?.["DEEPSEEK_API_KEY"]).toBe("user-secret-B");

    await supervisor.applyRuntimeConfig({
      env: {},
      unsetEnv: ["DEEPSEEK_API_KEY"]
    });
    expect(supervisor.resolveSpawnEnv("runtime")).not.toBeNull();
    expect(supervisor.resolveSpawnEnv("runtime")?.["DEEPSEEK_API_KEY"]).toBeUndefined();
    expect(process.env["DEEPSEEK_API_KEY"]).toBeUndefined();
  });

  it("updates health probe URLs for mem0 / ollama / tts without spawn", async () => {
    const spawnSpy = vi.spyOn(processWindows, "spawnManagedProcess");
    const supervisor = new DesktopSupervisor(
      baseConfig({
        runtimeStart: null,
        mem0Start: null,
        ttsWrapperStart: null
      })
    );

    await supervisor.applyRuntimeConfig({
      env: {
        MEM0_BASE_URL: "http://127.0.0.1:6199",
        MEM0_OLLAMA_BASE_URL: "http://127.0.0.1:11999",
        GPT_SOVITS_TTS_BASE_URL: "http://127.0.0.1:9899",
        GPT_SOVITS_TTS_UPSTREAM_URL: "http://127.0.0.1:9898",
        SERVER_PORT: "6121"
      },
      unsetEnv: []
    });

    expect(supervisor.resolveHealthUrl("mem0")).toBe("http://127.0.0.1:6199/health");
    expect(supervisor.resolveHealthUrl("ollama")).toBe("http://127.0.0.1:11999/api/tags");
    expect(supervisor.resolveHealthUrl("tts_wrapper")).toBe("http://127.0.0.1:9899/health");
    expect(spawnSpy).not.toHaveBeenCalled();

    // External-only refresh must not spawn or kill.
    vi.spyOn(health, "probeHttpHealth").mockResolvedValue({
      ok: false,
      statusCode: null,
      protocolOk: false,
      message: "down",
      latencyMs: 1
    });
    vi.spyOn(health, "probeTcp").mockResolvedValue({
      ok: false,
      statusCode: null,
      protocolOk: false,
      message: "closed",
      latencyMs: 1
    });
    await supervisor.refreshAll();
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("rejects config update while shutting down", async () => {
    const supervisor = new DesktopSupervisor(baseConfig({ runtimeStart: null }));
    await supervisor.shutdown();
    await expect(
      supervisor.applyRuntimeConfig({ env: { DEEPSEEK_CHAT_MODEL: "x" }, unsetEnv: [] })
    ).rejects.toThrow(/shutting down/i);
  });

  it("external services stay unspawned when config changes", async () => {
    const spawnSpy = vi.spyOn(processWindows, "spawnManagedProcess");
    const supervisor = new DesktopSupervisor(
      baseConfig({
        runtimeStart: null,
        mem0Start: null,
        ttsWrapperStart: null,
        ttsUpstreamStart: null
      })
    );
    await supervisor.applyRuntimeConfig({
      env: {
        YUVI_AUTOSTART_RUNTIME: "false",
        YUVI_AUTOSTART_MEM0: "false",
        YUVI_AUTOSTART_TTS: "false",
        MEM0_BASE_URL: "http://127.0.0.1:6200"
      },
      unsetEnv: ["DEEPSEEK_API_KEY", "DATABASE_URL"]
    });
    expect(spawnSpy).not.toHaveBeenCalled();
    const snap = supervisor.snapshot();
    expect(snap.services.find((s) => s.id === "ollama")?.managed).toBe(false);
    expect(snap.services.find((s) => s.id === "postgres")?.managed).toBe(false);
  });

  it("status snapshot never contains secret values", async () => {
    process.env["DEEPSEEK_API_KEY"] = "sk-super-secret-value";
    const supervisor = new DesktopSupervisor(baseConfig());
    await supervisor.applyRuntimeConfig({
      env: { DEEPSEEK_API_KEY: "sk-super-secret-value", DEEPSEEK_CHAT_MODEL: "m" },
      unsetEnv: []
    });
    const text = JSON.stringify(supervisor.snapshot());
    expect(text).not.toContain("sk-super-secret-value");
    expect(text).not.toContain("DEEPSEEK_API_KEY");
  });

  it("buildChildProcessEnv deletes unset keys after merge", () => {
    const env = buildChildProcessEnv(
      { DEEPSEEK_API_KEY: "old", PATH: "/bin", SERVER_PORT: "1" },
      { SERVER_PORT: "2" },
      ["DEEPSEEK_API_KEY"]
    );
    expect(env["SERVER_PORT"]).toBe("2");
    expect(env["DEEPSEEK_API_KEY"]).toBeUndefined();
    expect(env["PATH"]).toBe("/bin");
  });
});
