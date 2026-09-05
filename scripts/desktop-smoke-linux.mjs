/**
 * Linux desktop build + startup smoke.
 *
 * Proves, on a dev machine with a display:
 *   clean frontend build inputs → Tauri Linux desktop compiles →
 *   Supervisor control plane publishes an endpoint → Tauri reaches its
 *   bootstrap barrier (`tauri-bootstrap-ready.json` is written only after the
 *   Supervisor ACKs /v1/config AND /v1/bootstrap) → control plane answers
 *   health/status → the smoke exits without leaving owned processes behind.
 *
 * Non-goals: packaging, tray/window interaction, lifecycle redesign.
 *
 * The run is fully isolated: XDG data/config homes, YUVI roots and HOME all
 * point into a fresh temp directory, so real user settings, memory, speaker
 * profiles and Postgres data are never read or written. Services are not
 * autostarted (control plane only) — Runtime/Mem0 lifecycle ownership is the
 * Linux Supervisor/KDE lifecycle atom's scope.
 *
 * Process cleanup is deterministic: every process this smoke started inherits
 * the isolated temp root via its environment, so leftovers are found by
 * scanning each /proc environ file for that unique path — never by name
 * guessing or fixed sleeps.
 *
 * Exit codes: 0 pass · 1 bootstrap/validation failure · 2 preflight failure.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TAURI_DIR = path.join(REPO_ROOT, "apps", "desktop", "src-tauri");
const BINARY = path.join(TAURI_DIR, "target", "debug", "yuvi-desktop");
const READY_MARKER_SEGMENTS = ["YUVI", "DesktopSupervisor", "tauri-bootstrap-ready.json"];

const BOOTSTRAP_TIMEOUT_MS = 60_000;
const APP_EXIT_TIMEOUT_MS = 15_000;
const KILL_WAIT_MS = 5_000;
const POLL_INTERVAL_MS = 250;

let tempRoot;
let appChild = null;
let cleanupDone = false;

function failPreflight(message) {
  console.error(`[desktop-smoke-linux] preflight failed: ${message}`);
  process.exit(2);
}

function fail(message, detail) {
  console.error(`[desktop-smoke-linux] FAIL: ${message}`);
  if (detail) console.error(detail);
  cleanup();
  if (process.exitCode === undefined) process.exitCode = 1;
  process.exit(process.exitCode);
}

function info(message) {
  console.log(`[desktop-smoke-linux] ${message}`);
}

function warn(message) {
  console.warn(`[desktop-smoke-linux] WARN: ${message}`);
}

function runStep(name, file, args, options = {}) {
  info(`${name}: ${file} ${args.join(" ")}`);
  const result = spawnSync(file, args, {
    cwd: options.cwd ?? REPO_ROOT,
    stdio: options.quiet ? "pipe" : "inherit",
    encoding: "utf8"
  });
  if (result.status !== 0) {
    const tail =
      result.stdout || result.stderr
        ? `\n${[result.stdout, result.stderr].filter(Boolean).join("\n").slice(-4000)}`
        : "";
    failPreflight(`${name} exited with code ${result.status}${tail}`);
  }
}

function assertLinuxWithDisplay() {
  if (process.platform !== "linux") {
    failPreflight(
      `this smoke targets Linux (got ${process.platform}); use the Windows/desktop packaging smokes there`
    );
  }
  const hasDisplay = Boolean(
    process.env.WAYLAND_DISPLAY ||
    process.env.DISPLAY ||
    /wayland|x11/i.test(process.env.XDG_SESSION_TYPE ?? "")
  );
  if (!hasDisplay) {
    failPreflight(
      "no graphical session detected (WAYLAND_DISPLAY/DISPLAY unset); WebKitGTK needs a display"
    );
  }
}

function makeIsolatedRoots() {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-desktop-smoke-"));
  for (const segment of ["home", "xdg-data", "xdg-config", "data", "cache", "logs"]) {
    fs.mkdirSync(path.join(tempRoot, segment), { recursive: true });
  }
  return {
    home: path.join(tempRoot, "home"),
    xdgData: path.join(tempRoot, "xdg-data"),
    xdgConfig: path.join(tempRoot, "xdg-config"),
    data: path.join(tempRoot, "data"),
    cache: path.join(tempRoot, "cache"),
    logs: path.join(tempRoot, "logs")
  };
}

function smokeEnv(roots) {
  return {
    ...process.env,
    // Deterministic launch mode (documented tests-only override).
    YUVI_SUPERVISOR_MODE: "development",
    // Isolated Atom 05 roots: never touch real user settings/data/cache.
    HOME: roots.home,
    XDG_DATA_HOME: roots.xdgData,
    XDG_CONFIG_HOME: roots.xdgConfig,
    YUVI_DATA_ROOT: roots.data,
    YUVI_CACHE_ROOT: roots.cache,
    // Control plane only: no Runtime/Mem0/Postgres children from this smoke.
    YUVI_AUTOSTART_RUNTIME: "false",
    YUVI_AUTOSTART_MEM0: "false",
    YUVI_AUTOSTART_TTS: "false",
    YUVI_AUTOSTART_LOCAL_STT: "false",
    RUST_BACKTRACE: "1"
  };
}

function stateRoot(roots) {
  return path.join(roots.xdgData, ...READY_MARKER_SEGMENTS.slice(0, 2));
}

function readyMarkerPath(roots) {
  return path.join(roots.xdgData, ...READY_MARKER_SEGMENTS);
}

function spawnApp(env, roots) {
  if (!fs.existsSync(BINARY)) {
    failPreflight(`desktop binary missing after build: ${BINARY}`);
  }
  const stdout = fs.openSync(path.join(roots.logs, "app-stdout.log"), "a");
  const stderr = fs.openSync(path.join(roots.logs, "app-stderr.log"), "a");
  appChild = spawn(BINARY, [], { cwd: REPO_ROOT, env, stdio: ["ignore", stdout, stderr] });
  info(`launched ${BINARY} (pid ${appChild.pid})`);
  return appChild;
}

function appExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForReadyMarker(roots, child, timeoutMs) {
  const markerPath = readyMarkerPath(roots);
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (appExited(child)) {
      fail(
        `desktop app exited before reaching the bootstrap barrier (exit=${child.exitCode} signal=${child.signalCode})`,
        readLogs(roots)
      );
    }
    try {
      if (fs.existsSync(markerPath)) {
        return JSON.parse(fs.readFileSync(markerPath, "utf8"));
      }
    } catch {
      // Marker may be mid-write; keep polling until the deadline.
    }
    sleep(POLL_INTERVAL_MS);
  }
  fail(
    `bootstrap marker did not appear within ${timeoutMs}ms at ${markerPath}`,
    readLogs(roots) + "\nstate root: " + safeListDir(stateRoot(roots))
  );
}

function readLogs(roots) {
  const parts = [];
  for (const name of ["app-stdout.log", "app-stderr.log"]) {
    try {
      const text = fs.readFileSync(path.join(roots.logs, name), "utf8");
      if (text.trim()) parts.push(`--- ${name} (tail) ---\n${text.slice(-4000)}`);
    } catch {
      // ignore
    }
  }
  return parts.join("\n") || "(no app output captured)";
}

function safeListDir(dir) {
  try {
    return fs.readdirSync(dir, { recursive: true }).join("\n");
  } catch {
    return "(state root not created)";
  }
}

function httpJson(url, { token } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      url,
      { headers: token ? { "X-Yuvi-Control-Token": token } : {}, timeout: 5_000 },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`HTTP ${response.statusCode} for ${url}`));
            return;
          }
          try {
            resolve(body ? JSON.parse(body) : {});
          } catch (error) {
            reject(new Error(`invalid JSON from ${url}: ${error.message}`));
          }
        });
      }
    );
    request.on("timeout", () => request.destroy(new Error(`timeout requesting ${url}`)));
    request.on("error", reject);
    request.end();
  });
}

function readActiveEndpoint(roots) {
  const pointerPath = path.join(stateRoot(roots), "active-instance.json");
  const pointer = JSON.parse(fs.readFileSync(pointerPath, "utf8"));
  const endpoint = JSON.parse(fs.readFileSync(pointer.endpointFile, "utf8"));
  return { pointer, endpoint, pointerPath };
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/**
 * PIDs of live processes whose environment mentions the isolated temp root.
 * Everything this smoke launched inherits that path, so this finds the whole
 * owned tree deterministically (and nothing else — the root is unique).
 */
