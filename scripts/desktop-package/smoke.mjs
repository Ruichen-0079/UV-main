/**
 * Clean-room smoke for packaged artifacts.
 * Copies supervisor/ + runtime/ outside the repo and runs with a sanitized PATH/env.
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  NODE_EXE_NAME,
  REPO_ROOT,
  RUNTIME_ENTRY_NAME,
  RUNTIME_MANIFEST_NAME,
  RUNTIME_OUT_DIR,
  SUPERVISOR_BUNDLE_NAME,
  SUPERVISOR_EXE_NAME,
  SUPERVISOR_OUT_DIR,
  TAURI_GENERATED
} from "./constants.mjs";
import { assertFile, readJson } from "./paths.mjs";
import { collectDisallowedExternals } from "./build-runtime.mjs";

function fail(message) {
  throw new Error(message);
}

function systemPathOnly() {
  if (process.platform === "win32") {
    const windir = process.env["WINDIR"] ?? "C:\\Windows";
    return [path.join(windir, "System32"), windir, path.join(windir, "System32", "Wbem")].join(
      path.delimiter
    );
  }
  return "/usr/bin:/bin";
}

function cleanEnv(extra = {}) {
  const env = {};
  // Keep only non-dev essentials from the host process.
  for (const key of [
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
    "APPDATA",
    "LOCALAPPDATA",
    "COMPUTERNAME",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "OS",
    "PATHEXT",
    "COMSPEC"
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // Explicit caller overrides win (e.g. isolated LOCALAPPDATA for clean-room).
  Object.assign(env, extra);
  env.PATH = systemPathOnly();
  env.Path = env.PATH;
  // Explicitly strip Node/npm/pnpm pollution.
  for (const key of [
    "NODE_PATH",
    "NODE_OPTIONS",
    "npm_config_prefix",
    "npm_config_cache",
    "npm_config_user_agent",
    "PNPM_HOME",
    "INIT_CWD",
    "npm_lifecycle_event",
    "npm_package_name",
    "BUN_INSTALL",
    "NVM_DIR",
    "FNM_DIR"
  ]) {
    delete env[key];
  }
  return env;
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    if (ent.isDirectory()) {
      copyDir(from, to);
    } else if (ent.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

function listFiles(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) listFiles(full, acc);
    else acc.push(full);
  }
  return acc;
}

function assertNoRepoPaths(text, label) {
  const repo = REPO_ROOT.replaceAll("/", "\\");
  if (text.includes(REPO_ROOT) || text.replaceAll("/", "\\").includes(repo)) {
    fail(`${label} contains repository path: ${REPO_ROOT}`);
  }
}

export async function smokeDesktopPackage() {
  console.info("[desktop-package] clean-room smoke start");

  const sourceRuntime = fs.existsSync(path.join(TAURI_GENERATED, "runtime"))
    ? path.join(TAURI_GENERATED, "runtime")
    : RUNTIME_OUT_DIR;
  const sourceSupervisor = fs.existsSync(path.join(TAURI_GENERATED, "supervisor"))
    ? path.join(TAURI_GENERATED, "supervisor")
    : SUPERVISOR_OUT_DIR;

  assertFile(path.join(sourceRuntime, NODE_EXE_NAME), "source node.exe");
  assertFile(path.join(sourceRuntime, RUNTIME_ENTRY_NAME), "source runtime entry");
  assertFile(path.join(sourceRuntime, RUNTIME_MANIFEST_NAME), "source runtime manifest");
  assertFile(path.join(sourceSupervisor, SUPERVISOR_BUNDLE_NAME), "source supervisor cjs");

  // Metafile audit (from prepare output next to runtime entry).
  const metafilePath = path.join(sourceRuntime, "runtime-esbuild-metafile.json");
  if (fs.existsSync(metafilePath)) {
    const meta = readJson(metafilePath);
    const disallowed = collectDisallowedExternals(meta);
    if (disallowed.length > 0) {
      fail(`disallowed runtime externals: ${disallowed.join(", ")}`);
    }
    console.info("[desktop-package] metafile external audit ok");
  } else {
    console.warn("[desktop-package] metafile missing in stage (re-run prepare)");
  }

  const manifest = readJson(path.join(sourceRuntime, RUNTIME_MANIFEST_NAME));
  if (manifest.schemaVersion !== 1) fail("bad schemaVersion");
  if (path.isAbsolute(manifest.nodeExecutable) || path.isAbsolute(manifest.runtimeEntry)) {
    fail("manifest must use relative paths");
  }
  const manifestText = JSON.stringify(manifest);
  assertNoRepoPaths(manifestText, "manifest");
  if (/sk-|api[_-]?key|password|secret/i.test(manifestText)) {
    fail("manifest must not contain secret-like keys");
  }

  const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-package-smoke-"));
  // Ensure outside repo
  if (smokeRoot.toLowerCase().startsWith(REPO_ROOT.toLowerCase())) {
    fail(`smoke temp dir is under repository: ${smokeRoot}`);
  }
  const cleanRoom = path.join(smokeRoot, "resources");
  const runtimeDir = path.join(cleanRoom, "runtime");
  const supervisorDir = path.join(cleanRoom, "supervisor");
  const dataRoot = path.join(smokeRoot, "state");
  const emptyCwd = path.join(smokeRoot, "empty-cwd");
  fs.mkdirSync(emptyCwd, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });

  copyDir(sourceRuntime, runtimeDir);
  copyDir(sourceSupervisor, supervisorDir);

  // Snapshot resource files before run (must not write into install-like resource tree).
  const beforeFiles = new Set(listFiles(cleanRoom).map((f) => path.relative(cleanRoom, f)));

  const nodeExe = path.join(runtimeDir, NODE_EXE_NAME);
  const entry = path.join(runtimeDir, RUNTIME_ENTRY_NAME);
  const exePath = path.join(supervisorDir, SUPERVISOR_EXE_NAME);
  const cjsPath = path.join(supervisorDir, SUPERVISOR_BUNDLE_NAME);
  const useExe = fs.existsSync(exePath);

  // --- Runtime direct smoke (clean env + empty cwd) ---
  const runtimePort = 18000 + Math.floor(Math.random() * 1000);
  const runtimeData = path.join(dataRoot, "runtime-data");
  fs.mkdirSync(runtimeData, { recursive: true });
  const runtimeEnv = cleanEnv({
    SERVER_HOST: "127.0.0.1",
    SERVER_PORT: String(runtimePort),
    YUVI_PACKAGED: "1",
    YUVI_RUNTIME_DATA_DIR: runtimeData,
    YUVI_RUNTIME_ENV_DIR: runtimeData,
    YUVI_RUNTIME_RESOURCE_DIR: cleanRoom,
    PROVIDER_ALLOW_MOCKS: "true",
    MEMORY_REPOSITORY: "in-memory",
    MEMORY_BACKEND: "legacy"
  });
  const runtimeChild = spawn(nodeExe, [entry], {
    cwd: emptyCwd,
    env: runtimeEnv,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let runtimeStdout = "";
  let runtimeStderr = "";
  runtimeChild.stdout?.on("data", (c) => {
    runtimeStdout += c.toString();
  });
  runtimeChild.stderr?.on("data", (c) => {
    runtimeStderr += c.toString();
  });

  try {
    await waitForHealth(runtimePort, 25_000);
    console.info(`[desktop-package] clean-room runtime health ok on :${runtimePort}`);
    assertNoRepoPaths(runtimeStdout + runtimeStderr, "runtime logs");
  } catch (error) {
    fail(
      `runtime health failed: ${error instanceof Error ? error.message : String(error)}\nstdout=${runtimeStdout}\nstderr=${runtimeStderr}`
    );
  } finally {
    runtimeChild.kill();
    await sleep(400);
  }

  // --- Supervisor smoke ---
  // Point active pointer into a isolated LOCALAPPDATA under smoke root so we don't
  // require real user profile, while still testing packaged layout args.
  const fakeLocalAppData = path.join(smokeRoot, "LocalAppData");
  fs.mkdirSync(fakeLocalAppData, { recursive: true });
  const supervisorEnv = cleanEnv({
    LOCALAPPDATA: fakeLocalAppData,
    YUVI_AUTOSTART_RUNTIME: "true",
    YUVI_AUTOSTART_MEM0: "false",
    YUVI_AUTOSTART_TTS: "false",
    SERVER_HOST: "127.0.0.1",
    SERVER_PORT: String(19000 + Math.floor(Math.random() * 500)),
    PROVIDER_ALLOW_MOCKS: "true",
    MEMORY_REPOSITORY: "in-memory",
    MEMORY_BACKEND: "legacy"
  });

  const args = [
    "--mode",
    "packaged",
    "--resource-root",
    cleanRoom,
    "--state-root",
    dataRoot,
    "--runtime-manifest",
    path.join(runtimeDir, RUNTIME_MANIFEST_NAME)
  ];
  for (const a of args) {
    if (/sk-|deepseek_api_key|database_url/i.test(a)) {
      fail("secret-like argv");
    }
  }

  const sup = useExe
    ? spawn(exePath, args, {
        cwd: emptyCwd,
        env: supervisorEnv,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      })
    : spawn(nodeExe, [cjsPath, ...args], {
        cwd: emptyCwd,
        env: supervisorEnv,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });

  let supStdout = "";
  let supStderr = "";
  sup.stdout?.on("data", (c) => {
    supStdout += c.toString();
  });
  sup.stderr?.on("data", (c) => {
    supStderr += c.toString();
  });

  let supervised = false;
  let endpointToken = null;
  let endpointBase = null;
  try {
    const deadline = Date.now() + 35_000;
    while (Date.now() < deadline) {
      const endpoints = findEndpointFiles(dataRoot, fakeLocalAppData);
      for (const file of endpoints) {
        try {
          const data = JSON.parse(fs.readFileSync(file, "utf8"));
          const baseUrl =
            data.baseUrl ?? (data.port ? `http://127.0.0.1:${data.port}` : null);
          if (baseUrl && (await getOk(`${baseUrl}/health`))) {
            supervised = true;
            endpointBase = baseUrl;
            endpointToken = data.controlToken ?? null;
            break;
          }
        } catch {
          // continue
        }
      }
      if (supervised) break;
      await sleep(300);
    }

    if (!supervised) {
      fail(`supervisor did not become healthy\nstdout=${supStdout}\nstderr=${supStderr}`);
    }
    console.info("[desktop-package] clean-room supervisor health ok");

    // Bootstrap so managed Runtime may start.
    if (endpointToken && endpointBase) {
      await postJson(`${endpointBase}/v1/bootstrap`, endpointToken, null);
      // Wait for runtime health via supervisor status or direct port.
      await sleep(1500);
      await postJson(`${endpointBase}/v1/refresh`, endpointToken, null);
      const status = await getJson(`${endpointBase}/v1/status`, endpointToken);
      const services = status?.services ?? [];
      const runtime = services.find((s) => s.id === "runtime");
      console.info(
        `[desktop-package] runtime status=${runtime?.status ?? "n/a"} ownership=${runtime?.ownership ?? "n/a"}`
      );
    }

    assertNoRepoPaths(supStdout + supStderr, "supervisor logs");

    // Process command lines: supervisor and any child node must be under cleanRoom.
    if (process.platform === "win32" && sup.pid) {
      try {
        const cmdline = getProcessCommandLine(sup.pid);
        if (cmdline) {
          if (/pnpm|tsx/i.test(cmdline)) fail(`supervisor cmdline has pnpm/tsx: ${cmdline}`);
          if (!cmdline.toLowerCase().includes(cleanRoom.toLowerCase().replaceAll("/", "\\"))) {
            // exe path should reference clean-room copy
            const expected = useExe ? exePath : nodeExe;
            if (!cmdline.toLowerCase().includes(path.basename(expected).toLowerCase())) {
              fail(`supervisor cmdline not from clean-room: ${cmdline}`);
            }
          }
        }
      } catch {
        // best-effort
      }
    }

    // Shutdown
    if (endpointToken && endpointBase) {
      await postJson(`${endpointBase}/v1/shutdown`, endpointToken, null);
    }
  } finally {
    try {
      sup.kill();
    } catch {
      // ignore
    }
    await sleep(800);
  }

  // Resource tree must be unchanged (no logs/pid written into install-like dir).
  const afterFiles = new Set(listFiles(cleanRoom).map((f) => path.relative(cleanRoom, f)));
  for (const f of afterFiles) {
    if (!beforeFiles.has(f)) {
      fail(`resource tree gained file during smoke: ${f}`);
    }
  }

  // Cleanup
  try {
    fs.rmSync(smokeRoot, { recursive: true, force: true });
  } catch {
    console.warn(`[desktop-package] temp cleanup incomplete: ${smokeRoot}`);
  }

  console.info("[desktop-package] clean-room smoke passed");
  console.info(`[desktop-package] used supervisor mode: ${useExe ? "pkg-exe" : "node-cjs-fallback"}`);
}

function findEndpointFiles(...roots) {
  const out = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    walk(root, (file) => {
      if (file.endsWith("control-endpoint.json") || file.endsWith("active-instance.json")) {
        out.push(file);
      }
    });
  }
  // Resolve active-instance pointers to endpoint files.
  const resolved = [...out];
  for (const file of out) {
    if (!file.endsWith("active-instance.json")) continue;
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (data.endpointFile && fs.existsSync(data.endpointFile)) {
        resolved.push(data.endpointFile);
      }
    } catch {
      // ignore
    }
  }
  return resolved;
}

function walk(dir, onFile) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, onFile);
    else onFile(full);
  }
}

function getProcessCommandLine(pid) {
  try {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`
      ],
      { encoding: "utf8", windowsHide: true }
    );
    return out.trim();
  } catch {
    return "";
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForHealth(port, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      getOk(`http://127.0.0.1:${port}/health`)
        .then((ok) => {
          if (ok) return resolve();
          if (Date.now() - started > timeoutMs) {
            return reject(new Error(`runtime health timeout on :${port}`));
          }
          setTimeout(tick, 200);
        })
        .catch(() => {
          if (Date.now() - started > timeoutMs) {
            return reject(new Error(`runtime health timeout on :${port}`));
          }
          setTimeout(tick, 200);
        });
    };
    tick();
  });
}

function getOk(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

function getJson(url, token) {
  return new Promise((resolve) => {
    const req = http.get(
      url,
      {
        timeout: 5000,
        headers: token ? { "X-Yuvi-Control-Token": token } : {}
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

function postJson(url, token, body) {
  return new Promise((resolve) => {
    const payload = body == null ? "" : JSON.stringify(body);
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "X-Yuvi-Control-Token": token,
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload)
              }
            : {})
        },
        timeout: 30_000
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      }
    );
    req.on("error", () => resolve(0));
    req.on("timeout", () => {
      req.destroy();
      resolve(0);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith("smoke.mjs");
if (isMain) {
  smokeDesktopPackage().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
