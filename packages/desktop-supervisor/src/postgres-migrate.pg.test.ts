/**
 * Real PostgreSQL 16 acceptance for the Supervisor migration adapter.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { MigrationError } from "@companion/memory";
import {
  buildPrivateDatabaseUrl,
  migrateSupervisorPostgres,
  migrateSupervisorTarget
} from "./postgres-migrate.js";

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

async function freePort(): Promise<number> {
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
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
    server.on("error", reject);
  });
}

describePg("supervisor postgres-migrate PG16", () => {
  let port = 0;
  let dataDir = "";
  let child: ChildProcess | undefined;

  beforeAll(async () => {
    if (!pgHome) throw new Error("PostgreSQL 16 distribution missing");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-sup-mig-"));
    dataDir = path.join(root, "data");
    const runtime = path.join(root, "runtime");
    fs.mkdirSync(runtime, { recursive: true });
    const init = spawnSync(
      path.join(pgHome, "bin", "initdb"),
      ["-D", dataDir, "--username=yuvi", "--auth-local=trust", "--auth-host=trust", "--no-sync"],
      { encoding: "utf8", timeout: 60_000 }
    );
    if (init.status !== 0) throw new Error(init.stderr || init.stdout);
    port = await freePort();
    child = spawn(
      path.join(pgHome, "bin", "postgres"),
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
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        const client = new Client({
          connectionString: `postgres://yuvi@127.0.0.1:${port}/postgres`,
          connectionTimeoutMillis: 1_000
        });
        await client.connect();
        await client.end();
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw new Error("Supervisor adapter PostgreSQL did not become ready.");
  }, 90_000);

  afterAll(async () => {
    if (pgHome && dataDir) {
      spawnSync(
        path.join(pgHome, "bin", "pg_ctl"),
        ["stop", "-D", dataDir, "-m", "fast", "-w", "-t", "10"],
        {
          encoding: "utf8",
          timeout: 20_000
        }
      );
    }
    if (child?.pid && !child.killed) {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
    if (dataDir) fs.rmSync(path.dirname(dataDir), { recursive: true, force: true });
  }, 20_000);

  async function createDb(name: string): Promise<string> {
    const client = new Client({
      connectionString: `postgres://yuvi@127.0.0.1:${port}/postgres`,
      connectionTimeoutMillis: 5_000
    });
    await client.connect();
    await client.query(`CREATE DATABASE ${name}`);
    await client.end();
    return `postgres://yuvi@127.0.0.1:${port}/${name}`;
  }

  it("migrates an external target URL and does not log it", async () => {
    const url = await createDb("ext_ok");
    const logs: string[] = [];
    const result = await migrateSupervisorPostgres({
      databaseUrl: url,
      logger: { log: (message) => logs.push(String(message)) }
    });
    expect(result.ok).toBe(true);
    expect(result.schemaReady).toBe(true);
    expect(result.diagnostics.applied).toContain("006_conversation_v1.sql");
    expect(logs.join("\n")).not.toContain("postgres://");
    expect(JSON.stringify(result.diagnostics)).not.toContain("postgres://");
  }, 60_000);

  it("builds a private target URL from D1-owned fields and migrates it", async () => {
    const url = await createDb("priv_ok");
    const built = buildPrivateDatabaseUrl({
      host: "127.0.0.1",
      port,
      user: "yuvi",
      database: "priv_ok",
      password: ""
    });
    expect(built).toContain("127.0.0.1");
    const result = await migrateSupervisorTarget({
      kind: "private",
      host: "127.0.0.1",
      port,
      user: "yuvi",
      database: "priv_ok",
      password: ""
    });
    expect(result.schemaReady).toBe(true);
    expect(url).toContain("priv_ok");
  }, 60_000);

  it("refuses a foreign external database", async () => {
    const url = await createDb("ext_foreign");
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    await client.connect();
    await client.query("CREATE TABLE other_app(id int primary key)");
    await client.end();
    await expect(migrateSupervisorPostgres({ databaseUrl: url })).rejects.toBeInstanceOf(
      MigrationError
    );
  }, 60_000);
});
