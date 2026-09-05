/**
 * Isolated smoke for the real Windows NSIS installer.
 *
 * This script intentionally starts only the packaged Supervisor resource. It
 * never starts the Tauri shell, so the current user's Credential Manager is
 * not involved in this check.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  BUILD_ROOT,
  LOCAL_STT_EXE_NAME,
  LOCAL_STT_MANIFEST_NAME,
  LOCAL_STT_MODEL_MANIFEST_NAME,
  MEM0_EXE_NAME,
  MEM0_MANIFEST_NAME,
  MEM0_INTERNAL_DIR_NAME,
  NODE_EXE_NAME,
  REPO_ROOT,
  RUNTIME_ENTRY_NAME,
  RUNTIME_MANIFEST_NAME,
  SUPERVISOR_BUNDLE_NAME,
  SUPERVISOR_EXE_NAME,
  TAURI_GENERATED
} from "./constants.mjs";
import { assertRelativeSafe, readJson } from "./paths.mjs";
import { validateMem0Artifact } from "./build-mem0.mjs";
import { validateLocalSttArtifact } from "./build-local-stt.mjs";

const NSIS_DIR = path.join(
  REPO_ROOT,
  "apps",
  "desktop",
  "src-tauri",
  "target",
  "release",
  "bundle",
  "nsis"
);
const SECRET_KEYS = [
  "DATABASE_URL",
  "MEM0_PG_CONNECTION_STRING",
  "MEM0_LLM_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "XAI_API_KEY",
  "DASHSCOPE_API_KEY",
  "YUVI_API_KEY"
];
const STRIPPED_KEYS = [
  "PYTHONHOME",
  "PYTHONPATH",
  "PYTHONUSERBASE",
  "PYTHONSTARTUP",
  "VIRTUAL_ENV",
  "CONDA_PREFIX",
  "CONDA_DEFAULT_ENV",
  "PIP_CONFIG_FILE",
  "UV_PYTHON",
  "UV_PROJECT_ENVIRONMENT",
  "NODE_PATH",
  "PNPM_HOME",
  "npm_config_prefix",
  "npm_config_cache",
  "npm_config_user_agent",
  "NODE_OPTIONS"
];
const SUPERVISOR_BUILD_INFO_NAME = "supervisor-build-info.json";
export const FORBIDDEN_PATH_TOOLS = ["python", "python3", "py", "pip", "uv", "node", "pnpm", "tsx"];

function fail(message) {
  throw new Error(message);
}

function normalized(value) {
  return path.resolve(String(value)).replaceAll("/", "\\").toLowerCase();
}

function stripWindowsOuterQuotes(value) {
  const text = String(value ?? "").trim();
  return text.length >= 2 &&
      ((text.startsWith('"') && text.endsWith('"')) ||
        (text.startsWith("'") && text.endsWith("'")))
    ? text.slice(1, -1)
    : text;
}

function stripWindowsDevicePrefix(value) {
  const text = stripWindowsOuterQuotes(value).replaceAll("/", "\\");
  if (/^\\\\\?\\UNC\\/i.test(text)) return `\\\\${text.slice(8)}`;
  if (/^\\\\\?\\/i.test(text)) return text.slice(4);
  if (/^\\\\\.\\/i.test(text)) return text.slice(4);
  return text;
}

function trimWindowsTrailingSeparators(value) {
  const parsed = path.win32.parse(value);
  if (value === parsed.root) return value;
  return value.replace(/[\\]+$/, "");
}

/** Canonical Windows path used only for provenance comparison. */
export function normalizeWindowsPathForComparison(value) {
  if (typeof value !== "string") return "";
  const text = stripWindowsDevicePrefix(value);
  if (!text) return "";
  const normalizedPath = path.win32.normalize(text);
  if (!normalizedPath || normalizedPath === ".") return "";
  if (!path.win32.isAbsolute(normalizedPath)) return "";
  return trimWindowsTrailingSeparators(normalizedPath).toLowerCase();
}

/**
 * Resolve an existing Windows path through the filesystem before comparing it.
 * This deliberately remains separate from the lexical canonicalizer above:
 * short-name aliases are filesystem metadata, not a string transformation.
 */
export function resolveExistingWindowsPathForComparison(
  value,
  { realpathSyncNative = fs.realpathSync.native } = {}
) {
  const rawPath = typeof value === "string" ? stripWindowsDevicePrefix(value) : "";
  const lexicalPath = normalizeWindowsPathForComparison(value);
  if (!lexicalPath) {
    return {
      ok: false,
      rawPath: rawPath || null,
      lexicalPath: null,
      resolvedPath: null,
      errorCode: "INVALID_PATH"
    };
  }
  try {
    const resolvedRawPath = realpathSyncNative(rawPath);
    const resolvedPath = normalizeWindowsPathForComparison(resolvedRawPath);
    if (!resolvedPath) {
      return {
        ok: false,
        rawPath,
        lexicalPath,
        resolvedPath: null,
        errorCode: "INVALID_RESOLVED_PATH"
      };
    }
    return {
      ok: true,
      rawPath,
      lexicalPath,
      resolvedPath,
      errorCode: null
    };
  } catch (error) {
    return {
      ok: false,
      rawPath,
      lexicalPath,
      resolvedPath: null,
      errorCode: String(error?.code ?? "RESOLVE_FAILED").slice(0, 80)
    };
  }
}

export function pathsEqualWindows(a, b) {
  const left = normalizeWindowsPathForComparison(a);
  const right = normalizeWindowsPathForComparison(b);
  return Boolean(left && right && left === right);
}

/** Return whether candidate is root itself or a descendant of root. */
export function isWindowsPathInside(root, candidate) {
  const rootCanonical = normalizeWindowsPathForComparison(root);
  const candidateCanonical = normalizeWindowsPathForComparison(candidate);
  if (!rootCanonical || !candidateCanonical) return false;
  const relative = path.win32.relative(rootCanonical, candidateCanonical);
  if (!relative) return true;
  if (path.win32.isAbsolute(relative)) return false;
  return relative !== ".." && !relative.startsWith(`..${path.win32.sep}`);
}

// Keep the existing exported name for callers/tests while using the explicit
// root/candidate contract internally.
export function normalizeWindowsProcessPath(value) {
  return normalizeWindowsPathForComparison(value);
}

export function windowsProcessPathInside(child, parent) {
  return isWindowsPathInside(parent, child);
}

export function isWithin(child, parent) {
  const c = normalized(child);
  const p = normalized(parent);
  return c === p || c.startsWith(`${p}\\`);
}

export function parseArgs(argv = process.argv.slice(2)) {
  const result = {
    installer: null,
    keepTemp: false,
    build: false,
    cleanupStale: false,
    launchApp: false,
    timeoutMs: 60_000
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--keep-temp") result.keepTemp = true;
    else if (arg === "--build") result.build = true;
    else if (arg === "--cleanup-stale") result.cleanupStale = true;
    else if (arg === "--launch-app") result.launchApp = true;
    else if (arg === "--installer") {
      result.installer = argv[++i];
      if (!result.installer) fail("--installer requires an absolute path");
    } else if (arg === "--timeout") {
      const seconds = Number(argv[++i]);
      if (!Number.isFinite(seconds) || seconds <= 0) fail("--timeout must be positive seconds");
      result.timeoutMs = Math.round(seconds * 1000);
    } else if (arg === "--help" || arg === "-h") {
      console.info(
        "Usage: node scripts/desktop-package/installer-smoke.mjs [--installer <path>] [--build] [--keep-temp] [--cleanup-stale] [--launch-app] [--timeout <seconds>]"
      );
      return null;
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }
  if (result.installer && !path.isAbsolute(result.installer))
    fail("--installer must be an absolute path");
  return result;
}

export function assertTauriAppSmokeAllowed(env = process.env, platform = process.platform) {
  if (platform !== "win32" || env.CI !== "true" || env.YUVI_ALLOW_TAURI_APP_SMOKE !== "1") {
    fail("Tauri app smoke is CI-only and requires YUVI_ALLOW_TAURI_APP_SMOKE=1.");
  }
  return true;
}

export function findInstallerCandidates(nsisDir = NSIS_DIR, fsImpl = fs) {
  if (!fsImpl.existsSync(nsisDir)) return [];
  return fsImpl
    .readdirSync(nsisDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^YUVI Companion_.+_x64-setup\.exe$/i.test(entry.name))
    .map((entry) => {
      const fullPath = path.join(nsisDir, entry.name);
      const stat = fsImpl.statSync(fullPath);
      return { path: fullPath, name: entry.name, mtimeMs: stat.mtimeMs, size: stat.size };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
}

export function chooseInstaller({ explicitPath, nsisDir = NSIS_DIR, buildStartedAt = 0 } = {}) {
  if (explicitPath) {
    const fullPath = path.resolve(explicitPath);
    if (!/^YUVI Companion_.+_x64-setup\.exe$/i.test(path.basename(fullPath)))
      fail("installer filename is not a YUVI x64 NSIS installer");
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) fail("installer is missing");
    return {
      selected: {
        path: fullPath,
        name: path.basename(fullPath),
        mtimeMs: fs.statSync(fullPath).mtimeMs,
        size: fs.statSync(fullPath).size
      },
      candidates: []
    };
  }
  const candidates = findInstallerCandidates(nsisDir);
  if (candidates.length === 0) fail(`no NSIS installer found in ${nsisDir}`);
  const selected = candidates[0];
  if (buildStartedAt && selected.mtimeMs <= buildStartedAt)
    fail("newest NSIS installer predates this build; refusing to install an old artifact");
  return { selected, candidates };
}

export function restrictedWindowsPath(env = process.env) {
  const windir = env.SystemRoot ?? env.WINDIR ?? "C:\\Windows";
  const windowsPath = path.win32;
  return [
    windowsPath.join(windir, "System32"),
    windowsPath.join(windir, "System32", "Wbem"),
    windowsPath.join(windir, "System32", "WindowsPowerShell", "v1.0")
  ].join(windowsPath.delimiter);
}

export function restrictedPath(env = process.env) {
  if (process.platform !== "win32") return "/usr/bin:/bin";
  return restrictedWindowsPath(env);
}

export function sanitizeChildEnv(overrides = {}) {
  const allow = [
    "SystemRoot",
    "WINDIR",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "USERNAME",
    "USERDOMAIN",
    "COMPUTERNAME",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "OS",
    "PATHEXT",
    "COMSPEC"
  ];
  const env = {};
  for (const key of allow) if (process.env[key] !== undefined) env[key] = process.env[key];
  Object.assign(env, overrides);
  env.PATH = restrictedPath();
  env.Path = env.PATH;
  for (const key of [...STRIPPED_KEYS, ...SECRET_KEYS]) delete env[key];
  return env;
}

export function createTauriAppEnv({ localAppData, appData, home, temp } = {}) {
  const userProfile = process.env.USERPROFILE;
  if (process.platform === "win32" && !userProfile)
    fail("Tauri app smoke requires the real Windows USERPROFILE");
  return sanitizeChildEnv({
    LOCALAPPDATA: localAppData,
    APPDATA: appData,
    ...(userProfile ? { USERPROFILE: userProfile } : {}),
    HOME: home,
    TEMP: temp,
    TMP: temp,
    YUVI_AUTOSTART_RUNTIME: "true",
    YUVI_AUTOSTART_MEM0: "true",
    YUVI_AUTOSTART_TTS: "false"
  });
}

export function assertNoSecrets(value, label = "value") {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const key of SECRET_KEYS) {
    if (new RegExp(`(?:${key}|api[_-]?key|password|secret|authorization)`, "i").test(text))
      fail(`${label} contains secret-like material`);
  }
  return true;
}

export function assertNoUnsafeCommandLine(commandLine, { repoRoot = REPO_ROOT } = {}) {
  const text = String(commandLine || "");
  const lower = text.toLowerCase().replaceAll("/", "\\");
  const forbidden = [
    normalized(repoRoot),
    normalized(path.join(repoRoot, "build")),
    normalized(path.join(repoRoot, "apps", "desktop", "src-tauri", "generated")),
    "python",
    "py.exe",
    "pip",
    "services\\memory-mem0"
  ];
  if (forbidden.some((needle) => lower.includes(needle)))
    fail("child command line contains source/tool path");
  if (/(?:target[\\/]|pnpm|tsx)/i.test(text))
    fail("child command line contains an unpackaged tool path");
  return true;
}

function listFiles(root, out = []) {
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) listFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

export function snapshotTree(root) {
  const snapshot = new Map();
  for (const file of listFiles(root)) {
    const stat = fs.statSync(file);
    snapshot.set(path.relative(root, file).replaceAll("\\", "/"), {
      size: stat.size,
      hash: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
    });
  }
  return snapshot;
}

export function compareSnapshots(before, after) {
  const changed = [];
  for (const [name, entry] of before) {
    const next = after.get(name);
    if (!next) changed.push({ type: "removed", path: name });
    else if (entry.size !== next.size || entry.hash !== next.hash)
      changed.push({ type: "changed", path: name });
  }
  for (const name of after.keys())
    if (!before.has(name)) changed.push({ type: "added", path: name });
  return changed;
}

export function assertTempRoot(root, tempDir = os.tmpdir()) {
  const resolved = path.resolve(root);
  if (
    !isWithin(resolved, tempDir) ||
    path.basename(resolved).startsWith("yuvi-installer-smoke-") === false
  )
    fail(`unsafe smoke root: ${resolved}`);
  return resolved;
}

export function assertInstallPathSafe(
  installDir,
  root,
  { repoRoot = REPO_ROOT, localAppData = process.env.LOCALAPPDATA } = {}
) {
  const resolved = path.resolve(installDir);
  assertTempRoot(root);
  if (!isWithin(resolved, root) || resolved === path.resolve(root))
    fail("install directory is outside smoke root");
  if (isWithin(resolved, repoRoot)) fail("install directory is inside repository");
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  if (isWithin(resolved, programFiles)) fail("install directory is inside Program Files");
  if (localAppData && isWithin(resolved, path.join(localAppData, "YUVI")))
    fail("install directory is inside real LOCALAPPDATA\\YUVI");
  return resolved;
}

export function assertCleanupTarget(root) {
  assertTempRoot(root);
  if (!fs.existsSync(root)) return root;
  if (!fs.statSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink())
    fail("cleanup target is not a real directory");
  return root;
}

export function cleanupStaleRoots(tempDir = os.tmpdir()) {
  const removed = [];
  const retained = [];
  const failures = [];
  if (!fs.existsSync(tempDir)) return { removed, retained, failures };
  for (const entry of fs.readdirSync(tempDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("yuvi-installer-smoke-")) continue;
    const root = path.join(tempDir, entry.name);
    assertTempRoot(root, tempDir);
    if (fs.existsSync(path.join(root, "snapshots", "summary.json"))) {
      retained.push(root);
      continue;
    }
    try {
      assertCleanupTarget(root);
      fs.rmSync(root, { recursive: true, force: true });
      removed.push(root);
    } catch (error) {
      failures.push({ root, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (failures.length)
    fail(`stale smoke cleanup failed for ${failures.map((item) => item.root).join(", ")}`);
  return { removed, retained, failures };
}

function recursiveSize(root) {
  return listFiles(root).reduce((sum, file) => sum + fs.statSync(file).size, 0);
}

export function validatePackagingInfo(info) {
  if (!info || info.schemaVersion !== 1 || info.platform !== "win32" || info.arch !== "x64")
    fail("packaging-info schema mismatch");
  if (info.hasMem0 !== true || info.mem0ProtocolVersion !== 1)
    fail("packaging-info does not declare packaged Mem0");
  if (info.hasLocalStt !== true || info.localSttProtocolVersion !== 1)
    fail("packaging-info does not declare packaged local STT");
  if (info.hasSupervisorExe !== true || info.supervisorMode !== "pkg-exe")
    fail("packaging-info does not declare packaged Supervisor exe");
  assertRelativeSafe(info.supervisorBuildInfo, "packaging-info.supervisorBuildInfo");
  for (const field of [
    "runtimeEntry",
    "nodeExecutable",
    "mem0Executable",
    "mem0Manifest",
    "localSttExecutable",
    "localSttManifest",
    "localSttModelManifest"
  ])
    assertRelativeSafe(info[field], `packaging-info.${field}`);
  assertNoSecrets(info, "packaging-info");
  return info;
}

export function validateSupervisorProvenance(info) {
  if (!info || info.schemaVersion !== 1 || info.mode !== "pkg-exe")
    fail("Supervisor provenance schema/mode mismatch");
  if (typeof info.checkoutSha !== "string" || !/^[0-9a-f]{40}$/i.test(info.checkoutSha))
    fail("Supervisor provenance checkoutSha is not a commit SHA");
  for (const field of ["sourceFingerprint", "bundleSha256", "bundleInputSha256", "executableSha256", "stagedExecutableSha256", "stagedBundleSha256"]) {
    if (typeof info[field] !== "string" || !/^[0-9a-f]{64}$/i.test(info[field]))
      fail(`Supervisor provenance ${field} is not a SHA-256 value`);
  }
  if (typeof info.entry !== "string" || info.entry.includes("\\") || info.entry.includes("/"))
    fail("Supervisor provenance entry is unsafe");
  for (const field of ["bundleRelativePath", "executableRelativePath"])
    assertRelativeSafe(info[field], `Supervisor provenance ${field}`);
  if (info.pkgTarget !== "node20-win-x64" || info.platform !== "win32" || info.arch !== "x64")
    fail("Supervisor provenance target mismatch");
  assertNoSecrets(info, "Supervisor provenance");
  return info;
}

export function parseEmbeddedSupervisorBuildInfo(stdout, stderr = "", code = 0) {
  if (code !== 0) fail(`Supervisor --build-info-json exited with ${code}`);
  const lines = String(stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) fail("Supervisor build-info output must contain exactly one JSON line");
  let value;
  try {
    value = JSON.parse(lines[0]);
  } catch {
    fail("Supervisor build-info output is not valid JSON");
  }
  if (!value || value.schemaVersion !== 1 || value.mode !== "pkg-exe")
    fail("embedded Supervisor build-info schema/mode mismatch");
  if (typeof value.checkoutSha !== "string" || !/^[0-9a-f]{40}$/i.test(value.checkoutSha))
    fail("embedded Supervisor checkout SHA is invalid");
  if (typeof value.sourceFingerprint !== "string" || !/^[0-9a-f]{64}$/i.test(value.sourceFingerprint))
    fail("embedded Supervisor source fingerprint is invalid");
  if (typeof value.bundleSha256 !== "string" || !/^[0-9a-f]{64}$/i.test(value.bundleSha256))
    fail("embedded Supervisor bundle SHA is invalid");
  if (typeof value.entry !== "string" || value.entry.includes("/") || value.entry.includes("\\"))
    fail("embedded Supervisor entry is invalid");
  assertNoSecrets(value, "embedded Supervisor build-info");
  if (stderr && String(stderr).trim()) fail("Supervisor --build-info-json wrote stderr");
  return value;
}

export function assertSupervisorProvenance({
  resource,
  provenance,
  embedded,
  installedExecutableSha256,
  installedBundleSha256
}) {
  validateSupervisorProvenance(provenance);
  if (!embedded || embedded.schemaVersion !== 1 || embedded.mode !== "pkg-exe")
    fail("embedded Supervisor identity schema/mode mismatch");
  if (installedExecutableSha256 !== provenance.executableSha256 ||
      installedExecutableSha256 !== provenance.stagedExecutableSha256)
    fail("installed Supervisor executable SHA-256 does not match provenance");
  if (installedBundleSha256 !== provenance.bundleInputSha256 ||
      installedBundleSha256 !== provenance.stagedBundleSha256)
    fail("installed Supervisor bundle SHA-256 does not match provenance");
  for (const field of ["schemaVersion", "mode", "checkoutSha", "sourceFingerprint", "bundleSha256", "entry"])
    if (embedded[field] !== provenance[field]) fail(`embedded Supervisor identity mismatch: ${field}`);
  if (!provenance.executableRelativePath.toLowerCase().startsWith("supervisor/"))
    fail("Supervisor executable provenance escaped resource root");
  return true;
}

export function findUniqueSupervisorExecutable(supervisorRoot) {
  const matches = listFiles(supervisorRoot).filter(
    (file) => path.basename(file).toLowerCase() === SUPERVISOR_EXE_NAME.toLowerCase()
  );
  if (matches.length !== 1)
    fail(`expected exactly one packaged Supervisor exe, found ${matches.length}`);
  return matches[0];
}

export function validateInstalledResources(resourceRoot) {
  const runtime = path.join(resourceRoot, "runtime");
  const supervisor = path.join(resourceRoot, "supervisor");
  const mem0 = path.join(resourceRoot, "mem0");
  const infoPath = path.join(resourceRoot, "packaging-info.json");
  for (const required of [runtime, supervisor, mem0, infoPath])
    if (!fs.existsSync(required)) fail(`installed resource missing: ${required}`);
  const info = validatePackagingInfo(readJson(infoPath));
  const supervisorBuildInfoPath = path.join(resourceRoot, info.supervisorBuildInfo);
  if (!fs.existsSync(supervisorBuildInfoPath)) fail("installed Supervisor provenance is missing");
  const supervisorBuildInfo = validateSupervisorProvenance(readJson(supervisorBuildInfoPath));
  for (const required of [
    path.join(runtime, NODE_EXE_NAME),
    path.join(runtime, RUNTIME_ENTRY_NAME),
    path.join(runtime, RUNTIME_MANIFEST_NAME),
    path.join(supervisor, SUPERVISOR_BUNDLE_NAME),
    path.join(mem0, MEM0_EXE_NAME),
    path.join(mem0, MEM0_MANIFEST_NAME),
    path.join(mem0, MEM0_INTERNAL_DIR_NAME),
    path.join(resourceRoot, "local-stt", LOCAL_STT_EXE_NAME),
    path.join(resourceRoot, "local-stt", LOCAL_STT_MANIFEST_NAME),
    path.join(resourceRoot, "local-stt", LOCAL_STT_MODEL_MANIFEST_NAME),
    path.join(resourceRoot, "local-stt", "_internal"),
    path.join(resourceRoot, "local-stt", "models")
  ])
    if (!fs.existsSync(required)) fail(`installed resource missing: ${required}`);
  const supervisorExe = findUniqueSupervisorExecutable(supervisor);
  if (path.resolve(supervisorExe) !== path.resolve(path.join(resourceRoot, supervisorBuildInfo.executableRelativePath)))
    fail("Supervisor executable path does not match provenance");
  const runtimeManifest = readJson(path.join(runtime, RUNTIME_MANIFEST_NAME));
  for (const field of ["nodeExecutable", "runtimeEntry"])
    assertRelativeSafe(runtimeManifest[field], `runtime-manifest.${field}`);
  assertNoSecrets(runtimeManifest, "runtime-manifest");
  const mem0Result = validateMem0Artifact(mem0, { repoRoot: REPO_ROOT });
  const localStt = path.join(resourceRoot, "local-stt");
  if (!fs.existsSync(localStt)) fail("installed resource missing: local-stt");
  const localSttResult = validateLocalSttArtifact(localStt, { repoRoot: REPO_ROOT });
  const forbidden =
    /(?:^|[\\/])(?:\.env|cache|history\.db|config\.json|logs?|sqlite(?:3)?)(?:$|[\\/])/i;
  for (const file of listFiles(resourceRoot)) {
    const rel = path.relative(resourceRoot, file).replaceAll("\\", "/");
    // PyInstaller vendors normal Python distribution metadata under
    // _internal/*.dist-info/METADATA; that immutable package metadata is not
    // a runtime state file and must remain in the onedir artifact.
    if (forbidden.test(rel)) fail(`runtime resource contains forbidden mutable file: ${rel}`);
    if (/(?:^|\/)metadata(?:\.json|\.db)?$/i.test(rel) && !/\.dist-info\/METADATA$/i.test(rel))
      fail(`runtime resource contains forbidden metadata file: ${rel}`);
  }
  return {
    info,
    runtime,
    supervisor,
    supervisorExe,
    supervisorBuildInfo,
    mem0,
    runtimeManifest,
    mem0Result,
    localStt,
    localSttResult
  };
}

export function findUninstaller(installDir) {
  const candidates = ["uninstall.exe", "unins000.exe", "uninstaller.exe"]
    .map((name) => path.join(installDir, name))
    .filter((file) => fs.existsSync(file) && fs.statSync(file).isFile());
  if (candidates.length !== 1)
    fail(`expected one uninstaller in TEMP install, found ${candidates.length}`);
  if (!isWithin(candidates[0], installDir)) fail("uninstaller escaped install directory");
  return candidates[0];
}

export function findInstalledApplicationExecutable(installRoot) {
  const root = path.resolve(installRoot);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory())
    fail("installed application root is missing");
  const excluded = new Set([
    "uninstall.exe",
    "uninstaller.exe",
    "unins000.exe",
    SUPERVISOR_EXE_NAME.toLowerCase(),
    MEM0_EXE_NAME.toLowerCase(),
    NODE_EXE_NAME.toLowerCase()
  ]);
  const candidates = fs
    .readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        path.extname(entry.name).toLowerCase() === ".exe" &&
        !/^unins?[^.]*\.exe$/i.test(entry.name) &&
        !excluded.has(entry.name.toLowerCase())
    )
    .map((entry) => path.join(root, entry.name));
  if (candidates.length === 0) fail("installed Tauri application executable was not found");
  if (candidates.length > 1)
    fail(
      `multiple installed application executables: ${candidates.map((file) => path.basename(file)).join(", ")}`
    );
  if (!isWithin(candidates[0], root)) fail("installed application escaped TEMP install");
  return candidates[0];
}

function assertInstallerSwitches(installer) {
  const text = fs.readFileSync(installer).toString("latin1");
  if (!/\/D=/i.test(text) || !/\/S(?:ILENT)?/i.test(text))
    fail("installer does not advertise verified /D= and /S switches");
}

function assertSilentSwitch(executable, label) {
  const text = fs.readFileSync(executable).toString("latin1");
  if (!/\/S(?:ILENT)?/i.test(text)) fail(`${label} does not advertise a verified /S switch`);
}

function runProcess(file, args, options, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { ...options, shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      // Preserve partial output on the timeout error so callers can report
      // the helper's last-known progress. The message itself is unchanged.
      const timeoutError = new Error(`${path.basename(file)} timed out`);
      timeoutError.stdout = stdout;
      timeoutError.stderr = stderr;
      reject(timeoutError);
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ child, code, signal, stdout, stderr });
    });
  });
}

