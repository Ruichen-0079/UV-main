/**
 * Linux KDE close/tray lifecycle validation (CachyOS + KDE Plasma + Wayland).
 *
 * Proves, on a real KDE Wayland session, the frozen window lifecycle contract:
 *   ordinary window Close  → CloseRequested is prevented, the window hides,
 *                            the app stays alive, the Runtime/Supervisor stay
 *                            healthy, and the tray remains usable;
 *   tray Quit              → the same graceful exit gate as SIGTERM:
 *                            app.exit(0) → ExitRequested → ShutdownGate →
 *                            Supervisor /v1/shutdown drain → app exits with
 *                            code 0 → zero owned descendants remain.
 *
 * This is NOT pixel automation. Every interaction rides the real platform
 * protocols a user interaction would produce:
 *   - window close: the KDE compositor itself (KWin scripting closeWindow →
 *     xdg_toplevel.close — the exact event the titlebar X button delivers);
 *   - tray menu: StatusNotifierItem + com.canonical.dbusmenu Event("clicked")
 *     — the exact DBus message the Plasma system tray sends on a click;
 *   - window visibility: KWin workspace.windowList() read back through the
 *     journald entry for that probe (hidden Wayland toplevels are unmapped
 *     and disappear from the list).
 *
 * The run is fully isolated (temp XDG/HOME/YUVI roots, no service autostart),
 * identical to desktop-smoke-linux. Leftover owned processes are found by
 * scanning /proc environ files for the unique temp root — never by name or
 * port. A PASS is only valid when the product shutdown reaped its own tree;
 * the emergency cleanup exists for failure autopsy only.
 *
 * Exit codes: 0 pass · 1 validation failure · 2 preflight failure.
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
const SNI_FIND_TIMEOUT_MS = 15_000;
const CLOSE_OBSERVE_TIMEOUT_MS = 10_000;
const APP_EXIT_TIMEOUT_MS = 15_000;
const OWNED_TREE_SETTLE_MS = 10_000;
const KILL_WAIT_MS = 5_000;
const POLL_INTERVAL_MS = 250;

const MAIN_WINDOW_CAPTION = "YUVI Chat";
const WEBUI_WINDOW_CAPTION = "YUVI WebUI";
const MENU_LABELS = ["Open YUVI", "Hide YUVI", "Open WebUI", "Hide WebUI", "Show Companion", "Hide Companion", "Quit"];

let tempRoot;
let appChild = null;
let cleanupDone = false;
let probeRunCounter = 0;

function failPreflight(message) {
  console.error(`[desktop-close-tray-linux] preflight failed: ${message}`);
  process.exit(2);
}

function fail(message, detail) {
  console.error(`[desktop-close-tray-linux] FAIL: ${message}`);
  if (detail) console.error(detail);
  // Mark failure BEFORE cleanup so artifacts are kept for inspection.
  if (process.exitCode === undefined) process.exitCode = 1;
  cleanup();
  process.exit(process.exitCode);
}

function info(message) {
  console.log(`[desktop-close-tray-linux] ${message}`);
}

function warn(message) {
  console.warn(`[desktop-close-tray-linux] WARN: ${message}`);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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

/* ---------------------------------------------------------------- session */

function sessionBusEnv() {
  const uid = process.getuid?.() ?? os.userInfo().uid;
  const env = { ...process.env };
  env.DBUS_SESSION_BUS_ADDRESS ??= `unix:path=/run/user/${uid}/bus`;
  env.XDG_RUNTIME_DIR ??= `/run/user/${uid}`;
  return env;
}

const BUS = sessionBusEnv();