function findProcessTreeByEnvironment() {
  const found = [];
  if (!tempRoot) return found;
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    let environ;
    try {
      environ = fs.readFileSync(`/proc/${entry}/environ`);
    } catch {
      continue; // Process vanished or is not ours.
    }
    if (environ.includes(Buffer.from(tempRoot))) found.push(pid);
  }
  return found;
}

async function waitForExit(child, waitMs) {
  if (appExited(child)) return;
  await new Promise((resolve) => {
    const timer = setTimeout(done, waitMs);
    function done() {
      clearTimeout(timer);
      child.off("exit", done);
      resolve();
    }
    child.once("exit", done);
  });
}

function cleanup() {
  if (cleanupDone) return;
  cleanupDone = true;
  // The app itself: escalate to SIGKILL; reaping uses the exit event because a
  // zombie child still answers kill(pid, 0).
  if (appChild && !appExited(appChild)) {
    try {
      appChild.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
  // Product shutdown on Linux may leave supervisor tree members behind
  // (lifecycle atom scope); the smoke guarantees no orphans regardless.
  for (const pid of findProcessTreeByEnvironment()) {
    if (appChild && pid === appChild.pid) continue; // handled below
    warn(
      `process ${pid} outlived the smoke session; terminating (Linux lifecycle evidence, see next atom)`
    );
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      continue;
    }
    const deadline = Date.now() + KILL_WAIT_MS;
    while (Date.now() < deadline && pidAlive(pid)) sleep(100);
    if (pidAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // ignore
      }
    }
  }
  if (appChild && !appExited(appChild)) {
    void waitForExit(appChild, KILL_WAIT_MS).then(() => {
      try {
        appChild.kill("SIGKILL");
      } catch {
        // ignore
      }
    });
  }
  if (tempRoot && fs.existsSync(tempRoot) && process.exitCode !== 1) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } else if (tempRoot) {
    info(`artifacts kept for inspection: ${tempRoot}`);
  }
}

