#!/usr/bin/env node
/** Install packaged Linux daily systemd units against immutable resource root (this directory). */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
if (process.platform !== "linux") throw new Error("Linux only");
const resourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const nodeBin = path.join(resourceRoot, "runtime", "node");
const supervisor = path.join(resourceRoot, "supervisor", "yuvi-desktop-supervisor.cjs");
const runtimeManifest = path.join(resourceRoot, "runtime", "runtime-manifest.json");
const webServer = path.join(resourceRoot, "web", "static-server.mjs");
const webDist = path.join(resourceRoot, "web", "dist");
for (const f of [nodeBin, supervisor, runtimeManifest, webServer, webDist]) { if (!fs.existsSync(f)) throw new Error("Missing packaged resource: " + f); }
const xdg = (k, fb) => { const v = process.env[k]; return v && path.isAbsolute(v) ? v : path.join(os.homedir(), fb); };
const unitDir = path.join(xdg("XDG_CONFIG_HOME", ".config"), "systemd/user");
const applications = path.join(xdg("XDG_DATA_HOME", ".local/share"), "applications");
const envDir = path.resolve(process.env.YUVI_RUNTIME_ENV_DIR || path.join(os.homedir(), ".config/yuvi-daily"));
if (!fs.existsSync(path.join(envDir, ".env.local"))) throw new Error("Configure .env.local in YUVI_RUNTIME_ENV_DIR first");
const stateRoot = path.join(xdg("XDG_DATA_HOME", ".local/share"), "YUVI/DesktopSupervisor");
const quote = (v) => "\"" + v.replace(/\\\\/g, "\\\\\\\\").replace(/"/g, "\\\\\"").replace(/%/g, "%%") + "\"";
const pathEnv = ["/usr/local/bin", "/usr/bin", "/bin"].filter((p) => fs.existsSync(p)).join(":");
const common = (wd) => `WorkingDirectory=${wd.replace(/%/g, "%%")}\nEnvironment=${quote("PATH=" + pathEnv)}\nEnvironment=${quote("YUVI_RUNTIME_ENV_DIR=" + envDir)}\nEnvironment=YUVI_DAILY_USE_SYSTEMD=1\nEnvironment=YUVI_PACKAGED_EXTERNAL_SIDECARS=1\nEnvironment=YUVI_POSTGRES_MODE=external\nTimeoutStopSec=90\nKillMode=mixed\n`;
fs.mkdirSync(unitDir, { recursive: true }); fs.mkdirSync(applications, { recursive: true });
const execDaily = `${quote(nodeBin)} ${quote(supervisor)} --mode packaged --resource-root ${quote(resourceRoot)} --state-root ${quote(stateRoot)} --runtime-manifest ${quote(runtimeManifest)}`;
fs.writeFileSync(path.join(unitDir, "yuvi-daily.service"), `[Unit]\nDescription=YUVI Linux daily-use Runtime (packaged)\nWants=yuvi-daily-web.service\n\n[Service]\n${common(resourceRoot)}ExecStart=${execDaily}\nRestart=on-failure\nRestartSec=5\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`, { mode: 0o600 });
fs.writeFileSync(path.join(unitDir, "yuvi-daily-web.service"), `[Unit]\nDescription=YUVI Linux Product WebUI (packaged static)\nPartOf=yuvi-daily.service\nAfter=yuvi-daily.service\n\n[Service]\n${common(path.join(resourceRoot, "web"))}ExecStart=${quote(nodeBin)} ${quote(webServer)} --root ${quote(webDist)} --host 127.0.0.1 --port 5173\nRestart=on-failure\nRestartSec=5\nUMask=0077\n`, { mode: 0o600 });
fs.writeFileSync(path.join(applications, "yuvi-daily.desktop"), `[Desktop Entry]\nType=Application\nName=YUVI Daily\nComment=Open the Linux Product WebUI\nExec=xdg-open http://127.0.0.1:5173/#/webui\nTerminal=false\nCategories=Utility;\n`, { mode: 0o644 });
for (const args of [["--user", "daemon-reload"], ["--user", "enable", "yuvi-daily.service"]]) { const r = spawnSync("systemctl", args, { stdio: "inherit" }); if (r.status !== 0) throw new Error("systemctl failed: " + args.join(" ")); }
console.log("Installed packaged YUVI daily from", resourceRoot);
