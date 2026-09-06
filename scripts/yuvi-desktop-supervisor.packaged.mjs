/**
 * Packaged-entry wrapper for the desktop supervisor.
 * Bundled to CJS (no top-level await / import.meta).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DesktopSupervisor,
  acquireSupervisorInstanceLock,
  loadSupervisorConfig,
  loadPackagedSupervisorConfig,
  startSupervisorHttpServer
} from "../packages/desktop-supervisor/src/index.ts";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (Object.prototype.hasOwnProperty.call(args, "build-info-json")) {
    const buildInfo = globalThis.__YUVI_SUPERVISOR_BUILD_INFO__;
    if (!buildInfo || buildInfo.schemaVersion !== 1 || buildInfo.mode !== "pkg-exe") {
      throw new Error("embedded Supervisor build identity is unavailable");
    }
    process.stdout.write(`${JSON.stringify(buildInfo)}\n`);
    return;
  }
  const mode = (args.mode ?? "development").toLowerCase();

  const config =
    mode === "packaged"
      ? loadPackagedSupervisorConfig({
          resourceRoot: required(args, "resource-root"),
          dataRoot: required(args, "state-root"),
          runtimeManifestPath: required(args, "runtime-manifest"),
          mem0ManifestPath: required(args, "mem0-manifest"),
          controlPort: args.port ? Number(args.port) : 0,
          controlHost: "127.0.0.1"
        })
      : loadSupervisorConfig({
          repositoryRoot: args["repo-root"] ?? process.cwd(),
          controlPort: args.port ? Number(args.port) : 0,
          controlHost: "127.0.0.1"
        });

  fs.mkdirSync(config.stateDirectory, { recursive: true });
  restrictToCurrentUser(config.stateDirectory);

  const pointerRoot = defaultDesktopSupervisorRoot();
  fs.mkdirSync(pointerRoot, { recursive: true });
  // One packaged Supervisor per user state root — prevents multiple installs
  // from racing active-instance.json and adopting each other's Runtime without secrets.
  const releaseInstanceLock = acquireSupervisorInstanceLock(pointerRoot);
  const activePointer = path.join(pointerRoot, "active-instance.json");
  const endpointFile = path.join(config.stateDirectory, "control-endpoint.json");
  fs.mkdirSync(path.dirname(endpointFile), { recursive: true });
  try {
    fs.unlinkSync(endpointFile);
  } catch {
    // ignore
  }

  const supervisor = new DesktopSupervisor(config);
  const { server, port, host } = await startSupervisorHttpServer(supervisor, {
    host: config.controlHost,
    port: config.controlPort,
    controlToken: config.controlToken,
    // /v1/shutdown is terminal: once the drain has finished, this supervisor
    // process itself must exit so the Tauri owner never outlives a drained
    // control plane. The timer lets the HTTP ack flush before exiting.
    onShutdownComplete: () => {
      setTimeout(() => void gracefulShutdown("control-plane-shutdown"), 150);
    }
  });

  const endpoint = {
    host,
    port,
    baseUrl: `http://${host}:${port}`,
    instanceId: config.instanceId,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    controlToken: config.controlToken
  };
  writeEndpointSecure(endpointFile, endpoint);
  fs.writeFileSync(
    activePointer,
    `${JSON.stringify(
      {
        instanceId: config.instanceId,
        pid: process.pid,
        endpointFile,
        stateDirectory: config.stateDirectory,
        startedAt: endpoint.startedAt,
        mode: config.layout?.mode ?? mode
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  restrictToCurrentUser(activePointer);

  console.log(
    JSON.stringify({
      ok: true,
      event: "supervisor.listening",
      baseUrl: `http://${host}:${port}`,
      instanceId: config.instanceId,
      stateDirectory: config.stateDirectory,
      mode: config.layout?.mode ?? mode,
      pid: process.pid
    })
  );

  supervisor.startBackgroundRefresh(5_000);
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
  async function gracefulShutdown(reason) {
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
      try {
        releaseInstanceLock.release();
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
}

function required(map, key) {
  const value = map[key];
  if (!value || !String(value).trim()) {
    throw new Error(`missing required --${key}`);
  }
  return String(value);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith("--")) continue;
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

function writeEndpointSecure(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  restrictToCurrentUser(filePath);
}

function restrictToCurrentUser(targetPath) {
  if (process.platform !== "win32") {
    try {
      // Directories need the traverse bit; a 0600 directory cannot hold files.
      const isDirectory = fs.statSync(targetPath).isDirectory();
      fs.chmodSync(targetPath, isDirectory ? 0o700 : 0o600);
    } catch {
      // ignore
    }
    return;
  }
  try {
    const user = process.env["USERNAME"] ?? "";
    if (!user) return;
    spawnSync("icacls", [targetPath, "/inheritance:r", "/grant:r", `${user}:(F)`], {
      stdio: "ignore",
      windowsHide: true
    });
  } catch {
    // ignore
  }
}

function defaultDesktopSupervisorRoot() {
  const local = process.env["LOCALAPPDATA"];
  if (local && local.trim()) {
    const root = path.join(local, "YUVI", "DesktopSupervisor");
    fs.mkdirSync(root, { recursive: true });
    return root;
  }
  // Mirrors defaultStateDirectory() (XDG data-home) so the Tauri launcher's
  // desktop_state_dir() and this pointer root agree on non-Windows hosts.
  const xdgDataHome = process.env["XDG_DATA_HOME"]?.trim();
  if (xdgDataHome && path.isAbsolute(xdgDataHome)) {
    const root = path.join(xdgDataHome, "YUVI", "DesktopSupervisor");
    fs.mkdirSync(root, { recursive: true });
    return root;
  }
  const home = process.env["HOME"]?.trim();
  const base = home && path.isAbsolute(home)
    ? path.join(home, ".local", "share", "YUVI", "DesktopSupervisor")
    : path.join(os.tmpdir(), "YUVI-DesktopSupervisor");
  fs.mkdirSync(base, { recursive: true });
  return base;
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      ok: false,
      event: "supervisor.fatal",
      error: error instanceof Error ? error.message : String(error)
    })
  );
  process.exit(1);
});
