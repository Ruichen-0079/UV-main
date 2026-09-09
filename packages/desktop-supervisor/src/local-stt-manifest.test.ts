import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readLocalSttManifest,
  resolveLocalSttManifestExecutable,
  validateLocalSttManifest
} from "./local-stt-manifest.js";
import type { LocalSttManifest } from "./types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function windowsManifest(): LocalSttManifest {
  return {
    schemaVersion: 1,
    protocolVersion: 1,
    platform: "win32",
    arch: "x64",
    executable: "yuvi-local-stt.exe",
    modelDirectory: "models",
    modelManifest: "models.manifest.json",
    healthPath: "/health",
    defaultHost: "127.0.0.1",
    defaultPort: 9876
  };
}

function linuxManifest(): LocalSttManifest {
  return {
    ...windowsManifest(),
    platform: "linux",
    executable: "yuvi-local-stt"
  };
}

describe("Local STT manifest", () => {
  it("accepts Windows and Linux packaged manifests", () => {
    expect(validateLocalSttManifest(windowsManifest())).toEqual(windowsManifest());
    expect(validateLocalSttManifest(linuxManifest())).toEqual(linuxManifest());
  });

  it("resolves the Linux executable basename", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-local-stt-manifest-"));
    tempDirs.push(dir);
    const executable = path.join(dir, "yuvi-local-stt");
    const manifestPath = path.join(dir, "local-stt-manifest.json");
    fs.writeFileSync(executable, "ELF");
    fs.writeFileSync(manifestPath, JSON.stringify(linuxManifest()));
    expect(readLocalSttManifest(manifestPath)).toEqual(linuxManifest());
    expect(resolveLocalSttManifestExecutable(manifestPath, linuxManifest())).toBe(executable);
  });

  it("rejects a Linux executable name on a Windows manifest", () => {
    expect(() =>
      validateLocalSttManifest({ ...windowsManifest(), executable: "yuvi-local-stt" })
    ).toThrow(/yuvi-local-stt\.exe/i);
  });

  it("rejects unsupported platforms", () => {
    expect(() => validateLocalSttManifest({ ...windowsManifest(), platform: "darwin" })).toThrow(
      /platform must be win32 or linux/i
    );
  });
});
