import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parsePostgresVersionText,
  resolvePostgresDistribution,
  resolvePostgresHome
} from "./postgres-distribution.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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
    const bin = path.join(home, "bin");
    fs.mkdirSync(bin);
    const script = `#!/bin/sh\necho 'postgres (PostgreSQL) 18.4'\n`;
    for (const name of ["postgres", "pg_ctl", "initdb", "psql"]) {
      const file = path.join(bin, name);
      fs.writeFileSync(file, script, { mode: 0o755 });
      fs.chmodSync(file, 0o755);
    }
    const result = resolvePostgresDistribution(
      { YUVI_POSTGRES_HOME: home },
      { mode: "development", repositoryRoot: home }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("POSTGRES_MAJOR_UNSUPPORTED");
      expect(result.error.detectedMajor).toBe(18);
    }
  });

  it("rejects mixed major tools in the same tree", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-mix-"));
    tempDirs.push(home);
    const bin = path.join(home, "bin");
    fs.mkdirSync(bin);
    const write = (name: string, version: string) => {
      const file = path.join(bin, name);
      fs.writeFileSync(file, `#!/bin/sh\necho '${name} (PostgreSQL) ${version}'\n`, {
        mode: 0o755
      });
      fs.chmodSync(file, 0o755);
    };
    write("postgres", "16.10");
    write("pg_ctl", "17.4");
    write("initdb", "16.10");
    write("psql", "16.10");
    const result = resolvePostgresDistribution(
      { YUVI_POSTGRES_HOME: home },
      { mode: "development", repositoryRoot: home }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("POSTGRES_MAJOR_UNSUPPORTED");
  });
});
