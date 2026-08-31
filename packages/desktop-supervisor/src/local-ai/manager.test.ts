import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalAiServiceManager } from "./manager.js";
import type { LocalAiManagerConfig } from "./types.js";

const tempDirs: string[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function cfg(overrides: Partial<LocalAiManagerConfig> = {}): LocalAiManagerConfig {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-local-ai-"));
  tempDirs.push(stateDirectory);
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-repo-"));
  tempDirs.push(repositoryRoot);
  return {
    repositoryRoot,
    stateDirectory,
    instanceId: "inst-local-ai",
    ownershipToken: "own-local-ai",
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
    localLlmSystemdUnit: null,
    ...overrides
  };
}

describe("LocalAiServiceManager", () => {
  it("exposes the catalog without creating a second Runtime", async () => {
    const manager = new LocalAiServiceManager(cfg());
    const snap = await manager.refreshAll();
    const ids = snap.services.map((service) => service.id);
    expect(ids).toEqual(["alice", "alice.upstream", "alice.wrapper", "embedding", "stt", "local-llm"]);
    const alice = snap.services.find((service) => service.id === "alice");
    expect(alice?.kind).toBe("logical");
    expect(alice?.children).toEqual(["alice.upstream", "alice.wrapper"]);
    expect(JSON.stringify(snap)).not.toContain("test-key");
    expect(JSON.stringify(snap)).not.toContain("Character");
    const llm = snap.services.find((service) => service.id === "local-llm");
    expect(llm?.startPolicy).toBe("MANUAL");
    expect(llm?.metadata["roleRouting"]).toBe(false);
    expect(llm?.canStop).toBe(false);
  });

  it("refuses to stop an unowned local LLM endpoint", async () => {
    const manager = new LocalAiServiceManager(cfg());
    const result = await manager.stop("local-llm");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not owned/i);
  });

  it("treats a reachable unowned HTTP service as external and refuses stop", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected tcp");
    const manager = new LocalAiServiceManager(
      cfg({
        localLlmUrl: `http://127.0.0.1:${address.port}`
      })
    );
    await manager.refreshAll();
    const llm = manager.getService("local-llm");
    expect(llm.ownership).toBe("external");
    expect(llm.canStop).toBe(false);
    const stopped = await manager.stop("local-llm");
    expect(stopped.ok).toBe(false);
  });

  it("does not assign Character or Cognition roles in LLM discovery metadata", async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url?.includes("/models")) {
        res.end(JSON.stringify({ data: [{ id: "future-llama", owned_by: "llamacpp" }] }));
        return;
      }
      res.end(JSON.stringify({ status: "ok" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected tcp");
    const manager = new LocalAiServiceManager(
      cfg({ localLlmUrl: `http://127.0.0.1:${address.port}` })
    );
    const test = await manager.test("local-llm");
    expect(test.ok).toBe(true);
    expect(test.detail["roleRouting"]).toBe(false);
    expect(JSON.stringify(test)).not.toContain("Character");
    expect(JSON.stringify(test)).not.toContain("Cognition");
  });
});
