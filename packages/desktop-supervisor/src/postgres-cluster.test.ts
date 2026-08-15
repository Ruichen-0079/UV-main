import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createClusterMarker,
  ensurePostgresDirectories,
  layoutFromRoot,
  writeClusterMarker,
  writeInitializationState
} from "./postgres-layout.js";
import {
  buildPostgresStartCommand,
  inspectExistingCluster,
  writeLocalOnlyConfig
} from "./postgres-cluster.js";
import { generatePostgresPassword, redactSecretText } from "./postgres-secret.js";

const tempDirs: string[] = [];
afterEach(() => {
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