function writeLog(logDir, name, text) {
  fs.mkdirSync(logDir, { recursive: true });
  assertNoSecrets(text, `${name} log`);
  fs.writeFileSync(path.join(logDir, name), text, "utf8");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeBasename(value) {
  if (!value) return null;
  return path.win32.basename(String(value).replaceAll("/", "\\"));
}

function safeDiagnosticPath(value, installRoot) {
  if (!value) return null;
  const normalizedValue = stripWindowsDevicePrefix(value);
  const canonicalValue = normalizeWindowsPathForComparison(normalizedValue);
  const canonicalRoot = normalizeWindowsPathForComparison(installRoot);
  if (canonicalRoot && isWindowsPathInside(canonicalRoot, canonicalValue)) {
    return (
      path.win32.relative(
        canonicalRoot,
        canonicalValue
      ).replaceAll("\\", "/") || "."
    );
  }
  return safeBasename(normalizedValue);
}

function provenanceDiagnosticPath(value, installRoot) {
  if (!value) return "unavailable";
  const normalizedValue = stripWindowsDevicePrefix(value);
  const canonicalValue = normalizeWindowsPathForComparison(normalizedValue);
  const canonicalRoot = normalizeWindowsPathForComparison(installRoot);
  if (canonicalRoot && isWindowsPathInside(canonicalRoot, canonicalValue)) {
    return (
      path.win32
        .relative(canonicalRoot, canonicalValue)
        .replaceAll("\\", "/") || "."
    );
  }
  return `outside-install-root:${normalizedValue.replaceAll("\\", "/")}`;
}

export function powershellDiagnosticPath(env = process.env) {
  const systemRoot = env.SystemRoot ?? env.WINDIR ?? "C:\\Windows";
  return path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function listenerResult(port, overrides = {}) {
  return {
    port: Number.isInteger(Number(port)) && Number(port) > 0 ? Number(port) : null,
    state: "not-configured",
    owningPid: 0,
    processName: null,
    parentProcessId: 0,
    executablePath: null,
    creationDate: null,
    querySucceeded: false,
    queryErrorCode: null,
    executableInsideInstallRoot: false,
    pidEqualsSupervisorPid: false,
    pidEqualsKnownManagedPid: false,
    ...overrides
  };
}

/** Read-only Windows listener attribution. The PowerShell query never requests CommandLine. */
export function attributeWindowsListener(
  port,
  {
    execFile = execFileSync,
    platform = process.platform,
    systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows",
    installRoot = null,
    supervisorPid = 0,
    knownManagedPid = 0
  } = {}
) {
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort <= 0) {
    return listenerResult(null, { queryErrorCode: "invalid-port" });
  }
  if (platform !== "win32") {
    return listenerResult(numericPort, {
      state: "unsupported-platform",
      queryErrorCode: "platform-not-windows"
    });
  }
  const script = [
    "$connection = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort " +
      numericPort +
      " -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1",
    "if (-not $connection) {",
    "  @{ state = 'not-listening'; owningPid = 0 } | ConvertTo-Json -Compress",
    "  exit 0",
    "}",
    "$ownerPid = [int]$connection.OwningProcess",
    '$process = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,ExecutablePath,CreationDate -Filter "ProcessId=$ownerPid" | Select-Object -First 1',
    "@{",
    "  state = [string]$connection.State",
    "  owningPid = $ownerPid",
    "  processName = if ($process) { [string]$process.Name } else { $null }",
    "  parentProcessId = if ($process) { [int]$process.ParentProcessId } else { 0 }",
    "  executablePath = if ($process) { [string]$process.ExecutablePath } else { $null }",
    "  creationDate = if ($process) { [string]$process.CreationDate } else { $null }",
    "} | ConvertTo-Json -Compress"
  ].join("\n");
  try {
    const output = execFile(
      powershellDiagnosticPath({ SystemRoot: systemRoot }),
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"]
      }
    );
    const parsed = JSON.parse(String(output).trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "{}");
    const owningPid = Number(parsed.owningPid) > 0 ? Number(parsed.owningPid) : 0;
    const executablePath = typeof parsed.executablePath === "string" ? parsed.executablePath : null;
    return listenerResult(numericPort, {
      state: parsed.state === "not-listening" ? "not-listening" : String(parsed.state ?? "unknown"),
      owningPid,
      processName: parsed.processName ? String(parsed.processName) : null,
      parentProcessId: Number(parsed.parentProcessId) > 0 ? Number(parsed.parentProcessId) : 0,
      executablePath,
      creationDate: parsed.creationDate ? String(parsed.creationDate) : null,
      querySucceeded: true,
      executableInsideInstallRoot: Boolean(
        executablePath && installRoot && isWithin(executablePath, installRoot)
      ),
      pidEqualsSupervisorPid: owningPid > 0 && owningPid === Number(supervisorPid),
      pidEqualsKnownManagedPid: owningPid > 0 && owningPid === Number(knownManagedPid)
    });
  } catch (error) {
    return listenerResult(numericPort, {
      state: "query-failed",
      queryErrorCode: String(error?.code ?? "query-failed").slice(0, 80)
    });
  }
}

export function readOwnershipMetadataDiagnostic(
  metadataPath,
  { installRoot = null, smokeRoot = null } = {}
) {
  const base = {
    exists: false,
    mtimeMs: null,
    schemaVersion: null,
    protocolVersion: null,
    role: null,
    pid: 0,
    instanceId: null,
    marker: null,
    startTime: null,
    executable: null,
    executableInsideInstallRoot: false,
    queryErrorCode: null
  };
  if (smokeRoot && metadataPath && !isWithin(metadataPath, smokeRoot)) {
    return { ...base, queryErrorCode: "metadata-outside-smoke-root" };
  }
  if (!metadataPath || !fs.existsSync(metadataPath)) return base;
  try {
    const raw = readJson(metadataPath);
    const marker = raw?.commandMarker ?? raw?.marker ?? null;
    const executable = safeBasename(marker);
    return {
      ...base,
      exists: true,
      mtimeMs: fs.statSync(metadataPath).mtimeMs,
      schemaVersion: raw?.schemaVersion ?? null,
      protocolVersion: raw?.protocolVersion ?? null,
      role: raw?.role ?? null,
      pid: Number(raw?.pid) > 0 ? Number(raw.pid) : 0,
      instanceId: raw?.instanceId ?? null,
      marker: safeDiagnosticPath(marker, installRoot),
      startTime: raw?.processStartedAtUtc ?? raw?.startTime ?? null,
      executable,
      executableInsideInstallRoot: Boolean(marker && installRoot && isWithin(marker, installRoot))
    };
  } catch (error) {
    return { ...base, queryErrorCode: String(error?.code ?? "metadata-read-failed").slice(0, 80) };
  }
}

export function createDiagnosticPortRoles({ mem0ServicePort, supervisorRequestedControlPort }) {
  return {
    mem0ServicePort: Number(mem0ServicePort),
    supervisorPublicStatusPort: null,
    supervisorControlPort: null,
    supervisorRequestedControlPort: Number(supervisorRequestedControlPort)
  };
}

export function createOwnershipDiagnostics({
  ports,
  metadataPath,
  installRoot,
  smokeRoot,
  supervisorPid = 0,
  attribution = attributeWindowsListener,
  now = Date.now
}) {
  const startedAt = now();
  const checkpoints = [];
  const stateSequence = [];
  let lastStateKey = null;
  let firstListenerPhase = null;
  let knownSupervisorPid = Number(supervisorPid) || 0;
  let knownManagedPid = 0;
  let endpointPort = null;
  let knownSupervisorInstanceId = null;
  let knownSupervisorStartedAt = null;
  let currentMetadataPath = metadataPath;

  function currentPorts() {
    return {
      ...ports,
      supervisorPublicStatusPort: endpointPort,
      supervisorControlPort: endpointPort
    };
  }

  async function sample(
    phase,
    {
      endpoint,
      instanceId = null,
      supervisorStartedAt = null,
      ownership = null,
      status = null,
      pid = 0
    } = {}
  ) {
    if (endpoint) endpointPort = Number(endpoint);
    if (instanceId) knownSupervisorInstanceId = String(instanceId);
    if (supervisorStartedAt) knownSupervisorStartedAt = String(supervisorStartedAt);
    if (pid) knownManagedPid = Number(pid);
    const timestamp = now();
    const stateKey = JSON.stringify([status, ownership, Number(pid) || 0]);
    if ((status || ownership) && stateKey !== lastStateKey) {
      lastStateKey = stateKey;
      stateSequence.push({
        phase,
        relativeMs: Math.max(0, timestamp - startedAt),
        status,
        ownership,
        pid: Number(pid) || 0
      });
    }
    const roles = currentPorts();
    const queryEntries = [
      ["mem0Service", roles.mem0ServicePort],
      ["supervisorPublicStatus", roles.supervisorPublicStatusPort],
      ["supervisorControl", roles.supervisorControlPort],
      ["supervisorRequestedControl", roles.supervisorRequestedControlPort]
    ];
    const listeners = {};
    for (const [role, port] of queryEntries) {
      try {
        listeners[role] = await attribution(port, {
          installRoot,
          supervisorPid: knownSupervisorPid,
          knownManagedPid
        });
      } catch (error) {
        listeners[role] = listenerResult(port, {
          state: "query-failed",
          queryErrorCode: String(error?.code ?? "query-failed").slice(0, 80)
        });
      }
    }
    const metadata = readOwnershipMetadataDiagnostic(currentMetadataPath, {
      installRoot,
      smokeRoot
    });
    const mem0Listener = listeners.mem0Service;
    const listening = mem0Listener?.state === "Listen" || Number(mem0Listener?.owningPid) > 0;
    if (!firstListenerPhase && listening) firstListenerPhase = phase;
    const point = {
      phase,
      isoTime: new Date(timestamp).toISOString(),
      relativeMs: Math.max(0, timestamp - startedAt),
      ports: roles,
      supervisorPid: knownSupervisorPid,
      supervisorInstanceId: knownSupervisorInstanceId,
      supervisorStartedAt: knownSupervisorStartedAt,
      ownership,
      status,
      mem0Pid: knownManagedPid,
      listeners,
      metadata
    };
    checkpoints.push(point);
    return point;
  }

  async function observeStatus(phase, service) {
    const nextKey = JSON.stringify([
      service?.status ?? null,
      service?.ownership ?? null,
      Number(service?.pid) || 0
    ]);
    if (nextKey === lastStateKey) return null;
    return sample(phase, {
      ownership: service?.ownership ?? null,
      status: service?.status ?? null,
      pid: Number(service?.pid) || 0
    });
  }

  function snapshot() {
    return {
      checkpoints,
      stateSequence,
      firstListenerPhase,
      ports: currentPorts(),
      metadataPath: currentMetadataPath
    };
  }

  return {
    setSupervisorPid(pid) {
      knownSupervisorPid = Number(pid) || 0;
    },
    setMetadataPath(filePath) {
      currentMetadataPath = filePath;
    },
    sample,
    observeStatus,
    snapshot
  };
}

export function formatOwnershipDiagnostic({
  diagnostic,
  supervisorExecutable = null,
  installRoot = null
}) {
  const snapshot = diagnostic?.snapshot ? diagnostic.snapshot() : diagnostic;
  const points = snapshot?.checkpoints ?? [];
  const last = points.at(-1) ?? null;
  const listener = last?.listeners?.mem0Service ?? listenerResult(null);
  const metadata = last?.metadata ?? readOwnershipMetadataDiagnostic(null);
  const roles = snapshot?.ports ?? {};
  const sequence =
    (snapshot?.stateSequence ?? [])
      .map(
        (point) =>
          `${point.relativeMs}ms ${point.status ?? "unknown"}/${point.ownership ?? "unknown"}`
      )
      .join(" -> ") || "none";
  const safeSupervisor = safeDiagnosticPath(supervisorExecutable, installRoot);
  const safeExecutable = safeDiagnosticPath(listener.executablePath, installRoot);
  const parseDiagnosticTime = (value) => {
    if (!value) return NaN;
    const parsed = Date.parse(String(value));
    if (Number.isFinite(parsed)) return parsed;
    const match = String(value).match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
    return match
      ? Date.UTC(
          Number(match[1]),
          Number(match[2]) - 1,
          Number(match[3]),
          Number(match[4]),
          Number(match[5]),
          Number(match[6])
        )
      : NaN;
  };
  const metadataStartMs = parseDiagnosticTime(metadata.startTime);
  const listenerStartMs = parseDiagnosticTime(listener.creationDate);
  const metadataStartMatches =
    Number.isFinite(metadataStartMs) && Number.isFinite(listenerStartMs)
      ? Math.abs(metadataStartMs - listenerStartMs) <= 2_500
      : false;
  const metadataExeMatches = Boolean(
    metadata.executable &&
    listener.processName &&
    metadata.executable.toLowerCase() === listener.processName.toLowerCase()
  );
  const metadataInstanceMatches = Boolean(
    metadata.instanceId &&
    last?.supervisorInstanceId &&
    metadata.instanceId === last.supervisorInstanceId
  );
  return [
    "MEM0 OWNERSHIP DIAGNOSTIC",
    "",
    "port roles:",
    `  mem0 service: ${roles.mem0ServicePort ?? "unknown"}`,
    `  supervisor public/status: ${roles.supervisorPublicStatusPort ?? "unknown"}`,
    `  supervisor control: ${roles.supervisorControlPort ?? "unknown"}`,
    `  supervisor requested control: ${roles.supervisorRequestedControlPort ?? "unknown"}`,
    "",
    "supervisor:",
    `  pid: ${last?.supervisorPid || "unknown"}`,
    `  executable: ${safeSupervisor ?? "unknown"}`,
    `  start time: ${last?.supervisorStartedAt ?? "unknown"}`,
    "",
    "mem0 listener:",
    `  listening: ${listener.state === "Listen" ? "yes" : listener.state}`,
    `  pid: ${listener.owningPid || "unknown"}`,
    `  parent pid: ${listener.parentProcessId || "unknown"}`,
    `  process name: ${listener.processName ?? "unknown"}`,
    `  executable: ${safeExecutable ?? "unknown"}`,
    `  creation date: ${listener.creationDate ?? "unknown"}`,
    `  inside current install root: ${listener.executableInsideInstallRoot ? "yes" : "no"}`,
    `  child of supervisor: ${listener.parentProcessId > 0 && listener.parentProcessId === Number(last?.supervisorPid) ? "yes" : "no"}`,
    "",
    "ownership:",
    `  observed sequence: ${sequence}`,
    `  metadata exists: ${metadata.exists ? "yes" : "no"}`,
    `  metadata pid: ${metadata.pid || "unknown"}`,
    `  metadata instance matches: ${metadataInstanceMatches ? "yes" : "unknown"}`,
    `  metadata start time matches: ${metadataStartMatches ? "yes" : "unknown"}`,
    `  metadata executable matches: ${metadataExeMatches ? "yes" : "unknown"}`,
    "",
    "classification evidence:",
    `  known current-run process: ${listener.pidEqualsKnownManagedPid || listener.pidEqualsSupervisorPid ? "yes" : "no"}`,
    `  unexplained external listener: ${listener.owningPid > 0 && !listener.pidEqualsKnownManagedPid && !listener.pidEqualsSupervisorPid ? "yes" : "unknown"}`
  ].join("\n");
}

export function formatDiagnosticSummary({ diagnostic, installRoot = null }) {
  const snapshot = diagnostic?.snapshot ? diagnostic.snapshot() : diagnostic;
  const points = snapshot?.checkpoints ?? [];
  const beforeSpawn = points.find((point) => point.phase === "T1-supervisor-spawn-before");
  const listenerPoint = points.find((point) => Number(point.listeners?.mem0Service?.owningPid) > 0);
  const metadataPoint = points.find((point) => point.metadata?.exists);
  const finalState = [...(snapshot?.stateSequence ?? [])].at(-1);
  const listener = listenerPoint?.listeners?.mem0Service ?? listenerResult(null);
  const metadata = metadataPoint?.metadata ?? readOwnershipMetadataDiagnostic(null);
  const roles = snapshot?.ports ?? {};
  return [
    `port roles: mem0 service=${roles.mem0ServicePort ?? "unknown"}, supervisor public/status=${roles.supervisorPublicStatusPort ?? "unknown"}, supervisor control=${roles.supervisorControlPort ?? "unknown"}, requested control=${roles.supervisorRequestedControlPort ?? "unknown"}`,
    `T1 Mem0 listener=${beforeSpawn?.listeners?.mem0Service?.state ?? "unknown"}`,
    `listener first=${snapshot?.firstListenerPhase ?? "none"}, pid=${listener.owningPid || "none"}, parent=${listener.parentProcessId || "none"}, exe=${safeDiagnosticPath(listener.executablePath, installRoot) ?? "none"}, childOfSupervisor=${listener.parentProcessId > 0 && listener.parentProcessId === Number(listenerPoint?.supervisorPid) ? "yes" : "no"}`,
    `metadata first=${metadataPoint?.phase ?? "none"}, pid=${metadata.pid || "none"}, exe=${metadata.executable ?? "none"}`,
    `ownership sequence=${(snapshot?.stateSequence ?? []).map((entry) => `${entry.relativeMs}ms ${entry.status ?? "unknown"}/${entry.ownership ?? "unknown"}`).join(" -> ") || "none"}`,
    `final ownership=${finalState?.ownership ?? "unknown"}, shutdown=pids-exited, resource=unchanged, orphan=none, temp=clean`
  ].join("\n");
}

export function createTauriTimeline(now = Date.now, maxEntries = 64) {
  const startedAt = now();
  const events = [];
  const limit = Math.max(1, Number(maxEntries) || 64);
  let dropped = 0;
  return {
    mark(phase, fields = {}) {
      if (events.length >= limit) {
        dropped += 1;
        return;
      }
      const timestamp = now();
      events.push({
        phase,
        isoTime: new Date(timestamp).toISOString(),
        relativeMs: Math.max(0, timestamp - startedAt),
        ...fields
      });
    },
    snapshot() {
      return [...events];
    },
    droppedCount() {
      return dropped;
    }
  };
}

function safePidSnapshot(pid, pidProbe) {
  const numericPid = Number(pid) || 0;
  if (numericPid <= 0) return { pid: 0, status: "unknown" };
  try {
    return { pid: numericPid, status: pidProbe(numericPid) ? "alive" : "exited" };
  } catch (error) {
    const code = String(error?.code ?? "query-failed").slice(0, 80);
    return {
      pid: numericPid,
      status: "unknown",
      queryErrorCode: code === "ETIMEDOUT" ? "query-timeout" : code
    };
  }
}

