import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { envFlag, envString, loadYuviEnvFiles } from "./env.js";
import { canonicalPath, defaultStateDirectory, parseUrlOrigin } from "./paths.js";
import type { StartCommandSpec, SupervisorConfig } from "./types.js";

export type LoadSupervisorConfigInput = {
  repositoryRoot: string;
  stateDirectory?: string | undefined;
  instanceId?: string | undefined;
  ownershipToken?: string | undefined;
  controlToken?: string | undefined;
  controlPort?: number | undefined;
  controlHost?: string | undefined;
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
  // Per-instance state so multi-open YUVI never shares metadata / endpoint files.
  const stateDirectory = canonicalPath(
    input.stateDirectory ?? path.join(defaultStateDirectory(), instanceId)
  );

  const controlPort = input.controlPort ?? Number(envString(env, "YUVI_SUPERVISOR_PORT", "0"));
  const controlHost = input.controlHost ?? "127.0.0.1";
  assertLoopbackHost(controlHost);

  const derived = deriveConfigFromEnv(repositoryRoot, env);

  return {
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
 * Recompute URLs, autostart flags, and start-command specs from an env map.
 * Used at bootstrap and when Tauri pushes a runtime config update.
 */
export function deriveConfigFromEnv(
  repositoryRoot: string,
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

  return {
    memoryBackend,
    autostartRuntime: envFlag(env, "YUVI_AUTOSTART_RUNTIME", true),
    autostartMem0: envFlag(env, "YUVI_AUTOSTART_MEM0", memoryBackend === "mem0"),
    autostartTts: envFlag(env, "YUVI_AUTOSTART_TTS", false),
    runtimeUrl,
    mem0Url,
    ttsWrapperUrl,
    ttsUpstreamUrl,
    ollamaUrl,
    databaseUrl,
    runtimeStart: resolveRuntimeStart(repositoryRoot, env, runtimePort),
    mem0Start: resolveMem0Start(repositoryRoot, env, mem0Url),
    ttsWrapperStart: resolveOptionalStartCommand(
      env,
      "YUVI_TTS_WRAPPER_START_COMMAND",
      repositoryRoot
    ),
    ttsUpstreamStart: resolveOptionalStartCommand(
      env,
      "YUVI_TTS_UPSTREAM_START_COMMAND",
      repositoryRoot
    )
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
