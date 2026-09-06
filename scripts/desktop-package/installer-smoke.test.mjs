import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertCleanupTarget,
  assertInstallPathSafe,
  assertNoSecrets,
  assertNoUnsafeCommandLine,
  assertToolsUnresolvable,
  assertTempRoot,
  assertTauriAppSmokeAllowed,
  allocateDistinctPorts,
  attributeWindowsListener,
  buildWmCloseArguments,
  buildWmCloseScript,
  buildTrayQuitArguments,
  buildTrayQuitScript,
  shouldRetryTrayQuit,
  TRAY_QUIT_MAX_ATTEMPTS,
  TRAY_QUIT_ATTEMPT_BUDGET_MS,
  chooseInstaller,
  compareSnapshots,
  createTauriAppEnv,
  createRequestDiagnostics,
  createTauriFailureSnapshot,
  createTauriTimeline,
  createDiagnosticPortRoles,
  createOwnershipDiagnostics,
  FORBIDDEN_PATH_TOOLS,
  formatOwnershipDiagnostic,
  formatMem0ProvenanceDiagnostic,
  formatRuntimeHealthProtocolDiagnostic,
  formatTauriFailureDiagnostic,
  evaluateMem0Provenance,
  evaluateRuntimeHealthProtocol,
  evaluateRuntimeProvenance,
  formatRuntimeProvenanceDiagnostic,
  findInstalledApplicationExecutable,
  findInstallerCandidates,
  findUninstaller,
  findUniqueSupervisorExecutable,
  isWithin,
  isWindowsPathInside,
  normalizeWindowsPathForComparison,
  normalizeWindowsProcessPath,
  parseRuntimeCommandLine,
  parseWmCloseOutput,
  pathsEqualWindows,
  processBaseline,
  requestJson,
  parseEmbeddedSupervisorBuildInfo,
  removeTreeWithRetries,
  restrictedPath,
  restrictedWindowsPath,
  resolveWmClosePythonExecutable,
  readOwnershipMetadataDiagnostic,
  resolveExistingWindowsPathForComparison,
  sanitizeChildEnv,
  snapshotTree,
  assertSupervisorProvenance,
  powershellDiagnosticPath,
  runWmCloseHelper,
  TAURI_MAIN_WINDOW_TITLE,
  TRAY_ICON_WINDOW_CLASS,
  TRAY_MENU_OBJID_CLIENT,
  TRAY_MENU_WINDOW_CLASS,
  TRAY_NOTIFY_MESSAGE_ID,
  TRAY_QUIT_MENU_TEXT,
  TRAY_QUIT_SEMANTIC_ID,
  TRAY_QUIT_PYTHON_SOURCE,
  parseTrayQuitOutput,
  WM_CLOSE_PYTHON_SOURCE,
  waitForSpecificPidsExit,
  waitForTauriBootstrapReady,
  windowsProcessPathInside,
  validateInstalledResources,
  validatePackagingInfo,
  validateSupervisorProvenance
} from "./installer-smoke.mjs";

const temp = (prefix = "yuvi-installer-test-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const syntheticExistingResolver = (value) =>
  resolveExistingWindowsPathForComparison(value, { realpathSyncNative: (input) => input });
const mappedExistingResolver = (map) => (value) =>
  resolveExistingWindowsPathForComparison(value, {
    realpathSyncNative: (input) => {
      if (map.has(input)) return map.get(input);
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }
  });

function fakeHttpRequest({ responseBody = null, statusCode = 200, requestError = null } = {}) {
  let responseCallback;
  const listeners = new Map();
  let calls = 0;
  let factoryCalls = 0;
  const optionsSeen = [];
  const request = {
    once(event, handler) {
      listeners.set(event, handler);
      return this;
    },
    write() {
      return true;
    },
    end() {
      calls += 1;
      queueMicrotask(() => {
        listeners.get("socket")?.({ connecting: false });
        if (requestError) {
          listeners.get("error")?.(requestError);
          return;
        }
        const responseListeners = new Map();
        const response = {
          statusCode,
          setEncoding() {},
          on(event, handler) {
            responseListeners.set(event, handler);
            return this;
          },
          once(event, handler) {
            responseListeners.set(event, handler);
            return this;
          }
        };
        responseCallback(response);
        if (responseBody !== null) responseListeners.get("data")?.(responseBody);
        responseListeners.get("end")?.();
      });
      return this;
    }
  };
  return {
    factory(options, callback) {
      factoryCalls += 1;
      optionsSeen.push(options);
      responseCallback = callback;
      return request;
    },
    calls() {
      return calls;
    },
    factoryCalls() {
      return factoryCalls;
    },
    optionsSeen() {
      return optionsSeen;
    }
  };
}

function runtimeHealthBody({
  ok = true,
  service = "ai-companion-runtime",
  runtimeMode = "development",
  server = { status: "healthy" },
  database = { status: "healthy" },
  chat = {
    provider: "deepseek",
    name: "deepseek",
    configured: true,
    available: true,
    status: "degraded"
  }
} = {}) {
  return {
    ok,
    service,
    runtimeMode,
    server,
    database,
    providers: { chat }
  };
}

test("Runtime health protocol accepts ready and clean-install degraded chat states", () => {
  const ready = evaluateRuntimeHealthProtocol({
    status: 200,
    value: runtimeHealthBody()
  });
  assert.equal(ready.protocolValid, true);
  assert.equal(ready.expectedOk, true);
  assert.equal(ready.chatAvailable, true);

  const cleanInstall = evaluateRuntimeHealthProtocol({
    status: 200,
    value: runtimeHealthBody({
      ok: false,
      chat: {
        provider: "deepseek",
        name: "deepseek",
        configured: false,
        available: false,
        status: "unavailable"
      }
    })
  });
  assert.equal(cleanInstall.protocolValid, true);
  assert.equal(cleanInstall.expectedOk, false);
  assert.equal(cleanInstall.healthOk, false);
  assert.equal(cleanInstall.chatAvailable, false);
});

test("Runtime health protocol rejects unhealthy, malformed, and inconsistent payloads", () => {
  const cases = [
    ["database unhealthy", { database: { status: "unhealthy" }, ok: false }],
    ["database unavailable with chat available", { database: { status: "unavailable" }, ok: false }],
    ["ok true while chat unavailable", { ok: true, chat: { available: false } }],
    ["ok false while chat available", { ok: false }],
    ["HTTP 500", { status: 500, value: runtimeHealthBody() }],
    ["HTTP 404", { status: 404, value: runtimeHealthBody() }],
    ["missing body", { status: 200, value: null }],
    ["array body", { status: 200, value: [] }],
    ["string body", { status: 200, value: "healthy" }],
    ["missing ok", { status: 200, value: (() => { const body = runtimeHealthBody(); delete body.ok; return body; })() }],
    ["non-boolean ok", { status: 200, value: runtimeHealthBody({ ok: "true" }) }],
    ["wrong service", { status: 200, value: runtimeHealthBody({ service: "other-service" }) }],
    ["missing server", { status: 200, value: runtimeHealthBody({ server: null }) }],
    ["unhealthy server", { status: 200, value: runtimeHealthBody({ server: { status: "starting" } }) }],
    ["missing database", { status: 200, value: runtimeHealthBody({ database: null, ok: false }) }],
    ["missing database status", { status: 200, value: runtimeHealthBody({ database: {}, ok: false }) }],
    ["missing providers chat", { status: 200, value: { ...runtimeHealthBody(), ok: false, providers: {} } }],
    ["non-boolean chat available", { status: 200, value: runtimeHealthBody({ ok: false, chat: { available: "false" } }) }]
  ];
  for (const [label, input] of cases) {
    assert.equal(evaluateRuntimeHealthProtocol(input).protocolValid, false, label);
  }
});

test("Runtime health diagnostics expose only safe protocol fields", () => {
  const result = evaluateRuntimeHealthProtocol({
    status: 200,
    value: runtimeHealthBody({
      ok: false,
      chat: { provider: "deepseek", configured: false, available: false, status: "unavailable" }
    })
  });
  const text = formatRuntimeHealthProtocolDiagnostic(result);
  assert.match(text, /RUNTIME HEALTH PROTOCOL/);
  assert.match(text, /service: ai-companion-runtime/);
  assert.match(text, /chat available: no/);
  assert.match(text, /protocol valid: yes/);
  assert.doesNotMatch(text, /DEEPSEEK_API_KEY|Authorization|DATABASE_URL|token|secret/i);
});

test("Tauri Runtime smoke uses the structured health protocol helper", () => {
  const source = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "installer-smoke.mjs"),
    "utf8"
  );
  assert.doesNotMatch(source, /runtimeHealth\.value\?\.ok\s*!==\s*true/);
  assert.doesNotMatch(source, /if\s*\(runtimeHealth\.status\s*!==\s*200\s*\)/);
  assert.ok((source.match(/evaluateRuntimeHealthProtocol\(/g) ?? []).length >= 2);
});

test("Tauri request diagnostics preserve ECONNRESET and never retry", async () => {
  const reset = Object.assign(new Error("read ECONNRESET"), {
    name: "Error",
    code: "ECONNRESET",
    errno: -4077,
    syscall: "read"
  });
  const fake = fakeHttpRequest({ requestError: reset });
  const diagnostics = createRequestDiagnostics({ now: () => 1_000 });
  await assert.rejects(
    requestJson("http://127.0.0.1:6121/v1/status?token=secret-value", {
      method: "GET",
      token: "secret-value",
      label: "supervisor.status",
      diagnostics,
      requestFactory: fake.factory
    }),
    (error) => error === reset
  );
  assert.equal(fake.calls(), 1);
  const formatted = diagnostics.format();
  assert.match(formatted, /supervisor\.status GET 127\.0\.0\.1:6121\/v1\/status/);
  assert.match(formatted, /errorCode=ECONNRESET/);
  assert.match(formatted, /syscall=read/);
  assert.doesNotMatch(formatted, /secret-value/);
  assert.equal(diagnostics.lastFailure().phase, "connected");
  assert.equal(fake.optionsSeen()[0].agent, false);
});

test("Tauri request diagnostics keep successful request count and hide query secrets", async () => {
  const fake = fakeHttpRequest({ responseBody: JSON.stringify({ ok: true }) });
  const diagnostics = createRequestDiagnostics({ now: () => 2_000 });
  const result = await requestJson(
    "http://127.0.0.1:6121/health?api_key=query-secret",
    { label: "supervisor.health", diagnostics, requestFactory: fake.factory }
  );
  assert.equal(result.status, 200);
  assert.deepEqual(result.value, { ok: true });
  assert.equal(fake.calls(), 1);
  const formatted = diagnostics.format({ includeSuccess: true });
  assert.match(formatted, /supervisor\.health GET 127\.0\.0\.1:6121\/health/);
  assert.doesNotMatch(formatted, /query-secret/);
  assert.doesNotMatch(formatted, /api_key/);
  assert.equal(fake.optionsSeen()[0].agent, false);
});

test("requestJson isolates sequential requests and does not use globalAgent", async () => {
  const fake = fakeHttpRequest({ responseBody: JSON.stringify({ ok: true }) });
  const first = await requestJson("http://127.0.0.1:6121/health", {
    label: "supervisor.health",
    requestFactory: fake.factory
  });
  const second = await requestJson("http://127.0.0.1:6121/v1/status", {
    label: "supervisor.status",
    requestFactory: fake.factory
  });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(fake.factoryCalls(), 2);
  assert.equal(fake.calls(), 2);
  assert.deepEqual(fake.optionsSeen().map((options) => options.agent), [false, false]);
  assert.notEqual(fake.optionsSeen()[0].agent, http.globalAgent);
});

test("Tauri failure timeline is bounded and retains deterministic order", () => {
  let now = 10_000;
  const timeline = createTauriTimeline(() => (now += 1), 3);
  timeline.mark("E0");
  timeline.mark("E1");
  timeline.mark("E2");
  timeline.mark("E3");
  assert.deepEqual(timeline.snapshot().map((event) => event.phase), ["E0", "E1", "E2"]);
  assert.equal(timeline.droppedCount(), 1);
});

