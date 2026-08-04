import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DesktopSupervisor } from "./supervisor.js";
import {
  CONTROL_TOKEN_HEADER,
  startSupervisorHttpServer,
  tokensMatch
} from "./http-server.js";
import { assertLoopbackHost, generateControlToken } from "./config.js";
import type { SupervisorConfig } from "./types.js";

const tempDirs: string[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function cfg(): SupervisorConfig {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-http-"));
  tempDirs.push(stateDirectory);
  return {
    repositoryRoot: "C:\\Dev\\UV-main",
    stateDirectory,
    instanceId: "inst-http",
    ownershipToken: "own-tok",
    controlToken: generateControlToken(),
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
    databaseUrl: null,
    runtimeStart: null,
    mem0Start: null,
    ttsWrapperStart: null,
    ttsUpstreamStart: null
  };
}

async function request(
  port: number,
  method: string,
  pathName: string,
  token?: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathName,
        method,
        headers: token ? { [CONTROL_TOKEN_HEADER]: token } : {}
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

describe("control plane auth + loopback", () => {
  it("rejects non-loopback bind hosts", () => {
    expect(() => assertLoopbackHost("0.0.0.0")).toThrow(/loopback/i);
    expect(() => assertLoopbackHost("192.168.1.10")).toThrow(/loopback/i);
    expect(() => assertLoopbackHost("127.0.0.1")).not.toThrow();
  });

  it("requires token for write and status; health is public", async () => {
    const config = cfg();
    const supervisor = new DesktopSupervisor(config);
    const { server, port } = await startSupervisorHttpServer(supervisor, {
      host: "127.0.0.1",
      controlToken: config.controlToken
    });
    servers.push(server);

    const health = await request(port, "GET", "/health");
    expect(health.status).toBe(200);

    const noTok = await request(port, "POST", "/v1/refresh");
    expect(noTok.status).toBe(401);

    const badTok = await request(port, "POST", "/v1/refresh", "wrong-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    expect(badTok.status).toBe(401);

    const statusNoTok = await request(port, "GET", "/v1/status");
    expect(statusNoTok.status).toBe(401);

    const ok = await request(port, "GET", "/v1/status", config.controlToken);
    expect(ok.status).toBe(200);
    const body = JSON.parse(ok.body) as Record<string, unknown>;
    expect(body["instanceId"]).toBe("inst-http");
    // Token must never appear in status payload.
    expect(JSON.stringify(body)).not.toContain(config.controlToken);
  });

  it("tokensMatch rejects mismatched lengths", () => {
    expect(tokensMatch("abcd", null)).toBe(false);
    expect(tokensMatch("abcd", "ab")).toBe(false);
    expect(tokensMatch("abcd", "abcd")).toBe(true);
  });

  it("generateControlToken is high entropy length", () => {
    const a = generateControlToken();
    const b = generateControlToken();
    expect(a).toHaveLength(64);
    expect(b).toHaveLength(64);
    expect(a).not.toBe(b);
  });
});