function safePortFromUrl(value) {
  try {
    const parsed = new URL(String(value ?? ""));
    const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

function safeListenerSnapshot(
  port,
  {
    installRoot,
    supervisorPid,
    knownManagedPid,
    listenerProbe
  }
) {
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort <= 0)
    return { port: null, state: "not-configured" };
  try {
    const listener = listenerProbe(numericPort, {
      installRoot,
      supervisorPid,
      knownManagedPid
    });
    return {
      port: numericPort,
      state: listener?.state ?? "unknown",
      owningPid: Number(listener?.owningPid) || 0,
      parentProcessId: Number(listener?.parentProcessId) || 0,
      processName: listener?.processName ?? null,
      executablePath: safeDiagnosticPath(listener?.executablePath, installRoot),
      creationDate: listener?.creationDate ?? null,
      queryErrorCode: listener?.queryErrorCode ?? null,
      pidEqualsSupervisorPid: listener?.pidEqualsSupervisorPid === true,
      pidEqualsKnownManagedPid: listener?.pidEqualsKnownManagedPid === true
    };
  } catch (error) {
    const code = String(error?.code ?? "query-failed").slice(0, 80);
    return {
      port: numericPort,
      state: "query-failed",
      owningPid: 0,
      parentProcessId: 0,
      processName: null,
      executablePath: null,
      creationDate: null,
      queryErrorCode: code === "ETIMEDOUT" ? "query-timeout" : code,
      pidEqualsSupervisorPid: false,
      pidEqualsKnownManagedPid: false
    };
  }
}

/** Read-only process/listener snapshot that never replaces the primary error. */
export function createTauriFailureSnapshot({
  appPid = 0,
  supervisorPid = 0,
  runtimePid = 0,
  mem0Pid = 0,
  endpoint = null,
  runtime = null,
  mem0 = null,
  installRoot = null,
  pidProbe = pidAlive,
  listenerProbe = attributeWindowsListener,
  now = Date.now
} = {}) {
  const supervisorPort = safePortFromUrl(endpoint?.baseUrl);
  const runtimePort = safePortFromUrl(runtime?.url);
  const mem0Port = safePortFromUrl(mem0?.url);
  const snapshot = {
    capturedAt: new Date(now()).toISOString(),
    processes: {
      app: safePidSnapshot(appPid, pidProbe),
      supervisor: safePidSnapshot(supervisorPid, pidProbe),
      runtime: safePidSnapshot(runtimePid || runtime?.pid, pidProbe),
      mem0: safePidSnapshot(mem0Pid || mem0?.pid, pidProbe)
    },
    listeners: {},
    snapshotStatus: "ok"
  };
  snapshot.listeners.supervisor = safeListenerSnapshot(supervisorPort, {
    installRoot,
    supervisorPid,
    knownManagedPid: supervisorPid,
    listenerProbe
  });
  snapshot.listeners.runtime = safeListenerSnapshot(runtimePort, {
    installRoot,
    supervisorPid,
    knownManagedPid: runtimePid || runtime?.pid || 0,
    listenerProbe
  });
  snapshot.listeners.mem0 = safeListenerSnapshot(mem0Port, {
    installRoot,
    supervisorPid,
    knownManagedPid: mem0Pid || mem0?.pid || 0,
    listenerProbe
  });
  if (
    Object.values(snapshot.processes).some((entry) => entry.queryErrorCode === "query-timeout") ||
    Object.values(snapshot.listeners).some((entry) => entry.queryErrorCode === "query-timeout")
  ) {
    snapshot.snapshotStatus = "query-timeout";
  }
  return snapshot;
}

export function formatTauriFailureDiagnostic({
  primaryError,
  requestDiagnostics,
  timeline,
  snapshot,
  processQueries = []
} = {}) {
  const failure = requestDiagnostics?.lastFailure?.();
  const primaryCode = failure?.errorCode ?? diagnosticErrorField(primaryError, "code") ?? "unknown";
  const primaryName = failure?.errorName ?? String(primaryError?.name ?? "Error").slice(0, 80);
  const requestLines = requestDiagnostics?.format?.() || "  none";
  const timelineLines = timeline?.snapshot?.()
    ?.map((event) => `  ${event.phase}: ${event.isoTime} (+${event.relativeMs}ms)`)
    .join("\n") || "  none";
  const processLines = Object.entries(snapshot?.processes ?? {})
    .map(([role, state]) => `  ${role}: pid=${state.pid || "unknown"} status=${state.status}${state.queryErrorCode ? ` query=${state.queryErrorCode}` : ""}`)
    .join("\n") || "  unavailable";
  const listenerLines = Object.entries(snapshot?.listeners ?? {})
    .map(([role, listener]) => `  ${role}: port=${listener.port ?? "unknown"} state=${listener.state} pid=${listener.owningPid || "unknown"} parent=${listener.parentProcessId || "unknown"} process=${listener.processName ?? "unknown"} executable=${listener.executablePath ?? "unknown"} query=${listener.queryErrorCode ?? "none"}`)
    .join("\n") || "  unavailable";
  const processQueryLines = processQueries
    .map((query) => `  ${query.role}: pid=${query.pid || "unknown"} startedAt=${query.startedAt ?? "unknown"} endedAt=${query.endedAt ?? "unknown"} elapsedMs=${query.elapsedMs ?? "unknown"} outcome=${query.outcome} query=${query.errorCode ?? "none"}`)
    .join("\n") || "  none";
  return [
    "TAURI SMOKE FAILURE DIAGNOSTIC",
    `  primaryError: ${primaryName}`,
    `  primaryCode: ${primaryCode}`,
    `  snapshot: ${snapshot?.snapshotStatus ?? "unknown"}`,
    "",
    "requests:",
    requestLines,
    "",
    "timeline:",
    timelineLines,
    "",
    "processes:",
    processLines,
    "",
    "listeners:",
    listenerLines,
    "",
    "process-queries:",
    processQueryLines
  ].join("\n");
}

function tauriRuntimePort(runtime) {
  try {
    const parsed = new URL(String(runtime?.url ?? ""));
    const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

function formatTauriRuntimeOwnershipDiagnostic({
  appPid,
  appExecutable,
  pointer,
  endpoint,
  runtime,
  installRoot,
  smokeRoot,
  localAppData,
  timeline,
  expectedBundledNodePath = path.join(installRoot, "runtime", NODE_EXE_NAME),
  expectedEntrypointPath = path.join(installRoot, "runtime", RUNTIME_ENTRY_NAME)
}) {
  const supervisorPid = Number(pointer?.pid) || 0;
  const runtimePid = Number(runtime?.pid) || 0;
  const expectedPort = tauriRuntimePort(runtime);
  const listener = expectedPort
    ? attributeWindowsListener(expectedPort, {
        installRoot,
        supervisorPid,
        knownManagedPid: runtimePid
      })
    : listenerResult(null, { queryErrorCode: "runtime-url-unavailable" });
  const metadataPath =
    typeof endpoint?.stateDirectory === "string"
      ? path.join(endpoint.stateDirectory, "runtime.pid.json")
      : null;
  const metadata = readOwnershipMetadataDiagnostic(metadataPath, {
    installRoot,
    smokeRoot
  });
  const runtimeCommandLine = runtimePid > 0 ? processCommandLine(runtimePid) : "";
  const metadataExecutableMatch = Boolean(
    metadata.marker &&
      runtimeCommandLine &&
      runtimeCommandLine.toLowerCase().includes(String(metadata.marker).toLowerCase())
  );
  const metadataInstanceMatch = Boolean(
    metadata.instanceId && endpoint?.instanceId && metadata.instanceId === endpoint.instanceId
  );
  const runtimeProvenance = evaluateRuntimeProvenance({
    imagePath: listener.executablePath || processExecutablePath(runtimePid),
    commandLine: runtimeCommandLine,
    expectedBundledNodePath,
    expectedEntrypointPath,
    installRoot
  });
  runtimeProvenance.pid = runtimePid;
  runtimeProvenance.processName = listener.processName;
  const timelineLines = (timeline ?? [])
    .map(
      (event) =>
        `  ${event.phase}: ${event.isoTime} (+${event.relativeMs}ms)`
    )
    .join("\n");
  const appPath = safeDiagnosticPath(appExecutable, installRoot) ?? "unknown";
  const supervisorPort = endpoint?.baseUrl ? Number(new URL(endpoint.baseUrl).port) : null;
  const supervisorListener = supervisorPort
    ? attributeWindowsListener(supervisorPort, { installRoot, supervisorPid })
    : listenerResult(null, { queryErrorCode: "supervisor-endpoint-unavailable" });
  const runtimePath = listener.executablePath;
  const runtimeChildOfTauri = listener.parentProcessId > 0 && listener.parentProcessId === Number(appPid);
  const runtimeChildOfSupervisor =
    listener.parentProcessId > 0 && listener.parentProcessId === supervisorPid;
  const runtimeFirstListener = (timeline ?? []).find((event) => event.runtimeListening)?.phase ?? "none";
  return [
    "TAURI RUNTIME OWNERSHIP DIAGNOSTIC",
    "",
    "app:",
    `  pid: ${Number(appPid) || "unknown"}`,
    `  executable: ${appPath}`,
    "",
    "supervisor:",
    `  pid: ${supervisorPid || "unknown"}`,
    `  parent pid: ${supervisorListener.parentProcessId || "unknown"}`,
    `  executable: ${safeDiagnosticPath(supervisorListener.executablePath, installRoot) ?? "unknown"}`,
    `  active-instance exists: ${pointer ? "yes" : "no"}`,
    `  endpoint: ${endpoint?.baseUrl ?? "unknown"}`,
    "",
    "runtime:",
    `  expected port: ${expectedPort ?? "unknown"}`,
    `  listening: ${listener.state === "Listen" ? "yes" : listener.state}`,
    `  pid: ${listener.owningPid || runtimePid || "unknown"}`,
    `  parent pid: ${listener.parentProcessId || "unknown"}`,
    `  process name: ${listener.processName ?? "unknown"}`,
    `  executable: ${safeDiagnosticPath(runtimePath, installRoot) ?? "unknown"}`,
    `  executable inside install root: ${listener.executableInsideInstallRoot ? "yes" : "no"}`,
    "",
    "ownership:",
    `  health: ${runtime?.status ?? "unknown"}`,
    `  ownership: ${runtime?.ownership ?? "unknown"}`,
    `  metadata exists: ${metadata.exists ? "yes" : "no"}`,
    `  metadata pid: ${metadata.pid || "unknown"}`,
    `  metadata instance match: ${metadataInstanceMatch ? "yes" : "no"}`,
    `  metadata executable match: ${metadataExecutableMatch ? "yes" : "no"}`,
    "",
    "relationship:",
    `  runtime child of Tauri: ${runtimeChildOfTauri ? "yes" : "no"}`,
    `  runtime child of Supervisor: ${runtimeChildOfSupervisor ? "yes" : "no"}`,
    `  runtime known to current Supervisor: ${runtimePid > 0 && runtimePid === Number(runtime?.pid) ? "yes" : "no"}`,
    "",
    formatRuntimeProvenanceDiagnostic({
      stage: "TAURI",
      provenance: runtimeProvenance,
      installRoot,
      supervisorPid,
      runtimeParentPid: listener.parentProcessId,
      ownership: runtime?.ownership ?? "unknown",
      metadataPid: metadata.pid,
      metadataInstanceMatch
    }),
    "",
    "bootstrap:",
    `  supervisor started before Runtime: ${supervisorPid > 0 && (!listener.creationDate || !runtime?.startedAt || Date.parse(listener.creationDate) >= Date.parse(runtime.startedAt)) ? "yes" : "unknown"}`,
    `  managed Runtime intent observed: ${runtime?.managed === true ? "configured" : "not-observed"}`,
    `  Runtime first listener phase: ${runtimeFirstListener}`,
    "",
    "timeline:",
    timelineLines || "  none",
    "",
    `  isolated LocalAppData root: ${safeDiagnosticPath(localAppData, smokeRoot) ?? "unknown"}`
  ].join("\n");
}

export async function waitForSpecificPidsExit(
  entries,
  { pidProbe = pidAlive, sleep = wait, now = Date.now, timeoutMs = 10_000 } = {}
) {
  const owned = entries.filter(
    (entry) => Number.isInteger(Number(entry.pid)) && Number(entry.pid) > 0
  );
  const deadline = now() + Math.max(0, timeoutMs);
  while (owned.some((entry) => pidProbe(Number(entry.pid)))) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      const live = owned
        .filter((entry) => pidProbe(Number(entry.pid)))
        .map((entry) => `${entry.role} PID ${Number(entry.pid)}`)
        .join(", ");
      fail(`owned process exit timeout before cleanup: ${live}`);
    }
    await sleep(Math.min(250, remaining));
  }
}

export async function removeTreeWithRetries(
  target,
  {
    smokeOwnedRoot,
    remove = fs.rmSync,
    sleep = wait,
    now = Date.now,
    maxAttempts = 8,
    deadlineMs = 10_000,
    retryableCodes = ["EPERM", "EBUSY", "ENOTEMPTY"],
    phase = "temp-tree-cleanup",
    onRetry = ({ code, attempt, targetName }) =>
      console.warn(
        `[installer-smoke] cleanup retry phase=${phase} code=${code} attempt=${attempt} target=${targetName}`
      ),
    systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows"
  } = {}
) {
  if (typeof target !== "string" || target.trim().length === 0) fail("cleanup target is empty");
  if (typeof smokeOwnedRoot !== "string" || smokeOwnedRoot.trim().length === 0)
    fail("smoke-owned cleanup root is required");
  const resolved = path.resolve(target);
  const ownedRoot = path.resolve(smokeOwnedRoot);
  assertTempRoot(ownedRoot);
  if (!isWithin(resolved, ownedRoot)) fail("cleanup target is outside smoke root");
  if (path.parse(resolved).root === resolved) fail("cleanup target cannot be a drive root");
  const repoRoot = path.resolve(REPO_ROOT);
  if (isWithin(resolved, repoRoot)) fail("cleanup target is inside repository");
  const resolvedSystemRoot = path.resolve(systemRoot);
  if (isWithin(resolved, resolvedSystemRoot)) fail("cleanup target is inside SystemRoot");

  const retryCodes = new Set(
    retryableCodes.filter((code) => ["EPERM", "EBUSY", "ENOTEMPTY"].includes(code))
  );
  const started = now();
  for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt += 1) {
    try {
      await remove(resolved, { recursive: true, force: true });
      return resolved;
    } catch (error) {
      const code = error?.code;
      if (code === "ENOENT") return resolved;
      const remaining = deadlineMs - (now() - started);
      if (!retryCodes.has(code) || attempt >= Math.max(1, maxAttempts) || remaining <= 0)
        throw error;
      const delayMs = Math.min(1_000, 100 * 2 ** (attempt - 1), remaining);
      onRetry({ code, attempt, targetName: path.basename(resolved) });
      await sleep(delayMs);
    }
  }
  return resolved;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

export async function allocateDistinctPorts({ free = freePort, maxAttempts = 4 } = {}) {
  const mem0Port = await free();
  for (let attempt = 0; attempt < Math.max(1, maxAttempts); attempt += 1) {
    const supervisorPort = await free();
    if (supervisorPort !== mem0Port) return { mem0Port, supervisorPort };
  }
  fail(`unable to allocate distinct smoke ports (Mem0 ${mem0Port})`);
}

const DEFAULT_REQUEST_DIAGNOSTIC_LIMIT = 64;

function diagnosticErrorField(error, field) {
  const value = error?.[field];
  if (value === undefined || value === null || value === "") return null;
  return typeof value === "number" ? value : String(value).slice(0, 80);
}

/** Bounded, secret-free identity/outcome records for smoke HTTP requests. */
export function createRequestDiagnostics({
  now = Date.now,
  maxEntries = DEFAULT_REQUEST_DIAGNOSTIC_LIMIT,
  timeline = null
} = {}) {
  const limit = Math.max(1, Number(maxEntries) || DEFAULT_REQUEST_DIAGNOSTIC_LIMIT);
  const entries = [];
  let nextRequestId = 0;

  const find = (requestId) => entries.find((entry) => entry.requestId === requestId);
  const safeHost = (parsed) => String(parsed.hostname || "").slice(0, 255);
  const safePort = (parsed) => Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  const safePathname = (parsed) => String(parsed.pathname || "/").slice(0, 512);

  return {
    begin({ label, method, parsed }) {
      const entry = {
        requestId: `http-${++nextRequestId}`,
        label: String(label || "http.request").slice(0, 80),
        method: String(method || "GET").toUpperCase().slice(0, 16),
        host: safeHost(parsed),
        port: safePort(parsed),
        pathname: safePathname(parsed),
        startedAt: new Date(now()).toISOString(),
        completedAt: null,
        elapsedMs: null,
        phase: "before-connect",
        outcome: "pending",
        status: null,
        errorName: null,
        errorCode: null,
        errno: null,
        syscall: null
      };
      if (entries.length >= limit) entries.shift();
      entries.push(entry);
      timeline?.mark("E7-before-http-request", {
        requestId: entry.requestId,
        label: entry.label,
        method: entry.method,
        host: entry.host,
        port: entry.port,
        pathname: entry.pathname
      });
      return entry.requestId;
    },
    updatePhase(requestId, phase) {
      const entry = find(requestId);
      if (entry) entry.phase = String(phase || "unknown").slice(0, 40);
    },
    complete(requestId, { phase, status, error } = {}) {
      const entry = find(requestId);
      if (!entry) return;
      const completedAtMs = Number(now());
      const elapsedMs = Math.max(0, completedAtMs - Date.parse(entry.startedAt));
      entry.elapsedMs = Number.isFinite(elapsedMs) ? elapsedMs : null;
      entry.completedAt = new Date(completedAtMs).toISOString();
      entry.phase = String(phase || entry.phase || "unknown").slice(0, 40);
      if (error) {
        entry.outcome = "error";
        entry.errorName = String(error?.name || "Error").slice(0, 80);
        entry.errorCode = diagnosticErrorField(error, "code");
        entry.errno = diagnosticErrorField(error, "errno");
        entry.syscall = diagnosticErrorField(error, "syscall");
        timeline?.mark("E8-http-error", {
          requestId: entry.requestId,
          label: entry.label,
          phase: entry.phase,
          errorName: entry.errorName,
          errorCode: entry.errorCode
        });
      } else {
        entry.outcome = "response";
        entry.status = Number(status) || 0;
      }
    },
    snapshot() {
      return entries.map((entry) => ({ ...entry }));
    },
    lastFailure() {
      return [...entries].reverse().find((entry) => entry.outcome === "error") ?? null;
    },
    format({ includeSuccess = false } = {}) {
      return entries
        .filter((entry) => includeSuccess || entry.outcome === "error")
        .map((entry) => {
          const outcome = entry.outcome === "error"
            ? ` errorName=${entry.errorName ?? "unknown"} errorCode=${entry.errorCode ?? "unknown"} errno=${entry.errno ?? "unknown"} syscall=${entry.syscall ?? "unknown"}`
            : ` status=${entry.status ?? "unknown"}`;
          return `  ${entry.requestId} ${entry.label} ${entry.method} ${entry.host}:${entry.port}${entry.pathname} phase=${entry.phase} elapsedMs=${entry.elapsedMs ?? "unknown"} outcome=${entry.outcome}${outcome}`;
        })
        .join("\n");
    }
  };
}

export function requestJson(
  url,
  {
    method = "GET",
    token,
    body,
    label = "http.request",
    diagnostics = null,
    requestFactory = null
  } = {}
) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const requestId = diagnostics?.begin({ label, method, parsed });
    let phase = "before-connect";
    let settled = false;
    const finishError = (error) => {
      if (settled) return;
      settled = true;
      diagnostics?.complete(requestId, { phase, error });
      reject(error);
    };
    try {
      const request = (requestFactory ?? http.request)(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: `${parsed.pathname}${parsed.search}`,
          method,
          agent: false,
          headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(body ? { "content-type": "application/json" } : {})
          }
        },
        (response) => {
          if (settled) return;
          phase = "response-headers-received";
          diagnostics?.updatePhase(requestId, phase);
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            phase = "reading-body";
            diagnostics?.updatePhase(requestId, phase);
            text += chunk;
          });
          response.once("error", finishError);
          response.on("end", () => {
            if (settled) return;
            settled = true;
            let value = null;
            try {
              value = text ? JSON.parse(text) : null;
            } catch {
              /* diagnostics below */
            }
            diagnostics?.complete(requestId, { phase, status: response.statusCode ?? 0 });
            resolve({ status: response.statusCode ?? 0, value, text });
          });
        }
      );
      request.once("socket", (socket) => {
        if (socket?.connecting === false) phase = "connected";
        else socket?.once?.("connect", () => {
          phase = "connected";
          diagnostics?.updatePhase(requestId, phase);
        });
        diagnostics?.updatePhase(requestId, phase);
      });
      request.once("error", finishError);
      if (body) request.write(JSON.stringify(body));
      request.end();
    } catch (error) {
      finishError(error);
    }
  });
}

function safeWmCloseOutput(value, label) {
  const text = String(value ?? "");
  try {
    assertNoSecrets(text, label);
  } catch {
    return "<redacted secret-like output>";
  }
  return text.length > 8_000 ? text.slice(-8_000) : text;
}

function wmCloseExecutableDiagnostic(file) {
  const text = String(file ?? "");
  const basename = safeBasename(text) ?? "unknown";
  const isSystemPowerShell =
    /^powershell\.exe$/i.test(basename) &&
    /(?:^|[\\/])System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i.test(text);
  const isPythonHarness = /^python(?:\.exe)?$/i.test(basename);
  return {
    category: isSystemPowerShell
      ? "system-windows-powershell"
      : isPythonHarness
        ? "python-harness"
        : "wm-close-helper",
    path: isSystemPowerShell ? text.replaceAll("\\", "/") : basename
  };
}

function formatWmCloseFailure({
  reason,
  executable,
  helperPid,
  startedAt,
  now,
  lastPhase,
  stdout,
  stderr,
  killRequested,
  killResult,
  exitObservedAfterKill,
  exitCode,
  exitSignal,
  parseError
}) {
  const diagnostic = wmCloseExecutableDiagnostic(executable);
  const elapsedMs = Math.max(0, Number(now()) - Number(startedAt));
  return [
    reason,
    `helper_executable_category=${diagnostic.category}`,
    `helper_executable_path=${diagnostic.path}`,
    `helper_pid=${Number(helperPid) || 0}`,
    `elapsed_ms=${elapsedMs}`,
    `last_phase=${lastPhase || "unknown"}`,
    `kill_requested=${killRequested ? "yes" : "no"}`,
    `kill_result=${killResult ? "yes" : "no"}`,
    `exit_observed_after_kill=${exitObservedAfterKill ? "yes" : "no"}`,
    `exit_code=${exitCode === null || exitCode === undefined ? "none" : exitCode}`,
    `exit_signal=${exitSignal || "none"}`,
    parseError ? `parse_error=${parseError}` : null,
    `safe_stdout=${safeWmCloseOutput(stdout, "WM_CLOSE stdout") || "<empty>"}`,
    `safe_stderr=${safeWmCloseOutput(stderr, "WM_CLOSE stderr") || "<empty>"}`
  ]
    .filter(Boolean)
    .join("\n");
}

export const TAURI_MAIN_WINDOW_TITLE = "YUVI Chat";

