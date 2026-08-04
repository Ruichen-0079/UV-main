import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { envFlag, envString, loadYuviEnvFiles } from "./env.js";
import { canonicalPath, defaultStateDirectory, parseUrlOrigin } from "./paths.js";
import { readRuntimeManifest, resolveManifestFile } from "./runtime-manifest.js";
import type {
  StartCommandSpec,
  SupervisorConfig,
  SupervisorLayout
} from "./types.js";

export type LoadSupervisorConfigInput = {
  repositoryRoot: string;
  stateDirectory?: string | undefined;
  instanceId?: string | undefined;
  ownershipToken?: string | undefined;
  controlToken?: string | undefined;
  controlPort?: number | undefined;
  controlHost?: string | undefined;
};

export type LoadPackagedSupervisorConfigInput = {
  resourceRoot: string;
  dataRoot: string;
  runtimeManifestPath?: string | undefined;
  stateDirectory?: string | undefined;
  instanceId?: string | undefined;
  ownershipToken?: string | undefined;
  controlToken?: string | undefined;
  controlPort?: number | undefined;
  controlHost?: string | undefined;
  /** Optional non-secret public env seed (never load install-dir .env). */
  env?: Record<string, string> | undefined;
};

/** 256-bit hex control token (never log). */
export function generateControlToken(): string {
  return randomBytes(32).toString("hex");
}

export function assertLoopbackHost(host: string): void {
  const normalized = host.trim().toLowerCase();
  if (normalized !== "127.0.0.1" && normalized !== "localhost" && normalized !== "::1") {
    throw new Error(`Supervisor control plane must bind loopback only (got '${host}').`);
  }
}

export function loadSupervisorConfig(input: LoadSupervisorConfigInput): SupervisorConfig {
  const repositoryRoot = canonicalPath(input.repositoryRoot);
  const env = loadYuviEnvFiles(repositoryRoot);
  const instanceId = input.instanceId ?? randomUUID();
  const ownershipToken = input.ownershipToken ?? randomUUID();
  const controlToken = input.controlToken ?? generateControlToken();
  const stateDirectory = canonicalPath(
    input.stateDirectory ?? path.join(defaultStateDirectory(), instanceId)
  );

  const controlPort = input.controlPort ?? Number(envString(env, "YUVI_SUPERVISOR_PORT", "0"));
  const controlHost = input.controlHost ?? "127.0.0.1";
  assertLoopbackHost(controlHost);

  const layout: SupervisorLayout = { mode: "development", repositoryRoot };
  const derived = deriveConfigFromEnv(layout, env);

  return {
    layout,
    repositoryRoot,
    stateDirectory,
    instanceId,
    ownershipToken,
    controlToken,
    controlHost,
    controlPort: Number.isFinite(controlPort) ? controlPort : 0,
    env,
    ...derived
  };
}

/**
 * Packaged install layout: no repo .env, no PowerShell dev runner, no pnpm/tsx.
 */
export function loadPackagedSupervisorConfig(
  input: LoadPackagedSupervisorConfigInput
): SupervisorConfig {
  const resourceRoot = canonicalPath(input.resourceRoot);
  const dataRoot = canonicalPath(input.dataRoot);
  if (!fs.existsSync(resourceRoot)) {
    throw new Error(`Supervisor resource root missing: ${resourceRoot}`);
  }
  const runtimeManifestPath = canonicalPath(
    input.runtimeManifestPath ??
      path.join(resourceRoot, "runtime", "runtime-manifest.json")
  );
  // Validate early so bootstrap fails with a clear packaging error.
  readRuntimeManifest(runtimeManifestPath);

  const instanceId = input.instanceId ?? randomUUID();
  const ownershipToken = input.ownershipToken ?? randomUUID();
  const controlToken = input.controlToken ?? generateControlToken();
  const stateDirectory = canonicalPath(
    input.stateDirectory ?? path.join(dataRoot, "instances", instanceId)
  );
  fs.mkdirSync(stateDirectory, { recursive: true });

  // Packaged: process env + optional non-secret seed only (never install-dir .env).
  const env: Record<string, string> = { ...(input.env ?? {}) };
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string" && env[key] === undefined) {
      env[key] = value;
    }
  }

  const controlPort = input.controlPort ?? Number(envString(env, "YUVI_SUPERVISOR_PORT", "0"));
  const controlHost = input.controlHost ?? "127.0.0.1";
  assertLoopbackHost(controlHost);

  const layout: SupervisorLayout = {
    mode: "packaged",
    resourceRoot,
    dataRoot,
    runtimeManifestPath
  };
  const derived = deriveConfigFromEnv(layout, env);

  return {
    layout,
    // Ownership root for packaged services is the resource root.
    repositoryRoot: resourceRoot,
    stateDirectory,
    instanceId,
    ownershipToken,
    controlToken,
    controlHost,
    controlPort: Number.isFinite(controlPort) ? controlPort : 0,
    env,
    ...derived
  };
}

