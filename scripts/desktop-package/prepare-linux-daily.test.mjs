import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { LINUX_LOCAL_STT_MANIFEST } from "./build-local-stt.mjs";

const root = path.resolve(import.meta.dirname, "../..");

test("linux daily prepare packages the Local STT sidecar instead of adapter sources", () => {
  const source = fs.readFileSync(new URL("./prepare-linux-daily.mjs", import.meta.url), "utf8");
  assert.match(source, /buildPackagedLocalStt/);
  assert.match(source, /genericLocalSttWeightsBundled: true/);
  assert.match(source, /local-stt-sidecar/);
  assert.match(source, /tauri-desktop-shell/);
  assert.match(source, /YUVI_LINUX_DESKTOP_BINARY/);
  assert.match(source, /yuvi-desktop-launcher/);
  assert.equal(
    source.includes('copyTreeFiltered(path.join(REPO_ROOT, "services", "local-stt")'),
    false
  );
  assert.doesNotMatch(source, /services", "memory-mem0"/);
  assert.doesNotMatch(source, /YUVI_LOCAL_STT_START_COMMAND/);
});

test("linux daily installer leaves packaged Local STT stopped without a route", () => {
  const source = fs.readFileSync(new URL("./install-linux-daily.mjs", import.meta.url), "utf8");
  assert.match(source, /YUVI_AUTOSTART_LOCAL_STT=0/);
  assert.match(source, /local-stt", "yuvi-local-stt"/);
  assert.doesNotMatch(source, /YUVI_LOCAL_STT_START_COMMAND/);
  assert.match(source, /YUVI_PACKAGED_EXTERNAL_SIDECARS=1/);
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
      fs.mkdirSync(path.join(resource, "desktop"), { recursive: true });
      fs.writeFileSync(path.join(resource, "desktop", "yuvi-desktop"), "ELF\n", { mode: 0o755 });
      fs.writeFileSync(
        path.join(resource, "desktop", "yuvi-desktop-launcher"),
        "#!/bin/sh\nexit 0\n",
        { mode: 0o755 }
      );
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
      assert.match(unit, /YUVI_PACKAGED_EXTERNAL_SIDECARS=1/);
      assert.doesNotMatch(unit, /YUVI_LOCAL_STT_START_COMMAND/);
      const desktopEntry = fs.readFileSync(
        path.join(home, "data/applications/yuvi-daily.desktop"),
        "utf8"
      );
      assert.match(desktopEntry, /yuvi-desktop-launcher/);
      assert.doesNotMatch(desktopEntry, /xdg-open/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
);
