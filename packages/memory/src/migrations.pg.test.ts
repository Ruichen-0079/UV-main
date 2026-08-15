/**
 * Real PostgreSQL 16 acceptance for the D2 migration engine.
 * Skips only when no PG 16 distribution is available. A declared
 * YUVI_POSTGRES_HOME that is not usable fails the file instead of skipping.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import {
  MigrationError,
  collectDatabaseInventory,
  defaultMigrationsDir,
  loadMigrationRegistry,
  migrateYuviSchema,
  normalizeInventory
} from "./migrations.js";

function discoverPg16Home(): string | null {
  const explicit = process.env["YUVI_POSTGRES_HOME"]?.trim();
  if (explicit) return explicit;
  const cached = path.join(os.tmpdir(), "yuvi-postgres-16-dist");
  if (fs.existsSync(path.join(cached, "bin", "postgres"))) return cached;
  return null;
}

const pgHome = discoverPg16Home();
if (process.env["YUVI_POSTGRES_HOME"]) {
  const explicit = process.env["YUVI_POSTGRES_HOME"].trim();
  if (!fs.existsSync(path.join(explicit, "bin", "postgres"))) {
    throw new Error("YUVI_POSTGRES_HOME is set but does not contain a PostgreSQL distribution.");
  }
  const version = spawnSync(path.join(explicit, "bin", "postgres"), ["--version"], {
    encoding: "utf8"
  });
  const text = `${version.stdout ?? ""}\n${version.stderr ?? ""}`;
  if (!text.includes("16.")) {
    throw new Error(`YUVI_POSTGRES_HOME is set but is not PostgreSQL 16: ${JSON.stringify(text)}`);
  }
}

const describePg = pgHome ? describe : describe.skip;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate a TCP port."));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
    server.on("error", reject);
  });
}

function writeVectorStub(extensionDir: string): void {
  fs.writeFileSync(
    path.join(extensionDir, "vector.control"),
    "comment = 'isolated YUVI D2 capability stub'\ndefault_version = '0.1.0'\nrelocatable = true\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(extensionDir, "vector--0.1.0.sql"),
    "CREATE TYPE vector AS (yuvi_test_stub real);\n",
    "utf8"
  );
}

function makeOverlayHome(realHome: string): string {
  const overlay = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-overlay-"));
  fs.mkdirSync(path.join(overlay, "bin"));
  for (const name of ["postgres", "initdb", "pg_ctl"]) {
    const source = path.join(realHome, "bin", name);
    const dest = path.join(overlay, "bin", name);
    fs.copyFileSync(source, dest);
    fs.chmodSync(dest, 0o755);
  }
  fs.symlinkSync(path.join(realHome, "lib"), path.join(overlay, "lib"));
  fs.cpSync(path.join(realHome, "share"), path.join(overlay, "share"), { recursive: true });
  return overlay;
}

class PgCluster {
  constructor(
    readonly home: string,
    readonly root: string,
    readonly dataDir: string,
    readonly port: number,
    private child: ChildProcess
  ) {}

  url(database: string): string {
    return `postgres://yuvi@127.0.0.1:${this.port}/${database}`;
  }

  async connect(database: string): Promise<Client> {
    const client = new Client({
      connectionString: this.url(database),
      connectionTimeoutMillis: 5_000
    });
    await client.connect();
    return client;
  }

  async createDatabase(name: string): Promise<string> {
    const client = await this.connect("postgres");
    try {
      await client.query(`CREATE DATABASE ${name}`);
    } finally {
      await client.end();
    }
    return this.url(name);
  }

  async dropDatabase(name: string): Promise<void> {
    const client = await this.connect("postgres");
    try {
      await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } finally {
      await client.end();
    }
  }

  async stop(): Promise<void> {
    const pgCtl = path.join(this.home, "bin", "pg_ctl");
    spawnSync(pgCtl, ["stop", "-D", this.dataDir, "-m", "fast", "-w", "-t", "10"], {
      encoding: "utf8",
      timeout: 20_000
    });
    if (this.child.pid && !this.child.killed) {
      try {
        this.child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
    fs.rmSync(this.root, { recursive: true, force: true });
  }
}

async function startCluster(home: string): Promise<PgCluster> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-mig-pg-"));
  const dataDir = path.join(root, "data");
  const runtime = path.join(root, "runtime");
  fs.mkdirSync(runtime, { recursive: true });
  const initdb = path.join(home, "bin", "initdb");
  const init = spawnSync(
    initdb,
    ["-D", dataDir, "--username=yuvi", "--auth-local=trust", "--auth-host=trust", "--no-sync"],
    { encoding: "utf8", timeout: 60_000 }
  );
  if (init.status !== 0) {
    throw new Error(`initdb failed: ${init.stderr || init.stdout}`);
  }
  const port = await freePort();
  const postgres = path.join(home, "bin", "postgres");
  const child = spawn(
    postgres,
    [
      "-D",
      dataDir,
      "-p",
      String(port),
      "-h",
      "127.0.0.1",
      "-k",
      runtime,
      "-c",
      "listen_addresses=127.0.0.1"
    ],
    { stdio: "ignore" }
  );
  const cluster = new PgCluster(home, root, dataDir, port, child);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const client = await cluster.connect("postgres");
      await client.end();
      return cluster;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  await cluster.stop();
  throw new Error("PostgreSQL did not become ready.");
}

async function inventoryOf(url: string) {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    return normalizeInventory(
      await collectDatabaseInventory(async (sql, params) => {
        const result = params ? await client.query(sql, params) : await client.query(sql);
        return { rows: result.rows as Array<Record<string, unknown>> };
      })
    );
  } finally {
    await client.end();
  }
}

async function historyNames(url: string): Promise<string[]> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    const result = await client.query(
      "SELECT name FROM public.yuvi_schema_migrations ORDER BY name"
    );
    return result.rows.map((row) => String((row as { name: string }).name));
  } finally {
    await client.end();
  }
}

async function execSql(url: string, sql: string): Promise<void> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

describePg("D2 real PG16 migration engine", () => {
  let realCluster: PgCluster;
  let overlayHome: string;
  let overlayCluster: PgCluster;
  let dbSerial = 0;
  const leftovers: string[] = [];

  beforeAll(async () => {
    if (!pgHome) throw new Error("PostgreSQL 16 distribution missing");
    realCluster = await startCluster(pgHome);
    overlayHome = makeOverlayHome(pgHome);
    overlayCluster = await startCluster(overlayHome);
  }, 120_000);

  afterAll(async () => {
    if (realCluster) await realCluster.stop();
    if (overlayCluster) await overlayCluster.stop();
    if (overlayHome) fs.rmSync(overlayHome, { recursive: true, force: true });
  }, 30_000);

  afterEach(async () => {
    for (const name of leftovers.splice(0)) {
      await realCluster?.dropDatabase(name).catch(() => undefined);
      await overlayCluster?.dropDatabase(name).catch(() => undefined);
    }
  });

  async function freshDb(cluster: PgCluster): Promise<{ name: string; url: string }> {
    dbSerial += 1;
    const name = `d2_${dbSerial}`;
    leftovers.push(name);
    const url = await cluster.createDatabase(name);
    return { name, url };
  }

  it("A/B: empty database migrates core history and postconditions", async () => {
    const { url } = await freshDb(realCluster);
    const first = await migrateYuviSchema({ databaseUrl: url });
    expect(first.diagnostics.classification).toBe("B");
    expect(first.diagnostics.schemaReady).toBe(true);
    expect(first.diagnostics.memorySearchReady).toBe(false);
    expect(first.recorded).toEqual([
      "006_conversation_v1.sql",
      "007_conversation_streaming.sql",
      "008_finalized_ingestion_ledger_v1.sql",
      "009_finalized_ingestion_work_discovery_v1.sql"
    ]);
    expect(first.diagnostics.vectorAvailable).toBe(false);
  }, 60_000);

  it("B: rerun is a checksum-verified no-op", async () => {
    const { url } = await freshDb(realCluster);
    const first = await migrateYuviSchema({ databaseUrl: url });
    const before = await historyNames(url);
    const second = await migrateYuviSchema({ databaseUrl: url });
    expect(second.appliedNow).toEqual([]);
    expect(await historyNames(url)).toEqual(before);
    expect(second.diagnostics.schemaReady).toBe(true);
    expect(first.recorded).toEqual(second.recorded);
  }, 60_000);

  it("C: two runners serialize and do not duplicate history", async () => {
    const { url } = await freshDb(realCluster);
    const [left, right] = await Promise.all([
      migrateYuviSchema({ databaseUrl: url }),
      migrateYuviSchema({ databaseUrl: url })
    ]);
    expect(left.diagnostics.schemaReady).toBe(true);
    expect(right.diagnostics.schemaReady).toBe(true);
    const names = await historyNames(url);
    expect(names).toEqual([
      "006_conversation_v1.sql",
      "007_conversation_streaming.sql",
      "008_finalized_ingestion_ledger_v1.sql",
      "009_finalized_ingestion_work_discovery_v1.sql"
    ]);
  }, 60_000);

  it("D/E: failing migration rolls back and retry succeeds", async () => {
    const { url } = await freshDb(realCluster);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-fail-mig-"));
    fs.writeFileSync(path.join(dir, "006_ok.sql"), "CREATE TABLE IF NOT EXISTS yuvi_ok(id int);\n");
    fs.writeFileSync(
      path.join(dir, "007_fail.sql"),
      "DO $$ BEGIN RAISE EXCEPTION 'yuvi-test-boom'; END $$;\n"
    );
    await expect(migrateYuviSchema({ databaseUrl: url, migrationsDir: dir })).rejects.toMatchObject(
      {
        code: "MIGRATION_FAILED"
      }
    );
    const names = await historyNames(url);
    expect(names).toEqual(["006_ok.sql"]);
    fs.writeFileSync(
      path.join(dir, "007_fail.sql"),
      "CREATE TABLE IF NOT EXISTS yuvi_retry(id int);\n"
    );
    const retry = await migrateYuviSchema({ databaseUrl: url, migrationsDir: dir });
    expect(retry.appliedNow).toEqual(["007_fail.sql"]);
    expect(await historyNames(url)).toEqual(["006_ok.sql", "007_fail.sql"]);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("F: complete legacy 009 without history records 001-009 without executing SQL", async () => {
    const { url } = await freshDb(overlayCluster);
    writeVectorStub(path.join(overlayHome, "share", "postgresql", "extension"));
    const registry = await loadMigrationRegistry(defaultMigrationsDir());
    for (const migration of registry) {
      await execSql(url, migration.sql);
    }
    const before = await inventoryOf(url);
    const result = await migrateYuviSchema({ databaseUrl: url });
    expect(result.diagnostics.classification).toBe("C");
    expect(result.recorded).toEqual(registry.map((item) => item.name));
    const after = await inventoryOf(url);
    expect(after.relations.some((rel) => rel.name === "yuvi_schema_migrations")).toBe(true);
    expect(after.extensions).toEqual(expect.arrayContaining(before.extensions));
  }, 90_000);

  it("G: partial Yuvi is refused with identical inventory", async () => {
    const { url } = await freshDb(realCluster);
    await execSql(url, "CREATE TABLE conversation_sessions (id text primary key)");
    const before = await inventoryOf(url);
    await expect(migrateYuviSchema({ databaseUrl: url })).rejects.toMatchObject({
      code: "PARTIAL_YUVI_SCHEMA"
    });
    expect(await inventoryOf(url)).toEqual(before);
    await expect(historyNames(url)).rejects.toThrow();
  }, 60_000);

  it("H: foreign database is refused with identical inventory", async () => {
    const { url } = await freshDb(realCluster);
    await execSql(url, "CREATE TABLE app_users (id int primary key, email text)");
    const before = await inventoryOf(url);
    await expect(migrateYuviSchema({ databaseUrl: url })).rejects.toMatchObject({
      code: "FOREIGN_DATABASE"
    });
    expect(await inventoryOf(url)).toEqual(before);
  }, 60_000);

  it("I: empty valid history resumes as A2", async () => {
    const { url } = await freshDb(realCluster);
    await execSql(
      url,
      `CREATE TABLE public.yuvi_schema_migrations (
        name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL
      )`
    );
    const result = await migrateYuviSchema({ databaseUrl: url });
    expect(result.diagnostics.classification).toBe("A2");
    expect(result.diagnostics.schemaReady).toBe(true);
    expect(result.recorded).toContain("006_conversation_v1.sql");
  }, 60_000);

  it("J: complete legacy plus empty history resumes as A3", async () => {
    const { url } = await freshDb(overlayCluster);
    writeVectorStub(path.join(overlayHome, "share", "postgresql", "extension"));
    const registry = await loadMigrationRegistry(defaultMigrationsDir());
    for (const migration of registry) {
      await execSql(url, migration.sql);
    }
    await execSql(
      url,
      `CREATE TABLE public.yuvi_schema_migrations (
        name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL
      )`
    );
    const result = await migrateYuviSchema({ databaseUrl: url });
    expect(result.diagnostics.classification).toBe("A3");
    expect(result.recorded).toEqual(registry.map((item) => item.name));
  }, 90_000);

  it("K: vector unavailable records exactly 006-009 and is schema_ready", async () => {
    const { url } = await freshDb(realCluster);
    const result = await migrateYuviSchema({ databaseUrl: url });
    expect(result.diagnostics.vectorAvailable).toBe(false);
    expect(result.recorded).toEqual([
      "006_conversation_v1.sql",
      "007_conversation_streaming.sql",
      "008_finalized_ingestion_ledger_v1.sql",
      "009_finalized_ingestion_work_discovery_v1.sql"
    ]);
    expect(result.diagnostics.schemaReady).toBe(true);
    expect(result.diagnostics.memorySearchReady).toBe(false);
    expect(result.diagnostics.memorySearch.status).toBe("unavailable");
  }, 60_000);

  it("L: later vector availability applies exactly 001-005 and does not replay 006-009", async () => {
    const { url } = await freshDb(overlayCluster);
    const extensionDir = path.join(overlayHome, "share", "postgresql", "extension");
    for (const name of ["vector.control", "vector--0.1.0.sql"]) {
      fs.rmSync(path.join(extensionDir, name), { force: true });
    }
    const first = await migrateYuviSchema({ databaseUrl: url });
    expect(first.recorded).toEqual([
      "006_conversation_v1.sql",
      "007_conversation_streaming.sql",
      "008_finalized_ingestion_ledger_v1.sql",
      "009_finalized_ingestion_work_discovery_v1.sql"
    ]);
    writeVectorStub(path.join(overlayHome, "share", "postgresql", "extension"));
    const second = await migrateYuviSchema({ databaseUrl: url });
    expect(second.appliedNow).toEqual([
      "001_init_memory.sql",
      "002_postgres_search_v2.sql",
      "003_embedding_pgvector_v1.sql",
      "004_ann_vector_index_v1.sql",
      "005_identity_retention_v1.sql"
    ]);
    expect(second.recorded).toHaveLength(9);
    expect(second.diagnostics.schemaReady).toBe(true);
  }, 90_000);

  it("M: checksum mismatch refuses before any new file", async () => {
    const { url } = await freshDb(realCluster);
    await migrateYuviSchema({ databaseUrl: url });
    const before = await inventoryOf(url);
    const beforeHistory = await historyNames(url);
    await execSql(
      url,
      `UPDATE public.yuvi_schema_migrations
       SET checksum = 'deadbeef'
       WHERE name = '006_conversation_v1.sql'`
    );
    await expect(migrateYuviSchema({ databaseUrl: url })).rejects.toMatchObject({
      code: "MIGRATION_CHECKSUM_MISMATCH"
    });
    const after = await inventoryOf(url);
    expect(after).toEqual(before);
    expect(await historyNames(url)).toEqual(beforeHistory);
  }, 60_000);

  it("N: unknown history row refuses before mutation", async () => {
    const { url } = await freshDb(realCluster);
    await migrateYuviSchema({ databaseUrl: url });
    const before = await inventoryOf(url);
    await execSql(
      url,
      `INSERT INTO public.yuvi_schema_migrations(name, checksum, applied_at)
       VALUES ('999_unknown.sql', 'abc', now())`
    );
    await expect(migrateYuviSchema({ databaseUrl: url })).rejects.toMatchObject({
      code: "UNKNOWN_MIGRATION"
    });
    expect(await inventoryOf(url)).toEqual(before);
  }, 60_000);

  it("connection interruption rolls back, releases the lock, and is retryable", async () => {
    const { url } = await freshDb(realCluster);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-crash-mig-"));
    fs.writeFileSync(
      path.join(dir, "006_sleep.sql"),
      "SELECT pg_sleep(20);\nCREATE TABLE IF NOT EXISTS yuvi_crash(id int);\n"
    );
    const migrating = migrateYuviSchema({ databaseUrl: url, migrationsDir: dir }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    );
    const killer = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    await killer.connect();
    const deadline = Date.now() + 10_000;
    let killed = false;
    while (Date.now() < deadline) {
      const activity = await killer.query(
        `SELECT pid FROM pg_stat_activity
         WHERE datname = current_database()
           AND pid <> pg_backend_pid()
           AND query ILIKE '%pg_sleep%'`
      );
      const pid = activity.rows[0]?.["pid"];
      if (typeof pid === "number") {
        await killer.query("SELECT pg_terminate_backend($1)", [pid]);
        killed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await killer.end();
    expect(killed).toBe(true);
    const outcome = await migrating;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBeInstanceOf(MigrationError);
    expect(await historyNames(url)).toEqual([]);
    const lock = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    await lock.connect();
    const locks = await lock.query(
      `SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND granted AND pid <> pg_backend_pid()`
    );
    expect(locks.rows).toEqual([]);
    await lock.end();
    const retry = await migrateYuviSchema({ databaseUrl: url });
    expect(retry.diagnostics.classification).toBe("A2");
    expect(retry.diagnostics.schemaReady).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("external vector-not-creatable still reaches core schema_ready", async () => {
    const { name, url } = await freshDb(overlayCluster);
    writeVectorStub(path.join(overlayHome, "share", "postgresql", "extension"));
    const role = `lim_${name}`;
    await execSql(overlayCluster.url("postgres"), `CREATE ROLE ${role} LOGIN`);
    await execSql(
      overlayCluster.url("postgres"),
      `GRANT CONNECT, CREATE ON DATABASE ${name} TO ${role}`
    );
    await execSql(url, `GRANT USAGE, CREATE ON SCHEMA public TO ${role}`);
    const limitedUrl = `postgres://${role}@127.0.0.1:${overlayCluster.port}/${name}`;
    const probe = new Client({ connectionString: limitedUrl, connectionTimeoutMillis: 5_000 });
    await probe.connect();
    const available = await probe.query(
      "SELECT 1 FROM pg_available_extensions WHERE name = 'vector'"
    );
    const installed = await probe.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
    await probe.end();
    expect(available.rows.length).toBeGreaterThan(0);
    expect(installed.rows).toHaveLength(0);

    const result = await migrateYuviSchema({ databaseUrl: limitedUrl });
    expect(result.diagnostics.schemaReady).toBe(true);
    expect(result.diagnostics.memorySearch.status).toBe("failed");
    expect(result.diagnostics.memorySearch.failedMigration).toBe("001_init_memory.sql");
    expect(result.diagnostics.memorySearch.errorCode).toBe("MIGRATION_FAILED");
    expect(await historyNames(url)).toEqual([
      "006_conversation_v1.sql",
      "007_conversation_streaming.sql",
      "008_finalized_ingestion_ledger_v1.sql",
      "009_finalized_ingestion_work_discovery_v1.sql"
    ]);
    const objects = await inventoryOf(url);
    expect(objects.relations.map((rel) => rel.name)).toEqual(
      expect.arrayContaining([
        "conversation_sessions",
        "conversation_messages",
        "finalized_ingestion_turns",
        "finalized_ingestion_events"
      ])
    );
    expect(objects.relations.some((rel) => rel.name === "memories")).toBe(false);

    const recovered = await migrateYuviSchema({ databaseUrl: url });
    expect(recovered.appliedNow).toEqual([
      "001_init_memory.sql",
      "002_postgres_search_v2.sql",
      "003_embedding_pgvector_v1.sql",
      "004_ann_vector_index_v1.sql",
      "005_identity_retention_v1.sql"
    ]);
    expect(recovered.diagnostics.schemaReady).toBe(true);
    expect(recovered.diagnostics.memorySearch.status).toBe("ready");
    expect(await historyNames(url)).toHaveLength(9);
  }, 90_000);

  it("keeps core ready after a mid memory_search failure and retries from the failed file", async () => {
    const { url } = await freshDb(overlayCluster);
    writeVectorStub(path.join(overlayHome, "share", "postgresql", "extension"));
    const registry = await loadMigrationRegistry(defaultMigrationsDir());
    const failing = registry.map((migration) =>
      migration.name.startsWith("002_")
        ? { name: migration.name, sql: "DO $$ BEGIN RAISE EXCEPTION 'yuvi-optional-boom'; END $$;" }
        : { name: migration.name, sql: migration.sql }
    );
    const first = await migrateYuviSchema({ databaseUrl: url, migrations: failing });
    expect(first.diagnostics.schemaReady).toBe(true);
    expect(first.diagnostics.memorySearch.status).toBe("failed");
    expect(first.diagnostics.memorySearch.failedMigration).toBe("002_postgres_search_v2.sql");
    expect(await historyNames(url)).toEqual([
      "001_init_memory.sql",
      "006_conversation_v1.sql",
      "007_conversation_streaming.sql",
      "008_finalized_ingestion_ledger_v1.sql",
      "009_finalized_ingestion_work_discovery_v1.sql"
    ]);
    const retry = await migrateYuviSchema({ databaseUrl: url });
    expect(retry.appliedNow[0]).toBe("002_postgres_search_v2.sql");
    expect(retry.appliedNow).not.toContain("006_conversation_v1.sql");
    expect(retry.diagnostics.schemaReady).toBe(true);
    expect(retry.diagnostics.memorySearch.status).toBe("ready");
  }, 90_000);

  it("keeps a core-track failure fail-closed without a history row for the failed file", async () => {
    const { url } = await freshDb(realCluster);
    const registry = await loadMigrationRegistry(defaultMigrationsDir());
    const failing = registry.map((migration) =>
      migration.name.startsWith("007_")
        ? { name: migration.name, sql: "DO $$ BEGIN RAISE EXCEPTION 'yuvi-core-boom'; END $$;" }
        : { name: migration.name, sql: migration.sql }
    );
    await expect(
      migrateYuviSchema({ databaseUrl: url, migrations: failing })
    ).rejects.toMatchObject({
      code: "MIGRATION_FAILED"
    });
    expect(await historyNames(url)).toEqual(["006_conversation_v1.sql"]);
  }, 60_000);

  it("serializes two runners when memory_search later becomes eligible", async () => {
    const { url } = await freshDb(overlayCluster);
    const extensionDir = path.join(overlayHome, "share", "postgresql", "extension");
    for (const name of ["vector.control", "vector--0.1.0.sql"]) {
      fs.rmSync(path.join(extensionDir, name), { force: true });
    }
    await migrateYuviSchema({ databaseUrl: url });
    writeVectorStub(extensionDir);
    const [left, right] = await Promise.all([
      migrateYuviSchema({ databaseUrl: url }),
      migrateYuviSchema({ databaseUrl: url })
    ]);
    expect(left.diagnostics.schemaReady).toBe(true);
    expect(right.diagnostics.schemaReady).toBe(true);
    expect(await historyNames(url)).toHaveLength(9);
    const applied = [...left.appliedNow, ...right.appliedNow].sort();
    expect(applied.filter((name) => name.startsWith("006_"))).toEqual([]);
  }, 90_000);
});