/**
 * Recompute URLs, autostart flags, and start-command specs from an env map.
 * Used at bootstrap and when Tauri pushes a runtime config update.
 */
export function deriveConfigFromEnv(
  layoutOrRepoRoot: SupervisorLayout | string,
  env: Record<string, string>
): Pick<
  SupervisorConfig,
  | "memoryBackend"
  | "autostartRuntime"
  | "autostartMem0"
  | "autostartTts"
  | "runtimeUrl"
  | "mem0Url"
  | "ttsWrapperUrl"
  | "ttsUpstreamUrl"
  | "ollamaUrl"
  | "databaseUrl"
  | "runtimeStart"
  | "mem0Start"
  | "ttsWrapperStart"
  | "ttsUpstreamStart"
> {
  const layout: SupervisorLayout =
    typeof layoutOrRepoRoot === "string"
      ? { mode: "development", repositoryRoot: layoutOrRepoRoot }
      : layoutOrRepoRoot;

  const runtimeHost = envString(env, "SERVER_HOST", "127.0.0.1");
  const runtimePort = envString(env, "SERVER_PORT", "6121");
  const runtimeUrl = `http://${runtimeHost}:${runtimePort}`;
  const mem0Url = envString(env, "MEM0_BASE_URL", "http://127.0.0.1:6131");
  const ttsWrapperUrl = envString(env, "GPT_SOVITS_TTS_BASE_URL", "http://127.0.0.1:9881");
  const ttsUpstreamUrl = envString(env, "GPT_SOVITS_TTS_UPSTREAM_URL", "http://127.0.0.1:9880");
  const ollamaUrl = envString(
    env,
    "MEM0_OLLAMA_BASE_URL",
    envString(env, "OLLAMA_HOST", "http://127.0.0.1:11434")
  );
  const databaseUrl = env["DATABASE_URL"]?.trim() || null;
  const memoryBackend = envString(env, "MEMORY_BACKEND", "mem0") === "legacy" ? "legacy" : "mem0";

  const ownershipRoot =
    layout.mode === "development" ? layout.repositoryRoot : layout.resourceRoot;

  return {
    memoryBackend,
    autostartRuntime: envFlag(env, "YUVI_AUTOSTART_RUNTIME", true),
    // Packaged P2 does not ship Mem0 sidecar — never autostart managed mem0.
    autostartMem0:
      layout.mode === "packaged"
        ? false
        : envFlag(env, "YUVI_AUTOSTART_MEM0", memoryBackend === "mem0"),
    autostartTts: envFlag(env, "YUVI_AUTOSTART_TTS", false),
    runtimeUrl,
    mem0Url,
    ttsWrapperUrl,
    ttsUpstreamUrl,
    ollamaUrl,
    databaseUrl,
    runtimeStart: resolveRuntimeStartForLayout(layout, env, runtimePort),
    mem0Start:
      layout.mode === "packaged" ? null : resolveMem0Start(ownershipRoot, env, mem0Url),
    ttsWrapperStart:
      layout.mode === "packaged"
        ? null
        : resolveOptionalStartCommand(env, "YUVI_TTS_WRAPPER_START_COMMAND", ownershipRoot),
    ttsUpstreamStart:
      layout.mode === "packaged"
        ? null
        : resolveOptionalStartCommand(env, "YUVI_TTS_UPSTREAM_START_COMMAND", ownershipRoot)
  };
}

