import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deriveConfigFromEnv,
  loadPackagedSupervisorConfig,
  resolvePostgresMode
} from "./config.js";
import { DesktopSupervisor } from "./supervisor.js";
import { redactSecretText } from "./postgres-secret.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function packagedTree(): { resourceRoot: string; dataRoot: string } {
  const resourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-res-"));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-data-"));
  tempDirs.push(resourceRoot, dataRoot);
  const runtimeDir = path.join(resourceRoot, "runtime");
  const mem0Dir = path.join(resourceRoot, "mem0");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(path.join(mem0Dir, "_internal"), { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, "node.exe"), "MZ");
  fs.writeFileSync(path.join(runtimeDir, "yuvi-runtime-server.mjs"), "export {};\n");
  fs.writeFileSync(
    path.join(runtimeDir, "runtime-manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      platform: "win32",
      arch: "x64",
      nodeExecutable: "node.exe",
      runtimeEntry: "yuvi-runtime-server.mjs"
    })
  );
  fs.writeFileSync(path.join(mem0Dir, "yuvi-mem0.exe"), "MZ");
  fs.writeFileSync(
    path.join(mem0Dir, "mem0-manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      protocolVersion: 1,
      platform: "win32",
      arch: "x64",
      executable: "yuvi-mem0.exe",
      healthPath: "/health",
      defaultHost: "127.0.0.1",
      defaultPort: 6131
    })
  );
  return { resourceRoot, dataRoot };
}

describe("supervisor postgres mode", () => {
  it("defaults packaged mode to private and development to external", () => {
    expect(
      resolvePostgresMode(
        {
          mode: "packaged",
          resourceRoot: "/r",
          dataRoot: "/d",
          runtimeManifestPath: "/m",
          mem0ManifestPath: "/n"
        },
        {}
      )
    ).toBe("private");
    expect(resolvePostgresMode({ mode: "development", repositoryRoot: "/repo" }, {})).toBe(
      "external"
    );
    expect(
      resolvePostgresMode(
        {
          mode: "packaged",
          resourceRoot: "/r",
          dataRoot: "/d",
          runtimeManifestPath: "/m",
          mem0ManifestPath: "/n"
        },
        {
          YUVI_POSTGRES_MODE: "external"
        }
      )
    ).toBe("external");
  });

  it("does not manage postgres in explicit external mode", () => {
    const { resourceRoot, dataRoot } = packagedTree();
    const cfg = loadPackagedSupervisorConfig({
      resourceRoot,
      dataRoot,
      env: { YUVI_POSTGRES_MODE: "external" }
    });
    expect(cfg.postgresMode).toBe("external");
    expect(cfg.postgresStart).toBeNull();
    const supervisor = new DesktopSupervisor(cfg);
    const snap = supervisor.snapshot();
    const postgres = snap.services.find((service) => service.id === "postgres");
    expect(postgres?.managed).toBe(false);
    expect(snap.postgres?.mode).toBe("external");
    expect(JSON.stringify(snap)).not.toContain("postgres://");
  });

  it("redacts connection strings from diagnostics text", () => {
    const text = redactSecretText(
      "failed DATABASE_URL=postgres://yuvi:super-secret@127.0.0.1:55432/yuvi",
      ["super-secret"]
    );
    expect(text).not.toContain("super-secret");
    expect(text).not.toContain("postgres://yuvi");
  });

  it("keeps the packaged Supervisor instance lock as the process-level mutex", () => {
    const script = fs.readFileSync(
      path.resolve(__dirname, "../../../scripts/yuvi-desktop-supervisor.packaged.mjs"),
      "utf8"
    );
    expect(script).toContain("acquireSupervisorInstanceLock");
    expect(script).toContain("supervisor.instance.lock");
    expect(script).toContain("Another YUVI Supervisor is already running");
  });

  it("refuses packaged secret fallback to local.secret", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-cm-"));
    tempDirs.push(root);
    const { preparePrivatePostgres } = await import("./postgres-lifecycle.js");
    const { layoutFromRoot } = await import("./postgres-layout.js");
    const layout = layoutFromRoot(root);
    const result = await preparePrivatePostgres({
      layout,
      distribution: {
        home: "/opt/pg16",
        binDir: "/opt/pg16/bin",
        postgres: "/opt/pg16/bin/postgres",
        pgCtl: "/opt/pg16/bin/pg_ctl",
        initdb: "/opt/pg16/bin/initdb",
        createdb: null,
        psql: "/opt/pg16/bin/psql",
        major: 16,
        versionText: "postgres (PostgreSQL) 16.10"
      },
      env: {},
      authority: "credential-manager"
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("POSTGRES_SECRET_UNAVAILABLE");
    expect(fs.existsSync(layout.passwordFile)).toBe(false);
    expect(fs.existsSync(layout.pgpassFile)).toBe(false);
  });

  it("keeps development deriveConfigFromEnv from autostarting private postgres", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-dev-"));
    tempDirs.push(repo);
    fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
    const runnerName =
      process.platform === "win32" ? "dev-server-runner.ps1" : "dev-server-runner.sh";
    fs.writeFileSync(path.join(repo, "scripts", runnerName), "#x\n");
    const derived = deriveConfigFromEnv({ mode: "development", repositoryRoot: repo }, {});
    expect(derived.postgresMode).toBe("external");
    expect(derived.postgresStart).toBeNull();
  });
});
