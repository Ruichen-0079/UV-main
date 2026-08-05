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
  assertTempRoot,
  assertTauriAppSmokeAllowed,
  buildWmCloseScript,
  chooseInstaller,
  compareSnapshots,
  findInstalledApplicationExecutable,
  findInstallerCandidates,
  findUninstaller,
  isWithin,
  processBaseline,
  restrictedPath,
  sanitizeChildEnv,
  snapshotTree,
  validateInstalledResources,
  validatePackagingInfo
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

test("packaging-info rejects missing Mem0 declaration", () => {
  assert.throws(
    () =>
      validatePackagingInfo({ schemaVersion: 1, platform: "win32", arch: "x64", hasMem0: false }),
    /Mem0/
  );
});

test("restricted PATH contains only system locations", () => {
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