export function resolveRuntimeStartForLayout(
  layout: SupervisorLayout,
  env: Record<string, string>,
  runtimePort: string
): StartCommandSpec | null {
  if (layout.mode === "packaged") {
    return resolvePackagedRuntimeStart(layout, env, runtimePort);
  }
  return resolveRuntimeStart(layout.repositoryRoot, env, runtimePort);
}

/**
 * Resolve Live2D model root + Cubism Core for packaged Runtime.
 *
 * Priority for each path:
 * 1. Explicit env (process / seed / user settings push)
 * 2. Bundled next to resource root (`live2d/`, `cubism-core/live2dcubismcore.min.js`)
 * 3. Standard per-user layout under LOCALAPPDATA/YUVI (matches .env.local convention)
 *
 * Missing assets are omitted (Runtime returns 404 for /live2d/*) — never invent paths.
 */
export function resolvePackagedLive2DEnv(
  layout: Extract<SupervisorLayout, { mode: "packaged" }>,
  env: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};

  const explicitAsset = env["LIVE2D_ASSET_ROOT"]?.trim();
  const explicitCore = env["LIVE2D_CORE_PATH"]?.trim();

  const bundledAsset = path.join(layout.resourceRoot, "live2d");
  const bundledCore = path.join(
    layout.resourceRoot,
    "cubism-core",
    "live2dcubismcore.min.js"
  );

  const localYuvi = defaultYuviLocalDataRoot();
  const userAsset = path.join(localYuvi, "Live2DModels");
  const userCore = path.join(localYuvi, "CubismCore", "live2dcubismcore.min.js");

  if (explicitAsset) {
    out["LIVE2D_ASSET_ROOT"] = explicitAsset;
  } else if (fs.existsSync(bundledAsset)) {
    out["LIVE2D_ASSET_ROOT"] = bundledAsset;
  } else if (fs.existsSync(userAsset)) {
    out["LIVE2D_ASSET_ROOT"] = userAsset;
  }

  if (explicitCore) {
    out["LIVE2D_CORE_PATH"] = explicitCore;
  } else if (fs.existsSync(bundledCore)) {
    out["LIVE2D_CORE_PATH"] = bundledCore;
  } else if (fs.existsSync(userCore)) {
    out["LIVE2D_CORE_PATH"] = userCore;
  }

  return out;
}

function defaultYuviLocalDataRoot(): string {
  const local = process.env["LOCALAPPDATA"]?.trim();
  if (local) return path.join(local, "YUVI");
  // Non-Windows / restricted clean-room fallback
  return path.join(process.env["HOME"]?.trim() || process.cwd(), ".yuvi");
}

/**
 * Packaged Runtime: bundled node.exe + yuvi-runtime-server.mjs (never PATH node/pnpm/tsx).
 */
export function resolvePackagedRuntimeStart(
  layout: Extract<SupervisorLayout, { mode: "packaged" }>,
  env: Record<string, string>,
  runtimePort: string
): StartCommandSpec | null {
  const manifest = readRuntimeManifest(layout.runtimeManifestPath);
  const runtimeDir = path.dirname(layout.runtimeManifestPath);
  const nodeExe = resolveManifestFile(runtimeDir, manifest.nodeExecutable);
  const entry = resolveManifestFile(runtimeDir, manifest.runtimeEntry);
  if (!fs.existsSync(nodeExe)) {
    throw new Error(`Bundled Node missing: ${nodeExe}`);
  }
  if (!fs.existsSync(entry)) {
    throw new Error(`Runtime entry missing: ${entry}`);
  }
  const dataDir = path.join(layout.dataRoot, "runtime-data");
  fs.mkdirSync(dataDir, { recursive: true });
  const host = envString(env, "SERVER_HOST", "127.0.0.1");
  const live2dEnv = resolvePackagedLive2DEnv(layout, env);
  return {
    file: nodeExe,
    args: [entry],
    cwd: dataDir,
    env: {
      SERVER_HOST: host,
      SERVER_PORT: runtimePort,
      YUVI_RUNTIME_RESOURCE_DIR: layout.resourceRoot,
      YUVI_RUNTIME_DATA_DIR: dataDir,
      YUVI_RUNTIME_ENV_DIR: dataDir,
      YUVI_PACKAGED: "1",
      ...live2dEnv
    },
    // Specific marker — not bare "node.exe".
    commandMarker: "yuvi-runtime-server.mjs"
  };
}

