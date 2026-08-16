import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as cluster from "./postgres-cluster.js";
import {
  createClusterMarker,
  ensurePostgresDirectories,
  layoutFromRoot,
  writeClusterMarker,
  writeInitializationState
} from "./postgres-layout.js";
import { preparePrivatePostgres } from "./postgres-lifecycle.js";

const tempDirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("private postgres packaged preparation", () => {
  it("does not invoke single-user CREATE DATABASE during prepare", async () => {
    const spy = vi.spyOn(cluster, "createYuviDatabaseSingleUser");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-prep-"));
    tempDirs.push(root);
    const layout = layoutFromRoot(root);
    ensurePostgresDirectories(layout);
    const marker = createClusterMarker(layout);
    writeClusterMarker(layout, marker);
    fs.writeFileSync(path.join(layout.data, "PG_VERSION"), "16\n");
    writeInitializationState(layout, "ready");
    const result = await preparePrivatePostgres({
      layout,
      distribution: {
        home: "/opt/pg16",
        binDir: "/opt/pg16/bin",
        postgres: "/opt/pg16/bin/postgres",
        pgCtl: "/opt/pg16/bin/pg_ctl",
        initdb: "/opt/pg16/bin/initdb",
        createdb: null,
        psql: "/opt/pg16/bin/psql",
        major: 16,
        versionText: "postgres (PostgreSQL) 16.10"
      },
      env: { YUVI_POSTGRES_PASSWORD: "unit-test-password" },
      authority: "development-file"
    });
    expect(result.ok).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });
});