test("Tauri failure snapshot is injectable and preserves ECONNRESET as primary", () => {
  const listenerProbe = (port) => ({
    state: "Listen",
    owningPid: port + 1,
    parentProcessId: 900,
    processName: "node.exe",
    executablePath: "C:\\smoke\\install\\runtime\\node.exe",
    creationDate: "2026-08-10T00:00:00Z",
    pidEqualsSupervisorPid: port === 6121,
    pidEqualsKnownManagedPid: port !== 6121
  });
  const snapshot = createTauriFailureSnapshot({
    appPid: 100,
    supervisorPid: 900,
    runtime: { pid: 901, url: "http://127.0.0.1:6122" },
    mem0: { pid: 902, url: "http://127.0.0.1:6123" },
    endpoint: { baseUrl: "http://127.0.0.1:6121" },
    installRoot: "C:\\smoke\\install",
    pidProbe: (pid) => pid !== 902,
    listenerProbe,
    now: () => Date.parse("2026-08-10T00:00:00Z")
  });
  assert.equal(snapshot.processes.app.status, "alive");
  assert.equal(snapshot.processes.mem0.status, "exited");
  assert.equal(snapshot.listeners.supervisor.owningPid, 6122);

  const timeoutSnapshot = createTauriFailureSnapshot({
    appPid: 100,
    supervisorPid: 900,
    endpoint: { baseUrl: "http://127.0.0.1:6121" },
    installRoot: "C:\\smoke\\install",
    pidProbe: () => true,
    listenerProbe: () => {
      const error = new Error("query timeout");
      error.code = "ETIMEDOUT";
      throw error;
    },
    now: () => Date.parse("2026-08-10T00:00:00Z")
  });
  const primary = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  const text = formatTauriFailureDiagnostic({
    primaryError: primary,
    requestDiagnostics: { format: () => "  http-1 supervisor.status GET 127.0.0.1:6121/v1/status errorCode=ECONNRESET", lastFailure: () => ({ errorName: "Error", errorCode: "ECONNRESET" }) },
    timeline: { snapshot: () => [{ phase: "E7-before-http-request", isoTime: "now", relativeMs: 1 }, { phase: "E8-http-error", isoTime: "now", relativeMs: 2 }] },
    snapshot: timeoutSnapshot,
    processQueries: [{
      role: "runtime.command-line",
      pid: 901,
      startedAt: "2026-08-10T00:00:01.000Z",
      endedAt: "2026-08-10T00:00:03.500Z",
      elapsedMs: 2500,
      outcome: "query-timeout",
      errorCode: "ETIMEDOUT"
    }]
  });
  assert.match(text, /primaryCode: ECONNRESET/);
  assert.match(text, /snapshot: query-timeout/);
  assert.match(text, /E7-before-http-request[\s\S]*E8-http-error/);
  assert.match(text, /runtime\.command-line: pid=901[\s\S]*query-timeout/);
  assert.doesNotMatch(text, /CommandLine|Authorization|token|api_key/i);
});

test("installer candidate discovery filters the expected x64 NSIS name", () => {
  const dir = temp();
  fs.writeFileSync(path.join(dir, "YUVI Companion_0.1.0_x64-setup.exe"), "x");
  fs.writeFileSync(path.join(dir, "YUVI Companion_0.1.0_x64-setup.msi"), "x");
  assert.equal(findInstallerCandidates(dir).length, 1);
});

test("newest installer is selected by mtime", () => {
  const dir = temp();
  const oldPath = path.join(dir, "YUVI Companion_0.1.0_x64-setup.exe");
  const newPath = path.join(dir, "YUVI Companion_0.2.0_x64-setup.exe");
  fs.writeFileSync(oldPath, "old");
  fs.writeFileSync(newPath, "new");
  const old = new Date(Date.now() - 10_000);
  fs.utimesSync(oldPath, old, old);
  const selected = chooseInstaller({ nsisDir: dir });
  assert.equal(selected.selected.path, newPath);
});

test("no installer candidates fail clearly", () => {
  assert.throws(() => chooseInstaller({ nsisDir: temp() }), /no NSIS installer/);
});

test("non-exe explicit installer is rejected", () => {
  const file = path.join(temp(), "YUVI Companion_0.1.0_x64-setup.msi");
  fs.writeFileSync(file, "x");
  assert.throws(() => chooseInstaller({ explicitPath: file }), /filename/);
});

test("explicit installer may be outside the default bundle directory", () => {
  const file = path.join(temp(), "YUVI Companion_0.1.0_x64-setup.exe");
  fs.writeFileSync(file, "x");
  assert.equal(chooseInstaller({ explicitPath: file }).selected.path, file);
});

test("default installer selection is contained by the target bundle", () => {
  const dir = temp();
  const file = path.join(dir, "YUVI Companion_0.1.0_x64-setup.exe");
  fs.writeFileSync(file, "x");
  assert.ok(isWithin(findInstallerCandidates(dir)[0].path, dir));
});

test("TEMP smoke root containment is enforced", () => {
  const root = temp("yuvi-installer-smoke-");
  assert.equal(assertTempRoot(root), root);
  assert.throws(() => assertTempRoot(path.join(os.tmpdir(), "not-yuvi")), /unsafe/);
});

test("install path cannot be the smoke root or repository", () => {
  const root = temp("yuvi-installer-smoke-");
  assert.throws(() => assertInstallPathSafe(root, root), /outside/);
  assert.throws(
    () => assertInstallPathSafe(path.join(root, "repo"), root, { repoRoot: root }),
    /repository/
  );
});

test("install path cannot be Program Files", () => {
  const root = temp("yuvi-installer-smoke-");
  const previous = process.env.ProgramFiles;
  process.env.ProgramFiles = root;
  try {
    assert.throws(() => assertInstallPathSafe(path.join(root, "install"), root), /Program/);
  } finally {
    if (previous === undefined) delete process.env.ProgramFiles;
    else process.env.ProgramFiles = previous;
  }
});

test("install path cannot be real LOCALAPPDATA YUVI", () => {
  const root = temp("yuvi-installer-smoke-");
  const local = path.join(root, "real-local");
  assert.throws(
    () =>
      assertInstallPathSafe(path.join(root, "YUVI", "install"), root, {
        localAppData: root,
        repoRoot: local
      }),
    /LOCALAPPDATA/
  );
});

test("packaging-info fixed schema and relative fields validate", () => {
  const info = validatePackagingInfo({
    schemaVersion: 1,
    platform: "win32",
    arch: "x64",
    supervisorMode: "pkg-exe",
    hasSupervisorExe: true,
    supervisorBuildInfo: "supervisor/supervisor-build-info.json",
    hasMem0: true,
    mem0ProtocolVersion: 1,
    hasLocalStt: true,
    localSttProtocolVersion: 1,
    runtimeEntry: "runtime/yuvi-runtime-server.mjs",
    nodeExecutable: "runtime/node.exe",
    mem0Executable: "mem0/yuvi-mem0.exe",
    mem0Manifest: "mem0/mem0-manifest.json",
    localSttExecutable: "local-stt/yuvi-local-stt.exe",
    localSttManifest: "local-stt/local-stt-manifest.json",
    localSttModelManifest: "local-stt/models.manifest.json"
  });
  assert.equal(info.hasMem0, true);
});

test("packaging-info rejects absolute executable paths", () => {
  assert.throws(
    () =>
      validatePackagingInfo({
        schemaVersion: 1,
        platform: "win32",
        arch: "x64",
        supervisorMode: "pkg-exe",
        hasSupervisorExe: true,
        supervisorBuildInfo: "supervisor/supervisor-build-info.json",
        hasMem0: true,
        mem0ProtocolVersion: 1,
        hasLocalStt: true,
        localSttProtocolVersion: 1,
        runtimeEntry: "C:\\repo\\runtime.mjs",
        nodeExecutable: "runtime/node.exe",
        mem0Executable: "mem0/yuvi-mem0.exe",
        mem0Manifest: "mem0/mem0-manifest.json",
        localSttExecutable: "local-stt/yuvi-local-stt.exe",
        localSttManifest: "local-stt/local-stt-manifest.json",
        localSttModelManifest: "local-stt/models.manifest.json"
      }),
    /absolute/
  );
});

const validSupervisorProvenance = () => ({
  schemaVersion: 1,
  mode: "pkg-exe",
  checkoutSha: "a".repeat(40),
  sourceFingerprint: "b".repeat(64),
  bundleSha256: "c".repeat(64),
  bundleInputSha256: "d".repeat(64),
  executableSha256: "e".repeat(64),
  stagedExecutableSha256: "e".repeat(64),
  stagedBundleSha256: "d".repeat(64),
  entry: "yuvi-desktop-supervisor.packaged.cjs",
  bundleRelativePath: "supervisor/yuvi-desktop-supervisor.cjs",
  executableRelativePath: "supervisor/yuvi-desktop-supervisor.exe",
  pkgTarget: "node20-win-x64",
  platform: "win32",
  arch: "x64"
});

test("Supervisor provenance and embedded identity require matching immutable fields", () => {
  const provenance = validSupervisorProvenance();
  assert.equal(validateSupervisorProvenance(provenance), provenance);
  const embedded = {
    schemaVersion: 1,
    mode: "pkg-exe",
    checkoutSha: provenance.checkoutSha,
    sourceFingerprint: provenance.sourceFingerprint,
    bundleSha256: provenance.bundleSha256,
    entry: provenance.entry
  };
  assert.equal(
    assertSupervisorProvenance({
      provenance,
      embedded,
      installedExecutableSha256: provenance.executableSha256,
      installedBundleSha256: provenance.bundleInputSha256
    }),
    true
  );
  assert.throws(
    () => assertSupervisorProvenance({
      provenance,
      embedded: { ...embedded, checkoutSha: "f".repeat(40) },
      installedExecutableSha256: provenance.executableSha256,
      installedBundleSha256: provenance.bundleInputSha256
    }),
    /identity mismatch/
  );
  assert.throws(
    () => validateSupervisorProvenance({ ...provenance, executableRelativePath: "C:\\bad.exe" }),
    /absolute/
  );
});

test("Supervisor embedded build-info is exactly one JSON line", () => {
  const provenance = validSupervisorProvenance();
  const embedded = {
    schemaVersion: 1,
    mode: "pkg-exe",
    checkoutSha: provenance.checkoutSha,
    sourceFingerprint: provenance.sourceFingerprint,
    bundleSha256: provenance.bundleSha256,
    entry: provenance.entry
  };
  assert.deepEqual(parseEmbeddedSupervisorBuildInfo(`${JSON.stringify(embedded)}\n`, "", 0), embedded);
  assert.throws(
    () => parseEmbeddedSupervisorBuildInfo(`${JSON.stringify(embedded)}\n{}\n`, "", 0),
    /exactly one/
  );
});

test("Supervisor resource must contain exactly one executable", () => {
  const root = temp();
  const supervisor = path.join(root, "supervisor");
  fs.mkdirSync(path.join(supervisor, "nested"), { recursive: true });
  fs.writeFileSync(path.join(supervisor, "yuvi-desktop-supervisor.exe"), "one");
  assert.equal(findUniqueSupervisorExecutable(supervisor), path.join(supervisor, "yuvi-desktop-supervisor.exe"));
  fs.writeFileSync(path.join(supervisor, "nested", "yuvi-desktop-supervisor.exe"), "two");
  assert.throws(() => findUniqueSupervisorExecutable(supervisor), /exactly one/);
});

test("packaging-info rejects missing Mem0 declaration", () => {
  assert.throws(
    () =>
      validatePackagingInfo({ schemaVersion: 1, platform: "win32", arch: "x64", hasMem0: false }),
    /Mem0/
  );
});

const windowsEntries = (value) => value.split(path.win32.delimiter);

test("forbidden PATH tools keep the Python launcher and developer tools", () => {
  assert.deepEqual(FORBIDDEN_PATH_TOOLS, [
    "python",
    "python3",
    "py",
    "pip",
    "uv",
    "node",
    "pnpm",
    "tsx"
  ]);
  assert.equal(FORBIDDEN_PATH_TOOLS.includes("py"), true);
});

