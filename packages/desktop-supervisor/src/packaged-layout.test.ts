import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deriveConfigFromEnv,
  loadPackagedSupervisorConfig,
  loadSupervisorConfig,
  resolvePackagedLive2DEnv,
  resolvePackagedRuntimeStart
} from "./config.js";
import { validateRuntimeManifest } from "./runtime-manifest.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makePackagedResourceTree(): {
  resourceRoot: string;
  dataRoot: string;
  manifestPath: string;
  mem0ManifestPath: string;
  nodeExe: string;
  entry: string;
} {
  const resourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-res-"));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-data-"));
  tempDirs.push(resourceRoot, dataRoot);
  const runtimeDir = path.join(resourceRoot, "runtime");
  fs.mkdirSync(runtimeDir, { recursive: true });
  const nodeExe = path.join(runtimeDir, "node.exe");
  const entry = path.join(runtimeDir, "yuvi-runtime-server.mjs");
  fs.writeFileSync(nodeExe, "MZ-placeholder");
  fs.writeFileSync(entry, "export {};\n");
  const manifestPath = path.join(runtimeDir, "runtime-manifest.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      platform: "win32",
      arch: "x64",
      nodeExecutable: "node.exe",
      runtimeEntry: "yuvi-runtime-server.mjs"
    })
  );
  const mem0Dir = path.join(resourceRoot, "mem0");
  fs.mkdirSync(path.join(mem0Dir, "_internal"), { recursive: true });
  fs.writeFileSync(path.join(mem0Dir, "yuvi-mem0.exe"), "MZ-placeholder");
  const mem0ManifestPath = path.join(mem0Dir, "mem0-manifest.json");
  fs.writeFileSync(
    mem0ManifestPath,
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
  const localSttDir = path.join(resourceRoot, "local-stt");
  fs.mkdirSync(path.join(localSttDir, "_internal"), { recursive: true });
  fs.writeFileSync(path.join(localSttDir, "yuvi-local-stt.exe"), "MZ-placeholder");
  fs.writeFileSync(path.join(localSttDir, "_internal", "placeholder.dat"), "x");
  fs.mkdirSync(path.join(localSttDir, "models", "sense-voice"), { recursive: true });
  fs.writeFileSync(path.join(localSttDir, "models", "sense-voice", "tokens.txt"), "tokens\n");
  fs.writeFileSync(
    path.join(localSttDir, "models.manifest.json"),
    JSON.stringify({ models: [], runtimeFiles: [] })
  );
  fs.writeFileSync(
    path.join(localSttDir, "local-stt-manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      protocolVersion: 1,
      platform: "win32",
      arch: "x64",
      executable: "yuvi-local-stt.exe",
      modelDirectory: "models",
      modelManifest: "models.manifest.json",
      healthPath: "/health",
      defaultHost: "127.0.0.1",
      defaultPort: 9876
    })
  );
  return { resourceRoot, dataRoot, manifestPath, mem0ManifestPath, nodeExe, entry };
}

