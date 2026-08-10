import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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
  buildWmCloseScript,
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
  formatTauriFailureDiagnostic,
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
  pathsEqualWindows,
  processBaseline,
  requestJson,
  parseEmbeddedSupervisorBuildInfo,
  removeTreeWithRetries,
  restrictedPath,
  restrictedWindowsPath,
  readOwnershipMetadataDiagnostic,
  resolveExistingWindowsPathForComparison,
  sanitizeChildEnv,
  snapshotTree,
  assertSupervisorProvenance,
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
    runtimeEntry: "runtime/yuvi-runtime-server.mjs",
    nodeExecutable: "runtime/node.exe",
    mem0Executable: "mem0/yuvi-mem0.exe",
    mem0Manifest: "mem0/mem0-manifest.json"
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
        runtimeEntry: "C:\\repo\\runtime.mjs",
        nodeExecutable: "runtime/node.exe",
        mem0Executable: "mem0/yuvi-mem0.exe",
        mem0Manifest: "mem0/mem0-manifest.json"
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

test("WM_CLOSE command targets a numeric PID only", () => {
  const script = buildWmCloseScript(12345);
  assert.match(script, /targetPid = 12345/);
  assert.match(script, /GetWindowThreadProcessId/);
  assert.match(script, /PostMessageW/);
  assert.doesNotMatch(script, /WindowText|title|Alt\+F4/i);
});

test("WM_CLOSE command rejects invalid PIDs", () => {
  assert.throws(() => buildWmCloseScript(0), /invalid/);
  assert.throws(() => buildWmCloseScript("pid"), /invalid/);
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