test("restricted Windows PATH contains only explicit SystemRoot children", () => {
  const value = restrictedWindowsPath({ SystemRoot: "C:\\Windows", PATH: "C:\\tools" });
  const entries = windowsEntries(value);
  assert.deepEqual(entries, [
    "C:\\Windows\\System32",
    "C:\\Windows\\System32\\Wbem",
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0"
  ]);
  assert.equal(entries.includes("C:\\Windows"), false);
  for (const entry of entries) {
    assert.equal(entry.toLowerCase().startsWith("c:\\windows\\"), true);
    assert.equal(entry.toLowerCase().includes("node_modules"), false);
    assert.equal(entry.toLowerCase().includes("python"), false);
    assert.equal(entry.toLowerCase().includes("toolcache"), false);
  }
});

test("restricted Windows PATH order is stable and does not inherit caller PATH", () => {
  const env = {
    SystemRoot: "D:\\Windows",
    PATH: "D:\\tools;C:\\Program Files\\nodejs;C:\\Python"
  };
  assert.equal(restrictedWindowsPath(env), restrictedWindowsPath(env));
  assert.deepEqual(windowsEntries(restrictedWindowsPath(env)), [
    "D:\\Windows\\System32",
    "D:\\Windows\\System32\\Wbem",
    "D:\\Windows\\System32\\WindowsPowerShell\\v1.0"
  ]);
});

test("restricted Windows PATH uses WINDIR and C:\\Windows fallbacks", () => {
  assert.equal(
    windowsEntries(restrictedWindowsPath({ WINDIR: "E:\\Win" }))[0],
    "E:\\Win\\System32"
  );
  assert.equal(windowsEntries(restrictedWindowsPath({}))[0], "C:\\Windows\\System32");
});

test("System32 remains available for where.exe while py stays unavailable", () => {
  const calls = [];
  const env = { PATH: restrictedWindowsPath({ SystemRoot: "C:\\Windows" }) };
  const lookup = (file, args, options) => {
    calls.push({ file, tool: args[0], path: options.env.PATH });
    if (args[0] === "py" && windowsEntries(options.env.PATH).includes("C:\\Windows"))
      return "C:\\Windows\\py.exe";
    throw new Error("not found");
  };

  assert.doesNotThrow(() => assertToolsUnresolvable(env, { execFile: lookup, platform: "win32" }));
  assert.equal(calls.length, FORBIDDEN_PATH_TOOLS.length);
  assert.equal(
    calls.every((call) => call.file === "where.exe"),
    true
  );
  assert.equal(
    calls.every((call) => call.path.includes("C:\\Windows\\System32")),
    true
  );

  const legacyPath = { PATH: ["C:\\Windows", env.PATH].join(path.win32.delimiter) };
  assert.throws(
    () => assertToolsUnresolvable(legacyPath, { execFile: lookup, platform: "win32" }),
    /restricted PATH resolved: py/
  );
});

test("restrictedPath keeps the non-Windows test fallback", () => {
  const value = restrictedPath().toLowerCase();
  assert.equal(value.includes("node_modules"), false);
  assert.equal(value.includes("pnpm"), false);
});

test("child environment removes secrets and developer tool variables", () => {
  const env = sanitizeChildEnv({ MEM0_LLM_API_KEY: "should-not-survive", NODE_PATH: "bad" });
  for (const key of ["MEM0_LLM_API_KEY", "DATABASE_URL", "NODE_PATH", "PYTHONPATH", "PNPM_HOME"])
    assert.equal(env[key], undefined);
});

test("secret values are rejected without echoing the value", () => {
  const secret = "never-print-this-secret";
  assert.throws(
    () => assertNoSecrets({ MEM0_LLM_API_KEY: secret }, "env"),
    (error) => !String(error).includes(secret)
  );
});

test("Supervisor argv/source command-line paths are checked", () => {
  assert.throws(
    () => assertNoUnsafeCommandLine("python services\\memory-mem0\\run.py"),
    /source\/tool/
  );
  assert.doesNotThrow(() => assertNoUnsafeCommandLine("C:\\Temp\\resources\\mem0\\yuvi-mem0.exe"));
});

test("process baseline preserves existing PIDs", () => {
  const before = processBaseline([{ pid: 100, name: "yuvi-mem0.exe" }]);
  assert.equal(before.has(100), true);
  assert.equal(before.has(101), false);
});

test("resource snapshot detects modifications, additions and removals", () => {
  const root = temp();
  fs.writeFileSync(path.join(root, "same.txt"), "same");
  fs.writeFileSync(path.join(root, "changed.txt"), "before");
  const before = snapshotTree(root);
  fs.writeFileSync(path.join(root, "changed.txt"), "after");
  fs.rmSync(path.join(root, "same.txt"));
  fs.writeFileSync(path.join(root, "added.txt"), "new");
  const changes = compareSnapshots(before, snapshotTree(root));
  assert.deepEqual(changes.map((change) => change.type).sort(), ["added", "changed", "removed"]);
});

test("resource snapshot is empty for a missing tree", () => {
  assert.equal(snapshotTree(path.join(temp(), "missing")).size, 0);
});

test("cleanup guard accepts only the smoke root", () => {
  const root = temp("yuvi-installer-smoke-");
  assert.equal(assertCleanupTarget(root), root);
  assert.throws(() => assertCleanupTarget(os.tmpdir()), /unsafe/);
});

test("smoke allocates distinct Supervisor and Mem0 ports", async () => {
  const supplied = [6131, 6131, 6242];
  const ports = await allocateDistinctPorts({ free: async () => supplied.shift() });
  assert.deepEqual(ports, { mem0Port: 6131, supervisorPort: 6242 });
});

test("smoke fails closed when distinct ports cannot be allocated", async () => {
  await assert.rejects(
    allocateDistinctPorts({ free: async () => 6131, maxAttempts: 2 }),
    /unable to allocate distinct smoke ports/
  );
});

test("diagnostic port roles keep Mem0, requested control, and actual Supervisor endpoint explicit", () => {
  const roles = createDiagnosticPortRoles({
    mem0ServicePort: 6131,
    supervisorRequestedControlPort: 6242
  });
  assert.deepEqual(roles, {
    mem0ServicePort: 6131,
    supervisorPublicStatusPort: null,
    supervisorControlPort: null,
    supervisorRequestedControlPort: 6242
  });
});

test("Windows listener attribution uses an absolute PowerShell path and no CommandLine query", () => {
  let invoked = null;
  const attributed = attributeWindowsListener(6131, {
    platform: "win32",
    systemRoot: "C:\\Windows",
    installRoot: "C:\\Temp\\install",
    supervisorPid: 100,
    knownManagedPid: 200,
    execFile: (file, args) => {
      invoked = { file, args };
      return JSON.stringify({
        state: "Listen",
        owningPid: 200,
        processName: "yuvi-mem0.exe",
        parentProcessId: 100,
        executablePath: "C:\\Temp\\install\\resources\\mem0\\yuvi-mem0.exe",
        creationDate: "2026-08-05T10:00:00.000Z"
      });
    }
  });
  assert.equal(invoked.file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.doesNotMatch(invoked.args.at(-1), /CommandLine/);
  assert.equal(attributed.owningPid, 200);
  assert.equal(attributed.parentProcessId, 100);
  assert.equal(attributed.executableInsideInstallRoot, true);
  assert.equal(attributed.pidEqualsSupervisorPid, false);
  assert.equal(attributed.pidEqualsKnownManagedPid, true);
});

test("listener attribution fails closed without changing the query conclusion", () => {
  const result = attributeWindowsListener(6131, {
    platform: "win32",
    execFile: () => {
      throw Object.assign(new Error("query unavailable"), { code: "ENOEXEC" });
    }
  });
  assert.equal(result.querySucceeded, false);
  assert.equal(result.queryErrorCode, "ENOEXEC");
  assert.equal(result.state, "query-failed");
});

test("Mem0 provenance accepts long actual and short expected filesystem aliases", () => {
  const root = "C:\\Users\\runneradmin\\Temp\\install";
  const shortRoot = "C:\\Users\\RUNNER~1\\Temp\\install";
  const actual = `${root}\\mem0\\yuvi-mem0.exe`;
  const expected = `${shortRoot}\\mem0\\yuvi-mem0.exe`;
  const result = evaluateMem0Provenance({
    imagePath: actual,
    expectedExecutablePath: expected,
    installRoot: shortRoot,
    resolveExistingPath: mappedExistingResolver(new Map([
      [root, root],
      [shortRoot, root],
      [actual, actual],
      [expected, actual]
    ]))
  });
  assert.equal(result.ok, true);
  assert.equal(result.imageMatchesExpected, true);
  assert.equal(result.imageInsideInstallRoot, true);
});

test("Mem0 provenance accepts short actual and long expected filesystem aliases", () => {
  const root = "C:\\Users\\runneradmin\\Temp\\install";
  const shortRoot = "C:\\Users\\RUNNER~1\\Temp\\install";
  const actual = `${shortRoot}\\mem0\\yuvi-mem0.exe`;
  const expected = `${root}\\mem0\\yuvi-mem0.exe`;
  const result = evaluateMem0Provenance({
    imagePath: actual,
    expectedExecutablePath: expected,
    installRoot: root,
    resolveExistingPath: mappedExistingResolver(new Map([
      [root, root],
      [shortRoot, root],
      [actual, expected],
      [expected, expected]
    ]))
  });
  assert.equal(result.ok, true);
  assert.equal(result.resolvedImagePath, result.resolvedExpectedPath);
});

test("Mem0 provenance accepts extended actual and normal expected paths", () => {
  const root = "C:\\Temp\\install";
  const actual = `\\\\?\\${root}\\mem0\\yuvi-mem0.exe`;
  const expected = `${root}\\mem0\\yuvi-mem0.exe`;
  const result = evaluateMem0Provenance({
    imagePath: actual,
    expectedExecutablePath: expected,
    installRoot: `\\\\?\\${root}`,
    resolveExistingPath: syntheticExistingResolver
  });
  assert.equal(result.ok, true);
  assert.equal(result.imageInsideInstallRoot, true);
});

test("Mem0 provenance rejects system and unrelated TEMP executables", () => {
  const root = "C:\\Users\\runneradmin\\Temp\\install";
  const expected = `${root}\\mem0\\yuvi-mem0.exe`;
  for (const imagePath of [
    "C:\\Program Files\\YUVI\\yuvi-mem0.exe",
    "C:\\Users\\runneradmin\\Temp\\other-install\\mem0\\yuvi-mem0.exe",
    "C:\\Dev\\UV-main\\build\\desktop\\win32-x64\\mem0\\yuvi-mem0.exe"
  ]) {
    const result = evaluateMem0Provenance({
      imagePath,
      expectedExecutablePath: expected,
      installRoot: root,
      resolveExistingPath: syntheticExistingResolver
    });
    assert.equal(result.ok, false);
    assert.equal(result.imageMatchesExpected, false);
    assert.equal(result.imageInsideInstallRoot, false);
  }
});

test("Mem0 provenance fails closed for resolver errors and unavailable images", () => {
  const root = "C:\\Users\\RUNNER~1\\Temp\\install";
  const expected = `${root}\\mem0\\yuvi-mem0.exe`;
  const actual = "C:\\Users\\runneradmin\\Temp\\install\\mem0\\yuvi-mem0.exe";
  const actualError = evaluateMem0Provenance({
    imagePath: actual,
    expectedExecutablePath: expected,
    installRoot: root,
    resolveExistingPath: mappedExistingResolver(new Map([
      [root, "C:\\Users\\runneradmin\\Temp\\install"],
      [expected, actual]
    ]))
  });
  assert.equal(actualError.ok, false);
  assert.match(actualError.failureReasons.join(";"), /authoritative Mem0 image filesystem resolution failed/);
  const expectedError = evaluateMem0Provenance({
    imagePath: actual,
    expectedExecutablePath: expected,
    installRoot: root,
    resolveExistingPath: mappedExistingResolver(new Map([
      [root, root],
      [actual, actual]
    ]))
  });
  assert.equal(expectedError.ok, false);
  assert.match(expectedError.failureReasons.join(";"), /installed Mem0 executable filesystem resolution failed/);
  const unavailable = evaluateMem0Provenance({
    imagePath: "",
    expectedExecutablePath: expected,
    installRoot: root,
    resolveExistingPath: syntheticExistingResolver
  });
  assert.equal(unavailable.ok, false);
  assert.match(unavailable.failureReasons.join(";"), /authoritative Mem0 image path unavailable/);
});

test("Mem0 provenance rejects an outside resolved root even when image paths match", () => {
  const root = "C:\\Users\\runneradmin\\Temp\\install";
  const outside = "C:\\Users\\runneradmin\\Temp\\other\\mem0\\yuvi-mem0.exe";
  const result = evaluateMem0Provenance({
    imagePath: outside,
    expectedExecutablePath: outside,
    installRoot: root,
    resolveExistingPath: syntheticExistingResolver
  });
  assert.equal(result.imageMatchesExpected, true);
  assert.equal(result.imageInsideInstallRoot, false);
  assert.equal(result.ok, false);
});

test("Mem0 command line is not an executable identity gate", () => {
  const root = "C:\\Temp\\install";
  const image = `${root}\\mem0\\yuvi-mem0.exe`;
  const result = evaluateMem0Provenance({
    imagePath: image,
    expectedExecutablePath: image,
    installRoot: root,
    resolveExistingPath: syntheticExistingResolver
  });
  assert.equal(result.ok, true);
  assert.doesNotThrow(() => assertNoUnsafeCommandLine("unexpected-safe-argument"));
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "installer-smoke.mjs"), "utf8");
  assert.doesNotMatch(source, /commandLine\.toLowerCase\(\)[\s\S]{0,160}includes\(expectedMem0\)/);
  assert.ok((source.match(/evaluateMem0Provenance\(/g) ?? []).length >= 2);
});

