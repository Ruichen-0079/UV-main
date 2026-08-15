import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createClusterMarker,
  ensurePostgresDirectories,
  layoutFromRoot,
  writeClusterMarker
} from "./postgres-layout.js";
import {
  evaluatePostgresOwnership,
  parsePostgresArgv,
  stopPrivatePostgresIfOwned
} from "./postgres-ownership.js";
import type { PostgresDistribution } from "./postgres-distribution.js";
import type { ProcessInspectionResult, ProcessMetadata } from "./types.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function distribution(root: string): PostgresDistribution {
  return {
    home: root,
    binDir: path.join(root, "bin"),
    postgres: path.join(root, "bin", "postgres"),
    pgCtl: path.join(root, "bin", "pg_ctl"),
    initdb: path.join(root, "bin", "initdb"),
    createdb: null,
    psql: path.join(root, "bin", "psql"),
    major: 16,
    versionText: "postgres (PostgreSQL) 16.10"
  };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-own-pg-"));
  tempDirs.push(root);
  const layout = layoutFromRoot(root);
  ensurePostgresDirectories(layout);
  const marker = createClusterMarker(layout);
  writeClusterMarker(layout, marker);
  fs.writeFileSync(path.join(layout.data, "PG_VERSION"), "16\n");
  const dist = distribution("/opt/pg16");
  const started = new Date("2026-01-01T00:00:00.000Z");
  const metadata: ProcessMetadata = {
    schemaVersion: 1,
    role: "postgres",
    pid: 4242,
    repositoryRoot: "/repo",
    stateDirectory: "/state",
    commandMarker: `yuvi-pg-${marker.clusterId}`,
    processStartedAtUtc: started.toISOString(),
    createdAtUtc: started.toISOString(),
    ownershipToken: "old-token",
    instanceId: "old-instance"
  };
  return { layout, marker, dist, started, metadata };
}

function inspection(commandLine: string, started: Date): ProcessInspectionResult {
  return {
    status: "resolved",
    processId: 4242,
    info: {
      processId: 4242,
      parentProcessId: 1,
      commandLine,
      createdAtUtc: started,
      executablePath: "/opt/pg16/bin/postgres"
    }
  };
}

describe("strong private postgres ownership", () => {
  it("parses exact argv tokens and rejects substring PGDATA", () => {
    const parsed = parsePostgresArgv(
      `/opt/pg16/bin/postgres -D /tmp/yuvi/data-extra -c cluster_name=yuvi-pg-abc`
    );
    expect(parsed.dataDirectory).toBe("/tmp/yuvi/data-extra");
    expect(parsed.clusterName).toBe("yuvi-pg-abc");
  });

  it("accepts a fully matching owned process", () => {
    const { layout, marker, dist, started, metadata } = fixture();
    const result = evaluatePostgresOwnership({
      layout,
      distribution: dist,
      metadata,
      processInspection: inspection(
        `${dist.postgres} -D ${layout.data} -p 55432 -c cluster_name=yuvi-pg-${marker.clusterId}`,
        started
      )
    });
    expect(result.owned).toBe(true);
    expect(result.port).toBe(55432);
  });

  it("rejects pid reuse, executable mismatch, and similar command lines", () => {
    const { layout, marker, dist, started, metadata } = fixture();
    const baseCmd = `${dist.postgres} -D ${layout.data} -c cluster_name=yuvi-pg-${marker.clusterId}`;
    const cases: Array<[string, ProcessInspectionResult, ProcessMetadata]> = [
      ["creation time", inspection(baseCmd, new Date("2026-02-01T00:00:00.000Z")), metadata],
      [
        "executable",
        {
          status: "resolved",
          processId: 4242,
          info: {
            processId: 4242,
            parentProcessId: 1,
            commandLine: `/usr/bin/postgres -D ${layout.data} -c cluster_name=yuvi-pg-${marker.clusterId}`,
            createdAtUtc: started,
            executablePath: "/usr/bin/postgres"
          }
        },
        metadata
      ],
      [
        "pgdata substring",
        inspection(
          `${dist.postgres} -D ${layout.data}-foreign -c cluster_name=yuvi-pg-${marker.clusterId}`,
          started
        ),
        metadata
      ],
      [
        "cluster marker",
        inspection(`${dist.postgres} -D ${layout.data} -c cluster_name=yuvi-pg-other`, started),
        metadata
      ]
    ];
    for (const [label, inspect, meta] of cases) {
      const result = evaluatePostgresOwnership({
        layout,
        distribution: dist,
        metadata: meta,
        processInspection: inspect
      });
      expect(result.owned, label).toBe(false);
    }
  });

  it("does not invoke pg_ctl when postmaster.pid is foreign or ownership fails", () => {
    const { layout, marker, dist, started, metadata } = fixture();
    fs.writeFileSync(path.join(layout.data, "postmaster.pid"), "99999\n");
    let invoked = false;
    const refused = stopPrivatePostgresIfOwned({
      layout,
      distribution: dist,
      metadata,
      processInspection: inspection(
        `${dist.postgres} -D ${layout.data} -c cluster_name=yuvi-pg-${marker.clusterId}`,
        started
      ),
      invokeStop: () => {
        invoked = true;
        return true;
      }
    });
    expect(refused.invoked).toBe(false);
    expect(invoked).toBe(false);

    const owned = stopPrivatePostgresIfOwned({
      layout,
      distribution: dist,
      metadata,
      processInspection: inspection(
        `${dist.postgres} -D ${layout.data} -c cluster_name=yuvi-pg-${marker.clusterId}`,
        started
      ),
      invokeStop: (input) => {
        invoked = true;
        expect(input.layout.data).toBe(layout.data);
        return true;
      }
    });
    expect(owned.invoked).toBe(false);
    fs.writeFileSync(path.join(layout.data, "postmaster.pid"), "4242\n");
    invoked = false;
    const allowed = stopPrivatePostgresIfOwned({
      layout,
      distribution: dist,
      metadata,
      processInspection: inspection(
        `${dist.postgres} -D ${layout.data} -c cluster_name=yuvi-pg-${marker.clusterId}`,
        started
      ),
      invokeStop: () => {
        invoked = true;
        return true;
      }
    });
    expect(allowed.invoked).toBe(true);
    expect(invoked).toBe(true);
  });
});