describe("packaged supervisor layout", () => {
  it("development layout generates a platform-native Runtime command when runner exists", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-dev-"));
    tempDirs.push(repo);
    fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
    const isWindows = process.platform === "win32";
    const runnerName = isWindows ? "dev-server-runner.ps1" : "dev-server-runner.sh";
    fs.writeFileSync(path.join(repo, "scripts", runnerName), "#x\n");
    const cfg = loadSupervisorConfig({ repositoryRoot: repo });
    expect(cfg.layout.mode).toBe("development");
    expect(cfg.runtimeStart?.commandMarker).toBe(runnerName);
    if (isWindows) {
      expect(cfg.runtimeStart?.file.toLowerCase()).toContain("powershell");
      expect(cfg.runtimeStart?.args).toContain("-File");
    } else {
      expect(cfg.runtimeStart?.file).toBe("bash");
      expect(cfg.runtimeStart?.args).toEqual([
        path.join(repo, "scripts", runnerName),
        "--repo-root",
        repo,
        "--server-port",
        "6121"
      ]);
    }
  });

  it("packaged layout generates bundled node command without pnpm/tsx", () => {
    const tree = makePackagedResourceTree();
    const cfg = loadPackagedSupervisorConfig({
      resourceRoot: tree.resourceRoot,
      dataRoot: tree.dataRoot,
      runtimeManifestPath: tree.manifestPath,
      mem0ManifestPath: tree.mem0ManifestPath
    });
    expect(cfg.layout.mode).toBe("packaged");
    expect(cfg.runtimeStart).not.toBeNull();
    expect(cfg.runtimeStart?.file).toBe(tree.nodeExe);
    expect(cfg.runtimeStart?.args).toEqual([tree.entry]);
    expect(cfg.runtimeStart?.commandMarker).toBe("yuvi-runtime-server.mjs");
    const joined = `${cfg.runtimeStart?.file} ${cfg.runtimeStart?.args.join(" ")}`;
    expect(joined.toLowerCase()).not.toContain("pnpm");
    expect(joined.toLowerCase()).not.toContain("tsx");
    expect(cfg.runtimeStart?.env["YUVI_PACKAGED"]).toBe("1");
    expect(cfg.runtimeStart?.env["YUVI_RUNTIME_MIGRATIONS_DIR"]).toBe(
      path.join(tree.resourceRoot, "runtime", "migrations")
    );
    expect(cfg.autostartMem0).toBe(false);
    expect(cfg.mem0Start).toBeNull();
    expect(cfg.localSttStart).not.toBeNull();
    expect(cfg.localSttStart?.file).toBe(
      path.join(tree.resourceRoot, "local-stt", "yuvi-local-stt.exe")
    );
    expect(cfg.localSttStart?.args).toContain(path.join(tree.resourceRoot, "local-stt", "models"));
    expect(cfg.localSttStart?.env["YUVI_STT_SPEAKER_DIR"]).toBe(
      path.join(tree.dataRoot, "local-stt", "speakers")
    );
    expect(cfg.postgresMode).toBe("private");
    expect(cfg.postgresStart).toBeNull();
  });

  it("packaged Live2D env prefers explicit, then bundled resources, then LOCALAPPDATA/YUVI", () => {
    const tree = makePackagedResourceTree();
    const layout = {
      mode: "packaged" as const,
      resourceRoot: tree.resourceRoot,
      dataRoot: tree.dataRoot,
      runtimeManifestPath: tree.manifestPath,
      mem0ManifestPath: tree.mem0ManifestPath
    };

    // Explicit wins even when bundled exists.
    const bundledLive2d = path.join(tree.resourceRoot, "live2d");
    fs.mkdirSync(bundledLive2d, { recursive: true });
    const bundledCoreDir = path.join(tree.resourceRoot, "cubism-core");
    fs.mkdirSync(bundledCoreDir, { recursive: true });
    const bundledCore = path.join(bundledCoreDir, "live2dcubismcore.min.js");
    fs.writeFileSync(bundledCore, "/*core*/");

    const explicit = resolvePackagedLive2DEnv(layout, {
      LIVE2D_ASSET_ROOT: "C:\\explicit\\models",
      LIVE2D_CORE_PATH: "C:\\explicit\\core.js"
    });
    expect(explicit["LIVE2D_ASSET_ROOT"]).toBe("C:\\explicit\\models");
    expect(explicit["LIVE2D_CORE_PATH"]).toBe("C:\\explicit\\core.js");

    // Bundled when no explicit.
    const bundled = resolvePackagedLive2DEnv(layout, {});
    expect(bundled["LIVE2D_ASSET_ROOT"]).toBe(bundledLive2d);
    expect(bundled["LIVE2D_CORE_PATH"]).toBe(bundledCore);

    // runtimeStart merges Live2D env.
    const start = resolvePackagedRuntimeStart(layout, {}, "6121");
    expect(start?.env["LIVE2D_ASSET_ROOT"]).toBe(bundledLive2d);
    expect(start?.env["LIVE2D_CORE_PATH"]).toBe(bundledCore);
  });

  it("rejects path traversal in runtime manifest fields", () => {
    expect(() =>
      validateRuntimeManifest({
        schemaVersion: 1,
        platform: "win32",
        arch: "x64",
        nodeExecutable: "../evil/node.exe",
        runtimeEntry: "yuvi-runtime-server.mjs"
      })
    ).toThrow(/\.\./);
  });

  it("rejects absolute paths in runtime manifest", () => {
    expect(() =>
      validateRuntimeManifest({
        schemaVersion: 1,
        platform: "win32",
        arch: "x64",
        nodeExecutable: "C:\\\\Windows\\\\node.exe",
        runtimeEntry: "yuvi-runtime-server.mjs"
      })
    ).toThrow(/relative/i);
  });

  it("packaged mode does not read repo .env for secrets", () => {
    const tree = makePackagedResourceTree();
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-repo-env-"));
    tempDirs.push(repo);
    fs.writeFileSync(path.join(repo, ".env"), "DEEPSEEK_API_KEY=from-repo-env\n");
    // Even if cwd has a .env, packaged config only uses process env + seed.
    const prev = process.cwd();
    try {
      process.chdir(repo);
      delete process.env["DEEPSEEK_API_KEY"];
      const cfg = loadPackagedSupervisorConfig({
        resourceRoot: tree.resourceRoot,
        dataRoot: tree.dataRoot,
        runtimeManifestPath: tree.manifestPath,
        mem0ManifestPath: tree.mem0ManifestPath
      });
      expect(cfg.env["DEEPSEEK_API_KEY"]).toBeUndefined();
    } finally {
      process.chdir(prev);
    }
  });

  it("paths with spaces work for packaged runtime start", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi space "));
    tempDirs.push(base);
    const resourceRoot = path.join(base, "res with spaces");
    const dataRoot = path.join(base, "data with spaces");
    fs.mkdirSync(path.join(resourceRoot, "runtime"), { recursive: true });
    fs.mkdirSync(dataRoot, { recursive: true });
    const runtimeDir = path.join(resourceRoot, "runtime");
    fs.writeFileSync(path.join(runtimeDir, "node.exe"), "MZ");
    fs.writeFileSync(path.join(runtimeDir, "yuvi-runtime-server.mjs"), "export {};\n");
    const manifestPath = path.join(runtimeDir, "runtime-manifest.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: 1,
        platform: "win32",
        arch: "x64",
        nodeExecutable: "node.exe",
        runtimeEntry: "yuvi-runtime-server.mjs"
      })
    );
    const start = resolvePackagedRuntimeStart(
      {
        mode: "packaged",
        resourceRoot,
        dataRoot,
        runtimeManifestPath: manifestPath,
        mem0ManifestPath: path.join(resourceRoot, "mem0", "mem0-manifest.json")
      },
      { SERVER_PORT: "6121" },
      "6121"
    );
    expect(start?.file.includes(" ")).toBe(true);
    expect(fs.existsSync(start!.file)).toBe(true);
  });

  it("deriveConfigFromEnv reuses layout after settings push", () => {
    const tree = makePackagedResourceTree();
    const layout = {
      mode: "packaged" as const,
      resourceRoot: tree.resourceRoot,
      dataRoot: tree.dataRoot,
      runtimeManifestPath: tree.manifestPath,
      mem0ManifestPath: tree.mem0ManifestPath
    };
    const first = deriveConfigFromEnv(layout, {
      SERVER_PORT: "6121",
      DEEPSEEK_CHAT_MODEL: "model-A"
    });
    const second = deriveConfigFromEnv(layout, {
      SERVER_PORT: "6121",
      DEEPSEEK_CHAT_MODEL: "model-B"
    });
    expect(first.runtimeStart?.commandMarker).toBe("yuvi-runtime-server.mjs");
    expect(second.runtimeStart?.commandMarker).toBe("yuvi-runtime-server.mjs");
    expect(second.runtimeStart?.env["SERVER_PORT"]).toBe("6121");
  });

  it("stores the default and explicit Mem0 manifest paths", () => {
    const tree = makePackagedResourceTree();
    const cfg = loadPackagedSupervisorConfig({
      resourceRoot: tree.resourceRoot,
      dataRoot: tree.dataRoot,
      runtimeManifestPath: tree.manifestPath,
      env: { YUVI_AUTOSTART_MEM0: "false" }
    });
    expect(cfg.layout.mode).toBe("packaged");
    if (cfg.layout.mode !== "packaged") throw new Error("expected packaged layout");
    expect(cfg.layout.mem0ManifestPath).toBe(
      path.join(tree.resourceRoot, "mem0", "mem0-manifest.json")
    );

    const alternateDir = path.join(tree.resourceRoot, "alternate-mem0");
    fs.mkdirSync(alternateDir, { recursive: true });
    const alternateManifest = path.join(alternateDir, "mem0-manifest.json");
    fs.writeFileSync(path.join(alternateDir, "yuvi-mem0.exe"), "MZ");
    fs.writeFileSync(
      alternateManifest,
      JSON.stringify({ ...validMem0Manifest(), defaultPort: 6142 })
    );
    const explicit = loadPackagedSupervisorConfig({
      resourceRoot: tree.resourceRoot,
      dataRoot: tree.dataRoot,
      runtimeManifestPath: tree.manifestPath,
      mem0ManifestPath: alternateManifest,
      env: { YUVI_AUTOSTART_MEM0: "false" }
    });
    expect(explicit.layout.mode === "packaged" && explicit.layout.mem0ManifestPath).toBe(
      alternateManifest
    );
  });

  it("validates the Mem0 manifest during packaged config bootstrap", () => {
    const tree = makePackagedResourceTree();
    fs.rmSync(tree.mem0ManifestPath);
    expect(() =>
      loadPackagedSupervisorConfig({
        resourceRoot: tree.resourceRoot,
        dataRoot: tree.dataRoot,
        runtimeManifestPath: tree.manifestPath
      })
    ).toThrow(/mem0 manifest missing/i);
  });

  it("validates the packaged local STT manifest and model root during bootstrap", () => {
    const tree = makePackagedResourceTree();
    const manifestPath = path.join(tree.resourceRoot, "local-stt", "local-stt-manifest.json");
    fs.rmSync(manifestPath);
    expect(() =>
      loadPackagedSupervisorConfig({
        resourceRoot: tree.resourceRoot,
        dataRoot: tree.dataRoot,
        runtimeManifestPath: tree.manifestPath,
        mem0ManifestPath: tree.mem0ManifestPath
      })
    ).toThrow(/local stt manifest missing/i);
  });

  it("gates packaged managed Mem0 on backend and YUVI_AUTOSTART_MEM0", () => {
    const tree = makePackagedResourceTree();
    const layout = {
      mode: "packaged" as const,
      resourceRoot: tree.resourceRoot,
      dataRoot: tree.dataRoot,
      runtimeManifestPath: tree.manifestPath,
      mem0ManifestPath: tree.mem0ManifestPath
    };
    const legacy = deriveConfigFromEnv(layout, {
      MEMORY_BACKEND: "legacy",
      YUVI_AUTOSTART_MEM0: "true"
    });
    expect(legacy.autostartMem0).toBe(false);
    expect(legacy.mem0Start).toBeNull();

    const disabled = deriveConfigFromEnv(layout, { YUVI_AUTOSTART_MEM0: "false" });
    expect(disabled.autostartMem0).toBe(false);
    expect(disabled.mem0Start).toBeNull();

    const managed = deriveConfigFromEnv(layout, {
      YUVI_AUTOSTART_MEM0: "true",
      MEM0_BASE_URL: "http://127.0.0.1:6147"
    });
    expect(managed.autostartMem0).toBe(true);
    expect(managed.mem0Start).not.toBeNull();
  });

  it("validates managed loopback URL and preserves external remote probing", () => {
    const tree = makePackagedResourceTree();
    const layout = {
      mode: "packaged" as const,
      resourceRoot: tree.resourceRoot,
      dataRoot: tree.dataRoot,
      runtimeManifestPath: tree.manifestPath,
      mem0ManifestPath: tree.mem0ManifestPath
    };
    const external = deriveConfigFromEnv(layout, {
      YUVI_AUTOSTART_MEM0: "false",
      MEM0_BASE_URL: "https://memory.example.test:6131"
    });
    expect(external.mem0Start).toBeNull();
    expect(() =>
      deriveConfigFromEnv(layout, {
        YUVI_AUTOSTART_MEM0: "true",
        MEM0_BASE_URL: "http://memory.example.test:6131"
      })
    ).toThrow(/loopback/i);
  });

  it("builds packaged Mem0 paths, env, and command marker without secret args", () => {
    const tree = makePackagedResourceTree();
    const layout = {
      mode: "packaged" as const,
      resourceRoot: tree.resourceRoot,
      dataRoot: tree.dataRoot,
      runtimeManifestPath: tree.manifestPath,
      mem0ManifestPath: tree.mem0ManifestPath
    };
    const secret = "P3_CONFIG_SECRET_DO_NOT_LOG";
    const resourceEntriesBefore = fs.readdirSync(tree.resourceRoot).sort();
    const start = deriveConfigFromEnv(layout, {
      YUVI_AUTOSTART_MEM0: "true",
      MEM0_BASE_URL: "http://127.0.0.1:6197",
      YUVI_MEM0_DATA_DIR: path.join(tree.dataRoot, "data with spaces"),
      YUVI_MEM0_LOG_DIR: path.join(tree.dataRoot, "logs with spaces"),
      MEM0_PG_CONNECTION_STRING: "postgresql://yuvi:explicit@127.0.0.1:1/yuvi",
      DATABASE_URL: "postgresql://yuvi:fallback@127.0.0.1:1/yuvi",
      MEM0_OLLAMA_BASE_URL: "http://127.0.0.1:11434",
      MEM0_LLM_PROVIDER: "deepseek",
      MEM0_LLM_API_KEY: secret,
      MEM0_REQUEST_TIMEOUT_MS: "1000"
    }).mem0Start;
    expect(start).not.toBeNull();
    expect(start?.file).toBe(path.join(tree.resourceRoot, "mem0", "yuvi-mem0.exe"));
    expect(start?.args).toEqual([]);
    expect(start?.cwd).toBe(path.join(tree.dataRoot, "data with spaces"));
    expect(start?.commandMarker).toBe(start?.file);
    expect(start?.env).toMatchObject({
      YUVI_MEM0_PACKAGED: "1",
      YUVI_MEM0_RESOURCE_DIR: path.join(tree.resourceRoot, "mem0"),
      YUVI_MEM0_DATA_DIR: path.join(tree.dataRoot, "data with spaces"),
      YUVI_MEM0_LOG_DIR: path.join(tree.dataRoot, "logs with spaces"),
      MEM0_DIR: path.join(tree.dataRoot, "data with spaces"),
      MEM0_TELEMETRY: "false",
      MEM0_SIDECAR_HOST: "127.0.0.1",
      MEM0_SIDECAR_PORT: "6197",
      MEM0_PG_CONNECTION_STRING: "postgresql://yuvi:explicit@127.0.0.1:1/yuvi",
      MEM0_LLM_API_KEY: secret
    });
    expect(start?.env["DATABASE_URL"]).toBeUndefined();
    expect(JSON.stringify(start?.args)).not.toContain(secret);
    expect(start?.commandMarker).not.toContain(secret);
    expect(fs.readdirSync(tree.resourceRoot).sort()).toEqual(resourceEntriesBefore);
  });
});

function validMem0Manifest() {
  return {
    schemaVersion: 1,
    protocolVersion: 1,
    platform: "win32",
    arch: "x64",
    executable: "yuvi-mem0.exe",
    healthPath: "/health",
    defaultHost: "127.0.0.1",
    defaultPort: 6131
  };
}
