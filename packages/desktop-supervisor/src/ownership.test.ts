import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROCESS_METADATA_VERSION,
  testProcessOwnership,
  writeProcessMetadata
} from "./ownership.js";
import { canonicalPath, commandLineContainsPath, pathsEqual } from "./paths.js";
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

  it("accepts owned process when command line uses quoted Windows repo path", () => {
    const dir = tempDir();
    const file = path.join(dir, "runtime.pid.json");
    const started = new Date();
    writeProcessMetadata(
      file,
      meta({
        pid: 2002,
        role: "runtime",
        processStartedAtUtc: started.toISOString(),
        repositoryRoot: "C:\\Dev\\UV-main",
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
        processId: 2002,
        parentProcessId: 1,
        commandLine:
          'powershell -File "C:\\Dev\\UV-main\\scripts\\dev-server-runner.ps1" -RepoRoot "C:\\Dev\\UV-main"',
        createdAtUtc: started
      }
    });
    expect(result.owned).toBe(true);
    expect(canonicalPath("C:\\Dev\\UV-main")).toBe("C:\\Dev\\UV-main");
    expect(pathsEqual("C:\\Dev\\UV-main", "c:/dev/uv-main")).toBe(true);
    expect(
      commandLineContainsPath(
        'powershell -File "C:\\Dev\\UV-main\\scripts\\dev-server-runner.ps1"',
        "C:\\Dev\\UV-main"
      )
    ).toBe(true);
  });

  it("rejects when repo path is absent from command line (not marker-only)", () => {
    const dir = tempDir();
    const file = path.join(dir, "runtime.pid.json");
    const started = new Date();
    writeProcessMetadata(
      file,
      meta({
        pid: 3003,
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
        processId: 3003,
        parentProcessId: 1,
        // Marker present, but different repository path — must fail.
        commandLine: "powershell -File C:\\Other\\Repo\\scripts\\dev-server-runner.ps1",
        createdAtUtc: started
      }
    });
    expect(result.owned).toBe(false);
    expect(result.message).toMatch(/repository root not present/i);
  });

  it("recognizes an owned packaged Mem0 process only with the full executable marker", () => {
    const dir = tempDir();
    const resourceRoot = path.join(dir, "installed resource");
    const executable = path.join(resourceRoot, "mem0", "yuvi-mem0.exe");
    const stateDirectory = path.join(dir, "state");
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.mkdirSync(stateDirectory, { recursive: true });
    fs.writeFileSync(executable, "MZ");
    const started = new Date();
    const metadataPath = path.join(stateDirectory, "mem0.pid.json");
    writeProcessMetadata(
      metadataPath,
      meta({
        pid: 5001,
        role: "mem0",
        repositoryRoot: resourceRoot,
        stateDirectory,
        commandMarker: executable,
        processStartedAtUtc: started.toISOString()
      })
    );
    const result = testProcessOwnership({
      metadataPath,
      expectedRole: "mem0",
      repositoryRoot: resourceRoot,
      stateDirectory,
      ownershipToken: "token-a",
      instanceId: "instance-a",
      processInfo: {
        processId: 5001,
        parentProcessId: 1,
        commandLine: `"${executable}"`,
        createdAtUtc: started
      }
    });
    expect(result.owned).toBe(true);
  });

  it.each([
    ["other executable", (executable: string) => `"${path.join(path.dirname(executable), "other.exe")}"`, "marker"],
    ["other install", (executable: string) => `"C:\\Other\\mem0\\yuvi-mem0.exe"`, "marker"],
    ["different token", (executable: string) => `"${executable}"`, "token"],
    ["different start time", (executable: string) => `"${executable}"`, "start time"]
  ])("does not claim packaged Mem0 with %s", (reason, commandLine, message) => {
    const dir = tempDir();
    const resourceRoot = path.join(dir, "resource");
    const executable = path.join(resourceRoot, "mem0", "yuvi-mem0.exe");
    const stateDirectory = path.join(dir, "state");
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.mkdirSync(stateDirectory, { recursive: true });
    fs.writeFileSync(executable, "MZ");
    const started = new Date();
    const metadataPath = path.join(stateDirectory, "mem0.pid.json");
    const metadata = meta({
      pid: 5002,
      role: "mem0",
      repositoryRoot: resourceRoot,
      stateDirectory,
      commandMarker: executable,
      processStartedAtUtc:
        reason === "different start time"
          ? new Date(started.getTime() - 10_000).toISOString()
          : started.toISOString(),
      ownershipToken: reason === "different token" ? "other-token" : "token-a"
    });
    writeProcessMetadata(metadataPath, metadata);
    const result = testProcessOwnership({
      metadataPath,
      expectedRole: "mem0",
      repositoryRoot: resourceRoot,
      stateDirectory,
      ownershipToken: "token-a",
      instanceId: "instance-a",
      processInfo: {
        processId: 5002,
        parentProcessId: 1,
        commandLine: commandLine(executable),
        createdAtUtc: started
      }
    });
    expect(result.owned).toBe(false);
    expect(result.message).toMatch(new RegExp(message, "i"));
  });

  it("does not claim packaged Mem0 when metadata is missing", () => {
    const dir = tempDir();
    const resourceRoot = path.join(dir, "resource");
    const stateDirectory = path.join(dir, "state");
    const result = testProcessOwnership({
      metadataPath: path.join(stateDirectory, "mem0.pid.json"),
      expectedRole: "mem0",
      repositoryRoot: resourceRoot,
      stateDirectory,
      ownershipToken: "token-a",
      instanceId: "instance-a",
      processInfo: {
        processId: 5003,
        parentProcessId: 1,
        commandLine: `${path.join(resourceRoot, "mem0", "yuvi-mem0.exe")}`,
        createdAtUtc: new Date()
      }
    });
    expect(result.owned).toBe(false);
    expect(result.status).toBe("missing");
  });
});
