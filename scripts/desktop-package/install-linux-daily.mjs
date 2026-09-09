#!/usr/bin/env node
/** Install packaged Linux daily systemd units against immutable resource root (this directory). */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
if (process.platform !== "linux") throw new Error("Linux only");
const resourceRoot = fs.realpathSync(path.dirname(fileURLToPath(import.meta.url)));
const nodeBin = path.join(resourceRoot, "runtime", "node");
const supervisor = path.join(resourceRoot, "supervisor", "yuvi-desktop-supervisor.cjs");
const runtimeManifest = path.join(resourceRoot, "runtime", "runtime-manifest.json");
const webServer = path.join(resourceRoot, "web", "static-server.mjs");
const webDist = path.join(resourceRoot, "web", "dist");
const localStt = path.join(resourceRoot, "local-stt", "yuvi-local-stt");
const localSttManifest = path.join(resourceRoot, "local-stt", "local-stt-manifest.json");
const desktopShell = path.join(resourceRoot, "desktop", "yuvi-desktop");
const desktopLauncher = path.join(resourceRoot, "desktop", "yuvi-desktop-launcher");
for (const f of [
  nodeBin,
  supervisor,
  runtimeManifest,
  webServer,
  webDist,
  localStt,
  localSttManifest,
  desktopShell,
  desktopLauncher
]) {
  if (!fs.existsSync(f)) throw new Error("Missing packaged resource: " + f);
}
const xdg = (k, fb) => {
  const v = process.env[k];
  return v && path.isAbsolute(v) ? v : path.join(os.homedir(), fb);
};
const unitDir = path.join(xdg("XDG_CONFIG_HOME", ".config"), "systemd/user");
const applications = path.join(xdg("XDG_DATA_HOME", ".local/share"), "applications");
const envDir = path.resolve(
  process.env.YUVI_RUNTIME_ENV_DIR || path.join(xdg("XDG_CONFIG_HOME", ".config"), "YUVI")
);
if (process.argv.includes("--uninstall")) {
  for (const args of [
    ["--user", "disable", "--now", "yuvi-daily.service"],
    ["--user", "stop", "yuvi-daily-web.service"]
  ]) {
    const r = spawnSync("systemctl", args, { stdio: "inherit" });
    if (r.status !== 0) throw new Error("Unable to stop YUVI integration; resources retained.");
  }
  for (const file of [
    path.join(unitDir, "yuvi-daily.service"),
    path.join(unitDir, "yuvi-daily-web.service"),
    path.join(applications, "yuvi-daily.desktop")
  ])
    fs.rmSync(file, { force: true });
  const r = spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("Unable to reload user integration.");
  const marker = path.join(resourceRoot, "managed-install.json");
  if (fs.existsSync(marker)) {
    const { checkoutSha } = JSON.parse(fs.readFileSync(marker, "utf8"));
    if (
      path.basename(resourceRoot) !== checkoutSha ||
      path.basename(path.dirname(resourceRoot)) !== "releases"
    )
      throw new Error("Invalid managed resource identity; resources retained.");
    const base = path.dirname(path.dirname(resourceRoot));
    const current = path.join(base, "current");
    if (fs.existsSync(current) && fs.realpathSync(current) === resourceRoot) fs.unlinkSync(current);
    // Remove every version installed by this installer, including retained updates.
    for (const name of fs.readdirSync(path.join(base, "releases"))) {
      if (!/^[a-f0-9]{40}$/.test(name)) continue;
      const release = path.join(base, "releases", name);
      if (!fs.lstatSync(release).isDirectory()) continue;
      const receipt = path.join(release, "managed-install.json");
      if (
        fs.existsSync(receipt) &&
        JSON.parse(fs.readFileSync(receipt, "utf8")).checkoutSha === name
      ) {
        fs.rmSync(release, { recursive: true });
      }
    }
  }
  console.log(
    "YUVI integration and managed resources removed. Durable DATA and CONFIG are preserved."
  );
  process.exit(0);
}
fs.mkdirSync(envDir, { recursive: true, mode: 0o700 });
const stateRoot = path.join(xdg("XDG_DATA_HOME", ".local/share"), "YUVI/DesktopSupervisor");
const quote = (v) =>
  '"' + v.replace(/\\\\/g, "\\\\\\\\").replace(/"/g, '\\\\"').replace(/%/g, "%%") + '"';
const desktopExecArg = (v) =>
  '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%") + '"';
const pathEnv = ["/usr/local/bin", "/usr/bin", "/bin"].filter((p) => fs.existsSync(p)).join(":");
const common = (wd) =>
  `WorkingDirectory=${wd.replace(/%/g, "%%")}\nEnvironment=${quote("PATH=" + pathEnv)}\nEnvironment=${quote("YUVI_RUNTIME_ENV_DIR=" + envDir)}\nEnvironment=YUVI_DAILY_USE_SYSTEMD=1\nEnvironment=YUVI_PACKAGED_EXTERNAL_SIDECARS=1\nEnvironment=YUVI_POSTGRES_MODE=external\nEnvironment=YUVI_AUTOSTART_MEM0=0\nEnvironment=YUVI_AUTOSTART_LOCAL_STT=0\nTimeoutStopSec=90\nKillMode=mixed\n`;
fs.mkdirSync(unitDir, { recursive: true });
fs.mkdirSync(applications, { recursive: true });
const execDaily = `${quote(nodeBin)} ${quote(supervisor)} --mode packaged --resource-root ${quote(resourceRoot)} --state-root ${quote(stateRoot)} --runtime-manifest ${quote(runtimeManifest)}`;
fs.writeFileSync(
  path.join(unitDir, "yuvi-daily.service"),
  `[Unit]\nDescription=YUVI Linux daily-use Runtime (packaged)\nWants=yuvi-daily-web.service\n\n[Service]\n${common(resourceRoot)}ExecStart=${execDaily}\nRestart=on-failure\nRestartSec=5\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`,
  { mode: 0o600 }
);
fs.writeFileSync(
  path.join(unitDir, "yuvi-daily-web.service"),
  `[Unit]\nDescription=YUVI Linux Product WebUI (packaged static)\nPartOf=yuvi-daily.service\nAfter=yuvi-daily.service\n\n[Service]\n${common(path.join(resourceRoot, "web"))}ExecStart=${quote(nodeBin)} ${quote(webServer)} --root ${quote(webDist)} --host 127.0.0.1 --port 5173\nRestart=on-failure\nRestartSec=5\nUMask=0077\n`,
  { mode: 0o600 }
);
fs.writeFileSync(
  path.join(applications, "yuvi-daily.desktop"),
  `[Desktop Entry]\nType=Application\nName=YUVI\nComment=Open the YUVI desktop shell\nExec=${desktopExecArg(desktopLauncher)}\nTerminal=false\nCategories=Utility;\n`,
  { mode: 0o644 }
);
for (const args of [
  ["--user", "daemon-reload"],
  ["--user", "enable", "yuvi-daily.service"]
]) {
  const r = spawnSync("systemctl", args, { stdio: "inherit" });
  if (r.status !== 0) throw new Error("systemctl failed: " + args.join(" "));
}
console.log("Installed packaged YUVI daily from", resourceRoot);

if (process.argv.includes("--managed-install")) {
  const { checkoutSha } = JSON.parse(
    fs.readFileSync(path.join(resourceRoot, "install-manifest.json"), "utf8")
  );
  if (
    path.basename(resourceRoot) !== checkoutSha ||
    path.basename(path.dirname(resourceRoot)) !== "releases"
  )
    throw new Error("Invalid managed install path");
  fs.writeFileSync(
    path.join(resourceRoot, "managed-install.json"),
    JSON.stringify({ checkoutSha }),
    { mode: 0o600 }
  );
}