async function main() {
  assertLinuxWithDisplay();

  runStep("frontend build", "pnpm", ["--filter", "@companion/web", "build"]);
  runStep("tauri rust build", "cargo", ["build"], { cwd: TAURI_DIR });

  const roots = makeIsolatedRoots();
  const child = spawnApp(smokeEnv(roots), roots);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(130);
  });

  const marker = waitForReadyMarker(roots, child, BOOTSTRAP_TIMEOUT_MS);
  if (marker.schemaVersion !== 1) fail(`unexpected marker schemaVersion: ${marker.schemaVersion}`);
  if (marker.tauriPid !== child.pid) {
    fail(`marker tauriPid ${marker.tauriPid} does not match launched pid ${child.pid}`);
  }
  if (!pidAlive(marker.supervisorPid)) {
    fail(`marker supervisorPid ${marker.supervisorPid} is not alive`);
  }
  info(
    `bootstrap barrier reached: supervisor pid ${marker.supervisorPid}, instance ${marker.instanceId}`
  );

  const { endpoint } = readActiveEndpoint(roots);
  if (endpoint.pid !== marker.supervisorPid || endpoint.instanceId !== marker.instanceId) {
    fail("active-instance pointer and readiness marker disagree about the supervisor instance");
  }
  if (!["127.0.0.1", "localhost", "::1"].includes(endpoint.host)) {
    fail(`supervisor endpoint host is not loopback: ${endpoint.host}`);
  }

  const health = await httpJson(`${endpoint.baseUrl}/health`);
  if (health.ok !== true)
    fail(`control plane /health returned unexpected payload: ${JSON.stringify(health)}`);

  // The status read uses the control token from the endpoint file. Tokens are
  // never printed; this smoke is the parent-side validator, same trust level
  // as the Tauri shell.
  const status = await httpJson(`${endpoint.baseUrl}/v1/status`, { token: endpoint.controlToken });
  const statusInstance = status.instanceId ?? status.instance_id;
  if (statusInstance !== marker.instanceId) {
    fail(
      `control plane status instanceId ${statusInstance} != marker instance ${marker.instanceId}`
    );
  }
  info(`control plane verified: /health ok, /v1/status acked for instance ${statusInstance}`);

  if (appExited(child))
    fail("desktop app exited after bootstrap although no shutdown was requested");

  // Ask the app to exit. Whatever the app's own shutdown manages to reap is
  // next-atom evidence; this smoke guarantees the tree is gone either way.
  info("requesting app shutdown (SIGTERM)");
  child.kill("SIGTERM");
  await waitForExit(child, APP_EXIT_TIMEOUT_MS);
  info(`app exited (exit=${child.exitCode} signal=${child.signalCode})`);

  cleanup();
  info("PASS: linux desktop build + bootstrap smoke");
  process.exit(0);
}

main().catch((error) => fail(`unexpected smoke failure: ${error?.stack ?? error}`));