function busCall(service, objectPath, iface, method, args, { timeoutMs = 10_000 } = {}) {
  const fullArgs = ["--user", "call", service, objectPath, iface, method, ...args];
  const result = spawnSync("busctl", fullArgs, {
    encoding: "utf8",
    env: BUS,
    timeout: timeoutMs
  });
  if (result.status !== 0 || result.error) {
    const reason = result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`;
    return { ok: false, error: reason };
  }
  return { ok: true, stdout: result.stdout.trim() };
}

function busCallJson(service, objectPath, iface, method, args) {
  const result = busCall(service, objectPath, iface, method, [...args, "--json=short"]);
  if (!result.ok) return result;
  try {
    return { ok: true, value: JSON.parse(result.stdout) };
  } catch (error) {
    return { ok: false, error: `busctl JSON parse failed: ${error.message}` };
  }
}

function assertLinuxKdeWayland() {
  if (process.platform !== "linux") {
    failPreflight(`this validation targets Linux (got ${process.platform})`);
  }
  const hasDisplay = Boolean(
    process.env.WAYLAND_DISPLAY ||
    process.env.DISPLAY ||
    /wayland|x11/i.test(process.env.XDG_SESSION_TYPE ?? "")
  );
  if (!hasDisplay) {
    failPreflight("no graphical session detected (WAYLAND_DISPLAY/DISPLAY unset)");
  }
  if (spawnSync("busctl", ["--version"], { encoding: "utf8" }).status !== 0) {
    failPreflight("busctl (systemd) is required to reach the session bus");
  }
  const kwin = busCall("org.kde.KWin", "/Scripting", "org.freedesktop.DBus.Peer", "Ping", []);
  if (!kwin.ok) {
    failPreflight("org.kde.KWin is not on the session bus — this validation requires a running KDE Plasma session");
  }
  const watcher = busCall(
    "org.kde.StatusNotifierWatcher",
    "/StatusNotifierWatcher",
    "org.freedesktop.DBus.Peer",
    "Ping",
    []
  );
  if (!watcher.ok) {
    failPreflight("org.kde.StatusNotifierWatcher is not on the session bus — Plasma system tray not available");
  }
}

/* ------------------------------------------------------------- test roots */

function makeIsolatedRoots() {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-close-tray-smoke-"));
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
    DBUS_SESSION_BUS_ADDRESS: BUS.DBUS_SESSION_BUS_ADDRESS,
    XDG_RUNTIME_DIR: BUS.XDG_RUNTIME_DIR,
    YUVI_SUPERVISOR_MODE: "development",
    HOME: roots.home,
    XDG_DATA_HOME: roots.xdgData,
    XDG_CONFIG_HOME: roots.xdgConfig,
    YUVI_DATA_ROOT: roots.data,
    YUVI_CACHE_ROOT: roots.cache,
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

/* ------------------------------------------------------- control plane io */

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
  return { pointer, endpoint };
}

async function assertSupervisorHealthy(roots, expectedInstance) {
  const { endpoint } = readActiveEndpoint(roots);
  const health = await httpJson(`${endpoint.baseUrl}/health`);
  if (health.ok !== true) {
    fail(`control plane /health failed after window close: ${JSON.stringify(health)}`, readLogs(roots));
  }
  const status = await httpJson(`${endpoint.baseUrl}/v1/status`, { token: endpoint.controlToken });
  const instance = status.instanceId ?? status.instance_id;
  if (expectedInstance && instance !== expectedInstance) {
    fail(`supervisor instance changed from ${expectedInstance} to ${instance} — the close path restarted something`, readLogs(roots));
  }
  if (status.shuttingDown === true || status.shutting_down === true) {
    fail("supervisor reports shuttingDown=true after an ordinary window close — the exit gate was claimed by the wrong path", readLogs(roots));
  }
  return { endpoint, status };
}

/* ------------------------------------------------------- tray (SNI/dbusmenu) */

/**
 * busctl --json wraps DBus variants as {"type":"v","data":<boxed>} chains
 * (e.g. the watcher's RegisteredStatusNotifierItems reply). Peel the layers
 * down to the plain payload.
 */
function unwrapDBusValue(value) {
  let v = value;
  while (v && typeof v === "object" && !Array.isArray(v) && "data" in v) {
    v = v.data;
    // A variant reply may box the payload as a single-element array.
    if (Array.isArray(v) && v.length === 1 && v[0] && typeof v[0] === "object" && "data" in v[0]) {
      v = v[0].data;
      break;
    }
  }
  return v;
}

async function waitForTrayMenu(appPid, timeoutMs) {
  const started = Date.now();
  let lastError = "not searched";
  while (Date.now() - started < timeoutMs) {
    const items = busCallJson(
      "org.kde.StatusNotifierWatcher",
      "/StatusNotifierWatcher",
      "org.freedesktop.DBus.Properties",
      "Get",
      ["ss", "org.kde.StatusNotifierWatcher", "RegisteredStatusNotifierItems"]
    );
    if (items.ok) {
      // Entries look like ":1.6299/org/ayatana/NotificationItem/<id>" — resolve
      // the owner pid of the unique bus name and match our spawned app.
      const registered = unwrapDBusValue(items.value) ?? [];
      if (!Array.isArray(registered) || registered.length === 0) {
        lastError = "watcher reports no registered items";
      }
      for (const entry of Array.isArray(registered) ? registered : []) {
        const slash = String(entry).indexOf("/");
        if (slash < 1) continue;
        const busName = String(entry).slice(0, slash);
        const itemPath = String(entry).slice(slash);
        const owner = busCall(
          "org.freedesktop.DBus",
          "/org/freedesktop/DBus",
          "org.freedesktop.DBus",
          "GetConnectionUnixProcessID",
          ["s", busName]
        );
        if (!owner.ok) {
          lastError = `owner lookup failed for ${busName}`;
          continue;
        }
        const ownerPid = Number.parseInt(owner.stdout.trim().split(/\s+/).pop(), 10);
        if (ownerPid !== appPid) continue;
        const menuProp = busCallJson(
          busName,
          itemPath,
          "org.freedesktop.DBus.Properties",
          "Get",
          ["ss", "org.kde.StatusNotifierItem", "Menu"]
        );
        if (!menuProp.ok) {
          lastError = `Menu property unreadable on ${busName}${itemPath}: ${menuProp.error}`;
          continue;
        }
        return { busName, itemPath, menuPath: unwrapDBusValue(menuProp.value) };
      }
    } else {
      lastError = items.error;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  fail(`no StatusNotifierItem owned by the app pid ${appPid} appeared within ${timeoutMs}ms (${lastError})`, readLogs(rootsRef));
}

/** Flatten a com.canonical.dbusmenu GetLayout JSON reply into label→id pairs. */
function menuItemsFromLayout(json) {
  const items = [];
  // A layout node is [id, {label: {data}}, [child…]]; busctl wraps children
  // as {"type":"(ia{sv}av)","data":<node>}.
  const visit = (node) => {
    const [id, properties, children] = node;
    const label = properties?.label?.data;
    if (typeof label === "string" && id !== 0) items.push({ id, label });
    for (const child of children ?? []) visit(child.data ?? child);
  };
  visit(json.value.data[1]);
  return items;
}

function getTrayMenuItems(tray) {
  const layout = busCallJson(
    tray.busName,
    tray.menuPath,
    "com.canonical.dbusmenu",
    "GetLayout",
    ["iias", 0, 6, 1, "label"]
  );
  if (!layout.ok) {
    return { ok: false, error: layout.error };
  }
  return { ok: true, items: menuItemsFromLayout(layout) };
}

function clickTrayMenuItem(tray, itemId) {
  // Event("clicked") on the dbusmenu item is exactly what the Plasma system
  // tray applet sends when a user activates a menu entry.
  const result = busCall(
    tray.busName,
    tray.menuPath,
    "com.canonical.dbusmenu",
    "Event",
    ["isvu", String(itemId), "clicked", "i", "0", "0"],
    { timeoutMs: 5_000 }
  );
  return result;
}

/* ----------------------------------------------------- KWin window probes */

/**
 * KWin scripts report back through the journal (print() lands in the
 * kwin_wayland unit). Each probe uses a unique tag so concurrent journal
 * noise cannot be mistaken for this run's output.
 */
function journalTag(prefix) {
  return `${prefix}-${process.pid}-${probeRunCounter++}`;
}

function readJournalFor(tag, sinceSeconds) {
  const result = spawnSync(
    "journalctl",
    ["--user", "_COMM=kwin_wayland", "--since", `-${sinceSeconds}s`, "--output=cat", "--no-pager"],
    { encoding: "utf8", env: BUS, timeout: 10_000 }
  );
  if (result.status !== 0) {
    return { ok: false, error: result.stderr?.trim() || `journalctl exit ${result.status}` };
  }
  const lines = (result.stdout ?? "")
    .split("\n")
    .filter((line) => line.includes(tag));
  return { ok: true, lines };
}

function kwinRunScript(name, body) {
  const scriptPath = path.join(tempRoot, `${name}.js`);
  fs.writeFileSync(scriptPath, body);
  const loaded = busCall(
    "org.kde.KWin",
    "/Scripting",
    "org.kde.kwin.Scripting",
    "loadScript",
    ["ss", scriptPath, name]
  );
  if (!loaded.ok) {
    fail(`KWin loadScript failed: ${loaded.error}`, readLogs(rootsRef));
  }
  const started = busCall(
    "org.kde.KWin",
    "/Scripting",
    "org.kde.kwin.Scripting",
    "start",
    []
  );
  if (!started.ok) {
    fail(`KWin script start failed: ${started.error}`, readLogs(rootsRef));
  }
  const unloaded = busCall(
    "org.kde.KWin",
    "/Scripting",
    "org.kde.kwin.Scripting",
    "unloadScript",
    ["s", name]
  );
  if (!unloaded.ok) {
    warn(`KWin unloadScript failed for ${name}: ${unloaded.error}`);
  }
}

/** Probe KWin for the app's windows. Resolves with the captions currently mapped. */
function kwinWindowCaptions(appPid, timeoutMs) {
  const tag = journalTag("YUVI-WIN-PROBE");
  kwinRunScript("yuvi-close-tray-probe", [
    "const wins = workspace.windowList();",
    `for (const w of wins) { if (w.pid === ${appPid}) print("${tag} caption=" + w.caption); }`,
    `print("${tag} DONE");`
  ].join("\n"));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const journal = readJournalFor(tag, Math.max(8, Math.ceil((Date.now() - (deadline - timeoutMs)) / 1000) + 5));
    if (journal.ok && journal.lines.some((line) => line.includes(`${tag} DONE`))) {
      return journal.lines
        .filter((line) => line.includes("caption="))
        .map((line) => line.split("caption=")[1].trim());
    }
    sleep(POLL_INTERVAL_MS);
  }
  fail(`KWin window probe did not report back within ${timeoutMs}ms (journal read-back broken?)`, readLogs(rootsRef));
}

/** Close one window of the app through the compositor (same event as the X button). */
function kwinCloseWindow(appPid, caption, timeoutMs) {
  const tag = journalTag("YUVI-CLOSE-PROBE");
  kwinRunScript("yuvi-close-tray-close", [
    "const wins = workspace.windowList();",
    `for (const w of wins) {`,
    `  if (w.pid === ${appPid} && w.caption === ${JSON.stringify(caption)} && !w.deleted) {`,
    "    w.closeWindow();",
    `    print("${tag} CLOSED");`,
    "    break;",
    "  }",
    "}",
    `print("${tag} DONE");`
  ].join("\n"));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const journal = readJournalFor(tag, 10);
    if (journal.ok && journal.lines.some((line) => line.includes(`${tag} DONE`))) {
      if (!journal.lines.some((line) => line.includes(`${tag} CLOSED`))) {
        fail(`KWin did not find the "${caption}" window of pid ${appPid} to close`, readLogs(rootsRef));
      }
      return;
    }
    sleep(POLL_INTERVAL_MS);
  }
  fail(`KWin close script did not report back within ${timeoutMs}ms`, readLogs(rootsRef));
}

function waitForWindowCaption(child, caption, expectedVisible, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (appExited(child)) {
      fail(`desktop app exited while waiting for ${description}`, readLogs(rootsRef));
    }
    const remainingMs = Math.max(POLL_INTERVAL_MS, deadline - Date.now());
    const visible = kwinWindowCaptions(child.pid, remainingMs).includes(caption);
    if (visible === expectedVisible) return;
    sleep(POLL_INTERVAL_MS);
  }
  fail(
    `${description} did not reach expected visibility=${expectedVisible} within ${timeoutMs}ms`,
    readLogs(rootsRef)
  );
}

/* ------------------------------------------------------ owned-tree sweeps */

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
 * Everything this validation launched inherits that path, so this finds the
 * whole owned tree deterministically (and nothing else — the root is unique).
 */
function findProcessTreeByEnvironment() {
  const found = [];
  if (!tempRoot) return found;
  const needle = Buffer.from(tempRoot);
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
    if (environ.includes(needle)) found.push(pid);
  }
  return found;
}

async function waitForOwnedTreeEmpty(waitMs) {
  const deadline = Date.now() + waitMs;
  let leftovers = findProcessTreeByEnvironment();
  while (leftovers.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    leftovers = findProcessTreeByEnvironment();
  }
  return leftovers;
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

/**
 * Failure-path autopsy only: terminate every leftover owned by this run.
 * Never called on the pass path — a PASS must come from the product's own
 * owner lifecycle, and each forced kill below is reported as a WARN.
 */
function cleanup() {
  if (cleanupDone) return;
  cleanupDone = true;
  if (appChild && !appExited(appChild)) {
    try {
      appChild.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
  for (const pid of findProcessTreeByEnvironment()) {
    if (appChild && pid === appChild.pid) continue;
    warn(`process ${pid} outlived the validation session; terminating (failure autopsy)`);
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
  removeArtifacts();
}

function removeArtifacts() {
  if (tempRoot && fs.existsSync(tempRoot) && process.exitCode !== 1) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } else if (tempRoot) {
    info(`artifacts kept for inspection: ${tempRoot}`);
  }
}

/* ------------------------------------------------------------------ phases */

// Set once main() reaches the isolated-launch phase; failure paths below use
// it for log/artifact context.
let rootsRef = null;

async function main() {
  assertLinuxKdeWayland();

  runStep("frontend build", "pnpm", ["--filter", "@companion/web", "build"]);
  runStep("tauri rust build", "cargo", ["build"], { cwd: TAURI_DIR });

  rootsRef = makeIsolatedRoots();
  const roots = rootsRef;
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
  const instanceId = marker.instanceId;
  info(`bootstrap barrier reached: supervisor pid ${marker.supervisorPid}, instance ${instanceId}`);

  const tray = await waitForTrayMenu(child.pid, SNI_FIND_TIMEOUT_MS);
  const menu = getTrayMenuItems(tray);
  if (!menu.ok) fail(`tray menu unreadable: ${menu.error}`, readLogs(roots));
  const labels = menu.items.map((item) => item.label).sort();
  if (JSON.stringify(labels) !== JSON.stringify([...MENU_LABELS].sort())) {
    fail(`tray menu does not match the contract: got [${labels.join(", ")}]`);
  }
  info(`tray present and usable: SNI at ${tray.itemPath}, menu items [${menu.items.map((i) => i.label).join(", ")}]`);
  const idByLabel = Object.fromEntries(menu.items.map((item) => [item.label, item.id]));

  /* --------------------------------------------- WebUI surface: lazy + tray */
  const captionsBeforeWebui = kwinWindowCaptions(child.pid, CLOSE_OBSERVE_TIMEOUT_MS);
  if (captionsBeforeWebui.includes(WEBUI_WINDOW_CAPTION)) {
    fail(`WebUI window "${WEBUI_WINDOW_CAPTION}" was created before its first tray request`, readLogs(roots));
  }
  info(`opening WebUI through the tray ("${WEBUI_WINDOW_CAPTION}")`);
  const openedWebui = clickTrayMenuItem(tray, idByLabel["Open WebUI"]);
  if (!openedWebui.ok) fail(`tray "Open WebUI" click failed: ${openedWebui.error}`, readLogs(roots));
  waitForWindowCaption(child, WEBUI_WINDOW_CAPTION, true, CLOSE_OBSERVE_TIMEOUT_MS, "tray Open WebUI");

  const hiddenWebui = clickTrayMenuItem(tray, idByLabel["Hide WebUI"]);
  if (!hiddenWebui.ok) fail(`tray "Hide WebUI" click failed: ${hiddenWebui.error}`, readLogs(roots));
  waitForWindowCaption(child, WEBUI_WINDOW_CAPTION, false, CLOSE_OBSERVE_TIMEOUT_MS, "tray Hide WebUI");
  info("WebUI tray show/hide mapped and unmapped the existing dashboard route");

  // Re-open it to prove the lazy window is reusable, then exercise the same
  // compositor close contract as Main and Companion.
  const reopenedWebui = clickTrayMenuItem(tray, idByLabel["Open WebUI"]);
  if (!reopenedWebui.ok) fail(`tray second "Open WebUI" click failed: ${reopenedWebui.error}`, readLogs(roots));
  waitForWindowCaption(child, WEBUI_WINDOW_CAPTION, true, CLOSE_OBSERVE_TIMEOUT_MS, "second tray Open WebUI");
  const reusedCaptions = kwinWindowCaptions(child.pid, CLOSE_OBSERVE_TIMEOUT_MS);
  if (reusedCaptions.filter((caption) => caption === WEBUI_WINDOW_CAPTION).length !== 1) {
    fail(`repeated WebUI show created duplicate windows: ${reusedCaptions.join(", ")}`, readLogs(roots));
  }
  info(`closing WebUI through the compositor ("${WEBUI_WINDOW_CAPTION}")`);
  kwinCloseWindow(child.pid, WEBUI_WINDOW_CAPTION, CLOSE_OBSERVE_TIMEOUT_MS);
  waitForWindowCaption(child, WEBUI_WINDOW_CAPTION, false, CLOSE_OBSERVE_TIMEOUT_MS, "WebUI close-as-hide");
  await assertSupervisorHealthy(roots, instanceId);
  info("WebUI close handled as hide: app alive and Supervisor healthy");

  const captionsBefore = kwinWindowCaptions(child.pid, CLOSE_OBSERVE_TIMEOUT_MS);
  if (!captionsBefore.includes(MAIN_WINDOW_CAPTION)) {
    fail(
      `main window "${MAIN_WINDOW_CAPTION}" is not mapped in the KDE session before the close phase (got: ${captionsBefore.join(", ") || "none"})`,
      readLogs(roots)
    );
  }

  /* ---------------------------------------------------- phase 1: close ≠ quit */
  info(`closing the main window through the compositor ("${MAIN_WINDOW_CAPTION}")`);
  kwinCloseWindow(child.pid, MAIN_WINDOW_CAPTION, CLOSE_OBSERVE_TIMEOUT_MS);

  // Give the Tauri CloseRequested handler (prevent_close + hide) time to run.
  const closeDeadline = Date.now() + CLOSE_OBSERVE_TIMEOUT_MS;
  let hidden = false;
  while (Date.now() < closeDeadline) {
    if (appExited(child)) {
      fail("desktop app EXITED after an ordinary window close — close leaked into the exit path", readLogs(roots));
    }
    if (!kwinWindowCaptions(child.pid, CLOSE_OBSERVE_TIMEOUT_MS).includes(MAIN_WINDOW_CAPTION)) {
      hidden = true;
      break;
    }
    sleep(POLL_INTERVAL_MS);
  }
  if (!hidden) fail(`main window "${MAIN_WINDOW_CAPTION}" is still mapped after the compositor close — close was not handled as hide`, readLogs(roots));
  if (appExited(child)) fail("desktop app exited while observing the close phase", readLogs(roots));
  if (!fs.existsSync(readyMarkerPath(roots))) {
    fail("bootstrap-ready marker disappeared after an ordinary window close — the shutdown gate ran", readLogs(roots));
  }
  await assertSupervisorHealthy(roots, instanceId);
  info("close handled as hide: window unmapped, app alive, supervisor healthy, exit gate untouched");

  // The tray must still be usable while the app lives only in the tray.
  const menuAfterClose = getTrayMenuItems(tray);
  if (!menuAfterClose.ok) {
    fail(`tray menu unreadable after window close: ${menuAfterClose.error}`, readLogs(roots));
  }
  info("tray menu still answers GetLayout after the close — tray remains usable");

  // Behavioral check that the tray still controls the app while hidden:
  // re-open the main window through the tray, then hide it again.
  const reopened = clickTrayMenuItem(tray, idByLabel["Open YUVI"]);
  if (!reopened.ok) fail(`tray "Open YUVI" click failed: ${reopened.error}`, readLogs(roots));
  const reopenDeadline = Date.now() + CLOSE_OBSERVE_TIMEOUT_MS;
  let visibleAgain = false;
  while (Date.now() < reopenDeadline) {
    if (appExited(child)) fail("desktop app exited after tray Open YUVI", readLogs(roots));
    if (kwinWindowCaptions(child.pid, CLOSE_OBSERVE_TIMEOUT_MS).includes(MAIN_WINDOW_CAPTION)) {
      visibleAgain = true;
      break;
    }
    sleep(POLL_INTERVAL_MS);
  }
  if (!visibleAgain) fail(`tray "Open YUVI" did not re-map the main window`, readLogs(roots));
  const hiddenAgain = clickTrayMenuItem(tray, idByLabel["Hide YUVI"]);
  if (!hiddenAgain.ok) fail(`tray "Hide YUVI" click failed: ${hiddenAgain.error}`, readLogs(roots));
  const hideDeadline = Date.now() + CLOSE_OBSERVE_TIMEOUT_MS;
  let hiddenByTray = false;
  while (Date.now() < hideDeadline) {
    if (!kwinWindowCaptions(child.pid, CLOSE_OBSERVE_TIMEOUT_MS).includes(MAIN_WINDOW_CAPTION)) {
      hiddenByTray = true;
      break;
    }
    sleep(POLL_INTERVAL_MS);
  }
  if (!hiddenByTray) fail(`tray "Hide YUVI" did not hide the main window`, readLogs(roots));
  info("tray controls the app while windowless: Open YUVI re-mapped, Hide YUVI re-hid the main window");

  /* ------------------------------------------------------- phase 2: tray Quit */
  info("clicking tray Quit (com.canonical.dbusmenu Event, same message Plasma sends)");
  const quit = clickTrayMenuItem(tray, idByLabel["Quit"]);
  if (!quit.ok) fail(`tray Quit click failed: ${quit.error}`, readLogs(roots));

  // Repeated-quit probe: a second Quit must be harmless. If the app already
  // tore the menu down, the DBus error below is the harmless outcome; if it
  // was delivered, the ShutdownGate claim-once makes it a no-op (unit-tested).
  const repeat = clickTrayMenuItem(tray, idByLabel["Quit"]);
  if (repeat.ok) {
    info("repeated Quit was delivered and must be absorbed by the shutdown gate");
  } else {
    info(`repeated Quit found the menu already gone (harmless): ${repeat.error}`);
  }

  await waitForExit(child, APP_EXIT_TIMEOUT_MS);
  if (!appExited(child)) {
    fail(
      `desktop app did not exit within ${APP_EXIT_TIMEOUT_MS}ms of tray Quit`,
      readLogs(roots)
    );
  }
  if (child.exitCode !== 0 || child.signalCode !== null) {
    fail(
      `tray Quit ended the app abnormally (exit=${child.exitCode} signal=${child.signalCode}) — not the graceful exit(0) path`,
      readLogs(roots)
    );
  }
  info(`app exited gracefully from tray Quit (exit code ${child.exitCode})`);

  // The product cleanup removes its own state files as part of shutdown.
  if (fs.existsSync(path.join(stateRoot(roots), "active-instance.json"))) {
    fail("active-instance.json survived the shutdown — the supervisor drain did not complete", readLogs(roots));
  }

  // A PASS must come from the product's own owner lifecycle; emergency
  // cleanup is reserved for failure autopsy and must not create this PASS.
  const leftoverPids = await waitForOwnedTreeEmpty(OWNED_TREE_SETTLE_MS);
  if (leftoverPids.length > 0) {
    fail(
      `tray Quit left ${leftoverPids.length} owned process(es) behind (pids: ${leftoverPids.join(", ")}) — supervisor ownership broken`,
      readLogs(roots)
    );
  }

  info("owner lifecycle verified: graceful exit(0), state cleaned, zero owned descendants");
  removeArtifacts();
  info("PASS: KDE Wayland close≠quit + tray Quit graceful shutdown validation");
  process.exit(0);
}

main().catch((error) => fail(`unexpected validation failure: ${error?.stack ?? error}`));
