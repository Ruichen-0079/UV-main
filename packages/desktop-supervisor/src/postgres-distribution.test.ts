import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parsePostgresVersionText,
  resolvePostgresDistribution,
  resolvePostgresHome
} from "./postgres-distribution.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: vi.fn(actual.spawnSync)
  };
});

const spawnSyncMock = vi.mocked(spawnSync);

const tempDirs: string[] = [];
afterEach(() => {
  spawnSyncMock.mockReset();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function toolFileName(name: string): string {
  return process.platform === "win32" ? `${name}.exe` : name;
}

function writePlaceholderTools(binDir: string, names: string[]): void {
  fs.mkdirSync(binDir, { recursive: true });
  for (const name of names) {
    fs.writeFileSync(path.join(binDir, toolFileName(name)), "");
  }
}

function versionProbe(status: number, stdout: string, stderr = "") {
  return {
    status,
    stdout,
    stderr,
    signal: null,
    pid: 0,
    output: [null, stdout, stderr]
  } as unknown as ReturnType<typeof spawnSync>;
}

function mockToolVersions(versions: Record<string, string>): void {
  spawnSyncMock.mockImplementation((executable, args) => {
    const argv = Array.isArray(args) ? args : [];
    if (argv[0] !== "--version") {
      return versionProbe(1, "", "unexpected arguments");
    }
    const base = path.basename(String(executable)).replace(/\.exe$/iu, "");
    const version = versions[base];
    if (!version) {
      return versionProbe(1, "");
    }
    return versionProbe(0, `${base} (PostgreSQL) ${version}\n`);
  });
}

describe("postgres distribution contract", () => {
  it("parses official PostgreSQL 16 version strings including major-only", () => {
    expect(parsePostgresVersionText("postgres (PostgreSQL) 16.10").ok).toBe(true);
    expect(parsePostgresVersionText("postgres (PostgreSQL) 16.0").ok).toBe(true);
    expect(parsePostgresVersionText("postgres (PostgreSQL) 16").ok).toBe(true);
    expect(parsePostgresVersionText("psql (PostgreSQL) 16.10 (Ubuntu 16.10-1)").ok).toBe(true);
    expect(parsePostgresVersionText("postgres mystery").ok).toBe(false);
  });

  it("reads YUVI_POSTGRES_HOME and packaged resource_dir/postgres", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pghome-"));
    tempDirs.push(home);
    expect(
      resolvePostgresHome(
        { YUVI_POSTGRES_HOME: home },
        { mode: "development", repositoryRoot: home }
      )
    ).toBe(home);

    const resourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-res-"));
    tempDirs.push(resourceRoot);
    const staged = path.join(resourceRoot, "postgres");
    fs.mkdirSync(staged);
    expect(
      resolvePostgresHome(
        {},
        {
          mode: "packaged",
          resourceRoot,
          dataRoot: resourceRoot,
          runtimeManifestPath: path.join(resourceRoot, "runtime.json"),
          mem0ManifestPath: path.join(resourceRoot, "mem0.json")
        }
      )
    ).toBe(staged);
  });

  it("rejects a missing or incomplete distribution without initializing", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-empty-"));
    tempDirs.push(home);
    const result = resolvePostgresDistribution(
      { YUVI_POSTGRES_HOME: home },
      { mode: "development", repositoryRoot: home }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("POSTGRES_BINARIES_MISSING");
  });

  it("rejects the wrong PostgreSQL major", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-wrong-"));
    tempDirs.push(home);
    writePlaceholderTools(path.join(home, "bin"), ["postgres", "pg_ctl", "initdb", "psql"]);
    mockToolVersions({
      postgres: "18.4",
      pg_ctl: "18.4",
      initdb: "18.4",
      psql: "18.4"
    });
    const result = resolvePostgresDistribution(
      { YUVI_POSTGRES_HOME: home },
      { mode: "development", repositoryRoot: home }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("POSTGRES_MAJOR_UNSUPPORTED");
      expect(result.error.detectedMajor).toBe(18);
    }
    expect(spawnSyncMock).toHaveBeenCalled();
    expect(spawnSyncMock.mock.calls.every((call) => call[1]?.[0] === "--version")).toBe(true);
  });

  it("rejects mixed major tools in the same tree", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-mix-"));
    tempDirs.push(home);
    writePlaceholderTools(path.join(home, "bin"), ["postgres", "pg_ctl", "initdb", "psql"]);
    mockToolVersions({
      postgres: "16.10",
      pg_ctl: "17.4",
      initdb: "16.10",
      psql: "16.10"
    });
    const result = resolvePostgresDistribution(
      { YUVI_POSTGRES_HOME: home },
      { mode: "development", repositoryRoot: home }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("POSTGRES_MAJOR_UNSUPPORTED");
    expect(spawnSyncMock).toHaveBeenCalled();
    expect(spawnSyncMock.mock.calls.every((call) => call[1]?.[0] === "--version")).toBe(true);
  });
});