test("Mem0 provenance diagnostic omits command lines and secrets", () => {
  const root = "C:\\Temp\\install";
  const text = formatMem0ProvenanceDiagnostic({
    stage: "TAURI",
    installRoot: root,
    pid: 42,
    parentPid: 41,
    supervisorPid: 41,
    ownership: "owned",
    metadataInstanceMatch: true,
    provenance: evaluateMem0Provenance({
      imagePath: `${root}\\mem0\\yuvi-mem0.exe`,
      expectedExecutablePath: `${root}\\mem0\\yuvi-mem0.exe`,
      installRoot: root,
      resolveExistingPath: syntheticExistingResolver
    })
  });
  assert.match(text, /MEM0 PROVENANCE/);
  assert.match(text, /image match: yes/);
  assert.match(text, /child of Supervisor: yes/);
  assert.doesNotMatch(text, /CommandLine|Authorization|token|DATABASE_URL|api_key/i);
});

test("Runtime provenance accepts bundled image with basename or absolute argv0", () => {
  const root = "C:\\Temp\\install\\generated\\win32-x64";
  const node = `${root}\\runtime\\node.exe`;
  const entry = `${root}\\runtime\\yuvi-runtime-server.mjs`;
  for (const commandLine of [
    `node.exe "${entry}"`,
    `"${node}" "${entry}"`
  ]) {
    const result = evaluateRuntimeProvenance({
      imagePath: `\\\\?\\${node}`,
      commandLine,
      expectedBundledNodePath: node,
      expectedEntrypointPath: entry,
      installRoot: root,
      resolveExistingPath: syntheticExistingResolver
    });
    assert.equal(result.ok, true);
    assert.equal(result.imageMatchesExpected, true);
    assert.equal(result.entrypointMatchesExpected, true);
  }
});

test("Runtime provenance rejects system or outside Node images", () => {
  const root = "C:\\Temp\\install\\generated\\win32-x64";
  const node = `${root}\\runtime\\node.exe`;
  const entry = `${root}\\runtime\\yuvi-runtime-server.mjs`;
  for (const imagePath of ["C:\\Program Files\\nodejs\\node.exe", "D:\\other\\node.exe"]) {
    const result = evaluateRuntimeProvenance({
      imagePath,
      commandLine: `node.exe "${entry}"`,
      expectedBundledNodePath: node,
      expectedEntrypointPath: entry,
      installRoot: root,
      resolveExistingPath: syntheticExistingResolver
    });
    assert.equal(result.ok, false);
    assert.equal(result.imageMatchesExpected, false);
  }
});

test("Runtime provenance fails closed when authoritative image is unavailable", () => {
  const root = "C:\\Temp\\install\\generated\\win32-x64";
  const entry = `${root}\\runtime\\yuvi-runtime-server.mjs`;
  const result = evaluateRuntimeProvenance({
    imagePath: "",
    commandLine: `node.exe "${entry}"`,
    expectedBundledNodePath: `${root}\\runtime\\node.exe`,
    expectedEntrypointPath: entry,
    installRoot: root,
    resolveExistingPath: syntheticExistingResolver
  });
  assert.equal(result.ok, false);
  assert.equal(result.imageMatchesExpected, false);
  assert.match(result.failureReasons.join(";"), /authoritative image path unavailable/);
});

test("Runtime provenance independently validates the installed entrypoint", () => {
  const root = "C:\\Temp\\install\\generated\\win32-x64";
  const node = `${root}\\runtime\\node.exe`;
  const expected = `${root}\\runtime\\yuvi-runtime-server.mjs`;
  for (const entry of [
    "C:\\repo\\yuvi-runtime-server.mjs",
    "C:\\Temp\\other\\yuvi-runtime-server.mjs"
  ]) {
    const result = evaluateRuntimeProvenance({
      imagePath: node,
      commandLine: `node.exe "${entry}"`,
      expectedBundledNodePath: node,
      expectedEntrypointPath: expected,
      installRoot: root,
      resolveExistingPath: syntheticExistingResolver
    });
    assert.equal(result.imageMatchesExpected, true);
    assert.equal(result.entrypointMatchesExpected, false);
    assert.equal(result.ok, false);
  }
});

test("Runtime provenance does not trust processName or basename alone", () => {
  const root = "C:\\Temp\\install\\generated\\win32-x64";
  const result = evaluateRuntimeProvenance({
    imagePath: null,
    commandLine: "node.exe yuvi-runtime-server.mjs",
    expectedBundledNodePath: `${root}\\runtime\\node.exe`,
    expectedEntrypointPath: `${root}\\runtime\\yuvi-runtime-server.mjs`,
    installRoot: root,
    resolveExistingPath: syntheticExistingResolver
  });
  assert.equal(result.ok, false);
  assert.equal(result.executableToken, "node.exe");
});

test("Runtime provenance diagnostic omits full command lines and secrets", () => {
  const root = "C:\\Temp\\install\\generated\\win32-x64";
  const text = formatRuntimeProvenanceDiagnostic({
    stage: "TAURI",
    installRoot: root,
    supervisorPid: 22,
    runtimeParentPid: 22,
    ownership: "owned",
    metadataPid: 33,
    metadataInstanceMatch: true,
    provenance: {
      pid: 33,
      processName: "node.exe",
      authoritativeImagePath: `${root}\\runtime\\node.exe`,
      expectedBundledNodePath: `${root}\\runtime\\node.exe`,
      imageMatchesExpected: true,
      imageInsideInstallRoot: true,
      executableToken: "node.exe",
      entrypointPath: `${root}\\runtime\\yuvi-runtime-server.mjs`,
      expectedEntrypointPath: `${root}\\runtime\\yuvi-runtime-server.mjs`,
      entrypointMatchesExpected: true,
      entrypointInsideInstallRoot: true
    }
  });
  assert.doesNotMatch(text, /DATABASE_URL|API_KEY|Authorization|fullCommandLine/i);
  assert.doesNotMatch(text, /runtime\\node\.exe.*yuvi-runtime-server\.mjs/);
});

test("Windows comparison canonicalizer handles drive extended paths, case, separators, and components", () => {
  const normal = "C:\\Temp\\YUVI\\runtime\\node.exe";
  const extended = "\\\\?\\C:\\Temp\\YUVI\\runtime\\node.exe";
  assert.equal(pathsEqualWindows(extended, normal), true);
  assert.equal(pathsEqualWindows(normal, extended), true);
  assert.equal(
    pathsEqualWindows(
      "\\\\?\\c:/TEMP/YUVI/./runtime/child/../node.exe",
      "C:\\temp\\yuvi\\runtime\\node.exe"
    ),
    true
  );
  assert.equal(
    normalizeWindowsPathForComparison("C:\\"),
    "c:\\"
  );
  assert.equal(pathsEqualWindows("C:\\Temp\\YUVI\\", "c:/temp/yuvi"), true);
  assert.equal(normalizeWindowsPathForComparison("node.exe"), "");
  assert.equal(normalizeWindowsProcessPath(extended), "c:\\temp\\yuvi\\runtime\\node.exe");
  assert.equal(windowsProcessPathInside(extended, "C:\\Temp\\YUVI"), true);
});

test("lexical canonicalization never invents 8.3 short-name equivalence", () => {
  const longPath = "C:\\Users\\runneradmin\\Temp\\install\\runtime\\node.exe";
  const shortPath = "C:\\Users\\RUNNER~1\\Temp\\install\\runtime\\node.exe";
  assert.notEqual(normalizeWindowsPathForComparison(longPath), normalizeWindowsPathForComparison(shortPath));
  assert.equal(pathsEqualWindows(longPath, shortPath), false);
});

test("filesystem path resolver collapses injected short and long aliases", () => {
  const longPath = "C:\\Users\\runneradmin\\Temp\\install\\runtime\\node.exe";
  const shortPath = "C:\\Users\\RUNNER~1\\Temp\\install\\runtime\\node.exe";
  const resolved = (input) => (input === shortPath ? longPath : input);
  const shortResult = resolveExistingWindowsPathForComparison(shortPath, { realpathSyncNative: resolved });
  const longResult = resolveExistingWindowsPathForComparison(longPath, { realpathSyncNative: resolved });
  assert.equal(shortResult.ok, true);
  assert.equal(longResult.ok, true);
  assert.equal(shortResult.resolvedPath, longResult.resolvedPath);
});

test("Runtime provenance accepts short-vs-long filesystem identity for image and entrypoint", () => {
  const root = "C:\\Users\\runneradmin\\Temp\\install\\generated\\win32-x64";
  const shortRoot = "C:\\Users\\RUNNER~1\\Temp\\install\\generated\\win32-x64";
  const longNode = `${root}\\runtime\\node.exe`;
  const shortNode = `${shortRoot}\\runtime\\node.exe`;
  const longEntry = `${root}\\runtime\\yuvi-runtime-server.mjs`;
  const shortEntry = `${shortRoot}\\runtime\\yuvi-runtime-server.mjs`;
  const resolveMap = new Map([
    [shortRoot, root],
    [root, root],
    [shortNode, longNode],
    [longNode, longNode],
    [shortEntry, longEntry],
    [longEntry, longEntry]
  ]);
  const result = evaluateRuntimeProvenance({
    imagePath: shortNode,
    commandLine: `node.exe "${shortEntry}"`,
    expectedBundledNodePath: longNode,
    expectedEntrypointPath: longEntry,
    installRoot: root,
    resolveExistingPath: (value) =>
      resolveExistingWindowsPathForComparison(value, {
        realpathSyncNative: (input) => resolveMap.get(input) ?? (() => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); })()
      })
  });
  assert.equal(result.ok, true);
  assert.equal(result.imageMatchesExpected, true);
  assert.equal(result.entrypointMatchesExpected, true);
  assert.equal(result.imageInsideInstallRoot, true);
  assert.equal(result.entrypointInsideInstallRoot, true);
});

