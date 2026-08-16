import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  formatAutomaticBootstrapFailureDiagnostic,
  startAutomaticSupervisorBootstrap
} from "./supervisor-auto-bootstrap.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

test("automatic bootstrap success still emits the existing bootstrap event", async () => {
  const logs = [];
  await startAutomaticSupervisorBootstrap(
    {
      bootstrap: async () => ({
        services: [{ id: "postgres", status: "healthy", ownership: "owned" }]
      })
    },
    { log: (line) => logs.push(String(line)) }
  );
  assert.equal(logs.length, 1);
  assert.match(logs[0], /"event":"supervisor.bootstrap"/);
  assert.match(logs[0], /"id":"postgres"/);
});

test("automatic bootstrap rejection is handled without exit or rethrow", async () => {
  const logs = [];
  const previousExit = process.exitCode;
  const failure = Object.assign(new Error("The private PostgreSQL target is not reachable."), {
    name: "MigrationError",
    code: "DATABASE_UNAVAILABLE"
  });
  const supervisor = {
    async bootstrap() {
      throw failure;
    },
    snapshot() {
      return {
        postgres: { mode: "private", migration: { schemaReady: false, memorySearchStatus: null } },
        services: []
      };
    }
  };
  await startAutomaticSupervisorBootstrap(supervisor, { log: (line) => logs.push(String(line)) });
  assert.equal(process.exitCode, previousExit);
  const diagnostic = JSON.parse(logs[0]);
  assert.equal(diagnostic.event, "supervisor.bootstrap_failed");
  assert.equal(diagnostic.errorCode, "DATABASE_UNAVAILABLE");
  assert.equal(diagnostic.errorName, "MigrationError");
  assert.equal(diagnostic.schemaReady, false);
  assert.equal(diagnostic.postgresMode, "private");
});

test("automatic bootstrap failure handler never rethrows", async () => {
  await startAutomaticSupervisorBootstrap(
    {
      async bootstrap() {
        throw Object.assign(new Error("boom"), { code: "DATABASE_UNAVAILABLE" });
      },
      snapshot() {
        throw new Error("snapshot failed");
      }
    },
    {
      log() {
        throw new Error("log failed");
      }
    }
  );
});

test("failure diagnostic is bounded and redacts secrets", () => {
  const diagnostic = formatAutomaticBootstrapFailureDiagnostic(
    Object.assign(
      new Error(
        "DATABASE_URL=postgres://yuvi:super-secret@127.0.0.1/yuvi YUVI_POSTGRES_PASSWORD=super-secret MEM0_PG_CONNECTION_STRING=postgres://mem0 Bearer control-token"
      ),
      { name: "MigrationError", code: "DATABASE_UNAVAILABLE" }
    )
  );
  const text = JSON.stringify(diagnostic);
  assert.doesNotMatch(
    text,
    /super-secret|control-token|postgres:\/\/yuvi|DATABASE_URL=postgres:\/\/yuvi/
  );
  assert.match(diagnostic.message, /\[redacted\]/);
  assert.equal(diagnostic.errorCode, "DATABASE_UNAVAILABLE");
});

test("later explicit bootstrap remains possible after automatic rejection", async () => {
  const logs = [];
  let calls = 0;
  const supervisor = {
    async bootstrap() {
      calls += 1;
      if (calls === 1) {
        throw Object.assign(new Error("The private PostgreSQL target is not reachable."), {
          name: "MigrationError",
          code: "DATABASE_UNAVAILABLE"
        });
      }
      return { services: [{ id: "postgres", status: "unavailable", ownership: "none" }] };
    },
    snapshot() {
      return { postgres: { mode: "private", migration: { schemaReady: false } } };
    }
  };
  await startAutomaticSupervisorBootstrap(supervisor, { log: (line) => logs.push(String(line)) });
  await startAutomaticSupervisorBootstrap(supervisor, { log: (line) => logs.push(String(line)) });
  assert.equal(calls, 2);
  assert.match(logs[0], /supervisor.bootstrap_failed/);
  assert.match(logs[1], /"event":"supervisor.bootstrap"/);
});

test("packaged and development entrypoints share the contained helper", () => {
  const packaged = fs.readFileSync(path.join(here, "yuvi-desktop-supervisor.packaged.mjs"), "utf8");
  const development = fs.readFileSync(path.join(here, "yuvi-desktop-supervisor.mts"), "utf8");
  const helper = fs.readFileSync(path.join(here, "supervisor-auto-bootstrap.mjs"), "utf8");
  for (const source of [packaged, development]) {
    assert.match(source, /startAutomaticSupervisorBootstrap\(supervisor\)/);
    assert.doesNotMatch(source, /void supervisor\.bootstrap\(\)\.then\(/);
  }
  assert.doesNotMatch(helper, /process\.exit|process\.exitCode/);
  assert.match(helper, /never rethrow/);
});