/**
 * Build the env object used for managed child spawn.
 * Typical call: baseEnv + current config overrides, then commandEnv.
 * `unsetKeys` (optional) delete after merge — prefer restoring base fallbacks
 * in the Supervisor rather than permanently stripping shell env.
 */
export function buildChildProcessEnv(
  processEnv: NodeJS.ProcessEnv,
  commandEnv: Record<string, string>,
  unsetKeys: Iterable<string> = []
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...processEnv, ...commandEnv };
  for (const key of unsetKeys) {
    delete env[key];
  }
  return env;
}

export function resolveRuntimeStart(
  repositoryRoot: string,
  env: Record<string, string>,
  runtimePort: string
): StartCommandSpec | null {
  const explicit = resolveOptionalStartCommand(env, "YUVI_RUNTIME_START_COMMAND", repositoryRoot);
  if (explicit) return explicit;

  const runner = path.join(repositoryRoot, "scripts", "dev-server-runner.ps1");
  if (!fs.existsSync(runner)) return null;
  const shell = process.platform === "win32" ? "powershell.exe" : "pwsh";
  return {
    file: shell,
    args: [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      runner,
      "-RepoRoot",
      repositoryRoot,
      "-ServerPort",
      runtimePort
    ],
    cwd: repositoryRoot,
    env: {
      SERVER_PORT: runtimePort,
      YUVI_RUNTIME_ENV_DIR: repositoryRoot
    },
    commandMarker: "dev-server-runner.ps1"
  };
}

export function resolveMem0Start(
  repositoryRoot: string,
  env: Record<string, string>,
  mem0Url: string
): StartCommandSpec | null {
  const explicit = resolveOptionalStartCommand(env, "YUVI_MEM0_START_COMMAND", repositoryRoot);
  if (explicit) return explicit;

  const sidecarDir = path.join(repositoryRoot, "services", "memory-mem0");
  const srcDir = path.join(sidecarDir, "src");
  if (!fs.existsSync(path.join(srcDir, "yuvi_mem0"))) return null;

  const venvPython = path.join(sidecarDir, ".venv", "Scripts", "python.exe");
  const python = fs.existsSync(venvPython) ? venvPython : "python";
  const parsed = parseUrlOrigin(mem0Url);
  const port = parsed?.port ?? 6131;

  return {
    file: python,
    args: ["-m", "yuvi_mem0"],
    cwd: sidecarDir,
    env: {
      PYTHONPATH: "src",
      MEM0_SIDECAR_PORT: String(port),
      MEM0_SIDECAR_HOST: "127.0.0.1"
    },
    commandMarker: "yuvi_mem0"
  };
}

/**
 * Explicit start command format: executable + args separated by spaces.
 * Example: C:\path\python.exe -m alice_wrapper
 * We do not invent model weight paths.
 */
function resolveOptionalStartCommand(
  env: Record<string, string>,
  key: string,
  repositoryRoot: string
): StartCommandSpec | null {
  const raw = env[key]?.trim();
  if (!raw) return null;
  const parts = splitCommandLine(raw);
  if (parts.length === 0) return null;
  const file = parts[0]!;
  const args = parts.slice(1);
  return {
    file,
    args,
    cwd: repositoryRoot,
    env: {},
    commandMarker: path.basename(file)
  };
}

function splitCommandLine(input: string): string[] {
  const matches = input.match(/"[^"]+"|'[^']+'|\S+/g) ?? [];
  return matches.map((part) => {
    if (
      (part.startsWith('"') && part.endsWith('"')) ||
      (part.startsWith("'") && part.endsWith("'"))
    ) {
      return part.slice(1, -1);
    }
    return part;
  });
}