test("filesystem-resolved provenance rejects a different real target and short sibling", () => {
  const root = "C:\\Users\\runneradmin\\Temp\\install\\generated\\win32-x64";
  const expectedNode = `${root}\\runtime\\node.exe`;
  const expectedEntry = `${root}\\runtime\\yuvi-runtime-server.mjs`;
  const shortSiblingNode = "C:\\Users\\RUNNER~2\\Temp\\install\\generated\\win32-x64\\runtime\\node.exe";
  const resolveMap = new Map([
    [root, root],
    [expectedNode, expectedNode],
    [expectedEntry, expectedEntry],
    [shortSiblingNode, "C:\\Users\\other\\Temp\\runtime\\node.exe"]
  ]);
  const resolveExisting = (value) =>
    resolveExistingWindowsPathForComparison(value, {
      realpathSyncNative: (input) => resolveMap.get(input) ?? (() => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); })()
    });
  const result = evaluateRuntimeProvenance({
    imagePath: shortSiblingNode,
    commandLine: `node.exe "${expectedEntry}"`,
    expectedBundledNodePath: expectedNode,
    expectedEntrypointPath: expectedEntry,
    installRoot: root,
    resolveExistingPath: resolveExisting
  });
  assert.equal(result.ok, false);
  assert.equal(result.imageMatchesExpected, false);
  assert.equal(result.imageInsideInstallRoot, false);
  assert.match(result.failureReasons.join(";"), /Runtime image does not match/);
});

test("filesystem-resolved containment accepts an alias inside root and rejects an outside alias", () => {
  const root = "C:\\Users\\runneradmin\\Temp\\install";
  const shortRoot = "C:\\Users\\RUNNER~1\\Temp\\install";
  const insideShort = `${shortRoot}\\runtime\\node.exe`;
  const outsideShort = `${shortRoot}\\runtime\\junction\\node.exe`;
  const insideLong = `${root}\\runtime\\node.exe`;
  const entryLong = `${root}\\runtime\\yuvi-runtime-server.mjs`;
  const outsideLong = "C:\\Users\\runneradmin\\Temp\\outside\\node.exe";
  const resolveMap = new Map([
    [root, root],
    [shortRoot, root],
    [insideShort, insideLong],
    [insideLong, insideLong],
    [entryLong, entryLong],
    [outsideShort, outsideLong],
    [outsideLong, outsideLong]
  ]);
  const resolveExisting = (value) =>
    resolveExistingWindowsPathForComparison(value, {
      realpathSyncNative: (input) => resolveMap.get(input) ?? (() => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); })()
    });
  const inside = evaluateRuntimeProvenance({
    imagePath: insideShort,
    commandLine: `node.exe "${entryLong}"`,
    expectedBundledNodePath: insideLong,
    expectedEntrypointPath: entryLong,
    installRoot: shortRoot,
    resolveExistingPath: resolveExisting
  });
  const outside = evaluateRuntimeProvenance({
    imagePath: outsideShort,
    commandLine: `node.exe "${entryLong}"`,
    expectedBundledNodePath: insideLong,
    expectedEntrypointPath: entryLong,
    installRoot: root,
    resolveExistingPath: resolveExisting
  });
  assert.equal(inside.imageInsideInstallRoot, true);
  assert.equal(inside.entrypointMatchesExpected, true);
  assert.equal(outside.imageInsideInstallRoot, false);
  assert.equal(outside.ok, false);
});

test("filesystem resolver errors fail closed without lexical fallback", () => {
  const value = "C:\\Users\\RUNNER~1\\Temp\\missing\\runtime\\node.exe";
  const result = evaluateRuntimeProvenance({
    imagePath: value,
    commandLine: `node.exe "${value}"`,
    expectedBundledNodePath: value,
    expectedEntrypointPath: value,
    installRoot: "C:\\Users\\RUNNER~1\\Temp\\missing",
    resolveExistingPath: () => ({
      ok: false,
      rawPath: value,
      lexicalPath: normalizeWindowsPathForComparison(value),
      resolvedPath: null,
      errorCode: "ENOENT"
    })
  });
  assert.equal(result.ok, false);
  assert.equal(result.imageMatchesExpected, false);
  assert.match(result.failureReasons.join(";"), /filesystem resolution failed/);
});

test("existing extended drive and UNC forms remain compatible with injected resolution", () => {
  const root = "C:\\Temp\\YUVI\\install";
  const node = `${root}\\runtime\\node.exe`;
  const entry = `${root}\\runtime\\yuvi-runtime-server.mjs`;
  const result = evaluateRuntimeProvenance({
    imagePath: `\\\\?\\${node}`,
    commandLine: `node.exe "\\\\?\\${entry}"`,
    expectedBundledNodePath: node,
    expectedEntrypointPath: entry,
    installRoot: `\\\\?\\${root}`,
    resolveExistingPath: syntheticExistingResolver
  });
  assert.equal(result.ok, true);
  assert.equal(result.imageInsideInstallRoot, true);
});

test("Windows comparison canonicalizer preserves UNC semantics", () => {
  const normal = "\\\\server\\share\\foo\\bar.exe";
  const extended = "\\\\?\\UNC\\server\\share\\foo\\bar.exe";
  assert.equal(pathsEqualWindows(extended, normal), true);
  assert.equal(
    normalizeWindowsPathForComparison("\\\\?\\UNC\\SERVER\\SHARE"),
    "\\\\server\\share\\"
  );
  assert.equal(
    pathsEqualWindows("\\\\server\\share\\", "\\\\?\\UNC\\server\\share"),
    true
  );
});

test("Windows inside-root comparison uses relative path boundaries", () => {
  const root = "C:\\Temp\\YUVI";
  assert.equal(isWindowsPathInside(root, "C:\\Temp\\YUVI\\runtime\\node.exe"), true);
  assert.equal(
    isWindowsPathInside(root, "\\\\?\\C:\\Temp\\YUVI\\runtime\\node.exe"),
    true
  );
  assert.equal(
    isWindowsPathInside("\\\\?\\C:\\Temp\\YUVI", "C:\\Temp\\YUVI\\runtime\\node.exe"),
    true
  );
  assert.equal(isWindowsPathInside(root, root), true);
  assert.equal(isWindowsPathInside(root, "C:\\Temp\\YUVI-Evil\\node.exe"), false);
  assert.equal(isWindowsPathInside(root, "C:\\Temp\\YUVI2\\node.exe"), false);
  assert.equal(isWindowsPathInside(root, "C:\\Temp\\YUVI\\..\\outside\\node.exe"), false);
  assert.equal(isWindowsPathInside(root, "D:\\Temp\\YUVI\\runtime\\node.exe"), false);
  assert.equal(
    isWindowsPathInside("\\\\server\\share", "\\\\?\\UNC\\server\\share2\\foo"),
    false
  );
});

test("diagnostics sample listener, metadata, and stable ownership state changes", async () => {
  const root = temp("yuvi-installer-smoke-");
  const installRoot = path.join(root, "install");
  const metadataPath = path.join(root, "state", "mem0.pid.json");
  fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
  fs.writeFileSync(
    metadataPath,
    JSON.stringify({
      schemaVersion: 1,
      role: "mem0",
      pid: 200,
      commandMarker: `${installRoot}\\resources\\mem0\\yuvi-mem0.exe`,
      processStartedAtUtc: "2026-08-05T10:00:00.000Z",
      instanceId: "instance-a",
      ownershipToken: "secret-canary"
    })
  );
  let now = 1_000;
  let listening = false;
  const calls = [];
  const attribution = async (port, options) => {
    calls.push({ port, options });
    if (port === 6131 && listening)
      return {
        port,
        state: "Listen",
        owningPid: 200,
        processName: "yuvi-mem0.exe",
        parentProcessId: 100,
        executablePath: `${installRoot}\\resources\\mem0\\yuvi-mem0.exe`,
        creationDate: "2026-08-05T10:00:00.000Z",
        querySucceeded: true,
        queryErrorCode: null,
        executableInsideInstallRoot: true,
        pidEqualsSupervisorPid: false,
        pidEqualsKnownManagedPid: true
      };
    return {
      port,
      state: "not-listening",
      owningPid: 0,
      processName: null,
      parentProcessId: 0,
      executablePath: null,
      creationDate: null,
      querySucceeded: true,
      queryErrorCode: null,
      executableInsideInstallRoot: false,
      pidEqualsSupervisorPid: false,
      pidEqualsKnownManagedPid: false
    };
  };
  const diagnostic = createOwnershipDiagnostics({
    ports: createDiagnosticPortRoles({
      mem0ServicePort: 6131,
      supervisorRequestedControlPort: 6242
    }),
    metadataPath,
    installRoot,
    smokeRoot: root,
    attribution,
    now: () => now
  });
  diagnostic.setSupervisorPid(100);
  await diagnostic.sample("T0", { status: "stopped", ownership: "none" });
  now += 10;
  listening = true;
  await diagnostic.sample("T1", { status: "healthy", ownership: "owned", pid: 200 });
  now += 10;
  await diagnostic.sample("T2", { status: "healthy", ownership: "owned", pid: 200 });
  const snapshot = diagnostic.snapshot();
  assert.equal(snapshot.firstListenerPhase, "T1");
  assert.deepEqual(
    snapshot.stateSequence.map((entry) => entry.phase),
    ["T0", "T1"]
  );
  assert.equal(snapshot.checkpoints.length, 3);
  assert.equal(calls.length, 12);
  assert.equal(snapshot.checkpoints[1].metadata.pid, 200);
  const formatted = formatOwnershipDiagnostic({
    diagnostic,
    supervisorExecutable: `${installRoot}\\resources\\supervisor\\yuvi-desktop-supervisor.exe`,
    installRoot
  });
  assert.match(formatted, /MEM0 OWNERSHIP DIAGNOSTIC/);
  assert.doesNotMatch(formatted, /secret-canary/);
});

test("ownership metadata diagnostics use an allowlist and hide secret fields", () => {
  const root = temp("yuvi-installer-smoke-");
  const installRoot = path.join(root, "install");
  const metadataPath = path.join(root, "state", "mem0.pid.json");
  fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
  fs.writeFileSync(
    metadataPath,
    JSON.stringify({
      schemaVersion: 1,
      protocolVersion: 1,
      role: "mem0",
      pid: 42,
      instanceId: "instance-a",
      commandMarker: `${installRoot}\\mem0\\yuvi-mem0.exe`,
      processStartedAtUtc: "2026-08-05T10:00:00.000Z",
      ownershipToken: "secret-canary",
      DATABASE_URL: "postgres://secret"
    })
  );
  const result = readOwnershipMetadataDiagnostic(metadataPath, { installRoot });
  assert.equal(result.pid, 42);
  assert.equal(result.executable, "yuvi-mem0.exe");
  assert.equal(result.executableInsideInstallRoot, true);
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result, "ownershipToken"), false);
});

function transientError(code) {
  return Object.assign(new Error(code), { code });
}

function cleanupFixture() {
  const root = temp("yuvi-installer-smoke-");
  return { root, target: path.join(root, "install") };
}

test("cleanup succeeds immediately without sleeping", async () => {
  const { root, target } = cleanupFixture();
  let attempts = 0;
  let sleeps = 0;
  await removeTreeWithRetries(target, {
    smokeOwnedRoot: root,
    remove: () => {
      attempts += 1;
    },
    sleep: async () => {
      sleeps += 1;
    }
  });
  assert.equal(attempts, 1);
  assert.equal(sleeps, 0);
});

for (const code of ["EPERM", "EBUSY", "ENOTEMPTY"]) {
  test(`cleanup retries transient ${code} and then succeeds`, async () => {
    const { root, target } = cleanupFixture();
    let attempts = 0;
    const sleeps = [];
    await removeTreeWithRetries(target, {
      smokeOwnedRoot: root,
      remove: () => {
        attempts += 1;
        if (attempts === 1) throw transientError(code);
      },
      sleep: async (delay) => sleeps.push(delay)
    });
    assert.equal(attempts, 2);
    assert.deepEqual(sleeps, [100]);
  });
}

test("persistent EPERM fails with the original error after bounded retries", async () => {
  const { root, target } = cleanupFixture();
  const original = transientError("EPERM");
  let attempts = 0;
  const sleeps = [];
  await assert.rejects(
    removeTreeWithRetries(target, {
      smokeOwnedRoot: root,
      maxAttempts: 4,
      remove: () => {
        attempts += 1;
        throw original;
      },
      sleep: async (delay) => sleeps.push(delay)
    }),
    (error) => error === original && error.code === "EPERM"
  );
  assert.equal(attempts, 4);
  assert.equal(sleeps.length, 3);
});

