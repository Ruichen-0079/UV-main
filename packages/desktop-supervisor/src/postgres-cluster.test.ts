import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createClusterMarker,
  ensurePostgresDirectories,
  layoutFromRoot,
  readInitializationState,
  writeClusterMarker,
  writeInitializationState
} from "./postgres-layout.js";
import {
  INITDB_REASON_MAX_CHARS,
  INITDB_STDERR_TAIL_MAX_CHARS,
  INITDB_STDOUT_TAIL_MAX_CHARS,
  buildInitdbFailureEvidence,
  buildPostgresStartCommand,
  classifyInitdbSpawnResult,
  initializePrivateCluster,
  inspectExistingCluster,
  writeLocalOnlyConfig
} from "./postgres-cluster.js";
import { generatePostgresPassword, redactSecretText } from "./postgres-secret.js";
import type { PostgresDistribution } from "./postgres-distribution.js";

type SpawnSyncOverride = (
  command: string,
  args?: readonly string[],
  options?: Record<string, unknown>
) => {
  error?: Error | undefined;
  status: number | null;
  signal: NodeJS.Signals | string | null;
  stdout: string;
  stderr: string;
};

type SpawnSyncOverrideRegistration = {
  command: string;
  run: SpawnSyncOverride;
};

const childProcessState = vi.hoisted(() => ({
  override: null as SpawnSyncOverrideRegistration | null
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: ((command: string, args?: readonly string[], options?: Record<string, unknown>) => {
      const override = childProcessState.override;
      if (override && command === override.command) {
        return override.run(command, args, options);
      }
      return actual.spawnSync(command, args as string[] | undefined, options);
    }) as typeof actual.spawnSync
  };
});