export const WM_CLOSE_PYTHON_SOURCE = String.raw`
import ctypes
import sys
import time
from ctypes import wintypes

WM_CLOSE = 0x0010
started = time.monotonic()
target_pid = int(sys.argv[1])
expected_title = sys.argv[2]
pid_top_level_windows = 0
exact_title_matches = []
validated_pid = 0
title_exact = 0
identity_valid = 0
target_hwnd = 0
post_result = 0
visible_after_close = 1

def emit_phase(name):
    print(f"WM_CLOSE_PHASE={name}", flush=True)

def emit_result(error=None):
    print(f"target_pid={target_pid}", flush=True)
    print(f"pid_top_level_windows={pid_top_level_windows}", flush=True)
    print(f"exact_title_matches={len(exact_title_matches)}", flush=True)
    print(f"target_hwnd={target_hwnd}", flush=True)
    print(f"validated_pid={validated_pid}", flush=True)
    print(f"title_exact={title_exact}", flush=True)
    print(f"identity_valid={identity_valid}", flush=True)
    print(f"post_result={post_result}", flush=True)
    print(f"visible_after_close={visible_after_close}", flush=True)
    if error is not None:
        print(f"win32_error={error}", flush=True)
    print(f"elapsed_ms={max(0, int((time.monotonic() - started) * 1000))}", flush=True)

user32 = ctypes.WinDLL("user32", use_last_error=True)
EnumWindowsProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
user32.EnumWindows.argtypes = [EnumWindowsProc, wintypes.LPARAM]
user32.EnumWindows.restype = wintypes.BOOL
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.GetWindowThreadProcessId.restype = wintypes.DWORD
user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
user32.GetWindowTextLengthW.restype = ctypes.c_int
user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetWindowTextW.restype = ctypes.c_int
user32.IsWindow.argtypes = [wintypes.HWND]
user32.IsWindow.restype = wintypes.BOOL
user32.IsWindowVisible.argtypes = [wintypes.HWND]
user32.IsWindowVisible.restype = wintypes.BOOL
user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
user32.PostMessageW.restype = wintypes.BOOL

def read_title(hwnd):
    length = user32.GetWindowTextLengthW(hwnd)
    buffer = ctypes.create_unicode_buffer(max(1, length + 1))
    user32.GetWindowTextW(hwnd, buffer, len(buffer))
    return buffer.value

def enum_window(hwnd, _lparam):
    global pid_top_level_windows
    pid_value = wintypes.DWORD(0)
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid_value))
    if int(pid_value.value) != target_pid:
        return True
    pid_top_level_windows += 1
    if read_title(hwnd) == expected_title:
        exact_title_matches.append(int(hwnd))
    return True

emit_phase("start")
emit_phase("before_enum")
if not user32.EnumWindows(EnumWindowsProc(enum_window), 0):
    emit_phase("after_enum")
    emit_result(ctypes.get_last_error())
    raise SystemExit(1)
emit_phase("after_enum")
if len(exact_title_matches) != 1:
    emit_result()
    raise SystemExit(1)
target_hwnd = exact_title_matches[0]
emit_phase("before_revalidate")
pid_value = wintypes.DWORD(0)
user32.GetWindowThreadProcessId(target_hwnd, ctypes.byref(pid_value))
validated_pid = int(pid_value.value)
title_exact = int(read_title(target_hwnd) == expected_title)
identity_valid = int(bool(user32.IsWindow(target_hwnd)) and validated_pid == target_pid and title_exact == 1)
emit_phase("after_revalidate")
if identity_valid != 1:
    emit_result()
    raise SystemExit(1)
emit_phase("before_post")
post_result = int(bool(user32.PostMessageW(target_hwnd, WM_CLOSE, 0, 0)))
post_error = ctypes.get_last_error() if post_result == 0 else None
emit_phase("after_post")
for _ in range(20):
    if not user32.IsWindowVisible(target_hwnd):
        visible_after_close = 0
        break
    time.sleep(0.05)
emit_result(post_error)
raise SystemExit(0 if post_result == 1 else 1)
`;

export function resolveWmClosePythonExecutable(
  env = process.env,
  fsImpl = fs,
  platform = process.platform
) {
  const executable = String(env?.YUVI_PYTHON311 ?? "").trim();
  if (!executable) fail("Tauri WM_CLOSE harness requires YUVI_PYTHON311");
  const absolute = platform === "win32" ? path.win32.isAbsolute(executable) : path.isAbsolute(executable);
  if (!absolute) fail("Tauri WM_CLOSE harness requires an absolute YUVI_PYTHON311 path");
  let stat;
  try {
    stat = fsImpl.statSync(executable);
  } catch {
    fail("Tauri WM_CLOSE harness requires an existing YUVI_PYTHON311 file");
  }
  if (!stat?.isFile?.()) fail("Tauri WM_CLOSE harness requires an existing YUVI_PYTHON311 file");
  return executable;
}

export function parseWmCloseOutput(stdout, expectedPid = null) {
  const text = String(stdout ?? "");
  assertNoSecrets(text, "WM_CLOSE stdout");
  const phases = [...text.matchAll(/(?:^|\r?\n)WM_CLOSE_PHASE=([a-z_]+)(?=\r?$)/gm)].map(
    (match) => match[1]
  );
  const requiredPhases = [
    "start",
    "before_enum",
    "after_enum",
    "before_revalidate",
    "after_revalidate",
    "before_post",
    "after_post"
  ];
  if (phases.length !== requiredPhases.length || phases.some((phase, index) => phase !== requiredPhases[index]))
    fail("WM_CLOSE output has invalid phase sequence");
  const readInteger = (name) => {
    const matches = [...text.matchAll(new RegExp(`(?:^|\\r?\\n)${name}=(-?\\d+)(?=\\r?$)`, "gm"))];
    if (matches.length !== 1) fail(`WM_CLOSE output is missing or malformed ${name}`);
    const value = Number(matches[0][1]);
    if (!Number.isSafeInteger(value) || value < 0) fail(`WM_CLOSE output has invalid ${name}`);
    return value;
  };
  const targetPid = readInteger("target_pid");
  const pidTopLevelWindows = readInteger("pid_top_level_windows");
  const exactTitleMatches = readInteger("exact_title_matches");
  const targetHwnd = readInteger("target_hwnd");
  const validatedPid = readInteger("validated_pid");
  const titleExact = readInteger("title_exact");
  const identityValid = readInteger("identity_valid");
  const postResult = readInteger("post_result");
  const elapsedMs = readInteger("elapsed_ms");
  const visibleAfterCloseMatches = [
    ...text.matchAll(/(?:^|\r?\n)visible_after_close=(-?\d+)(?=\r?$)/gm)
  ];
  if (visibleAfterCloseMatches.length > 1)
    fail("WM_CLOSE output has duplicate visible_after_close");
  const visibleAfterClose = visibleAfterCloseMatches.length
    ? Number(visibleAfterCloseMatches[0][1])
    : null;
  if (visibleAfterClose !== null && ![0, 1].includes(visibleAfterClose))
    fail("WM_CLOSE output has invalid visible_after_close");
  if (expectedPid !== null && targetPid !== Number(expectedPid))
    fail(`WM_CLOSE output target PID mismatch (${targetPid})`);
  if (pidTopLevelWindows < 1) fail("WM_CLOSE found no target top-level windows");
  if (exactTitleMatches !== 1) fail("WM_CLOSE requires exactly one exact title match");
  if (targetHwnd <= 0) fail("WM_CLOSE output has invalid target_hwnd");
  if (expectedPid !== null && validatedPid !== Number(expectedPid))
    fail(`WM_CLOSE validated PID mismatch (${validatedPid})`);
  if (titleExact !== 1) fail("WM_CLOSE target title was not exact");
  if (identityValid !== 1) fail("WM_CLOSE target identity was not validated");
  if (postResult !== 1) fail("WM_CLOSE PostMessageW was not accepted");
  return {
    targetPid,
    pidTopLevelWindows,
    exactTitleMatches,
    targetHwnd,
    validatedPid,
    titleExact: titleExact === 1,
    identityValid: identityValid === 1,
    postResult: postResult === 1,
    visibleAfterClose: visibleAfterClose === null ? null : visibleAfterClose === 1,
    elapsedMs,
    phases,
    lastPhase: phases.at(-1) ?? "unknown"
  };
}

export function runWmCloseHelper({
  executable,
  args,
  options,
  timeoutMs,
  expectedPid = null,
  spawnImpl = spawn,
  killGraceMs = 1_000,
  now = Date.now
} = {}) {
  if (!executable) fail("WM_CLOSE helper executable is required");
  if (!Array.isArray(args)) fail("WM_CLOSE helper arguments are required");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) fail("WM_CLOSE helper timeout is invalid");
  const startedAt = Number(now());
  const phaseTimings = {};
  let child;
  let stdout = "";
  let stderr = "";
  let lastPhase = "unknown";
  let helperPid = 0;
  let timedOut = false;
  let killRequested = false;
  let killResult = false;
  let exitObserved = false;
  let exitCode = null;
  let exitSignal = null;
  let settled = false;
  let timer = null;
  let graceTimer = null;
  const rememberOutput = (stream, chunk) => {
    const text = chunk.toString();
    if (stream === "stdout") stdout += text;
    else stderr += text;
    for (const match of stdout.matchAll(/(?:^|\r?\n)WM_CLOSE_PHASE=([a-z_]+)/g)) {
      lastPhase = match[1];
      if (phaseTimings[lastPhase] === undefined)
        phaseTimings[lastPhase] = Math.max(0, Number(now()) - startedAt);
    }
  };
  return new Promise((resolve, reject) => {
    const clearTimers = () => {
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      timer = null;
      graceTimer = null;
    };
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(error);
    };
    const resolveOnce = (value) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(value);
    };
    const timeoutFailure = (reason) =>
      new Error(
        formatWmCloseFailure({
          reason,
          executable,
          helperPid,
          startedAt,
          now,
          lastPhase,
          stdout,
          stderr,
          killRequested,
          killResult,
          exitObservedAfterKill: exitObserved,
          exitCode,
          exitSignal
        })
      );
    const onExit = (code, signal) => {
      exitObserved = true;
      exitCode = code;
      exitSignal = signal;
      if (timedOut) {
        rejectOnce(timeoutFailure("WM_CLOSE helper timed out"));
        return;
      }
      if (code !== 0) {
        let parseError = null;
        try {
          parseWmCloseOutput(stdout, expectedPid);
        } catch (error) {
          parseError = error instanceof Error ? error.message : String(error);
        }
        rejectOnce(
          new Error(
            formatWmCloseFailure({
              reason: `WM_CLOSE helper exited with code ${code ?? "none"}`,
              executable,
              helperPid,
              startedAt,
              now,
              lastPhase,
              stdout,
              stderr,
              killRequested: false,
              killResult: false,
              exitObservedAfterKill: false,
              exitCode,
              exitSignal,
              parseError
            })
          )
        );
        return;
      }
      try {
        assertNoSecrets(stderr, "WM_CLOSE stderr");
        const parsed = parseWmCloseOutput(stdout, expectedPid);
        resolveOnce({
          child,
          code,
          signal,
          stdout,
          stderr,
          helperPid,
          executable: wmCloseExecutableDiagnostic(executable),
          lastPhase: parsed.lastPhase,
          phaseTimings,
          ...parsed,
          totalElapsedMs: Math.max(0, Number(now()) - startedAt)
        });
      } catch (error) {
        rejectOnce(error);
      }
    };
    const onError = (error) => {
      if (timedOut) return;
      rejectOnce(
        new Error(
          formatWmCloseFailure({
            reason: `WM_CLOSE helper spawn failed: ${safeWmCloseOutput(error?.message, "WM_CLOSE spawn error")}`,
            executable,
            helperPid,
            startedAt,
            now,
            lastPhase,
            stdout,
            stderr,
            killRequested: false,
            killResult: false,
            exitObservedAfterKill: false,
            exitCode,
            exitSignal
          })
        )
      );
    };
    try {
      child = spawnImpl(executable, args, { ...options, shell: false, windowsHide: true });
      helperPid = Number(child?.pid) || 0;
      child.stdout?.on("data", (chunk) => rememberOutput("stdout", chunk));
      child.stderr?.on("data", (chunk) => rememberOutput("stderr", chunk));
      child.once("error", onError);
      child.once("exit", onExit);
    } catch (error) {
      onError(error);
      return;
    }
    timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      killRequested = true;
      try {
        killResult = child.kill() !== false;
      } catch {
        killResult = false;
      }
      graceTimer = setTimeout(() => {
        if (settled) return;
        if (exitObserved) return;
        rejectOnce(
          timeoutFailure("WM_CLOSE helper timed out and did not exit after termination request")
        );
      }, Math.max(1, Number(killGraceMs) || 1));
    }, timeoutMs);
  });
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * Validate the Runtime /health protocol without conflating provider readiness
 * with the shape and core-health contract of the packaged Runtime.
 */
export function evaluateRuntimeHealthProtocol({ status, value } = {}) {
  const failureReasons = [];
  const body = isRecord(value) ? value : null;
  const server = body && isRecord(body.server) ? body.server : null;
  const database = body && isRecord(body.database) ? body.database : null;
  const providers = body && isRecord(body.providers) ? body.providers : null;
  const chat = providers && isRecord(providers.chat) ? providers.chat : null;
  const serverStatus = server && typeof server.status === "string" ? server.status : null;
  const databaseStatus = database && typeof database.status === "string" ? database.status : null;
  const chatAvailable = chat && typeof chat.available === "boolean" ? chat.available : null;
  const expectedOk = databaseStatus === "healthy" && chatAvailable === true;

  if (status !== 200) failureReasons.push(`HTTP status is ${String(status)}`);
  if (!body) failureReasons.push("body is not a JSON object");
  if (body && body.service !== "ai-companion-runtime")
    failureReasons.push("service identity is not ai-companion-runtime");
  if (body && typeof body.ok !== "boolean") failureReasons.push("ok is not boolean");
  if (!server) failureReasons.push("server object is missing");
  else if (serverStatus !== "healthy") failureReasons.push("server.status is not healthy");
  if (!database) failureReasons.push("database object is missing");
  else if (databaseStatus !== "healthy") failureReasons.push("database.status is not healthy");
  if (!providers) failureReasons.push("providers object is missing");
  if (!chat) failureReasons.push("providers.chat object is missing");
  else if (chatAvailable === null) failureReasons.push("providers.chat.available is not boolean");
  if (body && typeof body.ok === "boolean" && body.ok !== expectedOk)
    failureReasons.push(`ok does not match expected readiness (${String(expectedOk)})`);

  return {
    protocolValid: failureReasons.length === 0,
    failureReasons,
    status: Number.isInteger(status) ? status : null,
    service: typeof body?.service === "string" ? body.service : null,
    runtimeMode: typeof body?.runtimeMode === "string" ? body.runtimeMode : null,
    serverStatus,
    databaseStatus,
    chatProvider:
      typeof chat?.provider === "string"
        ? chat.provider
        : typeof chat?.name === "string"
          ? chat.name
          : null,
    chatConfigured: typeof chat?.configured === "boolean" ? chat.configured : null,
    chatAvailable,
    healthOk: typeof body?.ok === "boolean" ? body.ok : null,
    expectedOk
  };
}

export function formatRuntimeHealthProtocolDiagnostic(result = {}) {
  const safe = (value, fallback = "unknown") =>
    value === null || value === undefined || value === "" ? fallback : String(value);
  return [
    "RUNTIME HEALTH PROTOCOL",
    `  http status: ${safe(result.status)}`,
    `  service: ${safe(result.service)}`,
    `  runtime mode: ${safe(result.runtimeMode)}`,
    `  server status: ${safe(result.serverStatus)}`,
    `  database status: ${safe(result.databaseStatus)}`,
    `  chat provider: ${safe(result.chatProvider)}`,
    `  chat configured: ${result.chatConfigured === null ? "unknown" : result.chatConfigured ? "yes" : "no"}`,
    `  chat available: ${result.chatAvailable === null ? "unknown" : result.chatAvailable ? "yes" : "no"}`,
    `  health ok: ${result.healthOk === null ? "unknown" : result.healthOk ? "yes" : "no"}`,
    `  expected ok: ${result.expectedOk ? "yes" : "no"}`,
    `  protocol valid: ${result.protocolValid ? "yes" : "no"}`,
    ...(result.failureReasons?.length ? [`  failure reasons: ${result.failureReasons.join("; ")}`] : [])
  ].join("\n");
}

async function waitForJsonFile(file, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(file)) {
      try {
        const value = readJson(file);
        if (value?.baseUrl && value?.controlToken) return value;
      } catch {
        /* file may still be being written */
      }
    }
    await wait(250);
  }
  fail(`timed out waiting for ${file}`);
}

export async function waitForTauriBootstrapReady(
  file,
  { timeoutMs, appPid, supervisorPid, instanceId } = {}
) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(file)) {
      try {
        const marker = readJson(file);
        if (
          marker?.schemaVersion === 1 &&
          Number(marker.tauriPid) === Number(appPid) &&
          Number(marker.supervisorPid) === Number(supervisorPid) &&
          String(marker.instanceId) === String(instanceId) &&
          Number(marker.readyAtMs) > 0
        ) {
          return marker;
        }
      } catch {
        /* marker may still be being written */
      }
    }
    await wait(100);
  }
  fail("timed out waiting for Tauri bootstrap readiness barrier");
}

async function waitForSupervisorEndpoint(pointerRoot, stateRoot, timeoutMs, { checkExit } = {}) {
  const pointer = path.join(pointerRoot, "active-instance.json");
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const exitError = checkExit?.();
    if (exitError) fail(exitError);
    if (fs.existsSync(pointer)) {
      try {
        const active = readJson(pointer);
        if (active.endpointFile && isWithin(active.endpointFile, stateRoot)) {
          const endpoint = await waitForJsonFile(active.endpointFile, Math.min(timeoutMs, 5_000));
          if (endpoint && active.stateDirectory) endpoint.stateDirectory = active.stateDirectory;
          return endpoint;
        }
      } catch {
        /* pointer can be transient while the process starts */
      }
    }
    await wait(250);
  }
  fail(`timed out waiting for ${pointer}`);
}

function processCommandLine(pid, { onError } = {}) {
  if (!pid || process.platform !== "win32") return "";
  try {
    const script = `(Get-CimInstance Win32_Process -Filter \"ProcessId=${Number(pid)}\").CommandLine`;
    return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true
    }).trim();
  } catch (error) {
    onError?.(error);
    return "";
  }
}

export function processExecutablePath(
  pid,
  { execFile = execFileSync, platform = process.platform, onError } = {}
) {
  if (!pid || platform !== "win32") return "";
  try {
    const script = `(Get-CimInstance Win32_Process -Filter \"ProcessId=${Number(pid)}\").ExecutablePath`;
    return execFile(powershellDiagnosticPath(), ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true
    }).trim();
  } catch (error) {
    onError?.(error);
    return "";
  }
}

export function splitWindowsCommandLine(commandLine) {
  const text = String(commandLine ?? "");
  const tokens = [];
  let token = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (/\s/.test(char) && !quoted) {
      if (token) {
        tokens.push(token);
        token = "";
      }
      continue;
    }
    token += char;
  }
  if (token) tokens.push(token);
  return tokens;
}

export function parseRuntimeCommandLine(commandLine) {
  const tokens = splitWindowsCommandLine(commandLine);
  const executableToken = tokens[0] ?? null;
  const entrypointPath =
    tokens.find(
      (token) => path.win32.basename(stripWindowsDevicePrefix(token)).toLowerCase() === RUNTIME_ENTRY_NAME
    ) ?? null;
  return { executableToken, entrypointPath };
}

export function evaluateRuntimeProvenance({
  imagePath,
  commandLine,
  entrypointPath,
  expectedBundledNodePath,
  expectedEntrypointPath,
  installRoot,
  resolveExistingPath = resolveExistingWindowsPathForComparison
} = {}) {
  const parsed = parseRuntimeCommandLine(commandLine);
  const actualEntrypoint = entrypointPath ?? parsed.entrypointPath;
  const imageAvailable = Boolean(String(imagePath ?? "").trim());
  const entrypointAvailable = Boolean(String(actualEntrypoint ?? "").trim());

  const resolvePath = (value) => {
    try {
      const result = resolveExistingPath(value);
      if (typeof result === "string") {
        const resolvedPath = normalizeWindowsPathForComparison(result);
        return {
          ok: Boolean(resolvedPath),
          rawPath: typeof value === "string" ? stripWindowsDevicePrefix(value) : null,
          lexicalPath: normalizeWindowsPathForComparison(value) || null,
          resolvedPath: resolvedPath || null,
          errorCode: resolvedPath ? null : "INVALID_RESOLVED_PATH"
        };
      }
      if (!result || typeof result !== "object") {
        return {
          ok: false,
          rawPath: typeof value === "string" ? stripWindowsDevicePrefix(value) : null,
          lexicalPath: normalizeWindowsPathForComparison(value) || null,
          resolvedPath: null,
          errorCode: "RESOLVE_FAILED"
        };
      }
      const resolvedPath = normalizeWindowsPathForComparison(result.resolvedPath);
      return {
        ok: result.ok === true && Boolean(resolvedPath),
        rawPath: result.rawPath ?? (typeof value === "string" ? stripWindowsDevicePrefix(value) : null),
        lexicalPath: result.lexicalPath ?? (normalizeWindowsPathForComparison(value) || null),
        resolvedPath: resolvedPath || null,
        errorCode: result.errorCode ?? (result.ok === true ? null : "RESOLVE_FAILED")
      };
    } catch (error) {
      return {
        ok: false,
        rawPath: typeof value === "string" ? stripWindowsDevicePrefix(value) : null,
        lexicalPath: normalizeWindowsPathForComparison(value) || null,
        resolvedPath: null,
        errorCode: String(error?.code ?? "RESOLVE_FAILED").slice(0, 80)
      };
    }
  };

  const imageResolution = resolvePath(imagePath);
  const expectedImageResolution = resolvePath(expectedBundledNodePath);
  const entrypointResolution = resolvePath(actualEntrypoint);
  const expectedEntrypointResolution = resolvePath(expectedEntrypointPath);
  const installRootResolution = resolvePath(installRoot);
  const imageMatchesExpected =
    imageAvailable &&
    imageResolution.ok &&
    expectedImageResolution.ok &&
    imageResolution.resolvedPath === expectedImageResolution.resolvedPath;
  const imageInsideInstallRoot =
    imageResolution.ok &&
    installRootResolution.ok &&
    isWindowsPathInside(installRootResolution.resolvedPath, imageResolution.resolvedPath);
  const entrypointMatchesExpected =
    entrypointAvailable &&
    entrypointResolution.ok &&
    expectedEntrypointResolution.ok &&
    entrypointResolution.resolvedPath === expectedEntrypointResolution.resolvedPath;
  const entrypointInsideInstallRoot =
    entrypointResolution.ok &&
    installRootResolution.ok &&
    isWindowsPathInside(installRootResolution.resolvedPath, entrypointResolution.resolvedPath);
  const normalizedImagePath = normalizeWindowsPathForComparison(imagePath);
  const normalizedExpectedImagePath = normalizeWindowsPathForComparison(expectedBundledNodePath);
  const normalizedEntrypointPath = normalizeWindowsPathForComparison(actualEntrypoint);
  const normalizedExpectedEntrypointPath = normalizeWindowsPathForComparison(expectedEntrypointPath);
  const normalizedInstallRoot = normalizeWindowsPathForComparison(installRoot);
  const failureReasons = [];
  if (!imageAvailable) failureReasons.push("authoritative image path unavailable");
  else if (!imageMatchesExpected) failureReasons.push("Runtime image does not match bundled Node");
  if (!entrypointAvailable) failureReasons.push("Runtime entrypoint unavailable");
  else if (!entrypointMatchesExpected)
    failureReasons.push("Runtime entrypoint does not match installed Runtime");
  const resolutionFailures = [
    ["install root", installRootResolution, true],
    ["authoritative image", imageResolution, imageAvailable],
    ["expected bundled Node", expectedImageResolution, Boolean(String(expectedBundledNodePath ?? "").trim())],
    ["Runtime entrypoint", entrypointResolution, entrypointAvailable],
    ["expected Runtime entrypoint", expectedEntrypointResolution, Boolean(String(expectedEntrypointPath ?? "").trim())]
  ];
  for (const [label, resolution, required] of resolutionFailures) {
    if (required && !resolution.ok)
      failureReasons.push(`${label} filesystem resolution failed (${resolution.errorCode ?? "RESOLVE_FAILED"})`);
  }
  return {
    authoritativeImagePath: imagePath || null,
    executableToken: parsed.executableToken,
    entrypointPath: actualEntrypoint || null,
    expectedBundledNodePath: expectedBundledNodePath || null,
    expectedEntrypointPath: expectedEntrypointPath || null,
    normalizedImagePath: normalizedImagePath || null,
    normalizedExpectedImagePath: normalizedExpectedImagePath || null,
    normalizedEntrypointPath: normalizedEntrypointPath || null,
    normalizedExpectedEntrypointPath: normalizedExpectedEntrypointPath || null,
    normalizedInstallRoot: normalizedInstallRoot || null,
    resolvedImagePath: imageResolution.resolvedPath,
    resolvedExpectedImagePath: expectedImageResolution.resolvedPath,
    resolvedEntrypointPath: entrypointResolution.resolvedPath,
    resolvedExpectedEntrypointPath: expectedEntrypointResolution.resolvedPath,
    resolvedInstallRoot: installRootResolution.resolvedPath,
    filesystemResolution: {
      image: imageResolution,
      expectedImage: expectedImageResolution,
      entrypoint: entrypointResolution,
      expectedEntrypoint: expectedEntrypointResolution,
      installRoot: installRootResolution
    },
    imageMatchesExpected: Boolean(imageMatchesExpected),
    imageInsideInstallRoot: Boolean(imageInsideInstallRoot),
    entrypointMatchesExpected: Boolean(entrypointMatchesExpected),
    entrypointInsideInstallRoot: Boolean(entrypointInsideInstallRoot),
    failureReasons,
    ok:
      Boolean(imageMatchesExpected) &&
      Boolean(imageInsideInstallRoot) &&
      Boolean(entrypointMatchesExpected) &&
      Boolean(entrypointInsideInstallRoot)
  };
}

