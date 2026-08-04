/**
 * Long-lived desktop service supervisor process.
 * Spawned by Tauri (dev mode). Loopback HTTP control only + control-token auth.
 *
 * Usage:
 *   pnpm exec tsx scripts/yuvi-desktop-supervisor.mts --repo-root C:\Dev\UV-main
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DesktopSupervisor,
  loadSupervisorConfig,
  startSupervisorHttpServer,
  type ControlEndpointFile
} from "../packages/desktop-supervisor/src/index.ts";

const args = parseArgs(process.argv.slice(2));
const repoRoot =
  args["repo-root"] ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const config = loadSupervisorConfig({
  repositoryRoot: repoRoot,
  controlPort: args.port ? Number(args.port) : 0,
  controlHost: "127.0.0.1"
});

fs.mkdirSync(config.stateDirectory, { recursive: true });
// Restrict directory ACL to current user when possible (Windows).
restrictToCurrentUser(config.stateDirectory);

// Active-instance pointer (no token): helps Rust discover the latest endpoint path.
const activePointer = path.join(defaultDesktopSupervisorRoot(), "active-instance.json");
const endpointFile = path.join(config.stateDirectory, "control-endpoint.json");
// Drop stale endpoint before publishing so we never attach to an old PID.
try {
  fs.unlinkSync(endpointFile);
} catch {
  // ignore
}

const supervisor = new DesktopSupervisor(config);
const { server, port, host } = await startSupervisorHttpServer(supervisor, {
  host: config.controlHost,
  port: config.controlPort,
  controlToken: config.controlToken
});

const endpoint: ControlEndpointFile = {
  host,
  port,
  baseUrl: `http://${host}:${port}`,
  instanceId: config.instanceId,
  pid: process.pid,
  startedAt: new Date().toISOString(),
  // Token is for the Tauri parent only. Never printed below.
  controlToken: config.controlToken
};
writeEndpointSecure(endpointFile, endpoint);
// Pointer file has no controlToken — only path metadata for discovery.
fs.writeFileSync(
  activePointer,
  `${JSON.stringify(
    {
      instanceId: config.instanceId,
      pid: process.pid,
      endpointFile,
      stateDirectory: config.stateDirectory,
      startedAt: endpoint.startedAt
    },
    null,
    2
  )}\n`,
  "utf8"
);
restrictToCurrentUser(activePointer);

// Logs must never include controlToken / env secrets.
console.log(
  JSON.stringify({
    ok: true,
    event: "supervisor.listening",
    baseUrl: `http://${host}:${port}`,
    instanceId: config.instanceId,
    stateDirectory: config.stateDirectory,
    pid: process.pid
  })
);

supervisor.startBackgroundRefresh(3_000);
void supervisor.bootstrap().then((snap) => {
  console.log(
    JSON.stringify({
      ok: true,
      event: "supervisor.bootstrap",
      services: snap.services.map((s) => ({
        id: s.id,
        status: s.status,
        ownership: s.ownership
      }))
    })
  );
});

let shuttingDown = false;
async function gracefulShutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ ok: true, event: "supervisor.shutdown", reason }));
  try {
    await supervisor.shutdown();
  } finally {
    server.close();
    try {
      fs.unlinkSync(endpointFile);
    } catch {
      // ignore
    }
    process.exit(0);
  }
}

process.on("SIGINT", () => {
  void gracefulShutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void gracefulShutdown("SIGTERM");
});

function writeEndpointSecure(filePath: string, data: ControlEndpointFile): void {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  restrictToCurrentUser(filePath);
}

function restrictToCurrentUser(targetPath: string): void {
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(targetPath, 0o600);
    } catch {
      // ignore
    }
    return;
  }
  try {
    const user = process.env["USERNAME"] ?? "";
    if (!user) return;
    // Current user full control; remove inheritance for tighter local ACL.
    spawnSync(
      "icacls",
      [targetPath, "/inheritance:r", "/grant:r", `${user}:(F)`],
      { windowsHide: true, timeout: 5_000 }
    );
  } catch {
    // Best-effort only.
  }
}

function defaultDesktopSupervisorRoot(): string {
  const local = process.env["LOCALAPPDATA"];
  if (local && local.trim()) {
    return path.join(local, "YUVI", "DesktopSupervisor");
  }
  return path.join(process.cwd(), ".yuvi-desktop-supervisor");
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? "";
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = "true";
    }
  }
  return out;
}
