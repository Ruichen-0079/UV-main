/** Install a login-persistent Linux checkout launcher. No model downloads, no database ownership. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux") throw new Error("This launcher is Linux-only.");
const action = process.argv[2] ?? "install";
const actions = ["install", "start", "stop", "restart", "diagnose", "uninstall"];
if (!actions.includes(action))
  throw new Error(`Usage: install-daily-use-linux.mts ${actions.join("|")}`);
function systemctl(...args: string[]) {
  const result = spawnSync("systemctl", ["--user", ...args], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("systemd user operation failed");
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const xdg = (key: string, fallback: string) => {
  const value = process.env[key];
  return value && path.isAbsolute(value) ? value : path.join(os.homedir(), fallback);
};
const unitDir = path.join(xdg("XDG_CONFIG_HOME", ".config"), "systemd/user");
const applications = path.join(xdg("XDG_DATA_HOME", ".local/share"), "applications");
if (["start", "stop", "restart"].includes(action)) {
  systemctl(action, "yuvi-daily.service");
  process.exit(0);
}
if (action === "diagnose") {
  // Fixed property allowlist: never environment, command lines, journal or private files.
  systemctl(
    "show",
    "yuvi-daily.service",
    "yuvi-daily-web.service",
    "-p",
    "Id",
    "-p",
    "ActiveState",
    "-p",
    "SubState",
    "-p",
    "Result",
    "-p",
    "NRestarts"
  );
  try {
    const response = await fetch("http://127.0.0.1:5173/yuvi-daily/status", {
      signal: AbortSignal.timeout(5000),
      redirect: "error"
    });
    if (!response.ok) throw new Error("Unavailable");
    const { projectDailyServiceStatus } = await import("../apps/web/src/daily-service-status.js");
    // Re-project even the existing public endpoint before export.
    const data = await response.json();
    const safe = projectDailyServiceStatus({
      services: data.services.map((s: object) => ({ ...s, checkedAt: data.checkedAt }))
    });
    console.log(JSON.stringify(safe, null, 2));
  } catch {
    console.log(
      "Supervisor observations unavailable. Open Product for live status; verify external PostgreSQL/Ollama prerequisites."
    );
    process.exitCode = 1;
  }
  process.exit(process.exitCode ?? 0);
}
if (action === "uninstall") {
  systemctl("disable", "--now", "yuvi-daily.service");
  systemctl("stop", "yuvi-daily-web.service");
  for (const file of [
    path.join(unitDir, "yuvi-daily.service"),
    path.join(unitDir, "yuvi-daily-web.service"),
    path.join(applications, "yuvi-daily.desktop")
  ]) {
    fs.rmSync(file, { force: true });
  }
  systemctl("daemon-reload");
  console.log(
    "Removed daily launcher. Configuration, Memory, profiles, models, references, checkout and external services are retained."
  );
  process.exit(0);
}
for (const file of ["node_modules/tsx/dist/cli.mjs", "apps/web/node_modules/vite/bin/vite.js"]) {
  if (!fs.existsSync(path.join(root, file)))
    throw new Error("Run pnpm install --frozen-lockfile before installation.");
}
const envDir = path.resolve(process.env["YUVI_RUNTIME_ENV_DIR"] || root);
if (!fs.existsSync(path.join(envDir, ".env.local"))) {
  throw new Error(
    "Configure .env.local first (optionally in YUVI_RUNTIME_ENV_DIR). No models or external services are provisioned by this installer."
  );
}
// Explicit paths and systemd quoting, never shell interpolation of configuration.
const quote = (value: string) =>
  `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
for (const value of [root, envDir, process.execPath, process.env["PATH"] || ""]) {
  if (/[\r\n\0]/.test(value))
    throw new Error("Launcher paths must not contain control characters.");
}
fs.mkdirSync(unitDir, { recursive: true });
fs.mkdirSync(applications, { recursive: true });
const node = process.execPath;
// Persist stable executable locations, not pnpm injection or agent temporary paths.
const processPath = [
  ...new Set(
    (process.env["PATH"] || "/usr/local/bin:/usr/bin:/bin")
      .split(path.delimiter)
      .filter(
        (entry) =>
          path.isAbsolute(entry) &&
          fs.existsSync(entry) &&
          !entry.includes("/tmp/") &&
          !entry.includes("/node_modules/")
      )
  )
].join(path.delimiter);
const common = (workingDirectory: string) =>
  `WorkingDirectory=${workingDirectory.replace(/%/g, "%%")}\nEnvironment=${quote(`PATH=${processPath}`)}\nEnvironment=${quote(`YUVI_RUNTIME_ENV_DIR=${envDir}`)}\nEnvironment=YUVI_DAILY_USE_SYSTEMD=1\nTimeoutStopSec=90\nKillMode=mixed\n`;
fs.writeFileSync(
  path.join(unitDir, "yuvi-daily.service"),
  `[Unit]
Description=YUVI Linux daily-use Runtime and local sidecars (checkout)
Wants=yuvi-daily-web.service

[Service]
${common(root)}ExecStart=${quote(node)} ${quote(path.join(root, "node_modules/tsx/dist/cli.mjs"))} ${quote(path.join(root, "scripts/yuvi-desktop-supervisor.mts"))} --repo-root ${quote(root)}
Restart=on-failure
RestartSec=5
UMask=0077

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
UMask=0077
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