/**
 * Validate the authoritative Mem0 process image against the installed resource.
 * Command lines are intentionally not part of this identity contract.
 */
export function evaluateMem0Provenance({
  imagePath,
  expectedExecutablePath,
  installRoot,
  resolveExistingPath = resolveExistingWindowsPathForComparison
} = {}) {
  const resolvePath = (value) => {
    try {
      const result = resolveExistingPath(value);
      if (typeof result === "string") {
        const resolvedPath = normalizeWindowsPathForComparison(result);
        return {
          ok: Boolean(resolvedPath),
          rawPath: typeof value === "string" ? stripWindowsDevicePrefix(value) : null,
          lexicalPath: normalizeWindowsPathForComparison(value) || null,
          resolvedPath: resolvedPath || null,
          errorCode: resolvedPath ? null : "INVALID_RESOLVED_PATH"
        };
      }
      if (!result || typeof result !== "object") {
        return {
          ok: false,
          rawPath: typeof value === "string" ? stripWindowsDevicePrefix(value) : null,
          lexicalPath: normalizeWindowsPathForComparison(value) || null,
          resolvedPath: null,
          errorCode: "RESOLVE_FAILED"
        };
      }
      const resolvedPath = normalizeWindowsPathForComparison(result.resolvedPath);
      return {
        ok: result.ok === true && Boolean(resolvedPath),
        rawPath: result.rawPath ?? (typeof value === "string" ? stripWindowsDevicePrefix(value) : null),
        lexicalPath: result.lexicalPath ?? (normalizeWindowsPathForComparison(value) || null),
        resolvedPath: resolvedPath || null,
        errorCode: result.errorCode ?? (result.ok === true ? null : "RESOLVE_FAILED")
      };
    } catch (error) {
      return {
        ok: false,
        rawPath: typeof value === "string" ? stripWindowsDevicePrefix(value) : null,
        lexicalPath: normalizeWindowsPathForComparison(value) || null,
        resolvedPath: null,
        errorCode: String(error?.code ?? "RESOLVE_FAILED").slice(0, 80)
      };
    }
  };

  const imageAvailable = Boolean(String(imagePath ?? "").trim());
  const expectedAvailable = Boolean(String(expectedExecutablePath ?? "").trim());
  const imageResolution = resolvePath(imagePath);
  const expectedResolution = resolvePath(expectedExecutablePath);
  const installRootResolution = resolvePath(installRoot);
  const imageMatchesExpected =
    imageAvailable &&
    expectedAvailable &&
    imageResolution.ok &&
    expectedResolution.ok &&
    imageResolution.resolvedPath === expectedResolution.resolvedPath;
  const imageInsideInstallRoot =
    imageResolution.ok &&
    installRootResolution.ok &&
    isWindowsPathInside(installRootResolution.resolvedPath, imageResolution.resolvedPath);
  const failureReasons = [];
  if (!imageAvailable) failureReasons.push("authoritative Mem0 image path unavailable");
  else if (!imageMatchesExpected) failureReasons.push("Mem0 image does not match installed executable");
  if (!expectedAvailable) failureReasons.push("installed Mem0 executable path unavailable");
  if (!imageInsideInstallRoot) failureReasons.push("Mem0 image is outside the installed resource root");
  const resolutionFailures = [
    ["install root", installRootResolution, true],
    ["authoritative Mem0 image", imageResolution, imageAvailable],
    ["installed Mem0 executable", expectedResolution, expectedAvailable]
  ];
  for (const [label, resolution, required] of resolutionFailures) {
    if (required && !resolution.ok)
      failureReasons.push(`${label} filesystem resolution failed (${resolution.errorCode ?? "RESOLVE_FAILED"})`);
  }
  return {
    rawImagePath: imagePath || null,
    rawExpectedPath: expectedExecutablePath || null,
    authoritativeImagePath: imagePath || null,
    expectedExecutablePath: expectedExecutablePath || null,
    normalizedImagePath: normalizeWindowsPathForComparison(imagePath) || null,
    normalizedExpectedPath: normalizeWindowsPathForComparison(expectedExecutablePath) || null,
    normalizedInstallRoot: normalizeWindowsPathForComparison(installRoot) || null,
    resolvedImagePath: imageResolution.resolvedPath,
    resolvedExpectedPath: expectedResolution.resolvedPath,
    resolvedExpectedImagePath: expectedResolution.resolvedPath,
    resolvedInstallRoot: installRootResolution.resolvedPath,
    filesystemResolution: {
      image: imageResolution,
      expected: expectedResolution,
      installRoot: installRootResolution
    },
    resolverStatus: {
      image: imageResolution.errorCode ?? "ok",
      expected: expectedResolution.errorCode ?? "ok",
      installRoot: installRootResolution.errorCode ?? "ok"
    },
    imageMatchesExpected: Boolean(imageMatchesExpected),
    imageInsideInstallRoot: Boolean(imageInsideInstallRoot),
    failureReasons,
    ok: Boolean(imageMatchesExpected) && Boolean(imageInsideInstallRoot)
  };
}

export function formatMem0ProvenanceDiagnostic({
  stage = "MEM0",
  provenance = {},
  installRoot,
  pid = 0,
  parentPid = 0,
  supervisorPid = 0,
  ownership = "unknown",
  metadataInstanceMatch = false
} = {}) {
  const rawPath = (value) => {
    const text = String(value ?? "").trim();
    return text || "unavailable";
  };
  return [
    `${stage} MEM0 PROVENANCE`,
    `  actual image: ${rawPath(provenance.rawImagePath ?? provenance.authoritativeImagePath)}`,
    `  expected image: ${rawPath(provenance.rawExpectedPath ?? provenance.expectedExecutablePath)}`,
    `  filesystem resolved actual: ${provenanceDiagnosticPath(provenance.resolvedImagePath, provenance.resolvedInstallRoot ?? installRoot)}`,
    `  filesystem resolved expected: ${provenanceDiagnosticPath(provenance.resolvedExpectedPath, provenance.resolvedInstallRoot ?? installRoot)}`,
    `  filesystem resolved install root: ${rawPath(provenance.resolvedInstallRoot)}`,
    `  image resolver: ${provenance.resolverStatus?.image ?? "unknown"}`,
    `  expected resolver: ${provenance.resolverStatus?.expected ?? "unknown"}`,
    `  image match: ${provenance.imageMatchesExpected ? "yes" : "no"}`,
    `  image inside install root: ${provenance.imageInsideInstallRoot ? "yes" : "no"}`,
    `  pid: ${Number(pid) || "unknown"}`,
    `  parent pid: ${Number(parentPid) || "unknown"}`,
    `  child of Supervisor: ${Number(parentPid) > 0 && Number(parentPid) === Number(supervisorPid) ? "yes" : "no"}`,
    `  ownership: ${ownership}`,
    `  metadata instance match: ${metadataInstanceMatch ? "yes" : "no"}`
  ].join("\n");
}

export function formatRuntimeProvenanceDiagnostic({
  stage,
  provenance = {},
  installRoot,
  supervisorPid = 0,
  runtimeParentPid = 0,
  ownership = "unknown",
  metadataPid = 0,
  metadataInstanceMatch = false,
  note = null
} = {}) {
  const rawPath = (value) => {
    const text = String(value ?? "").trim();
    return text || "unavailable";
  };
  const relativePath = (value) => {
    const root = normalizeWindowsPathForComparison(installRoot);
    const candidate = normalizeWindowsPathForComparison(value);
    if (!root || !candidate) return "unavailable";
    if (!isWindowsPathInside(root, candidate)) return "outside-install-root";
    return path.win32.relative(root, candidate) || ".";
  };
  return [
    `${stage ?? "RUNTIME"} RUNTIME PROVENANCE DIAGNOSTIC`,
    `  pid: ${provenance.pid || "unknown"}`,
    `  parentPid: ${runtimeParentPid || "unknown"}`,
    `  processName: ${provenance.processName ?? "unknown"}`,
    `  actualInstallRoot: ${rawPath(installRoot)}`,
    `  actualImagePath: ${rawPath(provenance.authoritativeImagePath)}`,
    `  expectedImagePath: ${rawPath(provenance.expectedBundledNodePath)}`,
    `  authoritativeImagePath: ${provenanceDiagnosticPath(provenance.authoritativeImagePath, installRoot)}`,
    `  expectedBundledNodePath: ${provenanceDiagnosticPath(provenance.expectedBundledNodePath, installRoot)}`,
    `  normalizedImagePath: ${rawPath(provenance.normalizedImagePath)}`,
    `  normalizedExpectedImagePath: ${rawPath(provenance.normalizedExpectedImagePath)}`,
    `  resolvedImagePath: ${provenanceDiagnosticPath(provenance.resolvedImagePath, provenance.resolvedInstallRoot)}`,
    `  resolvedExpectedImagePath: ${provenanceDiagnosticPath(provenance.resolvedExpectedImagePath, provenance.resolvedInstallRoot)}`,
    `  resolvedInstallRoot: ${rawPath(provenance.resolvedInstallRoot)}`,
    `  imageResolver: ${provenance.filesystemResolution?.image?.errorCode ?? "ok"}`,
    `  expectedImageResolver: ${provenance.filesystemResolution?.expectedImage?.errorCode ?? "ok"}`,
    `  relativeImagePath: ${relativePath(provenance.authoritativeImagePath)}`,
    `  imageMatchesExpected: ${provenance.imageMatchesExpected ? "yes" : "no"}`,
    `  imageInsideInstallRoot: ${provenance.imageInsideInstallRoot ? "yes" : "no"}`,
    `  executableToken: ${provenance.executableToken ?? "unavailable"}`,
    `  actualEntrypointPath: ${rawPath(provenance.entrypointPath)}`,
    `  expectedEntrypointPath: ${rawPath(provenance.expectedEntrypointPath)}`,
    `  entrypointPath: ${provenanceDiagnosticPath(provenance.entrypointPath, installRoot)}`,
    `  expectedEntrypointRelativePath: ${provenanceDiagnosticPath(provenance.expectedEntrypointPath, installRoot)}`,
    `  normalizedEntrypointPath: ${rawPath(provenance.normalizedEntrypointPath)}`,
    `  normalizedExpectedEntrypointPath: ${rawPath(provenance.normalizedExpectedEntrypointPath)}`,
    `  resolvedEntrypointPath: ${provenanceDiagnosticPath(provenance.resolvedEntrypointPath, provenance.resolvedInstallRoot)}`,
    `  resolvedExpectedEntrypointPath: ${provenanceDiagnosticPath(provenance.resolvedExpectedEntrypointPath, provenance.resolvedInstallRoot)}`,
    `  entrypointResolver: ${provenance.filesystemResolution?.entrypoint?.errorCode ?? "ok"}`,
    `  expectedEntrypointResolver: ${provenance.filesystemResolution?.expectedEntrypoint?.errorCode ?? "ok"}`,
    `  relativeEntrypointPath: ${relativePath(provenance.entrypointPath)}`,
    `  entrypointMatchesExpected: ${provenance.entrypointMatchesExpected ? "yes" : "no"}`,
    `  entrypointInsideInstallRoot: ${provenance.entrypointInsideInstallRoot ? "yes" : "no"}`,
    `  supervisorPid: ${supervisorPid || "unknown"}`,
    `  runtimeChildOfSupervisor: ${runtimeParentPid > 0 && runtimeParentPid === Number(supervisorPid) ? "yes" : "no"}`,
    `  ownership: ${ownership}`,
    `  metadataPid: ${metadataPid || "unknown"}`,
    `  metadataInstanceMatch: ${metadataInstanceMatch ? "yes" : "no"}`,
    ...(note ? [`  note: ${note}`] : [])
  ].join("\n");
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

export function processBaseline(entries = []) {
  return new Map(entries.map((entry) => [Number(entry.pid), { ...entry }]));
}

function captureProcessBaseline() {
  if (process.platform !== "win32") return processBaseline([]);
  try {
    const output = execFileSync("tasklist.exe", ["/FO", "CSV", "/NH"], {
      encoding: "utf8",
      windowsHide: true
    });
    const result = [];
    for (const line of output.split(/\r?\n/)) {
      const match = line.match(/^\"([^\"]+)\",\"(\d+)\"/);
      if (match && /YUVI Companion|yuvi-desktop-supervisor|yuvi-mem0/i.test(match[1]))
        result.push({ name: match[1], pid: Number(match[2]) });
    }
    return processBaseline(result);
  } catch {
    return processBaseline([]);
  }
}

function assertNoNewNamedProcesses(before) {
  const after = captureProcessBaseline();
  const added = [...after.values()].filter((entry) => !before.has(entry.pid));
  if (added.length)
    fail(
      `named process remained after shutdown: ${added.map((entry) => `${entry.name}:${entry.pid}`).join(", ")}`
    );
  return after;
}

export function assertToolsUnresolvable(
  env,
  { execFile = execFileSync, platform = process.platform } = {}
) {
  if (platform !== "win32") return [];
  const unresolved = [];
  for (const tool of FORBIDDEN_PATH_TOOLS) {
    try {
      execFile("where.exe", [tool], {
        env,
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"]
      });
    } catch {
      unresolved.push(tool);
    }
  }
  const expected = FORBIDDEN_PATH_TOOLS.filter((tool) => unresolved.includes(tool));
  if (expected.length !== FORBIDDEN_PATH_TOOLS.length)
    fail(
      `restricted PATH resolved: ${FORBIDDEN_PATH_TOOLS.filter((tool) => !unresolved.includes(tool)).join(", ")}`
    );
  return unresolved;
}

function locateResourceRoot(installDir) {
  const direct = path.join(installDir, "resources");
  if (fs.existsSync(path.join(direct, "packaging-info.json"))) return direct;
  for (const candidate of listFiles(installDir).filter(
    (file) => path.basename(file) === "packaging-info.json"
  )) {
    const root = path.dirname(candidate);
    if (isWithin(root, installDir) && fs.existsSync(path.join(root, "mem0", MEM0_MANIFEST_NAME)))
      return root;
  }
  fail("installed resource root with packaging-info.json was not found");
}

async function runPackagedSupervisor({
  resource,
  layout,
  timeoutMs,
  listenerAttribution = attributeWindowsListener,
  diagnosticsNow = Date.now
}) {
  const { mem0Port, supervisorPort } = await allocateDistinctPorts();
  const ports = createDiagnosticPortRoles({
    mem0ServicePort: mem0Port,
    supervisorRequestedControlPort: supervisorPort
  });
  const stateRoot = path.join(layout.state, "supervisor");
  const localAppData = layout.localAppData;
  const mem0MetadataPath = path.join(stateRoot, "mem0.pid.json");
  const diagnostics = createOwnershipDiagnostics({
    ports,
    metadataPath: mem0MetadataPath,
    installRoot: layout.install,
    smokeRoot: layout.root,
    attribution: listenerAttribution,
    now: diagnosticsNow
  });
  const requestDiagnostics = createRequestDiagnostics();
  const safeSample = async (...args) => {
    try {
      return await diagnostics.sample(...args);
    } catch {
      return null;
    }
  };
  const safeObserveStatus = async (...args) => {
    try {
      return await diagnostics.observeStatus(...args);
    } catch {
      return null;
    }
  };
  await safeSample("T0-ports-allocated", { pid: 0 });
  const env = sanitizeChildEnv({
    LOCALAPPDATA: localAppData,
    APPDATA: layout.appData,
    USERPROFILE: layout.home,
    HOME: layout.home,
    TEMP: layout.temp,
    TMP: layout.temp,
    YUVI_MEM0_DATA_DIR: path.join(localAppData, "YUVI", "Mem0", "data"),
    YUVI_MEM0_LOG_DIR: path.join(localAppData, "YUVI", "Mem0", "logs"),
    YUVI_AUTOSTART_RUNTIME: "false",
    YUVI_AUTOSTART_MEM0: "true",
    YUVI_AUTOSTART_TTS: "false",
    YUVI_SUPERVISOR_PORT: String(supervisorPort),
    MEMORY_BACKEND: "mem0",
    MEM0_BASE_URL: `http://127.0.0.1:${mem0Port}`,
    PROVIDER_ALLOW_MOCKS: "true",
    YUVI_SUPERVISOR_DIAGNOSTICS: "1"
  });
  console.info(
    `[installer-smoke] port roles: mem0 service=${mem0Port}, supervisor requested control=${supervisorPort}, supervisor public/status=unknown, supervisor control=unknown`
  );
  assertNoSecrets(env, "child env");
  assertToolsUnresolvable(env);
  const supervisorExe = resource.supervisorExe ?? findUniqueSupervisorExecutable(resource.supervisor);
  const supervisorProvenance = resource.supervisorBuildInfo;
  const installedExecutableSha256 = crypto.createHash("sha256").update(fs.readFileSync(supervisorExe)).digest("hex");
  const installedBundlePath = path.join(resource.root, supervisorProvenance.bundleRelativePath);
  const installedBundleSha256 = crypto.createHash("sha256").update(fs.readFileSync(installedBundlePath)).digest("hex");
  const buildInfoRun = await runProcess(
    supervisorExe,
    ["--build-info-json"],
    {
      cwd: layout.emptyCwd,
      env: sanitizeChildEnv({ YUVI_SUPERVISOR_DIAGNOSTICS: "1" }),
      stdio: ["ignore", "pipe", "pipe"]
    },
    Math.min(timeoutMs, 10_000)
  );
  const embeddedBuildInfo = parseEmbeddedSupervisorBuildInfo(
    buildInfoRun.stdout,
    buildInfoRun.stderr,
    buildInfoRun.code
  );
  assertSupervisorProvenance({
    resource,
    provenance: supervisorProvenance,
    embedded: embeddedBuildInfo,
    installedExecutableSha256,
    installedBundleSha256
  });
  console.info(
    `[installer-smoke] SUPERVISOR_PROVENANCE mode=${supervisorProvenance.mode} checkout_sha=${supervisorProvenance.checkoutSha} source_fingerprint=${supervisorProvenance.sourceFingerprint} bundle_sha256=${supervisorProvenance.bundleSha256} bundle_input_sha256=${supervisorProvenance.bundleInputSha256} build_exe_sha256=${supervisorProvenance.executableSha256} staged_exe_sha256=${supervisorProvenance.stagedExecutableSha256} installed_exe_sha256=${installedExecutableSha256} running_executable_path=pending`
  );
  const args = [
    "--mode",
    "packaged",
    "--resource-root",
    resource.root,
    "--state-root",
    stateRoot,
    "--runtime-manifest",
    path.join(resource.runtime, RUNTIME_MANIFEST_NAME),
    "--mem0-manifest",
    path.join(resource.mem0, MEM0_MANIFEST_NAME)
  ];
  assertNoSecrets(args, "Supervisor argv");
  const useExe = true;
  const command = supervisorExe;
  const commandArgs = args;
  await safeSample("T1-supervisor-spawn-before", { pid: 0 });
  const child = spawn(command, commandArgs, {
    cwd: layout.emptyCwd,
    env,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  diagnostics.setSupervisorPid(child.pid);
  await safeSample("T2-supervisor-spawn-returned", { pid: 0 });
  let stdout = "";
  let stderr = "";
  let endpoint = null;
  let ownedMem0Pid = 0;
  let runtimeState = null;
  child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
  child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
  const logExit = () => writeLog(layout.logs, "supervisor.log", `${stdout}\n${stderr}`);
  try {
    endpoint = await waitForSupervisorEndpoint(
      path.join(localAppData, "YUVI", "DesktopSupervisor"),
      stateRoot,
      timeoutMs
    );
    const runningExecutablePath = processExecutablePath(child.pid);
    if (process.platform === "win32" && (!runningExecutablePath || normalized(runningExecutablePath) !== normalized(supervisorExe)))
      fail("running Supervisor ExecutablePath does not match installed packaged exe");
    if (runningExecutablePath) {
      console.info(
        `[installer-smoke] SUPERVISOR_PROVENANCE running_executable_path=${safeDiagnosticPath(runningExecutablePath, layout.install)}`
      );
    }
    const base = String(endpoint.baseUrl);
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) fail("Supervisor endpoint is not loopback");
    const endpointPort = Number(new URL(base).port);
    if (
      typeof endpoint.stateDirectory === "string" &&
      isWithin(endpoint.stateDirectory, stateRoot)
    ) {
      diagnostics.setMetadataPath(path.join(endpoint.stateDirectory, "mem0.pid.json"));
    }
    await safeSample("T3-supervisor-endpoint", {
      endpoint: endpointPort,
      instanceId: endpoint.instanceId,
      supervisorStartedAt: endpoint.startedAt,
      pid: 0
    });
    if (endpointPort === mem0Port)
      fail(`Supervisor control port collides with Mem0 port (${mem0Port})`);
    const health = await requestJson(`${base}/health`, {
      label: "supervisor.health",
      diagnostics: requestDiagnostics
    });
    if (health.status !== 200 || health.value?.ok !== true)
      fail(`Supervisor health failed (${health.status})`);
    await safeSample("T4-before-bootstrap", { endpoint: endpointPort, pid: 0 });
    const bootstrap = await requestJson(`${base}/v1/bootstrap`, {
      method: "POST",
      token: endpoint.controlToken,
      body: null,
      label: "supervisor.bootstrap",
      diagnostics: requestDiagnostics
    });
    if (bootstrap.status < 200 || bootstrap.status >= 300)
      fail(`Supervisor bootstrap failed (${bootstrap.status})`);
    await safeSample("T5-after-bootstrap", { endpoint: endpointPort, pid: 0 });
    let mem0 = null;
    let observedHealthy = false;
    let observedExternal = false;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const status = await requestJson(`${base}/v1/status`, {
        token: endpoint.controlToken,
        label: "supervisor.status",
        diagnostics: requestDiagnostics
      });
      mem0 = status.value?.services?.find((service) => service.id === "mem0") ?? null;
      runtimeState = status.value?.services?.find((service) => service.id === "runtime") ?? null;
      await safeObserveStatus("status-change", mem0);
      if (mem0?.status === "healthy" && !observedHealthy) {
        observedHealthy = true;
        await safeSample("T6-first-mem0-healthy", {
          endpoint: endpointPort,
          ownership: mem0.ownership,
          status: mem0.status,
          pid: Number(mem0.pid) || 0
        });
      }
      if (mem0?.ownership === "external" && !observedExternal) {
        observedExternal = true;
        await safeSample("T7-first-mem0-external", {
          endpoint: endpointPort,
          ownership: mem0.ownership,
          status: mem0.status,
          pid: Number(mem0.pid) || 0
        });
      }
      if (
        mem0?.managed === true &&
        mem0.ownership === "owned" &&
        Number(mem0.pid) > 0 &&
        ["healthy", "degraded", "unhealthy"].includes(mem0.status)
      )
        break;
      await wait(300);
    }
    if (!mem0 || mem0.managed !== true || mem0.ownership !== "owned" || !(mem0.pid > 0)) {
      await safeSample("T8-before-ownership-error", {
        endpoint: endpointPort,
        ownership: mem0?.ownership ?? null,
        status: mem0?.status ?? null,
        pid: Number(mem0?.pid) || 0
      });
      fail("Supervisor did not own a running Mem0");
    }
    const mem0Health = await requestJson(`http://127.0.0.1:${mem0Port}/health`, {
      label: "mem0.health",
      diagnostics: requestDiagnostics
    });
    if (mem0Health.status !== 200 || !mem0Health.value?.ok)
      fail(`Mem0 health failed (${mem0Health.status})`);
    ownedMem0Pid = Number(mem0.pid);
    const mem0Listener = attributeWindowsListener(mem0Port, {
      installRoot: resource.root,
      supervisorPid: child.pid,
      knownManagedPid: ownedMem0Pid
    });
    const mem0Metadata = endpoint.stateDirectory
      ? readOwnershipMetadataDiagnostic(path.join(endpoint.stateDirectory, "mem0.pid.json"), {
          installRoot: resource.root,
          smokeRoot: layout.root
        })
      : readOwnershipMetadataDiagnostic(null);
    const mem0MetadataInstanceMatch = Boolean(
      mem0Metadata.instanceId && endpoint.instanceId && mem0Metadata.instanceId === endpoint.instanceId
    );
    if (!mem0MetadataInstanceMatch || Number(mem0Metadata.pid) !== ownedMem0Pid)
      fail("Mem0 ownership metadata does not match the current instance");
    const mem0ImagePath =
      processExecutablePath(ownedMem0Pid) || mem0Listener.executablePath || "";
    const expectedMem0 = path.join(resource.root, "mem0", MEM0_EXE_NAME);
    const mem0Provenance = evaluateMem0Provenance({
      imagePath: mem0ImagePath,
      expectedExecutablePath: expectedMem0,
      installRoot: resource.root
    });
    console.info(
      formatMem0ProvenanceDiagnostic({
        stage: "DIRECT",
        provenance: mem0Provenance,
        installRoot: resource.root,
        pid: ownedMem0Pid,
        parentPid: mem0Listener.parentProcessId,
        supervisorPid: child.pid,
        ownership: mem0.ownership,
        metadataInstanceMatch: mem0MetadataInstanceMatch
      })
    );
    if (mem0Listener.state === "Listen" &&
      mem0Listener.parentProcessId > 0 &&
      mem0Listener.parentProcessId !== Number(child.pid))
      fail("Mem0 listener is not a child of the current Supervisor");
    if (!mem0Provenance.ok)
      fail(`Mem0 executable provenance failed: ${mem0Provenance.failureReasons.join("; ")}`);
    const commandLine = processCommandLine(mem0.pid);
    if (commandLine) assertNoUnsafeCommandLine(commandLine);
    const dataRoot = path.join(localAppData, "YUVI", "Mem0");
    if (!isWithin(dataRoot, localAppData) || !fs.existsSync(dataRoot))
      fail("isolated Mem0 data path missing");
    if (fs.existsSync(path.join(layout.home, ".mem0"))) fail("Mem0 wrote into HOME");
    const emptyEntries = fs.existsSync(layout.emptyCwd) ? fs.readdirSync(layout.emptyCwd) : [];
    if (emptyEntries.length) fail(`empty cwd was written: ${emptyEntries.join(", ")}`);
    console.info(
      formatRuntimeProvenanceDiagnostic({
        stage: "DIRECT",
        provenance: {
          pid: Number(runtimeState?.pid) || 0,
          processName: null,
          expectedBundledNodePath: path.join(resource.root, "runtime", NODE_EXE_NAME),
          expectedEntrypointPath: path.join(resource.root, "runtime", RUNTIME_ENTRY_NAME)
        },
        installRoot: resource.root,
        supervisorPid: child.pid,
        runtimeParentPid: 0,
        ownership: runtimeState?.ownership ?? "not-started",
        metadataPid: 0,
        metadataInstanceMatch: false,
        note: "Direct precheck sets YUVI_AUTOSTART_RUNTIME=false"
      })
    );
    const shutdown = await requestJson(`${base}/v1/shutdown`, {
      method: "POST",
      token: endpoint.controlToken,
      body: null
    });
    if (shutdown.status < 200 || shutdown.status >= 300)
      fail(`Supervisor shutdown failed (${shutdown.status})`);
    const mem0Pid = ownedMem0Pid;
    await waitForSpecificPidsExit([{ role: "Mem0", pid: mem0Pid }], { timeoutMs });
    try {
      await waitForSpecificPidsExit([{ role: "Supervisor", pid: child.pid }], {
        timeoutMs: Math.min(timeoutMs, 5_000)
      });
    } catch (supervisorExitError) {
      if (pidAlive(child.pid)) {
        try {
          child.kill();
        } catch {
          /* exact spawned child only */
        }
      }
      await waitForSpecificPidsExit([{ role: "Supervisor", pid: child.pid }], {
        timeoutMs: Math.min(timeoutMs, 5_000)
      }).catch(() => {
        throw supervisorExitError;
      });
    }
    logExit();
    console.info(
      `[installer-smoke] diagnostic summary:\n${formatDiagnosticSummary({ diagnostic: diagnostics, installRoot: layout.install })}`
    );
    return {
      endpoint,
      mem0,
      mem0Pid,
      commandLine,
      supervisorPid: child.pid,
      useExe,
      supervisorExecutablePath: runningExecutablePath,
      supervisorProvenance,
      embeddedBuildInfo,
      installedExecutableSha256,
      installedBundleSha256,
      mem0Provenance,
      status: mem0Health.value
    };
  } catch (error) {
    await safeSample("T9-finally-start", {
      endpoint: endpoint?.baseUrl ? Number(new URL(endpoint.baseUrl).port) : null,
      ownership: error?.message?.includes("Supervisor did not own") ? "external" : null,
      status: null,
      pid: 0
    });
    if (endpoint?.baseUrl && endpoint?.controlToken) {
      try {
        await requestJson(`${endpoint.baseUrl}/v1/shutdown`, {
          method: "POST",
          token: endpoint.controlToken,
          body: null,
          label: "supervisor.shutdown",
          diagnostics: requestDiagnostics
        });
      } catch {
        /* best-effort graceful shutdown of this exact smoke instance */
      }
    }
    try {
      child.kill();
    } catch {
      /* exact spawned child only */
    }
    try {
      await waitForSpecificPidsExit(
        [
          { role: "Supervisor", pid: child.pid },
          { role: "Mem0", pid: ownedMem0Pid }
        ],
        { timeoutMs: Math.min(timeoutMs, 5_000) }
      );
    } catch (exitError) {
      error = new Error(
        `${error instanceof Error ? error.message : String(error)}\n${exitError.message}`
      );
    }
    logExit();
    const message = error instanceof Error ? error.message : String(error);
    let diagnosticBlock = "";
    if (message.includes("Supervisor did not own")) {
      try {
        diagnosticBlock = `\n${formatOwnershipDiagnostic({
          diagnostic: diagnostics,
          supervisorExecutable: command,
          installRoot: layout.install
        })}`;
      } catch {
        diagnosticBlock = "\nMEM0 OWNERSHIP DIAGNOSTIC\n  diagnostic query failed";
      }
    }
    const requestDiagnostic = requestDiagnostics.format();
    throw new Error(
      `${message}${diagnosticBlock}${requestDiagnostic ? `\nDIRECT HTTP REQUEST DIAGNOSTIC\n${requestDiagnostic}` : ""}\n${stdout}\n${stderr}`
    );
  }
}

export function buildWmCloseScript(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) fail("WM_CLOSE target PID is invalid");
  return WM_CLOSE_PYTHON_SOURCE;
}

export function buildWmCloseArguments(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) fail("WM_CLOSE target PID is invalid");
  return [
    "-I",
    "-S",
    "-c",
    WM_CLOSE_PYTHON_SOURCE,
    String(numericPid),
    TAURI_MAIN_WINDOW_TITLE
  ];
}

