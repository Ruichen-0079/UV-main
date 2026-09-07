/** Install a login-persistent Linux checkout launcher. No model downloads, no database ownership. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux") throw new Error("This launcher is Linux-only.");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const unitDir = path.join(
  process.env["XDG_CONFIG_HOME"] || path.join(os.homedir(), ".config"),
  "systemd/user"
);
const applications = path.join(
  process.env["XDG_DATA_HOME"] || path.join(os.homedir(), ".local/share"),
  "applications"
);
// Explicit paths and systemd quoting, never shell interpolation of configuration.
const quote = (value: string) =>
  `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
fs.mkdirSync(unitDir, { recursive: true });
fs.mkdirSync(applications, { recursive: true });
const node = process.execPath;
const processPath = process.env["PATH"] || "/usr/local/bin:/usr/bin:/bin";
const common = (workingDirectory: string) =>
  `WorkingDirectory=${workingDirectory.replace(/%/g, "%%")}\nEnvironment=${quote(`PATH=${processPath}`)}\nEnvironment=YUVI_DAILY_USE_SYSTEMD=1\nTimeoutStopSec=90\nKillMode=mixed\n`;
fs.writeFileSync(
  path.join(unitDir, "yuvi-daily.service"),
  `[Unit]
Description=YUVI Linux daily-use Runtime and local sidecars (checkout)
Wants=yuvi-daily-web.service

[Service]
${common(root)}ExecStart=${quote(node)} ${quote(path.join(root, "node_modules/tsx/dist/cli.mjs"))} ${quote(path.join(root, "scripts/yuvi-desktop-supervisor.mts"))} --repo-root ${quote(root)}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`,
  { mode: 0o600 }
);
fs.writeFileSync(
  path.join(unitDir, "yuvi-daily-web.service"),
  `[Unit]
Description=YUVI Linux Product WebUI (checkout)
PartOf=yuvi-daily.service
After=yuvi-daily.service

[Service]
${common(path.join(root, "apps/web"))}ExecStart=${quote(node)} ${quote(path.join(root, "apps/web/node_modules/vite/bin/vite.js"))} --config ${quote(path.join(root, "apps/web/vite.config.ts"))} ${quote(path.join(root, "apps/web"))} --host 127.0.0.1 --port 5173 --strictPort
Restart=on-failure
RestartSec=5
`,
  { mode: 0o600 }
);
fs.writeFileSync(
  path.join(applications, "yuvi-daily.desktop"),
  `[Desktop Entry]
Type=Application
Name=YUVI Daily
Comment=Open the Linux Product WebUI
Exec=xdg-open http://127.0.0.1:5173/#/webui
Terminal=false
Categories=Utility;
`,
  { mode: 0o644 }
);
for (const args of [
  ["--user", "daemon-reload"],
  ["--user", "enable", "yuvi-daily.service"]
]) {
  const result = spawnSync("systemctl", args, { stdio: "inherit" });
  if (result.status !== 0) throw new Error("systemd user unit installation failed");
}
console.log(
  "Installed YUVI Daily. Start: systemctl --user start yuvi-daily.service. Stop: systemctl --user stop yuvi-daily.service. PostgreSQL and Ollama remain external services."
);
