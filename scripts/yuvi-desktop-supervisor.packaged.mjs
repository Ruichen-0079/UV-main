/**
 * Packaged-entry wrapper for the desktop supervisor.
 * Bundled to CJS (no top-level await / import.meta).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  DesktopSupervisor,
  loadSupervisorConfig,
  loadPackagedSupervisorConfig,
  startSupervisorHttpServer
} from "../packages/desktop-supervisor/src/index.ts";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = (args.mode ?? "development").toLowerCase();

  const config =
    mode === "packaged"
      ? loadPackagedSupervisorConfig({
          resourceRoot: required(args, "resource-root"),
          dataRoot: required(args, "state-root"),
          runtimeManifestPath: args["runtime-manifest"],
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

  const activePointer = path.join(defaultDesktopSupervisorRoot(), "active-instance.json");
  const endpointFile = path.join(config.stateDirectory, "control-endpoint.json");
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
      fs.chmodSync(targetPath, 0o600);
    } catch {
      // ignore
    }
    return;
  }
  try {
    const user = process.env["USERNAME"] ?? "";
    if (!user) return;
    spawnSync(
      "icacls",
      [targetPath, "/inheritance:r", "/grant:r", `${user}:(F)`],
      { stdio: "ignore", windowsHide: true }
    );
  } catch {
    // ignore
  }
}

function defaultDesktopSupervisorRoot() {
  const local = process.env["LOCALAPPDATA"];
  if (local && local.trim()) {
    return path.join(local, "YUVI", "DesktopSupervisor");
  }
  return path.join(process.cwd(), ".yuvi-desktop-supervisor");
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
