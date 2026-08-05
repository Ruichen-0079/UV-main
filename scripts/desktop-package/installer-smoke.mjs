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
const TOOL_NAMES = ["python", "python3", "py", "pip", "uv", "node", "pnpm", "tsx"];

function fail(message) {
  throw new Error(message);
}

function normalized(value) {
  return path.resolve(String(value)).replaceAll("/", "\\").toLowerCase();
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

function windowsOnlyPath() {
  if (process.platform !== "win32") return "/usr/bin:/bin";
  const windir = process.env.WINDIR || process.env.SystemRoot || "C:\\Windows";
  return [
    path.join(windir, "System32"),
    windir,
    path.join(windir, "System32", "Wbem"),
    path.join(windir, "System32", "WindowsPowerShell", "v1.0")
  ].join(path.delimiter);
}

export function restrictedPath() {
  return windowsOnlyPath();
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
  for (const field of ["runtimeEntry", "nodeExecutable", "mem0Executable", "mem0Manifest"])
    assertRelativeSafe(info[field], `packaging-info.${field}`);
  assertNoSecrets(info, "packaging-info");
  return info;
}

export function validateInstalledResources(resourceRoot) {
  const runtime = path.join(resourceRoot, "runtime");
  const supervisor = path.join(resourceRoot, "supervisor");
  const mem0 = path.join(resourceRoot, "mem0");
  const infoPath = path.join(resourceRoot, "packaging-info.json");
  for (const required of [runtime, supervisor, mem0, infoPath])
    if (!fs.existsSync(required)) fail(`installed resource missing: ${required}`);
  const info = validatePackagingInfo(readJson(infoPath));
  for (const required of [
    path.join(runtime, NODE_EXE_NAME),
    path.join(runtime, RUNTIME_ENTRY_NAME),
    path.join(runtime, RUNTIME_MANIFEST_NAME),
    path.join(supervisor, SUPERVISOR_BUNDLE_NAME),
    path.join(mem0, MEM0_EXE_NAME),
    path.join(mem0, MEM0_MANIFEST_NAME),
    path.join(mem0, MEM0_INTERNAL_DIR_NAME)
  ])
    if (!fs.existsSync(required)) fail(`installed resource missing: ${required}`);
  const runtimeManifest = readJson(path.join(runtime, RUNTIME_MANIFEST_NAME));
  for (const field of ["nodeExecutable", "runtimeEntry"])
    assertRelativeSafe(runtimeManifest[field], `runtime-manifest.${field}`);
  assertNoSecrets(runtimeManifest, "runtime-manifest");
  const mem0Result = validateMem0Artifact(mem0, { repoRoot: REPO_ROOT });
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
  return { info, runtime, supervisor, mem0, runtimeManifest, mem0Result };
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
      reject(new Error(`${path.basename(file)} timed out`));
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

function requestJson(url, { method = "GET", token, body } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const request = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { "content-type": "application/json" } : {})
        }
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (text += chunk));
        response.on("end", () => {
          let value = null;
          try {
            value = text ? JSON.parse(text) : null;
          } catch {
            /* diagnostics below */
          }
          resolve({ status: response.statusCode ?? 0, value, text });
        });
      }
    );
    request.once("error", reject);
    if (body) request.write(JSON.stringify(body));
    request.end();
  });
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

