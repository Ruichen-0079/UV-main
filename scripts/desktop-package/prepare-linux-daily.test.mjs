import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { LINUX_LOCAL_STT_MANIFEST } from "./build-local-stt.mjs";
import {
  readPortablePackageIdentity,
  resolvePortableStateDirs,
  resolvePortableStateRoot
} from "./portable-state.mjs";

const root = path.resolve(import.meta.dirname, "../..");

test("linux daily prepare packages managed Memory and Local STT without adapter sources", () => {
  const source = fs.readFileSync(new URL("./prepare-linux-daily.mjs", import.meta.url), "utf8");
  assert.match(source, /buildPackagedLocalStt/);
  assert.match(source, /buildLinuxPackagedMem0/);
  assert.match(source, /stageLinuxPostgresDistribution/);
  assert.match(source, /postgresql-16-pgvector/);
  assert.match(source, /mem0-sidecar/);
  assert.match(source, /managedMemorySidecars: true/);
  assert.match(source, /genericLocalSttWeightsBundled: true/);
  assert.match(source, /local-stt-sidecar/);
  assert.match(source, /tauri-desktop-shell/);
  assert.match(source, /YUVI_LINUX_DESKTOP_BINARY/);
  assert.match(source, /yuvi-desktop-launcher/);
  assert.match(source, /portable-state\.mjs/);
  assert.equal(
    source.includes('copyTreeFiltered(path.join(REPO_ROOT, "services", "local-stt")'),
    false
  );
  assert.doesNotMatch(source, /services", "memory-mem0"/);
  assert.doesNotMatch(source, /YUVI_LOCAL_STT_START_COMMAND/);
});

test("linux desktop launchers prefer XWayland for reliable topmost semantics", () => {
  const installedLauncher = fs.readFileSync(
    new URL("./yuvi-desktop-linux", import.meta.url),
    "utf8"
  );
  assert.match(installedLauncher, /GDK_BACKEND/);
  assert.match(installedLauncher, /WAYLAND_DISPLAY/);
  assert.match(installedLauncher, /DISPLAY/);
  assert.match(installedLauncher, /export GDK_BACKEND=x11/);
  assert.ok(installedLauncher.includes('[ -z "${GDK_BACKEND:-}" ]'));

  const portableLauncher = fs.readFileSync(
    new URL("./linux-launcher.mjs", import.meta.url),
    "utf8"
  );
  assert.match(portableLauncher, /guiSessionEnv\.WAYLAND_DISPLAY/);
  assert.match(portableLauncher, /guiSessionEnv\.DISPLAY/);
  assert.match(portableLauncher, /desktopEnv\.GDK_BACKEND = 'x11'/);
  assert.match(portableLauncher, /process\.env\.GDK_BACKEND/);
  assert.match(portableLauncher, /readPortablePackageIdentity\(root\)/);
  assert.match(portableLauncher, /resolvePortableStateRoot/);
  assert.match(portableLauncher, /YUVI_CONFIG_ROOT: dirs\.config/);
  assert.match(portableLauncher, /YUVI_DATA_ROOT: dirs\.data/);
  assert.match(portableLauncher, /YUVI_CACHE_ROOT: dirs\.cache/);
  assert.match(portableLauncher, /YUVI_SUPERVISOR_STATE_ROOT: dirs\.supervisor/);
  assert.match(portableLauncher, /TMPDIR: dirs\.tmp/);
});

test("linux daily installer keeps Local STT route-controlled and no longer disables managed Memory", () => {
  const source = fs.readFileSync(new URL("./install-linux-daily.mjs", import.meta.url), "utf8");
  assert.match(source, /YUVI_AUTOSTART_LOCAL_STT=0/);
  assert.match(source, /local-stt", "yuvi-local-stt"/);
  assert.match(source, /mem0", "yuvi-mem0"/);
  assert.match(source, /postgres", "bin", "postgres"/);
  assert.match(source, /vector\.control/);
  assert.doesNotMatch(source, /YUVI_LOCAL_STT_START_COMMAND/);
  assert.doesNotMatch(source, /YUVI_PACKAGED_EXTERNAL_SIDECARS=1/);
  assert.doesNotMatch(source, /YUVI_POSTGRES_MODE=external/);
  assert.doesNotMatch(source, /YUVI_AUTOSTART_MEM0=0/);
  assert.match(source, /yuvi-desktop-launcher/);
  assert.doesNotMatch(source, /Exec=xdg-open/);
});

test("SenseVoice license files are present for redistribution", () => {
  const license = fs.readFileSync(
    path.join(root, "services/local-stt/licenses/FUNASR_MODEL_LICENSE.txt"),
    "utf8"
  );
  assert.match(license, /FunASR Model Open Source License Agreement/);
  assert.match(license, /Version: 1\.1/);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "services/local-stt/models.manifest.json"), "utf8")
  );
  assert.equal(
    manifest.models.find((model) => model.role === "asr").license,
    "FunASR-Model-License-v1.1"
  );
  assert.equal(LINUX_LOCAL_STT_MANIFEST.platform, "linux");
});

test(
  "linux daily installer needs no env file and leaves Local STT nonresident",
  { skip: process.platform !== "linux" },
  () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-linux-stt-install-"));
    try {
      const resource = path.join(home, "pkg");
      fs.mkdirSync(path.join(resource, "runtime"), { recursive: true });
      fs.mkdirSync(path.join(resource, "supervisor"), { recursive: true });
      fs.mkdirSync(path.join(resource, "web", "dist"), { recursive: true });
      fs.mkdirSync(path.join(resource, "local-stt"), { recursive: true });
      fs.mkdirSync(path.join(resource, "mem0"), { recursive: true });
      fs.mkdirSync(path.join(resource, "postgres", "bin"), { recursive: true });
      fs.mkdirSync(path.join(resource, "postgres", "share", "extension"), { recursive: true });
      fs.writeFileSync(path.join(resource, "runtime", "node"), "#!/bin/true\n", { mode: 0o755 });
      fs.writeFileSync(
        path.join(resource, "supervisor", "yuvi-desktop-supervisor.cjs"),
        "export {};\n"
      );
      fs.writeFileSync(path.join(resource, "runtime", "runtime-manifest.json"), "{}\n");
      fs.writeFileSync(path.join(resource, "web", "static-server.mjs"), "export {};\n");
      fs.writeFileSync(path.join(resource, "web", "dist", "index.html"), "<html></html>\n");
      fs.writeFileSync(path.join(resource, "local-stt", "yuvi-local-stt"), "ELF\n", {
        mode: 0o755
      });
      fs.writeFileSync(path.join(resource, "local-stt", "local-stt-manifest.json"), "{}\n");
      fs.writeFileSync(path.join(resource, "mem0", "yuvi-mem0"), "#!/bin/true\n", { mode: 0o755 });
      fs.writeFileSync(path.join(resource, "mem0", "mem0-manifest.json"), "{}\n");
      for (const tool of ["postgres", "pg_ctl", "initdb"]) {
        fs.writeFileSync(path.join(resource, "postgres", "bin", tool), "#!/bin/true\n", {
          mode: 0o755
        });
      }
      fs.writeFileSync(
        path.join(resource, "postgres", "share", "extension", "vector.control"),
        "default_version='0.8.6'\n"
      );
      fs.mkdirSync(path.join(resource, "desktop"), { recursive: true });
      fs.writeFileSync(path.join(resource, "desktop", "yuvi-desktop"), "ELF\n", { mode: 0o755 });
      fs.writeFileSync(
        path.join(resource, "desktop", "yuvi-desktop-launcher"),
        "#!/bin/sh\nexit 0\n",
        { mode: 0o755 }
      );
      fs.writeFileSync(path.join(resource, "desktop", "yuvi.png"), "PNG");
      fs.copyFileSync(
        path.join(root, "scripts/desktop-package/install-linux-daily.mjs"),
        path.join(resource, "install-linux-daily.mjs")
      );
      const envDir = path.join(home, "env");
      fs.mkdirSync(envDir);
      const bin = path.join(home, "bin");
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const rerun = spawnSync(process.execPath, [path.join(resource, "install-linux-daily.mjs")], {
        cwd: resource,
        env: {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: path.join(home, "config"),
          XDG_DATA_HOME: path.join(home, "data"),
          YUVI_RUNTIME_ENV_DIR: envDir,
          PATH: `${bin}:/usr/bin:/bin`
        },
        encoding: "utf8"
      });
      assert.equal(rerun.status, 0, rerun.stderr);
      const unit = fs.readFileSync(
        path.join(home, "config/systemd/user/yuvi-daily.service"),
        "utf8"
      );
      assert.match(unit, /YUVI_AUTOSTART_LOCAL_STT=0/);
      assert.doesNotMatch(unit, /YUVI_PACKAGED_EXTERNAL_SIDECARS=1/);
      assert.doesNotMatch(unit, /YUVI_POSTGRES_MODE=external/);
      assert.doesNotMatch(unit, /YUVI_AUTOSTART_MEM0=0/);
      assert.doesNotMatch(unit, /YUVI_LOCAL_STT_START_COMMAND/);
      const desktopEntry = fs.readFileSync(
        path.join(home, "data/applications/yuvi-daily.desktop"),
        "utf8"
      );
      assert.match(desktopEntry, /yuvi-desktop-launcher/);
      assert.ok(desktopEntry.includes(`Icon=${path.join(resource, "desktop", "yuvi.png")}`));
      assert.doesNotMatch(desktopEntry, /xdg-open/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
);

function writePortableManifest(packageRoot, version, checkoutSha) {
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "install-manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "yuvi-linux-daily-packaged",
      platform: "linux-x64",
      checkoutSha,
      version
    })
  );
}

