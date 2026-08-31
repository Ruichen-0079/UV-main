import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalAiManagerConfig } from "./types.js";

const tempDirs: string[] = [];
const controlLog: string[] = [];
let running = false;
let inflight = 0;
let maxInflight = 0;

vi.mock("./http.js", () => ({
  originOf: (url: string) => {
    try {
      const parsed = new URL(url.includes("://") ? url : `http://${url}`);
      const port = parsed.port ? Number(parsed.port) : 80;
      return { host: parsed.hostname, port, origin: `${parsed.protocol}//${parsed.host}` };
    } catch {
      return null;
    }
  },
  probeBinary: vi.fn(),
  probeJson: vi.fn(async () => {
    inflight += 1;
    maxInflight = Math.max(maxInflight, inflight);
    await new Promise((resolve) => setTimeout(resolve, 20));
    inflight -= 1;
    return {
      ok: running,
      statusCode: running ? 200 : null,
      latencyMs: 20,
      body: running ? { status: "ok" } : null,
      message: running ? "ok" : "down"
    };
  })
}));

vi.mock("./systemd.js", () => ({
  isSystemdUserAvailable: () => true,
  showAllowlistedUnit: (unit: string) => ({
    unit,
    loaded: true,
    exists: true,
    activeState: running ? "active" : "inactive",
    subState: running ? "running" : "dead",
    mainPid: running ? 4242 : null,
    memoryCurrent: running ? 1024 : null
  }),
  controlAllowlistedUnit: (_unit: string, action: "start" | "stop" | "restart") => {
    inflight += 1;
    maxInflight = Math.max(maxInflight, inflight);
    controlLog.push(`begin:${action}`);
    if (action === "start" || action === "restart") running = true;
    if (action === "stop") running = false;
    controlLog.push(`end:${action}`);
    inflight -= 1;
    return { ok: true, message: action };
  },
  isAllowlistedSystemdUnitName: () => true
}));

const { LocalAiServiceManager } = await import("./manager.js");

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  controlLog.length = 0;
  running = false;
  inflight = 0;
  maxInflight = 0;
});

function cfg(): LocalAiManagerConfig {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-local-ai-conc-"));
  tempDirs.push(stateDirectory);
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-repo-conc-"));
  tempDirs.push(repositoryRoot);
  return {
    repositoryRoot,
    stateDirectory,
    instanceId: "inst-conc",
    ownershipToken: "own-conc",
    env: {},
    ttsWrapperUrl: "http://127.0.0.1:65530",
    ttsUpstreamUrl: "http://127.0.0.1:65531",
    embeddingUrl: "http://127.0.0.1:65532/v1",
    embeddingApiKey: "test-key",
    embeddingModel: "Qwen3-Embedding-0.6B-Q8_0.gguf",
    embeddingDimensions: 512,
    sttUrl: "http://127.0.0.1:65533",
    sttPython: null,
    sttScript: null,
    sttModelDir: path.join(stateDirectory, "models"),
    localLlmUrl: null,
    localLlmSystemdUnit: null
  };
}

describe("LocalAiServiceManager start/stop/restart serialization", () => {
  it("runs concurrent start then stop without overlapping work", async () => {
    const manager = new LocalAiServiceManager(cfg());
    const started = manager.start("embedding");
    const stopped = manager.stop("embedding");
    const [startResult, stopResult] = await Promise.all([started, stopped]);
    expect(startResult.ok).toBe(true);
    expect(stopResult.ok).toBe(true);
    expect(maxInflight).toBe(1);
    expect(controlLog).toEqual(["begin:start", "end:start", "begin:stop", "end:stop"]);
    expect(manager.getService("embedding").lifecycle).toBe("STOPPED");
  });

  it("does not start twice when two starts race", async () => {
    const manager = new LocalAiServiceManager(cfg());
    const [first, second] = await Promise.all([manager.start("embedding"), manager.start("embedding")]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(controlLog.filter((item) => item === "begin:start")).toHaveLength(1);
    expect(maxInflight).toBe(1);
    expect(manager.getService("embedding").lifecycle).toBe("READY");
  });

  it("serializes Alice child start/stop through the family lock", async () => {
    const manager = new LocalAiServiceManager(cfg());
    const [upstream, wrapper] = await Promise.all([
      manager.start("alice.upstream"),
      manager.stop("alice.wrapper")
    ]);
    expect(upstream.ok).toBe(true);
    expect(wrapper.ok).toBe(true);
    expect(maxInflight).toBe(1);
    const starts = controlLog.indexOf("begin:start");
    const stops = controlLog.indexOf("begin:stop");
    expect(starts).toBeGreaterThanOrEqual(0);
    expect(stops).toBeGreaterThan(starts);
    expect(controlLog.indexOf("end:start")).toBeLessThan(stops);
  });
});
