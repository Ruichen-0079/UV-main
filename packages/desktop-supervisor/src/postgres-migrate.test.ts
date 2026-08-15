import { describe, expect, it } from "vitest";
import { buildPrivateDatabaseUrl, resolveSupervisorMigrationTarget } from "./postgres-migrate.js";
import type { SupervisorConfig } from "./types.js";

function config(overrides: Partial<SupervisorConfig> = {}): SupervisorConfig {
  return {
    layout: { mode: "development", repositoryRoot: "/repo" },
    repositoryRoot: "/repo",
    stateDirectory: "/tmp/state",
    instanceId: "inst",
    ownershipToken: "tok",
    controlToken: "c".repeat(64),
    controlHost: "127.0.0.1",
    controlPort: 0,
    env: {},
    memoryBackend: "mem0",
    autostartRuntime: false,
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
    ...overrides
  };
}

describe("supervisor migration adapter", () => {
  it("resolves private targets from D1-owned listen state and not from env DATABASE_URL", () => {
    const target = resolveSupervisorMigrationTarget(
      config({
        postgresMode: "private",
        postgresListenPort: 55432,
        databaseUrl: "postgres://should-not-use@127.0.0.1:5432/other"
      }),
      "private-secret"
    );
    expect(target).toMatchObject({
      kind: "private",
      host: "127.0.0.1",
      port: 55432,
      user: "yuvi",
      database: "yuvi"
    });
    expect(target && "password" in target ? target.password : null).toBe("private-secret");
  });

  it("uses the explicit external DATABASE_URL and does not invent a private target", () => {
    const target = resolveSupervisorMigrationTarget(
      config({
        postgresMode: "external",
        databaseUrl: "postgres://yuvi:ext@127.0.0.1:5432/yuvi"
      }),
      "ignored"
    );
    expect(target).toEqual({
      kind: "external",
      databaseUrl: "postgres://yuvi:ext@127.0.0.1:5432/yuvi"
    });
  });

  it("skips external mode when no DATABASE_URL is configured", () => {
    expect(resolveSupervisorMigrationTarget(config({ postgresMode: "external" }), null)).toBeNull();
  });

  it("encodes private connection credentials without exposing them in diagnostics helpers", () => {
    const url = buildPrivateDatabaseUrl({
      host: "127.0.0.1",
      port: 55432,
      user: "yuvi",
      database: "yuvi",
      password: "p@ss/word"
    });
    expect(url).toContain(encodeURIComponent("p@ss/word"));
    expect(url).not.toContain("p@ss/word");
  });
});
