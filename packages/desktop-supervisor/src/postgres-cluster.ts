/**
 * First-run private cluster initialization and localhost-only configuration.
 * Bootstrap SQL here only creates the `yuvi` database. Yuvi schema migrations
 * belong to P4-2D2.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { canonicalPath, pathsEqual } from "./paths.js";
import type { PostgresDistribution } from "./postgres-distribution.js";
import {
  PRIVATE_POSTGRES_DATABASE,
  PRIVATE_POSTGRES_HOST,
  PRIVATE_POSTGRES_MAJOR,
  PRIVATE_POSTGRES_USER,
  assertPgdataContained,
  createClusterMarker,
  isPgdataEmpty,
  pgdataLooksInitialized,
  readClusterMarker,
  readInitializationState,
  readPgVersion,
  restrictPathToCurrentUser,
  writeClusterMarker,
  writeInitializationState,
  type PostgresLayout,
  type YuviClusterMarker
} from "./postgres-layout.js";

export type ClusterPrepareResult =
  | {
      ok: true;
      marker: YuviClusterMarker;
      initialized: boolean;
    }
  | {
      ok: false;
      code:
        | "POSTGRES_INIT_IN_PROGRESS"
        | "POSTGRES_INIT_FAILED"
        | "POSTGRES_FOREIGN_PGDATA"
        | "POSTGRES_MAJOR_MISMATCH"
        | "POSTGRES_MARKER_MISMATCH"
        | "POSTGRES_PGDATA_OUTSIDE_ROOT";
      message: string;
    };

export function inspectExistingCluster(layout: PostgresLayout): ClusterPrepareResult {
  try {
    assertPgdataContained(layout);
  } catch (error) {
    return {
      ok: false,
      code: "POSTGRES_PGDATA_OUTSIDE_ROOT",
      message: error instanceof Error ? error.message : "PGDATA is outside the canonical root."
    };
  }
  const outside = !pathsEqual(path.dirname(layout.data), layout.root);
  if (outside) {
    return {
      ok: false,
      code: "POSTGRES_PGDATA_OUTSIDE_ROOT",
      message: "PGDATA is outside the canonical YUVI Postgres data root."
    };
  }

  const marker = readClusterMarker(layout);
  const initialized = pgdataLooksInitialized(layout);
  const empty = isPgdataEmpty(layout);
  const initState = readInitializationState(layout);

  if (!initialized && empty) {
    return {
      ok: true,
      marker: marker ?? createClusterMarker(layout),
      initialized: false
    };
  }

  if (initState?.state === "initializing") {
    return {
      ok: false,
      code: "POSTGRES_INIT_IN_PROGRESS",
      message: "Private PostgreSQL initialization was interrupted and is not ready."
    };
  }

  if (!marker) {
    return {
      ok: false,
      code: "POSTGRES_FOREIGN_PGDATA",
      message: "Non-empty PGDATA has no YUVI cluster marker; refusing to adopt or initialize."
    };
  }

  if (!pathsEqual(marker.dataDirectory, layout.data)) {
    return {
      ok: false,
      code: "POSTGRES_MARKER_MISMATCH",
      message: "YUVI cluster marker does not match this PGDATA path."
    };
  }

  const major = readPgVersion(layout);
  if (major !== PRIVATE_POSTGRES_MAJOR) {
    return {
      ok: false,
      code: "POSTGRES_MAJOR_MISMATCH",
      message: `Existing PGDATA major ${major ?? "unknown"} is not PostgreSQL ${PRIVATE_POSTGRES_MAJOR}.`
    };
  }

  if (initState?.state === "failed") {
    return {
      ok: false,
      code: "POSTGRES_INIT_FAILED",
      message: initState.reason ?? "Private PostgreSQL initialization previously failed."
    };
  }

  return { ok: true, marker, initialized: true };
}

export function initializePrivateCluster(input: {
  layout: PostgresLayout;
  distribution: PostgresDistribution;
  password: string;
  port: number;
}): ClusterPrepareResult {
  const existing = inspectExistingCluster(input.layout);
  if (!existing.ok) return existing;
  if (existing.initialized) return existing;
  if (!isPgdataEmpty(input.layout)) {
    return {
      ok: false,
      code: "POSTGRES_FOREIGN_PGDATA",
      message: "Refusing to run initdb over a non-empty PGDATA directory."
    };
  }

  const marker = existing.marker;
  writeInitializationState(input.layout, "initializing", "initdb");
  const pwFile = path.join(input.layout.runtime, `initdb-pw.${process.pid}.tmp`);
  try {
    fs.writeFileSync(pwFile, `${input.password}\n`, { encoding: "utf8", mode: 0o600 });
    restrictPathToCurrentUser(pwFile);
    const args = [
      "-D",
      input.layout.data,
      "--encoding=UTF8",
      "--locale=C",
      `--username=${PRIVATE_POSTGRES_USER}`,
      "--auth-host=scram-sha-256",
      "--auth-local=scram-sha-256",
      `--pwfile=${pwFile}`
    ];
    const result = spawnSync(input.distribution.initdb, args, {
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true
    });
    if (result.status !== 0) {
      const detail = sanitizeInitOutput(`${result.stdout ?? ""}${result.stderr ?? ""}`);
      writeInitializationState(input.layout, "failed", detail || "initdb failed");
      return {
        ok: false,
        code: "POSTGRES_INIT_FAILED",
        message: "initdb failed for the private YUVI PostgreSQL cluster."
      };
    }
    writeLocalOnlyConfig(input.layout, input.port);
    writeClusterMarker(input.layout, marker);
    writeInitializationState(input.layout, "ready");
    return { ok: true, marker, initialized: true };
  } catch (error) {
    writeInitializationState(
      input.layout,
      "failed",
      error instanceof Error ? error.message : "initialization threw"
    );
    return {
      ok: false,
      code: "POSTGRES_INIT_FAILED",
      message: "Private PostgreSQL initialization failed."
    };
  } finally {
    try {
      fs.unlinkSync(pwFile);
    } catch {
      // ignore
    }
  }
}

export function writeLocalOnlyConfig(layout: PostgresLayout, port: number): void {
  const conf = path.join(layout.data, "postgresql.conf");
  const hba = path.join(layout.data, "pg_hba.conf");
  const include = path.join(layout.data, "postgresql.yuvi.conf");
  const socketDir = layout.runtime.replaceAll("\\", "/");
  fs.writeFileSync(
    include,
    [
      "# Generated by YUVI. Do not listen on non-loopback addresses.",
      "listen_addresses = '127.0.0.1'",
      `port = ${port}`,
      "password_encryption = scram-sha-256",
      `unix_socket_directories = '${socketDir}'`,
      "logging_collector = off",
      ""
    ].join("\n"),
    "utf8"
  );
  restrictPathToCurrentUser(include);

  const existing = fs.existsSync(conf) ? fs.readFileSync(conf, "utf8") : "";
  if (!existing.includes("postgresql.yuvi.conf")) {
    fs.appendFileSync(conf, "\ninclude = 'postgresql.yuvi.conf'\n", "utf8");
  }

  fs.writeFileSync(
    hba,
    [
      "# YUVI private cluster: localhost scram only. Trust is not permitted.",
      "local   all   all                   scram-sha-256",
      "host    all   all   127.0.0.1/32    scram-sha-256",
      "host    all   all   ::1/128         reject",
      ""
    ].join("\n"),
    "utf8"
  );
  restrictPathToCurrentUser(hba);
}

export function buildPostgresStartCommand(
  layout: PostgresLayout,
  distribution: PostgresDistribution,
  port: number,
  clusterId: string
): import("./types.js").StartCommandSpec {
  const marker = `yuvi-pg-${clusterId}`;
  return {
    file: distribution.postgres,
    args: [
      "-D",
      layout.data,
      "-p",
      String(port),
      "-h",
      PRIVATE_POSTGRES_HOST,
      "-c",
      "listen_addresses=127.0.0.1",
      "-c",
      `unix_socket_directories=${layout.runtime}`,
      "-c",
      `cluster_name=${marker}`
    ],
    cwd: layout.runtime,
    env: {
      PGDATA: layout.data
    },
    commandMarker: marker
  };
}

export function createYuviDatabase(input: {
  layout: PostgresLayout;
  distribution: PostgresDistribution;
}): { ok: boolean; message: string } {
  return createYuviDatabaseSingleUser(input);
}

export function createYuviDatabaseSingleUser(input: {
  layout: PostgresLayout;
  distribution: PostgresDistribution;
}): { ok: boolean; message: string } {
  const result = spawnSync(
    input.distribution.postgres,
    ["--single", "-D", input.layout.data, "postgres"],
    {
      input: `CREATE DATABASE ${PRIVATE_POSTGRES_DATABASE};\n`,
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true
    }
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status === 0 || /already exists/i.test(output)) {
    return { ok: true, message: "yuvi database ready" };
  }
  return { ok: false, message: "CREATE DATABASE failed" };
}

type SqlClient = {
  connect(): Promise<void>;
  query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
};

async function createSqlClient(input: {
  port: number;
  password: string;
  database: string;
}): Promise<SqlClient> {
  const mod = (await import("pg")) as {
    Client: new (config: Record<string, unknown>) => SqlClient;
  };
  return new mod.Client({
    host: PRIVATE_POSTGRES_HOST,
    port: input.port,
    user: PRIVATE_POSTGRES_USER,
    password: input.password,
    database: input.database,
    connectionTimeoutMillis: 4_000
  });
}

export async function execAuthenticatedSql(input: {
  distribution: PostgresDistribution;
  port: number;
  password: string;
  database?: string;
  sql: string;
}): Promise<{ ok: boolean; output: string }> {
  void input.distribution;
  const client = await createSqlClient({
    port: input.port,
    password: input.password,
    database: input.database ?? PRIVATE_POSTGRES_DATABASE
  });
  try {
    await client.connect();
    const result = await client.query(input.sql);
    const output = result.rows
      .map((row) =>
        Object.values(row)
          .map((value) => String(value ?? ""))
          .join("|")
      )
      .join("\n");
    return { ok: true, output };
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) };
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function pingPostgres(input: {
  layout: PostgresLayout;
  distribution: PostgresDistribution;
  port: number;
  password: string;
  clusterId: string;
}): Promise<boolean> {
  const probed = await execAuthenticatedSql({
    distribution: input.distribution,
    port: input.port,
    password: input.password,
    database: PRIVATE_POSTGRES_DATABASE,
    sql: "SELECT current_setting('server_version_num') AS version, current_setting('cluster_name') AS cluster"
  });
  if (!probed.ok) return false;
  const line = probed.output.trim().split(/\r?\n/)[0] ?? "";
  const [versionRaw, clusterName] = line.split("|").map((part) => part.trim());
  const version = Number.parseInt(versionRaw ?? "", 10);
  const major = Number.isInteger(version) ? Math.floor(version / 10000) : NaN;
  return major === PRIVATE_POSTGRES_MAJOR && clusterName === `yuvi-pg-${input.clusterId}`;
}

export function runSingleUserSql(input: {
  layout: PostgresLayout;
  distribution: PostgresDistribution;
  database: string;
  sql: string;
}): { ok: boolean; output: string } {
  const result = spawnSync(
    input.distribution.postgres,
    ["--single", "-D", input.layout.data, input.database],
    {
      input: `${input.sql}\n`,
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true
    }
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { ok: result.status === 0, output };
}

export function stopPostgresFast(input: {
  layout: PostgresLayout;
  distribution: PostgresDistribution;
}): boolean {
  const result = spawnSync(
    input.distribution.pgCtl,
    ["stop", "-D", input.layout.data, "-m", "fast", "-w", "-t", "10"],
    { encoding: "utf8", timeout: 20_000, windowsHide: true, shell: false }
  );
  return result.status === 0;
}

function sanitizeInitOutput(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 180);
}

export function assertPgdataInsideLayout(layout: PostgresLayout): boolean {
  return pathsEqual(canonicalPath(path.dirname(layout.data)), layout.root);
}