export const TRAY_ICON_WINDOW_CLASS = "tray_icon_app";
export const TRAY_MENU_WINDOW_CLASS = "#32768";
// Notify-icon delivery message used by the pinned tray-icon crate
// (see Cargo.lock; tray-icon 0.24.2 platform_impl/windows defines
// WM_USER_TRAYICON = 6002). The shell reports a right-button release on the
// notify icon through this message, and the tray window opens the live muda
// popup menu in response. This constant is version-pinned, unlike the menu
// allocation order: adding tray items never changes it.
export const TRAY_NOTIFY_MESSAGE_ID = 6002;
export const TRAY_NOTIFY_RBUTTONUP = 0x0205;
// Diagnostic delivery route (DIAG230 Atom A). WM_MN_GETHMENU returned 0 for
// the app's own popup on the windows-2025 hosted runner (run 33946564777 /
// job 101253913752, 4/4 attempts), so the command id cannot be read from the
// live HMENU there. The stimulus therefore delivers the semantic Quit item
// through the exact production user path instead: MSAA locates the unique
// "Quit" item (get_accName) and its on-screen rect (accLocation), then one
// real injected left-click selects it — TrackPopupMenu itself posts
// WM_COMMAND to the tray window and closes the menu, exactly like a real
// user. No numeric id is assumed anywhere.
export const TRAY_QUIT_MENU_TEXT = "Quit";
// Documented muda string id for diagnostics. The clicked item is bound to
// TRAY_QUIT_MENU_TEXT at runtime; this label records which semantic action
// the delivery was resolved for.
export const TRAY_QUIT_SEMANTIC_ID = "tray-quit";

export const TRAY_QUIT_PYTHON_SOURCE = String.raw`
import ctypes
import sys
import time
from ctypes import wintypes

MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
WM_RBUTTONUP = 0x0205
WM_USER_TRAYICON = 6002
VK_ESCAPE = 0x1B
TRAY_ICON_WINDOW_CLASS = "tray_icon_app"
TRAY_MENU_WINDOW_CLASS = "#32768"
TRAY_QUIT_MENU_TEXT = "Quit"
OBJID_CLIENT = 0xFFFFFFFC
VT_I4 = 3
MENU_OPEN_ROUNDS = 3
MENU_OPEN_ROUND_S = 2.0
MENU_POLL_INTERVAL_S = 0.05
MENU_CLOSE_POLL_S = 1.0
started = time.monotonic()
target_pid = int(sys.argv[1])
tray_windows = []
validated_pid = 0
class_exact = 0
identity_valid = 0
tray_hwnd = 0
notify_post = 0
menu_windows = 0
menu_windows_any = 0
menu_hwnd = 0
tray_alive = 0
icon_rect_count = 0
icon_center_x = -1
icon_center_y = -1
cursor_place = 0
send_input = 0
menu_item_count = 0
menu_items = []
quit_matches = 0
quit_child_id = 0
quit_text = ""
quit_rect = None
invoke_hresult = 0
invoke_result = 0
menu_closed = 0

def emit_phase(name):
    print(f"TRAY_QUIT_PHASE={name}", flush=True)

def emit_result(error=None):
    print(f"target_pid={target_pid}", flush=True)
    print(f"tray_windows={len(tray_windows)}", flush=True)
    print(f"tray_hwnd={tray_hwnd}", flush=True)
    print(f"validated_pid={validated_pid}", flush=True)
    print(f"class_exact={class_exact}", flush=True)
    print(f"identity_valid={identity_valid}", flush=True)
    print(f"notify_post={notify_post}", flush=True)
    print(f"menu_windows={menu_windows}", flush=True)
    print(f"menu_windows_any={menu_windows_any}", flush=True)
    print(f"menu_hwnd={menu_hwnd}", flush=True)
    print(f"tray_alive={tray_alive}", flush=True)
    print(f"icon_rect_count={icon_rect_count}", flush=True)
    print(f"icon_center_x={icon_center_x}", flush=True)
    print(f"icon_center_y={icon_center_y}", flush=True)
    print(f"cursor_place={cursor_place}", flush=True)
    print(f"send_input={send_input}", flush=True)
    print(f"menu_item_count={menu_item_count}", flush=True)
    print(f"quit_matches={quit_matches}", flush=True)
    print(f"quit_child_id={quit_child_id}", flush=True)
    print(f"quit_text={quit_text}", flush=True)
    for child_id, text in menu_items:
        print(f"TRAY_QUIT_MENU_ITEM={child_id}:{text}", flush=True)
    if quit_rect is not None:
        left, top, right, bottom = quit_rect
        print(f"TRAY_QUIT_ITEM_RECT={left},{top},{right},{bottom}", flush=True)
    print(f"invoke_hresult={invoke_hresult}", flush=True)
    print(f"invoke_result={invoke_result}", flush=True)
    print(f"menu_closed={menu_closed}", flush=True)
    if error is not None:
        print(f"win32_error={error}", flush=True)
    print(f"elapsed_ms={max(0, int((time.monotonic() - started) * 1000))}", flush=True)

user32 = ctypes.WinDLL("user32", use_last_error=True)
EnumWindowsProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
user32.EnumWindows.argtypes = [EnumWindowsProc, wintypes.LPARAM]
user32.EnumWindows.restype = wintypes.BOOL
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.GetWindowThreadProcessId.restype = wintypes.DWORD
user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetClassNameW.restype = ctypes.c_int
user32.IsWindow.argtypes = [wintypes.HWND]
user32.IsWindow.restype = wintypes.BOOL
user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
user32.PostMessageW.restype = wintypes.BOOL
user32.SetCursorPos.argtypes = [ctypes.c_int, ctypes.c_int]
user32.SetCursorPos.restype = wintypes.BOOL
user32.mouse_event.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID]
user32.mouse_event.restype = None

class Guid(ctypes.Structure):
    _fields_ = [("data1", wintypes.DWORD),
                ("data2", wintypes.WORD),
                ("data3", wintypes.WORD),
                ("data4", wintypes.BYTE * 8)]

class ChildVariant(ctypes.Structure):
    _fields_ = [("vt", wintypes.USHORT),
                ("reserved1", wintypes.USHORT),
                ("reserved2", wintypes.USHORT),
                ("reserved3", wintypes.USHORT),
                ("value", ctypes.c_int64)]

IID_IACCESSIBLE = Guid(0x618736E0, 0x3C3D, 0x11CF,
                       (wintypes.BYTE * 8)(0x81, 0x0C, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71))

ole32 = ctypes.WinDLL("ole32", use_last_error=True)
ole32.CoInitialize.argtypes = [wintypes.LPVOID]
ole32.CoInitialize.restype = ctypes.c_long
ole32.CoUninitialize.argtypes = []
ole32.CoUninitialize.restype = None

oleacc = ctypes.WinDLL("oleacc", use_last_error=True)
oleacc.AccessibleObjectFromWindow.argtypes = [wintypes.HWND, wintypes.DWORD, ctypes.POINTER(Guid), ctypes.POINTER(wintypes.LPVOID)]
oleacc.AccessibleObjectFromWindow.restype = ctypes.c_long

oleaut32 = ctypes.WinDLL("oleaut32", use_last_error=True)
oleaut32.SysFreeString.argtypes = [wintypes.LPVOID]
oleaut32.SysFreeString.restype = None

class NotifyIconId(ctypes.Structure):
    _fields_ = [("size", wintypes.DWORD),
                ("hwnd", wintypes.HWND),
                ("uid", wintypes.UINT),
                ("guid", Guid)]

class IconRect(ctypes.Structure):
    _fields_ = [("left", wintypes.LONG),
                ("top", wintypes.LONG),
                ("right", wintypes.LONG),
                ("bottom", wintypes.LONG)]

shell32 = ctypes.WinDLL("shell32", use_last_error=True)
shell32.Shell_NotifyIconGetRect.argtypes = [ctypes.POINTER(NotifyIconId), ctypes.POINTER(IconRect)]
shell32.Shell_NotifyIconGetRect.restype = ctypes.c_long

ChildCountProto = ctypes.WINFUNCTYPE(ctypes.c_long, wintypes.LPVOID, ctypes.POINTER(ctypes.c_long))
GetNameProto = ctypes.WINFUNCTYPE(ctypes.c_long, wintypes.LPVOID, ChildVariant, ctypes.POINTER(wintypes.LPVOID))
LocationProto = ctypes.WINFUNCTYPE(ctypes.c_long, wintypes.LPVOID, ctypes.POINTER(ctypes.c_long), ctypes.POINTER(ctypes.c_long), ctypes.POINTER(ctypes.c_long), ctypes.POINTER(ctypes.c_long), ChildVariant)
DoDefaultProto = ctypes.WINFUNCTYPE(ctypes.c_long, wintypes.LPVOID, ChildVariant)
ReleaseProto = ctypes.WINFUNCTYPE(wintypes.ULONG, wintypes.LPVOID)

ACC_RELEASE = 2
ACC_CHILDCOUNT = 8
ACC_GETNAME = 10
ACC_LOCATION = 22
ACC_DODEFAULT = 25

def accessible_fn(pointer, index, proto):
    # A COM interface pointer addresses the object; its first field is the
    # vtable address. Dereference once before indexing the method slot.
    vtable = (wintypes.LPVOID).from_address(pointer).value
    if not vtable:
        raise RuntimeError("accessible vtable is null")
    table = (wintypes.LPVOID * 28).from_address(vtable)
    raw = table[index]
    address = raw if isinstance(raw, int) else raw.value
    if not address:
        raise RuntimeError("accessible vtable entry is null")
    return proto(address)

def child_arg(child_id):
    return ChildVariant(VT_I4, 0, 0, 0, child_id)

def release_accessible(pointer):
    try:
        if pointer:
            accessible_fn(pointer, ACC_RELEASE, ReleaseProto)(pointer)
    except Exception:
        pass
    try:
        ole32.CoUninitialize()
    except Exception:
        pass

def read_accessible_name(pointer, child_id):
    name_out = wintypes.LPVOID(0)
    result = int(accessible_fn(pointer, ACC_GETNAME, GetNameProto)(pointer, child_arg(child_id), ctypes.byref(name_out)))
    if result != 0 or not name_out.value:
        return ""
    try:
        return ctypes.wstring_at(name_out.value)
    finally:
        oleaut32.SysFreeString(name_out)

def read_class(hwnd):
    buffer = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, buffer, len(buffer))
    return buffer.value

found_tray = []
found_menu = []
found_menu_any = []

def enum_window(hwnd, _lparam):
    pid_value = wintypes.DWORD(0)
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid_value))
    class_name = read_class(hwnd)
    if class_name == TRAY_MENU_WINDOW_CLASS:
        found_menu_any.append(int(hwnd))
    if int(pid_value.value) != target_pid:
        return True
    if class_name == TRAY_ICON_WINDOW_CLASS:
        found_tray.append(int(hwnd))
    elif class_name == TRAY_MENU_WINDOW_CLASS:
        found_menu.append(int(hwnd))
    return True

def snapshot_menu_windows():
    del found_menu[:]
    del found_menu_any[:]
    user32.EnumWindows(EnumWindowsProc(enum_window), 0)
    return (list(found_menu), len(found_menu_any))

def revalidate_tray():
    pid_value = wintypes.DWORD(0)
    user32.GetWindowThreadProcessId(tray_hwnd, ctypes.byref(pid_value))
    return int(bool(user32.IsWindow(tray_hwnd)) and int(pid_value.value) == target_pid and read_class(tray_hwnd) == TRAY_ICON_WINDOW_CLASS)

emit_phase("start")
emit_phase("before_enum")
if not user32.EnumWindows(EnumWindowsProc(enum_window), 0):
    emit_phase("after_enum")
    tray_windows = list(found_tray)
    emit_result(ctypes.get_last_error())
    raise SystemExit(1)
tray_windows = list(found_tray)
emit_phase("after_enum")
if len(tray_windows) != 1:
    emit_result()
    raise SystemExit(1)
tray_hwnd = tray_windows[0]
emit_phase("before_revalidate")
pid_value = wintypes.DWORD(0)
user32.GetWindowThreadProcessId(tray_hwnd, ctypes.byref(pid_value))
validated_pid = int(pid_value.value)
class_exact = int(read_class(tray_hwnd) == TRAY_ICON_WINDOW_CLASS)
identity_valid = int(bool(user32.IsWindow(tray_hwnd)) and validated_pid == target_pid and class_exact == 1)
emit_phase("after_revalidate")
if identity_valid != 1:
    emit_result()
    raise SystemExit(1)
emit_phase("before_icon_probe")
for probe_uid in range(1, 17):
    identifier = NotifyIconId()
    identifier.size = ctypes.sizeof(NotifyIconId)
    identifier.hwnd = tray_hwnd
    identifier.uid = probe_uid
    rect = IconRect()
    probe_hr = int(shell32.Shell_NotifyIconGetRect(ctypes.byref(identifier), ctypes.byref(rect)))
    if probe_hr == 0:
        icon_rect_count += 1
        if icon_center_x < 0:
            icon_center_x = (int(rect.left) + int(rect.right)) // 2
            icon_center_y = (int(rect.top) + int(rect.bottom)) // 2
        print(f"TRAY_ICON_RECT={probe_uid}:{int(rect.left)},{int(rect.top)},{int(rect.right)},{int(rect.bottom)}", flush=True)
emit_phase("after_icon_probe")
emit_phase("before_menu_open")
# DIAG230 activation hardening: show_tray_menu positions the popup at the
# CURRENT cursor (GetCursorPos inside tray-icon), and the runner cursor is
# wherever the session left it. Place the cursor on the probed icon rect so
# the popup opens at a sane on-screen location, and fall back to a real
# injected right-click (shell → notify icon → tray window) when the posted
# WM_USER_TRAYICON round does not produce a popup.
notify_post = 0
notify_error = None
menu_hits = []
menu_windows_any = 0
emit_phase("before_cursor_place")
if icon_center_x >= 0:
    cursor_place = int(bool(user32.SetCursorPos(icon_center_x, icon_center_y)))
emit_phase("before_send_input")
for _ in range(MENU_OPEN_ROUNDS):
    posted = user32.PostMessageW(tray_hwnd, WM_USER_TRAYICON, 0, WM_RBUTTONUP)
    notify_post = int(bool(posted))
    if notify_post == 0:
        notify_error = ctypes.get_last_error()
        break
    menu_deadline = time.monotonic() + MENU_OPEN_ROUND_S
    while time.monotonic() < menu_deadline:
        menu_hits, menu_windows_any = snapshot_menu_windows()
        if len(menu_hits) >= 1:
            break
        time.sleep(MENU_POLL_INTERVAL_S)
    if len(menu_hits) >= 1:
        break
    if icon_center_x >= 0:
        user32.SetCursorPos(icon_center_x, icon_center_y)
    user32.mouse_event(MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, None)
    user32.mouse_event(MOUSEEVENTF_RIGHTUP, 0, 0, 0, None)
    send_input += 1
    menu_deadline = time.monotonic() + MENU_OPEN_ROUND_S
    while time.monotonic() < menu_deadline:
        menu_hits, menu_windows_any = snapshot_menu_windows()
        if len(menu_hits) >= 1:
            break
        time.sleep(MENU_POLL_INTERVAL_S)
    if len(menu_hits) >= 1:
        break
menu_windows = len(menu_hits)
menu_hwnd = int(menu_hits[0]) if menu_hits else 0
tray_alive = revalidate_tray()
emit_phase("after_menu_open")
if notify_post != 1 or menu_windows != 1:
    emit_result(notify_error)
    raise SystemExit(1)
emit_phase("before_discover")
pointer = 0
reached_invoke = False
try:
    ole32.CoInitialize(None)
    accessible = wintypes.LPVOID(0)
    accessible_hr = int(oleacc.AccessibleObjectFromWindow(menu_hwnd, OBJID_CLIENT, ctypes.byref(IID_IACCESSIBLE), ctypes.byref(accessible)))
    discover_error = None
    pointer = accessible.value
    if accessible_hr != 0 or not pointer:
        discover_error = f"accessible_hresult={accessible_hr & 0xFFFFFFFF}"
    else:
        raw_count = ctypes.c_long(0)
        count_hr = int(accessible_fn(pointer, ACC_CHILDCOUNT, ChildCountProto)(pointer, ctypes.byref(raw_count)))
        if count_hr != 0 or int(raw_count.value) <= 0:
            discover_error = f"child_count_hresult={count_hr & 0xFFFFFFFF}"
        else:
            menu_item_count = int(raw_count.value)
            for child_id in range(1, menu_item_count + 1):
                name = read_accessible_name(pointer, child_id)
                menu_items.append((child_id, name))
                if name == TRAY_QUIT_MENU_TEXT:
                    quit_matches += 1
                    quit_child_id = child_id
                    quit_text = name
    emit_phase("after_discover")
    if quit_matches != 1 or quit_child_id <= 0:
        release_accessible(pointer)
        emit_result(discover_error)
        raise SystemExit(1)
    emit_phase("before_invoke")
    reached_invoke = True
    # DIAG230 Atom A delivery: resolve the Quit item's on-screen rect via
    # MSAA accLocation, then deliver one real injected left-click. The open
    # menu's modal loop handles the click natively, selects the item, closes
    # the popup, and TrackPopupMenu posts the item's runtime WM_COMMAND to
    # the tray window — the exact production routing of a real user click.
    left = ctypes.c_long(0)
    top = ctypes.c_long(0)
    width = ctypes.c_long(0)
    height = ctypes.c_long(0)
    location_hr = int(accessible_fn(pointer, ACC_LOCATION, LocationProto)(pointer, ctypes.byref(left), ctypes.byref(top), ctypes.byref(width), ctypes.byref(height), child_arg(quit_child_id)))
    if location_hr != 0 or int(width.value) <= 0 or int(height.value) <= 0:
        invoke_hresult = location_hr & 0xFFFFFFFF
        release_accessible(pointer)
        emit_phase("after_invoke")
        emit_result(f"location_hresult={invoke_hresult}")
        raise SystemExit(1)
    quit_rect = (int(left.value), int(top.value), int(left.value) + int(width.value), int(top.value) + int(height.value))
    center_x = int(left.value) + int(width.value) // 2
    center_y = int(top.value) + int(height.value) // 2
    user32.SetCursorPos(center_x, center_y)
    user32.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, None)
    user32.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, None)
    invoke_result = 1
    close_deadline = time.monotonic() + MENU_CLOSE_POLL_S
    while time.monotonic() < close_deadline:
        closed_hits, _closed_any = snapshot_menu_windows()
        if len(closed_hits) == 0:
            menu_closed = 1
            break
        time.sleep(MENU_POLL_INTERVAL_S)
    release_accessible(pointer)
    emit_phase("after_invoke")
    emit_result(None)
    raise SystemExit(0)
except SystemExit:
    raise
except Exception as exc:
    release_accessible(pointer)
    emit_phase("after_invoke" if reached_invoke else "after_discover")
    emit_result(f"helper_error={type(exc).__name__}")
    raise SystemExit(1)
`;