test("non-retryable and no-code cleanup errors fail immediately", async () => {
  for (const error of [transientError("EACCES"), new Error("unknown cleanup failure")]) {
    const { root, target } = cleanupFixture();
    let sleeps = 0;
    await assert.rejects(
      removeTreeWithRetries(target, {
        smokeOwnedRoot: root,
        remove: () => {
          throw error;
        },
        sleep: async () => {
          sleeps += 1;
        }
      }),
      (actual) => actual === error
    );
    assert.equal(sleeps, 0);
  }
});

test("cleanup retry delays are stable and capped", async () => {
  const { root, target } = cleanupFixture();
  let attempts = 0;
  const sleeps = [];
  await removeTreeWithRetries(target, {
    smokeOwnedRoot: root,
    maxAttempts: 7,
    remove: () => {
      attempts += 1;
      if (attempts <= 6) throw transientError("EPERM");
    },
    sleep: async (delay) => sleeps.push(delay)
  });
  assert.deepEqual(sleeps, [100, 200, 400, 800, 1000, 1000]);
});

test("ENOENT is treated as an already-removed smoke tree", async () => {
  const { root, target } = cleanupFixture();
  let sleeps = 0;
  await removeTreeWithRetries(target, {
    smokeOwnedRoot: root,
    remove: () => {
      throw transientError("ENOENT");
    },
    sleep: async () => {
      sleeps += 1;
    }
  });
  assert.equal(sleeps, 0);
});

test("cleanup rejects empty, outside, repository and system paths", async () => {
  const { root, target } = cleanupFixture();
  await assert.rejects(
    removeTreeWithRetries("", { smokeOwnedRoot: root, remove: () => {} }),
    /empty/
  );
  await assert.rejects(
    removeTreeWithRetries(temp(), { smokeOwnedRoot: root, remove: () => {} }),
    /outside smoke root/
  );
  await assert.rejects(
    removeTreeWithRetries(path.resolve("."), { smokeOwnedRoot: root, remove: () => {} }),
    /outside smoke root/
  );
  await assert.rejects(
    removeTreeWithRetries(target, { smokeOwnedRoot: root, systemRoot: root, remove: () => {} }),
    /SystemRoot/
  );
});

test("cleanup rejects a drive root even when removal is injected", async () => {
  const root = temp("yuvi-installer-smoke-");
  await assert.rejects(
    removeTreeWithRetries(path.parse(root).root, { smokeOwnedRoot: root, remove: () => {} }),
    /outside smoke root|drive root/
  );
});

test("cleanup is invoked only after exact Supervisor and Mem0 PIDs exit", async () => {
  const { root, target } = cleanupFixture();
  const live = new Set([101, 202]);
  const events = [];
  await waitForSpecificPidsExit(
    [
      { role: "Supervisor", pid: 101 },
      { role: "Mem0", pid: 202 }
    ],
    {
      pidProbe: (pid) => live.has(pid),
      sleep: async () => {
        events.push("pids-exit");
        live.clear();
      }
    }
  );
  await removeTreeWithRetries(target, {
    smokeOwnedRoot: root,
    remove: () => events.push("cleanup"),
    sleep: async () => {}
  });
  assert.deepEqual(events, ["pids-exit", "cleanup"]);
});

test("PID exit timeout prevents cleanup and does not terminate external processes", async () => {
  const { root, target } = cleanupFixture();
  const probed = [];
  let cleanupCalls = 0;
  try {
    await waitForSpecificPidsExit(
      [
        { role: "Supervisor", pid: 101 },
        { role: "Mem0", pid: 202 }
      ],
      {
        pidProbe: (pid) => {
          probed.push(pid);
          return true;
        },
        timeoutMs: 0,
        sleep: async () => {}
      }
    );
    await removeTreeWithRetries(target, {
      smokeOwnedRoot: root,
      remove: () => {
        cleanupCalls += 1;
      }
    });
  } catch (error) {
    assert.match(String(error), /Supervisor PID 101.*Mem0 PID 202/);
  }
  assert.deepEqual([...new Set(probed)], [101, 202]);
  assert.equal(cleanupCalls, 0);
});

test("uninstaller must be inside TEMP install", () => {
  const root = temp("yuvi-installer-smoke-");
  const install = path.join(root, "install");
  fs.mkdirSync(install);
  fs.writeFileSync(path.join(install, "uninstall.exe"), "x");
  assert.equal(findUninstaller(install), path.join(install, "uninstall.exe"));
});

test("missing or ambiguous uninstaller fails", () => {
  const root = temp("yuvi-installer-smoke-");
  assert.throws(() => findUninstaller(root), /expected one uninstaller/);
  fs.writeFileSync(path.join(root, "uninstall.exe"), "x");
  fs.writeFileSync(path.join(root, "unins000.exe"), "x");
  assert.throws(() => findUninstaller(root), /expected one uninstaller/);
});

test("installed resource tree must contain Mem0 before deep validation", () => {
  const root = temp();
  fs.mkdirSync(path.join(root, "runtime"));
  fs.mkdirSync(path.join(root, "supervisor"));
  fs.writeFileSync(path.join(root, "packaging-info.json"), "{}");
  assert.throws(() => validateInstalledResources(root), /missing/);
});

test("--launch-app is rejected outside CI", () => {
  assert.throws(
    () => assertTauriAppSmokeAllowed({ CI: "false", YUVI_ALLOW_TAURI_APP_SMOKE: "1" }, "win32"),
    /CI-only/
  );
});

test("--launch-app requires the explicit CI opt-in", () => {
  assert.throws(
    () => assertTauriAppSmokeAllowed({ CI: "true" }, "win32"),
    /YUVI_ALLOW_TAURI_APP_SMOKE/
  );
});

test("--launch-app is rejected on non-Windows", () => {
  assert.throws(
    () => assertTauriAppSmokeAllowed({ CI: "true", YUVI_ALLOW_TAURI_APP_SMOKE: "1" }, "linux"),
    /CI-only/
  );
});

test("the exact CI gate permits app smoke", () => {
  assert.equal(
    assertTauriAppSmokeAllowed({ CI: "true", YUVI_ALLOW_TAURI_APP_SMOKE: "1" }, "win32"),
    true
  );
});

test("installed application finder selects the unique top-level product exe", () => {
  const root = temp("yuvi-installer-smoke-");
  fs.writeFileSync(path.join(root, "yuvi-desktop.exe"), "MZ");
  fs.writeFileSync(path.join(root, "uninstall.exe"), "MZ");
  fs.mkdirSync(path.join(root, "generated", "win32-x64", "mem0"), { recursive: true });
  fs.writeFileSync(path.join(root, "generated", "win32-x64", "mem0", "yuvi-mem0.exe"), "MZ");
  assert.equal(findInstalledApplicationExecutable(root), path.join(root, "yuvi-desktop.exe"));
});

test("installed application finder excludes uninstaller files", () => {
  const root = temp("yuvi-installer-smoke-");
  fs.writeFileSync(path.join(root, "uninstall.exe"), "MZ");
  fs.writeFileSync(path.join(root, "unins000.exe"), "MZ");
  assert.throws(() => findInstalledApplicationExecutable(root), /not found/);
});

test("installed application finder excludes generated internal executables", () => {
  const root = temp("yuvi-installer-smoke-");
  fs.writeFileSync(path.join(root, "yuvi-desktop.exe"), "MZ");
  fs.mkdirSync(path.join(root, "generated", "win32-x64", "runtime"), { recursive: true });
  fs.writeFileSync(path.join(root, "generated", "win32-x64", "runtime", "node.exe"), "MZ");
  assert.equal(path.basename(findInstalledApplicationExecutable(root)), "yuvi-desktop.exe");
});

test("installed application finder rejects multiple product executables", () => {
  const root = temp("yuvi-installer-smoke-");
  fs.writeFileSync(path.join(root, "yuvi-desktop.exe"), "MZ");
  fs.writeFileSync(path.join(root, "YUVI Companion.exe"), "MZ");
  assert.throws(() => findInstalledApplicationExecutable(root), /multiple installed application/);
});

test("installed application finder requires a top-level TEMP product", () => {
  const root = temp("yuvi-installer-smoke-");
  fs.mkdirSync(path.join(root, "nested"));
  fs.writeFileSync(path.join(root, "nested", "yuvi-desktop.exe"), "MZ");
  assert.throws(() => findInstalledApplicationExecutable(root), /not found/);
});

test("Tauri child env strips Python, Node and pnpm pollution", () => {
  const env = sanitizeChildEnv({
    PYTHONPATH: "bad",
    NODE_PATH: "bad",
    PNPM_HOME: "bad",
    npm_config_prefix: "bad"
  });
  for (const key of ["PYTHONPATH", "NODE_PATH", "PNPM_HOME", "npm_config_prefix"])
    assert.equal(env[key], undefined);
});

