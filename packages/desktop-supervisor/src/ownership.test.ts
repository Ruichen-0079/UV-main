import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROCESS_METADATA_VERSION,
  testProcessOwnership,
  writeProcessMetadata
} from "./ownership.js";
import type { ProcessMetadata } from "./types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-own-"));
  tempDirs.push(dir);
  return dir;
}

function meta(partial: Partial<ProcessMetadata> & Pick<ProcessMetadata, "pid" | "role">): ProcessMetadata {
  const now = new Date().toISOString();
  return {
    schemaVersion: PROCESS_METADATA_VERSION,
    repositoryRoot: "C:\\Dev\\UV-main",
    stateDirectory: "C:\\state",
    commandMarker: "dev-server-runner.ps1",
    processStartedAtUtc: now,
    createdAtUtc: now,
    ownershipToken: "token-a",
    instanceId: "instance-a",
    ...partial
  };
}

describe("process ownership", () => {
  it("rejects missing metadata", () => {
    const dir = tempDir();
    const result = testProcessOwnership({
      metadataPath: path.join(dir, "missing.json"),
      expectedRole: "runtime",
      repositoryRoot: "C:\\Dev\\UV-main",
      stateDirectory: "C:\\state",
      ownershipToken: "token-a",
      instanceId: "instance-a",
      processInfo: null
    });
    expect(result.owned).toBe(false);
    expect(result.status).toBe("missing");
  });

  it("rejects foreign ownership token (multi-instance safety)", () => {
    const dir = tempDir();
    const file = path.join(dir, "runtime.pid.json");
    writeProcessMetadata(
      file,
      meta({
        pid: 4242,
        role: "runtime",
        ownershipToken: "other-instance",
        instanceId: "other"
      })
    );
    const result = testProcessOwnership({
      metadataPath: file,
      expectedRole: "runtime",
      repositoryRoot: "C:\\Dev\\UV-main",
      stateDirectory: "C:\\state",
      ownershipToken: "token-a",
      instanceId: "instance-a",
      processInfo: {
        processId: 4242,
        parentProcessId: 1,
        commandLine: "powershell -File C:\\Dev\\UV-main\\scripts\\dev-server-runner.ps1",
        createdAtUtc: new Date()
      }
    });
    expect(result.owned).toBe(false);
    expect(result.status).toBe("mismatch");
    expect(result.message).toMatch(/token/i);
  });

  it("accepts matching owned process", () => {
    const dir = tempDir();
    const file = path.join(dir, "runtime.pid.json");
    const started = new Date();
    writeProcessMetadata(
      file,
      meta({
        pid: 1001,
        role: "runtime",
        processStartedAtUtc: started.toISOString(),
        repositoryRoot: "C:\\Dev\\UV-main",
        stateDirectory: dir,
        ownershipToken: "token-a",
        instanceId: "instance-a"
      })
    );
    const result = testProcessOwnership({
      metadataPath: file,
      expectedRole: "runtime",
      repositoryRoot: "C:\\Dev\\UV-main",
      stateDirectory: dir,
      ownershipToken: "token-a",
      instanceId: "instance-a",
      processInfo: {
        processId: 1001,
        parentProcessId: 1,
        commandLine: "powershell -File C:\\Dev\\UV-main\\scripts\\dev-server-runner.ps1",
        createdAtUtc: started
      }
    });
    expect(result.owned).toBe(true);
    expect(result.status).toBe("running");
  });

  it("rejects command marker mismatch (will not stop foreign pid)", () => {
    const dir = tempDir();
    const file = path.join(dir, "runtime.pid.json");
    const started = new Date();
    writeProcessMetadata(
      file,
      meta({
        pid: 1001,
        role: "runtime",
        processStartedAtUtc: started.toISOString(),
        stateDirectory: dir
      })
    );
    const result = testProcessOwnership({
      metadataPath: file,
      expectedRole: "runtime",
      repositoryRoot: "C:\\Dev\\UV-main",
      stateDirectory: dir,
      ownershipToken: "token-a",
      instanceId: "instance-a",
      processInfo: {
        processId: 1001,
        parentProcessId: 1,
        commandLine: "C:\\Windows\\System32\\notepad.exe",
        createdAtUtc: started
      }
    });
    expect(result.owned).toBe(false);
    expect(result.message).toMatch(/marker/i);
  });
});