export function buildTrayQuitScript(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) fail("tray Quit target PID is invalid");
  return TRAY_QUIT_PYTHON_SOURCE;
}

export function buildTrayQuitArguments(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) fail("tray Quit target PID is invalid");
  return ["-I", "-S", "-c", TRAY_QUIT_PYTHON_SOURCE, String(numericPid)];
}

// Opening the live tray popup is the environmentally flaky stage: the
// notify post is accepted but the popup sometimes never appears within one
// helper run while the app stays alive. Every attempt below drives the same
// real product path (open the genuine menu, resolve Quit semantically from
// the live HMENU, deliver its runtime command id through WM_COMMAND);
// attempts only repeat that path, never bypass it.
export const TRAY_QUIT_MAX_ATTEMPTS = 4;
export const TRAY_QUIT_ATTEMPT_BUDGET_MS = 70_000;

export function shouldRetryTrayQuit({ attempt, elapsedMs, timeoutMs } = {}) {
  if (!Number.isInteger(attempt) || attempt < 1) fail("tray Quit attempt is invalid");
  if (!Number.isFinite(Number(elapsedMs)) || Number(elapsedMs) < 0)
    fail("tray Quit elapsed time is invalid");
  if (attempt >= TRAY_QUIT_MAX_ATTEMPTS) return false;
  return Number(elapsedMs) <= Math.min(Number(timeoutMs) || 0, TRAY_QUIT_ATTEMPT_BUDGET_MS);
}

function trayQuitExcerpt(stdout) {
  const excerpt = String(stdout ?? "")
    .split(/\r?\n/)
    .filter((line) =>
      /^(?:TRAY_QUIT_PHASE|notify_post|menu_windows|menu_windows_any|menu_hwnd|tray_alive|icon_rect_count|icon_center_x|icon_center_y|cursor_place|send_input|TRAY_ICON_RECT|menu_item_count|quit_matches|quit_child_id|quit_text|TRAY_QUIT_MENU_ITEM|TRAY_QUIT_ITEM_RECT|invoke_hresult|invoke_result|menu_closed|win32_error)=/.test(
        line
      )
    )
    .join(" ");
  assertNoSecrets(excerpt, "tray Quit excerpt");
  return excerpt;
}

export function parseTrayQuitOutput(stdout, expectedPid = null) {
  const text = String(stdout ?? "");
  assertNoSecrets(text, "tray Quit stdout");
  const phases = [...text.matchAll(/(?:^|\r?\n)TRAY_QUIT_PHASE=([a-z_]+)(?=\r?$)/gm)].map(
    (match) => match[1]
  );
  const requiredPhases = [
    "start",
    "before_enum",
    "after_enum",
    "before_revalidate",
    "after_revalidate",
    "before_icon_probe",
    "after_icon_probe",
    "before_menu_open",
    "before_cursor_place",
    "before_send_input",
    "after_menu_open",
    "before_discover",
    "after_discover",
    "before_invoke",
    "after_invoke"
  ];
  if (phases.length !== requiredPhases.length || phases.some((phase, index) => phase !== requiredPhases[index]))
    fail("tray Quit output has invalid phase sequence");
  const readInteger = (name) => {
    const matches = [...text.matchAll(new RegExp(`(?:^|\\r?\\n)${name}=(-?\\d+)(?=\\r?$)`, "gm"))];
    if (matches.length !== 1) fail(`tray Quit output is missing or malformed ${name}`);
    const value = Number(matches[0][1]);
    if (!Number.isSafeInteger(value) || value < 0) fail(`tray Quit output has invalid ${name}`);
    return value;
  };
  const readSingleLine = (name) => {
    const matches = [...text.matchAll(new RegExp(`(?:^|\\r?\\n)${name}=(.*)(?=\\r?$)`, "gm"))];
    if (matches.length !== 1) fail(`tray Quit output is missing or malformed ${name}`);
    return matches[0][1];
  };
  const targetPid = readInteger("target_pid");
  const trayWindows = readInteger("tray_windows");
  const trayHwnd = readInteger("tray_hwnd");
  const validatedPid = readInteger("validated_pid");
  const classExact = readInteger("class_exact");
  const identityValid = readInteger("identity_valid");
  const notifyPost = readInteger("notify_post");
  const menuWindows = readInteger("menu_windows");
  const menuWindowsAny = readInteger("menu_windows_any");
  const menuHwnd = readInteger("menu_hwnd");
  const trayAlive = readInteger("tray_alive");
  const iconRectCount = readInteger("icon_rect_count");
  const iconCenterX = readInteger("icon_center_x");
  const iconCenterY = readInteger("icon_center_y");
  const cursorPlace = readInteger("cursor_place");
  const sendInput = readInteger("send_input");
  const iconRects = [...text.matchAll(/(?:^|\r?\n)TRAY_ICON_RECT=(\d+):(-?\d+),(-?\d+),(-?\d+),(-?\d+)(?=\r?$)/gm)].map(
    (match) => ({
      uid: Number(match[1]),
      left: Number(match[2]),
      top: Number(match[3]),
      right: Number(match[4]),
      bottom: Number(match[5])
    })
  );
  const menuItemCount = readInteger("menu_item_count");
  const quitMatches = readInteger("quit_matches");
  const quitChildId = readInteger("quit_child_id");
  const quitText = readSingleLine("quit_text");
  const menuClosed = readInteger("menu_closed");
  const itemRects = [...text.matchAll(/(?:^|\r?\n)TRAY_QUIT_ITEM_RECT=(-?\d+),(-?\d+),(-?\d+),(-?\d+)(?=\r?$)/gm)].map(
    (match) => ({
      left: Number(match[1]),
      top: Number(match[2]),
      right: Number(match[3]),
      bottom: Number(match[4])
    })
  );
  const menuItems = [...text.matchAll(/(?:^|\r?\n)TRAY_QUIT_MENU_ITEM=(\d+):(.*)(?=\r?$)/gm)].map(
    (match) => ({ childId: Number(match[1]), text: match[2] })
  );
  const invokeHresult = readInteger("invoke_hresult");
  const invokeResult = readInteger("invoke_result");
  const elapsedMs = readInteger("elapsed_ms");
  const menuMap = menuItems.length
    ? menuItems.map((item) => `${item.childId}:${item.text}`).join(" | ")
    : "<no menu items reported>";
  if (expectedPid !== null && targetPid !== Number(expectedPid))
    fail(`tray Quit output target PID mismatch (${targetPid})`);
  if (trayWindows !== 1) fail("tray Quit requires exactly one tray icon window");
  if (trayHwnd <= 0) fail("tray Quit output has invalid tray_hwnd");
  if (expectedPid !== null && validatedPid !== Number(expectedPid))
    fail(`tray Quit validated PID mismatch (${validatedPid})`);
  if (classExact !== 1) fail("tray Quit tray icon class was not exact");
  if (identityValid !== 1) fail("tray Quit target identity was not validated");
  if (notifyPost !== 1)
    fail("tray Quit context menu open was not accepted (WM_USER_TRAYICON/RBUTTONUP rejected)");
  if (menuWindows !== 1)
    fail(`tray Quit requires exactly one live context menu for the target PID (found ${menuWindows}, system-wide ${menuWindowsAny})`);
  if (menuHwnd <= 0) fail("tray Quit output has invalid menu_hwnd");
  if (trayAlive !== 1) fail("tray Quit tray window died while opening the context menu");
  if (iconRects.length !== iconRectCount)
    fail(`tray Quit icon rect map is truncated (rects=${iconRects.length}, count=${iconRectCount})`);
  if (menuItems.length !== menuItemCount)
    fail(`tray Quit menu map is truncated (items=${menuItems.length}, count=${menuItemCount}): ${menuMap}`);
  if (quitMatches !== 1)
    fail(
      `tray Quit semantic discovery failed: expected exactly one ${JSON.stringify(TRAY_QUIT_MENU_TEXT)} item, found ${quitMatches} of ${menuItemCount}: ${menuMap}`
    );
  if (quitText !== TRAY_QUIT_MENU_TEXT)
    fail(`tray Quit discovered text is not the semantic Quit item (${JSON.stringify(quitText)}): ${menuMap}`);
  if (!(quitChildId >= 1 && quitChildId <= menuItemCount))
    fail(`tray Quit accessible child id is out of range (${quitChildId} of ${menuItemCount}): ${menuMap}`);
  if (!menuItems.some((item) => item.childId === quitChildId && item.text === TRAY_QUIT_MENU_TEXT))
    fail(`tray Quit delivered child is not bound to the reported menu map (${quitChildId}): ${menuMap}`);
  if (itemRects.length !== 1)
    fail(`tray Quit item rect is missing or duplicated (rects=${itemRects.length}): ${menuMap}`);
  if (!(itemRects[0].right > itemRects[0].left && itemRects[0].bottom > itemRects[0].top))
    fail(`tray Quit item rect is empty (${JSON.stringify(itemRects[0])}): ${menuMap}`);
  if (invokeResult !== 1)
    fail(
      `tray Quit MSAA location of ${TRAY_QUIT_SEMANTIC_ID}/${JSON.stringify(quitText)} child ${quitChildId} failed (hresult=${invokeHresult}): ${menuMap}`
    );
  if (menuClosed !== 1)
    fail(
      `tray Quit popup did not close after the delivered click (delivery rejected?): ${menuMap}`
    );
  return {
    targetPid,
    trayWindows,
    trayHwnd,
    validatedPid,
    classExact: classExact === 1,
    identityValid: identityValid === 1,
    notifyPost: notifyPost === 1,
    menuWindows,
    menuWindowsAny,
    menuHwnd,
    trayAlive: trayAlive === 1,
    iconRectCount,
    iconCenterX,
    iconCenterY,
    cursorPlace: cursorPlace === 1,
    sendInput,
    iconRects,
    menuItemCount,
    quitMatches,
    quitChildId,
    quitText,
    itemRect: itemRects[0],
    menuItems,
    menuMap,
    invokeHresult,
    invokeResult: invokeResult === 1,
    menuClosed: menuClosed === 1,
    elapsedMs,
    phases,
    lastPhase: phases.at(-1) ?? "unknown"
  };
}

async function waitForProcessExit(pid, timeoutMs) {
  const started = Date.now();
  while (pidAlive(pid) && Date.now() - started < timeoutMs) await wait(250);
  return !pidAlive(pid);
}

