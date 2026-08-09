import assert from "node:assert/strict";
import fs from "node:fs";
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
  createDiagnosticPortRoles,
  createOwnershipDiagnostics,
  FORBIDDEN_PATH_TOOLS,
  formatOwnershipDiagnostic,
  findInstalledApplicationExecutable,
  findInstallerCandidates,
  findUninstaller,
  findUniqueSupervisorExecutable,
  isWithin,
  processBaseline,
  parseEmbeddedSupervisorBuildInfo,
  removeTreeWithRetries,
  restrictedPath,
  restrictedWindowsPath,
  readOwnershipMetadataDiagnostic,
  sanitizeChildEnv,
  snapshotTree,
  assertSupervisorProvenance,
  waitForSpecificPidsExit,
  waitForTauriBootstrapReady,
  validateInstalledResources,
  validatePackagingInfo,
  validateSupervisorProvenance
} from "./installer-smoke.mjs";

const temp = (prefix = "yuvi-installer-test-") => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

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
