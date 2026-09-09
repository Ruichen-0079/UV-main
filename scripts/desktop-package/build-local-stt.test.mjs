import assert from "node:assert/strict";
import test from "node:test";
import {
  LINUX_LOCAL_STT_MANIFEST,
  LOCAL_STT_MANIFEST,
  LOCAL_STT_NUMPY_VERSION,
  LOCAL_STT_PYINSTALLER_VERSION,
  LOCAL_STT_VERSION,
  localSttManifestFor,
  validateLocalSttPython
} from "./build-local-stt.mjs";
import fs from "node:fs";

const probe = (overrides = {}) => ({
  status: 0,
  stdout: JSON.stringify({
    platform: "win32",
    version: [3, 11],
    pointerSize: 64,
    machine: "AMD64",
    pyinstaller: LOCAL_STT_PYINSTALLER_VERSION,
    sherpaOnnx: LOCAL_STT_VERSION,
    numpy: LOCAL_STT_NUMPY_VERSION,
    ...overrides
  }),
  stderr: ""
});

test("local STT package manifest is fixed and relative", () => {
  assert.deepEqual(LOCAL_STT_MANIFEST, {
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
  });
  assert.equal(LOCAL_STT_MANIFEST.executable.includes("/"), false);
  assert.equal(LOCAL_STT_MANIFEST.modelDirectory.includes(".."), false);
});

test("local STT package validates the pinned Windows Python environment", () => {
  const result = validateLocalSttPython(
    { file: "python.exe", prefixArgs: [] },
    { spawnSyncImpl: () => probe() }
  );
  assert.equal(result.platform, "win32");
});

test("linux local STT package manifest is relative and has no .exe suffix", () => {
  assert.deepEqual(localSttManifestFor("linux"), LINUX_LOCAL_STT_MANIFEST);
  assert.equal(LINUX_LOCAL_STT_MANIFEST.executable, "yuvi-local-stt");
  assert.equal(LINUX_LOCAL_STT_MANIFEST.executable.includes("."), false);
  assert.equal(LINUX_LOCAL_STT_MANIFEST.modelDirectory.includes(".."), false);
});

test("local STT package validates the pinned Linux Python environment", () => {
  const result = validateLocalSttPython(
    { file: "python3", prefixArgs: [] },
    {
      spawnSyncImpl: () => probe({ platform: "linux", machine: "x86_64" }),
      targetPlatform: "linux"
    }
  );
  assert.equal(result.platform, "linux");
});

test("SenseVoice packaged license is not Apache-2.0", () => {
  const manifest = JSON.parse(
    fs.readFileSync(
      new URL("../../services/local-stt/models.manifest.json", import.meta.url),
      "utf8"
    )
  );
  const sense = manifest.models.find((model) => model.role === "asr");
  assert.equal(sense.license, "FunASR-Model-License-v1.1");
  assert.notEqual(sense.license, "Apache-2.0");
  assert.match(sense.licenseUrl, /FunASR/);
  const notices = fs.readFileSync(
    new URL("../../services/local-stt/THIRD_PARTY_NOTICES.md", import.meta.url),
    "utf8"
  );
  assert.match(notices, /FunASR Model Open Source License Agreement v1\.1/);
  assert.match(notices, /This is \*\*not\*\* Apache-2\.0/);
});

for (const [name, overrides, message] of [
  ["rejects non-Windows", { platform: "linux" }, /Windows/],
  ["rejects the wrong sherpa-onnx", { sherpaOnnx: "1.12.0" }, /sherpa-onnx/],
  ["rejects the wrong NumPy", { numpy: "1.26.4" }, /NumPy/],
  ["rejects the wrong PyInstaller", { pyinstaller: "6.12.0" }, /PyInstaller/]
]) {
  test(name, () =>
    assert.throws(
      () =>
        validateLocalSttPython(
          { file: "python.exe", prefixArgs: [] },
          { spawnSyncImpl: () => probe(overrides) }
        ),
      message
    )
  );
}