const tempDirs: string[] = [];
afterEach(() => {
  childProcessState.override = null;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("private postgres cluster safety", () => {
  it("refuses init over non-empty PGDATA without a YUVI marker", () => {
    const layout = layoutFromRoot(fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-foreign-")));
    tempDirs.push(layout.root);
    ensurePostgresDirectories(layout);
    fs.writeFileSync(path.join(layout.data, "PG_VERSION"), "16\n");
    const result = inspectExistingCluster(layout);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("POSTGRES_FOREIGN_PGDATA");
  });

  it("refuses a marker/cluster mismatch and a wrong major", () => {
    const layout = layoutFromRoot(fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-mismatch-")));
    tempDirs.push(layout.root);
    ensurePostgresDirectories(layout);
    const marker = createClusterMarker(layout);
    writeClusterMarker(layout, { ...marker, dataDirectory: "/not/this/data" });
    fs.writeFileSync(path.join(layout.data, "PG_VERSION"), "16\n");
    writeInitializationState(layout, "ready");
    const mismatch = inspectExistingCluster(layout);
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.code).toBe("POSTGRES_MARKER_MISMATCH");

    const wrong = layoutFromRoot(fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-v18-")));
    tempDirs.push(wrong.root);
    ensurePostgresDirectories(wrong);
    writeClusterMarker(wrong, createClusterMarker(wrong));
    fs.writeFileSync(path.join(wrong.data, "PG_VERSION"), "18\n");
    writeInitializationState(wrong, "ready");
    const major = inspectExistingCluster(wrong);
    expect(major.ok).toBe(false);
    if (!major.ok) expect(major.code).toBe("POSTGRES_MAJOR_MISMATCH");
  });

  it("generates localhost-only scram config without trust", () => {
    const layout = layoutFromRoot(fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-conf-")));
    tempDirs.push(layout.root);
    ensurePostgresDirectories(layout);
    fs.writeFileSync(path.join(layout.data, "postgresql.conf"), "# stock\n");
    writeLocalOnlyConfig(layout, 55432);
    const yuvi = fs.readFileSync(path.join(layout.data, "postgresql.yuvi.conf"), "utf8");
    const hba = fs.readFileSync(path.join(layout.data, "pg_hba.conf"), "utf8");
    expect(yuvi).toContain("listen_addresses = '127.0.0.1'");
    expect(yuvi).not.toContain("0.0.0.0");
    expect(yuvi).not.toContain("*");
    expect(hba).toContain("scram-sha-256");
    expect(hba).not.toMatch(/\btrust\b/);
    const password = generatePostgresPassword();
    expect(redactSecretText(yuvi, [password])).not.toContain(password);
    expect(redactSecretText(hba, [password])).not.toContain(password);
  });

  it("builds a start command without a secret URL", () => {
    const layout = layoutFromRoot(fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-cmd-")));
    tempDirs.push(layout.root);
    const command = buildPostgresStartCommand(
      layout,
      {
        home: "/opt/pg16",
        binDir: "/opt/pg16/bin",
        postgres: "/opt/pg16/bin/postgres",
        pgCtl: "/opt/pg16/bin/pg_ctl",
        initdb: "/opt/pg16/bin/initdb",
        createdb: null,
        psql: "/opt/pg16/bin/psql",
        major: 16,
        versionText: "postgres (PostgreSQL) 16.0"
      },
      55432,
      "abc-cluster"
    );
    expect(command.args).toContain("127.0.0.1");
    expect(command.args.join(" ")).not.toContain("postgres://");
    expect(command.env["PGPASSWORD"]).toBeUndefined();
    expect(command.commandMarker).toBe("yuvi-pg-abc-cluster");
  });
});

describe("initdb failure evidence", () => {
  const windowsBanner = [
    'The files belonging to this database system will be owned by user "runneradmin".',
    "",
    "This user must also own the server process.",
    "",
    'The database cluster will be initialized with locale "C".',
    'The default text search configuration will be set to "english".',
    ""
  ].join("\n");

  function emptyLayout() {
    const layout = layoutFromRoot(fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-initdb-")));
    tempDirs.push(layout.root);
    ensurePostgresDirectories(layout);
    return layout;
  }

  function fakeDistribution(initdb: string): PostgresDistribution {
    const binDir = path.dirname(initdb);
    return {
      home: binDir,
      binDir,
      postgres: path.join(binDir, "postgres"),
      pgCtl: path.join(binDir, "pg_ctl"),
      initdb,
      createdb: null,
      psql: path.join(binDir, "psql"),
      major: 16,
      versionText: "postgres (PostgreSQL) 16.10"
    };
  }

  function runInitialize(initdb: string, password = generatePostgresPassword()) {
    const layout = emptyLayout();
    const result = initializePrivateCluster({
      layout,
      distribution: fakeDistribution(initdb),
      password,
      port: 55432
    });
    return { layout, result, password };
  }

  function assertInitdbSpawnCall(
    call: {
      command: string;
      args: readonly string[];
      options: Record<string, unknown> | undefined;
    },
    input: { initdb: string; dataDir: string; password: string }
  ) {
    expect(call.command).toBe(input.initdb);
    expect(call.args).toEqual(
      expect.arrayContaining([
        "-D",
        input.dataDir,
        "--encoding=UTF8",
        "--locale=C",
        "--username=yuvi",
        "--auth-host=scram-sha-256",
        "--auth-local=scram-sha-256"
      ])
    );
    const pwfile = call.args.find((value) => String(value).startsWith("--pwfile="));
    expect(pwfile).toEqual(expect.stringMatching(/^--pwfile=/));
    expect(String(pwfile)).not.toContain(input.password);
    expect(call.command).not.toContain(input.password);
    expect(call.args.join("\0")).not.toContain(input.password);
    expect(call.options?.["encoding"]).toBe("utf8");
    expect(call.options?.["timeout"]).toBe(60_000);
    expect(call.options?.["windowsHide"]).toBe(true);
  }

  function syntheticInitdbCommand(): string {
    return path.join(os.tmpdir(), "yuvi-test-initdb", `initdb-${randomUUID()}`);
  }

  function registerExactInitdbOverride(
    initdb: string,
    result: {
      error?: Error | undefined;
      status: number | null;
      signal: NodeJS.Signals | string | null;
      stdout: string;
      stderr: string;
    }
  ) {
    const invocations: Array<{
      command: string;
      args: readonly string[];
      options: Record<string, unknown> | undefined;
    }> = [];
    childProcessState.override = {
      command: initdb,
      run(command, args = [], options) {
        expect(command).toBe(initdb);
        expect(command).not.toBe("icacls");
        invocations.push({ command, args, options });
        return result;
      }
    };
    return {
      invocations,
      expectInterceptedOnce() {
        expect(invocations).toHaveLength(1);
        expect(invocations[0]?.command).toBe(initdb);
        expect(invocations.some((call) => call.command === "icacls")).toBe(false);
      }
    };
  }

  it("classifies spawn failure, nonzero exit, signal, timeout, and success separately", () => {
    expect(
      classifyInitdbSpawnResult({
        error: Object.assign(new Error("spawn initdb ENOENT"), { code: "ENOENT" }),
        status: null,
        signal: null
      })
    ).toEqual({ kind: "SPAWN_FAILED", spawnErrorCode: "ENOENT" });
    expect(
      classifyInitdbSpawnResult({
        error: Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" }),
        status: null,
        signal: "SIGTERM"
      })
    ).toEqual({ kind: "TIMEOUT", spawnErrorCode: "ETIMEDOUT", signal: "SIGTERM" });
    expect(
      classifyInitdbSpawnResult({ error: undefined, status: null, signal: "SIGTERM" })
    ).toEqual({
      kind: "SIGNALLED",
      signal: "SIGTERM"
    });
    expect(classifyInitdbSpawnResult({ error: undefined, status: 1, signal: null })).toEqual({
      kind: "EXIT_NONZERO",
      exitStatus: 1
    });
    expect(classifyInitdbSpawnResult({ error: undefined, status: 0, signal: null })).toEqual({
      kind: "SUCCESS"
    });
  });

  it("keeps a Windows initdb banner from crowding out a later stderr fatal line", () => {
    const evidence = buildInitdbFailureEvidence(
      {
        error: undefined,
        status: 1,
        signal: null,
        stdout: windowsBanner,
        stderr: "FATAL_TEST_SENTINEL\n"
      },
      { secrets: [] }
    );
    expect(evidence.errorCode).toBe("EXIT_NONZERO");
    expect(evidence.exitStatus).toBe(1);
    expect(evidence.reason).toContain("FATAL_TEST_SENTINEL");
    expect(evidence.reason).not.toContain("owned by user");
    expect(evidence.stderrTail).toContain("FATAL_TEST_SENTINEL");
    expect(evidence.stdoutTail).toContain("owned by user");
  });

  it("persists the stderr fatal sentinel after a Windows-like initdb banner", () => {
    const initdb = syntheticInitdbCommand();
    const override = registerExactInitdbOverride(initdb, {
      error: undefined,
      status: 1,
      signal: null,
      stdout: windowsBanner,
      stderr: "FATAL_TEST_SENTINEL\n"
    });
    const { layout, result, password } = runInitialize(initdb);
    override.expectInterceptedOnce();
    assertInitdbSpawnCall(override.invocations[0]!, { initdb, dataDir: layout.data, password });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("POSTGRES_INIT_FAILED");
    const state = readInitializationState(layout);
    expect(state?.state).toBe("failed");
    expect(state?.errorCode).toBe("EXIT_NONZERO");
    expect(state?.exitStatus).toBe(1);
    expect(state?.reason).toContain("FATAL_TEST_SENTINEL");
    expect(state?.reason).not.toContain("owned by user");
    expect(state?.reason).not.toMatch(/RestrictedAclError|icacls/);
    expect(state?.stderrTail).toContain("FATAL_TEST_SENTINEL");
    const serialized = fs.readFileSync(layout.initializationStateFile, "utf8");
    expect(serialized).toContain("FATAL_TEST_SENTINEL");
    expect(serialized.indexOf("FATAL_TEST_SENTINEL")).toBeGreaterThan(-1);
  });

  it("preserves a missing-executable spawn as SPAWN_FAILED with a safe code", () => {
    childProcessState.override = null;
    const { layout, result } = runInitialize(
      path.join(os.tmpdir(), "yuvi-missing-initdb", "initdb-does-not-exist")
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("POSTGRES_INIT_FAILED");
    const state = readInitializationState(layout);
    expect(state?.state).toBe("failed");
    expect(state?.errorCode).toBe("SPAWN_FAILED");
    expect(state?.spawnErrorCode).toBe("ENOENT");
    expect(state?.exitStatus).toBeNull();
    expect(state?.reason).toContain("SPAWN_FAILED");
  });

  it("preserves a signalled initdb separately from a nonzero exit", () => {
    const initdb = syntheticInitdbCommand();
    const override = registerExactInitdbOverride(initdb, {
      error: undefined,
      status: null,
      signal: "SIGTERM",
      stdout: "",
      stderr: ""
    });
    const { layout, result } = runInitialize(initdb);
    override.expectInterceptedOnce();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("POSTGRES_INIT_FAILED");
    const state = readInitializationState(layout);
    expect(state?.state).toBe("failed");
    expect(state?.errorCode).toBe("SIGNALLED");
    expect(state?.signal).toBe("SIGTERM");
    expect(state?.exitStatus).toBeNull();
    expect(state?.reason).not.toMatch(/RestrictedAclError|icacls/);
  });

  it("leaves success initialization-state free of failure evidence", () => {
    const initdb = syntheticInitdbCommand();
    const override = registerExactInitdbOverride(initdb, {
      error: undefined,
      status: 0,
      signal: null,
      stdout: "",
      stderr: ""
    });
    const { layout, result } = runInitialize(initdb);
    override.expectInterceptedOnce();
    expect(result.ok).toBe(true);
    const state = readInitializationState(layout);
    expect(state?.state).toBe("ready");
    expect(state?.reason).toBeUndefined();
    expect(state?.errorCode).toBeUndefined();
    expect(state?.stdoutTail).toBeUndefined();
    expect(state?.stderrTail).toBeUndefined();
    expect(state?.exitStatus).toBeUndefined();
    expect(state?.signal).toBeUndefined();
    expect(state?.spawnErrorCode).toBeUndefined();
    const serialized = fs.readFileSync(layout.initializationStateFile, "utf8");
    expect(serialized).not.toContain("stdoutTail");
    expect(serialized).not.toContain("stderrTail");
    expect(serialized).not.toContain("EXIT_NONZERO");
    expect(serialized).not.toMatch(/RestrictedAclError|icacls/);
  });

  it("keeps a failure sentinel from large stdout/stderr and bounds persisted tails", () => {
    const stdout = `${windowsBanner}${"BANNER_NOISE".repeat(4000)}`;
    const stderr = `${"E".repeat(8000)}\nFATAL_TEST_SENTINEL\n`;
    const evidence = buildInitdbFailureEvidence(
      { error: undefined, status: 13, signal: null, stdout, stderr },
      { secrets: [] }
    );
    expect(evidence.exitStatus).toBe(13);
    expect(evidence.stdoutTail?.length ?? 0).toBeLessThanOrEqual(INITDB_STDOUT_TAIL_MAX_CHARS);
    expect(evidence.stderrTail?.length ?? 0).toBeLessThanOrEqual(INITDB_STDERR_TAIL_MAX_CHARS);
    expect(evidence.reason.length).toBeLessThanOrEqual(INITDB_REASON_MAX_CHARS);
    expect(evidence.stderrTail).toContain("FATAL_TEST_SENTINEL");
    expect(evidence.reason).toContain("FATAL_TEST_SENTINEL");
    expect(JSON.stringify(evidence).length).toBeLessThan(12_000);
  });

  it("redacts secrets from initdb failure diagnostics and persisted state", () => {
    const logs: string[] = [];
    const spy = (method: "log" | "info" | "warn" | "error") =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logs.push(args.map((value) => String(value)).join(" "));
      });
    const spies = [spy("log"), spy("info"), spy("warn"), spy("error")];
    const initdb = syntheticInitdbCommand();
    const override = registerExactInitdbOverride(initdb, {
      error: undefined,
      status: 1,
      signal: null,
      stdout: windowsBanner,
      stderr: [
        "YUVI_POSTGRES_PASSWORD=SUPERSECRET",
        "postgres://yuvi:SUPERSECRET@127.0.0.1/yuvi",
        "password=SUPERSECRET",
        "PGPASSWORD=SUPERSECRET",
        "Bearer SUPERSECRET",
        "FATAL_TEST_SENTINEL"
      ].join("\n")
    });
    try {
      const { layout, result } = runInitialize(initdb, generatePostgresPassword());
      override.expectInterceptedOnce();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("POSTGRES_INIT_FAILED");
      const state = readInitializationState(layout);
      expect(state?.errorCode).toBe("EXIT_NONZERO");
      expect(state?.reason).not.toMatch(/RestrictedAclError|icacls/);
      const serialized = fs.readFileSync(layout.initializationStateFile, "utf8");
      for (const haystack of [
        state?.reason ?? "",
        state?.stdoutTail ?? "",
        state?.stderrTail ?? "",
        serialized,
        logs.join("\n")
      ]) {
        expect(haystack).not.toContain("SUPERSECRET");
      }
      expect(state?.reason).toContain("FATAL_TEST_SENTINEL");
      expect(state?.stderrTail).toContain("FATAL_TEST_SENTINEL");
      expect(state?.stderrTail).toMatch(/YUVI_POSTGRES_PASSWORD=\[REDACTED\]/i);
      expect(state?.stderrTail).toMatch(/password=\[REDACTED\]/i);
      expect(state?.stderrTail).toMatch(/Bearer \[REDACTED\]/i);
      expect(state?.stderrTail).toMatch(/postgres:\/\/\[REDACTED\]/i);
    } finally {
      for (const current of spies) current.mockRestore();
    }
  });
});