async function sendWmClose(pid, layout, timeoutMs) {
  const script = buildWmCloseScript(pid);
  assertNoSecrets(script, "WM_CLOSE helper source");
  const executable = resolveWmClosePythonExecutable();
  const args = buildWmCloseArguments(pid);
  assertNoSecrets(args, "WM_CLOSE helper argv");
  const options = {
    cwd: layout.emptyCwd,
    env: sanitizeChildEnv(),
    stdio: ["ignore", "pipe", "pipe"]
  };
  let result;
  try {
    result = await runWmCloseHelper({
      executable,
      args,
      options,
      timeoutMs: Math.min(timeoutMs, 10_000),
      expectedPid: pid
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeLog(layout.logs, "wm-close.log", message);
    throw error;
  }
  const timing = result.phaseTimings;
  const phaseDelta = (before, after) =>
    timing[before] !== undefined && timing[after] !== undefined
      ? Math.max(0, timing[after] - timing[before])
      : "unknown";
  const diagnostic = [
    `WM_CLOSE_HELPER executable_category=${result.executable.category} executable_path=${result.executable.path} helper_pid=${result.helperPid} exit_code=${result.code}`,
    `WM_CLOSE_PHASE_TIMING spawn_to_before_enum_ms=${timing.before_enum ?? "unknown"} enum_ms=${phaseDelta("before_enum", "after_enum")} revalidate_ms=${phaseDelta("before_revalidate", "after_revalidate")} post_ms=${phaseDelta("before_post", "after_post")} total_ms=${result.totalElapsedMs}`,
    `WM_CLOSE_RESULT target_pid=${result.targetPid} pid_top_level_windows=${result.pidTopLevelWindows} exact_title_matches=${result.exactTitleMatches} target_hwnd=${result.targetHwnd} validated_pid=${result.validatedPid} title_exact=${result.titleExact ? 1 : 0} identity_valid=${result.identityValid ? 1 : 0} post_result=${result.postResult ? 1 : 0} visible_after_close=${result.visibleAfterClose === null ? "unknown" : result.visibleAfterClose ? 1 : 0} elapsed_ms=${result.elapsedMs}`
  ].join("\n");
  writeLog(layout.logs, "wm-close.log", `${result.stdout}\n${result.stderr}\n${diagnostic}`);
  console.info(`[installer-smoke] ${diagnostic.replaceAll("\n", " ")}`);
  return result;
}

async function sendTrayQuit(pid, layout, timeoutMs) {
  const script = buildTrayQuitScript(pid);
  assertNoSecrets(script, "tray Quit helper source");
  const executable = resolveWmClosePythonExecutable();
  const args = buildTrayQuitArguments(pid);
  assertNoSecrets(args, "tray Quit helper argv");
  const options = {
    cwd: layout.emptyCwd,
    env: sanitizeChildEnv(),
    stdio: ["ignore", "pipe", "pipe"]
  };
  const started = Date.now();
  const failures = [];
  for (let attempt = 1; ; attempt += 1) {
    if (attempt > 1 && !pidAlive(pid))
      fail(
        `Tauri application exited without a confirmed tray Quit invoke (after ${attempt - 1} attempts: ${failures.join(" ;; ") || "none"})`
      );
    let result;
    try {
      // 20s per attempt: the hardened open loop (posted round + real-input
      // fallback round, 2s poll each x 3) plus MSAA discovery needs headroom
      // when the popup only opens in a later round; the previous caps (10s,
      // then 15s) truncated late-opening attempts mid-discovery.
      result = await runProcess(executable, args, options, Math.min(timeoutMs, 20_000));
      assertNoSecrets(result.stderr, "tray Quit stderr");
      if (result.code !== 0) {
        let parseError = null;
        try {
          parseTrayQuitOutput(result.stdout, pid);
        } catch (error) {
          parseError = error instanceof Error ? error.message : String(error);
        }
        // Best-effort mapping excerpt so an early helper exit still reports
        // the semantic discovery state in the failure message itself.
        const excerpt = trayQuitExcerpt(result.stdout);
        fail(
          `tray Quit helper exited with code ${result.code}${parseError ? `: ${parseError}` : ""}${excerpt ? ` [${excerpt}]` : ""}`
        );
      }
      const parsed = parseTrayQuitOutput(result.stdout, pid);
      const diagnostic = [
        `TRAY_QUIT_HELPER executable_category=python-harness executable_path=${path.basename(executable)} exit_code=${result.code}`,
        `TRAY_QUIT_RESULT attempt=${attempt} target_pid=${parsed.targetPid} tray_windows=${parsed.trayWindows} tray_hwnd=${parsed.trayHwnd} validated_pid=${parsed.validatedPid} class_exact=${parsed.classExact ? 1 : 0} identity_valid=${parsed.identityValid ? 1 : 0} notify_post=${parsed.notifyPost ? 1 : 0} menu_windows=${parsed.menuWindows} menu_windows_any=${parsed.menuWindowsAny} menu_hwnd=${parsed.menuHwnd} tray_alive=${parsed.trayAlive ? 1 : 0} icon_rects=${parsed.iconRects.map((rect) => `${rect.uid}:${rect.left},${rect.top},${rect.right},${rect.bottom}`).join("|") || "none"} cursor_place=${parsed.cursorPlace ? 1 : 0} send_input=${parsed.sendInput} menu_items=${parsed.menuItemCount} quit_matches=${parsed.quitMatches} quit_semantic=${TRAY_QUIT_SEMANTIC_ID} quit_text=${parsed.quitText} quit_child_id=${parsed.quitChildId} quit_rect=${parsed.itemRect ? `${parsed.itemRect.left},${parsed.itemRect.top},${parsed.itemRect.right},${parsed.itemRect.bottom}` : "none"} invoke_hresult=${parsed.invokeHresult} invoke_result=${parsed.invokeResult ? 1 : 0} menu_closed=${parsed.menuClosed ? 1 : 0} elapsed_ms=${parsed.elapsedMs}`,
        `TRAY_QUIT_MENU_MAP ${parsed.menuMap}`
      ].join("\n");
      writeLog(layout.logs, "tray-quit.log", `${result.stdout}\n${result.stderr}\n${diagnostic}`);
      console.info(`[installer-smoke] ${diagnostic.replaceAll("\n", " ")}`);
      return parsed;
    } catch (error) {
      // On a helper timeout runProcess rejects without a result; the partial
      // helper output attached to the timeout error is still worth persisting
      // so the last-known discovery progress survives for triage.
      const partialStdout = result ? result.stdout : (error?.stdout ?? "");
      const partialStderr = result ? result.stderr : (error?.stderr ?? "");
      const attemptLog = `${partialStdout}\n${partialStderr}`;
      writeLog(layout.logs, `tray-quit-attempt-${attempt}.log`, attemptLog);
      let message = error instanceof Error ? error.message : String(error);
      if (!result && error instanceof Error && /timed out/.test(error.message)) {
        const excerpt = trayQuitExcerpt(partialStdout);
        message = `${error.message}${excerpt ? ` [${excerpt}]` : ""}`;
      }
      assertNoSecrets(message, "tray Quit attempt failure");
      failures.push(`attempt ${attempt}: ${message}`);
      console.info(`[installer-smoke] TRAY_QUIT_ATTEMPT n=${attempt} failed: ${message}`);
      if (!shouldRetryTrayQuit({ attempt, elapsedMs: Date.now() - started, timeoutMs }))
        fail(`tray Quit failed after ${attempt} attempt(s): ${failures.join(" ;; ")}`);
    }
  }
}

async function runTauriAppSmoke({ installDir, resource, layout, timeoutMs }) {
  const appExecutable = findInstalledApplicationExecutable(installDir);
  const tauriLocalAppData = path.join(layout.root, "tauri-local-app-data");
  const tauriAppData = path.join(layout.root, "tauri-app-data");
  const tauriHome = path.join(layout.root, "tauri-home");
  const tauriTemp = path.join(layout.root, "tauri-temp");
  for (const dir of [tauriLocalAppData, tauriAppData, tauriHome, tauriTemp])
    fs.mkdirSync(dir, { recursive: true });
  const env = createTauriAppEnv({
    localAppData: tauriLocalAppData,
    appData: tauriAppData,
    home: tauriHome,
    temp: tauriTemp
  });
  assertNoSecrets(env, "Tauri app env");
  const appArgs = [];
  assertNoSecrets(appArgs, "Tauri app argv");
  const timeline = createTauriTimeline();
  const requestDiagnostics = createRequestDiagnostics({ timeline });
  timeline.mark("T0-tauri-executable-spawn");
  const child = spawn(appExecutable, appArgs, {
    cwd: layout.emptyCwd,
    env,
    shell: false,
    windowsHide: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  timeline.mark("T1-tauri-spawn-returned", { appPid: child.pid });
  timeline.mark("E0-tauri-process-launched", { appPid: child.pid });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
  child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
  const logExit = () => writeLog(layout.logs, "tauri-app.log", `${stdout}\n${stderr}`);
  const outputTail = (value) => {
    const text = String(value ?? "").trim();
    return text.length > 4_000 ? text.slice(-4_000) : text;
  };
  const checkExit = () => {
    if (child.exitCode === null && child.signalCode === null) return null;
    const code = child.exitCode === null ? "none" : child.exitCode;
    const signal = child.signalCode ?? "none";
    return [
      `Tauri application exited before bootstrap (code=${code}, signal=${signal})`,
      `stdout tail:\n${outputTail(stdout) || "<empty>"}`,
      `stderr tail:\n${outputTail(stderr) || "<empty>"}`
    ].join("\n");
  };
  let endpoint = null;
  let pointer = null;
  let runtime = null;
  let runtimeDiagnosticText = "";
  let runtimePid = 0;
  let mem0Pid = 0;
  const processQueries = [];
  try {
    endpoint = await waitForSupervisorEndpoint(
      path.join(tauriLocalAppData, "YUVI", "DesktopSupervisor"),
      path.join(tauriLocalAppData, "YUVI", "DesktopSupervisor"),
      timeoutMs,
      { checkExit }
    );
    if (!pidAlive(child.pid)) fail("Tauri application exited before bootstrap");
    pointer = readJson(
      path.join(tauriLocalAppData, "YUVI", "DesktopSupervisor", "active-instance.json")
    );
    timeline.mark("T2-active-instance-available", {
      supervisorPid: Number(pointer.pid) || 0,
      endpoint: endpoint.baseUrl
    });
    timeline.mark("E1-supervisor-endpoint-discovered", {
      supervisorPid: Number(pointer.pid) || 0,
      endpointPort: safePortFromUrl(endpoint.baseUrl)
    });
    if (pointer.mode !== "packaged") fail("Tauri bootstrap did not use packaged mode");
    if (!pidAlive(Number(pointer.pid))) fail("packaged Supervisor endpoint PID is not alive");
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(String(endpoint.baseUrl)))
      fail("Tauri Supervisor endpoint is not loopback");
    const readinessMarker = await waitForTauriBootstrapReady(
      path.join(tauriLocalAppData, "YUVI", "DesktopSupervisor", "tauri-bootstrap-ready.json"),
      {
        timeoutMs,
        appPid: child.pid,
        supervisorPid: pointer.pid,
        instanceId: endpoint.instanceId
      }
    );
    timeline.mark("T3-bootstrap-ready-barrier", {
      readyAtMs: Number(readinessMarker.readyAtMs)
    });
    const health = await requestJson(`${endpoint.baseUrl}/health`, {
      label: "supervisor.health",
      diagnostics: requestDiagnostics
    });
    if (health.status !== 200 || health.value?.ok !== true) fail("Tauri Supervisor health failed");
    timeline.mark("T4-supervisor-health-first", { supervisorHealth: "healthy" });
    timeline.mark("E2-supervisor-health-ready", { supervisorHealth: "healthy" });
    const status = await requestJson(`${endpoint.baseUrl}/v1/status`, {
      token: endpoint.controlToken,
      label: "supervisor.status",
      diagnostics: requestDiagnostics
    });
    if (status.status !== 200) fail("Tauri Supervisor status failed");
    const services = status.value?.services ?? [];
    runtime = services.find((service) => service.id === "runtime");
    const mem0 = services.find((service) => service.id === "mem0");
    const tts = services.find((service) => service.id === "tts_wrapper");
    const mem0MetadataPath = endpoint.stateDirectory
      ? path.join(endpoint.stateDirectory, "mem0.pid.json")
      : null;
    const mem0Metadata = readOwnershipMetadataDiagnostic(mem0MetadataPath, {
      installRoot: resource.root,
      smokeRoot: layout.root
    });
    if (mem0Metadata.exists) {
      timeline.mark("E3-mem0-metadata-first-observed", {
        pid: mem0Metadata.pid || 0
      });
    }
    if (mem0?.ownership === "owned") {
      timeline.mark("E4-mem0-owned-first-observed", {
        pid: Number(mem0.pid) || 0,
        metadataExists: mem0Metadata.exists
      });
    }
    timeline.mark("T5-status-first-observed", {
      runtimeStatus: runtime?.status ?? null,
      runtimeOwnership: runtime?.ownership ?? null,
      runtimePid: Number(runtime?.pid) || 0,
      runtimeManaged: runtime?.managed === true
    });
    const runtimePort = tauriRuntimePort(runtime);
    const runtimeListener = runtimePort
      ? attributeWindowsListener(runtimePort, {
          installRoot: resource.root,
          supervisorPid: Number(pointer.pid) || 0,
          knownManagedPid: Number(runtime?.pid) || 0
        })
      : listenerResult(null, { queryErrorCode: "runtime-url-unavailable" });
    timeline.mark("T6-runtime-listener-first", {
      runtimeListening: runtimeListener.state === "Listen",
      runtimePid: runtimeListener.owningPid || Number(runtime?.pid) || 0,
      runtimeParentPid: runtimeListener.parentProcessId || 0
    });
    timeline.mark("T7-runtime-health-first", {
      runtimeHealth: runtime?.status === "healthy" ? "healthy" : runtime?.status ?? "unknown"
    });
    timeline.mark("T8-runtime-ownership-first", {
      runtimeOwnership: runtime?.ownership ?? "unknown"
    });
    timeline.mark("T9-bootstrap-readiness-assertion", {
      runtimeStatus: runtime?.status ?? null,
      runtimeOwnership: runtime?.ownership ?? null
    });
    const expectedRuntime = path.join(resource.root, "runtime", NODE_EXE_NAME);
    const expectedEntrypoint = path.join(resource.root, "runtime", RUNTIME_ENTRY_NAME);
    runtimeDiagnosticText = formatTauriRuntimeOwnershipDiagnostic({
      appPid: child.pid,
      appExecutable,
      pointer,
      endpoint,
      runtime,
      installRoot: resource.root,
      smokeRoot: layout.root,
      localAppData: tauriLocalAppData,
      timeline: timeline.snapshot(),
      expectedBundledNodePath: expectedRuntime,
      expectedEntrypointPath: expectedEntrypoint
    });
    console.info(runtimeDiagnosticText);
    if (!runtime || runtime.managed !== true || runtime.ownership !== "owned" || !(runtime.pid > 0)) {
      fail("Tauri bootstrap did not own Runtime");
    }
    if (!mem0 || mem0.managed !== true || mem0.ownership !== "owned" || !(mem0.pid > 0))
      fail("Tauri bootstrap did not own Mem0");
    if (tts?.ownership === "owned" || tts?.pid) fail("Tauri smoke unexpectedly started TTS");
    runtimePid = Number(runtime.pid);
    mem0Pid = Number(mem0.pid);
    const runProcessQuery = (role, pid, query) => {
      const startedAtMs = Date.now();
      let errorCode = null;
      let value = "";
      try {
        value = query((error) => {
          errorCode = diagnosticErrorField(error, "code") ?? "query-failed";
        });
      } catch (error) {
        errorCode = diagnosticErrorField(error, "code") ?? "query-failed";
      }
      const endedAtMs = Date.now();
      processQueries.push({
        role,
        pid: Number(pid) || 0,
        startedAt: new Date(startedAtMs).toISOString(),
        endedAt: new Date(endedAtMs).toISOString(),
        elapsedMs: Math.max(0, endedAtMs - startedAtMs),
        outcome: errorCode ? "query-timeout" : value ? "resolved" : "unavailable",
        errorCode
      });
      return value;
    };
    timeline.mark("E5-before-process-provenance-query", {
      runtimePid,
      mem0Pid
    });
    const runtimeCommandLine = runProcessQuery(
      "runtime.command-line",
      runtimePid,
      (onError) => processCommandLine(runtimePid, { onError })
    );
    const queriedRuntimeImagePath = runProcessQuery(
      "runtime.executable-path",
      runtimePid,
      (onError) => processExecutablePath(runtimePid, { onError })
    );
    const runtimeImagePath = queriedRuntimeImagePath || runtimeListener.executablePath || "";
    timeline.mark("E6-process-query-completed", {
      runtimeCommandLine: runtimeCommandLine ? "resolved" : "unavailable",
      runtimeImagePath: runtimeImagePath ? "resolved" : "unavailable",
      queryErrors: processQueries.filter((entry) => entry.errorCode).map((entry) => entry.errorCode)
    });
    const runtimeProvenance = evaluateRuntimeProvenance({
      imagePath: runtimeImagePath,
      commandLine: runtimeCommandLine,
      expectedBundledNodePath: expectedRuntime,
      expectedEntrypointPath: expectedEntrypoint,
      installRoot: resource.root
    });
    runtimeProvenance.pid = runtimePid;
    runtimeProvenance.processName = runtimeListener.processName;
    const mem0Port = safePortFromUrl(mem0?.url);
    const mem0Listener = mem0Port
      ? attributeWindowsListener(mem0Port, {
          installRoot: resource.root,
          supervisorPid: Number(pointer.pid) || 0,
          knownManagedPid: mem0Pid
        })
      : listenerResult(null, { queryErrorCode: "mem0-url-unavailable" });
    const mem0ImagePath = runProcessQuery(
      "mem0.executable-path",
      mem0Pid,
      (onError) => processExecutablePath(mem0Pid, { onError })
    );
    const expectedMem0 = path.join(resource.root, "mem0", MEM0_EXE_NAME);
    const mem0Provenance = evaluateMem0Provenance({
      imagePath: mem0ImagePath || mem0Listener.executablePath || "",
      expectedExecutablePath: expectedMem0,
      installRoot: resource.root
    });
    const mem0MetadataInstanceMatch = Boolean(
      mem0Metadata.instanceId && endpoint.instanceId && mem0Metadata.instanceId === endpoint.instanceId
    );
    console.info(
      formatMem0ProvenanceDiagnostic({
        stage: "TAURI",
        provenance: mem0Provenance,
        installRoot: resource.root,
        pid: mem0Pid,
        parentPid: mem0Listener.parentProcessId,
        supervisorPid: Number(pointer.pid) || 0,
        ownership: mem0.ownership,
        metadataInstanceMatch: mem0MetadataInstanceMatch
      })
    );
    const mem0CommandLine = runProcessQuery(
      "mem0.command-line",
      mem0Pid,
      (onError) => processCommandLine(mem0Pid, { onError })
    );
    if (!runtimeProvenance.ok)
      fail(`Tauri Runtime bundled-Node provenance failed: ${runtimeProvenance.failureReasons.join("; ")}`);
    if (!mem0Provenance.ok)
      fail(`Tauri Mem0 executable provenance failed: ${mem0Provenance.failureReasons.join("; ")}`);
    if (mem0Listener.state === "Listen" &&
      mem0Listener.parentProcessId > 0 &&
      mem0Listener.parentProcessId !== Number(pointer.pid))
      fail("Tauri Mem0 listener is not a child of the current Supervisor");
    if (!mem0MetadataInstanceMatch || Number(mem0Metadata.pid) !== mem0Pid)
      fail("Tauri Mem0 ownership metadata does not match the current instance");
    assertNoUnsafeCommandLine(runtimeCommandLine);
    assertNoUnsafeCommandLine(mem0CommandLine);
    const mem0Health = await requestJson(String(mem0.url), {
      label: "mem0.health",
      diagnostics: requestDiagnostics
    });
    if (mem0Health.status !== 200 || !mem0Health.value?.ok) fail("Tauri Mem0 health failed");
    if (!["healthy", "degraded", "unhealthy"].includes(mem0Health.value?.data?.status))
      fail("Tauri Mem0 health protocol is invalid");
    const runtimeHealth = await requestJson(String(runtime.url), {
      label: "runtime.health",
      diagnostics: requestDiagnostics
    });
    const runtimeHealthProtocol = evaluateRuntimeHealthProtocol(runtimeHealth);
    console.info(formatRuntimeHealthProtocolDiagnostic(runtimeHealthProtocol));
    if (!runtimeHealthProtocol.protocolValid)
      fail(
        `Tauri Runtime health protocol is invalid: ${runtimeHealthProtocol.failureReasons.join("; ")}`
      );

    await sendWmClose(child.pid, layout, timeoutMs);
    if (!pidAlive(child.pid)) fail("Tauri application exited after WM_CLOSE");
    if (!pidAlive(Number(pointer.pid))) fail("Supervisor exited after Tauri WM_CLOSE");
    if (!pidAlive(runtimePid)) fail("Runtime exited after Tauri WM_CLOSE");
    if (!pidAlive(mem0Pid)) fail("Mem0 exited after Tauri WM_CLOSE");
    timeline.mark("T10-main-close-hidden-services-persistent", {
      appPid: child.pid,
      supervisorPid: Number(pointer.pid),
      runtimePid,
      mem0Pid
    });
    await sendTrayQuit(child.pid, layout, timeoutMs);
    if (!(await waitForProcessExit(child.pid, Math.min(timeoutMs, 20_000))))
      fail("Tauri application did not exit after tray Quit");
    if (!(await waitForProcessExit(Number(pointer.pid), Math.min(timeoutMs, 20_000))))
      fail("Supervisor did not exit after tray Quit");
    if (!(await waitForProcessExit(runtimePid, Math.min(timeoutMs, 20_000))))
      fail("Runtime did not exit after tray Quit");
    if (!(await waitForProcessExit(mem0Pid, Math.min(timeoutMs, 20_000))))
      fail("Mem0 did not exit after tray Quit");
    const pointerPath = path.join(
      tauriLocalAppData,
      "YUVI",
      "DesktopSupervisor",
      "active-instance.json"
    );
    if (fs.existsSync(pointerPath)) {
      const active = readJson(pointerPath);
      if (active.pid && pidAlive(Number(active.pid)))
        fail("active Supervisor pointer remains alive");
    }
    const readinessPath = path.join(
      tauriLocalAppData,
      "YUVI",
      "DesktopSupervisor",
      "tauri-bootstrap-ready.json"
    );
    if (fs.existsSync(readinessPath)) fail("Tauri bootstrap readiness marker remains after shutdown");
    logExit();
    return {
      appExecutable,
      appPid: child.pid,
      supervisorPid: Number(pointer.pid),
      runtimePid,
      mem0Pid,
      runtimeCommandLine,
      mem0CommandLine,
      mem0Provenance,
      mode: pointer.mode,
      mem0Health: mem0Health.value
    };
  } catch (error) {
    const failureSnapshot = createTauriFailureSnapshot({
      appPid: child.pid,
      supervisorPid: Number(pointer?.pid) || 0,
      runtimePid,
      mem0Pid,
      endpoint,
      runtime,
      installRoot: resource.root
    });
    timeline.mark("E9-failure-snapshot", {
      snapshotStatus: failureSnapshot.snapshotStatus
    });
    timeline.mark("E10-cleanup-begins");
    if (endpoint?.baseUrl && endpoint.controlToken) {
      try {
        await requestJson(`${endpoint.baseUrl}/v1/shutdown`, {
          method: "POST",
          token: endpoint.controlToken,
          body: null,
          label: "supervisor.shutdown",
          diagnostics: requestDiagnostics
        });
      } catch {
        /* exact smoke instance cleanup only */
      }
    }
    for (const pid of [child.pid, Number(endpoint?.pid), runtimePid, mem0Pid]) {
      if (pid && pidAlive(pid)) {
        try {
          process.kill(pid);
        } catch {
          /* exact smoke PID fallback only */
        }
      }
    }
    logExit();
    const diagnostic = runtimeDiagnosticText ? `\n${runtimeDiagnosticText}` : "";
    const failureDiagnostic = formatTauriFailureDiagnostic({
      primaryError: error,
      requestDiagnostics,
      timeline,
      snapshot: failureSnapshot,
      processQueries
    });
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n${failureDiagnostic}${diagnostic}\n${stdout}\n${stderr}`
    );
  }
}

async function waitForInstallRemoval(installDir, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < Math.max(timeoutMs, 10_000)) {
    if (!fs.existsSync(installDir)) return;
    const entries = fs.readdirSync(installDir);
    if (entries.length === 0) return;
    await wait(250);
  }
  if (fs.existsSync(installDir) && fs.readdirSync(installDir).length > 0)
    fail("TEMP install still contains files after uninstall");
}

async function buildIfRequested() {
  if (!process.argv.includes("--build")) return 0;
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const started = Date.now();
  const result = spawnSync(command, ["desktop:build:windows"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    shell: false,
    windowsHide: true
  });
  if (result.status !== 0) fail(`desktop:build:windows failed (${result.status})`);
  return started;
}

function artifactStat(root) {
  const files = listFiles(root);
  return {
    exists: fs.existsSync(root),
    files: files.length,
    bytes: files.reduce((sum, file) => sum + fs.statSync(file).size, 0)
  };
}

function treeMetadata(root) {
  if (!root || !fs.existsSync(root)) return { exists: false, files: [] };
  return {
    exists: true,
    files: listFiles(root)
      .map((file) => {
        const stat = fs.statSync(file);
        return {
          path: path.relative(root, file).replaceAll("\\", "/"),
          size: stat.size,
          mtimeMs: stat.mtimeMs
        };
      })
      .sort((a, b) => a.path.localeCompare(b.path))
  };
}

export async function runInstallerSmoke(options = parseArgs()) {
  if (options === null) return null;
  if (options.launchApp) assertTauriAppSmokeAllowed();
  if (options.cleanupStale) {
    const result = cleanupStaleRoots();
    console.info(
      `[installer-smoke] stale TEMP cleanup removed=${result.removed.length}, retained=${result.retained.length}`
    );
    return result;
  }
  const buildStartedAt = options.build ? await buildIfRequested() : 0;
  const selection = chooseInstaller({ explicitPath: options.installer, buildStartedAt });
  console.info(
    `[installer-smoke] candidates: ${selection.candidates.map((candidate) => `${candidate.name} (${new Date(candidate.mtimeMs).toISOString()})`).join(", ") || "explicit path"}`
  );
  console.info(`[installer-smoke] selected: ${selection.selected.path}`);
  assertInstallerSwitches(selection.selected.path);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-installer-smoke-"));
  assertTempRoot(root);
  const layout = {
    root,
    ...Object.fromEntries(
      [
        "install",
        "state",
        "localAppData",
        "appData",
        "home",
        "temp",
        "emptyCwd",
        "logs",
        "snapshots"
      ].map((name) => [name, path.join(root, name)])
    )
  };
  for (const dir of Object.values(layout)) fs.mkdirSync(dir, { recursive: true });
  assertInstallPathSafe(layout.install, root);
  const baseline = captureProcessBaseline();
  const realLocal = process.env.LOCALAPPDATA;
  const existing = {
    defaultInstall: process.env.ProgramFiles
      ? path.join(process.env.ProgramFiles, "YUVI Companion")
      : null,
    localSupervisor: realLocal ? path.join(realLocal, "YUVI", "DesktopSupervisor") : null,
    localMem0: realLocal ? path.join(realLocal, "YUVI", "Mem0") : null,
    defaultInstallState: treeMetadata(
      process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "YUVI Companion") : null
    ),
    localSupervisorState: treeMetadata(
      realLocal ? path.join(realLocal, "YUVI", "DesktopSupervisor") : null
    ),
    localMem0State: treeMetadata(realLocal ? path.join(realLocal, "YUVI", "Mem0") : null),
    generated: artifactStat(TAURI_GENERATED),
    build: artifactStat(BUILD_ROOT)
  };
  const logBase = `installer=${selection.selected.name}\nsize=${selection.selected.size}\nmtime=${selection.selected.mtimeMs}\n`;
  writeLog(layout.logs, "installer-selection.log", logBase);
  let result;
  try {
    const install = await runProcess(
      selection.selected.path,
      ["/S", `/D=${layout.install}`],
      { cwd: layout.emptyCwd, stdio: ["ignore", "pipe", "pipe"] },
      options.timeoutMs
    );
    writeLog(layout.logs, "nsis-install.log", `${install.stdout}\n${install.stderr}`);
    if (install.code !== 0) fail(`NSIS installer failed (${install.code})`);
    if (!fs.existsSync(layout.install)) fail("NSIS installer did not create TEMP install");
    const mainExe = path.join(layout.install, "yuvi-desktop.exe");
    if (!fs.existsSync(mainExe)) fail("installed main executable is missing");
    const uninstaller = findUninstaller(layout.install);
    assertSilentSwitch(uninstaller, "uninstaller");
    const resourceRoot = locateResourceRoot(layout.install);
    const resource = { root: resourceRoot, ...validateInstalledResources(resourceRoot) };
    const before = snapshotTree(resourceRoot);
    result = await runPackagedSupervisor({ resource, layout, timeoutMs: options.timeoutMs });
    await waitForSpecificPidsExit(
      [
        { role: "Supervisor", pid: result.supervisorPid },
        { role: "Mem0", pid: result.mem0Pid }
      ],
      { timeoutMs: options.timeoutMs }
    );
    const after = snapshotTree(resourceRoot);
    const changes = compareSnapshots(before, after);
    if (changes.length)
      fail(`installed resource tree changed: ${changes.map((change) => change.path).join(", ")}`);
    let appSmoke = null;
    if (options.launchApp) {
      appSmoke = await runTauriAppSmoke({
        installDir: layout.install,
        resource,
        layout,
        timeoutMs: options.timeoutMs
      });
      const appAfter = snapshotTree(resourceRoot);
      const appChanges = compareSnapshots(before, appAfter);
      if (appChanges.length)
        fail(
          `installed resource tree changed during Tauri app smoke: ${appChanges.map((change) => change.path).join(", ")}`
        );
    }
    const uninstall = await runProcess(
      uninstaller,
      ["/S"],
      { cwd: layout.emptyCwd, stdio: ["ignore", "pipe", "pipe"] },
      options.timeoutMs
    );
    writeLog(layout.logs, "nsis-uninstall.log", `${uninstall.stdout}\n${uninstall.stderr}`);
    if (uninstall.code !== 0) fail(`NSIS uninstaller failed (${uninstall.code})`);
    await waitForInstallRemoval(layout.install, options.timeoutMs);
    assertNoNewNamedProcesses(baseline);
    const afterExisting = {
      defaultInstallState: treeMetadata(existing.defaultInstall),
      localSupervisorState: treeMetadata(existing.localSupervisor),
      localMem0State: treeMetadata(existing.localMem0),
      generated: artifactStat(TAURI_GENERATED),
      build: artifactStat(BUILD_ROOT)
    };
    if (
      JSON.stringify({
        defaultInstallState: existing.defaultInstallState,
        localSupervisorState: existing.localSupervisorState,
        localMem0State: existing.localMem0State,
        generated: existing.generated,
        build: existing.build
      }) !== JSON.stringify(afterExisting)
    )
      fail("an existing install, user state, or repository artifact changed");
    const summary = {
      installer: selection.selected,
      resourceRoot,
      installRoot: root,
      mem0: result.mem0,
      mem0Health: result.status,
      mem0CommandLine: result.commandLine,
      mem0Files: result ? resource.mem0Result.files : 0,
      mem0Bytes: result ? resource.mem0Result.bytes : 0,
      resourceSnapshot: "unchanged",
      uninstall: "passed",
      existing,
      processBaseline: "preserved"
    };
    if (appSmoke) summary.tauriApp = appSmoke;
    fs.writeFileSync(
      path.join(layout.snapshots, "summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
      "utf8"
    );
    console.info(
      `[installer-smoke] passed: Mem0 pid=${result.mem0Pid}, files=${summary.mem0Files}, bytes=${summary.mem0Bytes}`
    );
    return summary;
  } finally {
    if (options.keepTemp) console.info(`[installer-smoke] kept TEMP root: ${root}`);
    else {
      assertCleanupTarget(root);
      await removeTreeWithRetries(root, {
        smokeOwnedRoot: root,
        deadlineMs: Math.min(options.timeoutMs, 10_000)
      });
    }
  }
}

if (
  import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}` ||
  process.argv[1]?.endsWith("installer-smoke.mjs")
) {
  runInstallerSmoke().catch((error) => {
    console.error(
      `[installer-smoke] failed: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  });
}
