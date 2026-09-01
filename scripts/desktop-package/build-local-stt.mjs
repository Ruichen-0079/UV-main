/** Build and validate the Windows x64 packaged local STT sidecar. */
import fs from "node:fs";
import path from "node:path";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  LOCAL_STT_BUILD_SCRIPT,
  LOCAL_STT_EXE_NAME,
  LOCAL_STT_MANIFEST_NAME,
  LOCAL_STT_MODEL_BUILD_DIR,
  LOCAL_STT_MODEL_MANIFEST_NAME,
  LOCAL_STT_OUT_DIR,
  LOCAL_STT_SERVICE_ROOT,
  REPO_ROOT
} from "./constants.mjs";
import { assertRelativeSafe, ensureDir } from "./paths.mjs";

export const LOCAL_STT_MANIFEST = Object.freeze({
  schemaVersion: 1,
  protocolVersion: 1,
  platform: "win32",
  arch: "x64",
  executable: LOCAL_STT_EXE_NAME,
  modelDirectory: "models",
  modelManifest: LOCAL_STT_MODEL_MANIFEST_NAME,
  healthPath: "/health",
  defaultHost: "127.0.0.1",
  defaultPort: 9876
});

export const LOCAL_STT_PYINSTALLER_VERSION = "6.13.0";
export const LOCAL_STT_VERSION = "1.13.6";
export const LOCAL_STT_NUMPY_VERSION = "2.3.2";

const PYTHON_PROBE = [
  "import importlib.metadata, json, platform, struct, sys",
  "def v(name):",
  "    try:",
  "        return importlib.metadata.version(name)",
  "    except importlib.metadata.PackageNotFoundError:",
  "        return None",
  "print(json.dumps({'platform': sys.platform, 'version': list(sys.version_info[:2]), 'pointerSize': struct.calcsize('P') * 8, 'machine': platform.machine(), 'pyinstaller': v('pyinstaller'), 'sherpaOnnx': v('sherpa-onnx'), 'numpy': v('numpy')}))"
].join("\n");