test("portable package identity comes from install-manifest and rejects malformed identity", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-portable-identity-"));
  try {
    writePortableManifest(fixture, "0.1.2", "2".repeat(40));
    assert.deepEqual(readPortablePackageIdentity(fixture), {
      version: "0.1.2",
      checkoutSha: "2".repeat(40)
    });

    fs.writeFileSync(
      path.join(fixture, "install-manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "yuvi-linux-daily-packaged",
        platform: "linux-x64",
        checkoutSha: "2".repeat(40),
        version: "../0.1.2"
      })
    );
    assert.throws(() => readPortablePackageIdentity(fixture), /identity is invalid/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("new Portable release does not adopt old Product or Live2D state", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-portable-state-version-"));
  try {
    const xdgData = path.join(fixture, "xdg-data");
    const xdgConfig = path.join(fixture, "xdg-config");
    const oldPackage = path.join(fixture, "packages", "old");
    const newPackage = path.join(fixture, "packages", "new");
    writePortableManifest(oldPackage, "0.1.1", "1".repeat(40));
    writePortableManifest(newPackage, "0.1.2", "2".repeat(40));

    const env = { XDG_DATA_HOME: xdgData };
    const oldVersionedState = resolvePortableStateRoot({
      packageRoot: oldPackage,
      env,
      home: fixture
    });
    const newState = resolvePortableStateRoot({
      packageRoot: newPackage,
      env,
      home: fixture
    });
    assert.equal(oldVersionedState, path.join(xdgData, "YUVI", "portable", "0.1.1"));
    assert.equal(newState, path.join(xdgData, "YUVI", "portable", "0.1.2"));
    assert.notEqual(newState, oldVersionedState);

    // Exact v0.1.1 baseline before A2: all Portable state lived directly under
    // .../YUVI/portable/{config,data,cache,supervisor,...}.
    const legacyState = path.join(xdgData, "YUVI", "portable");
    const legacyConfig = path.join(legacyState, "config");
    const legacyLive2d = path.join(legacyState, "data", "yuvi", "live2d-models", "fake-model");
    const legacySupervisor = path.join(legacyState, "supervisor");
    const legacyCache = path.join(legacyState, "cache");
    fs.mkdirSync(legacyConfig, { recursive: true });
    fs.mkdirSync(legacyLive2d, { recursive: true });
    fs.mkdirSync(legacySupervisor, { recursive: true });
    fs.mkdirSync(legacyCache, { recursive: true });
    fs.writeFileSync(
      path.join(legacyConfig, "product-settings.json"),
      JSON.stringify({ revision: 11, activeModel: "old-model" })
    );
    fs.writeFileSync(
      path.join(legacyLive2d, "entry.json"),
      JSON.stringify({ name: "old-model" })
    );
    fs.writeFileSync(path.join(legacySupervisor, "active-instance.json"), '{"instanceId":"old"}');
    fs.writeFileSync(path.join(legacyCache, "old.cache"), "old-cache");

    const newDirs = resolvePortableStateDirs(newState);
    // Simulate the newer package's first launch directory initialization.
    for (const dir of Object.values(newDirs)) fs.mkdirSync(dir, { recursive: true });

    const newProductSettings = path.join(newDirs.config, "product-settings.json");
    const newLive2dRoot = path.join(newDirs.data, "yuvi", "live2d-models");
    const newSupervisorPointer = path.join(newDirs.supervisor, "active-instance.json");
    const newOldCache = path.join(newDirs.cache, "old.cache");
    assert.equal(fs.existsSync(newProductSettings), false);
    assert.equal(fs.existsSync(path.join(newLive2dRoot, "fake-model")), false);
    assert.equal(fs.existsSync(newSupervisorPointer), false);
    assert.equal(fs.existsSync(newOldCache), false);

    // Old v0.1.1 state is preserved exactly; A2 performs no migration/deletion.
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(legacyConfig, "product-settings.json"), "utf8")),
      { revision: 11, activeModel: "old-model" }
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(legacyLive2d, "entry.json"), "utf8")),
      { name: "old-model" }
    );
    assert.equal(
      fs.readFileSync(path.join(legacySupervisor, "active-instance.json"), "utf8"),
      '{"instanceId":"old"}'
    );
    assert.equal(fs.readFileSync(path.join(legacyCache, "old.cache"), "utf8"), "old-cache");

    // Installed roots remain separate from the Portable release namespace.
    const installedConfig = path.join(xdgConfig, "YUVI");
    const installedSupervisor = path.join(xdgData, "YUVI", "DesktopSupervisor");
    assert.equal(newDirs.config.startsWith(installedConfig + path.sep), false);
    assert.equal(newDirs.supervisor.startsWith(installedSupervisor + path.sep), false);
    assert.notEqual(newDirs.config, installedConfig);
    assert.notEqual(newDirs.supervisor, installedSupervisor);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("same-version relocation keeps the same Portable namespace and explicit override remains exact", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-portable-relocation-"));
  try {
    const xdgData = path.join(fixture, "xdg-data");
    const packageA = path.join(fixture, "extract-a");
    const packageB = path.join(fixture, "移动后的 YUVI");
    writePortableManifest(packageA, "0.1.2", "a".repeat(40));
    writePortableManifest(packageB, "0.1.2", "b".repeat(40));

    const env = { XDG_DATA_HOME: xdgData };
    const stateA = resolvePortableStateRoot({ packageRoot: packageA, env, home: fixture });
    const stateB = resolvePortableStateRoot({ packageRoot: packageB, env, home: fixture });
    assert.equal(stateA, stateB);
    assert.equal(stateA, path.join(xdgData, "YUVI", "portable", "0.1.2"));

    const explicit = path.join(fixture, "operator-selected-state");
    const overridden = resolvePortableStateRoot({
      packageRoot: packageB,
      env: {
        XDG_DATA_HOME: xdgData,
        YUVI_PORTABLE_STATE_ROOT: explicit
      },
      home: fixture
    });
    assert.equal(overridden, explicit);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
