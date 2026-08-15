/**
 * Real PostgreSQL 16 acceptance for the private-cluster substrate.
 * Identified by the `.pg.test.ts` suffix. Skips only when no PG 16
 * distribution is available; a declared YUVI_POSTGRES_HOME that is not
 * major 16 fails the file instead of skipping.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopSupervisor } from "./supervisor.js";
import { preparePrivatePostgres } from "./postgres-lifecycle.js";
import { resolvePostgresDistribution } from "./postgres-distribution.js";
import { layoutFromRoot, resolvePostgresLayout } from "./postgres-layout.js";
import { execAuthenticatedSql, inspectExistingCluster, pingPostgres } from "./postgres-cluster.js";
import { stopPrivatePostgresIfOwned } from "./postgres-ownership.js";
import { inspectProcess } from "./process-windows.js";
import type { SupervisorConfig } from "./types.js";

const tempDirs: string[] = [];
const supervisors: DesktopSupervisor[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) {
    await supervisor.shutdown();
  }
  for (const child of children.splice(0)) {
    if (child.pid && !child.killed) {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function discoverPg16Home(): string | null {
  const explicit = process.env["YUVI_POSTGRES_HOME"]?.trim();
  if (explicit) return explicit;
  const cached = path.join(os.tmpdir(), "yuvi-postgres-16-dist");
  if (fs.existsSync(path.join(cached, "bin", "postgres"))) return cached;
  return null;
}

const pgHome = discoverPg16Home();
const distribution = pgHome
  ? resolvePostgresDistribution(
      { YUVI_POSTGRES_HOME: pgHome },
      { mode: "development", repositoryRoot: pgHome }
    )
  : null;

if (process.env["YUVI_POSTGRES_HOME"] && distribution && !distribution.ok) {
  throw new Error(
    `YUVI_POSTGRES_HOME is set but is not a PostgreSQL 16 distribution: ${distribution.error.message}`
  );
}

const describePg = distribution?.ok ? describe : describe.skip;

function checksumTree(dir: string): string {
  const files: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const stat = fs.statSync(full);
        files.push(`${path.relative(dir, full)}:${stat.size}`);
      }
    }
  };
  walk(dir);
  return files.sort().join("|");
}

function persistenceConfig(
  pgHomeValue: string,
  dataRoot: string,
  startCommand: SupervisorConfig["postgresStart"],
  port: number,
  instanceId: string,
  token: string
): SupervisorConfig {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-sup-pg-"));
  tempDirs.push(stateDirectory);
  const env = {
    YUVI_POSTGRES_HOME: pgHomeValue,
    YUVI_POSTGRES_DATA_ROOT: dataRoot,
    YUVI_POSTGRES_MODE: "private"
  };
  const layout = resolvePostgresLayout(env, {});
  const resolved = resolvePostgresDistribution(env, {
    mode: "development",
    repositoryRoot: pgHomeValue
  });
  if (!resolved.ok) throw new Error(resolved.error.message);
  return {
    layout: { mode: "development", repositoryRoot: pgHomeValue },
    repositoryRoot: pgHomeValue,
    stateDirectory,
    instanceId,
    ownershipToken: token,
    controlToken: "b".repeat(64),
    controlHost: "127.0.0.1",
    controlPort: 0,
    env,
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
    postgresMode: "private",
    postgresLayout: layout,
    postgresDistribution: resolved.distribution,
    postgresStart: startCommand ?? null,
    postgresListenPort: port,
    postgresSecretAuthority: "development-file"
  };
}

describePg("private postgres real PG16 acceptance", () => {
  it("writes through an authenticated live connection and survives restart", async () => {
    if (!distribution?.ok || !pgHome) throw new Error("PostgreSQL 16 distribution missing");
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-persist-"));
    tempDirs.push(dataRoot);
    const env = {
      YUVI_POSTGRES_HOME: pgHome,
      YUVI_POSTGRES_DATA_ROOT: dataRoot,
      YUVI_POSTGRES_MODE: "private"
    };
    const layout = resolvePostgresLayout(env, {});
    const prepared = await preparePrivatePostgres({
      layout,
      distribution: distribution.distribution,
      env,
      authority: "development-file"
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const supervisor = new DesktopSupervisor(
      persistenceConfig(
        pgHome,
        dataRoot,
        prepared.startCommand,
        prepared.listen.port,
        "pg-a",
        "tok-a"
      )
    );
    supervisors.push(supervisor);
    await supervisor.bootstrap();
    expect(
      supervisor.snapshot().services.find((service) => service.id === "postgres")?.ownership
    ).toBe("owned");
    expect(
      await pingPostgres({
        layout: prepared.layout,
        distribution: distribution.distribution,
        port: prepared.listen.port,
        password: prepared.password,
        clusterId: prepared.marker.clusterId
      })
    ).toBe(true);

    const create = await execAuthenticatedSql({
      distribution: distribution.distribution,
      port: prepared.listen.port,
      password: prepared.password,
      sql: "CREATE TABLE yuvi_d1_probe(id int primary key, note text)"
    });
    expect(create.ok, create.output).toBe(true);
    const write = await execAuthenticatedSql({
      distribution: distribution.distribution,
      port: prepared.listen.port,
      password: prepared.password,
      sql: "INSERT INTO yuvi_d1_probe VALUES (1, 'survives-restart')"
    });
    expect(write.ok, write.output).toBe(true);

    await supervisor.shutdown();

    const restarted = new DesktopSupervisor(
      persistenceConfig(
        pgHome,
        dataRoot,
        prepared.startCommand,
        prepared.listen.port,
        "pg-b",
        "tok-b"
      )
    );
    supervisors.push(restarted);
    await restarted.bootstrap();
    const read = await execAuthenticatedSql({
      distribution: distribution.distribution,
      port: prepared.listen.port,
      password: prepared.password,
      sql: "SELECT note FROM yuvi_d1_probe WHERE id = 1;"
    });
    expect(read.ok, read.output).toBe(true);
    expect(read.output).toContain("survives-restart");
    await restarted.shutdown();
  }, 120_000);

  it("adopts a surviving postmaster after Supervisor disappearance", async () => {
    if (!distribution?.ok || !pgHome) throw new Error("PostgreSQL 16 distribution missing");
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-adopt-"));
    tempDirs.push(dataRoot);
    const env = {
      YUVI_POSTGRES_HOME: pgHome,
      YUVI_POSTGRES_DATA_ROOT: dataRoot,
      YUVI_POSTGRES_MODE: "private"
    };
    const layout = resolvePostgresLayout(env, {});
    const prepared = await preparePrivatePostgres({
      layout,
      distribution: distribution.distribution,
      env,
      authority: "development-file"
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const first = new DesktopSupervisor(
      persistenceConfig(
        pgHome,
        dataRoot,
        prepared.startCommand,
        prepared.listen.port,
        "adopt-a",
        "tok-a"
      )
    );
    supervisors.push(first);
    await first.bootstrap();
    const pidA =
      first.snapshot().services.find((service) => service.id === "postgres")?.pid ?? null;
    expect(pidA).toBeTruthy();
    const create = await execAuthenticatedSql({
      distribution: distribution.distribution,
      port: prepared.listen.port,
      password: prepared.password,
      sql: "CREATE TABLE yuvi_d1_adopt(id int primary key, note text)"
    });
    expect(create.ok, create.output).toBe(true);
    const write = await execAuthenticatedSql({
      distribution: distribution.distribution,
      port: prepared.listen.port,
      password: prepared.password,
      sql: "INSERT INTO yuvi_d1_adopt VALUES (1, 'adopted')"
    });
    expect(write.ok, write.output).toBe(true);

    const second = new DesktopSupervisor(
      persistenceConfig(
        pgHome,
        dataRoot,
        prepared.startCommand,
        prepared.listen.port,
        "adopt-b",
        "tok-b"
      )
    );
    supervisors.push(second);
    await second.bootstrap();
    const snap = second.snapshot();
    const postgres = snap.services.find((service) => service.id === "postgres");
    expect(postgres?.ownership).toBe("owned");
    expect(postgres?.status).toBe("healthy");
    expect(postgres?.pid).toBe(pidA);
    expect(snap.postgres?.port).toBe(prepared.listen.port);
    const read = await execAuthenticatedSql({
      distribution: distribution.distribution,
      port: prepared.listen.port,
      password: prepared.password,
      sql: "SELECT note FROM yuvi_d1_adopt WHERE id = 1;"
    });
    expect(read.ok, read.output).toBe(true);
    expect(read.output).toContain("adopted");
    await second.shutdown();
    expect(
      await pingPostgres({
        layout: prepared.layout,
        distribution: distribution.distribution,
        port: prepared.listen.port,
        password: prepared.password,
        clusterId: prepared.marker.clusterId
      })
    ).toBe(false);
  }, 120_000);

  it("refuses a foreign PGDATA without mutating it", async () => {
    if (!distribution?.ok || !pgHome) throw new Error("PostgreSQL 16 distribution missing");
    const foreignRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-foreign-"));
    tempDirs.push(foreignRoot);
    const data = path.join(foreignRoot, "data");
    fs.mkdirSync(data, { recursive: true });
    const pw = path.join(foreignRoot, "pw");
    fs.writeFileSync(pw, "foreign-pass\n", { mode: 0o600 });
    const init = spawnSync(
      distribution.distribution.initdb,
      ["-D", data, "--username=yuvi", "--auth-host=scram-sha-256", `--pwfile=${pw}`],
      { encoding: "utf8" }
    );
    expect(init.status, init.stderr ?? "").toBe(0);
    const before = checksumTree(foreignRoot);
    const layout = layoutFromRoot(foreignRoot);
    const inspected = inspectExistingCluster(layout);
    expect(inspected.ok).toBe(false);
    if (!inspected.ok) expect(inspected.code).toBe("POSTGRES_FOREIGN_PGDATA");
    const prepared = await preparePrivatePostgres({
      layout,
      distribution: distribution.distribution,
      env: { YUVI_POSTGRES_HOME: pgHome, YUVI_POSTGRES_DATA_ROOT: foreignRoot },
      authority: "development-file"
    });
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) expect(prepared.code).toBe("POSTGRES_FOREIGN_PGDATA");
    expect(checksumTree(foreignRoot)).toBe(before);
    expect(fs.existsSync(path.join(foreignRoot, "marker.json"))).toBe(false);
  }, 60_000);

  it("does not pg_ctl-stop a foreign postmaster", async () => {
    if (!distribution?.ok || !pgHome) throw new Error("PostgreSQL 16 distribution missing");
    const foreignRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-live-foreign-"));
    tempDirs.push(foreignRoot);
    const data = path.join(foreignRoot, "data");
    fs.mkdirSync(data, { recursive: true });
    const pw = path.join(foreignRoot, "pw");
    fs.writeFileSync(pw, "foreign-pass\n", { mode: 0o600 });
    const init = spawnSync(
      distribution.distribution.initdb,
      ["-D", data, "--username=yuvi", "--auth-host=scram-sha-256", `--pwfile=${pw}`],
      { encoding: "utf8" }
    );
    expect(init.status, init.stderr ?? "").toBe(0);
    const child = spawn(
      distribution.distribution.postgres,
      ["-D", data, "-h", "127.0.0.1", "-p", "55491"],
      { stdio: "ignore" }
    );
    children.push(child);
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(child.pid).toBeTruthy();
    const yuviRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-owned-root-"));
    tempDirs.push(yuviRoot);
    const layout = resolvePostgresLayout({ YUVI_POSTGRES_DATA_ROOT: yuviRoot }, {});
    let invoked = false;
    const result = stopPrivatePostgresIfOwned({
      layout,
      distribution: distribution.distribution,
      processInspection: inspectProcess(child.pid!),
      metadata: null,
      invokeStop: () => {
        invoked = true;
        return true;
      }
    });
    expect(result.invoked).toBe(false);
    expect(invoked).toBe(false);
    expect(child.exitCode).toBeNull();
    child.kill("SIGTERM");
  }, 60_000);
});
