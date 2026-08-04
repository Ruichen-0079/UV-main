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
  return { resourceRoot, dataRoot, manifestPath, nodeExe, entry };
}

describe("packaged supervisor layout", () => {
  it("development layout still generates dev Runtime command when runner exists", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "yuvi-dev-"));
    tempDirs.push(repo);
    fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(repo, "scripts", "dev-server-runner.ps1"), "#x\n");
    const cfg = loadSupervisorConfig({ repositoryRoot: repo });
    expect(cfg.layout.mode).toBe("development");
    expect(cfg.runtimeStart?.commandMarker).toBe("dev-server-runner.ps1");
    expect(cfg.runtimeStart?.file.toLowerCase()).toMatch(/powershell|pwsh/);
  });

  it("packaged layout generates bundled node command without pnpm/tsx", () => {
    const tree = makePackagedResourceTree();
    const cfg = loadPackagedSupervisorConfig({
      resourceRoot: tree.resourceRoot,
      dataRoot: tree.dataRoot,
      runtimeManifestPath: tree.manifestPath
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
    expect(cfg.autostartMem0).toBe(false);
    expect(cfg.mem0Start).toBeNull();
  });

  it("packaged Live2D env prefers explicit, then bundled resources, then LOCALAPPDATA/YUVI", () => {
    const tree = makePackagedResourceTree();
    const layout = {
      mode: "packaged" as const,
      resourceRoot: tree.resourceRoot,
      dataRoot: tree.dataRoot,
      runtimeManifestPath: tree.manifestPath
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
        runtimeManifestPath: tree.manifestPath
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
        runtimeManifestPath: manifestPath
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
      runtimeManifestPath: tree.manifestPath
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
});