test("Tauri app env preserves the real Windows profile while isolating mutable roots", () => {
  const previous = process.env.USERPROFILE;
  process.env.USERPROFILE = "C:\\Users\\runneradmin";
  try {
    const env = createTauriAppEnv({
      localAppData: "C:\\Temp\\yuvi-local",
      appData: "C:\\Temp\\yuvi-roaming",
      home: "C:\\Temp\\yuvi-home",
      temp: "C:\\Temp\\yuvi-temp"
    });
    assert.equal(env.USERPROFILE, "C:\\Users\\runneradmin");
    assert.equal(env.LOCALAPPDATA, "C:\\Temp\\yuvi-local");
    assert.equal(env.APPDATA, "C:\\Temp\\yuvi-roaming");
    assert.equal(env.HOME, "C:\\Temp\\yuvi-home");
    assert.equal(env.TEMP, "C:\\Temp\\yuvi-temp");
    assert.equal(env.TMP, "C:\\Temp\\yuvi-temp");
    assert.equal(env.PATH, restrictedPath());
    assert.equal(env.PYTHONPATH, undefined);
    assert.equal(env.NODE_PATH, undefined);
  } finally {
    if (previous === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previous;
  }
});

test("Tauri child env strips all four secret variables", () => {
  const env = sanitizeChildEnv({
    DEEPSEEK_API_KEY: "secret",
    DATABASE_URL: "secret",
    MEM0_PG_CONNECTION_STRING: "secret",
    MEM0_LLM_API_KEY: "secret"
  });
  for (const key of [
    "DEEPSEEK_API_KEY",
    "DATABASE_URL",
    "MEM0_PG_CONNECTION_STRING",
    "MEM0_LLM_API_KEY"
  ])
    assert.equal(env[key], undefined);
});

test("Tauri bootstrap readiness requires the current app and Supervisor instance", async () => {
  const root = temp("yuvi-installer-smoke-");
  const marker = path.join(root, "tauri-bootstrap-ready.json");
  fs.writeFileSync(
    marker,
    JSON.stringify({
      schemaVersion: 1,
      tauriPid: 111,
      supervisorPid: 222,
      instanceId: "current-instance",
      readyAtMs: Date.now()
    })
  );
  const ready = await waitForTauriBootstrapReady(marker, {
    timeoutMs: 100,
    appPid: 111,
    supervisorPid: 222,
    instanceId: "current-instance"
  });
  assert.equal(ready.supervisorPid, 222);
  await assert.rejects(
    waitForTauriBootstrapReady(marker, {
      timeoutMs: 100,
      appPid: 999,
      supervisorPid: 222,
      instanceId: "current-instance"
    }),
    /readiness barrier/
  );
});

test("Tauri application arguments are empty by construction", () => {
  const args = [];
  assert.deepEqual(args, []);
  assertNoSecrets(args, "Tauri argv");
});

test("WM_CLOSE command uses Python ctypes exact-HWND targeting", () => {
  const script = buildWmCloseScript(12345);
  assert.equal(script, WM_CLOSE_PYTHON_SOURCE);
  assert.match(script, /ctypes\.WinDLL\("user32", use_last_error=True\)/);
  for (const symbol of [
    "EnumWindows",
    "GetWindowThreadProcessId",
    "GetWindowTextLengthW",
    "GetWindowTextW",
    "IsWindow",
    "PostMessageW"
  ]) assert.match(script, new RegExp(symbol));
  assert.match(script, /expected_title/);
  assert.match(script, /emit_phase\("before_revalidate"\)/);
  assert.match(script, /emit_phase\("after_post"\)/);
  assert.doesNotMatch(
    script,
    /CloseMainWindow|UIAutomation|WindowPattern|SetFocus|Add-Type|DllImport|CodeDom|SendKeys|AppActivate|taskkill|Stop-Process/i
  );
});

test("WM_CLOSE command rejects invalid PIDs and uses isolated Python arguments", () => {
  assert.throws(() => buildWmCloseScript(0), /invalid/);
  assert.throws(() => buildWmCloseScript("pid"), /invalid/);
  assert.deepEqual(buildWmCloseArguments(12345).slice(0, 2), ["-I", "-S"]);
  assert.equal(buildWmCloseArguments(12345).at(-1), TAURI_MAIN_WINDOW_TITLE);
});

test("WM_CLOSE harness requires an absolute existing YUVI_PYTHON311 file", () => {
  const statFile = { statSync: () => ({ isFile: () => true }) };
  assert.throws(
    () => resolveWmClosePythonExecutable({}, statFile, "win32"),
    /requires YUVI_PYTHON311/
  );
  assert.throws(
    () => resolveWmClosePythonExecutable({ YUVI_PYTHON311: "python.exe" }, statFile, "win32"),
    /absolute/
  );
  assert.throws(
    () => resolveWmClosePythonExecutable(
      { YUVI_PYTHON311: "C:\\missing\\python.exe" },
      { statSync: () => { throw new Error("ENOENT"); } },
      "win32"
    ),
    /existing/
  );
  assert.equal(
    resolveWmClosePythonExecutable(
      { YUVI_PYTHON311: "C:\\Python311\\python.exe" },
      statFile,
      "win32"
    ),
    "C:\\Python311\\python.exe"
  );
});

const wmCloseOutput = ({
  targetPid = 123,
  pidTopLevelWindows = 2,
  exactTitleMatches = 1,
  targetHwnd = 123456,
  validatedPid = targetPid,
  titleExact = 1,
  identityValid = 1,
  postResult = 1,
  visibleAfterClose = 0,
  elapsedMs = 8,
  phases = null
} = {}) => {
  const phaseLines = [
    "start",
    "before_enum",
    "after_enum",
    "before_revalidate",
    "after_revalidate",
    "before_post",
    "after_post"
  ].map((phase) => `WM_CLOSE_PHASE=${phase}`);
  return [
    ...phaseLines.filter((line) => !phases || phases.includes(line.slice(15))),
    `target_pid=${targetPid}`,
    `pid_top_level_windows=${pidTopLevelWindows}`,
    `exact_title_matches=${exactTitleMatches}`,
    `target_hwnd=${targetHwnd}`,
    `validated_pid=${validatedPid}`,
    `title_exact=${titleExact}`,
    `identity_valid=${identityValid}`,
    `post_result=${postResult}`,
    `visible_after_close=${visibleAfterClose}`,
    `elapsed_ms=${elapsedMs}`
  ].join("\n");
};

function fakeWmCloseChild({ pid = 321, onKill = null } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let killCalls = 0;
  child.kill = () => {
    killCalls += 1;
    onKill?.(child);
    return true;
  };
  return { child, getKillCalls: () => killCalls };
}

test("WM_CLOSE keeps the existing PowerShell diagnostic path available", () => {
  const executable = powershellDiagnosticPath({ SystemRoot: "C:\\Windows" });
  assert.equal(executable, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
});

test("WM_CLOSE helper accepts a successful structured result", async () => {
  let observedExecutable = null;
  const result = await runWmCloseHelper({
    executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    args: [],
    options: {},
    timeoutMs: 100,
    expectedPid: 123,
    spawnImpl: (file) => {
      observedExecutable = file;
      const { child } = fakeWmCloseChild();
      queueMicrotask(() => {
        child.stdout.emit("data", wmCloseOutput());
        child.emit("exit", 0, null);
      });
      return child;
    }
  });
  assert.equal(observedExecutable, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(result.pidTopLevelWindows, 2);
  assert.equal(result.exactTitleMatches, 1);
  assert.equal(result.targetHwnd, 123456);
  assert.equal(result.identityValid, true);
  assert.equal(result.postResult, true);
  assert.equal(result.visibleAfterClose, false);
  assert.equal(result.code, 0);
});

test("WM_CLOSE helper fails closed for invalid discovery and identity", async () => {
  for (const [output, message] of [
    [wmCloseOutput({ pidTopLevelWindows: 0 }), /no target top-level windows/],
    [wmCloseOutput({ exactTitleMatches: 0 }), /exactly one exact title match/],
    [wmCloseOutput({ targetHwnd: 0 }), /invalid target_hwnd/],
    [wmCloseOutput({ identityValid: 0 }), /identity was not validated/],
    [wmCloseOutput({ postResult: 0 }), /PostMessageW was not accepted/]
  ]) {
    await assert.rejects(
      runWmCloseHelper({
        executable: "powershell.exe",
        args: [],
        options: {},
        timeoutMs: 100,
        spawnImpl: () => {
          const { child } = fakeWmCloseChild();
          queueMicrotask(() => {
            child.stdout.emit("data", output);
            child.emit("exit", 0, null);
          });
          return child;
        }
      }),
      message
    );
  }
});

test("WM_CLOSE helper rejects nonzero exit, spawn errors and malformed output", async () => {
  await assert.rejects(
    runWmCloseHelper({
      executable: "powershell.exe",
      args: [],
      options: {},
      timeoutMs: 100,
      spawnImpl: () => {
        const { child } = fakeWmCloseChild();
        queueMicrotask(() => child.emit("exit", 2, null));
        return child;
      }
    }),
    /exited with code 2/
  );
  await assert.rejects(
    runWmCloseHelper({
      executable: "powershell.exe",
      args: [],
      options: {},
      timeoutMs: 100,
      spawnImpl: () => {
        throw new Error("spawn failed safely");
      }
    }),
    /spawn failed safely/
  );
  await assert.rejects(
    runWmCloseHelper({
      executable: "powershell.exe",
      args: [],
      options: {},
      timeoutMs: 100,
      spawnImpl: () => {
        const { child } = fakeWmCloseChild();
        queueMicrotask(() => {
          child.stdout.emit("data", "WM_CLOSE_PHASE=start\ntarget_pid=123\n");
          child.emit("exit", 0, null);
        });
        return child;
      }
    }),
    /invalid phase sequence/
  );
});

test("WM_CLOSE helper rejects missing fields and wrong target PID", async () => {
  await assert.rejects(
    runWmCloseHelper({
      executable: "powershell.exe",
      args: [],
      options: {},
      timeoutMs: 100,
      expectedPid: 123,
      spawnImpl: () => {
        const { child } = fakeWmCloseChild();
        queueMicrotask(() => {
          child.stdout.emit(
            "data",
            wmCloseOutput().replace("post_result=1\n", "")
          );
          child.emit("exit", 0, null);
        });
        return child;
      }
    }),
    /missing or malformed post_result/
  );
  await assert.rejects(
    runWmCloseHelper({
      executable: "powershell.exe",
      args: [],
      options: {},
      timeoutMs: 100,
      expectedPid: 999,
      spawnImpl: () => {
        const { child } = fakeWmCloseChild();
        queueMicrotask(() => {
          child.stdout.emit("data", wmCloseOutput());
          child.emit("exit", 0, null);
        });
        return child;
      }
    }),
    /target PID mismatch/
  );
});

test("WM_CLOSE helper timeout requests one kill and reports phase and safe stderr", async () => {
  const { child, getKillCalls } = fakeWmCloseChild();
  await assert.rejects(
    runWmCloseHelper({
      executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      args: [],
      options: {},
      timeoutMs: 5,
      killGraceMs: 5,
      spawnImpl: () => {
        queueMicrotask(() => {
          child.stdout.emit("data", "WM_CLOSE_PHASE=start\nWM_CLOSE_PHASE=before_enum\n");
          child.stderr.emit("data", "safe diagnostic");
        });
        return child;
      }
    }),
    (error) => {
      assert.match(error.message, /did not exit after termination request/);
      assert.match(error.message, /helper_pid=321/);
      assert.match(error.message, /last_phase=before_enum/);
      assert.match(error.message, /kill_requested=yes/);
      assert.match(error.message, /safe_stderr=safe diagnostic/);
      assert.match(error.message, /exit_observed_after_kill=no/);
      return true;
    }
  );
  assert.equal(getKillCalls(), 1);
});

test("WM_CLOSE timeout observes a child exit after kill and never resolves later", async () => {
  const { child, getKillCalls } = fakeWmCloseChild({
    onKill: (target) => setTimeout(() => target.emit("exit", null, "SIGTERM"), 2)
  });
  await assert.rejects(
    runWmCloseHelper({
      executable: "powershell.exe",
      args: [],
      options: {},
      timeoutMs: 5,
      killGraceMs: 20,
      spawnImpl: () => child
    }),
    (error) => {
      assert.match(error.message, /WM_CLOSE helper timed out/);
      assert.match(error.message, /exit_observed_after_kill=yes/);
      assert.match(error.message, /exit_signal=SIGTERM/);
      return true;
    }
  );
  assert.equal(getKillCalls(), 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
});

test("WM_CLOSE timeout and exit race settles exactly once", async () => {
  const { child } = fakeWmCloseChild({
    onKill: (target) => target.emit("exit", null, "SIGTERM")
  });
  const outcome = await Promise.allSettled([
    runWmCloseHelper({
      executable: "powershell.exe",
      args: [],
      options: {},
      timeoutMs: 5,
      killGraceMs: 20,
      spawnImpl: () => child
    })
  ]);
  assert.equal(outcome.length, 1);
  assert.equal(outcome[0].status, "rejected");
});

test("WM_CLOSE output parser rejects secret-like output without retaining it", () => {
  assert.throws(
    () => parseWmCloseOutput(`${wmCloseOutput()}\nDEEPSEEK_API_KEY=do-not-echo`),
    /secret-like material/
  );
});

// Default synthetic menu: Quit sits in the middle so every default-case test
// proves resolution by accessible name, not by position or numeric id. MSAA
// child ids are 1-based positions assigned at discovery time.
const defaultTrayQuitItems = () => [
  "Show Companion",
  "Open YUVI",
  "Quit",
  "Hide YUVI",
  "Hide Companion"
];

const trayQuitOutput = ({
  targetPid = 123,
  trayWindows = 1,
  trayHwnd = 456789,
  validatedPid = targetPid,
  classExact = 1,
  identityValid = 1,
  notifyPost = 1,
  menuWindows = 1,
  menuWindowsAny = 1,
  menuHwnd = 789012,
  trayAlive = 1,
  rects = [{ uid: 1, left: 1800, top: 1040, right: 1824, bottom: 1064 }],
  items = defaultTrayQuitItems(),
  invokeHresult = 0,
  invokeResult = 1,
  elapsedMs = 8,
  phases = null
} = {}) => {
  const quitHits = items
    .map((text, index) => ({ text, childId: index + 1 }))
    .filter((item) => item.text === "Quit");
  const quitChildId = quitHits.length ? quitHits[0].childId : 0;
  const quitText = quitHits.length ? quitHits[0].text : "";
  const phaseLines = [
    "start",
    "before_enum",
    "after_enum",
    "before_revalidate",
    "after_revalidate",
    "before_icon_probe",
    "after_icon_probe",
    "before_menu_open",
    "after_menu_open",
    "before_discover",
    "after_discover",
    "before_invoke",
    "after_invoke"
  ].map((phase) => `TRAY_QUIT_PHASE=${phase}`);
  return [
    ...phaseLines.filter((line) => !phases || phases.includes(line.slice(16))),
    `target_pid=${targetPid}`,
    `tray_windows=${trayWindows}`,
    `tray_hwnd=${trayHwnd}`,
    `validated_pid=${validatedPid}`,
    `class_exact=${classExact}`,
    `identity_valid=${identityValid}`,
    `notify_post=${notifyPost}`,
    `menu_windows=${menuWindows}`,
    `menu_windows_any=${menuWindowsAny}`,
    `menu_hwnd=${menuHwnd}`,
    `tray_alive=${trayAlive}`,
    `icon_rect_count=${rects.length}`,
    ...rects.map((rect) => `TRAY_ICON_RECT=${rect.uid}:${rect.left},${rect.top},${rect.right},${rect.bottom}`),
    `menu_item_count=${items.length}`,
    `quit_matches=${quitHits.length}`,
    `quit_child_id=${quitChildId}`,
    `quit_text=${quitText}`,
    ...items.map((text, index) => `TRAY_QUIT_MENU_ITEM=${index + 1}:${text}`),
    `invoke_hresult=${invokeHresult}`,
    `invoke_result=${invokeResult}`,
    `elapsed_ms=${elapsedMs}`
  ].join("\n");
};

test("tray Quit helper invokes the semantic item and never uses numeric command ids", () => {
  const script = buildTrayQuitScript(12345);
  assert.equal(script, TRAY_QUIT_PYTHON_SOURCE);
  assert.match(script, /TRAY_ICON_WINDOW_CLASS = "tray_icon_app"/);
  assert.match(script, /TRAY_MENU_WINDOW_CLASS = "#32768"/);
  assert.match(script, /TRAY_QUIT_MENU_TEXT = "Quit"/);
  assert.match(script, /WM_USER_TRAYICON = 6002/);
  assert.match(script, /OBJID_CLIENT = 0xFFFFFFFC/);
  for (const symbol of [
    "EnumWindows",
    "GetWindowThreadProcessId",
    "GetClassNameW",
    "IsWindow",
    "PostMessageW",
    "oleacc",
    "AccessibleObjectFromWindow",
    "IID_IACCESSIBLE",
    "GetNameProto",
    "DoDefaultProto",
    "SysFreeString",
    "TRAY_QUIT_MENU_ITEM"
  ]) assert.match(script, new RegExp(symbol));
  assert.doesNotMatch(script, /1004/);
  assert.doesNotMatch(script, /WM_COMMAND/);
  assert.doesNotMatch(script, /SendMessageW/);
  assert.doesNotMatch(script, /MN_GETHMENU/);
  assert.doesNotMatch(script, /GetMenuStringW/);
  assert.doesNotMatch(script, /GetMenuItemID/);
  assert.doesNotMatch(script, /TRAY_QUIT_MENU_COMMAND_ID/);
  assert.doesNotMatch(script, /quit_command_id/);
  assert.equal(TRAY_ICON_WINDOW_CLASS, "tray_icon_app");
  assert.equal(TRAY_MENU_WINDOW_CLASS, "#32768");
  assert.equal(TRAY_MENU_OBJID_CLIENT, 0xfffffffc);
  assert.equal(TRAY_NOTIFY_MESSAGE_ID, 6002);
  assert.equal(TRAY_QUIT_MENU_TEXT, "Quit");
  assert.equal(TRAY_QUIT_SEMANTIC_ID, "tray-quit");
  assert.doesNotMatch(script, /taskkill|Stop-Process|UIAutomation|Add-Type|DllImport/i);
  const source = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "installer-smoke.mjs"),
    "utf8"
  );
  assert.doesNotMatch(source, /1004/);
  assert.doesNotMatch(source, /TRAY_QUIT_MENU_COMMAND_ID/);
});

test("tray Quit helper arguments are isolated and reject invalid PIDs", () => {
  assert.throws(() => buildTrayQuitScript(0), /invalid/);
  assert.throws(() => buildTrayQuitScript("pid"), /invalid/);
  assert.deepEqual(buildTrayQuitArguments(12345).slice(0, 2), ["-I", "-S"]);
  assert.equal(buildTrayQuitArguments(12345).at(-1), "12345");
});

test("tray Quit retry policy repeats only the real path within budget", () => {
  assert.equal(TRAY_QUIT_MAX_ATTEMPTS, 4);
  assert.equal(TRAY_QUIT_ATTEMPT_BUDGET_MS, 40_000);
  assert.equal(shouldRetryTrayQuit({ attempt: 1, elapsedMs: 0, timeoutMs: 60_000 }), true);
  assert.equal(shouldRetryTrayQuit({ attempt: 3, elapsedMs: 30_000, timeoutMs: 60_000 }), true);
  assert.equal(shouldRetryTrayQuit({ attempt: 4, elapsedMs: 0, timeoutMs: 60_000 }), false);
  assert.equal(shouldRetryTrayQuit({ attempt: 1, elapsedMs: 41_000, timeoutMs: 60_000 }), false);
  assert.equal(shouldRetryTrayQuit({ attempt: 1, elapsedMs: 6_000, timeoutMs: 5_000 }), false);
  assert.throws(() => shouldRetryTrayQuit({ attempt: 0, elapsedMs: 0, timeoutMs: 60_000 }), /invalid/);
});

test("tray Quit output resolves the semantic Quit item regardless of position", () => {
  const parsed = parseTrayQuitOutput(trayQuitOutput(), 123);
  assert.equal(parsed.identityValid, true);
  assert.equal(parsed.quitText, "Quit");
  assert.equal(parsed.quitChildId, 3);
  assert.equal(parsed.invokeResult, true);
  assert.equal(parsed.invokeHresult, 0);
  assert.deepEqual(
    parsed.menuItems.map((item) => item.text),
    ["Show Companion", "Open YUVI", "Quit", "Hide YUVI", "Hide Companion"]
  );
  assert.deepEqual(
    parsed.menuItems.map((item) => item.childId),
    [1, 2, 3, 4, 5]
  );
  assert.match(parsed.menuMap, /3:Quit/);

  const cases = [
    {
      label: "quit first",
      items: ["Quit", "Open YUVI"],
      expectedChild: 1
    },
    {
      label: "quit last",
      items: ["Open YUVI", "Quit"],
      expectedChild: 2
    },
    {
      label: "quit single item menu",
      items: ["Quit"],
      expectedChild: 1
    },
    {
      label: "future controls do not disturb Quit resolution",
      items: ["Open WebUI", "Quit", "Settings", "Toggle Subtitle", "Toggle Companion"],
      expectedChild: 2
    }
  ];
  for (const { label, items, expectedChild } of cases) {
    const result = parseTrayQuitOutput(trayQuitOutput({ items }), 123);
    assert.equal(result.quitChildId, expectedChild, label);
    assert.equal(result.quitMatches, 1, label);
    assert.equal(result.quitText, "Quit", label);
  }
});

test("tray Quit output fails closed when Quit is missing or ambiguous", () => {
  for (const [items, mapFragment] of [
    [["Open YUVI", "Settings"], "Open YUVI"],
    [
      ["quit", "Quit ", " Quit", "Quits", "Quit All", "&Quit"],
      "Quit All"
    ]
  ]) {
    assert.throws(
      () => parseTrayQuitOutput(trayQuitOutput({ items }), 123),
      (error) =>
        /expected exactly one "Quit" item/.test(error.message) &&
        error.message.includes(mapFragment),
      "missing Quit must fail with the discovered map"
    );
  }
  assert.throws(
    () =>
      parseTrayQuitOutput(
        trayQuitOutput({ items: ["Quit", "Open YUVI", "Quit"] }),
        123
      ),
    /expected exactly one "Quit" item, found 2 of 3/
  );
  assert.throws(
    () =>
      parseTrayQuitOutput(
        trayQuitOutput()
          .split("\n")
          .filter((line) => line !== "TRAY_QUIT_MENU_ITEM=3:Quit")
          .join("\n"),
        123
      ),
    /menu map is truncated/
  );
  assert.throws(
    () =>
      parseTrayQuitOutput(
        trayQuitOutput()
          .split("\n")
          .filter((line) => !line.startsWith("TRAY_ICON_RECT="))
          .join("\n"),
        123
      ),
    /icon rect map is truncated/
  );
  assert.throws(
    () => parseTrayQuitOutput(trayQuitOutput().replace("quit_child_id=3", "quit_child_id=5"), 123),
    /not bound to the reported menu map/
  );
});

test("tray Quit output requires the real menu surface and a successful invocation", () => {
  const parsed = parseTrayQuitOutput(trayQuitOutput(), 123);
  assert.equal(parsed.notifyPost, true);
  assert.equal(parsed.menuWindows, 1);
  assert.equal(parsed.menuWindowsAny, 1);
  assert.equal(parsed.trayAlive, true);
  assert.deepEqual(parsed.iconRects, [
    { uid: 1, left: 1800, top: 1040, right: 1824, bottom: 1064 }
  ]);
  for (const [output, message] of [
    [trayQuitOutput({ trayWindows: 0 }), /exactly one tray icon window/],
    [trayQuitOutput({ identityValid: 0 }), /identity was not validated/],
    [trayQuitOutput({ notifyPost: 0 }), /menu open was not accepted/],
    [trayQuitOutput({ menuWindows: 0 }), /exactly one live context menu/],
    [trayQuitOutput({ trayAlive: 0 }), /tray window died/],
    [trayQuitOutput({ invokeResult: 0, invokeHresult: 2147500037 }), /accessibility invoke.*failed/]
  ]) assert.throws(() => parseTrayQuitOutput(output), message);
  assert.throws(
    () => parseTrayQuitOutput(trayQuitOutput({ invokeResult: 0, invokeHresult: 2147500037 }), 123),
    (error) =>
      error.message.includes("2147500037") &&
      error.message.includes("tray-quit") &&
      error.message.includes("3:Quit")
  );
  assert.throws(
    () => parseTrayQuitOutput(`${trayQuitOutput()}\nDEEPSEEK_API_KEY=do-not-echo`),
    /secret-like material/
  );
});

test("endpoint files must be rooted in the isolated LOCALAPPDATA tree", () => {
  const root = temp("yuvi-installer-smoke-");
  const local = path.join(root, "local");
  const state = path.join(local, "YUVI", "DesktopSupervisor");
  fs.mkdirSync(state, { recursive: true });
  const endpoint = path.join(state, "control-endpoint.json");
  assert.ok(isWithin(endpoint, local));
  assert.equal(isWithin(path.join(root, "outside", "endpoint.json"), local), false);
});

test("packaged mode is an explicit endpoint property", () => {
  const endpoint = { mode: "packaged", baseUrl: "http://127.0.0.1:1" };
  assert.equal(endpoint.mode, "packaged");
});

test("runtime and Mem0 owned status requires positive PIDs", () => {
  const services = [
    { id: "runtime", managed: true, ownership: "owned", pid: 11 },
    { id: "mem0", managed: true, ownership: "owned", pid: 12 }
  ];
  for (const service of services)
    assert.equal(service.managed && service.ownership === "owned" && service.pid > 0, true);
});

test("command-line checker rejects repo, target and unpackaged tools", () => {
  assert.throws(
    () => assertNoUnsafeCommandLine("C:\\repo\\target\\debug\\yuvi.exe"),
    /source\/tool|unpackaged/
  );
  assert.throws(
    () => assertNoUnsafeCommandLine("pnpm exec tsx supervisor.ts"),
    /source\/tool|unpackaged/
  );
});

test("process tree exit checks use exact PIDs", () => {
  const before = processBaseline([{ pid: 41, name: "yuvi-mem0.exe" }]);
  const after = processBaseline([{ pid: 41, name: "yuvi-mem0.exe" }]);
  assert.equal(after.has(41), before.has(41));
  assert.equal(after.has(42), false);
});

test("resource snapshot detects app-mode writes", () => {
  const root = temp();
  fs.writeFileSync(path.join(root, "packaging-info.json"), "before");
  const before = snapshotTree(root);
  fs.writeFileSync(path.join(root, "packaging-info.json"), "after");
  assert.equal(compareSnapshots(before, snapshotTree(root)).at(0).type, "changed");
});
