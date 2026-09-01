import assert from "node:assert/strict";
import test from "node:test";
import {
  LOCAL_STT_MANIFEST,
  LOCAL_STT_NUMPY_VERSION,
  LOCAL_STT_PYINSTALLER_VERSION,
  LOCAL_STT_VERSION,
  validateLocalSttPython
} from "./build-local-stt.mjs";

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