async function waitForSupervisorEndpoint(pointerRoot, stateRoot, timeoutMs) {
  const pointer = path.join(pointerRoot, "active-instance.json");
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(pointer)) {
      try {
        const active = readJson(pointer);
        if (active.endpointFile && isWithin(active.endpointFile, stateRoot)) {
          const endpoint = await waitForJsonFile(active.endpointFile, Math.min(timeoutMs, 5_000));
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

function processCommandLine(pid) {
  if (!pid || process.platform !== "win32") return "";
  try {
    const script = `(Get-CimInstance Win32_Process -Filter \"ProcessId=${Number(pid)}\").CommandLine`;
    return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true
    }).trim();
  } catch {
    return "";
  }
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

function assertToolsUnresolvable(env) {
  if (process.platform !== "win32") return [];
  const unresolved = [];
  for (const tool of TOOL_NAMES) {
    try {
      execFileSync("where.exe", [tool], {
        env,
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"]
      });
    } catch {
      unresolved.push(tool);
    }
  }
  const expected = TOOL_NAMES.filter((tool) => unresolved.includes(tool));
  if (expected.length !== TOOL_NAMES.length)
    fail(
      `restricted PATH resolved: ${TOOL_NAMES.filter((tool) => !unresolved.includes(tool)).join(", ")}`
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

async function runPackagedSupervisor({ resource, layout, timeoutMs }) {
  const port = await freePort();
  const stateRoot = path.join(layout.state, "supervisor");
  const localAppData = layout.localAppData;
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
    MEMORY_BACKEND: "mem0",
    MEM0_BASE_URL: `http://127.0.0.1:${port}`,
    PROVIDER_ALLOW_MOCKS: "true"
  });
  assertNoSecrets(env, "child env");
  assertToolsUnresolvable(env);
  const runtimeNode = path.join(resource.runtime, NODE_EXE_NAME);
  const supervisorExe = path.join(resource.supervisor, SUPERVISOR_EXE_NAME);
  const supervisorCjs = path.join(resource.supervisor, SUPERVISOR_BUNDLE_NAME);
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
  const useExe = fs.existsSync(supervisorExe);
  const command = useExe ? supervisorExe : runtimeNode;
  const commandArgs = useExe ? args : [supervisorCjs, ...args];
  const child = spawn(command, commandArgs, {
    cwd: layout.emptyCwd,
    env,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  let endpoint = null;
  let ownedMem0Pid = 0;
  child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
  child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
  const logExit = () => writeLog(layout.logs, "supervisor.log", `${stdout}\n${stderr}`);
  try {
    endpoint = await waitForSupervisorEndpoint(
      path.join(localAppData, "YUVI", "DesktopSupervisor"),
      stateRoot,
      timeoutMs
    );
    const base = String(endpoint.baseUrl);
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) fail("Supervisor endpoint is not loopback");
    const health = await requestJson(`${base}/health`);
    if (health.status !== 200 || health.value?.ok !== true)
      fail(`Supervisor health failed (${health.status})`);
    const bootstrap = await requestJson(`${base}/v1/bootstrap`, {
      method: "POST",
      token: endpoint.controlToken,
      body: null
    });
    if (bootstrap.status < 200 || bootstrap.status >= 300)
      fail(`Supervisor bootstrap failed (${bootstrap.status})`);
    let mem0 = null;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const status = await requestJson(`${base}/v1/status`, { token: endpoint.controlToken });
      mem0 = status.value?.services?.find((service) => service.id === "mem0") ?? null;
      if (
        mem0?.managed === true &&
        mem0.ownership === "owned" &&
        Number(mem0.pid) > 0 &&
        ["healthy", "degraded", "unhealthy"].includes(mem0.status)
      )
        break;
      await wait(300);
    }
    if (!mem0 || mem0.managed !== true || mem0.ownership !== "owned" || !(mem0.pid > 0))
      fail("Supervisor did not own a running Mem0");
    const mem0Health = await requestJson(`http://127.0.0.1:${port}/health`);
    if (mem0Health.status !== 200 || !mem0Health.value?.ok)
      fail(`Mem0 health failed (${mem0Health.status})`);
    ownedMem0Pid = Number(mem0.pid);
    const commandLine = processCommandLine(mem0.pid);
    if (commandLine) {
      const expectedMem0 = path
        .join(resource.root, "mem0", MEM0_EXE_NAME)
        .toLowerCase()
        .replaceAll("/", "\\");
      if (!commandLine.toLowerCase().replaceAll("/", "\\").includes(expectedMem0))
        fail("Mem0 command line is not the installed executable");
      assertNoUnsafeCommandLine(commandLine);
    }
    const dataRoot = path.join(localAppData, "YUVI", "Mem0");
    if (!isWithin(dataRoot, localAppData) || !fs.existsSync(dataRoot))
      fail("isolated Mem0 data path missing");
    if (fs.existsSync(path.join(layout.home, ".mem0"))) fail("Mem0 wrote into HOME");
    const emptyEntries = fs.existsSync(layout.emptyCwd) ? fs.readdirSync(layout.emptyCwd) : [];
    if (emptyEntries.length) fail(`empty cwd was written: ${emptyEntries.join(", ")}`);
    const shutdown = await requestJson(`${base}/v1/shutdown`, {
      method: "POST",
      token: endpoint.controlToken,
      body: null
    });
    if (shutdown.status < 200 || shutdown.status >= 300)
      fail(`Supervisor shutdown failed (${shutdown.status})`);
    const mem0Pid = ownedMem0Pid;
    const waitStarted = Date.now();
    while (Date.now() - waitStarted < timeoutMs && (pidAlive(child.pid) || pidAlive(mem0Pid)))
      await wait(250);
    if (pidAlive(mem0Pid)) fail(`owned Mem0 survived shutdown (${mem0Pid})`);
    if (pidAlive(child.pid)) {
      try {
        child.kill();
      } catch {
        /* exact child fallback only */
      }
    }
    logExit();
    return {
      endpoint,
      mem0,
      mem0Pid,
      commandLine,
      supervisorPid: child.pid,
      useExe,
      status: mem0Health.value
    };
  } catch (error) {
    if (endpoint?.baseUrl && endpoint?.controlToken) {
      try {
        await requestJson(`${endpoint.baseUrl}/v1/shutdown`, {
          method: "POST",
          token: endpoint.controlToken,
          body: null
        });
      } catch {
        /* best-effort graceful shutdown of this exact smoke instance */
      }
    }
    const stopStarted = Date.now();
    while (ownedMem0Pid && pidAlive(ownedMem0Pid) && Date.now() - stopStarted < 5_000)
      await wait(200);
    try {
      child.kill();
    } catch {
      /* exact spawned child only */
    }
    logExit();
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n${stdout}\n${stderr}`
    );
  }
}

export function buildWmCloseScript(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) fail("WM_CLOSE target PID is invalid");
  return `$targetPid = ${numericPid};
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class YuviWindowCloser {
  private const uint WM_CLOSE = 0x0010;
  private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extra);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] private static extern bool PostMessageW(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
  public static void CloseForProcess(uint targetPid) {
    EnumWindows((hWnd, extra) => {
      uint windowPid;
      GetWindowThreadProcessId(hWnd, out windowPid);
      if (windowPid == targetPid) PostMessageW(hWnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
      return true;
    }, IntPtr.Zero);
  }
}
'@
[YuviWindowCloser]::CloseForProcess($targetPid)`;
}

async function waitForProcessExit(pid, timeoutMs) {
  const started = Date.now();
  while (pidAlive(pid) && Date.now() - started < timeoutMs) await wait(250);
  return !pidAlive(pid);
}

async function sendWmClose(pid, layout, timeoutMs) {
  const script = buildWmCloseScript(pid);
  assertNoSecrets(script, "WM_CLOSE script");
  const result = await runProcess(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { cwd: layout.emptyCwd, env: sanitizeChildEnv(), stdio: ["ignore", "pipe", "pipe"] },
    Math.min(timeoutMs, 10_000)
  );
  writeLog(layout.logs, "wm-close.log", `${result.stdout}\n${result.stderr}`);
  if (result.code !== 0) fail(`WM_CLOSE command failed (${result.code})`);
}

async function runTauriAppSmoke({ installDir, resource, layout, timeoutMs }) {
  const appExecutable = findInstalledApplicationExecutable(installDir);
  const tauriLocalAppData = path.join(layout.root, "tauri-local-app-data");
  const tauriAppData = path.join(layout.root, "tauri-app-data");
  const tauriHome = path.join(layout.root, "tauri-home");
  const tauriTemp = path.join(layout.root, "tauri-temp");
  for (const dir of [tauriLocalAppData, tauriAppData, tauriHome, tauriTemp])
    fs.mkdirSync(dir, { recursive: true });
  const env = sanitizeChildEnv({
    LOCALAPPDATA: tauriLocalAppData,
    APPDATA: tauriAppData,
    USERPROFILE: tauriHome,
    HOME: tauriHome,
    TEMP: tauriTemp,
    TMP: tauriTemp,
    YUVI_AUTOSTART_RUNTIME: "true",
    YUVI_AUTOSTART_MEM0: "true",
    YUVI_AUTOSTART_TTS: "false"
  });
  assertNoSecrets(env, "Tauri app env");
  const appArgs = [];
  assertNoSecrets(appArgs, "Tauri app argv");
  const child = spawn(appExecutable, appArgs, {
    cwd: layout.emptyCwd,
    env,
    shell: false,
    windowsHide: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
  child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
  const logExit = () => writeLog(layout.logs, "tauri-app.log", `${stdout}\n${stderr}`);
  let endpoint = null;
  let runtimePid = 0;
  let mem0Pid = 0;
  try {
    endpoint = await waitForSupervisorEndpoint(
      path.join(tauriLocalAppData, "YUVI", "DesktopSupervisor"),
      path.join(tauriLocalAppData, "YUVI", "DesktopSupervisor"),
      timeoutMs
    );
    if (!pidAlive(child.pid)) fail("Tauri application exited before bootstrap");
    const pointer = readJson(
      path.join(tauriLocalAppData, "YUVI", "DesktopSupervisor", "active-instance.json")
    );
    if (pointer.mode !== "packaged") fail("Tauri bootstrap did not use packaged mode");
    if (!pidAlive(Number(pointer.pid))) fail("packaged Supervisor endpoint PID is not alive");
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(String(endpoint.baseUrl)))
      fail("Tauri Supervisor endpoint is not loopback");
    const health = await requestJson(`${endpoint.baseUrl}/health`);
    if (health.status !== 200 || health.value?.ok !== true) fail("Tauri Supervisor health failed");
    const status = await requestJson(`${endpoint.baseUrl}/v1/status`, {
      token: endpoint.controlToken
    });
    if (status.status !== 200) fail("Tauri Supervisor status failed");
    const services = status.value?.services ?? [];
    const runtime = services.find((service) => service.id === "runtime");
    const mem0 = services.find((service) => service.id === "mem0");
    const tts = services.find((service) => service.id === "tts_wrapper");
    if (!runtime || runtime.managed !== true || runtime.ownership !== "owned" || !(runtime.pid > 0))
      fail("Tauri bootstrap did not own Runtime");
    if (!mem0 || mem0.managed !== true || mem0.ownership !== "owned" || !(mem0.pid > 0))
      fail("Tauri bootstrap did not own Mem0");
    if (tts?.ownership === "owned" || tts?.pid) fail("Tauri smoke unexpectedly started TTS");
    runtimePid = Number(runtime.pid);
    mem0Pid = Number(mem0.pid);
    const runtimeCommandLine = processCommandLine(runtimePid);
    const mem0CommandLine = processCommandLine(mem0Pid);
    const expectedRuntime = path
      .join(resource.root, "runtime", NODE_EXE_NAME)
      .toLowerCase()
      .replaceAll("/", "\\");
    const expectedMem0 = path
      .join(resource.root, "mem0", MEM0_EXE_NAME)
      .toLowerCase()
      .replaceAll("/", "\\");
    if (!runtimeCommandLine.toLowerCase().replaceAll("/", "\\").includes(expectedRuntime))
      fail("Tauri Runtime command line is not the installed bundled Node");
    if (!mem0CommandLine.toLowerCase().replaceAll("/", "\\").includes(expectedMem0))
      fail("Tauri Mem0 command line is not the installed executable");
    assertNoUnsafeCommandLine(runtimeCommandLine);
    assertNoUnsafeCommandLine(mem0CommandLine);
    const mem0Health = await requestJson(String(mem0.url));
    if (mem0Health.status !== 200 || !mem0Health.value?.ok) fail("Tauri Mem0 health failed");
    if (!["healthy", "degraded", "unhealthy"].includes(mem0Health.value?.data?.status))
      fail("Tauri Mem0 health protocol is invalid");
    const runtimeHealth = await requestJson(String(runtime.url));
    if (runtimeHealth.status !== 200 || runtimeHealth.value?.ok !== true)
      fail("Tauri Runtime health protocol is invalid");

    await sendWmClose(child.pid, layout, timeoutMs);
    if (!(await waitForProcessExit(child.pid, Math.min(timeoutMs, 20_000))))
      fail("Tauri application did not exit after WM_CLOSE");
    if (!(await waitForProcessExit(Number(pointer.pid), Math.min(timeoutMs, 20_000))))
      fail("Supervisor did not exit after Tauri CloseRequested");
    if (!(await waitForProcessExit(runtimePid, Math.min(timeoutMs, 20_000))))
      fail("Runtime did not exit after Tauri CloseRequested");
    if (!(await waitForProcessExit(mem0Pid, Math.min(timeoutMs, 20_000))))
      fail("Mem0 did not exit after Tauri CloseRequested");
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
    logExit();
    return {
      appExecutable,
      appPid: child.pid,
      supervisorPid: Number(pointer.pid),
      runtimePid,
      mem0Pid,
      runtimeCommandLine,
      mem0CommandLine,
      mode: pointer.mode,
      mem0Health: mem0Health.value
    };
  } catch (error) {
    if (endpoint?.baseUrl && endpoint.controlToken) {
      try {
        await requestJson(`${endpoint.baseUrl}/v1/shutdown`, {
          method: "POST",
          token: endpoint.controlToken,
          body: null
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
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n${stdout}\n${stderr}`
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
      fs.rmSync(root, { recursive: true, force: true });
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
