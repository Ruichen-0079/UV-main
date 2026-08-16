import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  aclGrantArguments,
  createClusterMarker,
  describeEscapedPgdata,
  describeUnsafePostgresDataRoot,
  ensurePostgresDirectories,
  layoutFromRoot,
  readClusterMarker,
  readInitializationState,
  resolvePostgresLayout,
  writeClusterMarker,
  writeInitializationState
} from "./postgres-layout.js";
import { inspectExistingCluster } from "./postgres-cluster.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("private postgres layout", () => {
  it("derives a user-writable layout from YUVI_POSTGRES_DATA_ROOT", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-root-"));
    tempDirs.push(root);
    const layout = resolvePostgresLayout({ YUVI_POSTGRES_DATA_ROOT: root });
    expect(layout.data.endsWith(`${path.sep}data`)).toBe(true);
    expect(layout.runtime.endsWith(`${path.sep}runtime`)).toBe(true);
    expect(layout.markerFile.endsWith("marker.json")).toBe(true);
    expect(describeUnsafePostgresDataRoot(layout.root)).toBeNull();
  });

  it("rejects Program Files, resource, and repository roots", () => {
    expect(describeUnsafePostgresDataRoot("C:\\", {})).toContain("volume root");
    expect(describeUnsafePostgresDataRoot("C:\\Windows\\YUVI", {})).toContain("Windows");
    expect(describeUnsafePostgresDataRoot("\\\\server\\share\\yuvi", {})).toContain("UNC");
    expect(describeUnsafePostgresDataRoot(os.homedir(), {})).toContain("user profile root");
    expect(describeUnsafePostgresDataRoot("C:\\Program Files\\YUVI\\Postgres", {})).toContain(
      "Program Files"
    );
    expect(
      describeUnsafePostgresDataRoot(os.tmpdir(), { packaged: true, tempRoot: os.tmpdir() })
    ).toContain("temporary");
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-repo-"));
    const resource = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-res-"));
    tempDirs.push(repo, resource);
    expect(
      describeUnsafePostgresDataRoot(path.join(resource, "Postgres"), { resourceRoot: resource })
    ).toContain("resource");
    expect(
      describeUnsafePostgresDataRoot(path.join(repo, "Postgres"), { repositoryRoot: repo })
    ).toContain("repository");
  });

  it("writes a durable YUVI cluster marker that is not inferred from PG_VERSION", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-mark-"));
    tempDirs.push(root);
    const layout = layoutFromRoot(root);
    ensurePostgresDirectories(layout);
    const marker = createClusterMarker(layout);
    writeClusterMarker(layout, marker);
    const read = readClusterMarker(layout);
    expect(read?.product).toBe("yuvi");
    expect(read?.postgresMajor).toBe(16);
    expect(read?.clusterId).toBe(marker.clusterId);
    fs.writeFileSync(path.join(layout.data, "PG_VERSION"), "16\n");
    const withoutMarker = layoutFromRoot(fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-nomark-")));
    tempDirs.push(withoutMarker.root);
    ensurePostgresDirectories(withoutMarker);
    fs.writeFileSync(path.join(withoutMarker.data, "PG_VERSION"), "16\n");
    const inspected = inspectExistingCluster(withoutMarker);
    expect(inspected.ok).toBe(false);
    if (!inspected.ok) expect(inspected.code).toBe("POSTGRES_FOREIGN_PGDATA");
  });

  it("builds inheritable directory ACL arguments without Everyone write", () => {
    const args = aclGrantArguments("C:\\YUVI\\Postgres", "alice", "directory");
    expect(args).toEqual(["C:\\YUVI\\Postgres", "/inheritance:r", "/grant:r", "alice:(OI)(CI)(F)"]);
    const joined = args.join(" ");
    expect(joined).not.toMatch(/(?:^|\s)\/T(?:\s|$)/);
    expect(joined.toLowerCase()).not.toContain("everyone");
    expect(joined).not.toContain("BUILTIN\\Users");
    expect(joined).not.toMatch(/Authenticated Users/i);
  });

  it("builds this-object file ACL arguments without inherit flags", () => {
    const args = aclGrantArguments("C:\\YUVI\\Postgres\\runtime\\initdb-pw.tmp", "alice", "file");
    expect(args).toEqual([
      "C:\\YUVI\\Postgres\\runtime\\initdb-pw.tmp",
      "/inheritance:r",
      "/grant:r",
      "alice:(F)"
    ]);
    const joined = args.join(" ");
    expect(joined).not.toContain("(OI)");
    expect(joined).not.toContain("(CI)");
    expect(joined).not.toMatch(/(?:^|\s)\/T(?:\s|$)/);
    expect(joined.toLowerCase()).not.toContain("everyone");
  });

  it("refuses a PGDATA symlink that escapes the cluster root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-link-"));
    const foreign = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-foreign-"));
    tempDirs.push(root, foreign);
    const layout = layoutFromRoot(root);
    fs.mkdirSync(layout.runtime, { recursive: true });
    fs.symlinkSync(foreign, layout.data);
    expect(describeEscapedPgdata(layout)).toMatch(/escapes/i);
    expect(() => ensurePostgresDirectories(layout)).toThrow(/contained|escapes/i);
  });

  it("treats interrupted initializing state as not ready", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-init-"));
    tempDirs.push(root);
    const layout = layoutFromRoot(root);
    ensurePostgresDirectories(layout);
    fs.writeFileSync(path.join(layout.data, "PG_VERSION"), "16\n");
    writeClusterMarker(layout, createClusterMarker(layout));
    writeInitializationState(layout, "initializing", "initdb");
    const inspected = inspectExistingCluster(layout);
    expect(inspected.ok).toBe(false);
    if (!inspected.ok) expect(inspected.code).toBe("POSTGRES_INIT_IN_PROGRESS");
  });

  it("persists failed initdb evidence additively and ignores it on ready", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-pg-init-ev-"));
    tempDirs.push(root);
    const layout = layoutFromRoot(root);
    ensurePostgresDirectories(layout);
    writeInitializationState(layout, "failed", "EXIT_NONZERO: FATAL_TEST_SENTINEL", {
      errorCode: "EXIT_NONZERO",
      exitStatus: 1,
      signal: null,
      spawnErrorCode: null,
      stdoutTail: 'owned by user "runneradmin"',
      stderrTail: "FATAL_TEST_SENTINEL"
    });
    const failed = readInitializationState(layout);
    expect(failed?.state).toBe("failed");
    expect(failed?.reason).toBe("EXIT_NONZERO: FATAL_TEST_SENTINEL");
    expect(failed?.errorCode).toBe("EXIT_NONZERO");
    expect(failed?.exitStatus).toBe(1);
    expect(failed?.stderrTail).toBe("FATAL_TEST_SENTINEL");
    writeInitializationState(layout, "ready", undefined, {
      errorCode: "EXIT_NONZERO",
      stdoutTail: "BANNER",
      stderrTail: "FATAL_TEST_SENTINEL"
    });
    const ready = readInitializationState(layout);
    expect(ready?.state).toBe("ready");
    expect(ready?.reason).toBeUndefined();
    expect(ready?.errorCode).toBeUndefined();
    expect(ready?.stdoutTail).toBeUndefined();
    expect(ready?.stderrTail).toBeUndefined();
    const serialized = fs.readFileSync(layout.initializationStateFile, "utf8");
    expect(serialized).not.toContain("stdoutTail");
    expect(serialized).not.toContain("FATAL_TEST_SENTINEL");
  });
});
