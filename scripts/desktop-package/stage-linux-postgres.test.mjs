import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  stageLinuxPostgresDistribution,
  validateLinuxPostgresDistribution
} from "./stage-linux-postgres.mjs";

function distribution() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg16-dist-"));
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.mkdirSync(path.join(root, "share", "extension"), { recursive: true });
  fs.mkdirSync(path.join(root, "lib", "postgresql"), { recursive: true });
  for (const tool of ["postgres", "pg_ctl", "initdb", "psql"]) {
    fs.writeFileSync(path.join(root, "bin", tool), "ELF-placeholder", { mode: 0o755 });
  }
  fs.writeFileSync(
    path.join(root, "share", "extension", "vector.control"),
    "default_version = '0.8.1'\n"
  );
  fs.writeFileSync(path.join(root, "share", "extension", "vector--0.8.1.sql"), "select 1;\n");
  fs.writeFileSync(path.join(root, "lib", "postgresql", "vector.so"), "ELF-vector");
  fs.writeFileSync(path.join(root, "share", "extension", "pgcrypto.control"), "default_version = '1.3'\n");
  fs.writeFileSync(path.join(root, "share", "extension", "pgcrypto--1.3.sql"), "select 1;\n");
  fs.writeFileSync(path.join(root, "lib", "postgresql", "pgcrypto.so"), "ELF-pgcrypto");
  fs.writeFileSync(path.join(root, "share", "extension", "pg_trgm.control"), "default_version = '1.6'\n");
  for (const version of ["1.3", "1.3--1.4", "1.4--1.5", "1.5--1.6"]) {
    fs.writeFileSync(path.join(root, "share", "extension", `pg_trgm--${version}.sql`), "select 1;\n");
  }
  fs.writeFileSync(path.join(root, "lib", "postgresql", "pg_trgm.so"), "ELF-pg-trgm");
  return root;
}

const versionProbe = () => ({ status: 0, stdout: "postgres (PostgreSQL) 16.15\n", stderr: "" });

test("rejects the released distribution's missing migration dependency", () => {
  const root = distribution();
  try {
    fs.rmSync(path.join(root, "share", "extension", "pgcrypto.control"));
    assert.throws(() => validateLinuxPostgresDistribution(root, {spawnSyncImpl: versionProbe}), /pgcrypto/);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test("validates PostgreSQL 16 and the complete pgvector extension payload", () => {
  const root = distribution();
  try {
    const result = validateLinuxPostgresDistribution(root, { spawnSyncImpl: versionProbe });
    assert.equal(result.postgresMajor, 16);
    assert.equal(result.pgvectorVersion, "0.8.1");
    assert.match(result.vectorLibrary, /vector\.so$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("staging copies the explicit distribution and writes non-secret provenance", () => {
  const root = distribution();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg16-stage-"));
  const dest = path.join(out, "postgres");
  try {
    stageLinuxPostgresDistribution({ sourceRoot: root, destination: dest, spawnSyncImpl: versionProbe });
    assert.equal(fs.existsSync(path.join(dest, "bin", "postgres")), true);
    assert.equal(fs.existsSync(path.join(dest, "share", "extension", "vector.control")), true);
    const provenance = JSON.parse(
      fs.readFileSync(path.join(dest, "yuvi-postgres-distribution.json"), "utf8")
    );
    assert.equal(provenance.postgresMajor, 16);
    assert.equal(provenance.pgvectorVersion, "0.8.1");
    assert.equal(JSON.stringify(provenance).includes(root), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("fails closed when pgvector is incomplete", () => {
  const root = distribution();
  try {
    fs.rmSync(path.join(root, "lib", "postgresql", "vector.so"));
    assert.throws(
      () => validateLinuxPostgresDistribution(root, { spawnSyncImpl: versionProbe }),
      /vector\.so/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed when a PostgreSQL tool is not major 16", () => {
  const root = distribution();
  try {
    assert.throws(
      () =>
        validateLinuxPostgresDistribution(root, {
          spawnSyncImpl: () => ({ status: 0, stdout: "postgres (PostgreSQL) 15.9\n", stderr: "" })
        }),
      /major 16/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