function spawnResult(candidate, args, spawnSyncImpl = nodeSpawnSync) {
  const result = spawnSyncImpl(candidate.file, [...(candidate.prefixArgs ?? []), ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error)
    throw new Error(`Python 3.11 probe failed (${safeInterpreterLabel(candidate.file)}).`);
  return result;
}

function safeInterpreterLabel(file) {
  return path.win32.basename(String(file).replaceAll("/", "\\"));
}

function assertCandidate(candidate) {
  if (!candidate || typeof candidate.file !== "string" || !candidate.file.trim())
    throw new Error("Python 3.11 interpreter candidate is invalid.");
  if (
    !Array.isArray(candidate.prefixArgs) ||
    candidate.prefixArgs.some((arg) => typeof arg !== "string")
  )
    throw new Error("Python 3.11 interpreter arguments are invalid.");
  if (candidate.prefixArgs.some((arg) => /[;&|<>]/.test(arg)))
    throw new Error("Python 3.11 interpreter arguments contain shell syntax.");
}

export function validateLocalSttPython(candidate, options = {}) {
  assertCandidate(candidate);
  const result = spawnResult(candidate, ["-c", PYTHON_PROBE], options.spawnSyncImpl);
  if (result.status !== 0) throw new Error("Python 3.11 probe failed.");
  let info;
  try {
    info = JSON.parse(
      String(result.stdout ?? "")
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .at(-1)
    );
  } catch {
    throw new Error("Python 3.11 probe returned invalid version metadata.");
  }
  if (!info || typeof info !== "object" || Array.isArray(info))
    throw new Error("Python 3.11 probe returned invalid version metadata.");
  if (info.platform !== "win32")
    throw new Error("Local STT packaged build requires Windows Python.");
  if (!Array.isArray(info.version) || info.version[0] !== 3 || info.version[1] !== 11)
    throw new Error("Local STT packaged build requires Python 3.11.x.");
  if (info.pointerSize !== 64) throw new Error("Local STT packaged build requires 64-bit Python.");
  if (!["AMD64", "X86_64"].includes(String(info.machine).toUpperCase()))
    throw new Error("Local STT packaged build requires Windows x64 Python.");
  if (info.pyinstaller !== LOCAL_STT_PYINSTALLER_VERSION)
    throw new Error(`PyInstaller ${LOCAL_STT_PYINSTALLER_VERSION} is required.`);
  if (info.sherpaOnnx !== LOCAL_STT_VERSION)
    throw new Error(`sherpa-onnx ${LOCAL_STT_VERSION} is required.`);
  if (info.numpy !== LOCAL_STT_NUMPY_VERSION)
    throw new Error(`NumPy ${LOCAL_STT_NUMPY_VERSION} is required.`);
  return info;
}

function regularFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function listFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function readModelManifest() {
  return JSON.parse(
    fs.readFileSync(path.join(LOCAL_STT_SERVICE_ROOT, "models.manifest.json"), "utf8")
  );
}

function requiredModelFiles(manifest) {
  return [
    ...new Set([...(manifest.runtimeFiles ?? []), ...manifest.models.map((model) => model.file)])
  ];
}

function assertSafeRelative(value, label) {
  assertRelativeSafe(value, label);
  if (path.posix.normalize(value) !== value.replaceAll("\\", "/"))
    throw new Error(`${label} is not normalized.`);
  return value;
}

function stageModels(modelDir, artifactDir, manifest) {
  const stagedModels = path.join(artifactDir, LOCAL_STT_MANIFEST.modelDirectory);
  ensureDir(stagedModels);
  for (const relative of requiredModelFiles(manifest)) {
    const safe = assertSafeRelative(relative, "local STT model file");
    const source = path.resolve(modelDir, safe);
    const target = path.resolve(stagedModels, safe);
    if (!source.startsWith(path.resolve(modelDir) + path.sep) || !regularFile(source))
      throw new Error(`local STT model file is missing: ${source}`);
    if (!target.startsWith(path.resolve(stagedModels) + path.sep))
      throw new Error("local STT model file escapes the packaged model directory.");
    ensureDir(path.dirname(target));
    fs.copyFileSync(source, target);
  }
  fs.copyFileSync(
    path.join(LOCAL_STT_SERVICE_ROOT, "models.manifest.json"),
    path.join(artifactDir, LOCAL_STT_MODEL_MANIFEST_NAME)
  );
}

export function validateLocalSttArtifact(artifactDir, options = {}) {
  const root = path.resolve(artifactDir);
  const modelRoot = path.join(root, LOCAL_STT_MANIFEST.modelDirectory);
  const executable = path.join(root, LOCAL_STT_EXE_NAME);
  const internal = path.join(root, "_internal");
  const manifestPath = path.join(root, LOCAL_STT_MANIFEST_NAME);
  const modelManifestPath = path.join(root, LOCAL_STT_MODEL_MANIFEST_NAME);
  if (!regularFile(executable) || fs.statSync(executable).size <= 0)
    throw new Error("yuvi-local-stt.exe is missing or empty.");
  if (
    !fs.existsSync(internal) ||
    !fs.statSync(internal).isDirectory() ||
    fs.readdirSync(internal).length === 0
  )
    throw new Error("Local STT _internal directory is missing or empty.");
  let manifest;
  let modelManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    modelManifest = JSON.parse(fs.readFileSync(modelManifestPath, "utf8"));
  } catch {
    throw new Error("Local STT manifest is unreadable or missing.");
  }
  if (JSON.stringify(manifest) !== JSON.stringify(LOCAL_STT_MANIFEST))
    throw new Error("Local STT manifest does not match the fixed schema.");
  const expectedModelManifest = JSON.parse(
    fs.readFileSync(path.join(LOCAL_STT_SERVICE_ROOT, "models.manifest.json"), "utf8")
  );
  if (JSON.stringify(modelManifest) !== JSON.stringify(expectedModelManifest))
    throw new Error("Local STT model manifest does not match the pinned model schema.");
  if (!fs.existsSync(modelRoot) || !fs.statSync(modelRoot).isDirectory())
    throw new Error("Local STT model directory is missing.");
  for (const model of modelManifest.models ?? []) {
    const file = path.resolve(modelRoot, assertSafeRelative(model.file, "local STT model file"));
    if (!file.startsWith(path.resolve(modelRoot) + path.sep) || !regularFile(file))
      throw new Error(`Local STT packaged model is missing: ${model.id}`);
    if (fs.statSync(file).size !== model.bytes || sha256File(file) !== model.sha256)
      throw new Error(`Local STT packaged model checksum mismatch: ${model.id}`);
  }
  for (const relative of modelManifest.runtimeFiles ?? []) {
    const file = path.resolve(modelRoot, assertSafeRelative(relative, "local STT runtime file"));
    if (!file.startsWith(path.resolve(modelRoot) + path.sep) || !regularFile(file))
      throw new Error(`Local STT packaged runtime file is missing: ${relative}`);
  }
  const files = listFiles(root);
  for (const file of files) {
    const rel = path.relative(root, file).replaceAll("\\", "/");
    if (path.basename(file).toLowerCase() === ".env" || rel.toLowerCase().endsWith("/.env"))
      throw new Error(".env was included in the Local STT artifact.");
    if (
      options.repoRoot &&
      fs.readFileSync(file).toString("utf8").includes(String(options.repoRoot))
    )
      throw new Error("Repository path leaked into the Local STT artifact.");
  }
  return {
    artifactDir: root,
    executable,
    manifestPath,
    modelManifestPath,
    modelRoot,
    files: files.length,
    bytes: files.reduce((sum, file) => sum + fs.statSync(file).size, 0)
  };
}

export function buildPackagedLocalStt(options = {}) {
  const spawnSyncImpl = options.spawnSyncImpl ?? nodeSpawnSync;
  const candidate = options.python ?? resolveLocalSttPython(options);
  validateLocalSttPython(candidate, { spawnSyncImpl: options.probeSpawnSyncImpl });
  const result = spawnSyncImpl(
    candidate.file,
    [...(candidate.prefixArgs ?? []), LOCAL_STT_BUILD_SCRIPT],
    {
      cwd: REPO_ROOT,
      shell: false,
      windowsHide: true,
      stdio: "inherit"
    }
  );
  if (result.error || result.status !== 0) throw new Error("Local STT packaged build failed.");
  const artifactDir = options.artifactDir ?? LOCAL_STT_OUT_DIR;
  const modelDir = options.modelDir ?? LOCAL_STT_MODEL_BUILD_DIR;
  const modelManifest = readModelManifest();
  stageModels(modelDir, artifactDir, modelManifest);
  const artifact = validateLocalSttArtifact(artifactDir, { repoRoot: REPO_ROOT });
  return { ...artifact, python: candidate, buildScript: LOCAL_STT_BUILD_SCRIPT };
}

export function resolveLocalSttPython(options = {}) {
  const configured = (options.env ?? process.env).YUVI_PYTHON311?.trim();
  if (configured) return { file: configured, prefixArgs: [] };
  const candidate = process.platform === "win32" ? "python" : "python3";
  return { file: candidate, prefixArgs: [] };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith("build-local-stt.mjs");
if (isMain) {
  try {
    const result = buildPackagedLocalStt();
    console.info(
      `[desktop-package] Local STT artifact: ${result.files} files, ${result.bytes} bytes`
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
